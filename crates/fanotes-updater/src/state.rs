//! Rollback protection and the persisted updater state (`updates/state.json`).
//!
//! The highest version ever offered per channel is remembered. A later
//! manifest naming an older version is refused ("rollback"), even when it is
//! still newer than the installed build.

use std::path::Path;

use serde_json::{json, Value};

use crate::date::now_iso;
use crate::error::{err, ErrorKind, Result};
use crate::platform::{MAX_PACKAGE_BYTES, MIN_PACKAGE_BYTES};
use crate::version::{compare_versions, is_valid_version, Channel};

pub const MAX_STATE_BYTES: usize = 64 * 1024;
pub const STATE_SCHEMA_VERSION: u32 = 3;
pub const ROLLBACK_MESSAGE: &str =
    "Der Update-Server bietet eine ältere als die bereits bekannte Version an. Das Update wurde zum Schutz vor einem Rollback blockiert.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInstall {
    pub channel: Channel,
    pub version: String,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub used_delta: bool,
    pub prepared_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdaterState {
    pub highest_stable: Option<String>,
    pub highest_beta: Option<String>,
    pub highest_nightly: Option<String>,
    pub pending_install: Option<PendingInstall>,
}

impl UpdaterState {
    pub fn highest(&self, channel: Channel) -> Option<&str> {
        match channel {
            Channel::Stable => self.highest_stable.as_deref(),
            Channel::Beta => self.highest_beta.as_deref(),
            Channel::Nightly => self.highest_nightly.as_deref(),
        }
    }

    fn highest_mut(&mut self, channel: Channel) -> &mut Option<String> {
        match channel {
            Channel::Stable => &mut self.highest_stable,
            Channel::Beta => &mut self.highest_beta,
            Channel::Nightly => &mut self.highest_nightly,
        }
    }

    /// Refuse a manifest older than the highest version seen on this channel.
    /// Equal is allowed.
    pub fn check_rollback(&self, channel: Channel, latest_version: &str) -> Result<()> {
        if let Some(highest) = self.highest(channel) {
            if compare_versions(latest_version, highest)?.is_lt() {
                return err(ErrorKind::Rollback, ROLLBACK_MESSAGE);
            }
        }
        Ok(())
    }

    /// `rememberHighestVersion`. Returns true when the state changed and must be saved.
    pub fn remember_highest(&mut self, channel: Channel, version: &str) -> Result<bool> {
        if let Some(previous) = self.highest(channel) {
            if compare_versions(version, previous)?.is_le() {
                return Ok(false);
            }
        }
        *self.highest_mut(channel) = Some(version.to_owned());
        Ok(true)
    }

    /// `loadPersistentState` parsing. Oversized or unreadable input yields an empty state;
    /// invalid fields are ignored one by one, never trusted.
    pub fn parse(raw: &str) -> UpdaterState {
        let mut state = UpdaterState::default();
        if raw.len() > MAX_STATE_BYTES {
            return state;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
            return state;
        };
        let valid = |value: Option<&Value>| {
            value
                .and_then(Value::as_str)
                .filter(|v| is_valid_version(v))
                .map(str::to_owned)
        };
        for channel in Channel::ALL {
            *state.highest_mut(channel) =
                valid(parsed.pointer(&format!("/highestSeenVersions/{}", channel.as_str())));
        }
        // Migrate the single-channel state written by FaNotes 2.x.
        if state.highest_stable.is_none() {
            state.highest_stable = valid(parsed.get("highestSeenVersion"));
        }
        if let Some(pending) = parsed.get("pendingInstall").and_then(Value::as_object) {
            let text = |key: &str| pending.get(key).and_then(Value::as_str);
            let size = crate::util::safe_integer(pending.get("sizeBytes"));
            let file_name = text("fileName").filter(|n| {
                !n.is_empty()
                    && crate::util::utf16_len(n) < 240
                    && !n.contains('/')
                    && !n.contains('\\')
            });
            let sha = text("sha256").filter(|h| {
                h.len() == 64
                    && h.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            });
            let version = text("version").filter(|v| is_valid_version(v));
            let channel = text("channel").and_then(Channel::parse);
            if let (Some(version), Some(channel), Some(file_name), Some(sha), Some(size)) =
                (version, channel, file_name, sha, size)
            {
                if (MIN_PACKAGE_BYTES..=MAX_PACKAGE_BYTES).contains(&size) {
                    state.pending_install = Some(PendingInstall {
                        channel,
                        version: version.to_owned(),
                        file_name: file_name.to_owned(),
                        sha256: sha.to_owned(),
                        size_bytes: size,
                        // JS `Boolean(x)`: only `true` is meaningful in a file we wrote ourselves.
                        used_delta: pending.get("usedDelta").is_some_and(truthy),
                        prepared_at: text("preparedAt").map(str::to_owned),
                    });
                }
            }
        }
        state
    }

    pub fn to_json(&self, updated_at: &str) -> Value {
        json!({
            "schemaVersion": STATE_SCHEMA_VERSION,
            "highestSeenVersions": {
                "stable": self.highest_stable,
                "beta": self.highest_beta,
                "nightly": self.highest_nightly,
            },
            "pendingInstall": self.pending_install.as_ref().map(|p| json!({
                "channel": p.channel.as_str(),
                "version": p.version,
                "fileName": p.file_name,
                "sha256": p.sha256,
                "sizeBytes": p.size_bytes,
                "usedDelta": p.used_delta,
                "preparedAt": p.prepared_at,
            })),
            "updatedAt": updated_at,
        })
    }

    /// Load from `path`; a missing or unreadable file gives an empty state.
    pub fn load(path: &Path) -> UpdaterState {
        std::fs::read_to_string(path)
            .map(|raw| Self::parse(&raw))
            .unwrap_or_default()
    }

    /// `atomicJsonWrite`: temp file with mode 0600 in the same directory, then rename.
    pub fn save(&self, path: &Path) -> Result<()> {
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&self.to_json(&now_iso())).unwrap_or_default()
        );
        atomic_write(path, text.as_bytes())
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if let Some(parent) = target.parent() {
        make_private_dir(parent)?;
    }
    let unique = format!(
        "{}.{:x}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    );
    let temporary = target.with_file_name(format!(
        "{}.{unique}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("state")
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    drop(file);
    std::fs::rename(&temporary, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })?;
    Ok(())
}

/// `mkdir -p` with mode 0700 for directories this call creates.
pub(crate) fn make_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}
