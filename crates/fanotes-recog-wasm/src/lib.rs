//! Browser and Electron entry for the shared handwriting recognition code.
//!
//! Loaded with the handwriting recognizer, not at application startup. The desktop sidecar runs
//! the model; this module groups and renders the ink, decodes the model output with the language
//! model and fits the personal classifier update.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use fanotes_recog::{
    beam_decode, ctc_loss_and_gradient, decode_ctc, fuse_recognition_model, group_ink_lines,
    ink_image, ink_span_boxes, line_tensor, BeamOptions, CharLm, FusionEntry, InkOptions, Language,
    Lexicon, LineBounds, LineOptions, LineStroke,
};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

thread_local! {
    static EXTRA_WORDS: RefCell<HashMap<String, HashSet<String>>> = RefCell::new(HashMap::new());
    static INK_LANGUAGE_MODELS: RefCell<HashMap<String, CharLm>> = RefCell::new(HashMap::new());
    static INK_LEXICONS: RefCell<HashMap<String, InkLexicon>> = RefCell::new(HashMap::new());
    /// Exact spelling lists. The Bloom filter is not safe for one-edit correction: a false
    /// positive becomes a "unique" neighbor and rewrites a real word.
    static INK_EXACT_WORDS: RefCell<HashMap<String, ExactWords>> = RefCell::new(HashMap::new());
}

struct ExactWords {
    /// The shipped word list, ß stored as ss.
    base: HashSet<String>,
    /// The writer's own words. Replaced as a whole, never merged into `base`, so a removed
    /// word stops counting and a word with ß matches the folded lookup.
    personal: HashSet<String>,
}

fn fold_word(word: &str) -> String {
    word.to_lowercase().replace('ß', "ss")
}

impl Lexicon for ExactWords {
    fn contains(&self, word: &str) -> bool {
        let folded = fold_word(word);
        self.base.contains(&folded) || self.personal.contains(&folded)
    }
}

/// The FaNotes spelling Bloom filter (`fanotes-spelling-bloom-v2`) plus personal words.
#[derive(Default)]
struct InkLexicon {
    bloom: Vec<u8>,
    bit_count: u32,
    personal: HashSet<String>,
}

fn bloom_hash(word: &[u16], seed: u32) -> u32 {
    word.iter().fold(seed, |hash, &unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
    })
}

impl Lexicon for InkLexicon {
    fn contains(&self, word: &str) -> bool {
        let folded = word.replace('ß', "ss");
        if self.personal.contains(&folded) {
            return true;
        }
        if self.bit_count == 0 {
            return false;
        }
        let units: Vec<u16> = folded.encode_utf16().collect();
        let first = bloom_hash(&units, 0x811c_9dc5);
        let second = bloom_hash(&units, 0x9e37_79b1) | 1;
        (0..8u32).all(|index| {
            let bit = first.wrapping_add(index.wrapping_mul(second)) % self.bit_count;
            self.bloom
                .get((bit >> 3) as usize)
                .is_some_and(|byte| byte & (1 << (bit & 7)) != 0)
        })
    }
}

fn unpack_ink(packed: &[f64]) -> Result<Vec<Vec<(f64, f64)>>, JsError> {
    let mut strokes = Vec::new();
    let mut index = 0;
    while index < packed.len() {
        let count = packed[index] as usize;
        index += 1;
        if index + count * 2 > packed.len() {
            return Err(JsError::new("Unvollständige Stiftdaten."));
        }
        strokes.push(
            packed[index..index + count * 2]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| (pair[0], pair[1]))
                .collect(),
        );
        index += count * 2;
    }
    Ok(strokes)
}

