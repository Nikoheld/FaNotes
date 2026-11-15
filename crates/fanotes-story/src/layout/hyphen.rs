//! Hyphenation identical to the npm `hyphen` package (1.14.1) as the
//! TypeScript layout calls it: `hyphenateSync(word, { hyphenChar: '­',
//! minWordLength: 5 })`, then the offsets of the soft hyphens (`fromSync` in
//! `layout/measure.ts`).
//!
//! The pattern data in `data/hyphen/*.json` is the package's `patterns/de-1996`,
//! `en-us` and `en-gb` modules as JSON (`node scripts/gen-story-fixtures.mjs
//! --patterns` rewrites them). The text reader, the pattern trie walk (with its
//! JavaScript array semantics) and the exception lists are ported line by line,
//! working on UTF-16 code units like the original.
//!
//! Provenance: `hyphen` is ISC-licensed; its pattern modules are the TeX
//! hyph-utf8 patterns (de-1996, en-us, en-gb) under their own licenses. The
//! web and desktop builds already ship the same data through npm.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use crate::json::{self, JsValue};
use crate::model::types::StoryLanguage;

/// Something that gives hyphenation points (UTF-16 offsets) for a word.
pub trait Hyphenate: Send + Sync {
    fn points(&self, word: &str) -> Vec<usize>;
}

#[derive(Default)]
struct Trie {
    children: HashMap<u16, TrieNode>,
}

struct TrieNode {
    next: Option<Trie>,
    /// Index into the levels table (`< 0`: none).
    level: i64,
}

pub struct Hyphenator {
    levels: Vec<Vec<i32>>,
    trie: Trie,
    exceptions: HashMap<String, Vec<usize>>,
}

const SOFT_HYPHEN: u16 = 0xAD;
const MIN_WORD_LENGTH: usize = 5;

fn build_trie(value: &JsValue) -> Trie {
    let mut trie = Trie::default();
    if let Some(map) = value.as_object() {
        for (key, node) in map.iter() {
            let units: Vec<u16> = key.encode_utf16().collect();
            // Keys longer than one UTF-16 unit never match a single letter.
            if units.len() != 1 {
                continue;
            }
            let entry = match node {
                JsValue::Array(pair) => TrieNode {
                    next: pair.first().map(build_trie),
                    level: pair
                        .get(1)
                        .and_then(JsValue::as_f64)
                        .map(|n| n as i64)
                        .unwrap_or(-1),
                },
                JsValue::Object(_) => TrieNode {
                    next: Some(build_trie(node)),
                    level: -1,
                },
                JsValue::Number(n) => TrieNode {
                    next: None,
                    level: *n as i64,
                },
                _ => continue,
            };
            trie.children.insert(units[0], entry);
        }
    }
    trie
}

