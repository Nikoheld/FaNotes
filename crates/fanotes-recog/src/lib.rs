//! Shared handwriting recognition pieces for FaNotes.
//!
//! The ink recognizer (`ink`, `lines`, `beam`, `charlm`, `adapt`) renders grouped pen lines into
//! the model image, decodes the line model's CTC output with a character language model and
//! fits the personal classifier update. Desktop and web call it through `fanotes-recog-wasm`;
//! the Android client ports the same procedures and checks them against the same fixtures.
//!
//! The PyLaia line tensor, its CTC decoder and the personal prototype fusion remain for the
//! classic glyph recognizer and the legacy line path.

mod adapt;
mod beam;
mod charlm;
mod ctc;
mod fusion;
mod ink;
mod language;
mod line;
mod lines;

pub use adapt::{adapt_head, ctc_loss_and_gradient, AdaptOptions, AdaptSample, HeadUpdate};
pub use beam::{
    beam_decode, log_softmax, BeamDecoded, BeamOptions, CharAlternative, DecodedChar, Lexicon,
    Reading,
};
pub use charlm::{context_hash, CharLm, CharLmError};
pub use ctc::{decode_ctc, CtcDecoded, CtcRun, DecodeError};
pub use fusion::{fuse_recognition_model, FusionEntry, FusionModel};
pub use ink::{
    ink_image, ink_transform, InkImage, InkOptions, InkTransform, INK_FRAME_STRIDE, INK_HEIGHT,
    INK_MARGIN_X, INK_MARGIN_Y, INK_MAX_WIDTH, INK_MIN_WIDTH, INK_PEN_WIDTH,
};
pub use language::Language;
pub use line::{
    line_tensor, LineBounds, LineOptions, LineStroke, LineTensor, MAX_MODEL_WIDTH, MIN_MODEL_WIDTH,
    MODEL_HEIGHT,
};
pub use lines::{group_ink_lines, InkLine};
