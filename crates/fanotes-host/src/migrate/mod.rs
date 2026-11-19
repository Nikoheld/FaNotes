//! Electron → Tauri profile migration. See `README.md` in this directory.
//!
//! Order: find the Electron profile → refuse while Electron runs → copy its
//! user data to `migration-backup/<id>/files/` with a SHA-256 manifest →
//! verify the copy → import from the verified copy only. The Electron profile
//! is only ever read. Every phase is idempotent and recorded in
//! `migration/state.json`, so a crash resumes at the phase it stopped in.
//! IndexedDB and localStorage are exported to `migration/export/`; the
//! renderer step writes them into the webview and confirms with counts.

pub(crate) mod backup;
pub(crate) mod idb;
pub(crate) mod leveldb;
pub(crate) mod local_storage;
pub mod os_crypt;
pub(crate) mod snappy;
pub(crate) mod v8;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::secrets::{self, SecretStore};
use crate::{notes, profile, SECRET_KEYS};

pub const COMPLETE_MARKER: &str = ".fanotes-electron-migration-v2-complete";
const WORK_DIR: &str = "migration";
const SECRET_SETTING_PREFIX: &str = "fanotes-secret-v1:";
const SYNC_ACCOUNT: &str = "sync-account";
const APP_NAME: &str = "FaNotes";
/// Files copied into the Tauri profile when it has none yet (same layout in both hosts).
const CARRIED_FILES: &[&str] = &[
    "folder-locations.json",
    "addons",
    "ink-recognition",
    "personal-handwriting-v2",
];

pub struct Options {
    pub source: Option<PathBuf>,
    pub secret_store: SecretStore,
    pub decryptor: Box<dyn Fn(Option<&Value>) -> os_crypt::Decryptor>,
    /// Tests: stop with an error right after this phase (a simulated crash).
    pub fail_after: Option<&'static str>,
    /// Run again from the newest verified backup even when the marker exists.
    pub rerun: bool,
}

impl Options {
    pub fn native(secret_store: SecretStore) -> Self {
        Self {
            source: None,
            secret_store,
            decryptor: Box::new(|state| os_crypt::Decryptor::native(state, APP_NAME)),
            fail_after: None,
            rerun: false,
        }
    }
}

/// Called from `Host::open`. Never panics and never blocks on a missing keyring.
pub(crate) fn run_at_startup(app_data: &Path, secret_store: SecretStore) {
    let _ = run(app_data, &Options::native(secret_store));
}

fn work(app_data: &Path) -> PathBuf {
    app_data.join(WORK_DIR)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    notes::atomic_write(path, text.as_bytes(), 0o600)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Appends one line to `migration/migration.log`. Callers never pass secret values.
fn log(app_data: &Path, message: &str) {
    let directory = work(app_data);
    if ensure_dir(&directory).is_err() {
        return;
    }
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("migration.log"))
    {
        let _ = writeln!(file, "{} {message}", notes::iso_now());
    }
}

pub fn report_path(app_data: &Path) -> PathBuf {
    work(app_data).join("report.json")
}

/// The report the UI shows (`migration/report.json`), or `null` before any run.
pub fn status(app_data: &Path) -> Value {
    read_json(&report_path(app_data)).unwrap_or(Value::Null)
}

struct Run<'a> {
    app_data: &'a Path,
    options: &'a Options,
    state: Value,
}

impl Run<'_> {
    fn save(&mut self) -> Result<(), String> {
        write_json(&work(self.app_data).join("state.json"), &self.state)?;
        write_json(&report_path(self.app_data), &self.state["report"])
    }

    fn done(&self, phase: &str) -> bool {
        self.state["phases"][phase].as_str() == Some("done")
    }

    fn finish(&mut self, phase: &str, result: Value) -> Result<(), String> {
        self.state["phases"][phase] = json!("done");
        self.state["report"][phase] = result;
        self.save()?;
        log(self.app_data, &format!("phase {phase} done"));
        if self.options.fail_after == Some(phase) {
            return Err(format!("simulated crash after {phase}"));
        }
        Ok(())
    }

    fn files(&self) -> PathBuf {
        PathBuf::from(self.state["backup"]["files"].as_str().unwrap_or_default())
    }
}

/// Runs or resumes the migration and returns the report.
pub fn run(app_data: &Path, options: &Options) -> Value {
    let marker = app_data.join(COMPLETE_MARKER);
    let reset = app_data.join(profile::RESET_COMPLETE);
    if profile::regular_file(&reset) {
        // A finished app-data reset must not pull the old profile back in.
        let _ = fs::remove_file(&reset);
        let _ = profile::write_marker(&app_data.join(profile::MIGRATION_MARKER));
        let _ = profile::write_marker(&marker);
        return status(app_data);
    }
    if profile::regular_file(&marker) && !options.rerun {
        return status(app_data);
    }
    let state_path = work(app_data).join("state.json");
    let mut state = read_json(&state_path)
        .filter(|state| state["version"] == 1)
        .unwrap_or_else(
            || json!({"version": 1, "phases": {}, "report": {"version": 1, "status": "running"}}),
        );
    if options.rerun {
        state["phases"] = json!({});
        let _ = fs::remove_file(&marker);
    }
    let mut run = Run {
        app_data,
        options,
        state,
    };
    match run_phases(&mut run) {
        Ok(()) => {}
        Err(error) => {
            let blocked = error == ELECTRON_RUNNING;
            run.state["report"]["status"] = json!(if blocked { "blocked" } else { "failed" });
            run.state["report"]["error"] = json!(error);
            let _ = run.save();
            log(app_data, &format!("stopped: {error}"));
        }
    }
    status(app_data)
}

const ELECTRON_RUNNING: &str =
    "FaNotes (Electron) is still running. Close it so its profile can be copied.";

