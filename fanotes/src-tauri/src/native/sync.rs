//! Desktop-only native sync (`fanotes-native:sync-*`), behind the preference
//! "native sync engine (preview)" (off by default).
//!
//! One `fanotes-native:sync-cycle` runs the body of one TypeScript `runCycle`
//! (pull, push, pull after push conflicts) with `fanotes-sync`. Vault files,
//! the per-vault state and the account secrets go through the same
//! `fanotes:sync-*` host channels the TypeScript engine uses on this host, so
//! both engines share one state file and one login. The renderer keeps the
//! scheduler, the account flows and conflict resolution.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use fanotes_sync::api::{SyncApi, SyncError, SYNC_ORIGIN};
use fanotes_sync::engine::{EngineOptions, SyncEngine};
use fanotes_sync::host::{ScanEntry, SyncHost};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::HostState;

static BUSY: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const EVENT: &str = "fanotes-native:sync-event";

/// The Tauri host's sync channels as a `SyncHost`.
struct TauriSyncHost(tauri::AppHandle);

impl TauriSyncHost {
    fn call(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let state = self.0.state::<HostState>();
        let mut host = state
            .0
            .lock()
            .map_err(|_| "Der Host ist belegt.".to_owned())?;
        host.dispatch(channel, args)
    }
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn optional_text(value: Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

impl SyncHost for TauriSyncHost {
    fn vault_id(&self) -> Result<String, String> {
        self.call("fanotes:sync-vault-id", &[])
            .map(|value| value.as_str().unwrap_or("").to_owned())
    }
    fn scan(&self) -> Result<Vec<ScanEntry>, String> {
        let value = self.call("fanotes:sync-scan", &[])?;
        Ok(value
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| ScanEntry {
                path: entry
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                size: number(entry, "size"),
                mtime_ms: number(entry, "mtimeMs"),
            })
            .collect())
    }
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let value = self.call("fanotes:sync-read", &[json!(path)])?;
        base64::engine::general_purpose::STANDARD
            .decode(value.as_str().unwrap_or(""))
            .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())
    }
    fn write(&self, path: &str, bytes: &[u8], mtime_ms: f64) -> Result<ScanEntry, String> {
        let value = self.call(
            "fanotes:sync-write",
            &[
                json!(path),
                json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
                json!(mtime_ms),
            ],
        )?;
        Ok(ScanEntry {
            path: value
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(path)
                .to_owned(),
            size: number(&value, "size"),
            mtime_ms: number(&value, "mtimeMs"),
        })
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        self.call("fanotes:sync-remove", &[json!(path)]).map(|_| ())
    }
    fn read_state(&self, vault_id: &str) -> Result<Option<String>, String> {
        self.call("fanotes:sync-read-state", &[json!(vault_id)])
            .map(optional_text)
    }
    fn write_state(&self, vault_id: &str, json: Option<&str>) -> Result<(), String> {
        self.call("fanotes:sync-write-state", &[json!(vault_id), json!(json)])
            .map(|_| ())
    }
    fn read_secrets(&self) -> Result<Option<String>, String> {
        self.call("fanotes:sync-read-secrets", &[])
            .map(optional_text)
    }
    fn write_secrets(&self, json: Option<&str>) -> Result<(), String> {
        self.call("fanotes:sync-write-secrets", &[json!(json)])
            .map(|_| ())
    }
}

fn preference_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let state = app.state::<HostState>();
    let host = state.0.lock().ok()?;
    Some(host.app_data.join("sync").join("native-engine.json"))
}

