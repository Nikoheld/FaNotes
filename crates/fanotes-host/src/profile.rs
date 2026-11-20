//! One-time import of an Electron or Lernwerk profile.
//!
//! The Tauri profile stores `settings.json` and `vault-path`. Electron stores
//! both in `config.json`. A completed app-data reset must not copy that file back.
//! The full migration (backup, secrets, IndexedDB, sync) lives in `migrate/`;
//! this file finds the Electron profile and imports its settings.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::secrets::SecretStore;
use crate::{notes, settings, SECRET_KEYS};

pub(crate) const MIGRATION_MARKER: &str = ".fanotes-legacy-migration-v1-complete";
pub(crate) const RESET_COMPLETE: &str = ".fanotes-reset-complete";
const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
/// `identifier` in `tauri.conf.json`: the last segment of Tauri's app data directory.
const TAURI_PROFILE_NAME: &str = "de.fanotes.app";

/// Where the Electron profile lookup may look outside the Tauri profile.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ProfileHome {
    /// Never look outside the profile directory and its sibling folders.
    #[default]
    None,
    /// The user's config home (`$XDG_CONFIG_HOME` or `~/.config`). Only the real
    /// Tauri profile (`de.fanotes.app`) uses it, and a test run panics before it
    /// resolves a real path.
    Real,
    /// A fixed directory that stands in for the config home.
    Dir(PathBuf),
}

pub(crate) fn import_electron_profile(
    app_data: &Path,
    secret_store: SecretStore,
    home: &ProfileHome,
) {
    crate::migrate::run_at_startup(app_data, secret_store, home);
}

/// Electron profile directories to look at, best first. Tests never look at the home directory.
pub(crate) fn electron_profile_dirs(app_data: &Path, home: &ProfileHome) -> Vec<PathBuf> {
    if let Some(explicit) =
        std::env::var_os("FANOTES_ELECTRON_PROFILE").filter(|value| !value.is_empty())
    {
        return vec![PathBuf::from(explicit)];
    }
    config_candidates(app_data, home)
        .into_iter()
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .filter(|directory| real_directory(directory))
        .collect()
}

/// The first profile directory with a readable `config.json` or web storage.
pub(crate) fn find_electron_profile(app_data: &Path, home: &ProfileHome) -> Option<PathBuf> {
    electron_profile_dirs(app_data, home)
        .into_iter()
        .find(|directory| {
            read_config(&directory.join("config.json")).is_some()
                || real_directory(&directory.join("IndexedDB"))
                || real_directory(&directory.join("Local Storage"))
        })
}

fn config_candidates(app_data: &Path, home: &ProfileHome) -> Vec<PathBuf> {
    let mut paths = vec![app_data.join("config.json")];
    let mut roots = Vec::new();
    if let Some(parent) = app_data.parent() {
        roots.push(parent.to_path_buf());
    }
    // Only the real Tauri profile (`<data dir>/de.fanotes.app`) looks in the user's home.
    let is_tauri_profile = app_data
        .file_name()
        .is_some_and(|name| name == TAURI_PROFILE_NAME);
    match home {
        ProfileHome::None => {}
        ProfileHome::Dir(directory) => roots.push(directory.clone()),
        ProfileHome::Real if is_tauri_profile => {
            crate::hermetic::forbid_real("the user's Electron config home");
            roots.push(electron_config_home());
        }
        ProfileHome::Real => {}
    }
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

/// Writes `settings.json` (secrets blank) and `vault-path` from an Electron `config.json`.
pub(crate) fn apply_config(app_data: &Path, config: &Value) {
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
    let sanitized = settings::sanitize(&settings_value, &crate::default_settings());
    let mut stored = serde_json::Map::from_iter(sanitized);
    for key in SECRET_KEYS {
        stored.insert((*key).to_owned(), Value::String(String::new()));
    }
    if let Ok(text) = serde_json::to_string_pretty(&stored) {
        let _ = notes::atomic_write(&app_data.join("settings.json"), text.as_bytes(), 0o600);
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

/// The byte limit `main.cjs` applies to each secret setting, in UTF-16 units.
pub(crate) fn secret_limit(key: &str) -> usize {
    match key {
        "homeworkApiSecret" => 256,
        "grokBuildAccessToken" | "grokBuildRefreshToken" => 8192,
        _ => 4096,
    }
}

pub(crate) fn remembered_vault(path: &str) -> Option<PathBuf> {
    if path.is_empty() || crate::vault::utf16_len(path) > 4096 || !Path::new(path).is_absolute() {
        return None;
    }
    let path = PathBuf::from(path);
    match fs::symlink_metadata(&path) {
        // Desktop `readConfig` stores a symlink and `validateVaultRoot` follows it.
        Ok(meta) if meta.file_type().is_symlink() => path.is_dir().then_some(path),
        Ok(meta) if !meta.is_dir() => None,
        Ok(_) | Err(_) => Some(path),
    }
}

pub(crate) fn read_config(path: &Path) -> Option<Value> {
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

pub(crate) fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
}

pub(crate) fn real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
}

fn same_directory(left: &Path, right: &Path) -> bool {
    // Desktop `path.resolve` drops `..` without creating the missing directory.
    crate::node_resolve(left) == crate::node_resolve(right)
}

#[cfg(test)]
mod tests {
    use super::apply_config;
    use serde_json::Value;
    use std::fs;

    fn imported_modes(config: &str) -> (String, String) {
        let dir = crate::test_support::Scratch::new(format!(
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
        apply_config(&dir, &parsed);
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

pub(crate) fn write_marker(path: &Path) -> Result<(), String> {
    notes::atomic_write(path, format!("{}\n", notes::iso_now()).as_bytes(), 0o600)
}
