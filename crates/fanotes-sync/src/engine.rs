//! `SyncEngine` from `fanotes/src/lib/sync/engine.ts`. Each method names the
//! TypeScript function it ports; the order of checks is the same.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;

use crate::api::{Download, RemoteEntry, Session, SyncApi, SyncApiError, SyncError};
use crate::conflicts::{self, ConflictGroup};
use crate::crypto::{self, sha256_hex, SyncFileMeta, SyncKdf, SyncKeyWrap, SyncKeys};
use crate::famd::{self, NoteSyncKind};
use crate::homework::{merge_homework_markdown_bytes, HOMEWORK_NOTE_PATH};
use crate::host::{ScanEntry, SyncHost};
use crate::notemeta::{iso_from_millis, now_ms};
use crate::paths::{self, SyncPathOptions};
use crate::state::{LocalBase, PersistedState, Secrets, SyncConflict};

const MAX_LOG: usize = 120;
const MAX_FILE_BYTES: f64 = 100.0 * 1024.0 * 1024.0;
const CONCURRENCY: usize = 3;

type Callback<T> = Arc<dyn Fn() -> T + Send + Sync>;

/// `SyncEngineOptions`.
#[derive(Clone)]
pub struct EngineOptions {
    pub platform: String,
    pub device_name: Callback<String>,
    pub automatic: Callback<bool>,
    pub is_path_busy: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub excluded_prefixes: Callback<Vec<String>>,
    pub include_recognition_model: Callback<bool>,
    pub include_history: Callback<bool>,
    pub on_applied: Arc<dyn Fn(&[String], &[String]) + Send + Sync>,
    pub on_conflict: Arc<dyn Fn(&SyncConflict) + Send + Sync>,
    pub on_signed_out: Arc<dyn Fn(&str) + Send + Sync>,
    pub on_log: Arc<dyn Fn(&LogEntry) + Send + Sync>,
    pub now: Option<Callback<f64>>,
    /// Extension point for structured merges (story scenes from `fanotes-story`):
    /// `(path, local, remote)` → merged bytes, or `None` for the ordinary conflict copy.
    /// Consulted where the homework merge is, only when both sides changed and are present.
    /// Unset by default, so the engine behaves exactly like the TypeScript one.
    pub content_merge: Option<Arc<dyn Fn(&str, &[u8], &[u8]) -> Option<Vec<u8>> + Send + Sync>>,
}

