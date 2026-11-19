//! `fanotes/src/lib/sync/crypto.ts` with `ring` instead of WebCrypto. Same
//! derivations and the same ciphertext layout (`iv ‖ ciphertext ‖ tag`).

use std::num::NonZeroU32;

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, hkdf, hmac, pbkdf2};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::jsjson::{self, Js, JsObject};

pub const KDF_ITERATIONS: u32 = 600_000;
pub const KDF_ALGORITHM: &str = "pbkdf2-sha256";
const HKDF_SALT: &[u8] = b"fanotes-sync-v1";
const GCM_IV_BYTES: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncKdf {
    pub algorithm: String,
    pub iterations: u64,
    pub salt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncKeyWrap {
    pub iv: String,
    pub data: String,
}

pub struct SyncKeys {
    data: LessSafeKey,
    id: hmac::Key,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoError(pub String);

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Deterministic IVs and secrets for the vector tests; `None` in normal use.
static FIXED_RANDOM: std::sync::Mutex<Option<Vec<u8>>> = std::sync::Mutex::new(None);

/// Test hook: the next random bytes come from `bytes` (cycled). Never used by the engine itself.
pub fn set_fixed_random_for_tests(bytes: Option<Vec<u8>>) {
    *FIXED_RANDOM
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = bytes;
}

pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut out = vec![0u8; length];
    if let Some(fixed) = FIXED_RANDOM
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
    {
        for (index, slot) in out.iter_mut().enumerate() {
            *slot = fixed[index % fixed.len()];
        }
        return out;
    }
    SystemRandom::new().fill(&mut out).expect("system random");
    out
}

pub fn to_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `atob` (forgiving base64): ASCII white space removed, padding optional.
pub fn from_base64(text: &str) -> Result<Vec<u8>, CryptoError> {
    let invalid = || CryptoError("The string to be decoded is not correctly encoded.".to_owned());
    let mut cleaned: Vec<u8> = text
        .bytes()
        .filter(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r'))
        .collect();
    if cleaned.len().is_multiple_of(4) {
        if cleaned.ends_with(b"==") {
            cleaned.truncate(cleaned.len() - 2);
        } else if cleaned.ends_with(b"=") {
            cleaned.truncate(cleaned.len() - 1);
        }
    }
    if cleaned.len() % 4 == 1
        || !cleaned
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
    {
        return Err(invalid());
    }
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in cleaned {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(digest::digest(&digest::SHA256, bytes).as_ref())
}

pub fn new_kdf() -> SyncKdf {
    SyncKdf {
        algorithm: KDF_ALGORITHM.to_owned(),
        iterations: u64::from(KDF_ITERATIONS),
        salt: to_base64(&random_bytes(16)),
    }
}

/// `isValidKdf(value)` on the JSON the server sent.
pub fn is_valid_kdf_json(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let iterations_ok = object
        .get("iterations")
        .and_then(serde_json::Value::as_f64)
        .is_some_and(|iterations| {
            iterations.fract() == 0.0 && (100_000.0..=5_000_000.0).contains(&iterations)
        });
    object.get("algorithm").and_then(serde_json::Value::as_str) == Some(KDF_ALGORITHM)
        && iterations_ok
        && object
            .get("salt")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|salt| jsjson::utf16_len(salt) >= 20)
}

pub struct WrappingKey(LessSafeKey);

/// `deriveFromPassword(password, kdf)`: the wrapping key and the base64 auth key.
pub fn derive_from_password(
    password: &str,
    kdf: &SyncKdf,
) -> Result<(WrappingKey, String), CryptoError> {
    let valid = kdf.algorithm == KDF_ALGORITHM
        && (100_000..=5_000_000).contains(&kdf.iterations)
        && jsjson::utf16_len(&kdf.salt) >= 20;
    if !valid {
        return Err(CryptoError(
            "Die Schlüsselableitung des Kontos wird nicht unterstützt.".to_owned(),
        ));
    }
    let normalized: String = password.nfkc().collect();
    let salt = from_base64(&kdf.salt)?;
    let mut bits = [0u8; 64];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(kdf.iterations as u32).expect("checked"),
        &salt,
        normalized.as_bytes(),
        &mut bits,
    );
    let key = LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, &bits[..32]).expect("32 bytes"));
    let auth_key = to_base64(&bits[32..]);
    bits.fill(0);
    Ok((WrappingKey(key), auth_key))
}