/// Packed strokes are `pointCount, x, y, x, y, …` per stroke in page pixels. Returns the lines
/// as JSON, top to bottom.
#[wasm_bindgen(js_name = inkGroupLines)]
pub fn ink_group_lines_js(packed: &[f64]) -> Result<String, JsError> {
    let strokes = unpack_ink(packed)?;
    serde_json::to_string(&group_ink_lines(&strokes))
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Writer-specific rendering: `NaN` keeps the default for a field.
fn ink_options(ref_height: f64, pen_width: f64, extra_shear: f64, scale: f64) -> InkOptions {
    let defaults = InkOptions::default();
    InkOptions {
        ref_height: if ref_height.is_finite() {
            ref_height.max(0.0)
        } else {
            0.0
        },
        pen_width: if pen_width.is_finite() {
            pen_width.clamp(1.0, 6.0)
        } else {
            defaults.pen_width
        },
        extra_shear: if extra_shear.is_finite() {
            extra_shear.clamp(-0.5, 0.5)
        } else {
            0.0
        },
        scale_jitter: if scale.is_finite() {
            scale.clamp(0.6, 1.2)
        } else {
            1.0
        },
        ..defaults
    }
}

/// `[width, height, …pixels]` of the model image (`1` paper, `0` ink), or empty without ink.
#[wasm_bindgen(js_name = inkLineImage)]
pub fn ink_line_image_js(
    packed: &[f64],
    ref_height: f64,
    pen_width: f64,
    extra_shear: f64,
    scale: f64,
) -> Result<Vec<f32>, JsError> {
    let strokes = unpack_ink(packed)?;
    let options = ink_options(ref_height, pen_width, extra_shear, scale);
    let Some(image) = ink_image(&strokes, &options) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(image.values.len() + 2);
    out.push(image.width as f32);
    out.push(image.height as f32);
    out.extend(image.values);
    Ok(out)
}

/// Page-space boxes `[minX, minY, maxX, maxY]` of the ink under each frame span
/// (`start, end` pairs). A span without ink gets `NaN`s.
#[wasm_bindgen(js_name = inkSpanBoxes)]
pub fn ink_span_boxes_js(
    packed: &[f64],
    ref_height: f64,
    pen_width: f64,
    extra_shear: f64,
    scale: f64,
    spans: &[u32],
) -> Result<Vec<f64>, JsError> {
    let strokes = unpack_ink(packed)?;
    let options = ink_options(ref_height, pen_width, extra_shear, scale);
    let spans: Vec<[u32; 2]> = spans.as_chunks::<2>().0.to_vec();
    let mut out = Vec::with_capacity(spans.len() * 4);
    for region in ink_span_boxes(&strokes, &options, &spans) {
        out.extend(region);
    }
    Ok(out)
}

/// CTC loss (nats) of `labels` under `[frames, classes]` logits; `+∞` when the line is too short.
#[wasm_bindgen(js_name = inkCtcLoss)]
pub fn ink_ctc_loss_js(logits: &[f32], classes: u32, labels: &[u32]) -> f64 {
    if classes == 0 || labels.is_empty() {
        return f64::INFINITY;
    }
    ctc_loss_and_gradient(logits, classes as usize, labels).map_or(f64::INFINITY, |(loss, _)| loss)
}

#[wasm_bindgen(js_name = setInkLanguageModel)]
pub fn set_ink_language_model(language: &str, bytes: &[u8]) -> Result<(), JsError> {
    let model = CharLm::parse(bytes).map_err(|error| JsError::new(&error.to_string()))?;
    INK_LANGUAGE_MODELS.with(|models| models.borrow_mut().insert(language.to_owned(), model));
    Ok(())
}

/// Installs the spelling Bloom filter of `language` as the decoder's word lexicon.
#[wasm_bindgen(js_name = setInkLexicon)]
pub fn set_ink_lexicon(language: &str, bloom: &[u8], bit_count: u32) -> Result<(), JsError> {
    if bit_count as usize > bloom.len() * 8 {
        return Err(JsError::new("Das Wörterbuch besitzt eine ungültige Länge."));
    }
    INK_LEXICONS.with(|lexicons| {
        let mut lexicons = lexicons.borrow_mut();
        let entry = lexicons.entry(language.to_owned()).or_default();
        entry.bloom = bloom.to_vec();
        entry.bit_count = bit_count;
    });
    Ok(())
}

/// Exact dictionary for one-edit correction (`de.words` / `en.words`), not the Bloom filter.
/// Personal words already stored for `language` stay known, so a writer's own word is not rewritten.
#[wasm_bindgen(js_name = setInkExactWords)]
pub fn set_ink_exact_words(language: &str, words: Vec<String>) {
    let base: HashSet<String> = words.into_iter().map(|word| fold_word(&word)).collect();
    let personal = INK_LEXICONS.with(|lexicons| {
        lexicons
            .borrow()
            .get(language)
            .map(|entry| entry.personal.clone())
            .unwrap_or_default()
    });
    INK_EXACT_WORDS.with(|exact| {
        exact
            .borrow_mut()
            .insert(language.to_owned(), ExactWords { base, personal });
    });
}

/// Replaces the personal vocabulary (lower-case words) of `language`.
#[wasm_bindgen(js_name = setInkPersonalWords)]
pub fn set_ink_personal_words(language: &str, words: Vec<String>) {
    let personal: HashSet<String> = words.into_iter().map(|word| fold_word(&word)).collect();
    INK_LEXICONS.with(|lexicons| {
        let mut lexicons = lexicons.borrow_mut();
        let entry = lexicons.entry(language.to_owned()).or_default();
        entry.personal = personal.clone();
    });
    INK_EXACT_WORDS.with(|exact| {
        if let Some(known) = exact.borrow_mut().get_mut(language) {
            known.personal = personal;
        }
    });
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DecodeOptionsInput {
    beam_width: Option<usize>,
    lm_weight: Option<f64>,
    word_bonus: Option<f64>,
    unknown_word_penalty: Option<f64>,
    insertion_bonus: Option<f64>,
    n_best: Option<usize>,
    use_language_model: Option<bool>,
}

/// Decodes `[frames, classes]` logits with the language model and lexicon of `language`.
#[wasm_bindgen(js_name = inkDecode)]
pub fn ink_decode_js(
    logits: &[f32],
    classes: u32,
    alphabet: &str,
    language: &str,
    options_json: &str,
) -> Result<String, JsError> {
    let input: DecodeOptionsInput = if options_json.is_empty() {
        DecodeOptionsInput::default()
    } else {
        serde_json::from_str(options_json).map_err(|error| JsError::new(&error.to_string()))?
    };
    let defaults = BeamOptions::default();
    let options = BeamOptions {
        beam_width: input.beam_width.unwrap_or(defaults.beam_width).clamp(1, 64),
        lm_weight: input.lm_weight.unwrap_or(defaults.lm_weight),
        word_bonus: input.word_bonus.unwrap_or(defaults.word_bonus),
        unknown_word_penalty: input
            .unknown_word_penalty
            .unwrap_or(defaults.unknown_word_penalty),
        insertion_bonus: input.insertion_bonus.unwrap_or(defaults.insertion_bonus),
        n_best: input.n_best.unwrap_or(defaults.n_best).clamp(1, 12),
        ..defaults
    };
    let alphabet: Vec<char> = alphabet.chars().collect();
    let decoded = INK_EXACT_WORDS.with(|exact| {
        INK_LANGUAGE_MODELS.with(|models| {
            INK_LEXICONS.with(|lexicons| {
                let exact = exact.borrow();
                let models = models.borrow();
                let lexicons = lexicons.borrow();
                let lm = if input.use_language_model == Some(false) {
                    None
                } else {
                    models.get(language)
                };
                let empty = InkLexicon::default();
                let lexicon = lexicons.get(language).unwrap_or(&empty);
                let dictionary = exact.get(language).map(|words| words as &dyn Lexicon);
                beam_decode(
                    logits,
                    classes as usize,
                    &alphabet,
                    lm,
                    lexicon,
                    dictionary,
                    &options,
                )
            })
        })
    });
    let decoded =
        decoded.ok_or_else(|| JsError::new("Die Modellausgabe passt nicht zum Zeichensatz."))?;
    serde_json::to_string(&decoded).map_err(|error| JsError::new(&error.to_string()))
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

/// Personal prototype fusion for entries that already have features. The TypeScript builder
/// stays available; callers switch only after the published model matches.
#[wasm_bindgen(js_name = fuseRecognitionModel)]
pub fn fuse_recognition_model_js(payload: &str) -> Result<String, JsError> {
    let entries: Vec<FusionEntry> =
        serde_json::from_str(payload).map_err(|error| JsError::new(&error.to_string()))?;
    let fused = fuse_recognition_model(&entries);
    serde_json::to_string(&fused).map_err(|error| JsError::new(&error.to_string()))
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

#[cfg(test)]
mod tests {
    use super::{fold_word, ExactWords, Lexicon};

    #[test]
    fn a_personal_word_with_eszett_is_known_and_a_removed_word_is_not() {
        let mut known = ExactWords {
            base: ["personen".to_owned()].into_iter().collect(),
            personal: [fold_word("Straße"), fold_word("Chudleigh")]
                .into_iter()
                .collect(),
        };
        assert!(known.contains("strasse"));
        assert!(known.contains("Straße"));
        assert!(known.contains("chudleigh"));
        assert!(known.contains("personen"));
        known.personal = [fold_word("Chudleigh")].into_iter().collect();
        assert!(!known.contains("straße"));
        assert!(known.contains("chudleigh"));
        assert!(known.contains("personen"));
    }
}
