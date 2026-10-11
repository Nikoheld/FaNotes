//! Spelling filters and the PyLaia bundle from the application directory.
//!
//! Electron reads `dist/spell` and `public/ocr` (or `dist/ocr` when packaged),
//! checks each file against the manifest, and returns the bytes to the renderer.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
const MAX_FILTER_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CANDIDATE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MODEL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RUNTIME_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CHARACTERS_BYTES: u64 = 256 * 1024;

pub(crate) fn load_spelling() -> Result<Value, String> {
    let directory = locate("spell", "Ungültiges Rechtschreibmanifest.")?;
    let manifest = read_manifest(&directory, "Ungültiges Rechtschreibmanifest.")?;
    if manifest.get("format").and_then(Value::as_str) != Some("fanotes-spelling-bloom-v2")
        || manifest.get("hashes").and_then(Value::as_u64) != Some(8)
    {
        return Err("Unbekanntes Rechtschreibformat.".to_owned());
    }
    let de = read_filter(&directory, &manifest, "de", "de.bloom")?;
    let en = read_filter(&directory, &manifest, "en", "en.bloom")?;
    Ok(json!({
        "manifest": manifest,
        "de": encode(&de),
        "en": encode(&en),
    }))
}

pub(crate) fn load_spelling_candidates(language: &str) -> Result<Value, String> {
    if language != "de" && language != "en" {
        return Err("Unbekannte Wörterbuchsprache.".to_owned());
    }
    let directory = locate("spell", "Ungültiges Rechtschreibmanifest.")?;
    let manifest = read_manifest(&directory, "Ungültiges Rechtschreibmanifest.")?;
    if manifest.get("format").and_then(Value::as_str) != Some("fanotes-spelling-bloom-v2") {
        return Err("Unbekanntes Rechtschreibformat.".to_owned());
    }
    let descriptor = manifest
        .pointer(&format!("/languages/{language}/candidates"))
        .cloned()
        .ok_or_else(|| "Ungültige OCR-Wortliste im Rechtschreibmanifest.".to_owned())?;
    let file = descriptor.get("file").and_then(Value::as_str);
    let size = descriptor.get("size").and_then(Value::as_u64);
    let word_count = descriptor.get("wordCount").and_then(Value::as_u64);
    let hash = descriptor.get("sha256").and_then(Value::as_str);
    let expected = format!("{language}.words");
    if file != Some(expected.as_str())
        || size.is_none_or(|size| !(100_000..=MAX_CANDIDATE_BYTES).contains(&size))
        || word_count.is_none_or(|count| count < 10_000)
        || hash.is_none_or(|hash| !is_sha256(hash))
    {
        return Err("Ungültige OCR-Wortliste im Rechtschreibmanifest.".to_owned());
    }
    let size = size.unwrap_or(0);
    let hash = hash.unwrap_or("");
    let bytes = read_hashed(
        &directory,
        &expected,
        size,
        MAX_CANDIDATE_BYTES,
        hash,
        "Ungültige OCR-Wortlistenlänge.",
        "Beschädigte OCR-Wortliste.",
    )?;
    if bytes.len() as u64 != size {
        return Err("Ungültige OCR-Wortlistenlänge.".to_owned());
    }
    Ok(json!({
        "language": language,
        "descriptor": descriptor,
        "bytes": encode(&bytes),
    }))
}

pub(crate) fn load_handwriting() -> Result<Value, String> {
    let directory = locate("ocr", "Ungültiges Handschriftmodell-Manifest.")?;
    let manifest = read_manifest(&directory, "Ungültiges Handschriftmodell-Manifest.")?;
    let desktop = manifest
        .pointer("/models/desktop")
        .ok_or_else(|| "Unbekanntes Handschriftmodell.".to_owned())?;
    let web = manifest
        .pointer("/models/web")
        .ok_or_else(|| "Unbekanntes Handschriftmodell.".to_owned())?;
    let runtime = manifest
        .pointer("/runtime")
        .ok_or_else(|| "Unbekanntes Handschriftmodell.".to_owned())?;
    let characters = manifest
        .pointer("/characters")
        .ok_or_else(|| "Unbekanntes Handschriftmodell.".to_owned())?;
    let desktop_size = desktop.get("size").and_then(Value::as_u64).unwrap_or(0);
    let web_size = web.get("size").and_then(Value::as_u64).unwrap_or(0);
    if manifest.get("format").and_then(Value::as_str) != Some("fanotes-neural-handwriting-v3")
        || desktop.get("name").and_then(Value::as_str) != Some("PyLaia_IAM_CTC")
        || desktop.get("precision").and_then(Value::as_str) != Some("fp32")
        || web.get("name").and_then(Value::as_str) != Some("PyLaia_IAM_CTC")
        || web.get("precision").and_then(Value::as_str) != Some("q8-dynamic")
        || desktop_size == 0
        || web_size == 0
        || web_size as f64 >= desktop_size as f64 * 0.4
        || runtime.get("name").and_then(Value::as_str) != Some("onnxruntime-web")
        || runtime.get("version").and_then(Value::as_str) != Some("1.22.0")
    {
        return Err("Unbekanntes Handschriftmodell.".to_owned());
    }
    let (model_file, model_size, model_hash) = descriptor(desktop, MAX_MODEL_BYTES)
        .map_err(|_| "Ungültige Handschriftmodell-Ressource.".to_owned())?;
    let (_, _, _) = descriptor(web, MAX_MODEL_BYTES)
        .map_err(|_| "Ungültige Handschriftmodell-Ressource.".to_owned())?;
    let (wasm_file, wasm_size, wasm_hash) = descriptor(runtime, MAX_RUNTIME_BYTES)
        .map_err(|_| "Ungültige Handschriftmodell-Ressource.".to_owned())?;
    let (character_file, character_size, character_hash) =
        descriptor(characters, MAX_CHARACTERS_BYTES)
            .map_err(|_| "Ungültige Handschriftmodell-Ressource.".to_owned())?;
    let count = characters
        .get("count")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Ungültige Handschriftmodell-Ressource.".to_owned())?;
    let model = read_hashed(
        &directory,
        model_file,
        model_size,
        MAX_MODEL_BYTES,
        model_hash,
        "Das Handschriftmodell ist unvollständig.",
        "Das Handschriftmodell ist beschädigt.",
    )?;
    let wasm = read_hashed(
        &directory,
        wasm_file,
        wasm_size,
        MAX_RUNTIME_BYTES,
        wasm_hash,
        "Das Handschriftmodell ist unvollständig.",
        "Das Handschriftmodell ist beschädigt.",
    )?;
    let character_bytes = read_hashed(
        &directory,
        character_file,
        character_size,
        MAX_CHARACTERS_BYTES,
        character_hash,
        "Das Handschriftmodell ist unvollständig.",
        "Das Handschriftmodell ist beschädigt.",
    )?;
    let parsed: Vec<String> = serde_json::from_slice(&character_bytes)
        .map_err(|_| "Der Zeichensatz des Handschriftmodells ist beschädigt.".to_owned())?;
    if parsed.len() as u64 != count
        || parsed
            .iter()
            .any(|character| character.chars().count() != 1)
    {
        return Err("Der Zeichensatz des Handschriftmodells ist beschädigt.".to_owned());
    }
    Ok(json!({
        "manifest": manifest,
        "model": encode(&model),
        "wasm": encode(&wasm),
        "characters": parsed,
    }))
}

