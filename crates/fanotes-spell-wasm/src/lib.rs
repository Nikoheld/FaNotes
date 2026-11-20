//! Browser and Electron entry for the spelling core. It runs inside the spelling Web Worker
//! (`fanotes/src/lib/spellingWorker.ts`), never on the main thread.
//!
//! The state lives in one thread-local lexicon. Lists and filters go in as bytes, answers come
//! back as JSON strings or numbers.

use std::cell::RefCell;

use fanotes_spell::{
    decide_autocorrect as decide, parse_word_list, suggest_all, Bloom, Language, SpellLexicon,
    Suggestion,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

thread_local! {
    static LEXICON: RefCell<SpellLexicon> = RefCell::new(SpellLexicon::new());
}

fn language(code: &str) -> Result<Language, JsError> {
    Language::parse(code).ok_or_else(|| JsError::new("Unbekannte Sprache."))
}

#[derive(Serialize, Deserialize)]
struct SuggestionJson {
    word: String,
    distance: u8,
    score: i32,
    language: String,
}

fn to_json(suggestion: &Suggestion) -> SuggestionJson {
    SuggestionJson {
        word: suggestion.word.clone(),
        distance: suggestion.distance,
        score: suggestion.score,
        language: suggestion.language.code().to_string(),
    }
}

/// Validates and installs an exact word list. Returns the number of words.
#[wasm_bindgen(js_name = loadWords)]
pub fn load_words(
    language_code: &str,
    bytes: &[u8],
    expected_size: u32,
    expected_count: u32,
) -> Result<u32, JsError> {
    let language = language(language_code)?;
    let words = parse_word_list(
        bytes,
        language,
        expected_size as usize,
        expected_count as usize,
    )
    .map_err(|error| JsError::new(&error.to_string()))?;
    let count = words.len() as u32;
    LEXICON.with(|lexicon| lexicon.borrow_mut().set_words(language, words));
    Ok(count)
}

#[wasm_bindgen(js_name = loadBloom)]
pub fn load_bloom(
    language_code: &str,
    bytes: &[u8],
    bit_count: f64,
    hashes: u32,
) -> Result<(), JsError> {
    let language = language(language_code)?;
    let bloom = Bloom::new(bytes.to_vec(), bit_count as u64, hashes).map_err(JsError::new)?;
    LEXICON.with(|lexicon| lexicon.borrow_mut().set_bloom(language, bloom));
    Ok(())
}

/// Replaces the words the user vouched for. `json` is an array of normalised words.
#[wasm_bindgen(js_name = setUserWords)]
pub fn set_user_words(json: &str) -> Result<(), JsError> {
    let words: Vec<String> =
        serde_json::from_str(json).map_err(|error| JsError::new(&error.to_string()))?;
    LEXICON.with(|lexicon| lexicon.borrow_mut().set_user_words(words));
    Ok(())
}

/// Every correction candidate for `typed`, sorted by score (ties by an approximate collation).
/// `languages_json` is an array of language codes; the caller applies `limit` after re-sorting ties.
#[wasm_bindgen(js_name = suggestAll)]
pub fn suggest(typed: &str, languages_json: &str, max_distance: u8) -> Result<String, JsError> {
    let codes: Vec<String> =
        serde_json::from_str(languages_json).map_err(|error| JsError::new(&error.to_string()))?;
    let languages = codes
        .iter()
        .map(|code| language(code))
        .collect::<Result<Vec<_>, _>>()?;
    let results =
        LEXICON.with(|lexicon| suggest_all(typed, &languages, &*lexicon.borrow(), max_distance));
    let json: Vec<SuggestionJson> = results.iter().map(to_json).collect();
    serde_json::to_string(&json).map_err(|error| JsError::new(&error.to_string()))
}

/// Index of the suggestion that is safe to apply while typing, or -1.
#[wasm_bindgen(js_name = decideAutocorrect)]
pub fn decide_autocorrect(
    typed: &str,
    suggestions_json: &str,
    language_code: &str,
    sentence_start: bool,
    is_proper_name: bool,
) -> Result<i32, JsError> {
    let parsed: Vec<SuggestionJson> =
        serde_json::from_str(suggestions_json).map_err(|error| JsError::new(&error.to_string()))?;
    let suggestions = parsed
        .iter()
        .map(|item| {
            Ok(Suggestion {
                word: item.word.clone(),
                distance: item.distance,
                score: item.score,
                language: language(&item.language)?,
            })
        })
        .collect::<Result<Vec<_>, JsError>>()?;
    let context_language = Language::parse(language_code);
    Ok(decide(
        typed,
        &suggestions,
        context_language,
        sentence_start,
        is_proper_name,
    )
    .map_or(-1, |index| index as i32))
}

/// Builds the n-gram index of a loaded language (once). Returns the word count.
#[wasm_bindgen(js_name = buildContext)]
pub fn build_context(language_code: &str) -> Result<u32, JsError> {
    let language = language(language_code)?;
    LEXICON.with(|lexicon| {
        let mut lexicon = lexicon.borrow_mut();
        let index = lexicon
            .context(language)
            .ok_or_else(|| JsError::new("Die Wortliste ist nicht geladen."))?;
        Ok((1..=64)
            .map(|length| index.words_of_length(length).len() as u32)
            .sum())
    })
}

fn with_context<T>(
    language_code: &str,
    fallback: T,
    run: impl FnOnce(&fanotes_spell::NgramIndex) -> T,
) -> Result<T, JsError> {
    let language = language(language_code)?;
    LEXICON.with(|lexicon| {
        let mut lexicon = lexicon.borrow_mut();
        Ok(lexicon.context(language).map_or(fallback, run))
    })
}

/// The built index as one JSON object for a synchronous reader on another thread:
/// `{buckets: {"<length>": "w1\\nw2..."}, bigrams: [gram, count, ...], trigrams: [...],
/// prefixes: [gram, ...], suffixes: [gram, ...]}`. Words stay newline joined so the receiver
/// splits a bucket only when it needs it.
#[wasm_bindgen(js_name = contextSnapshot)]
pub fn context_snapshot(language_code: &str) -> Result<String, JsError> {
    let language = language(language_code)?;
    LEXICON.with(|lexicon| {
        let mut lexicon = lexicon.borrow_mut();
        let index = lexicon
            .context(language)
            .ok_or_else(|| JsError::new("Die Wortliste ist nicht geladen."))?;
        let snapshot = index.snapshot().map_err(JsError::new)?;
        let flat = |grams: &[(String, u32)]| -> Vec<serde_json::Value> {
            grams
                .iter()
                .flat_map(|(gram, count)| [gram.clone().into(), (*count).into()])
                .collect()
        };
        let buckets: serde_json::Map<String, serde_json::Value> = snapshot
            .buckets
            .iter()
            .map(|(length, words)| (length.to_string(), words.clone().into()))
            .collect();
        let value = serde_json::json!({
            "buckets": buckets,
            "bigrams": flat(&snapshot.bigrams),
            "trigrams": flat(&snapshot.trigrams),
            "prefixes": snapshot.prefixes,
            "suffixes": snapshot.suffixes,
        });
        serde_json::to_string(&value).map_err(|error| JsError::new(&error.to_string()))
    })
}

#[wasm_bindgen(js_name = contextIsExtendedWord)]
pub fn context_is_extended_word(language_code: &str, word: &str) -> Result<bool, JsError> {
    with_context(language_code, false, |index| index.is_extended_word(word))
}

#[wasm_bindgen(js_name = contextSequenceScore)]
pub fn context_sequence_score(language_code: &str, word: &str) -> Result<f64, JsError> {
    with_context(language_code, 0.0, |index| {
        index.character_sequence_score(word)
    })
}

#[wasm_bindgen(js_name = contextSubwordScore)]
pub fn context_subword_score(language_code: &str, word: &str) -> Result<f64, JsError> {
    with_context(language_code, 0.0, |index| {
        index.character_subword_score(word)
    })
}

#[wasm_bindgen(js_name = contextWordsOfLength)]
pub fn context_words_of_length(language_code: &str, length: u32) -> Result<String, JsError> {
    with_context(language_code, "[]".to_string(), |index| {
        serde_json::to_string(index.words_of_length(length as usize))
            .unwrap_or_else(|_| "[]".to_string())
    })
}

/// All dictionary words within `maximum_distance` edits as `[[word, distance], ...]`, ordered by
/// distance then code unit order. The caller applies the collation sort and the limit.
#[wasm_bindgen(js_name = contextNearest)]
pub fn context_nearest(
    language_code: &str,
    source: &str,
    maximum_distance: u32,
    same_length_only: bool,
) -> Result<String, JsError> {
    with_context(language_code, "[]".to_string(), |index| {
        serde_json::to_string(&index.nearest_all(
            source,
            maximum_distance as usize,
            same_length_only,
        ))
        .unwrap_or_else(|_| "[]".to_string())
    })
}

/// `normalizeWord` of `spelling.ts`, exposed for the parity check.
#[wasm_bindgen(js_name = normalizeWord)]
pub fn normalize_word(word: &str, language_code: &str) -> Result<String, JsError> {
    Ok(fanotes_spell::text::normalize_word(
        word,
        language(language_code)?,
    ))
}
