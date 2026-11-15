//! Chromium IndexedDB on LevelDB (`IndexedDB/<origin>.indexeddb.leveldb` plus
//! `<origin>.indexeddb.blob/`) → databases, object stores and records.
//!
//! Key layout follows Chromium's `indexed_db_leveldb_coding.cc`: a `KeyPrefix`
//! (database id, object store id, index id), then a type-specific suffix.
//! Records live under index id 1; their value is `varint version` + the Blink
//! value. Blink may wrap a value: `ff 11 01 <size> <index>` moves it into an
//! external blob file, `ff 11 02` + Snappy compresses it. Index entries (ids
//! 30+) are not read: the target IndexedDB rebuilds every index from the
//! store definition when the records are put back.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

use super::leveldb::{self, Reader};
use super::v8;

const MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    pub key_path: Value,
    pub unique: bool,
    pub multi_entry: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub key: Value,
    pub value: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub name: String,
    pub key_path: Value,
    pub auto_increment: bool,
    pub indexes: Vec<Index>,
    #[serde(skip)]
    pub records: Vec<Record>,
    /// Records that could not be decoded: (key, reason). Never dropped silently.
    pub unreadable: Vec<(Value, String)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub name: String,
    pub version: u64,
    pub stores: Vec<Store>,
}

#[derive(Debug, Default)]
pub struct Origin {
    pub databases: Vec<Database>,
    pub warnings: Vec<String>,
}

/// `<profile>/IndexedDB/file__0.indexeddb.leveldb` for the `file://` origin.
pub fn read_origin(leveldb_dir: &Path) -> Result<Origin, String> {
    let snapshot = leveldb::read(leveldb_dir)?;
    if let Some(comparator) = &snapshot.comparator {
        if comparator != "idb_cmp1" {
            return Err(format!("unexpected comparator {comparator}"));
        }
    }
    let blob_dir = blob_directory(leveldb_dir);
    let mut origin = Origin {
        warnings: snapshot.warnings.clone(),
        ..Origin::default()
    };

    // DatabaseNameKey: prefix(0,0,0) 201 <origin> <name> → varint id.
    let mut names = Vec::new();
    for (key, value) in &snapshot.entries {
        let Some((prefix, rest)) = split_prefix(key) else {
            continue;
        };
        if prefix != (0, 0, 0) || rest.first() != Some(&201) {
            continue;
        }
        let mut input = Reader::new(&rest[1..]);
        let _origin = string_with_length(&mut input)?;
        let name = string_with_length(&mut input)?;
        let id = Reader::new(value).varint64()?;
        names.push((name, id));
    }
    names.sort();

    for (name_units, database_id) in names {
        let name = String::from_utf16(&name_units)
            .map_err(|_| "database name is not valid text".to_owned())?;
        origin
            .databases
            .push(read_database(&snapshot, &blob_dir, name, database_id)?);
    }
    Ok(origin)
}

fn blob_directory(leveldb_dir: &Path) -> PathBuf {
    let name = leveldb_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name.strip_suffix(".leveldb").unwrap_or(&name);
    leveldb_dir.with_file_name(format!("{stem}.blob"))
}