impl Hyphenator {
    /// Builds a hyphenator from a pattern module as JSON (`[levels, trie, exceptions]`).
    pub fn from_json(text: &str) -> Result<Hyphenator, String> {
        let value = json::parse_with_depth(text, 10_000).map_err(|error| error.to_string())?;
        let parts = value.as_array().ok_or("patterns: not an array")?;
        let levels = parts
            .first()
            .and_then(JsValue::as_array)
            .ok_or("patterns: no levels")?
            .iter()
            .map(|row| {
                row.as_array()
                    .map(|row| {
                        row.iter()
                            .map(|n| n.as_f64().unwrap_or(0.0) as i32)
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect();
        let trie = build_trie(parts.get(1).ok_or("patterns: no trie")?);
        let mut exceptions = HashMap::new();
        if let Some(map) = parts.get(2).and_then(JsValue::as_object) {
            for (word, markers) in map.iter() {
                let markers = markers
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .filter_map(JsValue::as_f64)
                            .map(|n| n as usize)
                            .collect()
                    })
                    .unwrap_or_default();
                exceptions.insert(word.clone(), markers);
            }
        }
        Ok(Hyphenator {
            levels,
            trie,
            exceptions,
        })
    }

    /// The bundled patterns of a language (`de` for de and de-CH).
    pub fn for_language(language: StoryLanguage) -> Arc<Hyphenator> {
        static DE: OnceLock<Arc<Hyphenator>> = OnceLock::new();
        static EN_US: OnceLock<Arc<Hyphenator>> = OnceLock::new();
        static EN_GB: OnceLock<Arc<Hyphenator>> = OnceLock::new();
        let (cell, data) = match language {
            StoryLanguage::De | StoryLanguage::DeCh => {
                (&DE, include_str!("../../data/hyphen/de.json"))
            }
            StoryLanguage::EnUs => (&EN_US, include_str!("../../data/hyphen/en-us.json")),
            StoryLanguage::EnGb => (&EN_GB, include_str!("../../data/hyphen/en-gb.json")),
        };
        cell.get_or_init(|| {
            Arc::new(Hyphenator::from_json(data).expect("bundled hyphenation patterns"))
        })
        .clone()
    }

    /// `hyphenateWord`: marker positions (UTF-16) for one word.
    fn hyphenate_word(&self, text_length: usize, lowered: &[u16]) -> Vec<usize> {
        // `levels` with JavaScript array semantics: -1 stands for NaN / a hole.
        let mut levels: Vec<i32> = vec![0; text_length + 1];
        let mut dotted = Vec::with_capacity(lowered.len() + 2);
        dotted.push(b'.' as u16);
        dotted.extend_from_slice(lowered);
        dotted.push(b'.' as u16);
        let mut entity: i64 = -1;
        let mut i = 0usize;
        loop {
            // createStringSlicer: slice = str.slice(i++); stop below 3 units.
            let start = i;
            i += 1;
            if dotted.len().saturating_sub(start) < 3 {
                break;
            }
            entity += 1;
            if i == 2 {
                entity -= 1;
            }
            let mut trie = Some(&self.trie);
            for letter in &dotted[start..] {
                let Some(node) = trie.and_then(|current| current.children.get(letter)) else {
                    break;
                };
                trie = node.next.as_ref();
                if node.level < 0 {
                    continue;
                }
                let Some(pattern) = self.levels.get(node.level as usize) else {
                    continue;
                };
                for (k, &level) in pattern.iter().enumerate() {
                    let at = (entity + k as i64) as usize;
                    if at >= levels.len() {
                        levels.resize(at + 1, -1);
                    }
                    let current = levels[at];
                    levels[at] = if current < 0 { -1 } else { level.max(current) };
                }
            }
            if trie.is_none() {
                // Matches `triePtr = {}` after a number node: the next lookup fails.
            }
        }
        let length = levels.len();
        levels[0] = 0;
        if length > 1 {
            levels[1] = 0;
        }
        levels[length - 1] = 0;
        if length >= 2 {
            levels[length - 2] = 0;
        }
        levels
            .iter()
            .enumerate()
            .filter(|(_, &level)| level >= 0 && level & 1 == 1)
            .map(|(index, _)| index)
            .collect()
    }

    fn markers_for(&self, word: &[u16]) -> Vec<usize> {
        let original = String::from_utf16_lossy(word);
        let lowered = original.to_lowercase();
        if let Some(markers) = self.exceptions.get(&lowered) {
            return markers.clone();
        }
        let lowered16: Vec<u16> = lowered.encode_utf16().collect();
        self.hyphenate_word(word.len(), &lowered16)
    }

    /// `hyphenateSync(text, { hyphenChar: '­', minWordLength: 5 })` (HTML skipping on).
    pub fn hyphenate_sync(&self, text: &str) -> Vec<u16> {
        let text: Vec<u16> = text.encode_utf16().collect();
        let mut out: Vec<u16> = Vec::with_capacity(text.len() + 8);
        let mut reader = Reader::default();
        while let Some((before, word)) = reader.next(&text) {
            out.extend_from_slice(&before);
            if !word.is_empty() {
                let markers = self.markers_for(&word);
                out.extend_from_slice(&insert_char(&word, &markers));
            }
        }
        out
    }
}

impl Hyphenate for Hyphenator {
    /// `fromSync`: offsets of the soft hyphens in the hyphenated word.
    fn points(&self, word: &str) -> Vec<usize> {
        let marked = String::from_utf16_lossy(&self.hyphenate_sync(word));
        let mut points = Vec::new();
        let mut offset = 0;
        for c in marked.chars() {
            if c == '\u{AD}' {
                points.push(offset);
            } else {
                offset += c.len_utf16();
            }
        }
        points
    }
}

/// `insertChar(text, hyphenChar, markers)`.
fn insert_char(text: &[u16], markers: &[usize]) -> Vec<u16> {
    if markers.is_empty() {
        return text.to_vec();
    }
    let slice = |from: usize, to: usize| -> &[u16] {
        let from = from.min(text.len());
        let to = to.min(text.len());
        if from >= to {
            &[]
        } else {
            &text[from..to]
        }
    };
    let mut parts: Vec<&[u16]> = vec![slice(0, markers[0])];
    for pair in markers.windows(2) {
        parts.push(slice(pair[0], pair[1]));
    }
    parts.push(slice(markers[markers.len() - 1], text.len()));
    let mut out = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.push(SOFT_HYPHEN);
        }
        out.extend_from_slice(part);
    }
    out
}

