//! Chromium localStorage (`Local Storage/leveldb`) for one origin.
//!
//! Data keys are `_<origin>\0<encoded name>`; names and values start with one
//! byte: 1 = Latin-1, 0 = UTF-16LE. `VERSION`, `META:` and `METAACCESS:` keys
//! are bookkeeping and are skipped.

use std::collections::BTreeMap;
use std::path::Path;

use super::leveldb;

/// Name → value as UTF-16 code units (a value may hold an unpaired surrogate).
pub type Entries = BTreeMap<Vec<u16>, Vec<u16>>;

pub fn read_origin(leveldb_dir: &Path, origin: &str) -> Result<(Entries, Vec<String>), String> {
    let snapshot = leveldb::read(leveldb_dir)?;
    let mut prefix = vec![b'_'];
    prefix.extend_from_slice(origin.as_bytes());
    prefix.push(0);
    let mut entries = Entries::new();
    for (key, value) in &snapshot.entries {
        let Some(name) = key.strip_prefix(prefix.as_slice()) else {
            continue;
        };
        entries.insert(decode(name)?, decode(value)?);
    }
    Ok((entries, snapshot.warnings))
}

fn decode(bytes: &[u8]) -> Result<Vec<u16>, String> {
    match bytes.split_first() {
        Some((1, rest)) => Ok(rest.iter().map(|byte| u16::from(*byte)).collect()),
        Some((0, rest)) if rest.len() % 2 == 0 => Ok(rest
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect()),
        _ => Err("localStorage entry has an unknown encoding".to_owned()),
    }
}
