//! Per-vault state and account secrets: the JSON `engine.ts` persists.

use serde_json::{json, Map, Value};

use crate::api::RemoteEntry;
use crate::paths::{is_syncable_path, SyncPathOptions};

#[derive(Clone, Debug, PartialEq)]
pub struct LocalBase {
    pub id: String,
    pub revision: i64,
    pub sha256: String,
    pub size: f64,
    pub mtime_ms: f64,
    pub content_sha256: Option<String>,
    pub blank: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncConflict {
    pub path: String,
    pub copy_path: String,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PersistedState {
    pub account_id: String,
    pub cursor: i64,
    pub last_sync_at: Option<String>,
    /// Insertion order, like the TypeScript object.
    pub files: indexmap_like::OrderedMap<LocalBase>,
    pub conflicts: Vec<SyncConflict>,
    pub pending_deletes: Vec<String>,
    pub skipped: Vec<RemoteEntry>,
}

pub mod indexmap_like {
    /// A string-keyed map that keeps insertion order (deleting and re-adding moves a key to the end).
    #[derive(Clone, Debug, PartialEq)]
    pub struct OrderedMap<V> {
        keys: Vec<String>,
        values: std::collections::HashMap<String, V>,
    }

    impl<V> Default for OrderedMap<V> {
        fn default() -> Self {
            Self {
                keys: Vec::new(),
                values: std::collections::HashMap::new(),
            }
        }
    }

    impl<V> OrderedMap<V> {
        pub fn get(&self, key: &str) -> Option<&V> {
            self.values.get(key)
        }
        pub fn contains_key(&self, key: &str) -> bool {
            self.values.contains_key(key)
        }
        pub fn insert(&mut self, key: String, value: V) {
            if !self.values.contains_key(&key) {
                self.keys.push(key.clone());
            }
            self.values.insert(key, value);
        }
        pub fn remove(&mut self, key: &str) -> Option<V> {
            let value = self.values.remove(key)?;
            self.keys.retain(|candidate| candidate != key);
            Some(value)
        }
        pub fn len(&self) -> usize {
            self.keys.len()
        }
        pub fn is_empty(&self) -> bool {
            self.keys.is_empty()
        }
        pub fn keys(&self) -> impl Iterator<Item = &String> {
            self.keys.iter()
        }
        pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
            self.keys.iter().map(move |key| (key, &self.values[key]))
        }
    }
}

impl PersistedState {
    pub fn empty(account_id: &str) -> Self {
        Self {
            account_id: account_id.to_owned(),
            cursor: 0,
            last_sync_at: None,
            files: Default::default(),
            conflicts: Vec::new(),
            pending_deletes: Vec::new(),
            skipped: Vec::new(),
        }
    }