fn run_phases(run: &mut Run<'_>) -> Result<(), String> {
    let app_data = run.app_data;
    ensure_dir(&work(app_data))?;
    if run.state["backup"]["verified"] != true {
        let source = match run
            .options
            .source
            .clone()
            .or_else(|| profile::find_electron_profile(app_data))
        {
            Some(source) => source,
            None => {
                run.state["report"]["status"] = json!("nothing");
                run.save()?;
                log(app_data, "no Electron profile found");
                profile::write_marker(&app_data.join(COMPLETE_MARKER))?;
                return Ok(());
            }
        };
        if backup::electron_running(&source) {
            return Err(ELECTRON_RUNNING.to_owned());
        }
        log(app_data, &format!("backing up {}", source.display()));
        let made = backup::create(app_data, &source)?;
        run.state["source"] = json!(source.to_string_lossy());
        run.state["backup"] = made.clone();
        run.state["report"]["source"] = json!(source.to_string_lossy());
        run.state["report"]["backup"] = made;
        run.state["report"]["status"] = json!("running");
        run.save()?;
        log(app_data, "backup verified");
    }
    let files = run.files();
    let config = profile::read_config(&files.join("config.json"));
    let local_state = read_json(&files.join("Local State"));
    let decryptor = (run.options.decryptor)(local_state.as_ref());

    if !run.done("settings") {
        let result = import_settings(app_data, config.as_ref());
        run.finish("settings", result)?;
    }
    if !run.done("secrets") {
        let result = import_secrets(
            app_data,
            run.options.secret_store,
            config.as_ref(),
            &decryptor,
        );
        run.finish("secrets", result)?;
    }
    if !run.done("sync") {
        let result = import_sync(
            app_data,
            run.options.secret_store,
            &files,
            &decryptor,
            config.as_ref(),
        )?;
        run.finish("sync", result)?;
    }
    if !run.done("files") {
        let result = carry_files(app_data, &files)?;
        run.finish("files", result)?;
    }
    if !run.done("webstorage") {
        let result = export_web_storage(app_data, &files)?;
        let nothing = result["status"] == "nothing";
        run.state["report"]["webstorage"] = result.clone();
        if nothing || result["status"] == "verified" {
            run.finish("webstorage", result)?;
        } else {
            run.state["phases"]["webstorage"] = json!("exported");
            run.save()?;
        }
    }
    conclude(run)
}

fn conclude(run: &mut Run<'_>) -> Result<(), String> {
    let pending = !run.done("webstorage");
    let report = &mut run.state["report"];
    let mut actions = Vec::new();
    for item in report["secrets"]["needsReentry"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        actions.push(
            json!({"kind": "reenter-secret", "name": item["name"], "reason": item["reason"]}),
        );
    }
    if report["sync"]["account"] == "needs-sign-in" {
        actions.push(json!({"kind": "sync-sign-in", "reason": report["sync"]["reason"]}));
    }
    let unreadable = report["webstorage"]["unreadable"].as_u64().unwrap_or(0);
    if unreadable > 0
        || report["webstorage"]["unsupported"]
            .as_array()
            .is_some_and(|list| !list.is_empty())
    {
        actions.push(json!({"kind": "webstorage-in-backup", "records": unreadable}));
    }
    report["actions"] = Value::Array(actions.clone());
    report["status"] = json!(if pending {
        "pending"
    } else if actions.is_empty() {
        "complete"
    } else {
        "complete-with-actions"
    });
    if !pending {
        report["completedAt"] = json!(notes::iso_now());
    }
    run.save()?;
    if !pending {
        profile::write_marker(&run.app_data.join(COMPLETE_MARKER))?;
        // The v1 settings import must not run again over the migrated settings.
        profile::write_marker(&run.app_data.join(profile::MIGRATION_MARKER))?;
        log(
            run.app_data,
            &format!(
                "migration {}",
                run.state["report"]["status"].as_str().unwrap_or("")
            ),
        );
    }
    Ok(())
}

fn import_settings(app_data: &Path, config: Option<&Value>) -> Value {
    if profile::regular_file(&app_data.join("settings.json"))
        || profile::regular_file(&app_data.join("vault-path"))
    {
        return json!({"status": "kept-existing"});
    }
    let Some(config) = config else {
        return json!({"status": "none"});
    };
    profile::apply_config(app_data, config);
    let vault = fs::read_to_string(app_data.join("vault-path"))
        .ok()
        .map(|text| text.trim_end_matches('\n').to_owned());
    json!({"status": "imported", "vault": vault})
}

fn import_secrets(
    app_data: &Path,
    store: SecretStore,
    config: Option<&Value>,
    decryptor: &os_crypt::Decryptor,
) -> Value {
    let mut migrated = Vec::new();
    let mut kept = Vec::new();
    let mut needs = Vec::new();
    let settings = config
        .and_then(|config| config.get("settings"))
        .and_then(Value::as_object);
    for key in SECRET_KEYS {
        let Some(raw) = settings
            .and_then(|settings| settings.get(*key))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let account = secrets::account(app_data, key);
        if matches!(secrets::get(store, &account), Ok(Some(existing)) if !existing.is_empty()) {
            kept.push(json!(key));
            continue;
        }
        let plain = match raw.strip_prefix(SECRET_SETTING_PREFIX) {
            None => Ok(raw.to_owned()),
            Some(encoded) => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| os_crypt::Failure::CannotDecrypt)
                .and_then(|bytes| decryptor.decrypt(&bytes))
                .and_then(|bytes| {
                    String::from_utf8(bytes).map_err(|_| os_crypt::Failure::CannotDecrypt)
                }),
        };
        let reason = match plain {
            Ok(value) if value.is_empty() => continue,
            Ok(value)
                if value.contains('\0')
                    || crate::vault::utf16_len(&value) > profile::secret_limit(key) =>
            {
                "invalid".to_owned()
            }
            Ok(value) => match secrets::set(store, &account, &value) {
                Ok(()) => {
                    migrated.push(json!(key));
                    continue;
                }
                Err(_) => "target-keyring-unavailable".to_owned(),
            },
            Err(failure) => failure.code().to_owned(),
        };
        log(app_data, &format!("secret {key} needs re-entry: {reason}"));
        needs.push(json!({"name": key, "reason": reason}));
    }
    json!({"migrated": migrated, "keptExisting": kept, "needsReentry": needs})
}