pub fn new_vault_secret() -> Vec<u8> {
    random_bytes(32)
}

fn seal(key: &LessSafeKey, iv: &[u8], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let mut data = plain.to_vec();
    let nonce = Nonce::try_assume_unique_for_key(iv).expect("12-byte iv");
    key.seal_in_place_append_tag(nonce, Aad::from(aad), &mut data)
        .expect("seal");
    data
}

fn open(key: &LessSafeKey, iv: &[u8], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    let nonce = Nonce::try_assume_unique_for_key(iv).ok()?;
    let mut data = sealed.to_vec();
    let plain = key.open_in_place(nonce, Aad::from(aad), &mut data).ok()?;
    Some(plain.to_vec())
}

pub fn wrap_vault_secret(secret: &[u8], wrapping: &WrappingKey) -> SyncKeyWrap {
    let iv = random_bytes(GCM_IV_BYTES);
    let data = seal(&wrapping.0, &iv, &[], secret);
    SyncKeyWrap {
        iv: to_base64(&iv),
        data: to_base64(&data),
    }
}

pub fn unwrap_vault_secret(
    wrap: &SyncKeyWrap,
    wrapping: &WrappingKey,
) -> Result<Vec<u8>, CryptoError> {
    let failed = || {
        CryptoError(
            "Der Vault-Schlüssel konnte mit diesem Passwort nicht entschlüsselt werden.".to_owned(),
        )
    };
    let iv = from_base64(&wrap.iv).map_err(|_| failed())?;
    let data = from_base64(&wrap.data).map_err(|_| failed())?;
    if iv.len() != GCM_IV_BYTES {
        return Err(failed());
    }
    open(&wrapping.0, &iv, &[], &data).ok_or_else(failed)
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf_expand(secret: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, HKDF_SALT).extract(secret);
    let mut out = [0u8; 32];
    prk.expand(&[info], Len(32))
        .expect("hkdf length")
        .fill(&mut out)
        .expect("fill");
    out
}

/// `deriveSyncKeys(importVaultSecret(secret))`.
pub fn derive_sync_keys(vault_secret: &[u8]) -> SyncKeys {
    let mut data = hkdf_expand(vault_secret, b"data");
    let mut id = hkdf_expand(vault_secret, b"id");
    let keys = SyncKeys {
        data: LessSafeKey::new(UnboundKey::new(&aead::AES_256_GCM, &data).expect("32 bytes")),
        id: hmac::Key::new(hmac::HMAC_SHA256, &id),
    };
    data.fill(0);
    id.fill(0);
    keys
}

/// `fileIdFor(keys, path)`: HMAC over the NFC path.
pub fn file_id_for(keys: &SyncKeys, path: &str) -> String {
    let normalized: String = path.nfc().collect();
    to_hex(hmac::sign(&keys.id, normalized.as_bytes()).as_ref())
}

/// `encryptBytes(keys, fileId, plain)`.
pub fn encrypt_bytes(keys: &SyncKeys, file_id: &str, plain: &[u8]) -> Vec<u8> {
    let iv = random_bytes(GCM_IV_BYTES);
    let mut out = iv.clone();
    out.extend(seal(&keys.data, &iv, file_id.as_bytes(), plain));
    out
}

