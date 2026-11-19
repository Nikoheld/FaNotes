//! One error type for the whole crate.
//!
//! `message` carries the exact German text the Electron updater shows, so the
//! shared fixtures can assert on the same substrings in both implementations.
//! `kind` is the machine-readable class that callers and tests branch on.

use std::fmt;

use crate::diagnosis::Diagnosis;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Malformed or inconsistent manifest or release list.
    Manifest,
    /// Signature, key id or key problem.
    Signature,
    /// URL or host outside the allow-list.
    Untrusted,
    /// A size is out of range, or a transfer is larger/smaller than announced.
    Size,
    /// SHA-256 mismatch.
    Hash,
    /// Rollback or downgrade blocked.
    Rollback,
    /// Delta header, plan or reconstruction problem.
    Delta,
    /// Release-policy (calendar version) violation.
    Policy,
    /// Local file-system problem.
    Io,
    /// Transport problem (connection, HTTP status, captive portal, ...).
    Network,
    /// The caller cancelled, or the deadline passed.
    Cancelled,
    /// Platform not supported by the updater.
    Unsupported,
}

#[derive(Debug, Clone)]
pub struct UpdateError {
    pub kind: ErrorKind,
    pub message: String,
    /// Node-style error code (`ECONNRESET`, `ETIMEDOUT`, ...), when known.
    pub code: Option<String>,
    pub diagnosis: Option<Box<Diagnosis>>,
}

pub type Result<T> = std::result::Result<T, UpdateError>;

impl UpdateError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            code: None,
            diagnosis: None,
        }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_diagnosis(mut self, diagnosis: Diagnosis) -> Self {
        self.diagnosis = Some(Box::new(diagnosis));
        self
    }

    /// Map a `std::io::Error` to the Node error code the JS retry logic keys on.
    pub fn from_io(error: &std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        let code = match error.kind() {
            K::ConnectionReset => Some("ECONNRESET"),
            K::BrokenPipe => Some("EPIPE"),
            K::TimedOut | K::WouldBlock => Some("ETIMEDOUT"),
            K::ConnectionAborted => Some("ECONNABORTED"),
            K::ConnectionRefused => Some("ECONNREFUSED"),
            K::UnexpectedEof => Some("ERR_STREAM_PREMATURE_CLOSE"),
            _ => None,
        };
        let kind = if code.is_some() {
            ErrorKind::Network
        } else {
            ErrorKind::Io
        };
        let mut out = Self::new(kind, error.to_string());
        out.code = code.map(str::to_owned);
        out
    }

    pub fn cancelled(message: &str) -> Self {
        Self::new(ErrorKind::Cancelled, message).with_code("AbortError")
    }

    pub fn is_abort(&self) -> bool {
        self.kind == ErrorKind::Cancelled || self.code.as_deref() == Some("AbortError")
    }
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UpdateError {}

impl From<std::io::Error> for UpdateError {
    fn from(error: std::io::Error) -> Self {
        Self::from_io(&error)
    }
}

/// Shorthand used throughout: `bail(kind, "text")`.
pub(crate) fn err<T>(kind: ErrorKind, message: impl Into<String>) -> Result<T> {
    Err(UpdateError::new(kind, message))
}
