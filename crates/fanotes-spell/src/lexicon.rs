//! The loaded lexicon: exact word lists, Bloom filters, the user's words and the n-gram index.

use crate::bloom::Bloom;
use crate::context::NgramIndex;
use crate::suggest::SuggestionLexicon;
use crate::text::{all_letters, normalize_word, Language};
use std::collections::HashSet;

#[derive(Default)]
pub struct SpellLexicon {
    words: [Option<HashSet<String>>; 2],
    word_lists: [Option<Vec<String>>; 2],
    bloom: [Option<Bloom>; 2],
    user: HashSet<String>,
    index: [Option<NgramIndex>; 2],
}

/// `splitsIntoGermanParts`: the word is two to six parts of 3 to 24 letters that `has_part`
/// accepts. Works on UTF-16 code units like the TypeScript code.
pub fn splits_into_german_parts(raw_word: &str, has_part: &dyn Fn(&str) -> bool) -> bool {
    let word = normalize_word(raw_word, Language::De);
    let units: Vec<u16> = word.encode_utf16().collect();
    if units.len() < 8 || units.len() > 64 || !all_letters(&word) {
        return false;
    }
    let mut memo: std::collections::HashMap<(usize, usize), bool> =
        std::collections::HashMap::new();
    fn find(
        units: &[u16],
        offset: usize,
        parts: usize,
        has_part: &dyn Fn(&str) -> bool,
        memo: &mut std::collections::HashMap<(usize, usize), bool>,
    ) -> bool {
        if offset == units.len() {
            return parts >= 2;
        }
        if parts >= 6 || units.len() - offset < 3 {
            return false;
        }
        if let Some(cached) = memo.get(&(offset, parts)) {
            return *cached;
        }
        let maximum = units.len().min(offset + 24);
        for end in offset + 3..=maximum {
            if end < units.len() && units.len() - end < 3 {
                continue;
            }
            let accepted =
                String::from_utf16(&units[offset..end]).is_ok_and(|part| has_part(&part));
            if accepted && find(units, end, parts + 1, has_part, memo) {
                memo.insert((offset, parts), true);
                return true;
            }
        }
        memo.insert((offset, parts), false);
        false
    }
    find(&units, 0, 0, has_part, &mut memo)
}

impl SpellLexicon {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_words(&mut self, language: Language, words: Vec<String>) {
        self.words[language.index()] = Some(words.iter().cloned().collect());
        self.word_lists[language.index()] = Some(words);
        self.index[language.index()] = None;
    }

    pub fn set_bloom(&mut self, language: Language, bloom: Bloom) {
        self.bloom[language.index()] = Some(bloom);
    }

    /// Replaces the words the user vouched for (already `normalizeForDictionary`-normalised).
    pub fn set_user_words(&mut self, words: impl IntoIterator<Item = String>) {
        self.user = words.into_iter().collect();
    }

    pub fn is_loaded(&self, language: Language) -> bool {
        self.words[language.index()].is_some()
    }

    pub fn languages(&self) -> Vec<Language> {
        [Language::De, Language::En]
            .into_iter()
            .filter(|language| self.is_loaded(*language))
            .collect()
    }

    /// Builds (once) the n-gram index of a loaded language.
    pub fn context(&mut self, language: Language) -> Option<&NgramIndex> {
        let slot = language.index();
        if self.index[slot].is_none() {
            let words = self.word_lists[slot].as_ref()?;
            self.index[slot] = Some(NgramIndex::build(words));
        }
        self.index[slot].as_ref()
    }

    fn listed(&self, language: Language, normalized: &str) -> bool {
        self.words[language.index()]
            .as_ref()
            .is_some_and(|words| words.contains(normalized))
            || self.user.contains(normalized)
    }

    fn exact_german_part(&self, part: &str) -> bool {
        self.words[Language::De.index()]
            .as_ref()
            .is_some_and(|words| words.contains(part))
    }
}

impl SuggestionLexicon for SpellLexicon {
    /// A word when the exact list (or the user) has it, or a German compound of exact list words.
    fn has_word(&self, language: Language, normalized: &str) -> bool {
        self.listed(language, normalized)
            || (language == Language::De
                && splits_into_german_parts(normalized, &|part| self.exact_german_part(part)))
    }

    /// Extra score for words accepted less than certainly: 0 listed, 4 known to the Bloom filter
    /// only, 15 otherwise.
    fn candidate_penalty(&self, language: Language, normalized: &str) -> i32 {
        if self.listed(language, normalized) {
            return 0;
        }
        match &self.bloom[language.index()] {
            Some(bloom) if bloom.has(normalized, language) => 4,
            _ => 15,
        }
    }
}
