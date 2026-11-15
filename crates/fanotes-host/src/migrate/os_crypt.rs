//! Electron `safeStorage` (Chromium `OSCrypt`, sync API, Electron 43 / Chromium 150).
//!
//! Linux (`components/os_crypt/sync/os_crypt_linux.cc`):
//! - `v10`: AES-128-CBC, IV = 16 spaces, key = PBKDF2-HMAC-SHA1("peanuts", "saltysalt", 1 iteration, 16 bytes).
//! - `v11`: same, password = the string Electron stored in the Secret Service
//!   (schema `chrome_libsecret_os_crypt_password_v2`, attribute `application` = app name,
//!   here "FaNotes") or in KWallet.
//! - Both retry with the key of the empty password (crbug.com/1195256).
//! - No prefix: old clear text.
//!
//! Windows (`os_crypt_win.cc`): `Local State` → `os_crypt.encrypted_key` = base64("DPAPI" + DPAPI blob)
//! of a 32-byte key; `v10` + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
//! No prefix: a raw DPAPI blob.
//!
//! Plaintext never leaves this module except as the return value. Nothing here logs.

use aes::cipher::{BlockCipherDecrypt, BlockCipherEncrypt, KeyInit};
use aes::{Aes128, Aes256};
use sha1::{Digest, Sha1};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Linux,
    Windows,
}

impl Scheme {
    pub fn native() -> Self {
        if cfg!(windows) {
            Scheme::Windows
        } else {
            Scheme::Linux
        }
    }
}

/// Why a value could not be opened. Carries no secret material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The OS keyring item or the `Local State` key is not available on this machine.
    KeyUnavailable(String),
    /// A key was found but does not open this value (wrong key or damaged value).
    CannotDecrypt,
}

impl Failure {
    pub fn code(&self) -> &'static str {
        match self {
            Failure::KeyUnavailable(_) => "keyring-unavailable",
            Failure::CannotDecrypt => "cannot-decrypt",
        }
    }
}

pub type Lookup = Box<dyn Fn() -> Result<Vec<Vec<u8>>, String>>;
pub type Unprotect = Box<dyn Fn(&[u8]) -> Result<Vec<u8>, String>>;

pub struct Decryptor {
    scheme: Scheme,
    /// Linux v11 password candidates, looked up once and only when needed.
    v11_lookup: Lookup,
    v11_passwords: std::cell::OnceCell<Result<Vec<Vec<u8>>, String>>,
    /// Windows: `Local State` `os_crypt.encrypted_key`, still DPAPI protected.
    windows_encrypted_key: Option<Vec<u8>>,
    windows_key: std::cell::OnceCell<Result<[u8; 32], String>>,
    unprotect: Unprotect,
}

