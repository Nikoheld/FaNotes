//! API keys and the sync login live in the OS credential store.
//!
//! A missing session bus must fail quickly. Headless runs keep the secrets
//! out of the profile files instead of falling back to plaintext.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

pub const KEYRING_UNAVAILABLE: &str = "Die Sync-Anmeldung ist mit dem Schlüsselbund dieses Systems geschützt, der gerade nicht verfügbar ist.";
pub const KEYRING_REQUIRED: &str =
    "Sync-Anmeldedaten können ohne verfügbaren Systemschlüsselbund nicht gespeichert werden.";

const SERVICE: &str = "de.fanotes.app";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretStore {
    /// The OS credential store (Secret Service, Keychain, or Credential Manager).
    Keyring,
    /// Process memory. Tests use this so they do not need a session bus.
    Memory,
    /// Always refuses writes. Tests use this for the headless path.
    Unavailable,
}

pub fn account(app_data: &Path, name: &str) -> String {
    // The same profile keeps one keyring account when its path is spelled
    // with `..` or a trailing slash. Desktop `path.resolve` drops both.
    let absolute = crate::node_resolve(app_data);
    let digest = Sha256::digest(absolute.to_string_lossy().as_bytes());
    let mut hex = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("{hex}:{name}")
}

pub fn get(store: SecretStore, account: &str) -> Result<Option<String>, String> {
    match store {
        SecretStore::Memory => Ok(memory()
            .lock()
            .map_err(|_| KEYRING_UNAVAILABLE.to_owned())?
            .get(account)
            .cloned()),
        SecretStore::Unavailable => Ok(None),
        SecretStore::Keyring => keyring_get(account),
    }
}

pub fn set(store: SecretStore, account: &str, secret: &str) -> Result<(), String> {
    match store {
        SecretStore::Memory => {
            memory()
                .lock()
                .map_err(|_| KEYRING_REQUIRED.to_owned())?
                .insert(account.to_owned(), secret.to_owned());
            Ok(())
        }
        SecretStore::Unavailable => Err(KEYRING_REQUIRED.to_owned()),
        SecretStore::Keyring => keyring_set(account, secret),
    }
}

pub fn forget_profile(app_data: &Path, names: &[&str]) {
    for name in names {
        let account = account(app_data, name);
        let _ = delete(SecretStore::Memory, &account);
        let _ = delete(SecretStore::Keyring, &account);
    }
}

pub fn delete(store: SecretStore, account: &str) -> Result<(), String> {
    match store {
        SecretStore::Memory => {
            memory()
                .lock()
                .map_err(|_| KEYRING_UNAVAILABLE.to_owned())?
                .remove(account);
            Ok(())
        }
        SecretStore::Unavailable => Ok(()),
        SecretStore::Keyring => keyring_delete(account),
    }
}

fn memory() -> &'static Mutex<BTreeMap<String, String>> {
    use std::sync::OnceLock;
    static MEMORY: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn keyring_get(account: &str) -> Result<Option<String>, String> {
    if !session_bus_configured() {
        return Err(KEYRING_UNAVAILABLE.to_owned());
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|_| KEYRING_UNAVAILABLE.to_owned())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(KEYRING_UNAVAILABLE.to_owned()),
    }
}

fn keyring_set(account: &str, secret: &str) -> Result<(), String> {
    if !session_bus_configured() {
        return Err(KEYRING_REQUIRED.to_owned());
    }
    let entry = keyring::Entry::new(SERVICE, account).map_err(|_| KEYRING_REQUIRED.to_owned())?;
    entry
        .set_password(secret)
        .map_err(|_| KEYRING_REQUIRED.to_owned())
}

fn keyring_delete(account: &str) -> Result<(), String> {
    if !session_bus_configured() {
        return Err(KEYRING_UNAVAILABLE.to_owned());
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|_| KEYRING_UNAVAILABLE.to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(KEYRING_UNAVAILABLE.to_owned()),
    }
}

fn session_bus_configured() -> bool {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(address) = std::env::var("DBUS_SESSION_BUS_ADDRESS") {
            return !address.is_empty() && address != "disabled";
        }
        if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
            if Path::new(&runtime).join("bus").exists() {
                return true;
            }
        }
        if let Some(uid) = linux_uid() {
            return Path::new(&format!("/run/user/{uid}/bus")).exists();
        }
        false
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        true
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_uid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        let Some(rest) = line.strip_prefix("Uid:") else {
            continue;
        };
        return rest.split_whitespace().next()?.parse().ok();
    }
    None
}
