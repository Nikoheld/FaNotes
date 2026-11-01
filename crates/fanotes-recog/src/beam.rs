//! CTC prefix beam search for the ink recognizer.
//!
//! The visual posteriors come from the line model; a character n-gram model and a word lexicon
//! re-rank prefixes while they grow, so a correct word that the pen trace only half shows can
//! still win over a visually similar non-word. The best reading is then force-aligned to the
//! frames to give every character its span, confidence and visual alternatives.

use std::collections::HashMap;

use serde::Serialize;

use crate::charlm::CharLm;

/// Decides whether a lower-case word is known (dictionary, personal vocabulary).
pub trait Lexicon {
    fn contains(&self, word: &str) -> bool;
}

impl Lexicon for () {
    fn contains(&self, _word: &str) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BeamOptions {
    pub beam_width: usize,
    /// Weight of the character language model cost.
    pub lm_weight: f64,
    /// Added once per completed word found in the lexicon.
    pub word_bonus: f64,
    /// Added once per completed word of two or more letters not in the lexicon.
    pub unknown_word_penalty: f64,
    /// Added per emitted character; counters the language model's bias to short readings.
    pub insertion_bonus: f64,
    /// Candidate characters per frame are those within this many nats of the frame maximum.
    pub prune_margin: f64,
    pub max_candidates: usize,
    pub n_best: usize,
    /// When a runner-up is within this many nats and closer to the raw trace, use it.
    pub trace_margin: f64,
}

impl Default for BeamOptions {
    fn default() -> Self {
        Self {
            beam_width: 16,
            lm_weight: 0.55,
            word_bonus: 1.2,
            unknown_word_penalty: -0.4,
            insertion_bonus: 0.6,
            prune_margin: 9.0,
            max_candidates: 8,
            n_best: 5,
            trace_margin: 0.2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharAlternative {
    pub char: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedChar {
    pub char: String,
    /// Posterior of this character at its strongest frame, `0..=1`.
    pub confidence: f32,
    pub start_frame: u32,
    pub end_frame: u32,
    pub alternatives: Vec<CharAlternative>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub text: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeamDecoded {
    pub text: String,
    pub greedy_text: String,
    /// Mean character confidence of `text`, `0..=1`.
    pub confidence: f32,
    pub characters: Vec<DecodedChar>,
    /// Distinct readings, best first; the first equals `text`.
    pub readings: Vec<Reading>,
    pub frames: u32,
    pub known_words: u32,
    pub words: u32,
}

const NEG_INF: f64 = f64::NEG_INFINITY;

fn log_add(a: f64, b: f64) -> f64 {
    if a == NEG_INF {
        return b;
    }
    if b == NEG_INF {
        return a;
    }
    let (high, low) = if a > b { (a, b) } else { (b, a) };
    high + (low - high).exp().ln_1p()
}

#[derive(Debug, Clone)]
struct Beam {
    blank: f64,
    other: f64,
}

impl Beam {
    fn total(&self) -> f64 {
        log_add(self.blank, self.other)
    }
}

/// Row-wise log-softmax of `[frames, classes]` logits.
pub fn log_softmax(logits: &[f32], classes: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(logits.len());
    for row in logits.chunks_exact(classes) {
        let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max) as f64;
        let sum: f64 = row.iter().map(|&v| (v as f64 - max).exp()).sum();
        let log_sum = sum.ln() + max;
        out.extend(row.iter().map(|&v| v as f64 - log_sum));
    }
    out
}

struct Words<'a> {
    alphabet: &'a [char],
    lexicon: &'a dyn Lexicon,
}

impl Words<'_> {
    fn is_letter(&self, symbol: u8) -> bool {
        symbol != 0 && self.alphabet[usize::from(symbol) - 1].is_alphabetic()
    }

    fn sentence_mark(&self, symbol: u8) -> bool {
        symbol != 0
            && matches!(
                self.alphabet[usize::from(symbol) - 1],
                '.' | ',' | ';' | ':' | '!' | '?'
            )
    }

    /// Lexicon verdict for the trailing letter run of `prefix`: `Some(true)` known,
    /// `Some(false)` unknown, `None` when there is no word of at least two letters.
    fn trailing_word(&self, prefix: &[u8]) -> Option<bool> {
        let start = prefix
            .iter()
            .rposition(|&symbol| !self.is_letter(symbol))
            .map_or(0, |index| index + 1);
        let letters = &prefix[start..];
        if letters.len() < 2 {
            return None;
        }
        let word: String = letters
            .iter()
            .map(|&symbol| self.alphabet[usize::from(symbol) - 1])
            .collect();
        let lower = word.to_lowercase();
        Some(self.lexicon.contains(&lower))
    }
}

fn word_score(verdict: Option<bool>, options: &BeamOptions) -> f64 {
    match verdict {
        Some(true) => options.word_bonus,
        Some(false) => options.unknown_word_penalty,
        None => 0.0,
    }
}

/// Decodes `[frames, classes]` logits (class `0` is the CTC blank, class `i` is
/// `alphabet[i - 1]`).
pub fn beam_decode(
    logits: &[f32],
    classes: usize,
    alphabet: &[char],
    lm: Option<&CharLm>,
    lexicon: &dyn Lexicon,
    dictionary: Option<&dyn Lexicon>,
    options: &BeamOptions,
) -> Option<BeamDecoded> {
    if classes != alphabet.len() + 1
        || logits.is_empty()
        || !logits.len().is_multiple_of(classes)
        || classes > 255
    {
        return None;
    }
    if let Some(model) = lm {
        if model.alphabet() != alphabet {
            return None;
        }
    }
    let frames = logits.len() / classes;
    let log_probs = log_softmax(logits, classes);
    let words = Words { alphabet, lexicon };
    let history_length = lm.map_or(0, |model| model.order() - 1);

    let mut beams: HashMap<Vec<u8>, Beam> = HashMap::new();
    beams.insert(
        Vec::new(),
        Beam {
            blank: 0.0,
            other: NEG_INF,
        },
    );
    let mut lm_cache: HashMap<(Vec<u8>, u8), f64> = HashMap::new();

    for frame in 0..frames {
        let row = &log_probs[frame * classes..(frame + 1) * classes];
        let best = row.iter().copied().fold(NEG_INF, f64::max);
        let mut candidates: Vec<usize> = (1..classes)
            .filter(|&class| row[class] >= best - options.prune_margin)
            .collect();
        candidates.sort_by(|&a, &b| row[b].total_cmp(&row[a]));
        candidates.truncate(options.max_candidates);

        let mut next: HashMap<Vec<u8>, Beam> =
            HashMap::with_capacity(beams.len() * (candidates.len() + 1));
        for (prefix, beam) in &beams {
            let total = beam.total();
            let stay = next.entry(prefix.clone()).or_insert(Beam {
                blank: NEG_INF,
                other: NEG_INF,
            });
            stay.blank = log_add(stay.blank, total + row[0]);
            if let Some(&last) = prefix.last() {
                stay.other = log_add(stay.other, beam.other + row[usize::from(last)]);
            }
            for &class in &candidates {
                let symbol = class as u8;
                let mut extension = row[class] + options.insertion_bonus;
                if let Some(model) = lm {
                    let take = prefix.len().min(history_length);
                    let mut history = Vec::with_capacity(history_length);
                    if take < history_length {
                        history.push(0);
                    }
                    history.extend_from_slice(&prefix[prefix.len() - take..]);
                    let cost = *lm_cache.entry((history, symbol)).or_insert_with_key(
                        |(history, symbol)| f64::from(model.cost(history, *symbol)),
                    );
                    extension -= options.lm_weight * cost;
                }
                if !words.is_letter(symbol)
                    && prefix.last().is_some_and(|&last| words.is_letter(last))
                {
                    extension += word_score(words.trailing_word(prefix), options);
                }
                let mut grown = prefix.clone();
                grown.push(symbol);
                let target = next.entry(grown).or_insert(Beam {
                    blank: NEG_INF,
                    other: NEG_INF,
                });
                let source = if prefix.last() == Some(&symbol) {
                    beam.blank
                } else {
                    total
                };
                target.other = log_add(target.other, source + extension);
            }
        }
        let mut ranked: Vec<(Vec<u8>, Beam)> = next.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total().total_cmp(&a.1.total()));
        ranked.truncate(options.beam_width);
        beams = ranked.into_iter().collect();
    }

    let mut finals: Vec<(Vec<u8>, f64)> = beams
        .into_iter()
        .map(|(prefix, beam)| {
            let closing = if prefix.last().is_some_and(|&last| words.is_letter(last)) {
                word_score(words.trailing_word(&prefix), options)
            } else {
                0.0
            };
            (prefix, beam.total() + closing)
        })
        .collect();
    finals.sort_by(|a, b| b.1.total_cmp(&a.1));
    let render = |symbols: &[u8]| -> String {
        symbols
            .iter()
            .map(|&symbol| alphabet[usize::from(symbol) - 1])
            .collect()
    };
    let mut readings: Vec<Reading> = Vec::new();
    for (prefix, score) in &finals {
        let text = tidy(&render(prefix));
        if !readings.iter().any(|reading| reading.text == text) {
            readings.push(Reading {
                text,
                score: *score,
            });
        }
        if readings.len() >= options.n_best {
            break;
        }
    }
    let greedy_ids = greedy_symbols(&log_probs, classes);
    let greedy_text = tidy(&greedy(&log_probs, classes, alphabet));
    let best_score = finals.first().map(|(_, score)| *score).unwrap_or(0.0);
    let mut best = Vec::new();
    let mut best_gap = usize::MAX;
    for (prefix, score) in finals.iter().take(options.n_best.max(1)) {
        if best_score - *score > options.trace_margin {
            break;
        }
        let polished = polish(prefix, &greedy_ids, &words, dictionary);
        let gap = edit_distance(&tidy(&render(&polished)), &greedy_text);
        if gap < best_gap {
            best = polished;
            best_gap = gap;
        }
    }
    // Digits are not words. If a close runner-up has the same letters and its digits sit
    // nearer the raw trace (`19,7` vs `11,7` when the pen reads `117`), take those digits.
    let mut current_text = tidy(&render(&best));
    for (prefix, score) in finals.iter().take(options.n_best.max(1)) {
        if best_score - *score > 0.6 {
            break;
        }
        let polished = polish(prefix, &greedy_ids, &words, dictionary);
        let text = tidy(&render(&polished));
        if digit_trace_prefers(&current_text, &text, &greedy_text) {
            best = polished;
            current_text = text;
        }
    }
    // A sentence that the beam already has, plus a final period within 0.5 nats, keeps the
    // period (`Bergen` → `Bergen.`). Nothing else in the reading may change.
    {
        let with_period = format!("{current_text}.");
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 0.5 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, dictionary);
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if text == with_period {
                best = polished;
                break;
            }
        }
    }
    // One unknown word, one letter away from a dictionary word, within 0.6 nats
    // (`SNAFF` → `SNIFF`, `Veds` → `Veda`). The new letter keeps the old letter's case,
    // and the rest of the line stays put.
    if let Some(dictionary) = dictionary {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 0.6 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, Some(dictionary));
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if promotes_one_unknown_letter(&chosen, &text, dictionary) {
                best = polished;
                break;
            }
        }
    }
    // Three copies of one letter written as separate words (`y y y`) join when a close
    // reading already has them together (`yyy`). Real words are longer than one letter.
    {
        let chosen = tidy(&render(&best));
        let collapsed = collapse_repeated_letters(&chosen);
        if collapsed != chosen {
            let mut distinct = 0usize;
            let mut previous = String::new();
            for (prefix, score) in &finals {
                if best_score - *score > 0.9 {
                    break;
                }
                let polished = polish(prefix, &greedy_ids, &words, dictionary);
                let text = tidy(&render(&polished));
                if text != previous {
                    if distinct == options.n_best.max(1) {
                        break;
                    }
                    distinct += 1;
                    previous = text.clone();
                }
                if text == collapsed {
                    best = polished;
                    break;
                }
            }
        }
    }
    // A close reading that is this line plus one apostrophe keeps it (`My!` → `'My!`).
    // The rest of the line has to stay as it is.
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 0.3 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, dictionary);
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if inserts_one_apostrophe(&chosen, &text) {
                best = polished;
                break;
            }
        }
    }
    // A close reading that only capitalizes a later long word keeps those capitals
    // (`kaninchen` → `Kaninchen`). A short word, or the first word, stays as it is.
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 0.8 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, dictionary);
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if capitalizes_a_long_later_word(&chosen, &text) {
                best = polished;
                break;
            }
        }
    }
    // A short word grows by one or two letters when a close reading already has the
    // dictionary word (`der` → `jeder`). The rest of the line stays put.
    if let Some(dictionary) = dictionary {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 1.2 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, Some(dictionary));
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if inserts_into_a_short_word(&chosen, &text, dictionary) {
                best = polished;
                break;
            }
        }
    }
    // A doubled final letter becomes that letter plus an exclamation when a close reading
    // already has it (`Muiriell` → `Muiriel!`).
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 2.3 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, dictionary);
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if finishes_a_doubled_letter_with_a_bang(&chosen, &text) {
                best = polished;
                break;
            }
        }
    }
    // One letter that turns a content word into a German function word is kept
    // (`heine` → `keine`) when that reading is very close.
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 0.4 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, dictionary);
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if prefers_a_closed_class_word(&chosen, &text) {
                best = polished;
                break;
            }
        }
    }
    // Two German function words of three letters, one letter apart (`sie` → `nie`).
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 0.9 {
                break;
            }
            let polished = polish(prefix, &greedy_ids, &words, dictionary);
            let text = tidy(&render(&polished));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if swaps_short_function_words(&chosen, &text) {
                best = polished;
                break;
            }
        }
    }
    // One letter the pen drew and the top reading dropped (`gnasts` → `gmnasts` when the
    // trace says `gmnasts`). The raw reading is kept so the dictionary does not turn it
    // into `gymnasts`.
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 1.0 {
                break;
            }
            let text = tidy(&render(prefix));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if inserts_one_traced_letter(&chosen, &text, &greedy_text) {
                best = prefix.clone();
                break;
            }
        }
    }
    // A sentence that already ends in a comma keeps a close reading that ends in a period
    // instead (`Worte,` → `Worte.`). A comma before more words stays a comma.
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 1.5 {
                break;
            }
            // The raw reading, not the polished one: polishing would copy the trace's comma
            // back onto this period.
            let text = tidy(&render(prefix));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if replaces_a_final_comma_with_a_period(&chosen, &text) {
                best = prefix.clone();
                break;
            }
        }
    }
    // A comma after a closing quote can be a period farther down the beam
    // (`"Muiriel",` → `"Muiriel".`). A comma after a word stays inside the tighter margin.
    {
        let chosen = tidy(&render(&best));
        let mut distinct = 0usize;
        let mut previous = String::new();
        for (prefix, score) in &finals {
            if best_score - *score > 2.5 {
                break;
            }
            let text = tidy(&render(prefix));
            if text != previous {
                if distinct == options.n_best.max(1) {
                    break;
                }
                distinct += 1;
                previous = text.clone();
            }
            if replaces_a_quoted_final_comma_with_a_period(&chosen, &text) {
                best = prefix.clone();
                break;
            }
        }
    }
    // The language model likes to split a long pen word into two known words (`Jack daws`).
    // If the raw trace has no space there and both pieces are long, join them back.
    let best = drop_spaces_absent_from_trace(&best, &greedy_text, &words, dictionary);
    // A hyphen the pen drew and the beam skipped is put back when the next letter matches
    // (`Fifth-` → `-Fifth-`).
    let best = restore_trace_hyphens(&best, &greedy_text, &words);
    let characters = align(&log_probs, classes, frames, &best, alphabet);
    let text = render(&best);
    let (known_words, word_count) = count_words(&best, &words);
    let confidence = if characters.is_empty() {
        0.0
    } else {
        characters.iter().map(|c| c.confidence).sum::<f32>() / characters.len() as f32
    };
    Some(BeamDecoded {
        greedy_text,
        text: text.clone(),
        confidence,
        characters,
        readings,
        frames: frames as u32,
        known_words,
        words: word_count,
    })
}

