//! CTC decode for a PyLaia line, ported from `decodeCtc` in `neuralTextRecognition.ts`.
//!
//! Lexical polish (`applyNeuralWordContext`) stays in TypeScript. This returns the greedy text
//! after the CTC word rescore, the raw beam text, and the per-character runs. Desktop and web both
//! call it, then apply the same polish.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::language::{lexicon, Language};

const BEAM_WIDTH: usize = 8;
const BEAM_TOP_K: usize = 5;
const LANGUAGE_WEIGHT: f64 = 0.42;
const INSERTION_BONUS: f64 = 0.04;
const PROBABILITY_FLOOR: f64 = 1e-12;

const PUNCTUATION: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const GERMAN_LETTERS: &str = "ÄÖÜäöü";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CtcRun {
    pub char: String,
    pub confidence: i32,
    pub start: f64,
    pub end: f64,
}

/// The CTC result before `applyNeuralWordContext`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CtcDecoded {
    pub raw_text: String,
    /// Beam text before lexical polish. Empty when the greedy text is shorter than 3 characters,
    /// which is when the TypeScript decoder skips the beam.
    pub raw_beam_text: String,
    /// Greedy text after the CTC word rescore, before lexical polish.
    pub ctc_greedy_text: String,
    pub confidence: i32,
    pub characters: Vec<CtcRun>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError;

impl std::fmt::Display for DecodeError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("Das Handschriftmodell hat ein unerwartetes Ergebnis geliefert.")
    }
}

pub fn decode_ctc(
    probabilities: &[f32],
    time_steps: usize,
    classes: usize,
    characters: &[String],
    language: Language,
    extra_words: &HashSet<String>,
) -> Result<CtcDecoded, DecodeError> {
    if time_steps == 0
        || classes != characters.len() + 1
        || probabilities.len() != time_steps * classes
    {
        return Err(DecodeError);
    }
    let allowed = allowed_indexes(characters, language);
    let mut output = Vec::new();
    let mut confidences = Vec::new();
    let mut path = Vec::with_capacity(time_steps);
    let mut previous = -1i32;
    for step in 0..time_steps {
        let offset = step * classes;
        let mut best_index = 0usize;
        let mut best_probability = f64::from(probabilities[offset]);
        for &index in &allowed {
            let probability = f64::from(probabilities[offset + index]);
            if probability > best_probability {
                best_index = index;
                best_probability = probability;
            }
        }
        if best_index != 0 && best_index as i32 != previous {
            output.push(characters[best_index - 1].clone());
            confidences.push(best_probability);
        }
        path.push(best_index);
        previous = best_index as i32;
    }
    let raw_text = surface(&normalize_sharp_s(&output.join("")));
    let runs = character_runs(&path, probabilities, classes, time_steps, characters);
    let raw_beam_text = if raw_text.chars().count() >= 3 {
        decode_beam(
            probabilities,
            time_steps,
            classes,
            &allowed,
            characters,
            language,
            extra_words,
        )
    } else {
        String::new()
    };
    let ctc_greedy_text = apply_ctc_word_context(
        &raw_text,
        probabilities,
        classes,
        &path,
        characters,
        language,
    );
    let confidence = if confidences.is_empty() {
        0
    } else {
        js_round(confidences.iter().sum::<f64>() / confidences.len() as f64 * 100.0)
    };
    Ok(CtcDecoded {
        raw_text,
        raw_beam_text,
        ctc_greedy_text,
        confidence,
        characters: runs,
    })
}

fn allowed_indexes(characters: &[String], language: Language) -> Vec<usize> {
    characters
        .iter()
        .enumerate()
        .filter_map(|(index, character)| {
            allowed_character(character, language).then_some(index + 1)
        })
        .collect()
}