fn import_sync(
    app_data: &Path,
    store: SecretStore,
    files: &Path,
    decryptor: &os_crypt::Decryptor,
    config: Option<&Value>,
) -> Result<Value, String> {
    let source = files.join("sync");
    let mut result = Map::new();
    // Account: `safe1:` safeStorage, `local1:` AES-GCM with `account.key`, `plain1:` is discarded by Electron too.
    let account = secrets::account(app_data, SYNC_ACCOUNT);
    let raw = fs::read(source.join("account.secret")).ok();
    let (status, reason) = match raw.as_deref() {
        None => ("none", None),
        Some(_) if matches!(secrets::get(store, &account), Ok(Some(existing)) if !existing.is_empty()) => {
            ("kept-existing", None)
        }
        Some(raw) => {
            let opened: Result<Vec<u8>, String> = if let Some(body) = raw.strip_prefix(b"safe1:") {
                base64::engine::general_purpose::STANDARD
                    .decode(body)
                    .map_err(|_| "cannot-decrypt".to_owned())
                    .and_then(|bytes| {
                        decryptor
                            .decrypt(&bytes)
                            .map_err(|failure| failure.code().to_owned())
                    })
            } else if let Some(body) = raw.strip_prefix(b"local1:") {
                fs::read(source.join("account.key"))
                    .map_err(|_| "local-key-missing".to_owned())
                    .and_then(|key| {
                        base64::engine::general_purpose::STANDARD
                            .decode(body)
                            .ok()
                            .and_then(|payload| os_crypt::open_local_sync_secret(&payload, &key))
                            .ok_or_else(|| "cannot-decrypt".to_owned())
                    })
            } else {
                Err("no-login".to_owned())
            };
            match opened
                .and_then(|bytes| String::from_utf8(bytes).map_err(|_| "cannot-decrypt".to_owned()))
            {
                Ok(json_text)
                    if serde_json::from_str::<Value>(&json_text)
                        .is_ok_and(|value| value["v"] == 1 && value["accountId"].is_string()) =>
                {
                    match secrets::set(store, &account, &json_text) {
                        Ok(()) => {
                            ensure_dir(&app_data.join("sync"))?;
                            notes::atomic_write(
                                &app_data.join("sync").join("account.secret"),
                                b"safe1:",
                                0o600,
                            )?;
                            ("migrated", None)
                        }
                        Err(_) => (
                            "needs-sign-in",
                            Some("target-keyring-unavailable".to_owned()),
                        ),
                    }
                }
                Ok(_) => ("needs-sign-in", Some("invalid".to_owned())),
                Err(reason) => ("needs-sign-in", Some(reason)),
            }
        }
    };
    result.insert("account".to_owned(), json!(status));
    if let Some(reason) = reason {
        log(app_data, &format!("sync login needs sign-in: {reason}"));
        result.insert("reason".to_owned(), json!(reason));
    }
    // State: same file names and format in both hosts; the vault id is sha256(path.resolve(vault)).
    let mut copied = 0;
    let mut same = 0;
    let mut kept = Vec::new();
    if let Ok(entries) = fs::read_dir(&source) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names {
            let Some(id) = name
                .strip_prefix("state-")
                .and_then(|rest| rest.strip_suffix(".json"))
            else {
                continue;
            };
            if !(16..=64).contains(&id.len())
                || !id
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            {
                continue;
            }
            let bytes =
                fs::read(source.join(&name)).map_err(|error| format!("sync/{name}: {error}"))?;
            match backup::carry(&bytes, &app_data.join("sync").join(&name))? {
                backup::Carried::Copied => copied += 1,
                backup::Carried::Same => same += 1,
                backup::Carried::KeptExisting => kept.push(json!(name)),
            }
        }
    }
    let vault_id = config
        .and_then(|config| config.get("vaultPath"))
        .and_then(Value::as_str)
        .and_then(profile::remembered_vault)
        .map(|vault| {
            use sha2::Digest;
            let digest =
                sha2::Sha256::digest(crate::node_resolve(&vault).to_string_lossy().as_bytes());
            digest
                .iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        });
    result.insert("states".to_owned(), json!(copied + same));
    result.insert("statesKeptExisting".to_owned(), Value::Array(kept));
    result.insert(
        "stateForVault".to_owned(),
        json!(vault_id.as_ref().is_some_and(|id| app_data
            .join("sync")
            .join(format!("state-{id}.json"))
            .is_file())),
    );
    Ok(Value::Object(result))
}

fn carry_files(app_data: &Path, files: &Path) -> Result<Value, String> {
    let mut copied = 0;
    let mut same = 0;
    let mut kept = Vec::new();
    for name in CARRIED_FILES {
        for (relative, path) in backup::walk(&files.join(name))? {
            let target_relative = if relative.is_empty() {
                (*name).to_owned()
            } else {
                format!("{name}/{relative}")
            };
            let bytes = fs::read(&path).map_err(|error| format!("{target_relative}: {error}"))?;
            let target = app_data.join(&target_relative);
            if let Some(parent) = target.parent() {
                ensure_dir(parent)?;
            }
            match backup::carry(&bytes, &target)? {
                backup::Carried::Copied => copied += 1,
                backup::Carried::Same => same += 1,
                backup::Carried::KeptExisting => kept.push(json!(target_relative)),
            }
        }
    }
    Ok(json!({"copied": copied, "unchanged": same, "keptExisting": kept}))
}

// ---- IndexedDB and localStorage: export, renderer pages, confirmation ----

const ORIGIN_DIR: &str = "file__0";

fn export_dir(app_data: &Path) -> PathBuf {
    work(app_data).join("export")
}