fn restore_trace_hyphens(prefix: &[u8], greedy: &str, words: &Words<'_>) -> Vec<u8> {
    let beam: String = prefix
        .iter()
        .map(|&symbol| words.alphabet[usize::from(symbol) - 1])
        .collect();
    let restored = restore_parenthesis_string(&restore_hyphen_string(&beam, greedy), greedy);
    if restored == beam {
        return prefix.to_vec();
    }
    let mut symbols = Vec::with_capacity(restored.chars().count());
    for character in restored.chars() {
        let Some(index) = words.alphabet.iter().position(|&item| item == character) else {
            return prefix.to_vec();
        };
        symbols.push((index + 1) as u8);
    }
    symbols
}

fn restore_hyphen_string(text: &str, greedy: &str) -> String {
    let text: Vec<char> = text.chars().collect();
    let greedy: Vec<char> = greedy.chars().collect();
    let mut out = Vec::with_capacity(text.len() + 2);
    let mut text_index = 0;
    let mut greedy_index = 0;
    while text_index < text.len() && greedy_index < greedy.len() {
        if greedy[greedy_index] == '-' && text[text_index] != '-' {
            let next = greedy_index + 1;
            if next < greedy.len() && letters_match(text[text_index], greedy[next]) {
                out.push('-');
                greedy_index += 1;
                continue;
            }
        }
        if letters_match(text[text_index], greedy[greedy_index]) {
            out.push(text[text_index]);
            text_index += 1;
            greedy_index += 1;
            continue;
        }
        break;
    }
    out.extend_from_slice(&text[text_index..]);
    out.into_iter().collect()
}

