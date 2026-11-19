//! Read-only LevelDB reader for the Chromium profile directories that hold
//! IndexedDB (`IndexedDB/<origin>.indexeddb.leveldb`) and localStorage
//! (`Local Storage/leveldb`).
//!
//! It never opens a file for writing, never takes the `LOCK`, and never
//! compacts. It reads `CURRENT`, replays the MANIFEST to find the live table
//! files, reads those tables, then replays the write-ahead logs that are newer
//! than the MANIFEST's log number. The entry with the highest sequence number
//! wins for every user key, and deletions hide older values. That is the same
//! state LevelDB recovers on open, without needing the custom comparator:
//! sequence numbers are global, so key order does not matter for the result.
//!
//! Checksums are verified. A torn record at the very end of the newest log is
//! what a crash leaves behind and LevelDB drops it too; it is reported as a
//! warning. Any other damage is an error, so a damaged database is never
//! imported partially without saying so.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const BLOCK_SIZE: usize = 32 * 1024;
const LOG_HEADER: usize = 7;
const TABLE_MAGIC: u64 = 0xdb47_7524_8b80_fb57;
const FOOTER_LEN: usize = 48;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct Snapshot {
    /// Live user key → value.
    pub entries: HashMap<Vec<u8>, Vec<u8>>,
    pub comparator: Option<String>,
    /// Non-fatal findings (a torn tail record of the newest log).
    pub warnings: Vec<String>,
    /// Every file that was read, for the migration log.
    pub files: Vec<PathBuf>,
}

impl Snapshot {
    #[allow(dead_code)] // Lookup by key; the migration only iterates today.
    pub fn get(&self, key: &[u8]) -> Option<&[u8]> {
        self.entries.get(key).map(Vec::as_slice)
    }
}

#[derive(Default)]
struct Version {
    comparator: Option<String>,
    log_number: u64,
    prev_log_number: u64,
    files: Vec<(u32, u64)>,
}

struct Entry {
    sequence: u64,
    value: Option<Vec<u8>>,
}

pub fn read(directory: &Path) -> Result<Snapshot, String> {
    let current = read_limited(&directory.join("CURRENT"))?;
    let manifest_name = String::from_utf8(current)
        .map_err(|_| "CURRENT is not text".to_owned())?
        .trim_end_matches(['\n', '\r'])
        .to_owned();
    if !manifest_name.starts_with("MANIFEST-")
        || manifest_name.len() <= 9
        || !manifest_name[9..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(format!(
            "CURRENT names an unexpected file: {manifest_name:?}"
        ));
    }
    let mut snapshot = Snapshot::default();
    let manifest_path = directory.join(&manifest_name);
    let manifest = read_limited(&manifest_path)?;
    snapshot.files.push(manifest_path.clone());
    let mut version = Version::default();
    let mut manifest_warnings = Vec::new();
    for record in log_records(&manifest, &mut manifest_warnings)? {
        apply_version_edit(&record, &mut version)?;
    }
    if !manifest_warnings.is_empty() {
        // A torn MANIFEST tail means the last edit never committed. LevelDB
        // ignores it as well, and the files it named are not live yet.
        snapshot.warnings.extend(
            manifest_warnings
                .into_iter()
                .map(|warning| format!("{manifest_name}: {warning}")),
        );
    }
    snapshot.comparator = version.comparator.clone();

    let mut merged: HashMap<Vec<u8>, Entry> = HashMap::new();
    let mut add = |key: Vec<u8>, sequence: u64, value: Option<Vec<u8>>| match merged.get(&key) {
        Some(existing) if existing.sequence >= sequence => {}
        _ => {
            merged.insert(key, Entry { sequence, value });
        }
    };

    for (_level, number) in &version.files {
        let path = table_path(directory, *number)
            .ok_or_else(|| format!("table file {number:06} is missing"))?;
        let bytes = read_limited(&path)?;
        read_table(&bytes, &mut add)
            .map_err(|error| format!("{}: {error}", display_name(&path)))?;
        snapshot.files.push(path);
    }

    let mut logs = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|error| format!("{}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".log") else {
            continue;
        };
        let Ok(number) = stem.parse::<u64>() else {
            continue;
        };
        if number >= version.log_number
            || (version.prev_log_number != 0 && number == version.prev_log_number)
        {
            logs.push((number, entry.path()));
        }
    }
    logs.sort();
    let newest = logs.last().map(|(number, _)| *number);
    for (number, path) in logs {
        let bytes = read_limited(&path)?;
        let mut warnings = Vec::new();
        let records = log_records(&bytes, &mut warnings)?;
        if !warnings.is_empty() {
            if Some(number) != newest {
                return Err(format!("{}: {}", display_name(&path), warnings.join("; ")));
            }
            snapshot.warnings.extend(
                warnings
                    .into_iter()
                    .map(|warning| format!("{}: {warning}", display_name(&path))),
            );
        }
        for record in records {
            apply_write_batch(&record, &mut add)
                .map_err(|error| format!("{}: {error}", display_name(&path)))?;
        }
        snapshot.files.push(path);
    }

    snapshot.entries = merged
        .into_iter()
        .filter_map(|(key, entry)| entry.value.map(|value| (key, value)))
        .collect();
    Ok(snapshot)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn table_path(directory: &Path, number: u64) -> Option<PathBuf> {
    for extension in ["ldb", "sst"] {
        let path = directory.join(format!("{number:06}.{extension}"));
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
            return Some(path);
        }
    }
    None
}

fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let meta =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", display_name(path)))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", display_name(path)));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{} is too large", display_name(path)));
    }
    fs::read(path).map_err(|error| format!("{}: {error}", display_name(path)))
}

/// The LevelDB log format: 32 KiB blocks of checksummed fragments.
fn log_records(bytes: &[u8], warnings: &mut Vec<String>) -> Result<Vec<Vec<u8>>, String> {
    let mut records = Vec::new();
    let mut pending: Option<Vec<u8>> = None;
    let mut offset = 0usize;
    while offset < bytes.len() {
        let block_left = BLOCK_SIZE - (offset % BLOCK_SIZE);
        if block_left < LOG_HEADER {
            offset += block_left;
            continue;
        }
        if bytes.len() - offset < LOG_HEADER {
            if bytes[offset..].iter().any(|byte| *byte != 0) {
                warnings.push(format!("torn record header at byte {offset}"));
            }
            break;
        }
        let header = &bytes[offset..offset + LOG_HEADER];
        let checksum = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = u16::from_le_bytes([header[4], header[5]]) as usize;
        let kind = header[6];
        if kind == 0 && length == 0 && checksum == 0 {
            // Zero padding: a preallocated tail or the rest of the block.
            offset += block_left;
            continue;
        }
        let start = offset + LOG_HEADER;
        let end = start + length;
        if length > block_left - LOG_HEADER || end > bytes.len() {
            warnings.push(format!("torn record at byte {offset}"));
            break;
        }
        let data = &bytes[start..end];
        let mut crc_input = Vec::with_capacity(length + 1);
        crc_input.push(kind);
        crc_input.extend_from_slice(data);
        if unmask_crc(checksum) != crc32c(&crc_input) {
            if end == bytes.len() || bytes[end..].iter().all(|byte| *byte == 0) {
                warnings.push(format!(
                    "record with a bad checksum at the end, byte {offset}"
                ));
                break;
            }
            return Err(format!("log record with a bad checksum at byte {offset}"));
        }
        match kind {
            1 => {
                if pending.take().is_some() {
                    return Err(format!(
                        "log record interrupts a fragmented record at byte {offset}"
                    ));
                }
                records.push(data.to_vec());
            }
            2 => {
                if pending.is_some() {
                    return Err(format!(
                        "log record interrupts a fragmented record at byte {offset}"
                    ));
                }
                pending = Some(data.to_vec());
            }
            3 => match pending.as_mut() {
                Some(buffer) => buffer.extend_from_slice(data),
                None => return Err(format!("orphan middle fragment at byte {offset}")),
            },
            4 => match pending.take() {
                Some(mut buffer) => {
                    buffer.extend_from_slice(data);
                    records.push(buffer);
                }
                None => return Err(format!("orphan last fragment at byte {offset}")),
            },
            other => return Err(format!("unknown log record type {other} at byte {offset}")),
        }
        offset = end;
    }
    if pending.is_some() {
        warnings.push("the last fragmented record is incomplete".to_owned());
    }
    Ok(records)
}