impl Decryptor {
    pub fn new(
        scheme: Scheme,
        local_state: Option<&serde_json::Value>,
        v11_lookup: Lookup,
        unprotect: Unprotect,
    ) -> Self {
        let windows_encrypted_key = local_state
            .and_then(|state| state.get("os_crypt"))
            .and_then(|os_crypt| os_crypt.get("encrypted_key"))
            .and_then(serde_json::Value::as_str)
            .and_then(|text| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(text).ok()
            });
        Self {
            scheme,
            v11_lookup,
            v11_passwords: std::cell::OnceCell::new(),
            windows_encrypted_key,
            windows_key: std::cell::OnceCell::new(),
            unprotect,
        }
    }

    /// The decryptor for this machine: Secret Service / KWallet on Linux, DPAPI on Windows.
    pub fn native(local_state: Option<&serde_json::Value>, app_name: &str) -> Self {
        let name = app_name.to_owned();
        Self::new(
            Scheme::native(),
            local_state,
            Box::new(move || linux_keyring_passwords(&name)),
            Box::new(dpapi_unprotect),
        )
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, Failure> {
        match self.scheme {
            Scheme::Linux => self.decrypt_linux(data),
            Scheme::Windows => self.decrypt_windows(data),
        }
    }

    fn decrypt_linux(&self, data: &[u8]) -> Result<Vec<u8>, Failure> {
        let empty = derive_key(b"");
        if let Some(body) = data.strip_prefix(b"v10") {
            return [derive_key(b"peanuts"), empty]
                .iter()
                .find_map(|key| cbc_decrypt(key, body))
                .ok_or(Failure::CannotDecrypt);
        }
        if let Some(body) = data.strip_prefix(b"v11") {
            let passwords = self
                .v11_passwords
                .get_or_init(|| (self.v11_lookup)())
                .as_ref()
                .map_err(|error| Failure::KeyUnavailable(error.clone()))?;
            if passwords.is_empty() {
                // Still try the empty-password key before giving up.
                return cbc_decrypt(&empty, body).ok_or_else(|| {
                    Failure::KeyUnavailable("no safeStorage password in the keyring".to_owned())
                });
            }
            return passwords
                .iter()
                .map(|password| derive_key(password))
                .chain([empty])
                .find_map(|key| cbc_decrypt(&key, body))
                .ok_or(Failure::CannotDecrypt);
        }
        Ok(data.to_vec())
    }

    fn decrypt_windows(&self, data: &[u8]) -> Result<Vec<u8>, Failure> {
        if let Some(body) = data.strip_prefix(b"v10") {
            let key = self
                .windows_key
                .get_or_init(|| {
                    let blob = self
                        .windows_encrypted_key
                        .as_deref()
                        .ok_or_else(|| "Local State has no os_crypt key".to_owned())?;
                    let protected = blob
                        .strip_prefix(b"DPAPI")
                        .ok_or_else(|| "os_crypt key has no DPAPI prefix".to_owned())?;
                    let key = (self.unprotect)(protected)?;
                    key.try_into()
                        .map_err(|_| "os_crypt key is not 32 bytes".to_owned())
                })
                .as_ref()
                .map_err(|error| Failure::KeyUnavailable(error.clone()))?;
            if body.len() < 12 + 16 {
                return Err(Failure::CannotDecrypt);
            }
            return gcm_decrypt(key, &body[..12], &body[12..]).ok_or(Failure::CannotDecrypt);
        }
        (self.unprotect)(data).map_err(|_| Failure::CannotDecrypt)
    }
}