/// Inserts a `)` the pen drew when that mark sits between the same two characters in the
/// beam (`dann heißen` → `dann) heißen` beside a trace of `dauen) heißen`).
fn restore_parenthesis_string(text: &str, greedy: &str) -> String {
    let text: Vec<char> = text.chars().collect();
    let greedy: Vec<char> = greedy.chars().collect();
    let mut sites = Vec::new();
    for (index, &character) in greedy.iter().enumerate() {
        if character != ')' || index == 0 {
            continue;
        }
        let before = greedy[index - 1];
        let after = greedy.get(index + 1).copied();
        let mut found = None;
        let mut count = 0;
        for place in 0..text.len() {
            if text[place] != before {
                continue;
            }
            let next = text.get(place + 1).copied();
            if next == Some(')') {
                continue;
            }
            let boundary = match after {
                Some(expected) => next == Some(expected),
                None => next.is_none(),
            };
            if !boundary {
                continue;
            }
            count += 1;
            found = Some(place + 1);
        }
        if count == 1 {
            if let Some(place) = found {
                sites.push(place);
            }
        }
    }
    if sites.is_empty() {
        return text.into_iter().collect();
    }
    sites.sort_unstable();
    sites.dedup();
    let mut out = text;
    for place in sites.into_iter().rev() {
        out.insert(place, ')');
    }
    out.into_iter().collect()
}

fn letters_match(left: char, right: char) -> bool {
    left == right || (left.is_alphabetic() && right.is_alphabetic() && same_letter(left, right))
}

fn polish(
    prefix: &[u8],
    greedy_ids: &[u8],
    words: &Words<'_>,
    dictionary: Option<&dyn Lexicon>,
) -> Vec<u8> {
    let marked = reconcile_sentence_marks(prefix, greedy_ids, words);
    match dictionary {
        Some(dictionary) => {
            let support = matched_to_greedy(&marked, greedy_ids, words);
            correct_unknown_words(&marked, words, dictionary, &support)
        }
        None => marked,
    }
}

/// True where the beam character is the same letter the raw trace chose.
fn matched_to_greedy(beam: &[u8], greedy: &[u8], words: &Words<'_>) -> Vec<bool> {
    let beam_chars: Vec<char> = beam
        .iter()
        .map(|&symbol| words.alphabet[usize::from(symbol) - 1])
        .collect();
    let greedy_chars: Vec<char> = greedy
        .iter()
        .map(|&symbol| words.alphabet[usize::from(symbol) - 1])
        .collect();
    let (n, m) = (beam_chars.len(), greedy_chars.len());
    let mut distance = vec![vec![0u16; m + 1]; n + 1];
    for (index, cell) in distance.iter_mut().enumerate() {
        cell[0] = index as u16;
    }
    for (index, cell) in distance[0].iter_mut().enumerate() {
        *cell = index as u16;
    }
    for i in 1..=n {
        for j in 1..=m {
            let substitute = distance[i - 1][j - 1]
                + u16::from(!same_letter(beam_chars[i - 1], greedy_chars[j - 1]));
            distance[i][j] = substitute
                .min(distance[i - 1][j] + 1)
                .min(distance[i][j - 1] + 1);
        }
    }
    let mut support = vec![false; n];
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        if i > 0
            && j > 0
            && distance[i][j]
                == distance[i - 1][j - 1]
                    + u16::from(!same_letter(beam_chars[i - 1], greedy_chars[j - 1]))
        {
            support[i - 1] = same_letter(beam_chars[i - 1], greedy_chars[j - 1]);
            i -= 1;
            j -= 1;
        } else if i > 0 && distance[i][j] == distance[i - 1][j] + 1 {
            i -= 1;
        } else if j > 0 {
            j -= 1;
        } else {
            break;
        }
    }
    support
}

fn same_letter(left: char, right: char) -> bool {
    let left: String = left.to_lowercase().collect();
    let right: String = right.to_lowercase().collect();
    left == right
}

fn drop_spaces_absent_from_trace(
    prefix: &[u8],
    greedy: &str,
    words: &Words<'_>,
    dictionary: Option<&dyn Lexicon>,
) -> Vec<u8> {
    if prefix.is_empty() || greedy.is_empty() {
        return prefix.to_vec();
    }
    let beam: Vec<char> = prefix
        .iter()
        .map(|&symbol| words.alphabet[usize::from(symbol) - 1])
        .collect();
    let greedy: Vec<char> = greedy.chars().collect();
    let (n, m) = (beam.len(), greedy.len());
    let mut distance = vec![vec![0u16; m + 1]; n + 1];
    for (index, cell) in distance.iter_mut().enumerate() {
        cell[0] = index as u16;
    }
    for (index, cell) in distance[0].iter_mut().enumerate() {
        *cell = index as u16;
    }
    for i in 1..=n {
        for j in 1..=m {
            let substitute = distance[i - 1][j - 1] + u16::from(beam[i - 1] != greedy[j - 1]);
            distance[i][j] = substitute
                .min(distance[i - 1][j] + 1)
                .min(distance[i][j - 1] + 1);
        }
    }
    let mut drop = vec![false; n];
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        if i > 0
            && j > 0
            && distance[i][j] == distance[i - 1][j - 1] + u16::from(beam[i - 1] != greedy[j - 1])
        {
            i -= 1;
            j -= 1;
        } else if i > 0 && distance[i][j] == distance[i - 1][j] + 1 {
            if beam[i - 1] == ' ' {
                let left = (0..i - 1)
                    .rev()
                    .take_while(|&index| beam[index].is_alphabetic())
                    .count();
                let right = (i..n)
                    .take_while(|&index| beam[index].is_alphabetic())
                    .count();
                // Two known words (`schlafen gehen`) stay split. A join is kept only when
                // the dictionary has the single word (`jackdaws`) and the trace has no space.
                if left >= 4 && right >= 4 {
                    let joined: String = beam[i - 1 - left..i - 1]
                        .iter()
                        .chain(beam[i..i + right].iter())
                        .flat_map(|character| character.to_lowercase())
                        .collect::<String>()
                        .replace('ß', "ss");
                    if dictionary.is_some_and(|known| known.contains(&joined)) {
                        drop[i - 1] = true;
                    }
                }
            }
            i -= 1;
        } else if j > 0 {
            j -= 1;
        } else {
            break;
        }
    }
    prefix
        .iter()
        .enumerate()
        .filter(|(index, _)| !drop[*index])
        .map(|(_, symbol)| *symbol)
        .collect()
}