fn allowed_character(character: &str, language: Language) -> bool {
    let mut chars = character.chars();
    let Some(ch) = chars.next() else { return false };
    if chars.next().is_some() {
        return false;
    }
    ch.is_ascii_alphanumeric()
        || PUNCTUATION.contains(ch)
        || ch == ' '
        || (matches!(language, Language::De) && GERMAN_LETTERS.contains(ch))
}

fn character_runs(
    path: &[usize],
    probabilities: &[f32],
    classes: usize,
    time_steps: usize,
    characters: &[String],
) -> Vec<CtcRun> {
    let mut runs = Vec::new();
    let mut start = 0;
    while start < path.len() {
        let index = path[start];
        let mut end = start + 1;
        while end < path.len() && path[end] == index {
            end += 1;
        }
        if index != 0 {
            let mut peak = 0.0f64;
            for step in start..end {
                peak = peak.max(f64::from(probabilities[step * classes + index]));
            }
            runs.push(CtcRun {
                char: characters[index - 1].clone(),
                confidence: js_round(peak * 100.0),
                start: start as f64 / time_steps as f64,
                end: end as f64 / time_steps as f64,
            });
        }
        start = end;
    }
    runs
}

fn apply_ctc_word_context(
    text: &str,
    probabilities: &[f32],
    classes: usize,
    path: &[usize],
    characters: &[String],
    language: Language,
) -> String {
    let words = lexicon(language).words;
    let mut character_indexes = HashMap::new();
    for (index, character) in characters.iter().enumerate() {
        character_indexes.insert(character.clone(), index + 1);
    }
    let spans = ctc_word_spans(path, characters);
    let mut span_index = 0;
    replace_words(text, language, |source| {
        let span = spans.get(span_index);
        span_index += 1;
        let Some(span) = span else {
            return source.to_owned();
        };
        let locale_source = locale_lower(source, language);
        if locale_lower(&span.source, language) != locale_source {
            return source.to_owned();
        }
        if words.iter().any(|word| *word == locale_source) || locale_source.chars().count() < 3 {
            return source.to_owned();
        }
        let maximum_distance = if locale_source.chars().count() >= 4 {
            2
        } else {
            1
        };
        let source_indexes: Vec<i32> = locale_source
            .chars()
            .map(|ch| {
                character_indexes
                    .get(&ch.to_string())
                    .copied()
                    .map(|index| index as i32)
                    .unwrap_or(-1)
            })
            .collect();
        if source_indexes.contains(&-1) {
            return source.to_owned();
        }
        let source_score = ctc_word_score(
            probabilities,
            classes,
            span.start,
            span.end,
            &source_indexes,
        );
        let mut candidates: Vec<(String, usize, f64)> = words
            .iter()
            .filter(|candidate| {
                candidate
                    .chars()
                    .count()
                    .abs_diff(locale_source.chars().count())
                    <= maximum_distance
            })
            .filter_map(|candidate| {
                let distance = word_distance(&locale_source, candidate);
                if distance > maximum_distance
                    || candidate
                        .chars()
                        .any(|ch| !character_indexes.contains_key(&ch.to_string()))
                {
                    return None;
                }
                let indexes: Vec<i32> = candidate
                    .chars()
                    .map(|ch| character_indexes[&ch.to_string()] as i32)
                    .collect();
                Some((
                    (*candidate).to_owned(),
                    distance,
                    ctc_word_score(probabilities, classes, span.start, span.end, &indexes),
                ))
            })
            .collect();
        candidates.sort_by(|first, second| {
            second
                .2
                .partial_cmp(&first.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(first.1.cmp(&second.1))
        });
        let best = candidates.first();
        let runner_up = candidates.get(1);
        let visual_allowance = match best {
            Some((_, 2, _)) if locale_source.chars().count() <= 5 => 1.5,
            Some((_, 2, _)) => (5.8f64).max(locale_source.chars().count() as f64 * 0.8),
            Some(_) => (8.0f64).max(locale_source.chars().count() as f64 * 1.4),
            None => return source.to_owned(),
        };
        if best.is_none_or(|(_, _, score)| *score < source_score - visual_allowance)
            || runner_up.is_some_and(|(_, _, score)| best.unwrap().2 - score < 0.5)
        {
            return source.to_owned();
        }
        preserve_word_case(source, &best.unwrap().0, language)
    })
}

struct WordSpan {
    source: String,
    start: usize,
    end: usize,
}

fn ctc_word_spans(path: &[usize], characters: &[String]) -> Vec<WordSpan> {
    let mut spans = Vec::new();
    let mut source = String::new();
    let mut start = 0usize;
    let mut previous = -1i32;
    let flush = |spans: &mut Vec<WordSpan>, source: &mut String, start: usize, end: usize| {
        if !source.is_empty() {
            spans.push(WordSpan {
                source: source.clone(),
                start,
                end,
            });
        }
        source.clear();
    };
    for (step, &index) in path.iter().enumerate() {
        if index == 0 || index as i32 == previous {
            previous = index as i32;
            continue;
        }
        let character = &characters[index - 1];
        if is_one_letter(character) {
            source.push_str(character);
        } else {
            flush(&mut spans, &mut source, start, step);
            start = step + 1;
        }
        previous = index as i32;
    }
    flush(&mut spans, &mut source, start, path.len());
    spans
}

fn ctc_word_score(
    probabilities: &[f32],
    classes: usize,
    start: usize,
    end: usize,
    indexes: &[i32],
) -> f64 {
    let steps = end.saturating_sub(start);
    if indexes.is_empty() || steps < indexes.len() {
        return f64::NEG_INFINITY;
    }
    let states = indexes.len() * 2 + 1;
    let labels: Vec<usize> = (0..states)
        .map(|index| {
            if index % 2 == 0 {
                0
            } else {
                indexes[(index - 1) / 2] as usize
            }
        })
        .collect();
    let mut previous = vec![f64::NEG_INFINITY; states];
    let first_offset = start * classes;
    previous[0] = f64::from(probabilities[first_offset])
        .max(PROBABILITY_FLOOR)
        .ln();
    previous[1] = f64::from(probabilities[first_offset + labels[1]])
        .max(PROBABILITY_FLOOR)
        .ln();
    for step in start + 1..end {
        let mut current = vec![f64::NEG_INFINITY; states];
        let offset = step * classes;
        for state in 0..states {
            let mut transitions = vec![previous[state]];
            if state > 0 {
                transitions.push(previous[state - 1]);
            }
            if state > 1 && labels[state] != 0 && labels[state] != labels[state - 2] {
                transitions.push(previous[state - 2]);
            }
            current[state] = log_add(&transitions)
                + f64::from(probabilities[offset + labels[state]])
                    .max(PROBABILITY_FLOOR)
                    .ln();
        }
        previous = current;
    }
    log_add(&[previous[states - 1], previous[states - 2]])
}

struct BeamState {
    prefix: String,
    blank: f64,
    nonblank: f64,
    language_score: f64,
    character_count: i32,
}

fn decode_beam(
    probabilities: &[f32],
    time_steps: usize,
    classes: usize,
    allowed: &[usize],
    characters: &[String],
    language: Language,
    extra_words: &HashSet<String>,
) -> String {
    let mut order = vec![String::new()];
    let mut states = HashMap::from([(
        String::new(),
        BeamState {
            prefix: String::new(),
            blank: 0.0,
            nonblank: f64::NEG_INFINITY,
            language_score: 0.0,
            character_count: 0,
        },
    )]);
    for step in 0..time_steps {
        let offset = step * classes;
        let candidates = top_indexes(probabilities, offset, allowed);
        let blank_log = f64::from(probabilities[offset]).max(PROBABILITY_FLOOR).ln();
        let mut next_order = Vec::new();
        let mut next_states: HashMap<String, BeamState> = HashMap::new();
        let ensure = |prefix: String,
                      language_score: f64,
                      character_count: i32,
                      next_order: &mut Vec<String>,
                      next_states: &mut HashMap<String, BeamState>| {
            next_states.entry(prefix.clone()).or_insert_with(|| {
                next_order.push(prefix.clone());
                BeamState {
                    prefix,
                    blank: f64::NEG_INFINITY,
                    nonblank: f64::NEG_INFINITY,
                    language_score,
                    character_count,
                }
            });
        };
        for prefix in &order {
            let state = &states[prefix];
            let total = log_add(&[state.blank, state.nonblank]);
            let last = last_char(&state.prefix);
            ensure(
                state.prefix.clone(),
                state.language_score,
                state.character_count,
                &mut next_order,
                &mut next_states,
            );
            {
                let same = next_states.get_mut(&state.prefix).expect("just inserted");
                same.blank = log_add(&[same.blank, total + blank_log]);
            }
            for (index, probability) in &candidates {
                let character = &characters[index - 1];
                let character_log = probability.max(PROBABILITY_FLOOR).ln();
                let mut source = total;
                if Some(character.as_str()) == last.as_deref() {
                    let same = next_states.get_mut(&state.prefix).expect("same prefix");
                    same.nonblank = log_add(&[same.nonblank, state.nonblank + character_log]);
                    source = state.blank;
                }
                if !source.is_finite() {
                    continue;
                }
                let extended_prefix = format!("{}{character}", state.prefix);
                let language_score = state.language_score
                    + beam_extension_language_delta(
                        &state.prefix,
                        character,
                        language,
                        extra_words,
                    );
                let character_count = state.character_count + i32::from(!is_whitespace(character));
                ensure(
                    extended_prefix.clone(),
                    language_score,
                    character_count,
                    &mut next_order,
                    &mut next_states,
                );
                let extended = next_states
                    .get_mut(&extended_prefix)
                    .expect("just inserted");
                extended.nonblank = log_add(&[extended.nonblank, source + character_log]);
            }
        }
        next_order.sort_by(|first, second| {
            beam_score(&next_states[second], false, language, extra_words)
                .partial_cmp(&beam_score(
                    &next_states[first],
                    false,
                    language,
                    extra_words,
                ))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        next_order.truncate(BEAM_WIDTH);
        states = next_order
            .iter()
            .map(|prefix| (prefix.clone(), next_states.remove(prefix).expect("kept")))
            .collect();
        order = next_order;
    }
    let best = order.into_iter().max_by(|first, second| {
        beam_score(&states[first], true, language, extra_words)
            .partial_cmp(&beam_score(&states[second], true, language, extra_words))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    best.map(|prefix| surface(&states[&prefix].prefix))
        .unwrap_or_default()
}

fn top_indexes(probabilities: &[f32], offset: usize, allowed: &[usize]) -> Vec<(usize, f64)> {
    let mut top: Vec<(usize, f64)> = Vec::new();
    for &index in allowed {
        let probability = f64::from(probabilities[offset + index]);
        if top.len() == BEAM_TOP_K && probability <= top.last().expect("full").1 {
            continue;
        }
        let insertion = top
            .iter()
            .position(|(_, current)| probability > *current)
            .unwrap_or(top.len());
        top.insert(insertion, (index, probability));
        if top.len() > BEAM_TOP_K {
            top.pop();
        }
    }
    top
}

fn beam_score(
    state: &BeamState,
    final_step: bool,
    language: Language,
    extra: &HashSet<String>,
) -> f64 {
    let completed = if final_step {
        state.language_score
            + beam_word_completion_score(&trailing_beam_word(&state.prefix), language, extra)
    } else {
        state.language_score
    };
    log_add(&[state.blank, state.nonblank])
        + LANGUAGE_WEIGHT * completed
        + INSERTION_BONUS * f64::from(state.character_count)
}

fn beam_word_completion_score(word: &str, language: Language, extra: &HashSet<String>) -> f64 {
    if word.is_empty() {
        return 0.0;
    }
    let lower = locale_lower(word, language);
    let length = lower.chars().count();
    if lexicon(language).words.iter().any(|entry| *entry == lower)
        || word_membership(&lower, language, extra)
    {
        return 1.25 + (length as f64 * 0.09).min(1.1);
    }
    if length == 1 && (lower == "a" || lower == "i") {
        return 0.65;
    }
    -(0.08 + length as f64 * 0.025).min(0.42)
}

fn word_membership(lower: &str, language: Language, extra: &HashSet<String>) -> bool {
    let normalized = normalize_membership(lower, language);
    let letters = normalized.chars().count();
    (3..=32).contains(&letters)
        && normalized.chars().all(char::is_alphabetic)
        && extra.contains(normalized.as_str())
}

fn normalize_membership(word: &str, language: Language) -> String {
    let lowered = match language {
        Language::De => locale_lower(word, Language::De),
        Language::En => locale_lower(word, Language::En),
    };
    let trimmed = trim_matches(&lowered, |ch| matches!(ch, '\'' | '’' | '-'));
    if matches!(language, Language::De) {
        trimmed.replace('ß', "ss")
    } else {
        trimmed
    }
}

fn beam_extension_language_delta(
    prefix: &str,
    character: &str,
    language: Language,
    extra: &HashSet<String>,
) -> f64 {
    let mut delta = 0.0;
    if is_one_letter(character) {
        let mut letters: String = prefix
            .chars()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .filter(|ch| ch.is_alphabetic())
            .collect();
        if let Some(ch) = character.chars().next().filter(|ch| ch.is_alphabetic()) {
            letters.push(ch);
        }
        let letters = locale_lower(&letters, language);
        let count = letters.chars().count();
        if count >= 2 {
            let bigram: String = letters.chars().skip(count - 2).collect();
            delta += if lexicon(language).bigrams.contains(&bigram.as_str()) {
                0.1
            } else {
                -0.025
            };
        }
        if count >= 3 {
            let trigram: String = letters.chars().skip(count - 3).collect();
            delta += if lexicon(language).trigrams.contains(&trigram.as_str()) {
                0.17
            } else {
                -0.02
            };
        }
    } else if is_whitespace(character) || is_sentence_punctuation(character) {
        delta += beam_word_completion_score(&trailing_beam_word(prefix), language, extra);
        if is_whitespace(character)
            && (prefix.is_empty() || prefix.chars().next_back().is_some_and(char::is_whitespace))
        {
            delta -= 1.2;
        }
        if is_sentence_punctuation(character) && prefix.ends_with(character) {
            delta -= 0.8;
        }
    }
    delta
}

fn trailing_beam_word(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut index = chars.len();
    while index > 0 && chars[index - 1].is_alphabetic() {
        index -= 1;
    }
    if index == chars.len() {
        return String::new();
    }
    let mut start = index;
    if start > 0 && chars[start - 1] == '\'' {
        let mut before = start - 1;
        while before > 0 && chars[before - 1].is_alphabetic() {
            before -= 1;
        }
        if before < start - 1 {
            start = before;
        }
    }
    chars[start..].iter().collect()
}

fn log_add(values: &[f64]) -> f64 {
    let mut maximum = f64::NEG_INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if *value > maximum {
            maximum = *value;
        }
    }
    if !maximum.is_finite() {
        return f64::NEG_INFINITY;
    }
    maximum
        + values
            .iter()
            .map(|value| (value - maximum).exp())
            .sum::<f64>()
            .ln()
}

fn word_distance(first: &str, second: &str) -> usize {
    let first: Vec<char> = first.chars().collect();
    let second: Vec<char> = second.chars().collect();
    let mut previous: Vec<usize> = (0..=second.len()).collect();
    let mut current = vec![0; second.len() + 1];
    for (first_index, first_char) in first.iter().enumerate() {
        current[0] = first_index + 1;
        for (second_index, second_char) in second.iter().enumerate() {
            let substitution = previous[second_index] + usize::from(first_char != second_char);
            current[second_index + 1] = (previous[second_index + 1] + 1)
                .min(current[second_index] + 1)
                .min(substitution);
        }
        previous.copy_from_slice(&current);
    }
    previous[second.len()]
}

fn preserve_word_case(source: &str, replacement: &str, language: Language) -> String {
    if source == locale_upper(source, language) {
        return locale_upper(replacement, language);
    }
    let Some(first) = source.chars().next() else {
        return replacement.to_owned();
    };
    if source.starts_with(locale_upper(&first.to_string(), language).as_str()) {
        let mut chars = replacement.chars();
        let Some(replacement_first) = chars.next() else {
            return String::new();
        };
        let mut out = locale_upper(&replacement_first.to_string(), language);
        out.push_str(chars.as_str());
        return out;
    }
    replacement.to_owned()
}

fn replace_words(
    text: &str,
    language: Language,
    mut replace: impl FnMut(&str) -> String,
) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if word_char(chars[index], language) {
            let start = index;
            while index < chars.len() && word_char(chars[index], language) {
                index += 1;
            }
            if index - start >= 2 {
                let word: String = chars[start..index].iter().collect();
                out.push_str(&replace(&word));
                continue;
            }
            out.extend(chars[start..index].iter());
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

fn word_char(ch: char, language: Language) -> bool {
    match language {
        Language::De => ch.is_ascii_alphabetic() || GERMAN_LETTERS.contains(ch),
        Language::En => ch.is_ascii_alphabetic(),
    }
}

fn surface(text: &str) -> String {
    let normalized: String = text.nfc().collect();
    let mut collapsed = String::new();
    let mut space_run = 0usize;
    for ch in normalized.chars() {
        if ch == ' ' || ch == '\t' {
            space_run += 1;
            if space_run == 1 {
                collapsed.push(' ');
            }
        } else {
            space_run = 0;
            collapsed.push(ch);
        }
    }
    let chars: Vec<char> = collapsed.chars().collect();
    let mut spaced = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_whitespace() {
            let start = index;
            while index < chars.len() && chars[index].is_whitespace() {
                index += 1;
            }
            if index < chars.len() && ",.;:!?".contains(chars[index]) {
                continue;
            }
            spaced.extend(chars[start..index].iter());
        } else {
            spaced.push(chars[index]);
            index += 1;
        }
    }
    spaced.trim_matches(char::is_whitespace).to_owned()
}

fn normalize_sharp_s(text: &str) -> String {
    text.replace('ẞ', "SS").replace('ß', "ss")
}

fn locale_lower(text: &str, language: Language) -> String {
    match language {
        Language::De | Language::En => text.chars().flat_map(char::to_lowercase).collect(),
    }
}

fn locale_upper(text: &str, language: Language) -> String {
    match language {
        Language::De | Language::En => text
            .chars()
            .flat_map(|ch| {
                if ch == 'ß' {
                    vec!['S', 'S']
                } else {
                    ch.to_uppercase().collect::<Vec<_>>()
                }
            })
            .collect(),
    }
}

fn trim_matches(text: &str, drop: impl Fn(char) -> bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut start = 0;
    let mut end = chars.len();
    while start < end && drop(chars[start]) {
        start += 1;
    }
    while end > start && drop(chars[end - 1]) {
        end -= 1;
    }
    chars[start..end].iter().collect()
}

fn last_char(text: &str) -> Option<String> {
    text.chars().next_back().map(|ch| ch.to_string())
}

fn is_one_letter(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(char::is_alphabetic) && chars.next().is_none()
}

fn is_whitespace(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(char::is_whitespace) && chars.next().is_none()
}

fn is_sentence_punctuation(text: &str) -> bool {
    matches!(text, "," | "." | ";" | ":" | "!" | "?")
}

fn js_round(value: f64) -> i32 {
    value.floor() as i32 + i32::from(value - value.floor() >= 0.5)
}
