//! One-time import of an Electron or Lernwerk profile.
//!
//! The Tauri profile stores `settings.json` and `vault-path`. Electron stores
//! both in `config.json`. A completed app-data reset must not copy that file back.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::secrets::{self, SecretStore};
use crate::{notes, settings, SECRET_KEYS};

const MIGRATION_MARKER: &str = ".fanotes-legacy-migration-v1-complete";
const RESET_COMPLETE: &str = ".fanotes-reset-complete";
const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const SECRET_PREFIX: &str = "fanotes-secret-v1:";

pub(crate) fn import_electron_profile(app_data: &Path, secret_store: SecretStore) {
    let marker = app_data.join(MIGRATION_MARKER);
    let reset = app_data.join(RESET_COMPLETE);
    if regular_file(&reset) {
        let _ = fs::remove_file(&reset);
        let _ = write_marker(&marker);
        return;
    }
    if regular_file(&marker) {
        return;
    }
    if !regular_file(&app_data.join("settings.json")) && !regular_file(&app_data.join("vault-path"))
    {
        if let Some(config) = first_config(app_data) {
            apply_config(app_data, secret_store, &config);
        }
    }
    let _ = write_marker(&marker);
}

fn first_config(app_data: &Path) -> Option<Value> {
    for path in config_candidates(app_data) {
        if let Some(parent) = path.parent() {
            if !real_directory(parent) {
                continue;
            }
        }
        if let Some(parsed) = read_config(&path) {
            return Some(parsed);
        }
    }
    None
}

fn config_candidates(app_data: &Path) -> Vec<PathBuf> {
    let mut paths = vec![app_data.join("config.json")];
    let mut roots = Vec::new();
    if let Some(parent) = app_data.parent() {
        roots.push(parent.to_path_buf());
    }
    roots.push(electron_config_home());
    for root in roots {
        for name in ["FaNotes", "Lernwerk Notes", "lernwerk-notes"] {
            let directory = root.join(name);
            if same_directory(&directory, app_data) {
                continue;
            }
            paths.push(directory.join("config.json"));
        }
    }
    paths
}

/// `Number(config.version)`. A missing version is `NaN`, and `NaN >= 2` is false.
fn config_version_number(version: Option<&Value>) -> f64 {
    fanotes_famd::js_number(version)
}

fn electron_config_home() -> PathBuf {
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
        if !config.is_empty() {
            return PathBuf::from(config);
        }
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".config"))
        .unwrap_or_default()
}

fn apply_config(app_data: &Path, secret_store: SecretStore, config: &Value) {
    let Some(object) = config.as_object() else {
        return;
    };
    let mut settings_value = object.get("settings").cloned().unwrap_or(Value::Null);
    // Desktop `Number(config.version) >= 2`. `NaN >= 2` is false, so a missing version resets.
    if !(config_version_number(object.get("version")) >= 2.0) {
        if let Some(settings) = settings_value.as_object_mut() {
            let previous = settings
                .get("recognitionMode")
                .and_then(Value::as_str)
                .unwrap_or("text");
            let last = if previous == "math" { "math" } else { "text" };
            settings.insert("recognitionMode".to_owned(), json!("auto"));
            settings.insert("lastRecognitionMode".to_owned(), json!(last));
        }
    }
    let imported_secrets = take_plaintext_secrets(&mut settings_value);
    let sanitized = settings::sanitize(&settings_value, &crate::default_settings());
    let mut stored = serde_json::Map::from_iter(sanitized);
    for key in SECRET_KEYS {
        stored.insert((*key).to_owned(), Value::String(String::new()));
    }
    if let Ok(text) = serde_json::to_string_pretty(&stored) {
        let _ = notes::atomic_write(&app_data.join("settings.json"), text.as_bytes(), 0o600);
    }
    for (key, value) in imported_secrets {
        let Some(secret) = value.as_str() else {
            continue;
        };
        let _ = secrets::set(secret_store, &secrets::account(app_data, &key), secret);
    }
    if let Some(path) = object.get("vaultPath").and_then(Value::as_str) {
        if let Some(vault) = remembered_vault(path) {
            let _ = notes::atomic_write(
                &app_data.join("vault-path"),
                format!("{}\n", vault.display()).as_bytes(),
                0o600,
            );
        }
    }
}

fn take_plaintext_secrets(settings: &mut Value) -> Map<String, Value> {
    let mut secrets = Map::new();
    let Some(object) = settings.as_object_mut() else {
        return secrets;
    };
    for key in SECRET_KEYS {
        let Some(value) = object.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let value = value.to_owned();
        object.insert((*key).to_owned(), Value::String(String::new()));
        let limit = if *key == "homeworkApiSecret" {
            256
        } else {
            4096
        };
        if value.is_empty()
            || value.starts_with(SECRET_PREFIX)
            || value.contains('\0')
            || crate::vault::utf16_len(&value) > limit
        {
            continue;
        }
        secrets.insert((*key).to_owned(), Value::String(value));
    }
    secrets
}

fn remembered_vault(path: &str) -> Option<PathBuf> {
    if path.is_empty() || crate::vault::utf16_len(path) > 4096 || !Path::new(path).is_absolute() {
        return None;
    }
    let path = PathBuf::from(path);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => None,
        Ok(_) | Err(_) => Some(path),
    }
}

fn read_config(path: &Path) -> Option<Value> {
    if !regular_file(path) {
        return None;
    }
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str(&text).ok()
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
}

fn real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
}

fn same_directory(left: &Path, right: &Path) -> bool {
    // Desktop `path.resolve` drops `..` without creating the missing directory.
    crate::node_resolve(left) == crate::node_resolve(right)
}

#[cfg(test)]
mod tests {
    use super::apply_config;
    use crate::secrets::SecretStore;
    use serde_json::Value;
    use std::fs;

    fn imported_modes(config: &str) -> (String, String) {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-profile-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let parsed: Value = serde_json::from_str(config).unwrap();
        apply_config(&dir, SecretStore::Memory, &parsed);
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        let _ = fs::remove_dir_all(&dir);
        (
            settings["recognitionMode"].as_str().unwrap().to_owned(),
            settings["lastRecognitionMode"].as_str().unwrap().to_owned(),
        )
    }

    #[test]
    fn a_config_version_uses_javascript_number() {
        assert_eq!(
            imported_modes(r#"{"version":"2","settings":{"recognitionMode":"math"}}"#),
            ("math".to_owned(), "text".to_owned())
        );
        assert_eq!(
            imported_modes(r#"{"version":2.5,"settings":{"recognitionMode":"math"}}"#),
            ("math".to_owned(), "text".to_owned())
        );
        assert_eq!(
            imported_modes(r#"{"version":1.5,"settings":{"recognitionMode":"math"}}"#),
            ("auto".to_owned(), "math".to_owned())
        );
        assert_eq!(
            imported_modes(r#"{"settings":{"recognitionMode":"math"}}"#),
            ("auto".to_owned(), "math".to_owned())
        );
    }
}

fn write_marker(path: &Path) -> Result<(), String> {
    let stamp = format!(
        "{}\n",
        notes::iso_from_system_time(std::time::SystemTime::now())
    );
    notes::atomic_write(path, stamp.as_bytes(), 0o600)
}