/// `candidate` is `current` with a final comma replaced by a period, and that comma
/// follows a closing quote.
fn replaces_a_quoted_final_comma_with_a_period(current: &str, candidate: &str) -> bool {
    let chars: Vec<char> = current.chars().collect();
    if chars.len() < 3 {
        return false;
    }
    let quote = chars[chars.len() - 2];
    (quote == '"' || quote == '\'') && replaces_a_final_comma_with_a_period(current, candidate)
}

/// `candidate` is `current` with a final comma replaced by a period.
fn replaces_a_final_comma_with_a_period(current: &str, candidate: &str) -> bool {
    let mut current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if current.len() < 2 || current.len() != candidate.len() {
        return false;
    }
    let last = current.len() - 1;
    if current[last] != ',' || candidate[last] != '.' {
        return false;
    }
    current[last] = '.';
    current == candidate
}

/// `candidate` is `current` plus one letter, and that letter's word is a whole word in the trace.
fn inserts_one_traced_letter(current: &str, candidate: &str, greedy: &str) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if candidate.len() != current.len() + 1 {
        return false;
    }
    let mut current_index = 0;
    let mut inserted = None;
    for (index, &character) in candidate.iter().enumerate() {
        if current_index < current.len() && character == current[current_index] {
            current_index += 1;
        } else if inserted.is_none() && character.is_alphabetic() {
            inserted = Some(index);
        } else {
            return false;
        }
    }
    let Some(inserted) = inserted else {
        return false;
    };
    if current_index != current.len() {
        return false;
    }
    let start = inserted
        - (0..inserted)
            .rev()
            .take_while(|&cursor| candidate[cursor].is_alphabetic())
            .count();
    let end = inserted
        + 1
        + (inserted + 1..candidate.len())
            .take_while(|&cursor| candidate[cursor].is_alphabetic())
            .count();
    if end - start < 6 {
        return false;
    }
    let word: String = candidate[start..end]
        .iter()
        .flat_map(|c| c.to_lowercase())
        .collect();
    greedy
        .split(|character: char| !character.is_alphabetic())
        .any(|token| token.to_lowercase() == word)
}

fn short_function_word(word: &str) -> bool {
    matches!(
        dict_key(word).as_str(),
        "auf"
            | "aus"
            | "bei"
            | "das"
            | "dem"
            | "den"
            | "der"
            | "des"
            | "die"
            | "dir"
            | "ein"
            | "hat"
            | "ist"
            | "mir"
            | "mit"
            | "nie"
            | "nur"
            | "sie"
            | "und"
            | "von"
            | "wir"
            | "zum"
            | "zur"
    )
}

/// `candidate` changes one letter inside one three-letter function word, into another.
fn swaps_short_function_words(current: &str, candidate: &str) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if current.len() != candidate.len() {
        return false;
    }
    let diffs: Vec<usize> = (0..current.len())
        .filter(|&index| current[index] != candidate[index])
        .collect();
    let &[index] = diffs.as_slice() else {
        return false;
    };
    if current[index]
        .to_lowercase()
        .eq(candidate[index].to_lowercase())
        || !current[index].is_alphabetic()
        || !candidate[index].is_alphabetic()
    {
        return false;
    }
    let start = index
        - (0..index)
            .rev()
            .take_while(|&cursor| current[cursor].is_alphabetic())
            .count();
    let end = index
        + 1
        + (index + 1..current.len())
            .take_while(|&cursor| current[cursor].is_alphabetic())
            .count();
    if end - start != 3 {
        return false;
    }
    let before: String = current[start..end].iter().collect();
    let after: String = candidate[start..end].iter().collect();
    short_function_word(&before) && short_function_word(&after)
}

fn german_closed_class(word: &str) -> bool {
    matches!(
        dict_key(word).as_str(),
        "keine"
            | "keiner"
            | "keinem"
            | "keinen"
            | "keines"
            | "kein"
            | "nicht"
            | "nichts"
            | "nie"
            | "dass"
            | "weil"
            | "und"
            | "oder"
            | "aber"
            | "ist"
            | "sind"
            | "wird"
            | "auch"
            | "schon"
            | "noch"
            | "diese"
            | "dieser"
            | "diesem"
            | "diesen"
            | "eine"
            | "einer"
            | "einem"
            | "einen"
    )
}

/// `candidate` differs by one letter, and that letter turns a non-function word into a
/// German function word (`heine` → `keine`).
fn prefers_a_closed_class_word(current: &str, candidate: &str) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if current.len() != candidate.len() {
        return false;
    }
    let diffs: Vec<usize> = (0..current.len())
        .filter(|&index| current[index] != candidate[index])
        .collect();
    if diffs.len() != 1
        || !current[diffs[0]].is_alphabetic()
        || !candidate[diffs[0]].is_alphabetic()
    {
        return false;
    }
    let index = diffs[0];
    let start = index
        - (0..index)
            .rev()
            .take_while(|&cursor| current[cursor].is_alphabetic())
            .count();
    let end = index
        + 1
        + (index + 1..current.len())
            .take_while(|&cursor| current[cursor].is_alphabetic())
            .count();
    if end - start < 4 {
        return false;
    }
    let before: String = current[start..end].iter().collect();
    let after: String = candidate[start..end].iter().collect();
    !german_closed_class(&before) && german_closed_class(&after)
}

/// `candidate` is `current` with a repeated final letter replaced by that letter and `!`.
fn finishes_a_doubled_letter_with_a_bang(current: &str, candidate: &str) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if current.len() < 2 || current.len() != candidate.len() {
        return false;
    }
    let last = current.len() - 1;
    current[last] == current[last - 1]
        && current[last].is_alphabetic()
        && candidate[last] == '!'
        && current[..last] == candidate[..last]
}

/// `candidate` is `current` with one word of two or three letters growing by one or two
/// inserted letters, and that longer word is in the dictionary.
fn inserts_into_a_short_word(current: &str, candidate: &str, dictionary: &dyn Lexicon) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    let current_words = word_spans(&current);
    let candidate_words = word_spans(&candidate);
    if current_words.len() != candidate_words.len() || current_words.is_empty() {
        return false;
    }
    let mut found = false;
    let mut current_from = 0;
    let mut candidate_from = 0;
    for index in 0..current_words.len() {
        let (current_start, current_end) = current_words[index];
        let (candidate_start, candidate_end) = candidate_words[index];
        if current[current_from..current_start] != candidate[candidate_from..candidate_start] {
            return false;
        }
        let short = &current[current_start..current_end];
        let long = &candidate[candidate_start..candidate_end];
        if short != long {
            if found || !(2..=3).contains(&short.len()) || !is_short_insertion(short, long) {
                return false;
            }
            let word: String = long.iter().collect();
            if !dictionary.contains(&dict_key(&word)) {
                return false;
            }
            found = true;
        }
        current_from = current_end;
        candidate_from = candidate_end;
    }
    found && current[current_from..] == candidate[candidate_from..]
}

fn word_spans(text: &[char]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut index = 0;
    while index < text.len() {
        if !text[index].is_alphabetic() {
            index += 1;
            continue;
        }
        let start = index;
        while index < text.len() && text[index].is_alphabetic() {
            index += 1;
        }
        spans.push((start, index));
    }
    spans
}

fn is_short_insertion(short: &[char], long: &[char]) -> bool {
    if long.len() <= short.len() || long.len() > short.len() + 2 {
        return false;
    }
    let mut index = 0;
    for &character in long {
        if index < short.len() && character == short[index] {
            index += 1;
        }
    }
    index == short.len()
}