    /// `parseState(raw, accountId)`.
    pub fn parse(raw: Option<&str>, account_id: &str) -> Self {
        let Some(raw) = raw else {
            return Self::empty(account_id);
        };
        let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
            return Self::empty(account_id);
        };
        let files_value = parsed.get("files");
        if parsed.get("version").and_then(Value::as_f64) != Some(1.0)
            || parsed.get("accountId").and_then(Value::as_str) != Some(account_id)
            || !files_value.is_some_and(Value::is_object)
        {
            return Self::empty(account_id);
        }
        let number = |value: Option<&Value>| -> f64 {
            match value {
                Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
                Some(Value::String(text)) => fanotes_famd::js_tonumber(text)
                    .filter(|n| !n.is_nan())
                    .unwrap_or(0.0),
                Some(Value::Bool(true)) => 1.0,
                _ => 0.0,
            }
        };
        let mut files = indexmap_like::OrderedMap::default();
        for (path, base) in files_value.and_then(Value::as_object).into_iter().flatten() {
            // Bases for optional paths stay saved while that setting is off, and when a folder
            // is excluded (`PERSISTED_SYNC_PATHS`). Trash and caches still drop.
            let persisted = SyncPathOptions {
                include_recognition_model: true,
                include_history: true,
                ..SyncPathOptions::default()
            };
            if !is_syncable_path(path, &persisted) || !base.is_object() {
                continue;
            }
            let (Some(id), Some(sha256)) = (
                base.get("id").and_then(Value::as_str),
                base.get("sha256").and_then(Value::as_str),
            ) else {
                continue;
            };
            files.insert(
                path.clone(),
                LocalBase {
                    id: id.to_owned(),
                    revision: number(base.get("revision")) as i64,
                    sha256: sha256.to_owned(),
                    size: number(base.get("size")),
                    mtime_ms: number(base.get("mtimeMs")),
                    content_sha256: base
                        .get("contentSha256")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned),
                    blank: base.get("blank") == Some(&Value::Bool(true)),
                },
            );
        }
        let tail = |items: Vec<Value>, keep: usize| -> Vec<Value> {
            let skip = items.len().saturating_sub(keep);
            items.into_iter().skip(skip).collect()
        };
        let array = |key: &str| {
            parsed
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let conflicts = tail(
            array("conflicts")
                .into_iter()
                .filter(|item| {
                    item.get("path").is_some_and(Value::is_string)
                        && item.get("copyPath").is_some_and(Value::is_string)
                })
                .collect(),
            50,
        )
        .into_iter()
        .map(|item| SyncConflict {
            path: item["path"].as_str().unwrap_or("").to_owned(),
            copy_path: item["copyPath"].as_str().unwrap_or("").to_owned(),
            at: item
                .get("at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        })
        .collect();
        let pending_deletes = tail(
            array("pendingDeletes")
                .into_iter()
                .filter(|item| {
                    item.as_str().is_some_and(|text| {
                        !text.is_empty() && crate::jsjson::utf16_len(text) <= 1024
                    })
                })
                .collect(),
            500,
        )
        .into_iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect();
        let skipped = tail(
            array("skipped")
                .into_iter()
                .filter(|item| {
                    item.get("id").is_some_and(Value::is_string)
                        && item.get("revision").is_some_and(Value::is_number)
                })
                .collect(),
            200,
        )
        .iter()
        .filter_map(RemoteEntry::from_json)
        .collect();
        let cursor = parsed
            .get("cursor")
            .and_then(Value::as_f64)
            .filter(|cursor| cursor.fract() == 0.0 && *cursor >= 0.0)
            .unwrap_or(0.0) as i64;
        Self {
            account_id: account_id.to_owned(),
            cursor,
            last_sync_at: parsed
                .get("lastSyncAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
            files,
            conflicts,
            pending_deletes,
            skipped,
        }
    }

    /// `JSON.stringify(state)` with the same field order.
    pub fn to_json_string(&self) -> String {
        let mut files = Map::new();
        for (path, base) in self.files.iter() {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(base.id));
            entry.insert("revision".into(), json!(base.revision));
            entry.insert("sha256".into(), json!(base.sha256));
            entry.insert("size".into(), js_number(base.size));
            entry.insert("mtimeMs".into(), js_number(base.mtime_ms));
            if let Some(content) = &base.content_sha256 {
                entry.insert("contentSha256".into(), json!(content));
            }
            if base.blank {
                entry.insert("blank".into(), json!(true));
            }
            files.insert(path.clone(), Value::Object(entry));
        }
        let value = json!({
            "version": 1,
            "accountId": self.account_id,
            "cursor": self.cursor,
            "lastSyncAt": self.last_sync_at,
            "files": Value::Object(files),
            "conflicts": self.conflicts.iter().map(|c| json!({ "path": c.path, "copyPath": c.copy_path, "at": c.at })).collect::<Vec<_>>(),
            "pendingDeletes": self.pending_deletes,
            "skipped": self.skipped.iter().map(RemoteEntry::to_json).collect::<Vec<_>>(),
        });
        serde_json::to_string(&value).expect("state json")
    }
}

/// A whole number as an integer, as `JSON.stringify` writes it.
pub fn js_number(value: f64) -> Value {
    fanotes_famd::js_json_number(value)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Secrets {
    pub account_id: String,
    pub device_id: String,
    pub token: String,
    pub expires_at: String,
    pub email: String,
    pub vault_secret: String,
    pub mcp_reader: Option<String>,
}

impl Secrets {
    /// `parseSecrets(raw)`.
    pub fn parse(raw: Option<&str>) -> Option<Secrets> {
        let parsed: Value = serde_json::from_str(raw?).ok()?;
        if parsed.get("v").and_then(Value::as_f64) != Some(1.0) {
            return None;
        }
        let text = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_owned);
        let mcp_reader = text("mcpReader").filter(|value| {
            (43..=80).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        });
        Some(Secrets {
            account_id: text("accountId")?,
            device_id: text("deviceId")?,
            token: text("token")?,
            expires_at: text("expiresAt").unwrap_or_default(),
            email: text("email")?,
            vault_secret: text("vaultSecret")?,
            mcp_reader,
        })
    }

    pub fn to_json_string(&self) -> String {
        let mut map = Map::new();
        map.insert("v".into(), json!(1));
        map.insert("accountId".into(), json!(self.account_id));
        map.insert("deviceId".into(), json!(self.device_id));
        map.insert("token".into(), json!(self.token));
        map.insert("expiresAt".into(), json!(self.expires_at));
        map.insert("email".into(), json!(self.email));
        map.insert("vaultSecret".into(), json!(self.vault_secret));
        if let Some(reader) = &self.mcp_reader {
            map.insert("mcpReader".into(), json!(reader));
        }
        serde_json::to_string(&Value::Object(map)).expect("secrets json")
    }
}