impl EngineOptions {
    pub fn new(platform: &str, device_name: &str) -> Self {
        let name = device_name.to_owned();
        Self {
            platform: platform.to_owned(),
            device_name: Arc::new(move || name.clone()),
            automatic: Arc::new(|| false),
            is_path_busy: Arc::new(|_| false),
            excluded_prefixes: Arc::new(Vec::new),
            include_recognition_model: Arc::new(|| false),
            include_history: Arc::new(|| false),
            on_applied: Arc::new(|_, _| {}),
            on_conflict: Arc::new(|_| {}),
            on_signed_out: Arc::new(|_| {}),
            on_log: Arc::new(|_| {}),
            now: None,
            content_merge: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LogEntry {
    pub at: String,
    pub level: &'static str,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct PublicState {
    pub status: String,
    pub error: Option<String>,
    pub last_sync_at: Option<String>,
    pub pending_local: usize,
    pub tracked_files: usize,
    pub open_conflicts: usize,
    pub conflicts: Vec<SyncConflict>,
    pub log: Vec<LogEntry>,
    pub account: Option<(String, String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Applied {
    Written,
    Removed,
    Conflict,
    Skipped,
    Deferred,
    Noop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Upload {
    Uploaded,
    Unchanged,
    Conflict,
    Skipped,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pushed {
    pub uploads: usize,
    pub deletes: usize,
    pub conflicts: usize,
}

struct LocalSnapshot {
    bytes: Vec<u8>,
    sha256: String,
    raw_sha256: String,
    identity: String,
    kind: NoteSyncKind,
    size: f64,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    keys: Option<Arc<SyncKeys>>,
    vault_secret: Option<String>,
    mcp_reader: Option<String>,
    vault_id: Option<String>,
    state: Option<PersistedState>,
    cleared: HashSet<String>,
    scan_cache: Option<HashMap<String, ScanEntry>>,
    public: PublicState,
}

pub struct SyncEngine {
    host: Arc<dyn SyncHost>,
    api: SyncApi,
    options: EngineOptions,
    inner: Mutex<Inner>,
    cycle: Mutex<()>,
}

fn host_err(message: String) -> SyncError {
    SyncError::Other(message)
}

/// `runLimited(items, limit, task)` on threads; the first error stops the workers.
fn run_limited<T: Sync>(
    items: &[T],
    limit: usize,
    task: impl Fn(&T) -> Result<(), SyncError> + Sync,
) -> Result<(), SyncError> {
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let failure: Mutex<Option<SyncError>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..limit.min(items.len()) {
            std::thread::Builder::new()
                .stack_size(16 * 1024 * 1024)
                .spawn_scoped(scope, || loop {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(item) = items.get(index) else { return };
                    if let Err(error) = task(item) {
                        stop.store(true, Ordering::SeqCst);
                        failure
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .get_or_insert(error);
                        return;
                    }
                })
                .expect("sync worker");
        }
    });
    match failure.into_inner().unwrap_or_else(|e| e.into_inner()) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

impl SyncEngine {
    pub fn new(host: Arc<dyn SyncHost>, api: SyncApi, options: EngineOptions) -> Self {
        let inner = Inner {
            public: PublicState {
                status: "unavailable".to_owned(),
                ..Default::default()
            },
            ..Default::default()
        };
        Self {
            host,
            api,
            options,
            inner: Mutex::new(inner),
            cycle: Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn public_state(&self) -> PublicState {
        self.lock().public.clone()
    }

    pub fn session(&self) -> Option<Session> {
        self.lock().session.clone()
    }

    pub fn state_snapshot(&self) -> Option<PersistedState> {
        self.lock().state.clone()
    }

    /// The server id of `path` under this account's keys (`fileIdFor`).
    pub fn file_id(&self, path: &str) -> Option<String> {
        self.lock()
            .keys
            .as_ref()
            .map(|keys| crypto::file_id_for(keys, path))
    }

    pub fn cleared(&self) -> Vec<String> {
        self.lock().cleared.iter().cloned().collect()
    }

    fn now(&self) -> f64 {
        self.options.now.as_ref().map_or_else(now_ms, |now| now())
    }

    fn path_options(&self) -> SyncPathOptions {
        SyncPathOptions {
            excluded_prefixes: (self.options.excluded_prefixes)(),
            include_recognition_model: (self.options.include_recognition_model)(),
            include_history: (self.options.include_history)(),
        }
    }

    fn accepts(&self, path: &str) -> bool {
        paths::is_syncable_path(path, &self.path_options())
    }

    fn busy(&self, path: &str) -> bool {
        (self.options.is_path_busy)(path)
    }

    fn log(&self, level: &'static str, text: String) {
        let entry = LogEntry {
            at: iso_from_millis(self.now()),
            level,
            text,
        };
        {
            let mut inner = self.lock();
            inner.public.log.push(entry.clone());
            let skip = inner.public.log.len().saturating_sub(MAX_LOG);
            inner.public.log.drain(..skip);
        }
        (self.options.on_log)(&entry);
    }

    fn device_name(&self) -> String {
        paths::device_info(&(self.options.device_name)(), &self.options.platform).0
    }

    fn device_info(&self) -> (String, String) {
        paths::device_info(&(self.options.device_name)(), &self.options.platform)
    }

    fn require(&self) -> Result<(Session, Arc<SyncKeys>), SyncError> {
        let inner = self.lock();
        match (&inner.session, &inner.keys, &inner.state) {
            (Some(session), Some(keys), Some(_)) => Ok((session.clone(), keys.clone())),
            _ => Err(SyncError::Other("Sync ist nicht angemeldet.".to_owned())),
        }
    }

    fn with_state<R>(&self, task: impl FnOnce(&mut PersistedState) -> R) -> Option<R> {
        let mut inner = self.lock();
        inner.state.as_mut().map(task)
    }

    fn base_of(&self, path: &str) -> Option<LocalBase> {
        self.lock()
            .state
            .as_ref()
            .and_then(|state| state.files.get(path).cloned())
    }

    fn set_base(&self, path: &str, base: LocalBase) {
        self.with_state(|state| state.files.insert(path.to_owned(), base));
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /// `start()` without timers: restore the session from the host secrets.
    pub fn start(&self) -> Result<bool, SyncError> {
        let vault_id = self.host.vault_id().map_err(host_err)?;
        self.lock().vault_id = Some(vault_id);
        let Some(secrets) = Secrets::parse(self.host.read_secrets().map_err(host_err)?.as_deref())
        else {
            self.lock().public.status = "signed-out".to_owned();
            return Ok(false);
        };
        self.adopt_secrets(&secrets)?;
        self.log("info", format!("Angemeldet als {}.", secrets.email));
        Ok(true)
    }

    fn adopt_secrets(&self, secrets: &Secrets) -> Result<(), SyncError> {
        let secret = crypto::from_base64(&secrets.vault_secret)?;
        let keys = Arc::new(crypto::derive_sync_keys(&secret));
        let vault_id = match self.lock().vault_id.clone() {
            Some(id) => id,
            None => self.host.vault_id().map_err(host_err)?,
        };
        let state = PersistedState::parse(
            self.host
                .read_state(&vault_id)
                .map_err(host_err)?
                .as_deref(),
            &secrets.account_id,
        );
        let mut inner = self.lock();
        inner.keys = Some(keys);
        inner.vault_secret = Some(secrets.vault_secret.clone());
        inner.session = Some(Session {
            account_id: secrets.account_id.clone(),
            device_id: secrets.device_id.clone(),
            token: secrets.token.clone(),
            expires_at: secrets.expires_at.clone(),
            email: secrets.email.clone(),
        });
        inner.mcp_reader = secrets.mcp_reader.clone();
        inner.vault_id = Some(vault_id);
        inner.public.status = "idle".to_owned();
        inner.public.account = Some((
            secrets.email.clone(),
            secrets.account_id.clone(),
            secrets.device_id.clone(),
        ));
        inner.public.last_sync_at = state.last_sync_at.clone();
        inner.public.conflicts = state.conflicts.clone();
        inner.public.tracked_files = state.files.len();
        inner.public.error = None;
        inner.state = Some(state);
        Ok(())
    }

    /// `switchVault()`.
    pub fn switch_vault(&self) -> Result<(), SyncError> {
        let _cycle = self.cycle.lock().unwrap_or_else(|e| e.into_inner());
        let vault_id = self.host.vault_id().map_err(host_err)?;
        let account = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.account_id.clone());
        self.lock().vault_id = Some(vault_id.clone());
        if let Some(account) = account {
            let state = PersistedState::parse(
                self.host
                    .read_state(&vault_id)
                    .map_err(host_err)?
                    .as_deref(),
                &account,
            );
            self.lock().state = Some(state);
            self.publish_counts();
        }
        Ok(())
    }

    fn persist_state(&self) -> Result<(), SyncError> {
        let (vault_id, json) = {
            let inner = self.lock();
            match (&inner.vault_id, &inner.state) {
                (Some(vault_id), Some(state)) => (vault_id.clone(), state.to_json_string()),
                _ => return Ok(()),
            }
        };
        self.host
            .write_state(&vault_id, Some(&json))
            .map_err(host_err)?;
        self.publish_counts();
        Ok(())
    }

    fn publish_counts(&self) {
        let mut inner = self.lock();
        if let Some(state) = inner.state.clone() {
            inner.public.tracked_files = state.files.len();
            inner.public.conflicts = state.conflicts.clone();
            inner.public.last_sync_at = state.last_sync_at.clone();
        }
    }

    // ── Account ─────────────────────────────────────────────────────────────

    /// `register(email, password)`.
    pub fn register(&self, email: &str, password: &str) -> Result<(), SyncError> {
        if let Some(problem) = crypto::password_problems(password) {
            return Err(SyncError::Other(problem.to_owned()));
        }
        let kdf = crypto::new_kdf();
        let (wrapping, auth_key) = crypto::derive_from_password(password, &kdf)?;
        let secret = crypto::new_vault_secret();
        let wrap = crypto::wrap_vault_secret(&secret, &wrapping);
        let normalized = crate::jsjson::js_trim(email).to_lowercase();
        let device = self.device_info();
        let result =
            self.api
                .register(&normalized, &auth_key, &kdf, &wrap, (&device.0, &device.1))?;
        self.sign_in_with(&result, &normalized, &secret)?;
        self.log("info", "Konto erstellt. Der Vault-Schlüssel wurde auf diesem Gerät erzeugt und verschlüsselt hinterlegt.".to_owned());
        Ok(())
    }

    /// `login(email, password)`.
    pub fn login(&self, email: &str, password: &str) -> Result<(), SyncError> {
        let normalized = crate::jsjson::js_trim(email).to_lowercase();
        let kdf_value = self.api.prelogin(&normalized)?;
        if !crypto::is_valid_kdf_json(&kdf_value) {
            return Err(SyncError::Other(
                "Der Server hat unbrauchbare Schlüsselparameter geliefert.".to_owned(),
            ));
        }
        let kdf: SyncKdf = serde_json::from_value(kdf_value)
            .map_err(|error| SyncError::Other(error.to_string()))?;
        let (wrapping, auth_key) = crypto::derive_from_password(password, &kdf)?;
        let device = self.device_info();
        let result = self
            .api
            .login(&normalized, &auth_key, (&device.0, &device.1))?;
        let wrap: SyncKeyWrap =
            serde_json::from_value(result.get("vaultKeyWrap").cloned().unwrap_or(Value::Null))
                .map_err(|_| {
                    SyncError::Other(
                "Der Vault-Schlüssel konnte mit diesem Passwort nicht entschlüsselt werden."
                    .to_owned(),
            )
                })?;
        let secret = crypto::unwrap_vault_secret(&wrap, &wrapping)?;
        self.sign_in_with(&result, &normalized, &secret)?;
        self.log(
            "info",
            format!("Angemeldet als {normalized}. Die Notizen des Kontos werden geholt."),
        );
        Ok(())
    }

    fn sign_in_with(&self, result: &Value, email: &str, secret: &[u8]) -> Result<(), SyncError> {
        let _cycle = self.cycle.lock().unwrap_or_else(|e| e.into_inner());
        let text = |key: &str| {
            result
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        let secrets = Secrets {
            account_id: text("accountId"),
            device_id: text("deviceId"),
            token: text("token"),
            expires_at: text("expiresAt"),
            email: email.to_owned(),
            vault_secret: crypto::to_base64(secret),
            mcp_reader: None,
        };
        let vault_id = match self.lock().vault_id.clone() {
            Some(id) => Some(id),
            None => self.host.vault_id().ok(),
        };
        if let Some(vault_id) = &vault_id {
            self.host.write_state(vault_id, None).map_err(host_err)?;
            self.lock().vault_id = Some(vault_id.clone());
        }
        self.host
            .write_secrets(Some(&secrets.to_json_string()))
            .map_err(host_err)?;
        self.adopt_secrets(&secrets)
    }

    /// `logout()`.
    pub fn logout(&self) -> Result<(), SyncError> {
        let _cycle = self.cycle.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = self.session() {
            let _ = self.api.logout(&session);
        }
        self.forget_session()?;
        self.log(
            "info",
            "Abgemeldet. Die Notizen bleiben auf diesem Gerät.".to_owned(),
        );
        Ok(())
    }

    fn forget_session(&self) -> Result<(), SyncError> {
        let vault_id = {
            let mut inner = self.lock();
            inner.session = None;
            inner.keys = None;
            inner.vault_secret = None;
            inner.mcp_reader = None;
            inner.state = None;
            inner.public.status = "signed-out".to_owned();
            inner.public.account = None;
            inner.public.pending_local = 0;
            inner.public.tracked_files = 0;
            inner.public.conflicts.clear();
            inner.public.open_conflicts = 0;
            inner.public.error = None;
            inner.vault_id.clone()
        };
        self.host.write_secrets(None).map_err(host_err)?;
        if let Some(vault_id) = vault_id {
            self.host.write_state(&vault_id, None).map_err(host_err)?;
        }
        Ok(())
    }

    /// `refreshAccount()`.
    pub fn refresh_account(&self) -> Result<Option<Value>, SyncError> {
        let Some(session) = self.session() else {
            return Ok(None);
        };
        match self.api.account(&session) {
            Ok(info) => Ok(Some(info)),
            Err(error) => {
                if error.api().is_some_and(SyncApiError::unauthorized) {
                    self.handle_unauthorized()?;
                }
                Err(error)
            }
        }
    }

    pub fn remove_device(&self, device_id: &str) -> Result<(), SyncError> {
        let session = self
            .session()
            .ok_or_else(|| SyncError::Other("Nicht angemeldet.".to_owned()))?;
        self.api.remove_device(&session, device_id)?;
        self.refresh_account().map(|_| ())
    }

    /// `changePassword(current, next)` (the Grok connector key is dropped as in TypeScript).
    pub fn change_password(&self, current: &str, next: &str) -> Result<(), SyncError> {
        let (session, vault_secret) = {
            let inner = self.lock();
            match (&inner.session, &inner.vault_secret) {
                (Some(session), Some(secret)) => (session.clone(), secret.clone()),
                _ => return Err(SyncError::Other("Nicht angemeldet.".to_owned())),
            }
        };
        if let Some(problem) = crypto::password_problems(next) {
            return Err(SyncError::Other(problem.to_owned()));
        }
        let current_kdf: SyncKdf = serde_json::from_value(self.api.prelogin(&session.email)?)
            .map_err(|error| SyncError::Other(error.to_string()))?;
        let (_, current_auth) = crypto::derive_from_password(current, &current_kdf)?;
        let kdf = crypto::new_kdf();
        let (wrapping, next_auth) = crypto::derive_from_password(next, &kdf)?;
        let wrap = crypto::wrap_vault_secret(&crypto::from_base64(&vault_secret)?, &wrapping);
        self.api
            .change_password(&session, &current_auth, &next_auth, &kdf, &wrap)?;
        self.lock().mcp_reader = None;
        let secrets = Secrets {
            account_id: session.account_id,
            device_id: session.device_id,
            token: session.token,
            expires_at: session.expires_at,
            email: session.email,
            vault_secret,
            mcp_reader: None,
        };
        self.host
            .write_secrets(Some(&secrets.to_json_string()))
            .map_err(host_err)?;
        self.log("info", "Passwort geändert; alle anderen Geräte müssen sich neu anmelden. Grok-Freigaben wurden widerrufen.".to_owned());
        Ok(())
    }

    /// `deleteAccount(password)`.
    pub fn delete_account(&self, password: &str) -> Result<(), SyncError> {
        let session = self
            .session()
            .ok_or_else(|| SyncError::Other("Nicht angemeldet.".to_owned()))?;
        let _cycle = self.cycle.lock().unwrap_or_else(|e| e.into_inner());
        let kdf: SyncKdf = serde_json::from_value(self.api.prelogin(&session.email)?)
            .map_err(|error| SyncError::Other(error.to_string()))?;
        let (_, auth) = crypto::derive_from_password(password, &kdf)?;
        self.api.delete_account(&session, &auth)?;
        self.forget_session()?;
        self.log(
            "info",
            "Konto und alle Daten auf dem Server gelöscht.".to_owned(),
        );
        Ok(())
    }

    fn handle_unauthorized(&self) -> Result<(), SyncError> {
        let reason = "Die Anmeldung ist abgelaufen oder wurde von einem anderen Gerät beendet. Bitte erneut anmelden.";
        self.forget_session()?;
        self.lock().public.error = Some(reason.to_owned());
        self.log("warn", reason.to_owned());
        (self.options.on_signed_out)(reason);
        Ok(())
    }

    // ── Marks ───────────────────────────────────────────────────────────────

    /// `markCleared(path)`.
    pub fn mark_cleared(&self, path: &str) {
        self.lock().cleared.insert(path.to_owned());
    }

    pub fn set_cleared(&self, paths: impl IntoIterator<Item = String>) {
        self.lock().cleared = paths.into_iter().collect();
    }

    /// `markDeleted(path)`.
    pub fn mark_deleted(&self, path: &str) -> Result<(), SyncError> {
        let normal = path.trim_matches('/').to_owned();
        if normal.is_empty()
            || normal
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Ok(());
        }
        let changed = self.with_state(|state| {
            if !state.pending_deletes.contains(&normal) {
                state.pending_deletes.push(normal.clone());
            }
        });
        if changed.is_some() {
            self.persist_state()?;
        }
        Ok(())
    }

    // ── Cycle ───────────────────────────────────────────────────────────────

    /// The body of `runCycle`: pull, push, pull again after push conflicts.
    /// On error the state is persisted before the error is returned.
    pub fn cycle_body(&self) -> Result<(usize, Pushed), SyncError> {
        let result = (|| {
            let mut conflicts = self.pull()?;
            let pushed = self.push()?;
            if pushed.conflicts > 0 {
                conflicts += self.pull()?;
            }
            Ok((conflicts, pushed))
        })();
        if result.is_err() {
            let _ = self.persist_state();
        }
        result
    }

    /// `syncNow()` → `runCycle(reason)`: one full cycle, serialised with every other cycle.
    pub fn sync_now(&self, reason: &str) -> Result<(), SyncError> {
        let _cycle = self.cycle.lock().unwrap_or_else(|e| e.into_inner());
        if self.lock().session.is_none() {
            return Ok(());
        }
        self.run_cycle(reason);
        Ok(())
    }

    fn run_cycle(&self, reason: &str) {
        if self.require().is_err() {
            return;
        }
        {
            let mut inner = self.lock();
            inner.public.status = "syncing".to_owned();
            inner.public.error = None;
        }
        match self.cycle_body() {
            Ok((conflicts, pushed)) => {
                let at = iso_from_millis(self.now());
                self.with_state(|state| state.last_sync_at = Some(at));
                if let Err(error) = self.persist_state() {
                    self.fail(error);
                    return;
                }
                {
                    let mut inner = self.lock();
                    inner.public.status = "idle".to_owned();
                    inner.public.pending_local = 0;
                }
                if reason != "timer" || pushed.uploads > 0 || pushed.deletes > 0 || conflicts > 0 {
                    let extra = if conflicts > 0 {
                        format!(", {conflicts} Konflikt(e)")
                    } else {
                        String::new()
                    };
                    self.log(
                        "info",
                        format!(
                            "Sync abgeschlossen ({} hochgeladen, {} gelöscht{extra}).",
                            pushed.uploads, pushed.deletes
                        ),
                    );
                }
            }
            Err(error) => self.fail(error),
        }
    }

    fn fail(&self, error: SyncError) {
        if error.api().is_some_and(SyncApiError::unauthorized) {
            let _ = self.handle_unauthorized();
            return;
        }
        let offline = error.api().is_some_and(SyncApiError::offline);
        {
            let mut inner = self.lock();
            inner.public.status = if offline { "offline" } else { "error" }.to_owned();
            inner.public.error = Some(error.message().to_owned());
        }
        self.log(
            if offline { "warn" } else { "error" },
            error.message().to_owned(),
        );
    }

    // ── Pull ────────────────────────────────────────────────────────────────

    fn local_snapshot(&self, path: &str) -> Option<LocalSnapshot> {
        let bytes = self.host.read(path).ok()?;
        let size = bytes.len() as f64;
        let kind = famd::note_sync_kind(path, &bytes);
        let unreadable = |bytes: Vec<u8>| LocalSnapshot {
            bytes,
            sha256: String::new(),
            raw_sha256: String::new(),
            identity: String::new(),
            kind: NoteSyncKind::Unreadable,
            size,
        };
        if kind == NoteSyncKind::Unreadable {
            return Some(unreadable(bytes));
        }
        // A throw in `identitySyncBytes` or `canonicalSyncBytes` makes `localSnapshot` return null.
        let identity = match famd::identity_sync_bytes(path, &bytes).ok()? {
            Some(identity) => sha256_hex(&identity),
            None => return Some(unreadable(bytes)),
        };
        let canonical = famd::canonical_sync_bytes(path, &bytes).ok()?;
        let raw_sha256 = sha256_hex(&bytes);
        let sha256 = match &canonical {
            std::borrow::Cow::Borrowed(_) => raw_sha256.clone(),
            std::borrow::Cow::Owned(owned) => sha256_hex(owned),
        };
        drop(canonical);
        Some(LocalSnapshot {
            bytes,
            sha256,
            raw_sha256,
            identity,
            kind,
            size,
        })
    }

    fn stat_of(&self, path: &str) -> Result<Option<ScanEntry>, SyncError> {
        if self.lock().scan_cache.is_none() {
            let scanned = self.host.scan().map_err(host_err)?;
            let map = scanned
                .into_iter()
                .map(|entry| (entry.path.clone(), entry))
                .collect();
            self.lock().scan_cache.get_or_insert(map);
        }
        Ok(self
            .lock()
            .scan_cache
            .as_ref()
            .and_then(|cache| cache.get(path).cloned()))
    }

    fn remember_skip(&self, entry: &RemoteEntry) {
        if entry.id.is_empty() {
            return;
        }
        self.with_state(|state| {
            state.skipped.retain(|item| item.id != entry.id);
            state.skipped.push(entry.clone());
            let skip = state.skipped.len().saturating_sub(200);
            state.skipped.drain(..skip);
        });
    }

    fn forget_skip(&self, id: &str) {
        self.with_state(|state| state.skipped.retain(|item| item.id != id));
    }

    fn id_index(&self) -> Mutex<HashMap<String, String>> {
        let inner = self.lock();
        let map = inner
            .state
            .as_ref()
            .map(|state| {
                state
                    .files
                    .iter()
                    .map(|(path, base)| (base.id.clone(), path.clone()))
                    .collect()
            })
            .unwrap_or_default();
        Mutex::new(map)
    }

    /// `pull()`: returns the number of conflicts.
    fn pull(&self) -> Result<usize, SyncError> {
        let (session, _) = self.require()?;
        let mut pending: Vec<RemoteEntry> = Vec::new();
        let mut since = self.with_state(|state| state.cursor).unwrap_or(0);
        for _ in 0..200 {
            let page = self.api.changes(&session, since)?;
            pending.extend(page.entries);
            since = page.next_since;
            if !page.more {
                break;
            }
        }
        let seen: HashSet<String> = pending.iter().map(|entry| entry.id.clone()).collect();
        let skipped = self
            .with_state(|state| state.skipped.clone())
            .unwrap_or_default();
        pending.extend(
            skipped
                .into_iter()
                .filter(|entry| !seen.contains(&entry.id)),
        );
        if pending.is_empty() {
            return Ok(0);
        }
        let id_index = self.id_index();
        let results: Mutex<(usize, Vec<String>, Vec<String>, i64)> =
            Mutex::new((0, Vec::new(), Vec::new(), i64::MAX));
        run_limited(&pending, CONCURRENCY, |entry| {
            let (result, path) = match self.apply_remote(entry, &id_index) {
                Ok(outcome) => outcome,
                Err(error) => {
                    if error.cycle_wide() {
                        return Err(error);
                    }
                    self.log("warn", format!("Ein Eintrag konnte nicht übernommen werden und wird später erneut versucht ({}).", error.message()));
                    (Applied::Skipped, None)
                }
            };
            let mut results = results.lock().unwrap_or_else(|e| e.into_inner());
            if result == Applied::Conflict {
                results.0 += 1;
            }
            if let Some(path) = &path {
                if matches!(result, Applied::Written | Applied::Conflict) {
                    results.1.push(path.clone());
                }
                if result == Applied::Removed {
                    results.2.push(path.clone());
                }
            }
            match result {
                Applied::Deferred => results.3 = results.3.min(entry.revision - 1),
                Applied::Skipped => {
                    drop(results);
                    self.remember_skip(entry);
                }
                _ => {
                    drop(results);
                    self.forget_skip(&entry.id);
                }
            }
            Ok(())
        })?;
        let (conflicts, written, removed, hold) =
            results.into_inner().unwrap_or_else(|e| e.into_inner());
        self.with_state(|state| state.cursor = state.cursor.max(since.min(hold)));
        self.persist_state()?;
        if !written.is_empty() || !removed.is_empty() {
            (self.options.on_applied)(&written, &removed);
        }
        Ok(conflicts)
    }

    /// `applyRemote(entry, idIndex)`.
    fn apply_remote(
        &self,
        entry: &RemoteEntry,
        id_index: &Mutex<HashMap<String, String>>,
    ) -> Result<(Applied, Option<String>), SyncError> {
        let Ok((session, keys)) = self.require() else {
            return Ok((Applied::Skipped, None));
        };
        let known_path = id_index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&entry.id)
            .cloned();

        if entry.deleted {
            let Some(known) = known_path else {
                return Ok((Applied::Noop, None));
            };
            let base = match self.base_of(&known) {
                Some(base) if entry.revision > base.revision => base,
                _ => return Ok((Applied::Noop, Some(known))),
            };
            if self.busy(&known) {
                return Ok((Applied::Deferred, Some(known)));
            }
            let Some(local) = self.local_snapshot(&known) else {
                self.with_state(|state| state.files.remove(&known));
                id_index
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&entry.id);
                return Ok((Applied::Noop, Some(known)));
            };
            if local.kind != NoteSyncKind::Unreadable
                && (local.sha256 == base.sha256 || local.raw_sha256 == base.sha256)
            {
                self.host.remove(&known).map_err(host_err)?;
                self.with_state(|state| state.files.remove(&known));
                id_index
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&entry.id);
                return Ok((Applied::Removed, Some(known)));
            }
            self.set_base(
                &known,
                LocalBase {
                    revision: entry.revision,
                    sha256: String::new(),
                    ..base
                },
            );
            self.log("info", format!("„{known}“ wurde anderswo gelöscht, hier aber geändert – die lokale Fassung bleibt."));
            return Ok((Applied::Noop, Some(known)));
        }

        let (Some(encoded_meta), Some(entry_sha)) = (
            entry.meta.as_deref().filter(|m| !m.is_empty()),
            entry.sha256.as_deref().filter(|s| !s.is_empty()),
        ) else {
            return Ok((Applied::Skipped, None));
        };
        let _ = entry_sha;
        let meta = match crypto::decrypt_meta(&keys, &entry.id, encoded_meta) {
            Ok(meta) => meta,
            Err(error) => {
                self.log(
                    "warn",
                    format!(
                        "Metadaten eines Eintrags konnten nicht entschlüsselt werden ({}).",
                        error.0
                    ),
                );
                return Ok((Applied::Skipped, None));
            }
        };
        let path = meta.path.clone();
        if !self.accepts(&path) {
            return Ok((Applied::Skipped, None));
        }
        let base = self.base_of(&path);
        if base
            .as_ref()
            .is_some_and(|base| base.id == entry.id && entry.revision <= base.revision)
        {
            return Ok((Applied::Noop, Some(path)));
        }
        if self.busy(&path) {
            return Ok((Applied::Deferred, Some(path)));
        }
        let local = self.local_snapshot(&path);
        let index = |path: &str| {
            id_index
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(entry.id.clone(), path.to_owned());
        };
        if let Some(local) = local.as_ref().filter(|local| {
            local.kind != NoteSyncKind::Unreadable
                && (local.sha256 == meta.sha256 || local.raw_sha256 == meta.sha256)
        }) {
            let stat = self.stat_of(&path)?;
            self.set_base(
                &path,
                LocalBase {
                    id: entry.id.clone(),
                    revision: entry.revision,
                    sha256: if local.sha256.is_empty() {
                        meta.sha256.clone()
                    } else {
                        local.sha256.clone()
                    },
                    size: stat.as_ref().map_or(local.size, |stat| stat.size),
                    mtime_ms: stat.as_ref().map_or(0.0, |stat| stat.mtime_ms),
                    content_sha256: Some(local.identity.clone()),
                    blank: local.kind == NoteSyncKind::Blank,
                },
            );
            index(&path);
            return Ok((Applied::Noop, Some(path)));
        }
        let local_changed = local.as_ref().is_some_and(|local| match &base {
            None => true,
            Some(_) if local.kind == NoteSyncKind::Unreadable => true,
            Some(base) => match base
                .content_sha256
                .as_deref()
                .filter(|content| !content.is_empty())
            {
                Some(content) => local.identity != content,
                None => local.sha256 != base.sha256 && local.raw_sha256 != base.sha256,
            },
        });
        let (revision, blob, blob_sha) = match self.api.download(&session, &entry.id)? {
            Download::Deleted { .. } => return Ok((Applied::Noop, Some(path))),
            Download::Blob {
                revision,
                sha256,
                blob,
                ..
            } => (revision, blob, sha256),
        };
        if sha256_hex(&blob) != blob_sha {
            return Err(SyncError::Other(format!(
                "Die Datei „{path}“ kam beschädigt vom Server."
            )));
        }
        let plain = crypto::decrypt_bytes(&keys, &entry.id, &blob)?;
        if sha256_hex(&plain) != meta.sha256 {
            return Err(SyncError::Other(format!(
                "Die Prüfsumme von „{path}“ stimmt nach dem Entschlüsseln nicht."
            )));
        }
        let plain_canonical_sha = match famd::canonical_sync_bytes(&path, &plain)? {
            std::borrow::Cow::Borrowed(_) => meta.sha256.clone(),
            std::borrow::Cow::Owned(owned) => sha256_hex(&owned),
        };
        let plain_identity = famd::identity_sync_bytes(&path, &plain)?
            .map(|bytes| sha256_hex(&bytes))
            .unwrap_or_default();
        if let Some(local) = local.as_ref().filter(|local| {
            local.kind != NoteSyncKind::Unreadable
                && (plain_canonical_sha == local.sha256
                    || (!plain_identity.is_empty() && plain_identity == local.identity))
        }) {
            let stat = self.stat_of(&path)?;
            self.set_base(
                &path,
                LocalBase {
                    id: entry.id.clone(),
                    revision,
                    sha256: plain_canonical_sha,
                    size: stat.as_ref().map_or(local.size, |stat| stat.size),
                    mtime_ms: stat.as_ref().map_or(0.0, |stat| stat.mtime_ms),
                    content_sha256: Some(if local.identity.is_empty() {
                        plain_identity
                    } else {
                        local.identity.clone()
                    }),
                    blank: local.kind == NoteSyncKind::Blank,
                },
            );
            index(&path);
            return Ok((Applied::Noop, Some(path)));
        }
        let remote_kind = famd::note_sync_kind(&path, &plain);
        let mut result = Applied::Written;
        let both_present = |local: &LocalSnapshot| {
            local_changed
                && local.kind == NoteSyncKind::Present
                && remote_kind == NoteSyncKind::Present
        };
        let merged = match (&self.options.content_merge, local.as_ref()) {
            (Some(merge), Some(local)) if path != HOMEWORK_NOTE_PATH && both_present(local) => {
                merge(&path, &local.bytes, &plain)
            }
            (_, Some(local)) if path == HOMEWORK_NOTE_PATH && both_present(local) => {
                merge_homework_markdown_bytes(&local.bytes, &plain)
            }
            _ => None,
        };
        if let Some(merged) = merged {
            // Task-by-task merge; the base stays the remote revision, so the next push uploads the merge.
            self.host
                .write(&path, &merged, now_ms())
                .map_err(host_err)?;
            self.set_base(
                &path,
                LocalBase {
                    id: entry.id.clone(),
                    revision,
                    sha256: meta.sha256.clone(),
                    size: plain.len() as f64,
                    mtime_ms: 0.0,
                    content_sha256: (!plain_identity.is_empty()).then(|| plain_identity.clone()),
                    blank: false,
                },
            );
            index(&path);
            self.log(
                "info",
                format!("„{path}“ wurde Aufgabe für Aufgabe zusammengeführt."),
            );
            return Ok((Applied::Written, Some(path)));
        }
        if let Some(local) = local.as_ref().filter(|local| {
            local_changed
                || (remote_kind == NoteSyncKind::Blank && local.kind != NoteSyncKind::Blank)
        }) {
            let at = self.now();
            let copy_path = self.free_conflict_copy_path(&path, at);
            self.host
                .write(&copy_path, &local.bytes, at)
                .map_err(host_err)?;
            self.record_conflict(&path, &copy_path, at);
            self.log(
                "warn",
                format!(
                    "Konflikt bei „{path}“: die lokale Fassung liegt jetzt unter „{copy_path}“."
                ),
            );
            result = Applied::Conflict;
        }
        let body = match local.as_ref() {
            Some(local) if famd::is_famd_sync_path(&path) => {
                let downloaded = crate::jsjson::text_decode(&plain);
                famd::with_local_page_stats(&downloaded, &crate::jsjson::text_decode(&local.bytes))?
                    .into_bytes()
            }
            _ => plain,
        };
        let mtime = if meta.mtime_ms != 0.0 {
            meta.mtime_ms
        } else {
            now_ms()
        };
        let stat = self.host.write(&path, &body, mtime).map_err(host_err)?;
        let stored_kind = famd::note_sync_kind(&path, &body);
        let stored_identity = famd::identity_sync_bytes(&path, &body)
            .ok()
            .flatten()
            .map(|bytes| sha256_hex(&bytes));
        self.set_base(
            &path,
            LocalBase {
                id: entry.id.clone(),
                revision,
                sha256: meta.sha256.clone(),
                size: stat.size,
                mtime_ms: stat.mtime_ms,
                content_sha256: stored_identity,
                blank: stored_kind == NoteSyncKind::Blank,
            },
        );
        index(&path);
        Ok((result, Some(path)))
    }

    fn record_conflict(&self, path: &str, copy_path: &str, at: f64) {
        let conflict = SyncConflict {
            path: path.to_owned(),
            copy_path: copy_path.to_owned(),
            at: iso_from_millis(at),
        };
        self.with_state(|state| {
            state.conflicts.push(conflict.clone());
            let skip = state.conflicts.len().saturating_sub(50);
            state.conflicts.drain(..skip);
        });
        (self.options.on_conflict)(&conflict);
    }

    // ── Scan + push ─────────────────────────────────────────────────────────

    fn is_pending_delete(&self, path: &str) -> bool {
        self.with_state(|state| {
            state
                .pending_deletes
                .iter()
                .any(|prefix| path == prefix || path.starts_with(&format!("{prefix}/")))
        })
        .unwrap_or(false)
    }

    /// `push()`.
    fn push(&self) -> Result<Pushed, SyncError> {
        self.require()?;
        let options = self.path_options();
        let entries: Vec<ScanEntry> = self
            .host
            .scan()
            .map_err(host_err)?
            .into_iter()
            .filter(|entry| paths::is_syncable_path(&entry.path, &options))
            .collect();
        let present: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
        let present_set: HashSet<&str> = present.iter().map(String::as_str).collect();
        {
            let mut inner = self.lock();
            inner.scan_cache = Some(
                entries
                    .iter()
                    .map(|entry| (entry.path.clone(), entry.clone()))
                    .collect(),
            );
            inner.public.open_conflicts = conflicts::group_conflicts(&present, &[]).len();
        }
        let considered: HashSet<String> = self
            .with_state(|state| state.pending_deletes.iter().cloned().collect())
            .unwrap_or_default();
        let (changed, tracked): (Vec<ScanEntry>, Vec<String>) = {
            let inner = self.lock();
            let state = inner
                .state
                .as_ref()
                .ok_or_else(|| SyncError::Other("Sync ist nicht angemeldet.".to_owned()))?;
            let changed = entries
                .iter()
                .filter(|entry| entry.size <= MAX_FILE_BYTES)
                .filter(|entry| match state.files.get(&entry.path) {
                    None => true,
                    Some(base) => {
                        base.size != entry.size
                            || base.mtime_ms != entry.mtime_ms
                            || entry.mtime_ms == 0.0
                            || base.sha256.is_empty()
                    }
                })
                .cloned()
                .collect();
            (changed, state.files.keys().cloned().collect())
        };
        let missing: Vec<String> = tracked
            .into_iter()
            .filter(|path| {
                paths::is_syncable_path(path, &options)
                    && !present_set.contains(path.as_str())
                    && !self.busy(path)
            })
            .collect();
        let (deleted, vanished): (Vec<String>, Vec<String>) = missing
            .into_iter()
            .partition(|path| self.is_pending_delete(path));
        for path in &vanished {
            self.restore_vanished(path);
        }
        self.lock().public.pending_local = changed.len() + deleted.len();
        let counts = Mutex::new(Pushed::default());
        run_limited(&changed, CONCURRENCY, |entry| {
            let outcome = self.upload_path(entry)?;
            let mut counts = counts.lock().unwrap_or_else(|e| e.into_inner());
            match outcome {
                Upload::Uploaded => counts.uploads += 1,
                Upload::Conflict => counts.conflicts += 1,
                _ => {}
            }
            Ok(())
        })?;
        let mut counts = counts.into_inner().unwrap_or_else(|e| e.into_inner());
        for path in &deleted {
            match self.delete_path(path)? {
                "deleted" => counts.deletes += 1,
                "conflict" => counts.conflicts += 1,
                _ => {}
            }
        }
        self.settle_pending_deletes(&considered)?;
        self.lock().scan_cache = None;
        self.persist_state()?;
        Ok(counts)
    }

    /// `uploadPath(entry)`.
    fn upload_path(&self, entry: &ScanEntry) -> Result<Upload, SyncError> {
        let Ok((session, keys)) = self.require() else {
            return Ok(Upload::Skipped);
        };
        let Ok(raw) = self.host.read(&entry.path) else {
            return Ok(Upload::Skipped);
        };
        let kind = famd::note_sync_kind(&entry.path, &raw);
        let base_early = self.base_of(&entry.path);
        if kind == NoteSyncKind::Unreadable {
            self.log(
                "warn",
                format!(
                    "„{}“ konnte nicht gelesen werden und wird nicht hochgeladen.",
                    entry.path
                ),
            );
            if let Some(base) = base_early.filter(|base| !base.blank) {
                return self.restore_instead(entry, &base, &raw, false);
            }
            return Ok(Upload::Skipped);
        }
        let Some(identity_bytes) = famd::identity_sync_bytes(&entry.path, &raw)? else {
            if let Some(base) = base_early.filter(|base| !base.blank) {
                return self.restore_instead(entry, &base, &raw, false);
            }
            return Ok(Upload::Skipped);
        };
        let identity = sha256_hex(&identity_bytes);
        drop(identity_bytes);
        let canonical = famd::canonical_sync_bytes(&entry.path, &raw)?;
        let raw_sha256 = sha256_hex(&raw);
        let sha256 = match &canonical {
            std::borrow::Cow::Borrowed(_) => raw_sha256.clone(),
            std::borrow::Cow::Owned(owned) => sha256_hex(owned),
        };
        let base = self.base_of(&entry.path);
        if let Some(base) = base.as_ref().filter(|base| {
            base.content_sha256.as_deref() == Some(identity.as_str())
                || base.sha256 == sha256
                || base.sha256 == raw_sha256
        }) {
            self.set_base(
                &entry.path,
                LocalBase {
                    sha256: if base.sha256.is_empty() {
                        sha256.clone()
                    } else {
                        base.sha256.clone()
                    },
                    content_sha256: Some(identity.clone()),
                    size: entry.size,
                    mtime_ms: entry.mtime_ms,
                    blank: kind == NoteSyncKind::Blank,
                    ..base.clone()
                },
            );
            self.lock().cleared.remove(&entry.path);
            return Ok(Upload::Unchanged);
        }
        let clearing = self.lock().cleared.contains(&entry.path);
        let raw_len = raw.len() as f64;
        let severe_shrink = base.as_ref().is_some_and(|base| {
            !base.blank && base.size >= 4096.0 && (raw_len <= 1024.0 || raw_len * 4.0 < base.size)
        });
        let base_holds_content = base.as_ref().is_some_and(|base| {
            !base.blank
                && (base.size > raw_len + 64.0 || kind == NoteSyncKind::Blank || severe_shrink)
        });
        if (kind == NoteSyncKind::Blank || severe_shrink) && base_holds_content && !clearing {
            self.log(
                "warn",
                format!(
                    "„{}“ ist leer und wird nicht über die vorhandene Fassung hochgeladen.",
                    entry.path
                ),
            );
            return self.restore_instead(entry, base.as_ref().expect("checked"), &raw, false);
        }
        let id = match &base {
            Some(base) => base.id.clone(),
            None => crypto::file_id_for(&keys, &entry.path),
        };
        let meta = crypto::encrypt_meta(
            &keys,
            &id,
            &SyncFileMeta {
                path: entry.path.clone(),
                mtime_ms: entry.mtime_ms,
                size: canonical.len() as f64,
                sha256: sha256.clone(),
            },
        );
        let blob = crypto::encrypt_bytes(&keys, &id, &canonical);
        drop(canonical);
        let blob_sha = sha256_hex(&blob);
        let mut base_revision = base.as_ref().map_or(0, |base| base.revision);
        for attempt in 0..2 {
            match self.api.upload(
                &session,
                &id,
                base_revision,
                &meta,
                &blob_sha,
                &blob,
                kind == NoteSyncKind::Blank,
                clearing && kind == NoteSyncKind::Blank,
            ) {
                Ok(revision) => {
                    self.lock().cleared.remove(&entry.path);
                    self.set_base(
                        &entry.path,
                        LocalBase {
                            id,
                            revision,
                            sha256,
                            size: entry.size,
                            mtime_ms: entry.mtime_ms,
                            content_sha256: Some(identity),
                            blank: kind == NoteSyncKind::Blank,
                        },
                    );
                    return Ok(Upload::Uploaded);
                }
                Err(error) => {
                    let Some(api) = error.api().filter(|api| api.conflict()) else {
                        if error.api().is_some_and(|api| api.status == 507) {
                            self.log(
                                "error",
                                format!(
                                    "„{}“ passt nicht mehr in den Speicher des Kontos: {}",
                                    entry.path,
                                    error.message()
                                ),
                            );
                            return Ok(Upload::Skipped);
                        }
                        return Err(error);
                    };
                    let current = api.entry.clone().filter(|current| current.id == id);
                    if api.guarded()
                        || current.as_ref().is_some_and(|current| {
                            !current.deleted && current.revision == base_revision
                        })
                    {
                        if let Some(base) = &base {
                            let revision = current
                                .as_ref()
                                .map_or(base.revision, |current| current.revision);
                            return self.restore_instead(
                                entry,
                                &LocalBase {
                                    revision,
                                    ..base.clone()
                                },
                                &raw,
                                true,
                            );
                        }
                        return Ok(Upload::Skipped);
                    }
                    if let Some(current) = current.as_ref().filter(|current| current.deleted) {
                        if kind == NoteSyncKind::Blank {
                            self.set_base(
                                &entry.path,
                                LocalBase {
                                    id: id.clone(),
                                    revision: current.revision,
                                    sha256: sha256.clone(),
                                    size: entry.size,
                                    mtime_ms: entry.mtime_ms,
                                    content_sha256: Some(identity.clone()),
                                    blank: true,
                                },
                            );
                            return Ok(Upload::Skipped);
                        }
                        if attempt == 0 {
                            self.log("info", format!("„{}“ war im Sync gelöscht, liegt hier aber noch vor – die lokale Fassung wird wieder hochgeladen.", entry.path));
                            base_revision = current.revision;
                            continue;
                        }
                        return Ok(Upload::Conflict);
                    }
                    if let Some(current) = current {
                        let id_index = self.id_index();
                        match self.apply_remote(&current, &id_index) {
                            Ok((applied, Some(path)))
                                if matches!(applied, Applied::Written | Applied::Conflict) =>
                            {
                                (self.options.on_applied)(&[path], &[])
                            }
                            Ok(_) => {}
                            Err(apply_error) => {
                                if apply_error.cycle_wide() {
                                    return Err(apply_error);
                                }
                                self.log("warn", format!("„{}“ konnte nicht abgeglichen werden und wird später erneut versucht ({}).", entry.path, apply_error.message()));
                            }
                        }
                        return Ok(Upload::Conflict);
                    }
                    if kind == NoteSyncKind::Blank {
                        if let Some(base) = &base {
                            return self.restore_instead(entry, base, &raw, false);
                        }
                    }
                    return Ok(Upload::Conflict);
                }
            }
        }
        Ok(Upload::Conflict)
    }

    /// `restoreInstead(entry, base, localBytes, why)`.
    fn restore_instead(
        &self,
        entry: &ScanEntry,
        base: &LocalBase,
        local_bytes: &[u8],
        guard: bool,
    ) -> Result<Upload, SyncError> {
        let Ok((session, keys)) = self.require() else {
            return Ok(Upload::Skipped);
        };
        if self.busy(&entry.path) {
            return Ok(Upload::Skipped);
        }
        let (blob, blob_sha) = match self.api.download(&session, &base.id)? {
            Download::Deleted { .. } => return Ok(Upload::Conflict),
            Download::Blob { blob, sha256, .. } => (blob, sha256),
        };
        if sha256_hex(&blob) != blob_sha {
            return Ok(Upload::Skipped);
        }
        let plain = crypto::decrypt_bytes(&keys, &base.id, &blob)?;
        if famd::note_sync_kind(&entry.path, &plain) != NoteSyncKind::Present {
            let identity = famd::identity_sync_bytes(&entry.path, local_bytes)
                .ok()
                .flatten()
                .map(|bytes| sha256_hex(&bytes));
            self.set_base(
                &entry.path,
                LocalBase {
                    size: entry.size,
                    mtime_ms: entry.mtime_ms,
                    blank: true,
                    content_sha256: identity.or_else(|| base.content_sha256.clone()),
                    ..base.clone()
                },
            );
            return Ok(Upload::Skipped);
        }
        let at = self.now();
        let copy_path = self.free_conflict_copy_path(&entry.path, at);
        self.host
            .write(&copy_path, local_bytes, at)
            .map_err(host_err)?;
        let conflict = SyncConflict {
            path: entry.path.clone(),
            copy_path: copy_path.clone(),
            at: iso_from_millis(at),
        };
        self.with_state(|state| {
            state.conflicts.push(conflict.clone());
            let skip = state.conflicts.len().saturating_sub(50);
            state.conflicts.drain(..skip);
        });
        self.log(
            "warn",
            if guard {
                format!("Der Sync-Server hat die stark gekürzte Fassung von „{}“ nicht übernommen. Die lokale Kopie liegt unter „{copy_path}“.", entry.path)
            } else {
                format!("Leere Fassung von „{}“ wurde nicht hochgeladen. Die lokale Kopie liegt unter „{copy_path}“.", entry.path)
            },
        );
        (self.options.on_conflict)(&conflict);
        let stat = self.host.write(&entry.path, &plain, at).map_err(host_err)?;
        (self.options.on_applied)(&[entry.path.clone(), copy_path], &[]);
        let identity = famd::identity_sync_bytes(&entry.path, &plain)
            .ok()
            .flatten()
            .map(|bytes| sha256_hex(&bytes));
        self.set_base(
            &entry.path,
            LocalBase {
                sha256: if base.sha256.is_empty() {
                    sha256_hex(&plain)
                } else {
                    base.sha256.clone()
                },
                size: stat.size,
                mtime_ms: stat.mtime_ms,
                blank: false,
                content_sha256: identity.or_else(|| base.content_sha256.clone()),
                ..base.clone()
            },
        );
        Ok(Upload::Conflict)
    }

    /// `deletePath(path)`.
    fn delete_path(&self, path: &str) -> Result<&'static str, SyncError> {
        let Some(base) = self.base_of(path) else {
            return Ok("skipped");
        };
        let session = self
            .session()
            .ok_or_else(|| SyncError::Other("Nicht angemeldet.".to_owned()))?;
        match self.api.remove(&session, &base.id, base.revision) {
            Ok(_) => {
                self.with_state(|state| state.files.remove(path));
                Ok("deleted")
            }
            Err(error) => {
                if let Some(api) = error.api().filter(|api| api.conflict()) {
                    if let Some(current) = &api.entry {
                        let id_index = self.id_index();
                        self.apply_remote(current, &id_index)?;
                    }
                    return Ok("conflict");
                }
                Err(error)
            }
        }
    }

    /// `settlePendingDeletes(considered)`.
    fn settle_pending_deletes(&self, considered: &HashSet<String>) -> Result<(), SyncError> {
        let (pending, tracked) = match self.with_state(|state| {
            (
                state.pending_deletes.clone(),
                state.files.keys().cloned().collect::<Vec<_>>(),
            )
        }) {
            Some(values) => values,
            None => return Ok(()),
        };
        if pending.is_empty() || !pending.iter().any(|entry| considered.contains(entry)) {
            return Ok(());
        }
        let present_now: HashSet<String> = self
            .host
            .scan()
            .map_err(host_err)?
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        let kept: Vec<String> = pending
            .into_iter()
            .filter(|entry| {
                !considered.contains(entry)
                    || tracked.iter().any(|candidate| {
                        (candidate == entry || candidate.starts_with(&format!("{entry}/")))
                            && !present_now.contains(candidate)
                    })
            })
            .collect();
        self.with_state(|state| state.pending_deletes = kept);
        Ok(())
    }

    fn exists(&self, path: &str) -> bool {
        self.host.read(path).is_ok()
    }

    /// `freeConflictCopyPath(path, at)`.
    fn free_conflict_copy_path(&self, path: &str, at: f64) -> String {
        let first = paths::conflict_copy_path(path, &self.device_name(), at);
        for number in 1..1000u64 {
            let candidate = if number == 1 {
                first.clone()
            } else {
                conflicts::numbered_variant(&first, number)
            };
            if !self.exists(&candidate) {
                return candidate;
            }
        }
        conflicts::numbered_variant(&first, now_ms() as u64)
    }

    /// `restoreVanished(path)`: errors leave everything as it is.
    fn restore_vanished(&self, path: &str) {
        let Ok((session, keys)) = self.require() else {
            return;
        };
        let Some(base) = self.base_of(path) else {
            return;
        };
        let attempt = (|| -> Result<(), SyncError> {
            match self.api.download(&session, &base.id)? {
                Download::Deleted { .. } => {
                    self.with_state(|state| state.files.remove(path));
                }
                Download::Blob {
                    revision,
                    sha256,
                    blob,
                    ..
                } => {
                    if sha256_hex(&blob) != sha256 {
                        return Ok(());
                    }
                    let plain = crypto::decrypt_bytes(&keys, &base.id, &blob)?;
                    let stat = self.host.write(path, &plain, now_ms()).map_err(host_err)?;
                    let identity = famd::identity_sync_bytes(path, &plain)
                        .ok()
                        .flatten()
                        .map(|bytes| sha256_hex(&bytes));
                    self.set_base(
                        path,
                        LocalBase {
                            revision,
                            sha256: sha256_hex(&plain),
                            size: stat.size,
                            mtime_ms: stat.mtime_ms,
                            content_sha256: identity.or_else(|| base.content_sha256.clone()),
                            ..base.clone()
                        },
                    );
                }
            }
            Ok(())
        })();
        let _ = attempt;
    }

    /// `listConflicts()`.
    pub fn list_conflicts(&self) -> Result<Vec<ConflictGroup>, SyncError> {
        let scanned: Vec<String> = self
            .host
            .scan()
            .map_err(host_err)?
            .into_iter()
            .map(|entry| entry.path)
            .filter(|path| self.accepts(path))
            .collect();
        let recorded: Vec<(String, String)> = self
            .with_state(|state| {
                state
                    .conflicts
                    .iter()
                    .map(|c| (c.copy_path.clone(), c.at.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let groups = conflicts::group_conflicts(&scanned, &recorded);
        let present: HashSet<&String> = scanned.iter().collect();
        let changed = self
            .with_state(|state| {
                let before = state.conflicts.len();
                state
                    .conflicts
                    .retain(|conflict| present.contains(&conflict.copy_path));
                before != state.conflicts.len()
            })
            .unwrap_or(false);
        if changed {
            self.persist_state()?;
        }
        self.lock().public.open_conflicts = groups.len();
        Ok(groups)
    }
}