fn export_web_storage(app_data: &Path, files: &Path) -> Result<Value, String> {
    let existing = export_dir(app_data).join("manifest.json");
    if let Some(manifest) = read_json(&existing) {
        // Already exported in an earlier run: keep the same export so the renderer can resume.
        return Ok(summary(&manifest, None));
    }
    let leveldb_dir = files
        .join("IndexedDB")
        .join(format!("{ORIGIN_DIR}.indexeddb.leveldb"));
    let sqlite_dir = files.join("IndexedDB").join(ORIGIN_DIR);
    let storage_dir = files.join("Local Storage").join("leveldb");
    let mut unsupported = Vec::new();
    let mut warnings = Vec::new();
    let origin = if profile::real_directory(&leveldb_dir) {
        let origin =
            idb::read_origin(&leveldb_dir).map_err(|error| format!("IndexedDB: {error}"))?;
        warnings.extend(origin.warnings.iter().cloned());
        Some(origin)
    } else {
        None
    };
    if profile::real_directory(&sqlite_dir) {
        // Chromium's SQLite IndexedDB backend (off by default in Electron 43). The files stay in the backup.
        unsupported.push(json!("IndexedDB SQLite backend"));
    }
    let storage = if profile::real_directory(&storage_dir) {
        let (entries, storage_warnings) = local_storage::read_origin(&storage_dir, "file://")
            .map_err(|error| format!("localStorage: {error}"))?;
        warnings.extend(storage_warnings);
        Some(entries)
    } else {
        None
    };
    if origin
        .as_ref()
        .is_none_or(|origin| origin.databases.is_empty())
        && storage.as_ref().is_none_or(|entries| entries.is_empty())
        && unsupported.is_empty()
    {
        return Ok(json!({"status": "nothing"}));
    }

    let staging = work(app_data).join(format!("export.tmp-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    ensure_dir(&staging)?;
    let mut databases = Vec::new();
    for (database_index, database) in origin
        .iter()
        .flat_map(|origin| origin.databases.iter())
        .enumerate()
    {
        let mut stores = Vec::new();
        for (store_index, store) in database.stores.iter().enumerate() {
            let file = format!("idb-{database_index}-{store_index}.jsonl");
            let mut text = String::new();
            for record in &store.records {
                text.push_str(&serde_json::to_string(record).map_err(|error| error.to_string())?);
                text.push('\n');
            }
            notes::atomic_write(&staging.join(&file), text.as_bytes(), 0o600)?;
            let mut meta = serde_json::to_value(store).map_err(|error| error.to_string())?;
            meta["count"] = json!(store.records.len());
            meta["file"] = json!(file);
            meta["unreadable"] = json!(store
                .unreadable
                .iter()
                .map(|(key, reason)| json!({"key": key, "reason": reason}))
                .collect::<Vec<_>>());
            stores.push(meta);
        }
        databases
            .push(json!({"name": database.name, "version": database.version, "stores": stores}));
    }
    let mut local = json!(null);
    if let Some(entries) = &storage {
        let mut text = String::new();
        for (name, value) in entries {
            text.push_str(
                &serde_json::to_string(
                    &json!({"name": v8::string(name), "value": v8::string(value)}),
                )
                .map_err(|error| error.to_string())?,
            );
            text.push('\n');
        }
        notes::atomic_write(&staging.join("local-storage.jsonl"), text.as_bytes(), 0o600)?;
        local = json!({"count": entries.len(), "file": "local-storage.jsonl"});
    }
    let manifest = json!({
        "version": 1,
        "origin": "file://",
        "databases": databases,
        "localStorage": local,
        "unsupported": unsupported,
        "warnings": warnings,
    });
    write_json(&staging.join("manifest.json"), &manifest)?;
    let _ = fs::remove_dir_all(export_dir(app_data));
    fs::rename(&staging, export_dir(app_data)).map_err(|error| format!("export: {error}"))?;
    Ok(summary(&manifest, None))
}

fn summary(manifest: &Value, verified: Option<&Value>) -> Value {
    let databases = manifest["databases"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut records = 0u64;
    let mut unreadable = 0u64;
    let mut list = Vec::new();
    for database in &databases {
        let mut stores = Vec::new();
        for store in database["stores"].as_array().into_iter().flatten() {
            records += store["count"].as_u64().unwrap_or(0);
            unreadable += store["unreadable"].as_array().map_or(0, Vec::len) as u64;
            stores.push(json!({"name": store["name"], "records": store["count"], "unreadable": store["unreadable"].as_array().map_or(0, Vec::len)}));
        }
        list.push(json!({"name": database["name"], "stores": stores}));
    }
    json!({
        "status": if verified.is_some() { "verified" } else { "pending-renderer" },
        "databases": list,
        "records": records,
        "unreadable": unreadable,
        "localStorage": manifest["localStorage"]["count"],
        "unsupported": manifest["unsupported"],
        "warnings": manifest["warnings"],
        "renderer": verified.cloned().unwrap_or(Value::Null),
    })
}

/// What the renderer step needs: the export manifest, or `null` when nothing is pending.
pub fn web_storage_plan(app_data: &Path) -> Value {
    let state = read_json(&work(app_data).join("state.json")).unwrap_or(Value::Null);
    if state["phases"]["webstorage"] != "exported" {
        return Value::Null;
    }
    read_json(&export_dir(app_data).join("manifest.json")).unwrap_or(Value::Null)
}

const PAGE_BYTES: usize = 4 * 1024 * 1024;

/// One page of an export file: parsed lines from `start`, at most ~4 MiB.
pub fn web_storage_page(app_data: &Path, file: &str, start: usize) -> Result<Value, String> {
    if file.is_empty()
        || !file
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
        || !file.ends_with(".jsonl")
    {
        return Err("invalid export file".to_owned());
    }
    let text = fs::read_to_string(export_dir(app_data).join(file))
        .map_err(|_| "export file is missing".to_owned())?;
    let mut items = Vec::new();
    let mut bytes = 0usize;
    let mut next = Value::Null;
    for (index, line) in text.lines().enumerate().skip(start) {
        if bytes >= PAGE_BYTES {
            next = json!(index);
            break;
        }
        bytes += line.len();
        items.push(
            serde_json::from_str::<Value>(line).map_err(|_| "export file is damaged".to_owned())?,
        );
    }
    Ok(json!({"items": items, "next": next}))
}

/// The renderer's confirmation: per store `{expected, equal, keptExisting, failed}`.
pub fn web_storage_done(
    app_data: &Path,
    result: &Value,
    store: SecretStore,
) -> Result<Value, String> {
    let manifest = read_json(&export_dir(app_data).join("manifest.json"))
        .ok_or_else(|| "nothing was exported".to_owned())?;
    let mut problems = Vec::new();
    let mut check = |label: String, expected: u64, reported: &Value| {
        let equal = reported["equal"].as_u64().unwrap_or(0);
        let kept = reported["keptExisting"].as_u64().unwrap_or(0);
        let failed = reported["failed"].as_u64().unwrap_or(0);
        if reported["expected"].as_u64() != Some(expected)
            || equal + kept != expected
            || failed != 0
        {
            problems.push(format!(
                "{label}: expected {expected}, equal {equal}, kept {kept}, failed {failed}"
            ));
        }
    };
    for database in manifest["databases"].as_array().into_iter().flatten() {
        for store_meta in database["stores"].as_array().into_iter().flatten() {
            let name = format!(
                "{}/{}",
                database["name"].as_str().unwrap_or(""),
                store_meta["name"].as_str().unwrap_or("")
            );
            let reported = result["stores"].get(&name).cloned().unwrap_or(Value::Null);
            check(name, store_meta["count"].as_u64().unwrap_or(0), &reported);
        }
    }
    if let Some(count) = manifest["localStorage"]["count"].as_u64() {
        check("localStorage".to_owned(), count, &result["localStorage"]);
    }
    if !problems.is_empty() {
        log(
            app_data,
            &format!("renderer import incomplete: {}", problems.join("; ")),
        );
        return Err(format!(
            "The browser data import is incomplete: {}",
            problems.join("; ")
        ));
    }
    log(app_data, "renderer import verified");
    let state_path = work(app_data).join("state.json");
    let mut state = read_json(&state_path).ok_or_else(|| "no migration is running".to_owned())?;
    state["phases"]["webstorage"] = json!("done");
    state["report"]["webstorage"] = summary(&manifest, Some(result));
    let options = Options::native(store);
    let mut run = Run {
        app_data,
        options: &options,
        state,
    };
    run.save()?;
    conclude(&mut run)?;
    Ok(status(app_data))
}

/// Rollback helper: writes a verified backup back as an Electron profile into an empty directory.
pub fn restore_electron_profile(
    app_data: &Path,
    backup_id: &str,
    destination: &Path,
) -> Result<Value, String> {
    let restored = backup::restore(app_data, backup_id, destination)?;
    log(
        app_data,
        &format!("restored backup {backup_id} to {}", destination.display()),
    );
    Ok(json!({"restored": restored, "destination": destination.to_string_lossy()}))
}

pub fn list_backups(app_data: &Path) -> Value {
    backup::list(app_data)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeMap;

    pub(crate) fn temp_dir(label: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let base = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = base.join(format!(
            "fanotes-migrate-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// Numbers compare by value: JSON from JavaScript and from Rust spell them differently.
    pub(crate) fn same_json(left: &Value, right: &Value) -> bool {
        match (left, right) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_json(x, y))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .zip(b)
                        .all(|((ka, va), (kb, vb))| ka == kb && same_json(va, vb))
            }
            _ => left == right,
        }
    }

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/migrate/fixtures")
            .join(name)
    }

    fn copy_tree(from: &Path, to: &Path) {
        for (relative, path) in backup::walk(from).unwrap() {
            let target = to.join(&relative);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::copy(&path, &target).unwrap();
        }
    }

    fn tree_hashes(root: &Path) -> BTreeMap<String, Vec<u8>> {
        backup::walk(root)
            .unwrap()
            .into_iter()
            .map(|(relative, path)| (relative, fs::read(path).unwrap()))
            .collect()
    }

    struct Setup {
        root: PathBuf,
        profile: PathBuf,
        app_data: PathBuf,
        vault: PathBuf,
        expected: Value,
    }

    /// A copy of a committed fixture with its vault moved into the temp directory,
    /// plus the caches and downloads a real profile has (which the backup leaves out).
    fn setup(name: &str) -> Setup {
        let root = temp_dir(name);
        let profile = root.join("electron").join("FaNotes");
        copy_tree(&fixture(name).join("profile"), &profile);
        let vault = root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        fs::write(vault.join("Welcome.md"), "# Fixture vault\n").unwrap();
        let config_path = profile.join("config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        config["vaultPath"] = json!(vault.to_string_lossy());
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        use sha2::Digest;
        let id: String = sha2::Sha256::digest(vault.to_string_lossy().as_bytes())
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect();
        for entry in fs::read_dir(profile.join("sync")).unwrap().flatten() {
            let name = entry.file_name().into_string().unwrap();
            if name.starts_with("state-") {
                fs::rename(
                    entry.path(),
                    profile.join("sync").join(format!("state-{id}.json")),
                )
                .unwrap();
            }
        }
        for (path, size) in [
            ("Cache/Cache_Data/data_0", 4096),
            ("GPUCache/index", 64),
            ("models/qwen-vision/x/model.bin", 65536),
            ("tree-cache-v1/c.json", 2),
            ("updates/pending.json", 2),
        ] {
            let target = profile.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, vec![1u8; size]).unwrap();
        }
        let expected =
            serde_json::from_slice(&fs::read(fixture(name).join("expected.json")).unwrap())
                .unwrap();
        let app_data = root.join("tauri").join("de.fanotes.app");
        fs::create_dir_all(&app_data).unwrap();
        Setup {
            root,
            profile,
            app_data,
            vault,
            expected,
        }
    }

    fn options(setup: &Setup, store: SecretStore) -> Options {
        Options {
            source: Some(setup.profile.clone()),
            secret_store: store,
            decryptor: Box::new(|state| {
                os_crypt::Decryptor::new(
                    os_crypt::Scheme::Linux,
                    state,
                    Box::new(|| Err("no keyring in tests".to_owned())),
                    Box::new(os_crypt::dpapi_unprotect),
                )
            }),
            fail_after: None,
            rerun: false,
        }
    }

    /// The export, read back like the renderer step does, compared record by record.
    fn compare_export(app_data: &Path, expected: &Value) -> u64 {
        let plan = web_storage_plan(app_data);
        let databases = expected["indexedDB"].as_array().unwrap();
        assert_eq!(plan["databases"].as_array().unwrap().len(), databases.len());
        let mut compared = 0;
        for (database, want) in plan["databases"].as_array().unwrap().iter().zip(databases) {
            assert_eq!(database["name"], want["name"]);
            assert_eq!(database["version"], want["version"]);
            let mut wanted: Vec<&Value> = want["stores"].as_array().unwrap().iter().collect();
            wanted.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            let stores = database["stores"].as_array().unwrap();
            assert_eq!(stores.len(), wanted.len());
            for (store, want) in stores.iter().zip(wanted) {
                let label = format!("{}/{}", database["name"], store["name"]);
                assert_eq!(store["name"], want["name"]);
                assert_eq!(store["keyPath"], want["keyPath"], "{label}");
                assert_eq!(store["autoIncrement"], want["autoIncrement"], "{label}");
                let mut indexes = want["indexes"].as_array().unwrap().clone();
                indexes.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                assert_eq!(store["indexes"], Value::Array(indexes), "{label}");
                assert_eq!(store["unreadable"], json!([]), "{label}");
                let mut records = Vec::new();
                let mut start = 0;
                loop {
                    let page =
                        web_storage_page(app_data, store["file"].as_str().unwrap(), start).unwrap();
                    records.extend(page["items"].as_array().unwrap().iter().cloned());
                    match page["next"].as_u64() {
                        Some(next) => start = next as usize,
                        None => break,
                    }
                }
                let want = want["records"].as_array().unwrap();
                assert_eq!(records.len(), want.len(), "{label}");
                assert_eq!(store["count"].as_u64().unwrap(), want.len() as u64);
                for (record, want) in records.iter().zip(want) {
                    assert!(
                        same_json(&record["key"], &want["key"]),
                        "{label} key {} != {}",
                        record["key"],
                        want["key"]
                    );
                    assert!(
                        same_json(&record["value"], &want["value"]),
                        "{label} {}:\n{}\n!=\n{}",
                        record["key"],
                        record["value"],
                        want["value"]
                    );
                    compared += 1;
                }
            }
        }
        let local = plan["localStorage"]["file"].as_str().unwrap();
        let entries = web_storage_page(app_data, local, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .clone();
        let want = expected["localStorage"].as_object().unwrap();
        assert_eq!(entries.len(), want.len());
        for entry in entries {
            assert_eq!(
                want.get(entry["name"].as_str().unwrap()),
                Some(&entry["value"])
            );
        }
        compared
    }

    /// What the renderer step reports after writing everything and reading it back equal.
    fn renderer_confirms(app_data: &Path) -> Value {
        let plan = web_storage_plan(app_data);
        let mut stores = Map::new();
        for database in plan["databases"].as_array().unwrap() {
            for store in database["stores"].as_array().unwrap() {
                let count = store["count"].as_u64().unwrap();
                stores.insert(
                    format!(
                        "{}/{}",
                        database["name"].as_str().unwrap(),
                        store["name"].as_str().unwrap()
                    ),
                    json!({"expected": count, "equal": count, "keptExisting": 0, "failed": 0}),
                );
            }
        }
        let local = plan["localStorage"]["count"].as_u64().unwrap();
        json!({"stores": stores, "localStorage": {"expected": local, "equal": local, "keptExisting": 0, "failed": 0}})
    }

    fn secret(app_data: &Path, name: &str) -> Option<String> {
        secrets::get(SecretStore::Memory, &secrets::account(app_data, name)).unwrap()
    }

    #[test]
    fn a_real_electron_profile_migrates_completely_and_stays_untouched() {
        let setup = setup("linux-leveldb");
        let before = tree_hashes(&setup.profile);
        let report = run(&setup.app_data, &options(&setup, SecretStore::Memory));
        assert_eq!(report["status"], "pending", "{report}");
        assert_eq!(
            tree_hashes(&setup.profile),
            before,
            "the Electron profile must not change"
        );

        // Backup: verified, caches and downloads left out, every kept file byte-equal.
        let backup = &report["backup"];
        assert_eq!(backup["verified"], true);
        let excluded: Vec<&str> = backup["excluded"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for name in ["Cache", "GPUCache", "models", "tree-cache-v1", "updates"] {
            assert!(excluded.contains(&name), "{name}");
        }
        let backed_up = tree_hashes(Path::new(backup["files"].as_str().unwrap()));
        for (path, bytes) in &before {
            let excluded_path = backup::EXCLUDED
                .iter()
                .any(|name| path == name || path.starts_with(&format!("{name}/")));
            assert_eq!(backed_up.get(path).is_some(), !excluded_path, "{path}");
            if let Some(copy) = backed_up.get(path) {
                assert_eq!(copy, bytes, "{path}");
            }
        }
        backup::verify(Path::new(backup["path"].as_str().unwrap())).unwrap();

        // Settings and vault.
        let settings: Value =
            serde_json::from_slice(&fs::read(setup.app_data.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["accent"], "#aa3366");
        assert_eq!(settings["editorFontSize"], 18);
        assert_eq!(settings["syncDeviceName"], "Fixture laptop");
        assert_eq!(settings["openAiApiKey"], "", "no secret in settings.json");
        assert_eq!(
            fs::read_to_string(setup.app_data.join("vault-path")).unwrap(),
            format!("{}\n", setup.vault.display())
        );

        // Secrets: every made-up value decrypted from real Electron v10 output; the damaged one is reported.
        for (name, value) in setup.expected["secrets"].as_object().unwrap() {
            assert_eq!(
                secret(&setup.app_data, name).as_deref(),
                value.as_str(),
                "{name}"
            );
        }
        assert_eq!(
            report["secrets"]["needsReentry"],
            json!([{"name": "geminiApiKey", "reason": "cannot-decrypt"}])
        );

        // Sync: the login and the per-vault state continue from the same base.
        let account: Value =
            serde_json::from_str(&secret(&setup.app_data, SYNC_ACCOUNT).unwrap()).unwrap();
        assert_eq!(account, setup.expected["syncAccount"]);
        assert_eq!(
            fs::read(setup.app_data.join("sync/account.secret")).unwrap(),
            b"safe1:"
        );
        assert_eq!(report["sync"]["account"], "migrated");
        assert_eq!(report["sync"]["stateForVault"], true);
        for entry in fs::read_dir(setup.profile.join("sync")).unwrap().flatten() {
            let name = entry.file_name().into_string().unwrap();
            if name.starts_with("state-") {
                assert_eq!(
                    fs::read(entry.path()).unwrap(),
                    fs::read(setup.app_data.join("sync").join(&name)).unwrap()
                );
            }
        }

        // Add-ons and the other carried files.
        for path in [
            "addons/addons.json",
            "addons/fixture-addon/main.js",
            "folder-locations.json",
            "ink-recognition/personal-model.onnx",
        ] {
            assert_eq!(
                fs::read(setup.profile.join(path)).unwrap(),
                fs::read(setup.app_data.join(path)).unwrap(),
                "{path}"
            );
        }

        // IndexedDB and localStorage: every record equal to what Electron itself read back.
        assert!(compare_export(&setup.app_data, &setup.expected) > 100);

        // No made-up secret value appears in any file of the Tauri profile except the backup copy.
        for (path, bytes) in tree_hashes(&setup.app_data) {
            if path.starts_with(backup::BACKUP_DIR) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for value in setup.expected["secrets"].as_object().unwrap().values() {
                assert!(
                    !text.contains(value.as_str().unwrap()),
                    "{path} holds a secret"
                );
            }
            assert!(
                !text.contains("token-fixture-not-real"),
                "{path} holds the sync token"
            );
        }

        // The renderer confirms; the migration completes; a rerun is a no-op.
        let done = web_storage_done(
            &setup.app_data,
            &renderer_confirms(&setup.app_data),
            SecretStore::Memory,
        )
        .unwrap();
        assert_eq!(done["status"], "complete-with-actions");
        assert_eq!(
            done["actions"],
            json!([{"kind": "reenter-secret", "name": "geminiApiKey", "reason": "cannot-decrypt"}])
        );
        assert!(setup.app_data.join(COMPLETE_MARKER).is_file());
        let app_before = tree_hashes(&setup.app_data);
        let again = run(&setup.app_data, &options(&setup, SecretStore::Memory));
        assert_eq!(again, done);
        assert_eq!(
            tree_hashes(&setup.app_data),
            app_before,
            "rerun must change nothing"
        );
        assert_eq!(list_backups(&setup.app_data).as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&setup.root);
    }

    #[test]
    fn an_incomplete_renderer_import_is_refused() {
        let setup = setup("linux-leveldb");
        run(&setup.app_data, &options(&setup, SecretStore::Memory));
        let mut confirmation = renderer_confirms(&setup.app_data);
        confirmation["stores"]["fanotes-handwriting/samples"]["equal"] = json!(3);
        let error =
            web_storage_done(&setup.app_data, &confirmation, SecretStore::Memory).unwrap_err();
        assert!(error.contains("fanotes-handwriting/samples"), "{error}");
        assert_eq!(status(&setup.app_data)["status"], "pending");
        assert!(!setup.app_data.join(COMPLETE_MARKER).exists());
        let _ = fs::remove_dir_all(&setup.root);
    }

    #[test]
    fn a_crash_resumes_and_ends_equal_to_an_uninterrupted_run() {
        let reference = setup("linux-leveldb");
        run(
            &reference.app_data,
            &options(&reference, SecretStore::Memory),
        );
        for phase in ["settings", "secrets", "sync", "files"] {
            let setup = setup("linux-leveldb");
            // A crash in the middle of an earlier backup leaves a partial copy behind.
            let partial = setup
                .app_data
                .join(backup::BACKUP_DIR)
                .join("20200101T000000000Z");
            fs::create_dir_all(partial.join("files")).unwrap();
            fs::write(partial.join("files/config.json"), "{").unwrap();
            let mut crashing = options(&setup, SecretStore::Memory);
            crashing.fail_after = Some(phase);
            let report = run(&setup.app_data, &crashing);
            assert_eq!(report["status"], "failed", "{phase}");
            assert!(!setup.app_data.join(COMPLETE_MARKER).exists());
            let report = run(&setup.app_data, &options(&setup, SecretStore::Memory));
            assert_eq!(report["status"], "pending", "{phase}: {report}");
            assert!(!partial.exists(), "the partial backup is redone");
            assert_eq!(
                list_backups(&setup.app_data).as_array().unwrap().len(),
                1,
                "{phase}: the verified backup is reused"
            );
            assert_eq!(report["secrets"], status(&reference.app_data)["secrets"]);
            assert_eq!(report["sync"], status(&reference.app_data)["sync"]);
            assert_eq!(
                compare_export(&setup.app_data, &setup.expected),
                compare_export(&reference.app_data, &reference.expected)
            );
            for name in setup.expected["secrets"].as_object().unwrap().keys() {
                assert_eq!(
                    secret(&setup.app_data, name),
                    secret(&reference.app_data, name)
                );
            }
            let _ = fs::remove_dir_all(&setup.root);
        }
        let _ = fs::remove_dir_all(&reference.root);
    }

    #[test]
    fn rollback_restores_the_profile_from_the_backup() {
        let setup = setup("linux-leveldb");
        let report = run(&setup.app_data, &options(&setup, SecretStore::Memory));
        let id = report["backup"]["id"].as_str().unwrap();
        // The user removed the Electron profile; the backup brings it back byte for byte.
        let original = tree_hashes(&setup.profile);
        let restored_dir = setup.root.join("restored").join("FaNotes");
        let restored = restore_electron_profile(&setup.app_data, id, &restored_dir).unwrap();
        assert!(restored["restored"].as_u64().unwrap() > 10);
        for (path, bytes) in tree_hashes(&restored_dir) {
            assert_eq!(original.get(&path), Some(&bytes), "{path}");
        }
        // Electron's own data opens again from the restored copy.
        let origin =
            idb::read_origin(&restored_dir.join("IndexedDB/file__0.indexeddb.leveldb")).unwrap();
        assert_eq!(
            origin.databases.len(),
            setup.expected["indexedDB"].as_array().unwrap().len()
        );
        // Never into a directory that holds anything.
        assert!(restore_electron_profile(&setup.app_data, id, &setup.profile).is_err());
        // A damaged backup is refused before anything is written.
        let copy = Path::new(report["backup"]["files"].as_str().unwrap()).join("config.json");
        fs::write(&copy, "{}").unwrap();
        let empty = setup.root.join("restored-2");
        assert!(restore_electron_profile(&setup.app_data, id, &empty)
            .unwrap_err()
            .contains("does not match"));
        assert!(!empty.exists());
        let _ = fs::remove_dir_all(&setup.root);
    }

    #[test]
    fn the_local_sync_seal_and_a_missing_target_keyring() {
        let setup = setup("linux-local1");
        // FaNotes without a usable keyring: no AI secrets stored, the sync login sealed with account.key.
        let report = run(&setup.app_data, &options(&setup, SecretStore::Memory));
        assert_eq!(report["sync"]["account"], "migrated", "{report}");
        let account: Value =
            serde_json::from_str(&secret(&setup.app_data, SYNC_ACCOUNT).unwrap()).unwrap();
        assert_eq!(account, setup.expected["syncAccount"]);

        let other = setup.root.join("tauri-2");
        fs::create_dir_all(&other).unwrap();
        let report = run(&other, &options(&setup, SecretStore::Unavailable));
        assert_eq!(report["sync"]["account"], "needs-sign-in");
        assert_eq!(report["sync"]["reason"], "target-keyring-unavailable");
        assert!(
            !other.join("sync/account.secret").exists(),
            "no marker without a stored login"
        );
        let _ = fs::remove_dir_all(&setup.root);
    }

    #[test]
    fn a_running_electron_blocks_the_copy() {
        let setup = setup("linux-local1");
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            format!("{}-{}", backup_hostname(), std::process::id()),
            setup.profile.join("SingletonLock"),
        )
        .unwrap();
        let report = run(&setup.app_data, &options(&setup, SecretStore::Memory));
        assert_eq!(report["status"], "blocked");
        assert!(!setup.app_data.join(backup::BACKUP_DIR).exists());
        assert!(!setup.app_data.join("settings.json").exists());
        let _ = fs::remove_dir_all(&setup.root);
    }

    #[cfg(unix)]
    fn backup_hostname() -> String {
        let mut buffer = [0u8; 256];
        unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        let end = buffer.iter().position(|byte| *byte == 0).unwrap();
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    }

    #[test]
    fn no_profile_means_nothing_to_do() {
        let root = temp_dir("empty");
        let app_data = root.join("de.fanotes.app");
        fs::create_dir_all(&app_data).unwrap();
        let mut options = Options::native(SecretStore::Memory);
        options.source = None;
        assert_eq!(run(&app_data, &options)["status"], "nothing");
        assert!(app_data.join(COMPLETE_MARKER).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    /// Set FANOTES_ELECTRON_FIXTURE to a profile made by `make-electron-profile.cjs`
    /// on this OS (the Windows CI job does) to migrate a fresh real profile.
    #[test]
    fn a_freshly_generated_electron_profile() {
        let Some(dir) = std::env::var_os("FANOTES_ELECTRON_FIXTURE") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let expected: Value =
            serde_json::from_slice(&fs::read(dir.join("expected.json")).unwrap()).unwrap();
        let app_data = temp_dir("fresh");
        let mut options = Options::native(SecretStore::Memory);
        options.source = Some(dir.join("profile"));
        let report = run(&app_data, &options);
        assert_eq!(report["status"], "pending", "{report}");
        assert!(compare_export(&app_data, &expected) > 100);
        if expected["report"]["encryptionAvailable"] == true {
            for (name, value) in expected["secrets"].as_object().unwrap() {
                assert_eq!(secret(&app_data, name).as_deref(), value.as_str(), "{name}");
            }
        }
        let account: Value =
            serde_json::from_str(&secret(&app_data, SYNC_ACCOUNT).unwrap()).unwrap();
        assert_eq!(account, expected["syncAccount"]);
        let _ = fs::remove_dir_all(&app_data);
    }

    /// Writes the fixture's export for `fixtures/check-renderer-step.cjs`
    /// (FANOTES_MIGRATION_EXPORT_OUT=<dir> cargo test ... -- --ignored write_export_for_renderer_check).
    #[test]
    #[ignore]
    fn write_export_for_renderer_check() {
        let out = PathBuf::from(
            std::env::var_os("FANOTES_MIGRATION_EXPORT_OUT").expect("FANOTES_MIGRATION_EXPORT_OUT"),
        );
        let setup = setup("linux-leveldb");
        run(&setup.app_data, &options(&setup, SecretStore::Memory));
        let _ = fs::remove_dir_all(&out);
        copy_tree(&export_dir(&setup.app_data), &out);
        fs::copy(
            fixture("linux-leveldb").join("expected.json"),
            out.join("expected.json"),
        )
        .unwrap();
        let _ = fs::remove_dir_all(&setup.root);
    }
}