fn enabled(app: &tauri::AppHandle) -> bool {
    preference_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn emit(app: &tauri::AppHandle, events: &Arc<Mutex<Vec<Value>>>, mut event: Value) {
    event["seq"] = json!(SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let _ = app.emit(EVENT, event.clone());
    events
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(event);
}

fn error_json(error: &SyncError) -> Value {
    match error.api() {
        Some(api) => json!({
            "status": api.status,
            "message": api.message,
            "entry": api.entry.as_ref().map(|entry| entry.to_json()),
            "reason": api.reason.map(|reason| if reason == fanotes_sync::api::RejectReason::Guard { "guard" } else { "stale" }),
        }),
        None => json!({ "status": -1, "message": error.message() }),
    }
}

fn run_cycle(app: tauri::AppHandle, request: Value) -> Value {
    if !enabled(&app) {
        return json!({ "ran": false, "reason": "disabled" });
    }
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    *BUSY.lock().unwrap_or_else(|error| error.into_inner()) =
        Some(strings(&request, "busy").into_iter().collect());
    let mut options = EngineOptions::new(
        request
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("linux"),
        request
            .get("deviceName")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let excluded = strings(&request, "excludedPrefixes");
    options.excluded_prefixes = Arc::new(move || excluded.clone());
    let history = request
        .get("includeHistory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    options.include_history = Arc::new(move || history);
    let model = request
        .get("includeRecognitionModel")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    options.include_recognition_model = Arc::new(move || model);
    // Unknown means busy: a note the renderer has not reported yet is never written under the editor.
    options.is_path_busy = Arc::new(|path| {
        BUSY.lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_none_or(|busy| busy.contains(path))
    });
    let (handle, sink) = (app.clone(), events.clone());
    options.on_applied = Arc::new(move |written, removed| {
        emit(
            &handle,
            &sink,
            json!({ "kind": "applied", "written": written, "removed": removed }),
        )
    });
    let (handle, sink) = (app.clone(), events.clone());
    options.on_conflict = Arc::new(move |conflict| {
        emit(
            &handle,
            &sink,
            json!({ "kind": "conflict", "path": conflict.path, "copyPath": conflict.copy_path, "at": conflict.at }),
        )
    });
    let (handle, sink) = (app.clone(), events.clone());
    options.on_log = Arc::new(move |entry| {
        emit(
            &handle,
            &sink,
            json!({ "kind": "log", "level": entry.level, "text": entry.text }),
        )
    });
    let api = SyncApi::new(SYNC_ORIGIN)
        .with_accept_language(Some(fanotes_host::desktop_navigator_language().to_owned()));
    let engine = SyncEngine::new(Arc::new(TauriSyncHost(app.clone())), api, options);
    let outcome = match engine.start() {
        Ok(false) => json!({ "ran": false, "reason": "signed-out" }),
        Err(error) => json!({ "ran": true, "error": error_json(&error) }),
        Ok(true) => {
            engine.set_cleared(strings(&request, "cleared"));
            match engine.cycle_body() {
                Ok((conflicts, pushed)) => {
                    json!({ "ran": true, "conflicts": conflicts, "pushed": { "uploads": pushed.uploads, "deletes": pushed.deletes, "conflicts": pushed.conflicts } })
                }
                Err(error) => json!({ "ran": true, "error": error_json(&error) }),
            }
        }
    };
    *BUSY.lock().unwrap_or_else(|error| error.into_inner()) = None;
    let mut outcome = outcome;
    // `start()` logs the sign-in; the renderer engine already did, so that line is not repeated.
    let collected: Vec<Value> = events
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .filter(|event| {
            !(event["kind"] == "log"
                && event["text"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("Angemeldet als ")))
        })
        .cloned()
        .collect();
    outcome["events"] = json!(collected);
    outcome["cleared"] = json!(engine.cleared());
    outcome
}

#[tauri::command(rename = "fanotes-native:sync-cycle")]
async fn sync_cycle(app: tauri::AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let request = args.into_iter().next().unwrap_or(Value::Null);
    tauri::async_runtime::spawn_blocking(move || run_cycle(app, request))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command(rename = "fanotes-native:sync-busy")]
fn sync_busy(args: Vec<Value>) -> Result<Value, String> {
    let paths: HashSet<String> = args
        .first()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect();
    let mut busy = BUSY.lock().unwrap_or_else(|error| error.into_inner());
    if busy.is_some() {
        *busy = Some(paths);
    }
    Ok(Value::Null)
}

#[tauri::command(rename = "fanotes-native:sync-enabled")]
fn sync_enabled(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(json!(enabled(&app)))
}

#[tauri::command(rename = "fanotes-native:sync-set-enabled")]
fn sync_set_enabled(app: tauri::AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let on = args.first().and_then(Value::as_bool).unwrap_or(false);
    let path = preference_path(&app).ok_or("Der Host ist belegt.")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, json!({ "enabled": on }).to_string())
        .map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(json!(on))
}

/// Routes `fanotes-native:sync-*` to this module and everything else to `inner`.
pub fn with_sync_commands(
    inner: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let native: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            sync_cycle,
            sync_busy,
            sync_enabled,
            sync_set_enabled
        ]);
    move |invoke| {
        if invoke.message.command().starts_with("fanotes-native:sync-") {
            native(invoke)
        } else {
            inner(invoke)
        }
    }
}
