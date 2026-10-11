//! Browser and Electron entry for the shared line tensor and CTC decoder.
//!
//! Loaded with the handwriting recognizer, not at application startup. Web inference stays in
//! `onnxruntime-web`; this module only builds the tensor and reads the probabilities.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use fanotes_recog::{decode_ctc, line_tensor, Language, LineBounds, LineOptions, LineStroke};
use wasm_bindgen::prelude::*;

thread_local! {
    static EXTRA_WORDS: RefCell<HashMap<String, HashSet<String>>> = RefCell::new(HashMap::new());
}

fn empty_words() -> &'static HashSet<String> {
    static EMPTY: OnceLock<HashSet<String>> = OnceLock::new();
    EMPTY.get_or_init(HashSet::new)
}

/// Remembers the spelling candidates for one language. Called once, when handwriting recognition
/// loads that language, so a line decode does not copy the list again.
#[wasm_bindgen(js_name = setLexicon)]
pub fn set_lexicon(language: &str, words: Vec<String>) {
    EXTRA_WORDS.with(|extra| {
        extra
            .borrow_mut()
            .insert(language.to_owned(), words.into_iter().collect());
    });
}

#[wasm_bindgen(js_name = decodeCtc)]
pub fn decode_ctc_js(
    probabilities: &[f32],
    time_steps: u32,
    classes: u32,
    characters: Vec<String>,
    language: &str,
) -> Result<String, JsError> {
    let parsed =
        Language::parse(language).ok_or_else(|| JsError::new("Unbekannte Erkennungssprache."))?;
    let decoded = EXTRA_WORDS
        .with(|extra| {
            let map = extra.borrow();
            let words = map.get(language).unwrap_or(empty_words());
            decode_ctc(
                probabilities,
                time_steps as usize,
                classes as usize,
                &characters,
                parsed,
                words,
            )
        })
        .map_err(|error| JsError::new(&error.to_string()))?;
    serde_json::to_string(&decoded).map_err(|error| JsError::new(&error.to_string()))
}

/// Packed strokes: for each stroke, `baseWidth`, `pointCount`, then that many `x, y` page coordinates.
/// Ratios are `NaN` when the caller wants the default crop.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = lineTensor)]
pub fn line_tensor_js(
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    source_width: f64,
    source_height: f64,
    margin_x_ratio: f64,
    margin_y_ratio: f64,
    ink_scale: f64,
    packed: &[f64],
) -> Result<Vec<f32>, JsError> {
    let strokes = unpack_strokes(packed).map_err(JsError::new)?;
    let tensor = line_tensor(
        LineBounds {
            min_x,
            min_y,
            max_x,
            max_y,
        },
        &strokes,
        source_width,
        source_height,
        LineOptions {
            margin_x_ratio: finite(margin_x_ratio),
            margin_y_ratio: finite(margin_y_ratio),
            ink_scale: finite(ink_scale),
        },
    );
    let mut out = Vec::with_capacity(1 + tensor.values.len());
    out.push(tensor.width as f32);
    out.extend(tensor.values);
    Ok(out)
}

fn finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

fn unpack_strokes(packed: &[f64]) -> Result<Vec<LineStroke>, &'static str> {
    let mut strokes = Vec::new();
    let mut index = 0;
    while index < packed.len() {
        if index + 2 > packed.len() {
            return Err("Unvollständige Stiftzeile.");
        }
        let base_width = packed[index];
        let count = packed[index + 1] as usize;
        index += 2;
        if index + count * 2 > packed.len() {
            return Err("Unvollständige Stiftzeile.");
        }
        let (pairs, _) = packed[index..index + count * 2].as_chunks::<2>();
        let points = pairs.iter().map(|pair| (pair[0], pair[1])).collect();
        index += count * 2;
        strokes.push(LineStroke { base_width, points });
    }
    Ok(strokes)
}
