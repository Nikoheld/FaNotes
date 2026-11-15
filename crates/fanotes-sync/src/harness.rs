//! One simulated device for the parity harness (`fanotes/scripts/sync-parity`):
//! an in-memory vault, the Rust engine, fault injection and a request log,
//! driven by JSON commands. `fanotes-sync-harness` exposes it on stdin/stdout.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::api::{AfterResponse, Fault, SyncApi, Transport};
use crate::engine::{EngineOptions, SyncEngine};
use crate::host::{MemoryHost, SyncHost};

#[derive(Default)]
struct Settings {
    busy: Vec<String>,
    now: Option<f64>,
    excluded: Vec<String>,
    include_history: bool,
    include_model: bool,
    events: Vec<Value>,
    requests: Vec<String>,
    faults: Vec<Rule>,
}

#[derive(Clone)]
struct Rule {
    method: String,
    path: String,
    mode: String,
    status: u16,
    message: String,
    count: i64,
    stage: &'static str,
}

struct DeviceTransport(Arc<Mutex<Settings>>);

impl DeviceTransport {
    fn take(&self, method: &str, path: &str, before: bool) -> Option<Rule> {
        let mut settings = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let index = settings.faults.iter().position(|rule| {
            rule.count != 0
                && rule.method == method
                && path.contains(&rule.path)
                && (rule.stage == "before") == before
        })?;
        let rule = settings.faults[index].clone();
        settings.faults[index].count -= 1;
        Some(rule)
    }
    fn record(&self, method: &str, path: &str, status: u16) {
        let path = path.split('?').next().unwrap_or(path);
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .requests
            .push(format!("{method} {path} {status}"));
    }
}

impl Transport for DeviceTransport {
    fn before(&self, method: &str, path: &str) -> Option<Fault> {
        let rule = self.take(method, path, true)?;
        if rule.mode == "offline" {
            self.record(method, path, 0);
            Some(Fault::Offline)
        } else {
            self.record(method, path, rule.status);
            Some(Fault::Status(rule.status, rule.message))
        }
    }
    fn after(&self, method: &str, path: &str, status: u16) -> AfterResponse {
        match self.take(method, path, false) {
            Some(rule) if rule.mode == "drop" => {
                self.record(method, path, 0);
                AfterResponse::Drop
            }
            Some(_) => {
                self.record(method, path, status);
                AfterResponse::Corrupt
            }
            None => {
                self.record(method, path, status);
                AfterResponse::Keep
            }
        }
    }
}

pub struct Device {
    pub host: Arc<MemoryHost>,
    name: String,
    origin: String,
    settings: Arc<Mutex<Settings>>,
    pub engine: SyncEngine,
}

