//! The n-gram word context index of `neuralWordContext.ts`.
//!
//! Grams are keyed by UTF-16 code units because the TypeScript code slices strings by code unit.

use crate::text::{cmp_utf16, lowercase, units};
use std::collections::{HashMap, HashSet};

pub struct NgramIndex {
    by_length: HashMap<usize, Vec<String>>,
    bigrams: HashMap<[u16; 2], u32>,
    trigrams: HashMap<[u16; 3], u32>,
    prefix4: HashSet<[u16; 4]>,
    prefix5: HashSet<[u16; 5]>,
    suffix4: HashSet<[u16; 4]>,
    suffix5: HashSet<[u16; 5]>,
}

const START: u16 = b'^' as u16;
const END: u16 = b'$' as u16;

impl NgramIndex {
    /// `installNeuralWordContextCandidates`: per-length buckets sorted in UTF-16 order plus bigram
    /// and trigram counts and the 4/5 unit prefix and suffix sets.
    pub fn build(words: &[String]) -> Self {
        let mut index = Self {
            by_length: HashMap::new(),
            bigrams: HashMap::new(),
            trigrams: HashMap::new(),
            prefix4: HashSet::new(),
            prefix5: HashSet::new(),
            suffix4: HashSet::new(),
            suffix5: HashSet::new(),
        };
        let mut padded: Vec<u16> = Vec::new();
        for word in words {
            index
                .by_length
                .entry(word.chars().count())
                .or_default()
                .push(word.clone());
            let word_units = units(word);
            padded.clear();
            padded.push(START);
            padded.extend_from_slice(&word_units);
            padded.push(END);
            for window in padded.windows(2) {
                *index.bigrams.entry([window[0], window[1]]).or_insert(0) += 1;
            }
            for window in padded.windows(3) {
                *index
                    .trigrams
                    .entry([window[0], window[1], window[2]])
                    .or_insert(0) += 1;
            }
            let length = word_units.len();
            if length >= 4 {
                index
                    .prefix4
                    .insert(word_units[..4].try_into().expect("four units"));
                index
                    .suffix4
                    .insert(word_units[length - 4..].try_into().expect("four units"));
            }
            if length >= 5 {
                index
                    .prefix5
                    .insert(word_units[..5].try_into().expect("five units"));
                index
                    .suffix5
                    .insert(word_units[length - 5..].try_into().expect("five units"));
            }
        }
        for bucket in index.by_length.values_mut() {
            bucket.sort_by(|first, second| cmp_utf16(first, second));
        }
        index
    }

    /// `isExtendedNeuralContextWord`
    pub fn is_extended_word(&self, source: &str) -> bool {
        self.by_length
            .get(&source.chars().count())
            .is_some_and(|bucket| {
                bucket
                    .binary_search_by(|word| cmp_utf16(word, source))
                    .is_ok()
            })
    }

    /// `neuralWordContextWordsOfLength` (length counted in code points)
    pub fn words_of_length(&self, length: usize) -> &[String] {
        self.by_length.get(&length).map_or(&[], Vec::as_slice)
    }

    /// `neuralCharacterSequenceScore`
    pub fn character_sequence_score(&self, source: &str) -> f64 {
        if source.is_empty() {
            return 0.0;
        }
        let mut value = vec![START];
        value.extend(lowercase(source).encode_utf16());
        let mut score = 0.0;
        for index in 1..value.len() {
            let bigram_count = self
                .bigrams
                .get(&[value[index - 1], value[index]])
                .copied()
                .unwrap_or(0);
            score += if bigram_count > 0 {
                (f64::from(bigram_count).ln_1p() / 3.0).min(1.0)
            } else {
                -2.5
            };
            if index >= 2 {
                let trigram_count = self
                    .trigrams
                    .get(&[value[index - 2], value[index - 1], value[index]])
                    .copied()
                    .unwrap_or(0);
                score += if trigram_count > 0 {
                    (f64::from(trigram_count).ln_1p() / 2.5).min(1.6)
                } else {
                    -6.0
                };
            }
        }
        score
    }

    /// `neuralCharacterSubwordScore`
    pub fn character_subword_score(&self, source: &str) -> f64 {
        let value = units(&lowercase(source));
        let mut prefix_score = 0.0;
        let mut suffix_score = 0.0;
        if value.len() >= 4 {
            let prefix: [u16; 4] = value[..4].try_into().expect("four units");
            let suffix: [u16; 4] = value[value.len() - 4..].try_into().expect("four units");
            if self.prefix4.contains(&prefix) {
                prefix_score += 1.0;
            }
            if suffix != prefix && self.suffix4.contains(&suffix) {
                suffix_score += 2.0;
            }
        }
        if value.len() >= 5 {
            let prefix: [u16; 5] = value[..5].try_into().expect("five units");
            let suffix: [u16; 5] = value[value.len() - 5..].try_into().expect("five units");
            if self.prefix5.contains(&prefix) {
                prefix_score += 1.25;
            }
            if suffix != prefix && self.suffix5.contains(&suffix) {
                suffix_score += 2.5;
            }
        }
        if prefix_score > 0.0 && suffix_score > 0.0 {
            prefix_score + suffix_score
        } else {
            0.0
        }
    }

    /// Every dictionary word within `maximum_distance` edits (`nearestNeuralWordContextCandidates`
    /// before its collation sort and trim), ordered by distance, then UTF-16 order.
    pub fn nearest_all(
        &self,
        source: &str,
        maximum_distance: usize,
        same_length_only: bool,
    ) -> Vec<(String, usize)> {
        let source_units = units(source);
        let source_length = source.chars().count();
        let minimum = if same_length_only {
            source_length
        } else {
            source_length.saturating_sub(maximum_distance).max(3)
        };
        let maximum = if same_length_only {
            source_length
        } else {
            source_length + maximum_distance
        };
        let mut found: Vec<(String, usize)> = Vec::new();
        for length in minimum..=maximum {
            for candidate in self.words_of_length(length) {
                let distance =
                    bounded_word_distance(&source_units, &units(candidate), maximum_distance);
                if distance <= maximum_distance {
                    found.push((candidate.clone(), distance));
                }
            }
        }
        found.sort_by(|first, second| {
            first
                .1
                .cmp(&second.1)
                .then_with(|| cmp_utf16(&first.0, &second.0))
        });
        found
    }
}

/// `boundedWordDistance`
pub fn bounded_word_distance(first: &[u16], second: &[u16], maximum: usize) -> usize {
    let unreachable = maximum + 1;
    if first.len().abs_diff(second.len()) > maximum {
        return unreachable;
    }
    let mut previous: Vec<usize> = (0..=second.len())
        .map(|index| if index <= maximum { index } else { unreachable })
        .collect();
    let mut current = vec![unreachable; second.len() + 1];
    for first_index in 1..=first.len() {
        current.fill(unreachable);
        if first_index <= maximum {
            current[0] = first_index;
        }
        let from = first_index.saturating_sub(maximum).max(1);
        let to = second.len().min(first_index + maximum);
        let mut row_minimum = unreachable;
        for second_index in from..=to {
            let substitution = previous[second_index - 1]
                + usize::from(first[first_index - 1] != second[second_index - 1]);
            current[second_index] = (previous[second_index] + 1)
                .min(current[second_index - 1] + 1)
                .min(substitution);
            row_minimum = row_minimum.min(current[second_index]);
        }
        if row_minimum > maximum {
            return unreachable;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[second.len()]
}
