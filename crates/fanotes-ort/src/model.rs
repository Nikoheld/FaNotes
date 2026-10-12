use std::{fs, path::Path};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::Error;

const MANIFEST_FORMAT: &str = "fanotes-neural-handwriting-v3";
const MODEL_NAME: &str = "PyLaia_IAM_CTC";
const MODEL_PRECISION: &str = "fp32";
const MAX_MODEL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHARACTERS_BYTES: u64 = 256 * 1024;

/// The desktop model entry of `public/ocr/manifest.json`: file name, byte size and SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDescriptor {
    file: String,
    size: u64,
    sha256: [u8; 32],
}

impl ModelDescriptor {
    /// Same bounds `verifiedNativeOcrModelPath` in `electron/main.cjs` applies to the manifest entry.
    pub fn new(file: &str, size: u64, sha256: &str) -> Result<Self, Error> {
        if !plain_file_name(file) || size == 0 || size > MAX_MODEL_BYTES {
            return Err(Error::UnknownModel);
        }
        let sha256 = parse_sha256(sha256).ok_or(Error::UnknownModel)?;
        Ok(Self {
            file: file.to_owned(),
            size,
            sha256,
        })
    }

    /// Reads `models.desktop` from the manifest and rejects it unless the whole manifest passes the
    /// checks `main.cjs` makes (format, PyLaia FP32 entry, and a well-formed `characters` entry).
    pub fn from_manifest(json: &str) -> Result<Self, Error> {
        let manifest: Value = serde_json::from_str(json).map_err(|_| Error::UnknownModel)?;
        let desktop = &manifest["models"]["desktop"];
        let characters = &manifest["characters"];
        let characters_ok = characters["file"].as_str().is_some_and(plain_file_name)
            && json_safe_u64(characters.get("size"))
                .is_some_and(|size| size > 0 && size <= MAX_CHARACTERS_BYTES)
            && json_safe_u64(characters.get("count")).is_some()
            && characters["sha256"]
                .as_str()
                .and_then(parse_sha256)
                .is_some();
        if manifest["format"] != MANIFEST_FORMAT
            || desktop["name"] != MODEL_NAME
            || desktop["precision"] != MODEL_PRECISION
            || !characters_ok
        {
            return Err(Error::UnknownModel);
        }
        Self::new(
            desktop["file"].as_str().ok_or(Error::UnknownModel)?,
            json_safe_u64(desktop.get("size")).ok_or(Error::UnknownModel)?,
            desktop["sha256"].as_str().ok_or(Error::UnknownModel)?,
        )
    }

    pub fn file(&self) -> &str {
        &self.file
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn sha256_hex(&self) -> String {
        self.sha256
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// Reads the model once and returns the bytes only if they match the descriptor. The session is
/// built from these bytes, so what was hashed is what runs.
pub fn verify_model_file(path: &Path, descriptor: &ModelDescriptor) -> Result<Vec<u8>, Error> {
    if path.file_name().and_then(|name| name.to_str()) != Some(descriptor.file()) {
        return Err(Error::IncompleteModel);
    }
    let info = fs::symlink_metadata(path).map_err(|_| Error::IncompleteModel)?;
    if !info.file_type().is_file() || info.len() != descriptor.size {
        return Err(Error::IncompleteModel);
    }
    let bytes = fs::read(path).map_err(|_| Error::IncompleteModel)?;
    if bytes.len() as u64 != descriptor.size {
        return Err(Error::IncompleteModel);
    }
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    if digest != descriptor.sha256 {
        return Err(Error::CorruptModel);
    }
    Ok(bytes)
}

/// `Number.isSafeInteger` for a non-negative manifest count. `8.0` counts; `8.5` does not.
fn json_safe_u64(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    if number.is_finite()
        && number.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&number)
    {
        Some(number as u64)
    } else {
        None
    }
}

/// `/^[a-z0-9][a-z0-9._-]*$/u`
fn plain_file_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

/// `/^[a-f0-9]{64}$/u`
fn parse_sha256(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut digest = [0u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(digest)
}