fn read_database(
    snapshot: &leveldb::Snapshot,
    blob_dir: &Path,
    name: String,
    database_id: u64,
) -> Result<Database, String> {
    let mut version = 0u64;
    let mut stores: BTreeMap<u64, StoreMeta> = BTreeMap::new();
    let mut indexes: BTreeMap<(u64, u64), IndexMeta> = BTreeMap::new();
    let mut raw_records: BTreeMap<u64, Vec<(Vec<u8>, Vec<u8>)>> = BTreeMap::new();
    let mut blob_entries: BTreeMap<(u64, Vec<u8>), Vec<u8>> = BTreeMap::new();

    for (key, value) in &snapshot.entries {
        let Some(((db, store, index), rest)) = split_prefix(key) else {
            continue;
        };
        if db != database_id {
            continue;
        }
        match (store, index) {
            (0, 0) => {
                let Some((&kind, tail)) = rest.split_first() else {
                    continue;
                };
                match kind {
                    4 => version = Reader::new(value).varint64()?,
                    50 => {
                        let mut input = Reader::new(tail);
                        let store_id = input.varint64()?;
                        let field = input.byte()?;
                        let meta = stores.entry(store_id).or_default();
                        match field {
                            0 => meta.name = Some(utf16_be(value)?),
                            1 => meta.key_path = Some(decode_key_path(value)?),
                            2 => meta.auto_increment = value.first().is_some_and(|byte| *byte != 0),
                            _ => {}
                        }
                    }
                    100 => {
                        let mut input = Reader::new(tail);
                        let store_id = input.varint64()?;
                        let index_id = input.varint64()?;
                        let field = input.byte()?;
                        let meta = indexes.entry((store_id, index_id)).or_default();
                        match field {
                            0 => meta.name = Some(utf16_be(value)?),
                            1 => meta.unique = value.first().is_some_and(|byte| *byte != 0),
                            2 => meta.key_path = Some(decode_key_path(value)?),
                            3 => meta.multi_entry = value.first().is_some_and(|byte| *byte != 0),
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            (store_id, 1) if store_id > 0 => raw_records
                .entry(store_id)
                .or_default()
                .push((rest.to_vec(), value.clone())),
            (store_id, 3) if store_id > 0 => {
                blob_entries.insert((store_id, rest.to_vec()), value.clone());
            }
            _ => {}
        }
    }

    let mut out = Vec::new();
    for (store_id, meta) in stores {
        let Some(store_name) = meta.name else {
            continue;
        };
        let mut store = Store {
            name: store_name,
            key_path: meta.key_path.unwrap_or(Value::Null),
            auto_increment: meta.auto_increment,
            indexes: indexes
                .iter()
                .filter(|((owner, _), _)| *owner == store_id)
                .filter_map(|(_, index)| {
                    Some(Index {
                        name: index.name.clone()?,
                        key_path: index.key_path.clone().unwrap_or(Value::Null),
                        unique: index.unique,
                        multi_entry: index.multi_entry,
                    })
                })
                .collect(),
            records: Vec::new(),
            unreadable: Vec::new(),
        };
        store
            .indexes
            .sort_by(|left, right| left.name.cmp(&right.name));
        let mut decoded: Vec<(Key, Record)> = Vec::new();
        for (encoded_key, value) in raw_records.remove(&store_id).unwrap_or_default() {
            let key = decode_key(&mut Reader::new(&encoded_key))?;
            let key_json = key.to_json();
            let blobs = blob_entries.get(&(store_id, encoded_key.clone()));
            match decode_record_value(&value, blobs.map(Vec::as_slice), blob_dir, database_id) {
                Ok(value) => decoded.push((
                    key,
                    Record {
                        key: key_json,
                        value,
                    },
                )),
                Err(error) => store.unreadable.push((key_json, error)),
            }
        }
        decoded.sort_by(|left, right| compare_keys(&left.0, &right.0));
        store.records = decoded.into_iter().map(|(_, record)| record).collect();
        out.push(store);
    }
    out.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Database {
        name,
        version,
        stores: out,
    })
}

#[derive(Default)]
struct StoreMeta {
    name: Option<String>,
    key_path: Option<Value>,
    auto_increment: bool,
}

#[derive(Default)]
struct IndexMeta {
    name: Option<String>,
    key_path: Option<Value>,
    unique: bool,
    multi_entry: bool,
}

fn split_prefix(key: &[u8]) -> Option<((u64, u64, u64), &[u8])> {
    let (&first, rest) = key.split_first()?;
    let database_bytes = usize::from((first >> 5) & 7) + 1;
    let store_bytes = usize::from((first >> 2) & 7) + 1;
    let index_bytes = usize::from(first & 3) + 1;
    let total = database_bytes + store_bytes + index_bytes;
    if rest.len() < total || database_bytes > 8 || store_bytes > 8 {
        return None;
    }
    let int = |bytes: &[u8]| {
        bytes
            .iter()
            .rev()
            .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
    };
    Some((
        (
            int(&rest[..database_bytes]),
            int(&rest[database_bytes..database_bytes + store_bytes]),
            int(&rest[database_bytes + store_bytes..total]),
        ),
        &rest[total..],
    ))
}

fn utf16_be(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("UTF-16 text has an odd length".to_owned());
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).map_err(|_| "name is not valid UTF-16".to_owned())
}

fn string_with_length(input: &mut Reader<'_>) -> Result<Vec<u16>, String> {
    let length = input.varint64()? as usize;
    let bytes = input.take(
        length
            .checked_mul(2)
            .ok_or_else(|| "string is too long".to_owned())?,
    )?;
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect())
}

fn decode_key_path(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < 3 || bytes[0] != 0 || bytes[1] != 0 {
        // Legacy form: the whole value is one string key path.
        return Ok(Value::String(utf16_be(bytes)?));
    }
    let mut input = Reader::new(&bytes[3..]);
    match bytes[2] {
        0 => Ok(Value::Null),
        1 => Ok(Value::String(
            String::from_utf16(&string_with_length(&mut input)?)
                .map_err(|_| "key path is not valid text".to_owned())?,
        )),
        2 => {
            let count = input.varint64()?;
            let mut items = Vec::new();
            for _ in 0..count {
                items.push(Value::String(
                    String::from_utf16(&string_with_length(&mut input)?)
                        .map_err(|_| "key path is not valid text".to_owned())?,
                ));
            }
            Ok(Value::Array(items))
        }
        other => Err(format!("unknown key path type {other}")),
    }
}

#[derive(Clone, Debug)]
pub enum Key {
    Number(f64),
    Date(f64),
    String(Vec<u16>),
    Binary(Vec<u8>),
    Array(Vec<Key>),
}

impl Key {
    pub fn to_json(&self) -> Value {
        match self {
            Key::Number(value) => v8::number(*value),
            Key::Date(value) => v8::special(vec![json!("date"), v8::number(*value)]),
            Key::String(units) => v8::string(units),
            Key::Binary(bytes) => v8::special(vec![
                json!("ArrayBuffer"),
                json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
            ]),
            Key::Array(items) => Value::Array(items.iter().map(Key::to_json).collect()),
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Key::Number(_) => 0,
            Key::Date(_) => 1,
            Key::String(_) => 2,
            Key::Binary(_) => 3,
            Key::Array(_) => 4,
        }
    }
}

fn decode_key(input: &mut Reader<'_>) -> Result<Key, String> {
    match input.byte()? {
        1 => Ok(Key::String(string_with_length(input)?)),
        kind @ (2 | 3) => {
            let bytes: [u8; 8] = input
                .take(8)?
                .try_into()
                .map_err(|_| "short key number".to_owned())?;
            let value = f64::from_le_bytes(bytes);
            Ok(if kind == 2 {
                Key::Date(value)
            } else {
                Key::Number(value)
            })
        }
        4 => {
            let length = input.varint64()?;
            let mut items = Vec::new();
            for _ in 0..length {
                items.push(decode_key(input)?);
            }
            Ok(Key::Array(items))
        }
        6 => {
            let length = input.varint64()? as usize;
            Ok(Key::Binary(input.take(length)?.to_vec()))
        }
        other => Err(format!("unsupported key type {other}")),
    }
}

/// IndexedDB key order: number < date < string < binary < array.
pub fn compare_keys(left: &Key, right: &Key) -> Ordering {
    match (left, right) {
        (Key::Number(a), Key::Number(b)) | (Key::Date(a), Key::Date(b)) => {
            a.partial_cmp(b).unwrap_or(Ordering::Equal)
        }
        (Key::String(a), Key::String(b)) => a.cmp(b),
        (Key::Binary(a), Key::Binary(b)) => a.cmp(b),
        (Key::Array(a), Key::Array(b)) => {
            for (x, y) in a.iter().zip(b) {
                let order = compare_keys(x, y);
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.len().cmp(&b.len())
        }
        _ => left.rank().cmp(&right.rank()),
    }
}

struct BlobInfo {
    number: u64,
    size: u64,
}

fn decode_blob_infos(bytes: &[u8]) -> Result<Vec<BlobInfo>, String> {
    let mut input = Reader::new(bytes);
    let mut infos = Vec::new();
    while !input.is_empty() {
        let is_file = input.byte()? != 0;
        let number = input.varint64()?;
        let _type = string_with_length(&mut input)?;
        let size;
        if is_file {
            let _file_name = string_with_length(&mut input)?;
            let _last_modified = input.varint64()?;
            size = input.varint64()?;
        } else {
            size = input.varint64()?;
        }
        infos.push(BlobInfo { number, size });
    }
    Ok(infos)
}

fn decode_record_value(
    value: &[u8],
    blob_entry: Option<&[u8]>,
    blob_dir: &Path,
    database_id: u64,
) -> Result<Value, String> {
    let mut input = Reader::new(value);
    let _version = input.varint64()?;
    let bytes = unwrap_value(input.rest(), blob_entry, blob_dir, database_id, 0)?;
    v8::decode_ssv(&bytes)
}

fn unwrap_value(
    bytes: &[u8],
    blob_entry: Option<&[u8]>,
    blob_dir: &Path,
    database_id: u64,
    depth: u8,
) -> Result<Vec<u8>, String> {
    if depth > 3 {
        return Err("value is wrapped too deeply".to_owned());
    }
    if bytes.len() < 3 || bytes[0] != 0xff || bytes[1] != 0x11 {
        return Ok(bytes.to_vec());
    }
    match bytes[2] {
        1 => {
            let mut input = Reader::new(&bytes[3..]);
            let size = input.varint64()?;
            let index = input.varint64()? as usize;
            let infos = decode_blob_infos(
                blob_entry.ok_or_else(|| "wrapped value has no blob entry".to_owned())?,
            )?;
            let info = infos
                .get(index)
                .ok_or_else(|| "wrapped value names a missing blob".to_owned())?;
            if info.size != size {
                return Err("wrapped value size does not match its blob".to_owned());
            }
            let path = blob_dir
                .join(database_id.to_string())
                .join(format!("{:02x}", (info.number >> 8) & 0xff))
                .join(format!("{:x}", info.number));
            let meta = fs::symlink_metadata(&path)
                .map_err(|_| format!("blob file {} is missing", info.number))?;
            if !meta.is_file() || meta.len() != size || size > MAX_BLOB_BYTES {
                return Err(format!("blob file {} has the wrong size", info.number));
            }
            let content =
                fs::read(&path).map_err(|error| format!("blob file {}: {error}", info.number))?;
            unwrap_value(&content, None, blob_dir, database_id, depth + 1)
        }
        2 => {
            let content = super::snappy::decompress(&bytes[3..])?;
            unwrap_value(&content, blob_entry, blob_dir, database_id, depth + 1)
        }
        other => Err(format!("unknown value wrapper {other}")),
    }
}

/// Helper for tests and the SQLite reader: one IDB key from its encoding.
pub fn decode_key_bytes(bytes: &[u8]) -> Result<Key, String> {
    decode_key(&mut Reader::new(bytes))
}
