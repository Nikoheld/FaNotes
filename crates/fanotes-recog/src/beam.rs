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
    let best = finals
        .first()
        .map(|(prefix, _)| prefix.clone())
        .unwrap_or_default();
    let characters = align(&log_probs, classes, frames, &best, alphabet);
    let text = render(&best);
    let (known_words, word_count) = count_words(&best, &words);
    let confidence = if characters.is_empty() {
        0.0
    } else {
        characters.iter().map(|c| c.confidence).sum::<f32>() / characters.len() as f32
    };
    Some(BeamDecoded {
        greedy_text: tidy(&greedy(&log_probs, classes, alphabet)),
        text: text.clone(),
        confidence,
        characters,
        readings,
        frames: frames as u32,
        known_words,
        words: word_count,
    })
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