fn read_filter(
    directory: &Path,
    manifest: &Value,
    language: &str,
    expected_file: &str,
) -> Result<Vec<u8>, String> {
    let descriptor = manifest
        .pointer(&format!("/languages/{language}"))
        .ok_or_else(|| "Ungültiges Rechtschreibmanifest.".to_owned())?;
    let bit_count = descriptor.get("bitCount").and_then(Value::as_u64);
    let hash = descriptor.get("sha256").and_then(Value::as_str);
    if descriptor.get("file").and_then(Value::as_str) != Some(expected_file)
        || bit_count.is_none_or(|count| count == 0 || count % 8 != 0)
        || hash.is_none_or(|hash| !is_sha256(hash))
    {
        return Err("Ungültiges Rechtschreibmanifest.".to_owned());
    }
    let size = bit_count.unwrap_or(0) / 8;
    read_hashed(
        directory,
        expected_file,
        size,
        MAX_FILTER_BYTES,
        hash.unwrap_or(""),
        "Ungültiger Rechtschreibfilter.",
        "Beschädigter Rechtschreibfilter.",
    )
}

fn read_manifest(directory: &Path, error: &str) -> Result<Value, String> {
    let bytes = read_regular(
        &directory.join("manifest.json"),
        1,
        MAX_MANIFEST_BYTES,
        error,
    )?;
    serde_json::from_slice(&bytes).map_err(|_| error.to_owned())
}

fn descriptor<'a>(value: &'a Value, max: u64) -> Result<(&'a str, u64, &'a str), ()> {
    let file = value.get("file").and_then(Value::as_str).ok_or(())?;
    let size = value.get("size").and_then(Value::as_u64).ok_or(())?;
    let hash = value.get("sha256").and_then(Value::as_str).ok_or(())?;
    if !plain_file_name(file) || size == 0 || size > max || !is_sha256(hash) {
        return Err(());
    }
    Ok((file, size, hash))
}

fn read_hashed(
    directory: &Path,
    name: &str,
    size: u64,
    max: u64,
    hash: &str,
    length_error: &str,
    hash_error: &str,
) -> Result<Vec<u8>, String> {
    if size == 0 || size > max {
        return Err(length_error.to_owned());
    }
    let bytes = read_regular(&directory.join(name), size, max, length_error)?;
    if bytes.len() as u64 != size {
        return Err(length_error.to_owned());
    }
    if sha256_hex(&bytes) != hash {
        return Err(hash_error.to_owned());
    }
    Ok(bytes)
}

fn read_regular(path: &Path, min: u64, max: u64, error: &str) -> Result<Vec<u8>, String> {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name != "manifest.json" && !plain_file_name(name))
    {
        return Err(error.to_owned());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| error.to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() < min || meta.len() > max {
        return Err(error.to_owned());
    }
    let bytes = fs::read(path).map_err(|_| error.to_owned())?;
    if (bytes.len() as u64) < min || (bytes.len() as u64) > max {
        return Err(error.to_owned());
    }
    Ok(bytes)
}

fn locate(folder: &str, error: &str) -> Result<PathBuf, String> {
    for root in candidate_roots() {
        let directory = root.join(folder);
        let manifest = directory.join("manifest.json");
        if fs::symlink_metadata(&manifest).is_ok_and(|meta| {
            meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= MAX_MANIFEST_BYTES
        }) {
            return Ok(directory);
        }
    }
    Err(error.to_owned())
}

fn candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = std::env::var("FANOTES_RESOURCES_DIR") {
        if !dir.is_empty() {
            roots.push(PathBuf::from(dir));
        }
    }
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fanotes");
    roots.push(compiled.join("public"));
    roots.push(compiled.join("dist"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("public"));
            roots.push(dir.join("resources"));
            roots.push(dir.join("../public"));
            roots.push(dir.join("../dist"));
        }
    }
    roots
}

fn plain_file_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && chars.all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
        })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