/// `candidate` differs from `current` only by turning lowercase letters into capitals,
/// and every such letter sits in a word of at least eight letters that is not the first word.
fn capitalizes_a_long_later_word(current: &str, candidate: &str) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if current.len() != candidate.len() {
        return false;
    }
    let mut changed = false;
    for index in 0..current.len() {
        if current[index] == candidate[index] {
            continue;
        }
        if !current[index].is_lowercase()
            || !candidate[index].is_uppercase()
            || !same_letter(current[index], candidate[index])
        {
            return false;
        }
        let start = index
            - (0..index)
                .rev()
                .take_while(|&cursor| current[cursor].is_alphabetic())
                .count();
        let end = index
            + 1
            + (index + 1..current.len())
                .take_while(|&cursor| current[cursor].is_alphabetic())
                .count();
        if end - start < 8
            || !current[..start]
                .iter()
                .any(|character| character.is_alphabetic())
        {
            return false;
        }
        changed = true;
    }
    changed
}

/// `candidate` is `current` with exactly one `'` added and every other character unchanged.
fn inserts_one_apostrophe(current: &str, candidate: &str) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if candidate.len() != current.len() + 1 {
        return false;
    }
    let mut matched = 0;
    let mut inserted = false;
    for &character in &candidate {
        if matched < current.len() && character == current[matched] {
            matched += 1;
        } else if !inserted && character == '\'' {
            inserted = true;
        } else {
            return false;
        }
    }
    inserted && matched == current.len()
}

fn collapse_repeated_letters(text: &str) -> String {
    let parts: Vec<&str> = text.split(' ').filter(|part| !part.is_empty()).collect();
    let mut out: Vec<String> = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let letter = parts[index];
        if letter.chars().count() == 1 {
            let mut end = index + 1;
            while end < parts.len() && parts[end] == letter {
                end += 1;
            }
            if end - index >= 3 {
                out.push(letter.repeat(end - index));
                index = end;
                continue;
            }
        }
        out.push(letter.to_owned());
        index += 1;
    }
    out.join(" ")
}

fn dict_key(word: &str) -> String {
    word.to_lowercase().replace('ß', "ss")
}

/// `candidate` is `current` with one letter changed, that letter keeps its case,
/// the old word is unknown, and the new word is in the dictionary.
fn promotes_one_unknown_letter(current: &str, candidate: &str, dictionary: &dyn Lexicon) -> bool {
    let current: Vec<char> = current.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    if current.len() != candidate.len() {
        return false;
    }
    let diffs: Vec<usize> = (0..current.len())
        .filter(|&index| current[index] != candidate[index])
        .collect();
    if diffs.len() != 1 {
        return false;
    }
    let index = diffs[0];
    let (before_char, after_char) = (current[index], candidate[index]);
    if !before_char.is_alphabetic()
        || !after_char.is_alphabetic()
        || before_char.is_uppercase() != after_char.is_uppercase()
    {
        return false;
    }
    let word_start = (0..index)
        .rev()
        .take_while(|&cursor| current[cursor].is_alphabetic())
        .count();
    let word_start = index - word_start;
    let word_end = index
        + 1
        + (index + 1..current.len())
            .take_while(|&cursor| current[cursor].is_alphabetic())
            .count();
    let before: String = current[word_start..word_end].iter().collect();
    let after: String = candidate[word_start..word_end].iter().collect();
    if before.chars().count() < 4 {
        return false;
    }
    !dictionary.contains(&dict_key(&before)) && dictionary.contains(&dict_key(&after))
}

fn digit_trace_prefers(current: &str, candidate: &str, greedy: &str) -> bool {
    if without_digits(current) != without_digits(candidate) {
        return false;
    }
    edit_distance(&digits_only(candidate), &digits_only(greedy))
        < edit_distance(&digits_only(current), &digits_only(greedy))
}

fn digits_only(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

fn without_digits(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_ascii_digit())
        .collect()
}

fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (i, &left_char) in left.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, &right_char) in right.iter().enumerate() {
            current.push(
                (previous[j + 1] + 1)
                    .min(current[j] + 1)
                    .min(previous[j] + usize::from(left_char != right_char)),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

fn count_words(prefix: &[u8], words: &Words<'_>) -> (u32, u32) {
    let mut known = 0;
    let mut total = 0;
    let mut end = 0;
    while end <= prefix.len() {
        let at_boundary = end == prefix.len() || !words.is_letter(prefix[end]);
        if at_boundary && end > 0 && words.is_letter(prefix[end - 1]) {
            match words.trailing_word(&prefix[..end]) {
                Some(true) => {
                    known += 1;
                    total += 1;
                }
                Some(false) => total += 1,
                None => {}
            }
        }
        end += 1;
    }
    (known, total)
}

/// Collapses runs of spaces; the model only ever emits single spaces between words, but a
/// beam may still carry a leading or trailing one.
fn tidy(text: &str) -> String {
    text.split(' ')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn greedy_symbols(log_probs: &[f64], classes: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut previous = 0usize;
    for row in log_probs.chunks_exact(classes) {
        let (best, _) = row
            .iter()
            .enumerate()
            .fold((0, NEG_INF), |acc, (index, &value)| {
                if value > acc.1 {
                    (index, value)
                } else {
                    acc
                }
            });
        if best != 0 && best != previous {
            out.push(best as u8);
        }
        previous = best;
    }
    out
}

/// A comma and a period swap only at a sentence boundary. Before a lowercase word, or in
/// a decimal (`11,7`), the beam's mark is the one that was written (`daran, dass`).
fn comma_period_inside_a_sentence(
    best: &[u8],
    mark: usize,
    greedy_mark: u8,
    words: &Words<'_>,
) -> bool {
    let beam_mark = words.alphabet[usize::from(best[mark]) - 1];
    let greedy_mark = words.alphabet[usize::from(greedy_mark) - 1];
    if !matches!((beam_mark, greedy_mark), (',', '.') | ('.', ',')) {
        return false;
    }
    let mut index = mark + 1;
    while index < best.len() && !words.is_letter(best[index]) {
        let character = words.alphabet[usize::from(best[index]) - 1];
        if character.is_ascii_digit() {
            return true;
        }
        if character != ' ' {
            return false;
        }
        index += 1;
    }
    index < best.len() && words.alphabet[usize::from(best[index]) - 1].is_lowercase()
}

/// Substitutes a sentence mark in `best` with the greedy mark when the two readings align there.
fn reconcile_sentence_marks(best: &[u8], greedy: &[u8], words: &Words<'_>) -> Vec<u8> {
    let mut result = best.to_vec();
    if best.is_empty() || greedy.is_empty() {
        return result;
    }
    let (n, m) = (best.len(), greedy.len());
    let mut distance = vec![vec![0u16; m + 1]; n + 1];
    for (index, cell) in distance.iter_mut().enumerate() {
        cell[0] = index as u16;
    }
    for (index, cell) in distance[0].iter_mut().enumerate() {
        *cell = index as u16;
    }
    for i in 1..=n {
        for j in 1..=m {
            let substitute = distance[i - 1][j - 1] + u16::from(best[i - 1] != greedy[j - 1]);
            distance[i][j] = substitute
                .min(distance[i - 1][j] + 1)
                .min(distance[i][j - 1] + 1);
        }
    }
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        if i > 0
            && j > 0
            && distance[i][j] == distance[i - 1][j - 1] + u16::from(best[i - 1] != greedy[j - 1])
        {
            if best[i - 1] != greedy[j - 1]
                && words.sentence_mark(best[i - 1])
                && words.sentence_mark(greedy[j - 1])
                && !comma_period_inside_a_sentence(best, i - 1, greedy[j - 1], words)
            {
                result[i - 1] = greedy[j - 1];
            }
            i -= 1;
            j -= 1;
        } else if i > 0 && distance[i][j] == distance[i - 1][j] + 1 {
            i -= 1;
        } else if j > 0 {
            j -= 1;
        }
    }
    result
}

fn correct_unknown_words(
    prefix: &[u8],
    words: &Words<'_>,
    dictionary: &dyn Lexicon,
    support: &[bool],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(prefix.len());
    let mut index = 0;
    while index < prefix.len() {
        if !words.is_letter(prefix[index]) {
            out.push(prefix[index]);
            index += 1;
            continue;
        }
        let start = index;
        while index < prefix.len() && words.is_letter(prefix[index]) {
            index += 1;
        }
        let word_support = support.get(start..index).unwrap_or(&[]);
        out.extend(corrected_run(
            &prefix[start..index],
            words,
            dictionary,
            word_support,
        ));
    }
    out
}

fn corrected_run(
    run: &[u8],
    words: &Words<'_>,
    dictionary: &dyn Lexicon,
    support: &[bool],
) -> Vec<u8> {
    if run.len() < 5 {
        return run.to_vec();
    }
    let original: String = run
        .iter()
        .map(|&symbol| words.alphabet[usize::from(symbol) - 1])
        .collect();
    // The word list stores ß as ss. Search neighbors on that folded form, then
    // replay the edit on the original so a written ß is not replaced by ss
    // (`größtechnischen` → `großtechnischen`, not `grosstechnischen`).
    let lower = original.to_lowercase();
    let (folded, origin) = fold_eszett(&lower);
    if dictionary.contains(&folded) {
        return run.to_vec();
    }
    let mut known = Vec::new();
    for candidate in edit_neighbors(&folded) {
        if !dictionary.contains(&candidate) {
            continue;
        }
        let Some(spelling) = apply_folded_edit(&lower, &folded, &origin, &candidate) else {
            continue;
        };
        known.push(spelling);
    }
    known.sort();
    known.dedup();
    if known.len() != 1 {
        return run.to_vec();
    }
    // `gnasts` is one deletion from the word `gnats`, but the pen also drew that s
    // (`gmnasts`). Dropping a letter the trace agrees with is not a correction.
    if deletes_supported_character(&lower, &known[0], support) {
        return run.to_vec();
    }
    let capitalized = words.alphabet[usize::from(run[0]) - 1].is_uppercase();
    let mut symbols = Vec::with_capacity(known[0].len());
    for (offset, character) in known[0].chars().enumerate() {
        let character = if offset == 0 && capitalized {
            let mut upper = character.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(single), None) => single,
                _ => return run.to_vec(),
            }
        } else {
            character
        };
        let Some(symbol) = words
            .alphabet
            .iter()
            .position(|&item| item == character)
            .map(|index| (index + 1) as u8)
        else {
            return run.to_vec();
        };
        symbols.push(symbol);
    }
    symbols
}

