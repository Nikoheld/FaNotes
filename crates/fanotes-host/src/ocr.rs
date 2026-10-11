//! Native PyLaia lines for `fanotes:recognize-native-handwriting-line`.
//!
//! The Tauri host speaks the same frames as Electron's `native-ocr.cjs` to the
//! `fanotes-ocr` sidecar. The model stays unloaded until the first valid line.

use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::Engine;
use fanotes_ort::protocol::{read_frame, write_frame, Reply, Request};
use fanotes_ort::{verify_model_file, ModelDescriptor, ENGINE, MODEL_HEIGHT};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

struct Sidecar {
    child: Child,
    input: BufWriter<std::process::ChildStdin>,
    output: BufReader<std::process::ChildStdout>,
    characters: Vec<String>,
}

static SIDECAR: Mutex<Option<Sidecar>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn recognize_line(request: &Value, configured_threads: i64) -> Result<Value, String> {
    let (width, input) = parse_line(request)?;
    let threads = ocr_thread_count(request.get("threads"), configured_threads, logical_cores());
    let mut guard = SIDECAR.lock().unwrap_or_else(|error| error.into_inner());
    if guard.is_none() {
        *guard = Some(start_sidecar()?);
    }
    let sidecar = guard.as_mut().expect("sidecar was just started");
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let frame = Request {
        id: id.clone(),
        width,
        threads,
        input,
    }
    .encode();
    if write_frame(&mut sidecar.input, &frame.header, &frame.payload).is_err() {
        let _ = sidecar.child.kill();
        *guard = None;
        return Err("Die native ONNX-Laufzeit ist nicht verfügbar.".to_owned());
    }
    let reply = match read_frame(&mut sidecar.output) {
        Ok(Some(frame)) => Reply::parse(&frame).map_err(|_| {
            "Die native ONNX-Laufzeit hat keine lesbare Textzeile geliefert.".to_owned()
        })?,
        _ => {
            let _ = sidecar.child.kill();
            *guard = None;
            return Err("Die native ONNX-Laufzeit ist nicht verfügbar.".to_owned());
        }
    };
    match reply {
        Reply::Error { message, .. } => Err(message),
        Reply::Prediction {
            prediction, engine, ..
        } => {
            if engine != ENGINE {
                return Err("Die native OCR-Antwort ist ungültig.".to_owned());
            }
            let payload: Vec<u8> = prediction
                .probabilities
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect();
            Ok(json!({
                "engine": engine,
                "dims": prediction.dims,
                "characters": sidecar.characters,
                "probabilitiesBase64": base64::engine::general_purpose::STANDARD.encode(payload),
            }))
        }
    }
}

fn parse_line(request: &Value) -> Result<(usize, Vec<f32>), String> {
    let invalid = || "Die native OCR-Eingabe ist ungültig.".to_owned();
    let width = request
        .get("width")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)? as usize;
    let height = request
        .get("height")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)? as usize;
    if height != MODEL_HEIGHT || !(32..=4096).contains(&width) {
        return Err(invalid());
    }
    let encoded = request
        .get("inputBase64")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid())?;
    if bytes.len() != width * MODEL_HEIGHT * 4 {
        return Err(invalid());
    }
    let input = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    Ok((width, input))
}

/// Desktop `recognizeNativeOcrLine`: the setting and the CPU count cap the
/// request. `0` means automatic, half the logical cores, at most four.
pub(crate) fn ocr_thread_count(
    requested: Option<&Value>,
    configured: i64,
    logical_cores: usize,
) -> usize {
    let logical = logical_cores.max(1) as i64;
    let automatic = (logical / 2).clamp(1, 4);
    let maximum = if (1..=4).contains(&configured) {
        configured
    } else {
        automatic
    };
    let requested = integer_threads(requested).unwrap_or(maximum);
    let threads = [4, logical, maximum, requested]
        .into_iter()
        .min()
        .unwrap_or(1);
    threads.max(1) as usize
}

fn integer_threads(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    let number = value.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 {
        Some(number as i64)
    } else {
        None
    }
}

fn logical_cores() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