fn apply_version_edit(record: &[u8], version: &mut Version) -> Result<(), String> {
    let mut input = Reader::new(record);
    while !input.is_empty() {
        match input.varint32()? {
            1 => {
                let name = input.length_prefixed()?;
                version.comparator = Some(String::from_utf8_lossy(name).into_owned());
            }
            2 => version.log_number = input.varint64()?,
            3 | 4 => {
                input.varint64()?;
            }
            5 => {
                input.varint32()?;
                input.length_prefixed()?;
            }
            6 => {
                let level = input.varint32()?;
                let number = input.varint64()?;
                version.files.retain(|entry| *entry != (level, number));
            }
            7 => {
                let level = input.varint32()?;
                let number = input.varint64()?;
                input.varint64()?;
                input.length_prefixed()?;
                input.length_prefixed()?;
                if !version.files.contains(&(level, number)) {
                    version.files.push((level, number));
                }
            }
            9 => version.prev_log_number = input.varint64()?,
            tag => return Err(format!("unknown MANIFEST tag {tag}")),
        }
    }
    Ok(())
}

fn apply_write_batch(
    record: &[u8],
    add: &mut impl FnMut(Vec<u8>, u64, Option<Vec<u8>>),
) -> Result<(), String> {
    if record.len() < 12 {
        return Err("write batch is too short".to_owned());
    }
    let sequence = u64::from_le_bytes(record[0..8].try_into().unwrap_or_default());
    let count = u32::from_le_bytes(record[8..12].try_into().unwrap_or_default()) as u64;
    let mut input = Reader::new(&record[12..]);
    let mut seen = 0u64;
    while !input.is_empty() {
        let kind = input.byte()?;
        let key = input.length_prefixed()?.to_vec();
        match kind {
            1 => {
                let value = input.length_prefixed()?.to_vec();
                add(key, sequence + seen, Some(value));
            }
            0 => add(key, sequence + seen, None),
            other => return Err(format!("unknown write batch entry {other}")),
        }
        seen += 1;
    }
    if seen != count {
        return Err(format!("write batch says {count} entries but holds {seen}"));
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Handle {
    offset: u64,
    size: u64,
}

fn read_table(
    bytes: &[u8],
    add: &mut impl FnMut(Vec<u8>, u64, Option<Vec<u8>>),
) -> Result<(), String> {
    if bytes.len() < FOOTER_LEN {
        return Err("table is too short".to_owned());
    }
    let footer = &bytes[bytes.len() - FOOTER_LEN..];
    let magic = u64::from_le_bytes(footer[40..48].try_into().unwrap_or_default());
    if magic != TABLE_MAGIC {
        return Err("table has a bad magic number".to_owned());
    }
    let mut input = Reader::new(&footer[..40]);
    let _metaindex = read_handle(&mut input)?;
    let index = read_handle(&mut input)?;
    let index_block = read_block(bytes, index)?;
    for (_key, value) in block_entries(&index_block)? {
        let handle = read_handle(&mut Reader::new(&value))?;
        let block = read_block(bytes, handle)?;
        for (internal_key, value) in block_entries(&block)? {
            if internal_key.len() < 8 {
                return Err("table entry has a short internal key".to_owned());
            }
            let split = internal_key.len() - 8;
            let trailer = u64::from_le_bytes(internal_key[split..].try_into().unwrap_or_default());
            let sequence = trailer >> 8;
            let user_key = internal_key[..split].to_vec();
            match trailer & 0xff {
                1 => add(user_key, sequence, Some(value)),
                0 => add(user_key, sequence, None),
                other => return Err(format!("table entry has an unknown type {other}")),
            }
        }
    }
    Ok(())
}

fn read_handle(input: &mut Reader<'_>) -> Result<Handle, String> {
    Ok(Handle {
        offset: input.varint64()?,
        size: input.varint64()?,
    })
}

fn read_block(bytes: &[u8], handle: Handle) -> Result<Vec<u8>, String> {
    let start = usize::try_from(handle.offset).map_err(|_| "block offset overflows".to_owned())?;
    let size = usize::try_from(handle.size).map_err(|_| "block size overflows".to_owned())?;
    let end = start
        .checked_add(size)
        .and_then(|end| end.checked_add(5))
        .ok_or_else(|| "block range overflows".to_owned())?;
    if end > bytes.len() {
        return Err("block lies outside the table".to_owned());
    }
    let contents = &bytes[start..start + size];
    let kind = bytes[start + size];
    let stored = u32::from_le_bytes(bytes[start + size + 1..end].try_into().unwrap_or_default());
    let mut crc_input = Vec::with_capacity(size + 1);
    crc_input.extend_from_slice(contents);
    crc_input.push(kind);
    if unmask_crc(stored) != crc32c(&crc_input) {
        return Err(format!("block at {start} has a bad checksum"));
    }
    match kind {
        0 => Ok(contents.to_vec()),
        1 => super::snappy::decompress(contents),
        other => Err(format!(
            "block at {start} uses unsupported compression {other}"
        )),
    }
}

fn block_entries(block: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
    if block.len() < 4 {
        return Err("block is too short".to_owned());
    }
    let restarts =
        u32::from_le_bytes(block[block.len() - 4..].try_into().unwrap_or_default()) as usize;
    let restart_bytes = restarts
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(4))
        .ok_or_else(|| "block restart count overflows".to_owned())?;
    if restart_bytes > block.len() {
        return Err("block restart array is too long".to_owned());
    }
    let data = &block[..block.len() - restart_bytes];
    let mut input = Reader::new(data);
    let mut entries = Vec::new();
    let mut key: Vec<u8> = Vec::new();
    while !input.is_empty() {
        let shared = input.varint32()? as usize;
        let unshared = input.varint32()? as usize;
        let value_len = input.varint32()? as usize;
        if shared > key.len() {
            return Err("block entry shares more than the previous key".to_owned());
        }
        key.truncate(shared);
        key.extend_from_slice(input.take(unshared)?);
        let value = input.take(value_len)?.to_vec();
        entries.push((key.clone(), value));
    }
    Ok(entries)
}

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.position >= self.bytes.len()
    }

    pub(crate) fn rest(&self) -> &'a [u8] {
        &self.bytes[self.position.min(self.bytes.len())..]
    }

    pub(crate) fn byte(&mut self) -> Result<u8, String> {
        let byte = *self
            .bytes
            .get(self.position)
            .ok_or_else(|| "unexpected end of data".to_owned())?;
        self.position += 1;
        Ok(byte)
    }

    pub(crate) fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    pub(crate) fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| "unexpected end of data".to_owned())?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    pub(crate) fn varint64(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("varint is too long".to_owned())
    }

    pub(crate) fn varint32(&mut self) -> Result<u32, String> {
        u32::try_from(self.varint64()?).map_err(|_| "varint32 overflows".to_owned())
    }

    fn length_prefixed(&mut self) -> Result<&'a [u8], String> {
        let length = self.varint32()? as usize;
        self.take(length)
    }
}