/// A one-character deletion of a letter the raw trace also chose.
fn deletes_supported_character(before: &str, after: &str, support: &[bool]) -> bool {
    let before: Vec<char> = before.chars().collect();
    let after: Vec<char> = after.chars().collect();
    if support.len() != before.len() || after.len() + 1 != before.len() {
        return false;
    }
    let mut index = 0;
    while index < after.len() && before[index] == after[index] {
        index += 1;
    }
    if before.get(index + 1..) != Some(&after[index..]) {
        return false;
    }
    support[index]
}

/// Expands each ß to ss. `origin[i]` is the source character index of folded character `i`.
fn fold_eszett(word: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(word.len() + 4);
    let mut origin = Vec::with_capacity(word.len() + 4);
    for (index, character) in word.chars().enumerate() {
        if character == 'ß' {
            folded.push('s');
            folded.push('s');
            origin.push(index);
            origin.push(index);
        } else {
            folded.push(character);
            origin.push(index);
        }
    }
    (folded, origin)
}

/// Applies the single edit from `folded` to `neighbor` onto `original`.
/// An edit that lands inside a ß (one half of its ss) is refused.
fn apply_folded_edit(
    original: &str,
    folded: &str,
    origin: &[usize],
    neighbor: &str,
) -> Option<String> {
    let original: Vec<char> = original.chars().collect();
    let folded: Vec<char> = folded.chars().collect();
    let neighbor: Vec<char> = neighbor.chars().collect();
    let mut result = original.clone();
    if neighbor.len() == folded.len() {
        let mut changed = None;
        for index in 0..folded.len() {
            if folded[index] != neighbor[index] {
                if changed.is_some() {
                    return None;
                }
                changed = Some(index);
            }
        }
        let index = changed?;
        let source = origin[index];
        if original[source] == 'ß' {
            return None;
        }
        result[source] = neighbor[index];
    } else if neighbor.len() + 1 == folded.len() {
        let mut index = 0;
        while index < neighbor.len() && folded[index] == neighbor[index] {
            index += 1;
        }
        if folded.get(index + 1..)? != neighbor.get(index..)? {
            return None;
        }
        let source = origin[index];
        if original[source] == 'ß' {
            return None;
        }
        result.remove(source);
    } else if neighbor.len() == folded.len() + 1 {
        let mut index = 0;
        while index < folded.len() && folded[index] == neighbor[index] {
            index += 1;
        }
        if folded.get(index..)? != neighbor.get(index + 1..)? {
            return None;
        }
        if index > 0 && index < folded.len() && origin[index] == origin[index - 1] {
            return None;
        }
        let at = if index == folded.len() {
            original.len()
        } else {
            origin[index]
        };
        result.insert(at, neighbor[index]);
    } else {
        return None;
    }
    Some(result.into_iter().collect())
}

fn edit_neighbors(word: &str) -> Vec<String> {
    let letters = [
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
        's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ü',
    ];
    let chars: Vec<char> = word.chars().collect();
    let mut out = Vec::new();
    for index in 0..chars.len() {
        let mut deleted = String::with_capacity(word.len());
        deleted.extend(chars[..index].iter());
        deleted.extend(chars[index + 1..].iter());
        if deleted.chars().count() >= 2 {
            out.push(deleted);
        }
        for &letter in &letters {
            if letter != chars[index] {
                let mut substituted = String::with_capacity(word.len());
                substituted.extend(chars[..index].iter());
                substituted.push(letter);
                substituted.extend(chars[index + 1..].iter());
                out.push(substituted);
            }
            let mut inserted = String::with_capacity(word.len() + 1);
            inserted.extend(chars[..index].iter());
            inserted.push(letter);
            inserted.extend(chars[index..].iter());
            out.push(inserted);
        }
    }
    for &letter in &letters {
        let mut inserted = String::with_capacity(word.len() + 1);
        inserted.extend(chars.iter());
        inserted.push(letter);
        out.push(inserted);
    }
    out
}

fn greedy(log_probs: &[f64], classes: usize, alphabet: &[char]) -> String {
    let mut out = String::new();
    let mut previous = 0usize;
    for row in log_probs.chunks_exact(classes) {
        let (best, _) = row
            .iter()
            .enumerate()
            .fold((0, NEG_INF), |acc, (index, &value)| {
                if value > acc.1 {
                    (index, value)
                } else {
                    acc
                }
            });
        if best != 0 && best != previous {
            out.push(alphabet[best - 1]);
        }
        previous = best;
    }
    out
}

