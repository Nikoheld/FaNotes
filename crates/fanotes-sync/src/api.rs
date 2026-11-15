//! `fanotes/src/lib/sync/api.ts`: the HTTP client for `/api/v1/sync`.

use std::time::Duration;

use serde_json::{json, Value};

use crate::crypto::{SyncKdf, SyncKeyWrap};

pub const SYNC_ORIGIN: &str = "https://fanotes.fasrv.ch";
pub const SYNC_API_PATH: &str = "/api/v1/sync";
const RETRY_DELAY: Duration = Duration::from_millis(400);
const MAX_RESPONSE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub account_id: String,
    pub device_id: String,
    pub token: String,
    pub expires_at: String,
    pub email: String,
}

/// One entry of the change feed (`publicEntry` on the server).
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteEntry {
    pub id: String,
    pub revision: i64,
    pub deleted: bool,
    pub size: f64,
    pub sha256: Option<String>,
    pub meta: Option<String>,
    pub updated_at: Option<String>,
    pub device_id: Option<String>,
}

fn opt_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

impl RemoteEntry {
    pub fn from_json(value: &Value) -> Option<RemoteEntry> {
        let object = value.as_object()?;
        Some(RemoteEntry {
            id: object.get("id")?.as_str()?.to_owned(),
            revision: object
                .get("revision")
                .and_then(Value::as_f64)
                .map(|revision| revision as i64)?,
            deleted: object.get("deleted").is_some_and(|value| match value {
                Value::Bool(flag) => *flag,
                Value::Null => false,
                Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
                Value::String(text) => !text.is_empty(),
                _ => true,
            }),
            size: object.get("size").and_then(Value::as_f64).unwrap_or(0.0),
            sha256: opt_string(object.get("sha256")),
            meta: opt_string(object.get("meta")),
            updated_at: opt_string(object.get("updatedAt")),
            device_id: opt_string(object.get("deviceId")),
        })
    }

    /// The object `rememberSkip` stores.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "revision": self.revision,
            "deleted": self.deleted,
            "size": self.size,
            "sha256": self.sha256,
            "meta": self.meta,
            "updatedAt": self.updated_at,
            "deviceId": self.device_id,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    Stale,
    Guard,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncApiError {
    pub status: u16,
    pub message: String,
    pub entry: Option<RemoteEntry>,
    pub reason: Option<RejectReason>,
}

impl SyncApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            entry: None,
            reason: None,
        }
    }
    pub fn unauthorized(&self) -> bool {
        self.status == 401
    }
    pub fn conflict(&self) -> bool {
        self.status == 409
    }
    pub fn offline(&self) -> bool {
        self.status == 0
    }
    pub fn guarded(&self) -> bool {
        self.status == 409 && self.reason == Some(RejectReason::Guard)
    }
}

/// Any failure the engine handles: a server or transport answer, or anything else (decrypt, host, JSON).
#[derive(Clone, Debug, PartialEq)]
pub enum SyncError {
    Api(SyncApiError),
    Other(String),
}

impl SyncError {
    pub fn message(&self) -> &str {
        match self {
            SyncError::Api(error) => &error.message,
            SyncError::Other(message) => message,
        }
    }
    pub fn api(&self) -> Option<&SyncApiError> {
        match self {
            SyncError::Api(error) => Some(error),
            SyncError::Other(_) => None,
        }
    }
    /// `cycleWide(error)`: sign-in, offline, 429 and 5xx end the cycle.
    pub fn cycle_wide(&self) -> bool {
        self.api().is_some_and(|error| {
            error.unauthorized() || error.offline() || error.status == 429 || error.status >= 500
        })
    }
}

impl From<SyncApiError> for SyncError {
    fn from(error: SyncApiError) -> Self {
        SyncError::Api(error)
    }
}

impl From<String> for SyncError {
    fn from(message: String) -> Self {
        SyncError::Other(message)
    }
}

impl From<crate::crypto::CryptoError> for SyncError {
    fn from(error: crate::crypto::CryptoError) -> Self {
        SyncError::Other(error.0)
    }
}