fn start_sidecar() -> Result<Sidecar, String> {
    let directory = ocr_directory()?;
    let manifest_text = std::fs::read_to_string(directory.join("manifest.json"))
        .map_err(|_| "Unbekanntes natives Handschriftmodell.".to_owned())?;
    let descriptor =
        ModelDescriptor::from_manifest(&manifest_text).map_err(|error| error.to_string())?;
    let model = directory.join(descriptor.file());
    verify_model_file(&model, &descriptor).map_err(|error| error.to_string())?;
    let characters = load_characters(&directory, &manifest_text)?;
    let executable = ocr_executable()?;
    let runtime = runtime_library()?;
    let mut child = Command::new(executable)
        .arg("--model")
        .arg(&model)
        .arg("--size")
        .arg(descriptor.size().to_string())
        .arg("--sha256")
        .arg(descriptor.sha256_hex())
        .arg("--runtime")
        .arg(runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Die native ONNX-Laufzeit ist nicht verfügbar: {error}"))?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| "Die native ONNX-Laufzeit ist nicht verfügbar.".to_owned())?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| "Die native ONNX-Laufzeit ist nicht verfügbar.".to_owned())?;
    Ok(Sidecar {
        child,
        input: BufWriter::new(input),
        output: BufReader::new(output),
        characters,
    })
}

fn load_characters(directory: &Path, manifest_text: &str) -> Result<Vec<String>, String> {
    let manifest: Value = serde_json::from_str(manifest_text)
        .map_err(|_| "Unbekanntes natives Handschriftmodell.".to_owned())?;
    let file = manifest["characters"]["file"]
        .as_str()
        .ok_or_else(|| "Unbekanntes natives Handschriftmodell.".to_owned())?;
    let size = manifest["characters"]["size"]
        .as_u64()
        .ok_or_else(|| "Unbekanntes natives Handschriftmodell.".to_owned())?;
    let count = manifest["characters"]["count"]
        .as_u64()
        .ok_or_else(|| "Unbekanntes natives Handschriftmodell.".to_owned())?
        as usize;
    let expected = manifest["characters"]["sha256"]
        .as_str()
        .ok_or_else(|| "Unbekanntes natives Handschriftmodell.".to_owned())?;
    let bytes = std::fs::read(directory.join(file))
        .map_err(|_| "Der native OCR-Zeichensatz ist beschädigt.".to_owned())?;
    if bytes.len() as u64 != size {
        return Err("Der native OCR-Zeichensatz ist beschädigt.".to_owned());
    }
    let digest = Sha256::digest(&bytes);
    let actual = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != expected {
        return Err("Der native OCR-Zeichensatz ist beschädigt.".to_owned());
    }
    let characters: Vec<String> = serde_json::from_slice(&bytes)
        .map_err(|_| "Der native OCR-Zeichensatz ist ungültig.".to_owned())?;
    if characters.len() != count
        || characters
            .iter()
            .any(|character| character.chars().count() != 1)
    {
        return Err("Der native OCR-Zeichensatz ist ungültig.".to_owned());
    }
    Ok(characters)
}

fn ocr_directory() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(dir) = std::env::var("FANOTES_OCR_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("fanotes/public/ocr"));
        candidates.push(cwd.join("public/ocr"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fanotes/public/ocr"));
    candidates
        .into_iter()
        .find(|path| path.join("manifest.json").is_file())
        .ok_or_else(|| "Unbekanntes natives Handschriftmodell.".to_owned())
}

fn ocr_executable() -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "fanotes-ocr.exe"
    } else {
        "fanotes-ocr"
    };
    let platform = format!("{}-{}", std::env::consts::OS, arch_name());
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("FANOTES_OCR_BIN") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("fanotes/native-ocr").join(&platform).join(name));
        candidates.push(cwd.join("target/debug").join(name));
        candidates.push(cwd.join("target/release").join(name));
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    candidates.push(root.join("fanotes/native-ocr").join(&platform).join(name));
    candidates.push(root.join("target/debug").join(name));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Die native ONNX-Laufzeit ist nicht verfügbar.".to_owned())
}

fn runtime_library() -> Result<PathBuf, String> {
    let file = fanotes_ort::default_runtime_file();
    let napi = PathBuf::from("node_modules/onnxruntime-node/bin/napi-v3")
        .join(std::env::consts::OS)
        .join(arch_name())
        .join(file);
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("FANOTES_ORT_RUNTIME") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("fanotes").join(&napi));
        candidates.push(cwd.join(&napi));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fanotes")
            .join(&napi),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("Die native ONNX-Laufzeit ist nicht verfügbar: {file}"))
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::ocr_thread_count;
    use serde_json::json;

    #[test]
    fn native_ocr_threads_follow_the_desktop_cap() {
        assert_eq!(ocr_thread_count(Some(&json!(4)), 1, 8), 1);
        assert_eq!(ocr_thread_count(Some(&json!(4)), 0, 8), 4);
        assert_eq!(ocr_thread_count(Some(&json!(4)), 0, 2), 1);
        assert_eq!(ocr_thread_count(None, 0, 4), 2);
        assert_eq!(ocr_thread_count(Some(&json!(2)), 3, 8), 2);
        assert_eq!(ocr_thread_count(Some(&json!(0)), 4, 8), 1);
        assert_eq!(ocr_thread_count(Some(&json!(-3)), 4, 8), 1);
        assert_eq!(ocr_thread_count(Some(&json!(2.5)), 4, 8), 4);
        assert_eq!(ocr_thread_count(Some(&json!(8)), 0, 16), 4);
    }
}