/// Viterbi alignment of `labels` to the frames; falls back to an even split when the line is
/// too short to hold the sequence.
fn align(
    log_probs: &[f64],
    classes: usize,
    frames: usize,
    labels: &[u8],
    alphabet: &[char],
) -> Vec<DecodedChar> {
    if labels.is_empty() {
        return Vec::new();
    }
    let states = labels.len() * 2 + 1;
    let label_of = |state: usize| {
        if state.is_multiple_of(2) {
            0usize
        } else {
            usize::from(labels[state / 2])
        }
    };
    let mut score = vec![NEG_INF; states];
    let mut back = vec![0u32; frames * states];
    score[0] = log_probs[0];
    if states > 1 {
        score[1] = log_probs[label_of(1)];
    }
    for frame in 1..frames {
        let row = &log_probs[frame * classes..(frame + 1) * classes];
        let mut next = vec![NEG_INF; states];
        for state in 0..states {
            let mut best = score[state];
            let mut from = state;
            if state >= 1 && score[state - 1] > best {
                best = score[state - 1];
                from = state - 1;
            }
            if state >= 2
                && state % 2 == 1
                && labels[state / 2] != labels[state / 2 - 1]
                && score[state - 2] > best
            {
                best = score[state - 2];
                from = state - 2;
            }
            if best > NEG_INF {
                next[state] = best + row[label_of(state)];
                back[frame * states + state] = from as u32;
            }
        }
        score = next;
    }
    let end = if states >= 2 && score[states - 2] > score[states - 1] {
        states - 2
    } else {
        states - 1
    };
    if score[end] == NEG_INF {
        return even_split(log_probs, classes, frames, labels, alphabet);
    }
    let mut path = vec![0usize; frames];
    let mut state = end;
    for frame in (0..frames).rev() {
        path[frame] = state;
        if frame > 0 {
            state = back[frame * states + state] as usize;
        }
    }
    let mut spans = vec![(u32::MAX, 0u32); labels.len()];
    for (frame, &state) in path.iter().enumerate() {
        if state % 2 == 1 {
            let span = &mut spans[state / 2];
            span.0 = span.0.min(frame as u32);
            span.1 = span.1.max(frame as u32 + 1);
        }
    }
    labels
        .iter()
        .zip(spans)
        .map(|(&label, (start, end))| {
            describe(
                log_probs,
                classes,
                label,
                start,
                end.max(start + 1),
                alphabet,
            )
        })
        .collect()
}

fn even_split(
    log_probs: &[f64],
    classes: usize,
    frames: usize,
    labels: &[u8],
    alphabet: &[char],
) -> Vec<DecodedChar> {
    labels
        .iter()
        .enumerate()
        .map(|(index, &label)| {
            let start = (index * frames / labels.len()) as u32;
            let end = (((index + 1) * frames / labels.len()) as u32).max(start + 1);
            describe(log_probs, classes, label, start, end, alphabet)
        })
        .collect()
}