/// `decryptBytes(keys, fileId, blob)`.
pub fn decrypt_bytes(keys: &SyncKeys, file_id: &str, blob: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if blob.len() < GCM_IV_BYTES + 16 {
        return Err(CryptoError(
            "Der verschlüsselte Inhalt ist beschädigt.".to_owned(),
        ));
    }
    open(&keys.data, &blob[..GCM_IV_BYTES], file_id.as_bytes(), &blob[GCM_IV_BYTES..])
        .ok_or_else(|| CryptoError("Der Inhalt konnte nicht entschlüsselt werden – falscher Schlüssel oder beschädigte Datei.".to_owned()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncFileMeta {
    pub path: String,
    pub mtime_ms: f64,
    pub size: f64,
    pub sha256: String,
}

/// `encryptMeta`: base64 of the encrypted `JSON.stringify({path, mtimeMs, size, sha256})`.
pub fn encrypt_meta(keys: &SyncKeys, file_id: &str, meta: &SyncFileMeta) -> String {
    let mut object = JsObject::new();
    object.define_str("path", Js::str(&meta.path));
    object.define_str("mtimeMs", Js::Num(meta.mtime_ms));
    object.define_str("size", Js::Num(meta.size));
    object.define_str("sha256", Js::str(&meta.sha256));
    let json = jsjson::stringify(&Js::Obj(object));
    to_base64(&encrypt_bytes(keys, file_id, json.as_bytes()))
}

/// `decryptMeta`.
pub fn decrypt_meta(
    keys: &SyncKeys,
    file_id: &str,
    encoded: &str,
) -> Result<SyncFileMeta, CryptoError> {
    let plain = decrypt_bytes(keys, file_id, &from_base64(encoded)?)?;
    let text = jsjson::text_decode(&plain);
    let parsed =
        jsjson::parse(&text).map_err(|_| CryptoError("Unexpected token in JSON".to_owned()))?;
    let path = match parsed.get("path") {
        Some(Js::Str(path)) => path.to_string_lossy(),
        _ => {
            return Err(CryptoError(
                "Die Metadaten der Datei sind unvollständig.".to_owned(),
            ))
        }
    };
    let sha256 = match parsed.get("sha256") {
        Some(Js::Str(sha)) => sha.to_string_lossy(),
        _ => {
            return Err(CryptoError(
                "Die Metadaten der Datei sind unvollständig.".to_owned(),
            ))
        }
    };
    let number = |key: &str| {
        let value = jsjson::to_number(parsed.get(key));
        if value.is_nan() || value == 0.0 {
            0.0
        } else {
            value
        }
    };
    Ok(SyncFileMeta {
        path,
        mtime_ms: number("mtimeMs"),
        size: number("size"),
        sha256,
    })
}

/// `passwordProblems(password)`.
pub fn password_problems(password: &str) -> Option<&'static str> {
    let length = jsjson::utf16_len(password);
    if length < 10 {
        return Some("Das Passwort braucht mindestens 10 Zeichen.");
    }
    if length > 256 {
        return Some("Das Passwort ist zu lang.");
    }
    let mut chars = password.chars();
    let first = chars.next();
    let repeated =
        password.chars().count() >= 2 && password.chars().all(|character| Some(character) == first);
    let lower: String = password.chars().take(12).collect::<String>().to_lowercase();
    let simple = ["0123456789", "1234567890", "qwertzuiop", "asdfghjkl"]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
    if repeated || simple {
        return Some("Dieses Passwort ist zu leicht zu erraten.");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blobs_are_bound_to_their_id() {
        let keys = derive_sync_keys(&[7u8; 32]);
        let id = file_id_for(&keys, "Mathe/Algebra.md");
        assert_eq!(id.len(), 64);
        let blob = encrypt_bytes(&keys, &id, b"# Algebra");
        assert_eq!(decrypt_bytes(&keys, &id, &blob).unwrap(), b"# Algebra");
        assert!(decrypt_bytes(&keys, &"0".repeat(64), &blob).is_err());
        let meta = SyncFileMeta {
            path: "Mathe/Algebra.md".into(),
            mtime_ms: 5.0,
            size: 9.0,
            sha256: sha256_hex(b"# Algebra"),
        };
        assert_eq!(
            decrypt_meta(&keys, &id, &encrypt_meta(&keys, &id, &meta)).unwrap(),
            meta
        );
    }

    #[test]
    fn forgiving_base64() {
        assert_eq!(from_base64("aGk=").unwrap(), b"hi");
        assert_eq!(from_base64("aGk").unwrap(), b"hi");
        assert_eq!(from_base64(" aG k= ").unwrap(), b"hi");
        assert!(from_base64("a").is_err());
        assert!(from_base64("a$==").is_err());
    }

    #[test]
    fn password_rules() {
        assert_eq!(
            password_problems("kurz"),
            Some("Das Passwort braucht mindestens 10 Zeichen.")
        );
        assert_eq!(
            password_problems("aaaaaaaaaaaa"),
            Some("Dieses Passwort ist zu leicht zu erraten.")
        );
        assert_eq!(
            password_problems("QWERTZUIOP123"),
            Some("Dieses Passwort ist zu leicht zu erraten.")
        );
        assert_eq!(password_problems("korrektes pferd batterie"), None);
    }
}
