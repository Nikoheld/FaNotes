//! PyLaia line recognition on the native ONNX Runtime through the `ort` crate.
//!
//! This replaces `fanotes/electron/native-ocr-worker.cjs`. The contract is the worker's: input `x` as
//! `[1, 1, 128, W]` with `W` in 32..=4096, output `probabilities`, CPU execution provider, sequential
//! execution, `ORT_ENABLE_ALL`, CPU memory arena and memory pattern, 1–4 intra-op threads and one
//! inter-op thread. The weights are checked against the size and SHA-256 from
//! `fanotes/public/ocr/manifest.json` before a session is created, and nothing is loaded until the
//! first line arrives.
//!
//! Electron reaches it through the `fanotes-ocr` sidecar (`src/bin/fanotes-ocr.rs`), spoken to over
//! the frames in [`protocol`].

mod model;
pub mod protocol;
mod runtime;
mod session;

pub use model::{verify_model_file, ModelDescriptor};
pub use runtime::{default_runtime_file, exit_process, load_runtime};
pub use session::{Prediction, PylaiaSession};

/// Reported with every result; the renderer refuses results from any other engine.
pub const ENGINE: &str = "fanotes-ort-cpu";
/// ONNX Runtime version the build is pinned to (`onnxruntime-node@1.21.0` in `fanotes/package.json`).
pub const ONNXRUNTIME_VERSION: &str = "1.21.0";
/// PyLaia line height. The ink recognizer uses 64; the sidecar takes the height from the request.
pub const MODEL_HEIGHT: usize = 128;
pub const MIN_HEIGHT: usize = 16;
pub const MAX_HEIGHT: usize = 256;
pub const MIN_WIDTH: usize = 16;
pub const MAX_WIDTH: usize = 4096;
pub const MIN_THREADS: usize = 1;
pub const MAX_THREADS: usize = 4;
/// Default input tensor name (PyLaia). The ink model uses `image`; the request carries the name.
pub const INPUT_NAME: &str = "x";
pub const OUTPUT_NAME: &str = "probabilities";

/// Error texts are the ones `main.cjs` and the worker used, so the host passes them on unchanged.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Die native OCR-Eingabe ist ungültig.")]
    InvalidInput,
    #[error("Unbekanntes natives Handschriftmodell.")]
    UnknownModel,
    #[error("Das native Handschriftmodell ist unvollständig.")]
    IncompleteModel,
    #[error("Das native Handschriftmodell ist beschädigt.")]
    CorruptModel,
    #[error("Die native ONNX-Laufzeit ist nicht verfügbar: {0}")]
    Runtime(String),
    #[error("Die native ONNX-Laufzeit hat keine lesbare Textzeile geliefert.")]
    UnreadableOutput,
    #[error("Die native ONNX-Erkennung ist fehlgeschlagen: {0}")]
    Inference(String),
}

impl From<ort::Error> for Error {
    fn from(error: ort::Error) -> Self {
        Error::Inference(error.to_string())
    }
}

/// True when `threads` is a thread count the worker accepted.
pub fn valid_threads(threads: usize) -> bool {
    (MIN_THREADS..=MAX_THREADS).contains(&threads)
}

/// True when `width` is a line width the worker accepted.
pub fn valid_width(width: usize) -> bool {
    (MIN_WIDTH..=MAX_WIDTH).contains(&width)
}

/// True when `height` is a model input height the sidecar serves (PyLaia 128, ink 64).
pub fn valid_height(height: usize) -> bool {
    (MIN_HEIGHT..=MAX_HEIGHT).contains(&height) && height.is_multiple_of(8)
}

/// True when `name` is a safe ONNX tensor name the request may carry.
pub fn valid_tensor_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'/'))
}