const CRC_MASK_DELTA: u32 = 0xa282_ead8;

fn unmask_crc(masked: u32) -> u32 {
    let rotated = masked.wrapping_sub(CRC_MASK_DELTA);
    rotated.rotate_left(15)
}

#[cfg(test)]
pub(crate) fn mask_crc(crc: u32) -> u32 {
    crc.rotate_right(15).wrapping_add(CRC_MASK_DELTA)
}

pub(crate) fn crc32c(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut crc = index as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0x82f6_3b78
                } else {
                    crc >> 1
                };
            }
            *slot = crc;
        }
        table
    });
    let mut crc = !0u32;
    for byte in bytes {
        crc = table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32c_matches_the_standard_check_value() {
        assert_eq!(crc32c(b"123456789"), 0xe306_9283);
        assert_eq!(unmask_crc(mask_crc(0x1234_5678)), 0x1234_5678);
    }

    fn log_fragment(kind: u8, data: &[u8]) -> Vec<u8> {
        let mut crc_input = vec![kind];
        crc_input.extend_from_slice(data);
        let mut out = mask_crc(crc32c(&crc_input)).to_le_bytes().to_vec();
        out.extend_from_slice(&(data.len() as u16).to_le_bytes());
        out.push(kind);
        out.extend_from_slice(data);
        out
    }

    fn batch(sequence: u64, entries: &[(&[u8], Option<&[u8]>)]) -> Vec<u8> {
        let mut out = sequence.to_le_bytes().to_vec();
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (key, value) in entries {
            out.push(u8::from(value.is_some()));
            out.push(key.len() as u8);
            out.extend_from_slice(key);
            if let Some(value) = value {
                out.push(value.len() as u8);
                out.extend_from_slice(value);
            }
        }
        out
    }

    fn manifest(log_number: u64) -> Vec<u8> {
        let mut edit = vec![1u8, 8];
        edit.extend_from_slice(b"idb_cmp1");
        edit.extend_from_slice(&[2, log_number as u8, 3, 9, 4, 0]);
        log_fragment(1, &edit)
    }

    fn database(log: &[u8]) -> PathBuf {
        let directory = crate::migrate::tests::temp_dir("leveldb");
        fs::write(directory.join("CURRENT"), b"MANIFEST-000002\n").unwrap();
        fs::write(directory.join("MANIFEST-000002"), manifest(3)).unwrap();
        fs::write(directory.join("000003.log"), log).unwrap();
        // An older log below the MANIFEST log number is already in a table and must be ignored.
        fs::write(
            directory.join("000001.log"),
            log_fragment(1, &batch(1, &[(b"old", Some(b"stale"))])),
        )
        .unwrap();
        directory
    }

    #[test]
    fn later_sequence_numbers_win_and_deletes_hide_values() {
        let mut log = log_fragment(1, &batch(10, &[(b"a", Some(b"1")), (b"b", Some(b"2"))]));
        log.extend(log_fragment(
            1,
            &batch(12, &[(b"a", Some(b"3")), (b"b", None)]),
        ));
        let directory = database(&log);
        let snapshot = read(&directory).unwrap();
        assert_eq!(snapshot.get(b"a"), Some(&b"3"[..]));
        assert_eq!(snapshot.get(b"b"), None);
        assert_eq!(snapshot.get(b"old"), None);
        assert_eq!(snapshot.comparator.as_deref(), Some("idb_cmp1"));
        assert!(snapshot.warnings.is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_torn_tail_is_a_warning_but_damage_in_the_middle_is_an_error() {
        let mut log = log_fragment(1, &batch(10, &[(b"a", Some(b"1"))]));
        let mut torn = log_fragment(1, &batch(11, &[(b"a", Some(b"2"))]));
        torn.truncate(torn.len() - 2);
        log.extend(torn);
        let directory = database(&log);
        let snapshot = read(&directory).unwrap();
        assert_eq!(snapshot.get(b"a"), Some(&b"1"[..]));
        assert_eq!(snapshot.warnings.len(), 1);

        let mut damaged = log_fragment(1, &batch(10, &[(b"a", Some(b"1"))]));
        let middle = damaged.len() - 1;
        damaged[middle] ^= 0xff;
        damaged.extend(log_fragment(1, &batch(11, &[(b"c", Some(b"2"))])));
        fs::write(directory.join("000003.log"), damaged).unwrap();
        assert!(read(&directory).unwrap_err().contains("bad checksum"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn fragments_across_blocks_are_joined() {
        let value = vec![7u8; 40_000];
        let mut record = 20u64.to_le_bytes().to_vec();
        record.extend_from_slice(&1u32.to_le_bytes());
        record.push(1);
        record.push(1);
        record.push(b'k');
        // varint length of 40000
        record.extend_from_slice(&[0xc0, 0xb8, 0x02]);
        record.extend_from_slice(&value);
        let first_len = BLOCK_SIZE - LOG_HEADER;
        let mut log = log_fragment(2, &record[..first_len]);
        log.extend(log_fragment(4, &record[first_len..]));
        let directory = database(&log);
        let snapshot = read(&directory).unwrap();
        assert_eq!(snapshot.get(b"k").map(<[u8]>::len), Some(40_000));
        let _ = fs::remove_dir_all(directory);
    }
}