/// PBKDF2-HMAC-SHA1 with one iteration and a 16-byte key: the first HMAC block, truncated.
fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut salt = b"saltysalt".to_vec();
    salt.extend_from_slice(&1u32.to_be_bytes());
    let mac = hmac_sha1(password, &salt);
    let mut key = [0u8; 16];
    key.copy_from_slice(&mac[..16]);
    key
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..20].copy_from_slice(&Sha1::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha1::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha1::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn cbc_decrypt(key: &[u8; 16], body: &[u8]) -> Option<Vec<u8>> {
    if body.is_empty() || body.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(key).ok()?;
    let mut previous = [b' '; 16];
    let mut out = Vec::with_capacity(body.len());
    for chunk in body.chunks_exact(16) {
        let mut block = aes::Block::try_from(chunk).ok()?;
        cipher.decrypt_block(&mut block);
        for (index, byte) in block.iter().enumerate() {
            out.push(byte ^ previous[index]);
        }
        previous.copy_from_slice(chunk);
    }
    let pad = *out.last()? as usize;
    if pad == 0
        || pad > 16
        || out[out.len() - pad..]
            .iter()
            .any(|byte| *byte as usize != pad)
    {
        return None;
    }
    out.truncate(out.len() - pad);
    Some(out)
}

fn gf_multiply(x: u128, y: u128) -> u128 {
    let mut z = 0u128;
    let mut v = y;
    for bit in 0..128 {
        if (x >> (127 - bit)) & 1 == 1 {
            z ^= v;
        }
        v = if v & 1 == 1 {
            (v >> 1) ^ (0xe1u128 << 120)
        } else {
            v >> 1
        };
    }
    z
}

fn ghash(h: u128, data: &[u8]) -> u128 {
    let mut x = 0u128;
    for chunk in data.chunks(16) {
        let mut block = [0u8; 16];
        block[..chunk.len()].copy_from_slice(chunk);
        x = gf_multiply(x ^ u128::from_be_bytes(block), h);
    }
    let lengths = (0u128 << 64) | ((data.len() as u128) * 8);
    gf_multiply(x ^ lengths, h)
}

fn aes256_block(cipher: &Aes256, input: [u8; 16]) -> [u8; 16] {
    let mut block = aes::Block::from(input);
    cipher.encrypt_block(&mut block);
    block.into()
}

fn gcm_ctr(cipher: &Aes256, nonce: &[u8], first_counter: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for (index, chunk) in data.chunks(16).enumerate() {
        let mut counter = [0u8; 16];
        counter[..12].copy_from_slice(nonce);
        counter[12..].copy_from_slice(&(first_counter.wrapping_add(index as u32)).to_be_bytes());
        let stream = aes256_block(cipher, counter);
        out.extend(chunk.iter().zip(stream).map(|(byte, key)| byte ^ key));
    }
    out
}

fn gcm_tag(cipher: &Aes256, nonce: &[u8], ciphertext: &[u8]) -> [u8; 16] {
    let h = u128::from_be_bytes(aes256_block(cipher, [0; 16]));
    let mut j0 = [0u8; 16];
    j0[..12].copy_from_slice(nonce);
    j0[15] = 1;
    (ghash(h, ciphertext) ^ u128::from_be_bytes(aes256_block(cipher, j0))).to_be_bytes()
}

/// AES-256-GCM, 12-byte nonce, no associated data, tag appended.
pub fn gcm_decrypt(key: &[u8; 32], nonce: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    if nonce.len() != 12 || sealed.len() < 16 {
        return None;
    }
    let cipher = Aes256::new_from_slice(key).ok()?;
    let (ciphertext, tag) = sealed.split_at(sealed.len() - 16);
    let expected = gcm_tag(&cipher, nonce, ciphertext);
    let difference = expected
        .iter()
        .zip(tag)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if difference != 0 {
        return None;
    }
    Some(gcm_ctr(&cipher, nonce, 2, ciphertext))
}

#[cfg(any(test, windows))]
pub fn gcm_encrypt(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256::new_from_slice(key).expect("32-byte key");
    let mut out = gcm_ctr(&cipher, nonce, 2, plaintext);
    let tag = gcm_tag(&cipher, nonce, &out);
    out.extend_from_slice(&tag);
    out
}

/// `sync.cjs` `sealLocal`: base64(iv(12) | tag(16) | body) with the 32-byte `account.key`.
pub fn open_local_sync_secret(payload: &[u8], key: &[u8]) -> Option<Vec<u8>> {
    let key: [u8; 32] = key.try_into().ok()?;
    if payload.len() < 12 + 16 + 1 {
        return None;
    }
    let mut sealed = payload[28..].to_vec();
    sealed.extend_from_slice(&payload[12..28]);
    gcm_decrypt(&key, &payload[..12], &sealed)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_keyring_passwords(app_name: &str) -> Result<Vec<Vec<u8>>, String> {
    if !session_bus_available() {
        return Err("no D-Bus session bus".to_owned());
    }
    let mut passwords = Vec::new();
    let mut errors = Vec::new();
    match secret_service_passwords(app_name) {
        Ok(found) => passwords.extend(found),
        Err(error) => errors.push(error),
    }
    match kwallet_passwords(app_name) {
        Ok(found) => passwords.extend(found),
        Err(error) => errors.push(error),
    }
    if passwords.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(passwords)
}

/// The same quick check as `secrets.rs`: a missing session bus must fail fast.
#[cfg(all(unix, not(target_os = "macos")))]
fn session_bus_available() -> bool {
    if let Ok(address) = std::env::var("DBUS_SESSION_BUS_ADDRESS") {
        return !address.is_empty() && address != "disabled";
    }
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
        if std::path::Path::new(&runtime).join("bus").exists() {
            return true;
        }
    }
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    std::path::Path::new(&format!("/run/user/{uid}/bus")).exists()
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn linux_keyring_passwords(_app_name: &str) -> Result<Vec<Vec<u8>>, String> {
    Err("not a Linux desktop".to_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn secret_service_passwords(app_name: &str) -> Result<Vec<Vec<u8>>, String> {
    use secret_service::blocking::SecretService;
    use secret_service::EncryptionType;
    use std::collections::HashMap;
    let service = SecretService::connect(EncryptionType::Dh)
        .map_err(|_| "Secret Service is not reachable".to_owned())?;
    let mut out = Vec::new();
    let queries: [&[(&str, &str)]; 2] = [
        &[
            ("xdg:schema", "chrome_libsecret_os_crypt_password_v2"),
            ("application", app_name),
        ],
        &[
            ("xdg:schema", "chrome_libsecret_os_crypt_password"),
            ("application", app_name),
        ],
    ];
    for query in queries {
        let attributes: HashMap<&str, &str> = query.iter().copied().collect();
        let Ok(found) = service.search_items(attributes) else {
            continue;
        };
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            if item.is_locked().unwrap_or(true) && item.unlock().is_err() {
                continue;
            }
            if let Ok(secret) = item.get_secret() {
                if !secret.is_empty() {
                    out.push(secret);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn kwallet_passwords(app_name: &str) -> Result<Vec<Vec<u8>>, String> {
    let connection =
        zbus::blocking::Connection::session().map_err(|_| "no D-Bus session".to_owned())?;
    let mut out = Vec::new();
    for (service, path) in [
        ("org.kde.kwalletd6", "/modules/kwalletd6"),
        ("org.kde.kwalletd5", "/modules/kwalletd5"),
    ] {
        let call = |method: &str, body: &(dyn erased::Body)| -> Option<zbus::Message> {
            body.call(&connection, service, path, method)
        };
        let Some(reply) = call("networkWallet", &()) else {
            continue;
        };
        let Ok(wallet) = reply.body().deserialize::<String>() else {
            continue;
        };
        let Some(reply) = call("open", &(wallet, 0i64, app_name.to_owned())) else {
            continue;
        };
        let Ok(handle) = reply.body().deserialize::<i32>() else {
            continue;
        };
        if handle < 0 {
            continue;
        }
        // Electron 43's sync path uses Chromium's names; its async path uses "<app> Keys".
        for (folder, key) in [
            (
                format!("{app_name} Keys"),
                format!("{app_name} Safe Storage"),
            ),
            (
                "Chromium Keys".to_owned(),
                "Chromium Safe Storage".to_owned(),
            ),
        ] {
            if let Some(reply) = call("readPassword", &(handle, folder, key, app_name.to_owned())) {
                if let Ok(password) = reply.body().deserialize::<String>() {
                    if !password.is_empty() {
                        out.push(password.into_bytes());
                    }
                }
            }
        }
        let _ = call("close", &(handle, false, app_name.to_owned()));
    }
    Ok(out)
}

#[cfg(all(unix, not(target_os = "macos")))]
mod erased {
    pub trait Body {
        fn call(
            &self,
            connection: &zbus::blocking::Connection,
            service: &str,
            path: &str,
            method: &str,
        ) -> Option<zbus::Message>;
    }
    impl<T: serde::Serialize + zbus::zvariant::DynamicType> Body for T {
        fn call(
            &self,
            connection: &zbus::blocking::Connection,
            service: &str,
            path: &str,
            method: &str,
        ) -> Option<zbus::Message> {
            connection
                .call_method(Some(service), path, Some("org.kde.KWallet"), method, self)
                .ok()
        }
    }
}

#[cfg(windows)]
pub fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input points at `blob` for the call; output is allocated by DPAPI and freed below.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("DPAPI could not unprotect the key".to_owned());
    }
    // SAFETY: DPAPI returned `cbData` bytes at `pbData`.
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

#[cfg(windows)]
pub fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: as above.
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("DPAPI could not protect the key".to_owned());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

#[cfg(not(windows))]
pub fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI is only available on Windows".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }

    fn no_keyring() -> Lookup {
        Box::new(|| Err("no keyring in tests".to_owned()))
    }

    #[test]
    fn the_v10_key_is_chromiums_fixed_key() {
        assert_eq!(
            derive_key(b"peanuts").to_vec(),
            hex("fd621fe5a2b402539dfa147ca9272778")
        );
        assert_eq!(&derive_key(b"")[..4], &hex("d0d0ec9c")[..]);
    }

    #[test]
    fn linux_v11_uses_the_keyring_password() {
        // Node: aes-128-cbc(pbkdf2("fixture-v11-password")), IV of spaces.
        let value = hex("7631310a16b4baba32a9320ee9cd1d0be092dc");
        let decryptor = Decryptor::new(
            Scheme::Linux,
            None,
            Box::new(|| Ok(vec![b"fixture-v11-password".to_vec()])),
            Box::new(dpapi_unprotect),
        );
        assert_eq!(
            decryptor.decrypt(&value).unwrap(),
            "v11 secret ä".as_bytes()
        );
        let missing = Decryptor::new(Scheme::Linux, None, no_keyring(), Box::new(dpapi_unprotect));
        assert_eq!(
            missing.decrypt(&value).unwrap_err().code(),
            "keyring-unavailable"
        );
        let wrong = Decryptor::new(
            Scheme::Linux,
            None,
            Box::new(|| Ok(vec![b"other".to_vec()])),
            Box::new(dpapi_unprotect),
        );
        assert_eq!(wrong.decrypt(&value).unwrap_err(), Failure::CannotDecrypt);
    }

    #[test]
    fn windows_v10_is_aes_gcm_with_the_dpapi_key() {
        // Node: aes-256-gcm, key 00..1f, nonce 00..0b.
        let value = hex("763130000102030405060708090a0b216bae6fb097a73bfe24f4f9d49d424dc4a4448833e43a5cc8f87d05f43b01b0c11f96461589c8a72fb5b124");
        let key: Vec<u8> = (0u8..32).collect();
        use base64::Engine;
        let mut protected = b"DPAPI".to_vec();
        protected.extend_from_slice(b"fake-dpapi:");
        protected.extend_from_slice(&key);
        let state = serde_json::json!({"os_crypt": {"encrypted_key": base64::engine::general_purpose::STANDARD.encode(&protected)}});
        let unprotect: Unprotect = Box::new(|blob| {
            blob.strip_prefix(b"fake-dpapi:")
                .map(<[u8]>::to_vec)
                .ok_or_else(|| "bad".to_owned())
        });
        let decryptor = Decryptor::new(Scheme::Windows, Some(&state), no_keyring(), unprotect);
        assert_eq!(
            decryptor.decrypt(&value).unwrap(),
            "fixture secret: Grüße 😀".as_bytes()
        );
        let mut damaged = value.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        assert_eq!(
            decryptor.decrypt(&damaged).unwrap_err(),
            Failure::CannotDecrypt
        );
        let no_state = Decryptor::new(
            Scheme::Windows,
            None,
            no_keyring(),
            Box::new(dpapi_unprotect),
        );
        assert_eq!(
            no_state.decrypt(&value).unwrap_err().code(),
            "keyring-unavailable"
        );
        let key: [u8; 32] = (0u8..32).collect::<Vec<_>>().try_into().unwrap();
        let nonce = [7u8; 12];
        assert_eq!(
            gcm_decrypt(&key, &nonce, &gcm_encrypt(&key, &nonce, b"round trip")).unwrap(),
            b"round trip"
        );
    }

    /// CI-only on the Windows runner: the real DPAPI round trip.
    #[cfg(windows)]
    #[test]
    fn windows_dpapi_round_trip() {
        use base64::Engine;
        let key = [42u8; 32];
        let mut protected = b"DPAPI".to_vec();
        protected.extend(dpapi_protect(&key).unwrap());
        let state = serde_json::json!({"os_crypt": {"encrypted_key": base64::engine::general_purpose::STANDARD.encode(&protected)}});
        let mut value = b"v10".to_vec();
        value.extend_from_slice(&[3u8; 12]);
        value.extend(gcm_encrypt(&key, &[3u8; 12], b"made-up windows secret"));
        let decryptor = Decryptor::native(Some(&state), "FaNotes");
        assert_eq!(
            decryptor.decrypt(&value).unwrap(),
            b"made-up windows secret"
        );
        let legacy = dpapi_protect(b"legacy dpapi value").unwrap();
        assert_eq!(decryptor.decrypt(&legacy).unwrap(), b"legacy dpapi value");
    }
}