fn make_engine(
    host: Arc<MemoryHost>,
    name: &str,
    origin: &str,
    settings: &Arc<Mutex<Settings>>,
) -> SyncEngine {
    let api = SyncApi::new(origin)
        .with_accept_language(Some("de-CH,de;q=0.9".to_owned()))
        .with_transport(Arc::new(DeviceTransport(settings.clone())));
    let mut options = EngineOptions::new("linux", name);
    let s = settings.clone();
    options.is_path_busy = Arc::new(move |path| {
        s.lock()
            .unwrap_or_else(|e| e.into_inner())
            .busy
            .iter()
            .any(|busy| busy == path)
    });
    let s = settings.clone();
    options.excluded_prefixes =
        Arc::new(move || s.lock().unwrap_or_else(|e| e.into_inner()).excluded.clone());
    let s = settings.clone();
    options.include_history =
        Arc::new(move || s.lock().unwrap_or_else(|e| e.into_inner()).include_history);
    let s = settings.clone();
    options.include_recognition_model =
        Arc::new(move || s.lock().unwrap_or_else(|e| e.into_inner()).include_model);
    let s = settings.clone();
    options.now = Some(Arc::new(move || {
        s.lock()
            .unwrap_or_else(|e| e.into_inner())
            .now
            .unwrap_or_else(crate::notemeta::now_ms)
    }));
    let s = settings.clone();
    options.on_applied = Arc::new(move |written, removed| {
        s.lock()
            .unwrap_or_else(|e| e.into_inner())
            .events
            .push(json!({ "applied": { "written": written, "removed": removed } }))
    });
    let s = settings.clone();
    options.on_conflict = Arc::new(move |conflict| {
        s.lock()
            .unwrap_or_else(|e| e.into_inner())
            .events
            .push(json!({ "conflict": { "path": conflict.path, "copyPath": conflict.copy_path } }))
    });
    let s = settings.clone();
    options.on_log = Arc::new(move |entry| {
        s.lock()
            .unwrap_or_else(|e| e.into_inner())
            .events
            .push(json!({ "log": [entry.level, entry.text] }))
    });
    let s = settings.clone();
    options.on_signed_out = Arc::new(move |reason| {
        s.lock()
            .unwrap_or_else(|e| e.into_inner())
            .events
            .push(json!({ "signedOut": reason }))
    });
    SyncEngine::new(host, api, options)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
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

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl Device {
    pub fn new(id: &str, name: &str, origin: &str) -> Self {
        let host = Arc::new(MemoryHost::new(id));
        let settings = Arc::new(Mutex::new(Settings::default()));
        let engine = make_engine(host.clone(), name, origin, &settings);
        Self {
            host,
            name: name.to_owned(),
            origin: origin.to_owned(),
            settings,
            engine,
        }
    }

    fn settings(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.settings.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn drain(&self) -> (Vec<Value>, Vec<String>) {
        let mut settings = self.settings();
        (
            std::mem::take(&mut settings.events),
            std::mem::take(&mut settings.requests),
        )
    }

    /// One command; the answer always has `ok`.
    pub fn handle(&mut self, command: &Value) -> Value {
        let result: Result<Value, String> = (|| {
            match text(command, "cmd").as_str() {
                "register" => self
                    .engine
                    .register(&text(command, "email"), &text(command, "password"))
                    .map(|_| json!({}))
                    .map_err(|e| e.to_string()),
                "login" => self
                    .engine
                    .login(&text(command, "email"), &text(command, "password"))
                    .map(|_| json!({}))
                    .map_err(|e| e.to_string()),
                "logout" => self
                    .engine
                    .logout()
                    .map(|_| json!({}))
                    .map_err(|e| e.to_string()),
                "restart" => {
                    self.engine =
                        make_engine(self.host.clone(), &self.name, &self.origin, &self.settings);
                    self.engine
                        .start()
                        .map(|signed_in| json!({ "signedIn": signed_in }))
                        .map_err(|e| e.to_string())
                }
                "put" => {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(text(command, "b64"))
                        .map_err(|e| e.to_string())?;
                    self.host.put(&text(command, "path"), &bytes);
                    Ok(json!({}))
                }
                "vanish" => {
                    self.host.delete(&text(command, "path"));
                    Ok(json!({}))
                }
                "markDeleted" => self
                    .engine
                    .mark_deleted(&text(command, "path"))
                    .map(|_| json!({}))
                    .map_err(|e| e.to_string()),
                "markCleared" => {
                    self.engine.mark_cleared(&text(command, "path"));
                    Ok(json!({}))
                }
                "settings" => {
                    let mut settings = self.settings();
                    if command.get("busy").is_some() {
                        settings.busy = strings(command, "busy");
                    }
                    if command.get("excluded").is_some() {
                        settings.excluded = strings(command, "excluded");
                    }
                    if let Some(now) = command.get("now").and_then(Value::as_f64) {
                        settings.now = Some(now);
                    }
                    if let Some(flag) = command.get("includeHistory").and_then(Value::as_bool) {
                        settings.include_history = flag;
                    }
                    if let Some(flag) = command.get("includeModel").and_then(Value::as_bool) {
                        settings.include_model = flag;
                    }
                    Ok(json!({}))
                }
                "fault" => {
                    let rule = command.get("rule").cloned().unwrap_or(Value::Null);
                    let mut path = text(&rule, "path");
                    let file = text(&rule, "file");
                    if !file.is_empty() {
                        path = format!(
                            "/files/{}",
                            self.engine.file_id(&file).ok_or("not signed in")?
                        );
                    }
                    let mode = text(&rule, "mode");
                    self.settings().faults.push(Rule {
                        method: text(&rule, "method"),
                        path,
                        stage: if mode == "drop" || mode == "corrupt" {
                            "after"
                        } else {
                            "before"
                        },
                        mode,
                        status: rule.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
                        message: text(&rule, "message"),
                        count: rule.get("count").and_then(Value::as_i64).unwrap_or(1),
                    });
                    Ok(json!({}))
                }
                "clearFaults" => {
                    self.settings().faults.clear();
                    Ok(json!({}))
                }
                "sync" => {
                    self.drain();
                    let started = std::time::Instant::now();
                    self.engine.sync_now("manual").map_err(|e| e.to_string())?;
                    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                    let state = self.engine.public_state();
                    let (events, requests) = self.drain();
                    Ok(
                        json!({ "status": state.status, "error": state.error, "events": events, "requests": requests, "ms": elapsed }),
                    )
                }
                "dump" => {
                    let vault_id = self.host.vault_id()?;
                    let files: Vec<Value> = self.host.files().into_iter().map(|(path, bytes, mtime)| json!({ "path": path, "b64": b64(&bytes), "mtimeMs": mtime })).collect();
                    Ok(
                        json!({ "files": files, "state": self.host.state_json(&vault_id), "secrets": self.host.secrets_json(), "cleared": self.engine.cleared() }),
                    )
                }
                "load" => {
                    // Take over another engine's vault, state and secrets (an engine switch on one device).
                    let vault_id = self.host.vault_id()?;
                    for file in command
                        .get("files")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(text(file, "b64"))
                            .map_err(|e| e.to_string())?;
                        self.host.write(
                            &text(file, "path"),
                            &bytes,
                            file.get("mtimeMs").and_then(Value::as_f64).unwrap_or(0.0),
                        )?;
                    }
                    if let Some(state) = command.get("state").and_then(Value::as_str) {
                        self.host.set_state_json(&vault_id, state);
                    }
                    if let Some(secrets) = command.get("secrets").and_then(Value::as_str) {
                        self.host.write_secrets(Some(secrets))?;
                    }
                    self.engine =
                        make_engine(self.host.clone(), &self.name, &self.origin, &self.settings);
                    let signed_in = self.engine.start().map_err(|e| e.to_string())?;
                    self.engine.set_cleared(strings(command, "cleared"));
                    self.drain();
                    Ok(json!({ "signedIn": signed_in }))
                }
                other => Err(format!("unknown command {other}")),
            }
        })();
        match result {
            Ok(Value::Object(mut map)) => {
                map.insert("ok".into(), json!(true));
                Value::Object(map)
            }
            Ok(_) => json!({ "ok": true }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }
}
