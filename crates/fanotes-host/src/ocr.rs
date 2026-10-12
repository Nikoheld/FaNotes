//! Native PyLaia lines for `fanotes:recognize-native-handwriting-line`.
//!
//! The Tauri host speaks the same frames as Electron's `native-ocr.cjs` to the
//! `fanotes-ocr` sidecar. The model stays unloaded until the first valid line.

use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
static SHUTDOWN_DEADLINE_MS: AtomicU64 = AtomicU64::new(0);

pub fn recognize_line(
    request: &Value,
    configured_threads: i64,
    keep_alive_seconds: Option<&Value>,
) -> Result<Value, String> {
    let (width, input) = parse_line(request)?;
    let threads = ocr_thread_count(request.get("threads"), configured_threads, logical_cores());
    IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
    let result = recognize_loaded(width, threads, input);
    IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    schedule_native_ocr_shutdown(keep_alive_seconds);
    result
}

fn recognize_loaded(width: usize, threads: usize, input: Vec<f32>) -> Result<Value, String> {
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

/// Desktop `scheduleNativeOcrShutdown`: a safe whole number of seconds from 0
/// through 600, otherwise two minutes. Zero waits one millisecond.
pub(crate) fn native_ocr_idle_delay(configured: Option<&Value>) -> Duration {
    let number = match configured {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => crate::vault::js_tonumber(text).unwrap_or(f64::NAN),
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    };
    if number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= 9_007_199_254_740_991.0
        && (0.0..=600.0).contains(&number)
    {
        Duration::from_millis((number as u64).saturating_mul(1_000).max(1))
    } else {
        Duration::from_millis(120_000)
    }
}

fn schedule_native_ocr_shutdown(configured: Option<&Value>) {
    let delay = native_ocr_idle_delay(configured);
    let deadline = now_millis().saturating_add(delay.as_millis() as u64).max(1);
    SHUTDOWN_DEADLINE_MS.store(deadline, Ordering::Relaxed);
    static SLEEPER: OnceLock<()> = OnceLock::new();
    SLEEPER.get_or_init(|| {
        thread::spawn(|| loop {
            let deadline = SHUTDOWN_DEADLINE_MS.load(Ordering::Relaxed);
            let now = now_millis();
            if deadline == 0 || now < deadline {
                let wait = if deadline == 0 {
                    Duration::from_secs(60)
                } else {
                    Duration::from_millis(deadline - now)
                };
                thread::sleep(wait.min(Duration::from_secs(60)));
                continue;
            }
            let mut guard = SIDECAR.lock().unwrap_or_else(|error| error.into_inner());
            let expired = SHUTDOWN_DEADLINE_MS.load(Ordering::Relaxed);
            if expired == 0 || now_millis() < expired || IN_FLIGHT.load(Ordering::Relaxed) != 0 {
                drop(guard);
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            if SHUTDOWN_DEADLINE_MS
                .compare_exchange(expired, 0, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
            {
                drop(guard);
                continue;
            }
            if let Some(mut sidecar) = guard.take() {
                let _ = sidecar.child.kill();
                let _ = sidecar.child.wait();
            }
        });
    });
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_line(request: &Value) -> Result<(usize, Vec<f32>), String> {
    let invalid = || "Die native OCR-Eingabe ist ungültig.".to_owned();
    // `Number.isSafeInteger` keeps a whole width such as `32.0`, and `128.0 !== 128` is false.
    let width = crate::resources::json_safe_u64(request.get("width")).ok_or_else(invalid)? as usize;
    let height =
        crate::resources::json_safe_u64(request.get("height")).ok_or_else(invalid)? as usize;
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
    let size = crate::resources::json_safe_u64(manifest["characters"].get("size"))
        .filter(|size| *size > 0 && *size <= 256 * 1024)
        .ok_or_else(|| "Unbekanntes natives Handschriftmodell.".to_owned())?;
    let count = crate::resources::json_safe_u64(manifest["characters"].get("count"))
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
    use super::{load_characters, native_ocr_idle_delay, ocr_thread_count, parse_line};
    use base64::Engine;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::time::Duration;

    #[test]
    fn native_ocr_idle_delay_follows_the_desktop() {
        assert_eq!(native_ocr_idle_delay(None), Duration::from_millis(120_000));
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(0))),
            Duration::from_millis(1)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(0.0))),
            Duration::from_millis(1)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(30))),
            Duration::from_secs(30)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(120.0))),
            Duration::from_secs(120)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!("600"))),
            Duration::from_secs(600)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(601))),
            Duration::from_millis(120_000)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(30.5))),
            Duration::from_millis(120_000)
        );
        assert_eq!(
            native_ocr_idle_delay(Some(&json!(-1))),
            Duration::from_millis(120_000)
        );
    }

    #[test]
    fn a_whole_line_width_still_counts() {
        let width = 32usize;
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0u8; width * 128 * 4]);
        let mut request = json!({
            "width": 32.0,
            "height": 128.0,
            "inputBase64": encoded,
        });
        let (parsed, input) = parse_line(&request).unwrap();
        assert_eq!(parsed, width);
        assert_eq!(input.len(), width * 128);
        request["width"] = json!(32.5);
        assert_eq!(
            parse_line(&request).unwrap_err(),
            "Die native OCR-Eingabe ist ungültig."
        );
    }

    #[test]
    fn a_character_manifest_keeps_a_whole_size() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-ocr-whole-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = serde_json::to_vec(&json!(["a"])).unwrap();
        std::fs::write(dir.join("chars.json"), &bytes).unwrap();
        let hash = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let size = bytes.len();
        let manifest = format!(
            r#"{{"characters":{{"file":"chars.json","size":{size}.0,"count":1.0,"sha256":"{hash}"}}}}"#
        );
        assert_eq!(load_characters(&dir, &manifest).unwrap(), vec!["a"]);
        let fractional =
            manifest.replace(&format!("\"size\":{size}.0"), &format!("\"size\":{size}.5"));
        assert_eq!(
            load_characters(&dir, &fractional).unwrap_err(),
            "Unbekanntes natives Handschriftmodell."
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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
