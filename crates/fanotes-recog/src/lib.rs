//! Shared handwriting recognition pieces for FaNotes.
//!
//! The line tensor and the CTC decoder live here so the desktop sidecar and the web
//! `onnxruntime-web` session consume one implementation. Inference itself does not: desktop runs
//! PyLaia through `fanotes-ort`, and the web keeps `session.run` on `onnxruntime-web`.
//! Personal prototype fusion is the same code the TypeScript model builder can still run.

mod ctc;
mod fusion;
mod language;
mod line;

pub use ctc::{decode_ctc, CtcDecoded, CtcRun, DecodeError};
pub use fusion::{fuse_recognition_model, FusionEntry, FusionModel};
pub use language::Language;
pub use line::{
    line_tensor, LineBounds, LineOptions, LineStroke, LineTensor, MAX_MODEL_WIDTH, MIN_MODEL_WIDTH,
    MODEL_HEIGHT,
};