impl From<crate::famd_v2::FamdError> for SyncError {
    fn from(error: crate::famd_v2::FamdError) -> Self {
        SyncError::Other(error.0)
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

pub struct ChangesPage {
    pub revision: i64,
    pub entries: Vec<RemoteEntry>,
    pub more: bool,
    pub next_since: i64,
}

pub enum Download {
    Deleted {
        revision: i64,
    },
    Blob {
        revision: i64,
        meta: String,
        sha256: String,
        blob: Vec<u8>,
    },
}

/// What a test transport does to one request attempt.
pub enum Fault {
    /// The request never reaches the server (status 0).
    Offline,
    /// The server is not asked; this status and message come back.
    Status(u16, String),
}

/// What happens to a response after the server answered.
pub enum AfterResponse {
    Keep,
    /// The answer is lost on the way back (status 0); the server already acted.
    Drop,
    /// The last body byte is flipped.
    Corrupt,
}

/// Observes every request attempt (the parity harness records them and injects faults).
pub trait Transport: Send + Sync {
    fn before(&self, _method: &str, _path: &str) -> Option<Fault> {
        None
    }
    fn after(&self, _method: &str, _path: &str, _status: u16) -> AfterResponse {
        AfterResponse::Keep
    }
}

struct NoTransport;
impl Transport for NoTransport {}

pub struct SyncApi {
    origin: String,
    agent: ureq::Agent,
    accept_language: Option<String>,
    transport: std::sync::Arc<dyn Transport>,
}

struct Raw {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Raw {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn parse_error(raw: &Raw) -> SyncApiError {
    let mut message = format!("Der Sync-Server antwortete mit {}.", raw.status);
    let mut entry = None;
    let mut reason =
        (raw.header("X-FaNotes-Rejected") == Some("guard")).then_some(RejectReason::Guard);
    if let Ok(body) = serde_json::from_slice::<Value>(&raw.body) {
        if let Some(error) = body.get("error").and_then(Value::as_str) {
            message = error.to_owned();
        }
        if let Some(value) = body.get("entry").filter(|value| value.is_object()) {
            entry = RemoteEntry::from_json(value);
        }
        match body.get("reason").and_then(Value::as_str) {
            Some("guard") => reason = Some(RejectReason::Guard),
            Some("stale") => reason = Some(RejectReason::Stale),
            _ => {}
        }
    }
    SyncApiError {
        status: raw.status,
        message,
        entry,
        reason,
    }
}

impl SyncApi {
    pub fn new(origin: impl Into<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(300)))
            .timeout_recv_body(Some(Duration::from_secs(600)))
            .build()
            .into();
        Self {
            origin: origin.into().trim_end_matches('/').to_owned(),
            agent,
            accept_language: None,
            transport: std::sync::Arc::new(NoTransport),
        }
    }

    pub fn with_accept_language(mut self, language: Option<String>) -> Self {
        self.accept_language = language;
        self
    }

    pub fn with_transport(mut self, transport: std::sync::Arc<dyn Transport>) -> Self {
        self.transport = transport;
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{SYNC_API_PATH}{path}", self.origin)
    }

    fn send_once(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: Option<&[u8]>,
    ) -> Result<Raw, ()> {
        let mut builder = ureq::http::Request::builder()
            .method(method)
            .uri(self.url(path));
        for (name, value) in headers {
            builder = builder.header(*name, value);
        }
        if let Some(language) = &self.accept_language {
            builder = builder.header("Accept-Language", language);
        }
        let result = match body {
            Some(bytes) => builder
                .body(bytes)
                .map_err(|_| ())
                .and_then(|request| self.agent.run(request).map_err(|_| ())),
            None => builder
                .body(())
                .map_err(|_| ())
                .and_then(|request| self.agent.run(request).map_err(|_| ())),
        };
        let mut response = result?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_vec()
            .map_err(|_| ())?;
        Ok(Raw {
            status,
            headers,
            body,
        })
    }

    /// `request()`: one retry for side-effect-free requests that failed before any response.
    #[allow(clippy::too_many_arguments)]
    fn request(
        &self,
        method: &str,
        path: &str,
        session: Option<&Session>,
        headers: Vec<(&str, String)>,
        body: Option<&[u8]>,
        retry: Option<bool>,
        _file_id: Option<&str>,
    ) -> Result<Raw, SyncError> {
        let mut all = headers;
        if let Some(session) = session {
            all.push(("Authorization", format!("Bearer {}", session.token)));
            all.push(("X-FaNotes-Account", session.account_id.clone()));
        }
        let retryable = retry.unwrap_or(method == "GET");
        let mut attempt = 0;
        loop {
            let outcome = match self.transport.before(method, path) {
                Some(Fault::Offline) => Err(()),
                Some(Fault::Status(status, message)) => Ok(Raw {
                    status,
                    headers: Vec::new(),
                    body: serde_json::to_vec(&json!({ "error": message })).unwrap_or_default(),
                }),
                None => self
                    .send_once(method, path, &all, body)
                    .and_then(
                        |mut raw| match self.transport.after(method, path, raw.status) {
                            AfterResponse::Keep => Ok(raw),
                            AfterResponse::Drop => Err(()),
                            AfterResponse::Corrupt => {
                                if let Some(last) = raw.body.last_mut() {
                                    *last ^= 0xff;
                                }
                                Ok(raw)
                            }
                        },
                    ),
            };
            match outcome {
                Ok(raw) => {
                    if !(200..300).contains(&raw.status) {
                        return Err(SyncError::Api(parse_error(&raw)));
                    }
                    return Ok(raw);
                }
                Err(()) => {
                    if retryable && attempt == 0 {
                        attempt += 1;
                        std::thread::sleep(RETRY_DELAY);
                        continue;
                    }
                    return Err(SyncError::Api(SyncApiError::new(
                        0,
                        "Der Sync-Server ist nicht erreichbar.",
                    )));
                }
            }
        }
    }

    fn json(
        &self,
        method: &str,
        path: &str,
        session: Option<&Session>,
        body: Option<Value>,
        retry: Option<bool>,
    ) -> Result<Value, SyncError> {
        let encoded = body.map(|body| serde_json::to_vec(&body).expect("json"));
        let headers = if encoded.is_some() {
            vec![("Content-Type", "application/json".to_owned())]
        } else {
            Vec::new()
        };
        let raw = self.request(
            method,
            path,
            session,
            headers,
            encoded.as_deref(),
            retry,
            None,
        )?;
        if raw.status == 204 {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&raw.body)
            .map_err(|error| SyncError::Other(format!("Unexpected token in JSON ({error})")))
    }

    pub fn prelogin(&self, email: &str) -> Result<Value, SyncError> {
        let body = self.json(
            "POST",
            "/prelogin",
            None,
            Some(json!({ "email": email })),
            Some(true),
        )?;
        Ok(body.get("kdf").cloned().unwrap_or(Value::Null))
    }

    pub fn register(
        &self,
        email: &str,
        auth_key: &str,
        kdf: &SyncKdf,
        wrap: &SyncKeyWrap,
        device: (&str, &str),
    ) -> Result<Value, SyncError> {
        self.json(
            "POST",
            "/register",
            None,
            Some(json!({ "email": email, "authKey": auth_key, "kdf": kdf, "vaultKeyWrap": wrap, "device": { "name": device.0, "platform": device.1 } })),
            None,
        )
    }

    pub fn login(
        &self,
        email: &str,
        auth_key: &str,
        device: (&str, &str),
    ) -> Result<Value, SyncError> {
        self.json("POST", "/login", None, Some(json!({ "email": email, "authKey": auth_key, "device": { "name": device.0, "platform": device.1 } })), None)
    }

    pub fn account(&self, session: &Session) -> Result<Value, SyncError> {
        self.json("GET", "/account", Some(session), None, None)
    }

    pub fn logout(&self, session: &Session) -> Result<(), SyncError> {
        self.json("POST", "/logout", Some(session), None, None)
            .map(|_| ())
    }

    pub fn remove_device(&self, session: &Session, device_id: &str) -> Result<(), SyncError> {
        let encoded: String = device_id
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        self.json(
            "DELETE",
            &format!("/devices/{encoded}"),
            Some(session),
            None,
            None,
        )
        .map(|_| ())
    }

    pub fn change_password(
        &self,
        session: &Session,
        auth_key: &str,
        new_auth_key: &str,
        kdf: &SyncKdf,
        wrap: &SyncKeyWrap,
    ) -> Result<(), SyncError> {
        self.json("POST", "/password", Some(session), Some(json!({ "authKey": auth_key, "newAuthKey": new_auth_key, "kdf": kdf, "vaultKeyWrap": wrap })), None).map(|_| ())
    }

    pub fn delete_account(&self, session: &Session, auth_key: &str) -> Result<(), SyncError> {
        self.json(
            "DELETE",
            "/account",
            Some(session),
            Some(json!({ "authKey": auth_key })),
            None,
        )
        .map(|_| ())
    }

    pub fn changes(&self, session: &Session, since: i64) -> Result<ChangesPage, SyncError> {
        let body = self.json(
            "GET",
            &format!("/changes?since={since}"),
            Some(session),
            None,
            None,
        )?;
        let entries = body
            .get("entries")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(RemoteEntry::from_json).collect())
            .unwrap_or_default();
        Ok(ChangesPage {
            revision: body.get("revision").and_then(Value::as_f64).unwrap_or(0.0) as i64,
            entries,
            more: body.get("more").and_then(Value::as_bool).unwrap_or(false),
            next_since: body
                .get("nextSince")
                .and_then(Value::as_f64)
                .unwrap_or(since as f64) as i64,
        })
    }

    pub fn download(&self, session: &Session, file_id: &str) -> Result<Download, SyncError> {
        let raw = self.request(
            "GET",
            &format!("/files/{file_id}"),
            Some(session),
            Vec::new(),
            None,
            None,
            Some(file_id),
        )?;
        let revision = raw
            .header("X-FaNotes-Revision")
            .and_then(fanotes_famd::js_tonumber)
            .unwrap_or(f64::NAN);
        let revision = if revision.is_finite() {
            revision as i64
        } else {
            0
        };
        if raw.status == 204 || raw.header("X-FaNotes-Deleted") == Some("1") {
            return Ok(Download::Deleted { revision });
        }
        Ok(Download::Blob {
            revision,
            meta: raw.header("X-FaNotes-Meta").unwrap_or("").to_owned(),
            sha256: raw.header("X-FaNotes-Sha256").unwrap_or("").to_owned(),
            blob: raw.body,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upload(
        &self,
        session: &Session,
        file_id: &str,
        base_revision: i64,
        meta: &str,
        sha256: &str,
        blob: &[u8],
        blank: bool,
        clear: bool,
    ) -> Result<i64, SyncError> {
        let mut headers = vec![
            ("Content-Type", "application/octet-stream".to_owned()),
            ("If-Match", base_revision.to_string()),
            ("X-FaNotes-Meta", meta.to_owned()),
            ("X-FaNotes-Sha256", sha256.to_owned()),
            ("X-FaNotes-Blank", if blank { "1" } else { "0" }.to_owned()),
        ];
        if clear {
            headers.push(("X-FaNotes-Clear", "1".to_owned()));
        }
        let raw = self.request(
            "PUT",
            &format!("/files/{file_id}"),
            Some(session),
            headers,
            Some(blob),
            None,
            Some(file_id),
        )?;
        let body: Value = serde_json::from_slice(&raw.body)
            .map_err(|error| SyncError::Other(format!("Unexpected token in JSON ({error})")))?;
        Ok(body.get("revision").and_then(Value::as_f64).unwrap_or(0.0) as i64)
    }

    pub fn remove(
        &self,
        session: &Session,
        file_id: &str,
        base_revision: i64,
    ) -> Result<i64, SyncError> {
        let headers = vec![
            ("If-Match", base_revision.to_string()),
            ("X-FaNotes-Delete", "1".to_owned()),
        ];
        let raw = self.request(
            "DELETE",
            &format!("/files/{file_id}"),
            Some(session),
            headers,
            None,
            None,
            Some(file_id),
        )?;
        let body: Value = serde_json::from_slice(&raw.body).unwrap_or(Value::Null);
        Ok(body.get("revision").and_then(Value::as_f64).unwrap_or(0.0) as i64)
    }
}