/// `isNotLetter`: `/\s|(?![\'])[\!-\@\[-\`\{-\~–-‼]/` on one UTF-16 unit (`None` = `''`).
fn is_not_letter(unit: Option<u16>) -> bool {
    let Some(c) = unit else { return false };
    let space = matches!(c, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF);
    let punctuation =
        c != 0x27 && matches!(c, 0x21..=0x40 | 0x5B..=0x60 | 0x7B..=0x7E | 0x2013..=0x203C);
    space || punctuation
}

/// The text reader with its two verifiers (HTML and hyphen char), state per call.
#[derive(Default)]
struct Reader {
    i: usize,
    accum0: Vec<u16>,
    accum: Vec<u16>,
    html_skip: bool,
    hyphen_skip: bool,
}

impl Reader {
    fn next(&mut self, text: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
        while self.i < text.len() {
            let char1 = text[self.i];
            self.i += 1;
            let char2 = text.get(self.i).copied();
            if let Some(result) = self.verify(char1, char2) {
                return Some(result);
            }
        }
        None
    }

    fn accumulate(&mut self) {
        let accum = std::mem::take(&mut self.accum);
        self.accum0.extend(accum);
    }

    fn resolve(&mut self) -> (Vec<u16>, Vec<u16>) {
        (
            std::mem::take(&mut self.accum0),
            std::mem::take(&mut self.accum),
        )
    }

    fn html(&mut self, chars: (u16, Option<u16>)) -> bool {
        if self.html_skip {
            if chars.0 == b'>' as u16 {
                self.accumulate();
                self.html_skip = false;
            }
        } else if chars.0 == b'<' as u16
            && (!is_not_letter(chars.1) || chars.1 == Some(b'/' as u16))
        {
            self.html_skip = true;
        }
        self.html_skip
    }

    fn hyphen_char(&mut self, chars: (u16, Option<u16>)) -> bool {
        if self.hyphen_skip {
            if !is_not_letter(Some(chars.0)) && is_not_letter(chars.1) {
                self.accumulate();
                self.hyphen_skip = false;
            }
        } else if !is_not_letter(Some(chars.0)) && chars.1 == Some(SOFT_HYPHEN) {
            self.hyphen_skip = true;
        }
        self.hyphen_skip
    }

    fn verify(&mut self, char1: u16, char2: Option<u16>) -> Option<(Vec<u16>, Vec<u16>)> {
        self.accum.push(char1);
        // `verifiers.reduce((skip, verify) => skip || verify(...))`: the second runs only when the first says no.
        let skip = self.html((char1, char2)) || self.hyphen_char((char1, char2));
        if !skip {
            if is_not_letter(Some(char1)) && !is_not_letter(char2) {
                self.accumulate();
            }
            if !is_not_letter(Some(char1)) && is_not_letter(char2) {
                if self.accum.len() >= MIN_WORD_LENGTH {
                    return Some(self.resolve());
                }
                self.accumulate();
            }
        }
        if char2.is_none() {
            if self.accum.len() < MIN_WORD_LENGTH || skip {
                self.accumulate();
            }
            return Some(self.resolve());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn german_patterns() {
        let de = Hyphenator::for_language(StoryLanguage::De);
        assert_eq!(de.points("Leuchtturmwärter"), vec![6, 10, 13]);
    }
}