fn describe(
    log_probs: &[f64],
    classes: usize,
    label: u8,
    start: u32,
    end: u32,
    alphabet: &[char],
) -> DecodedChar {
    let frames = log_probs.len() / classes;
    let (start, end) = (start as usize, (end as usize).min(frames));
    let class = usize::from(label);
    let mut peak_frame = start;
    let mut peak = NEG_INF;
    for frame in start..end.max(start + 1).min(frames) {
        let value = log_probs[frame * classes + class];
        if value > peak {
            peak = value;
            peak_frame = frame;
        }
    }
    let row = &log_probs[peak_frame * classes..(peak_frame + 1) * classes];
    let mut others: Vec<(usize, f64)> = (1..classes)
        .filter(|&c| c != class)
        .map(|c| (c, row[c]))
        .collect();
    others.sort_by(|a, b| b.1.total_cmp(&a.1));
    let non_blank: f64 = (1..classes).map(|c| row[c].exp()).sum::<f64>().max(1e-9);
    let alternatives = others
        .into_iter()
        .take(4)
        .map(|(c, value)| (c, value.exp() / non_blank))
        .filter(|&(_, share)| share >= 0.01)
        .map(|(c, share)| CharAlternative {
            char: alphabet[c - 1].to_string(),
            confidence: share as f32,
        })
        .collect();
    DecodedChar {
        char: alphabet[class - 1].to_string(),
        confidence: (peak.exp() / non_blank.max(peak.exp())).min(1.0) as f32,
        start_frame: start as u32,
        end_frame: end.max(start + 1) as u32,
        alternatives,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(alphabet: &[char]) -> Words<'_> {
        Words {
            alphabet,
            lexicon: &(),
        }
    }

    #[test]
    fn a_greedy_period_replaces_a_comma_only_before_a_capital() {
        let alphabet: Vec<char> = "abcABC178., ".chars().collect();
        let index = |character: char| {
            (alphabet.iter().position(|&item| item == character).unwrap() + 1) as u8
        };
        let symbols = |text: &str| text.chars().map(index).collect::<Vec<_>>();
        let decoder = words(&alphabet);
        assert_eq!(
            reconcile_sentence_marks(&symbols("a, B"), &symbols("a. C"), &decoder),
            symbols("a. B")
        );
        assert_eq!(
            reconcile_sentence_marks(&symbols("a, b"), &symbols("a. c"), &decoder),
            symbols("a, b")
        );
        assert_eq!(
            reconcile_sentence_marks(&symbols("1, 7"), &symbols("1. 8"), &decoder),
            symbols("1, 7")
        );
    }

    #[test]
    fn an_unknown_word_takes_its_only_dictionary_neighbor() {
        let alphabet: Vec<char> = "abcdex".chars().collect();
        let index = |character: char| {
            (alphabet.iter().position(|&item| item == character).unwrap() + 1) as u8
        };
        struct Known;
        impl Lexicon for Known {
            fn contains(&self, word: &str) -> bool {
                word == "abcde"
            }
        }
        let decoder = Words {
            alphabet: &alphabet,
            lexicon: &Known,
        };
        let slip = ['a', 'b', 'x', 'd', 'e'].map(index);
        assert_eq!(
            corrected_run(&slip, &decoder, &Known, &[]),
            ['a', 'b', 'c', 'd', 'e'].map(index)
        );
        let known = ['a', 'b', 'c', 'd', 'e'].map(index);
        assert_eq!(corrected_run(&known, &decoder, &Known, &[]), known);
    }

    #[test]
    fn a_dictionary_correction_keeps_a_written_eszett() {
        let mut alphabet: Vec<char> = "abcdeghinorstx".chars().collect();
        alphabet.push('ö');
        alphabet.push('ß');
        let index = |character: char| {
            (alphabet.iter().position(|&item| item == character).unwrap() + 1) as u8
        };
        let symbols = |text: &str| text.chars().map(index).collect::<Vec<_>>();
        struct German;
        impl Lexicon for German {
            fn contains(&self, word: &str) -> bool {
                matches!(word, "grosstechnischen" | "strasse" | "grosxxxx")
            }
        }
        let decoder = Words {
            alphabet: &alphabet,
            lexicon: &German,
        };
        assert_eq!(
            corrected_run(&symbols("größtechnischen"), &decoder, &German, &[]),
            symbols("großtechnischen"),
            "the ö→o edit is applied and ß stays"
        );
        assert_eq!(
            corrected_run(&symbols("straße"), &decoder, &German, &[]),
            symbols("straße"),
            "a folded dictionary hit keeps the written ß"
        );
        assert_eq!(
            corrected_run(&symbols("großxxxx"), &decoder, &German, &[]),
            symbols("großxxxx"),
            "an edit inside the ss expansion of ß is refused"
        );
    }

    #[test]
    fn a_letter_the_pen_also_drew_is_not_deleted_for_the_dictionary() {
        let alphabet: Vec<char> = "agnst".chars().collect();
        let index = |character: char| {
            (alphabet.iter().position(|&item| item == character).unwrap() + 1) as u8
        };
        let symbols = |text: &str| text.chars().map(index).collect::<Vec<_>>();
        struct Gnats;
        impl Lexicon for Gnats {
            fn contains(&self, word: &str) -> bool {
                word == "gnats"
            }
        }
        let decoder = Words {
            alphabet: &alphabet,
            lexicon: &Gnats,
        };
        assert_eq!(
            corrected_run(&symbols("gnasts"), &decoder, &Gnats, &[]),
            symbols("gnats")
        );
        // g n a s t s — the first s is the one a deletion would drop, and the pen drew it.
        let support = [false, false, false, true, false, false];
        assert_eq!(
            corrected_run(&symbols("gnasts"), &decoder, &Gnats, &support),
            symbols("gnasts")
        );
    }

    #[test]
    fn a_space_the_trace_does_not_have_joins_long_pieces_only() {
        let alphabet: Vec<char> = "abcdefghijklmnopqrstuvwxyz ".chars().collect();
        let index = |character: char| {
            (alphabet.iter().position(|&item| item == character).unwrap() + 1) as u8
        };
        let symbols = |text: &str| text.chars().map(index).collect::<Vec<_>>();
        struct KnownJoin;
        impl Lexicon for KnownJoin {
            fn contains(&self, word: &str) -> bool {
                word == "abcdefgh"
            }
        }
        let decoder = words(&alphabet);
        assert_eq!(
            drop_spaces_absent_from_trace(
                &symbols("abcd efgh"),
                "abcdefgh",
                &decoder,
                Some(&KnownJoin)
            ),
            symbols("abcdefgh")
        );
        assert_eq!(
            drop_spaces_absent_from_trace(&symbols("abcd efgh"), "abcdefgh", &decoder, None),
            symbols("abcd efgh"),
            "two known pieces are not joined when the word is not in the dictionary"
        );
        assert_eq!(
            drop_spaces_absent_from_trace(&symbols("abcd e"), "abcde", &decoder, Some(&KnownJoin)),
            symbols("abcd e")
        );
    }

    #[test]
    fn closer_digits_require_the_same_letters() {
        assert!(digit_trace_prefers(
            "über 19,7 Millionen",
            "über 11,7 Millionen",
            "über 117 Millionen"
        ));
        assert!(!digit_trace_prefers(
            "über 19,7 Millionen",
            "über 117 Millionen",
            "über 117 Millionen"
        ));
        assert!(!digit_trace_prefers("Jack daws", "Jackdaws", "Jackdaws"));
    }

    #[test]
    fn one_unknown_letter_promotes_only_a_dictionary_word_of_the_same_case() {
        struct Known;
        impl Lexicon for Known {
            fn contains(&self, word: &str) -> bool {
                word == "sniff" || word == "veda" || word == "personen"
            }
        }
        assert!(promotes_one_unknown_letter(
            "PEcK SNAFF long-lost",
            "PEcK SNIFF long-lost",
            &Known
        ));
        assert!(promotes_one_unknown_letter(
            "Rig-Veds\".",
            "Rig-Veda\".",
            &Known
        ));
        assert!(!promotes_one_unknown_letter(
            "Rig-Veds\".",
            "Rig-VedA\".",
            &Known
        ));
        assert!(!promotes_one_unknown_letter(
            "über Personen",
            "über Paronen",
            &Known
        ));
    }

    #[test]
    fn a_final_comma_can_become_a_period() {
        assert!(replaces_a_final_comma_with_a_period(
            "Ich finde keine Worte,",
            "Ich finde keine Worte."
        ));
        assert!(!replaces_a_final_comma_with_a_period(
            "Das liegt daran, dass du willst.",
            "Das liegt daran. dass du willst."
        ));
        assert!(!replaces_a_final_comma_with_a_period(
            "astounded Mirabeau,",
            "astounded Mirabeau,"
        ));
        assert!(replaces_a_quoted_final_comma_with_a_period(
            "Das Passwort ist \"Muiriel\",",
            "Das Passwort ist \"Muiriel\"."
        ));
        assert!(!replaces_a_quoted_final_comma_with_a_period(
            "astounded Mirabeau,",
            "astounded Mirabeau."
        ));
    }

    #[test]
    fn one_traced_letter_is_put_back_when_the_word_is_long() {
        assert!(inserts_one_traced_letter(
            "Six piqued gnasts!",
            "Six piqued gmnasts!",
            "Six piqued gmnasts!"
        ));
        assert!(!inserts_one_traced_letter(
            "Six piqued gnasts!",
            "Six piqued gymnasts!",
            "Six piqued gmnasts!"
        ));
        assert!(!inserts_one_traced_letter(
            "Six piqued gnasts!",
            "Six piqued gmnasts!",
            "Six piqued gnasts!"
        ));
    }

    #[test]
    fn short_function_words_swap_one_real_letter() {
        assert!(swaps_short_function_words(
            "Das wird sie enden.",
            "Das wird nie enden."
        ));
        assert!(!swaps_short_function_words(
            "Ich war in den Bergen.",
            "ich war in den Bergen."
        ));
        assert!(!swaps_short_function_words(
            "Ich finde heine Worte,",
            "Ich finde keine Worte,"
        ));
    }

    #[test]
    fn a_content_word_yields_to_a_closed_class_word() {
        assert!(prefers_a_closed_class_word(
            "Ich finde heine Worte,",
            "Ich finde keine Worte,"
        ));
        assert!(!prefers_a_closed_class_word(
            "Das wird sie enden.",
            "Das wird nie enden."
        ));
        assert!(!prefers_a_closed_class_word("A move", "A mace"));
    }

    #[test]
    fn a_doubled_final_letter_can_become_an_exclamation() {
        assert!(finishes_a_doubled_letter_with_a_bang(
            "zum Geburtstag, Muiriell",
            "zum Geburtstag, Muiriel!"
        ));
        assert!(!finishes_a_doubled_letter_with_a_bang(
            "zum Geburtstag, Muiriel",
            "zum Geburtstag, Muiriel!"
        ));
        assert!(!finishes_a_doubled_letter_with_a_bang("hello", "hell!"));
    }

    #[test]
    fn a_trace_hyphen_is_restored_when_the_next_letter_matches() {
        assert_eq!(
            restore_hyphen_string("vocabulary Fifth-", "vocabulary -Fifth-"),
            "vocabulary -Fifth-"
        );
        assert_eq!(restore_hyphen_string("foobar", "foo-xyz"), "foobar");
        assert_eq!(
            restore_hyphen_string("already-there", "already-there"),
            "already-there"
        );
        assert_eq!(
            restore_parenthesis_string("2023 dann heißen.", "2023 dauen) heißen."),
            "2023 dann) heißen."
        );
        assert_eq!(
            restore_parenthesis_string("hello there", "hello) there"),
            "hello) there"
        );
        assert_eq!(restore_parenthesis_string("an an ", "an) an "), "an an ");
    }

    #[test]
    fn a_short_word_grows_only_into_a_dictionary_word() {
        struct Known;
        impl Lexicon for Known {
            fn contains(&self, word: &str) -> bool {
                word == "jeder"
            }
        }
        assert!(inserts_into_a_short_word(
            "muss der selbst lernen.",
            "muss jeder selbst lernen.",
            &Known
        ));
        assert!(!inserts_into_a_short_word(
            "Marie luft statut",
            "Marine luft statut",
            &Known
        ));
        assert!(!inserts_into_a_short_word(
            "muss der selbst.",
            "muss jeder selbst,",
            &Known
        ));
    }

    #[test]
    fn a_long_later_word_may_take_a_capital_from_a_close_reading() {
        assert!(capitalizes_a_long_later_word(
            "Das war ein böses kaninchen.",
            "Das war ein böses Kaninchen."
        ));
        assert!(!capitalizes_a_long_later_word(
            "Six piqued gnasts!",
            "Six piqued Gnasts!"
        ));
        assert!(!capitalizes_a_long_later_word(
            "kaninchen bleibt hier",
            "Kaninchen bleibt hier"
        ));
    }

    #[test]
    fn one_apostrophe_is_kept_only_when_the_rest_of_the_line_matches() {
        assert!(inserts_one_apostrophe(
            "Guy's Perdyce My!",
            "Guy's Perdyce 'My!"
        ));
        assert!(inserts_one_apostrophe("My!", "'My!"));
        assert!(!inserts_one_apostrophe(
            "Guy's Perdyce My!",
            "Guy's Pendyce 'My!"
        ));
        assert!(!inserts_one_apostrophe(
            "Guy's Perdyce My!",
            "Guy's Perdyce My"
        ));
        assert!(!inserts_one_apostrophe("'My!", "My!"));
    }

    #[test]
    fn three_copies_of_one_letter_join_and_real_words_stay_split() {
        assert_eq!(collapse_repeated_letters("xxx y y y zzz"), "xxx yyy zzz");
        assert_eq!(collapse_repeated_letters("a a"), "a a");
        assert_eq!(
            collapse_repeated_letters("schlafen gehen"),
            "schlafen gehen"
        );
        assert_eq!(
            collapse_repeated_letters("DDD EEE FFF GGG"),
            "DDD EEE FFF GGG"
        );
    }
}
