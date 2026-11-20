//! Spelling core shared by the web worker (wasm) and, later, the native desktop host.
//!
//! This is a port of `fanotes/src/lib/spelling.ts` (exact word list load and validation, Bloom
//! filter, German compound split), `spellingSuggest.ts` (correction candidates and the autocorrect
//! rule) and `neuralWordContext.ts` (the n-gram word context index). Every function keeps the
//! semantics of the TypeScript original, including JavaScript's UTF-16 code unit ordering and
//! indexing. The `check-spell-wasm-parity.mjs` script proves both agree on the shipped lexicon.
//!
//! The one thing not ported is ICU collation (`localeCompare`), which only breaks score ties.
//! `text::lite_collate` approximates it for native callers; the web wrapper re-sorts the ties
//! with `Intl` so the results are identical.

pub mod bloom;
pub mod context;
pub mod lexicon;
pub mod suggest;
pub mod text;
pub mod wordlist;

pub use bloom::Bloom;
pub use context::{ContextSnapshot, NgramIndex};
pub use lexicon::SpellLexicon;
pub use suggest::{
    decide_autocorrect, restore_word_case, suggest_all, Suggestion, SuggestionLexicon,
};
pub use text::Language;
pub use wordlist::{parse_word_list, SpellError};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bloom::Bloom;
    use crate::lexicon::splits_into_german_parts;
    use crate::text::{cmp_utf16, lite_collate, normalize_word};
    use std::cmp::Ordering;

    fn lexicon(words: &[&str]) -> SpellLexicon {
        let mut lexicon = SpellLexicon::new();
        let mut sorted: Vec<String> = words.iter().map(|word| word.to_string()).collect();
        sorted.sort_by(|a, b| cmp_utf16(a, b));
        lexicon.set_words(Language::De, sorted.clone());
        lexicon.set_words(Language::En, sorted);
        lexicon
    }

    #[test]
    fn normalizes_like_the_typescript_version() {
        assert_eq!(normalize_word("  ", Language::De), "  ");
        assert_eq!(normalize_word("'Strasse-", Language::De), "strasse");
        assert_eq!(normalize_word("GROSS", Language::De), "gross");
        assert_eq!(normalize_word("Gro\u{df}", Language::De), "gross");
        assert_eq!(normalize_word("Gro\u{df}", Language::En), "gro\u{df}");
        assert_eq!(normalize_word("A\u{308}pfel", Language::De), "\u{e4}pfel");
    }

    #[test]
    fn validates_word_lists() {
        let good = "ast\nbaum\nzug\n".as_bytes();
        assert_eq!(
            parse_word_list(good, Language::De, good.len(), 3).unwrap(),
            vec!["ast", "baum", "zug"]
        );
        let check = |text: &str, count: usize| {
            parse_word_list(text.as_bytes(), Language::De, text.len(), count)
        };
        assert_eq!(check("ast\nbaum", 2), Err(SpellError::Incomplete));
        assert_eq!(check("ast\nbaum\n", 3), Err(SpellError::WrongCount));
        assert_eq!(
            check("baum\nast\n", 2),
            Err(SpellError::InvalidEntry),
            "unsorted"
        );
        assert_eq!(
            check("ast\nast\n", 2),
            Err(SpellError::InvalidEntry),
            "duplicate"
        );
        assert_eq!(
            check("ab\nast\n", 2),
            Err(SpellError::InvalidEntry),
            "too short"
        );
        assert_eq!(
            check("Ast\nbaum\n", 2),
            Err(SpellError::InvalidEntry),
            "not normalised"
        );
        assert_eq!(
            check("gro\u{df}\nzug\n", 2),
            Err(SpellError::InvalidEntry),
            "sharp s must be folded"
        );
        assert_eq!(
            check("ast1\nbaum\n", 2),
            Err(SpellError::InvalidEntry),
            "digit"
        );
        assert_eq!(
            parse_word_list(good, Language::De, good.len() + 1, 3),
            Err(SpellError::InvalidLength)
        );
    }

    #[test]
    fn orders_like_javascript_strings() {
        // U+FF5E (BMP) sorts after U+1F600 (astral, surrogate D83D) in UTF-16 order, before it in UTF-8.
        assert_eq!(cmp_utf16("\u{ff5e}", "\u{1f600}"), Ordering::Greater);
        assert_eq!(lite_collate("\u{e4}", "b"), Ordering::Less);
    }

    #[test]
    fn suggests_swiss_and_german_candidates() {
        let lexicon = lexicon(&[
            "strasse", "nicht", "nichte", "haus", "hause", "auch", "das", "schule", "fenster",
        ]);
        let top = |typed: &str| {
            suggest_all(typed, &[Language::De], &lexicon, 2)
                .into_iter()
                .map(|s| s.word)
                .collect::<Vec<_>>()
        };
        assert_eq!(top("Strase")[0], "Strasse");
        assert_eq!(top("nciht")[0], "nicht");
        assert_eq!(top("Schle")[0], "Schule");
        assert!(top("auchdas").contains(&"auch das".to_string()));
        assert!(
            top("HAUSS").contains(&"HAUS".to_string()),
            "all caps stays all caps"
        );
    }

    #[test]
    fn autocorrect_is_conservative() {
        let lexicon = lexicon(&["nicht", "nichte", "fenster", "haus", "hause"]);
        let decide_for = |typed: &str, name: bool| {
            let suggestions = suggest_all(typed, &[Language::De], &lexicon, 1);
            decide_autocorrect(typed, &suggestions, Some(Language::De), true, name)
                .map(|index| suggestions[index].word.clone())
        };
        assert_eq!(decide_for("fenstr", false), Some("fenster".to_string()));
        assert_eq!(decide_for("Fenstr", false), Some("Fenster".to_string()));
        assert_eq!(decide_for("fenstr", true), None);
        assert_eq!(decide_for("FeNstr", false), None);
        assert_eq!(decide_for("ab", false), None);
    }

    #[test]
    fn splits_compounds_into_exact_parts() {
        let has = |part: &str| ["haus", "tuer", "schluessel"].contains(&part);
        assert!(splits_into_german_parts("Haustuer", &has));
        assert!(splits_into_german_parts(
            "Hausschl\u{fc}ssel".replace('\u{fc}', "ue").as_str(),
            &has
        ));
        assert!(!splits_into_german_parts("Haustuerx", &has));
        assert!(!splits_into_german_parts("haus", &has), "too short");
    }

    #[test]
    fn bloom_matches_the_hash_scheme() {
        // Insert "haus" the way the generator does and read it back.
        let bit_count = 1024u64;
        let mut bytes = vec![0u8; 128];
        let hash = |word: &str, seed: u32| {
            word.encode_utf16()
                .fold(seed, |h, u| (h ^ u32::from(u)).wrapping_mul(0x0100_0193))
        };
        let (first, second) = (hash("haus", 0x811c_9dc5), hash("haus", 0x9e37_79b1) | 1);
        for index in 0..8u32 {
            let bit = u64::from(first.wrapping_add(index.wrapping_mul(second))) % bit_count;
            bytes[(bit >> 3) as usize] |= 1 << (bit & 7);
        }
        let bloom = Bloom::new(bytes, bit_count, 8).unwrap();
        assert!(bloom.has("Haus", Language::De));
        assert!(!bloom.has("katze", Language::De));
    }

    #[test]
    fn context_index_scores_and_finds_words() {
        let words: Vec<String> = ["ast", "baum", "baumhaus", "haus", "hause"]
            .iter()
            .map(|w| w.to_string())
            .collect();
        let index = NgramIndex::build(&words);
        assert!(index.is_extended_word("haus"));
        assert!(!index.is_extended_word("hau"));
        assert!(index.character_sequence_score("haus") > index.character_sequence_score("xqzv"));
        assert_eq!(
            index.words_of_length(4),
            ["baum".to_string(), "haus".to_string()]
        );
        let near = index.nearest_all("hous", 1, false);
        assert_eq!(near[0], ("haus".to_string(), 1));
        assert!(index.character_subword_score("baumhaus") > 0.0);
    }

    #[test]
    fn snapshot_carries_buckets_and_grams() {
        let words: Vec<String> = ["zug", "ast", "haus", "baum", "\u{e4}ste", "baumhaus"]
            .iter()
            .map(|word| word.to_string())
            .collect();
        let snapshot = NgramIndex::build(&words).snapshot().unwrap();
        assert_eq!(
            snapshot.buckets,
            vec![
                (3, "ast\nzug".to_string()),
                (4, "baum\nhaus\n\u{e4}ste".to_string()),
                (8, "baumhaus".to_string()),
            ]
        );
        assert!(snapshot.bigrams.contains(&("^z".to_string(), 1)));
        assert!(snapshot.bigrams.contains(&("au".to_string(), 4)));
        assert!(snapshot.trigrams.contains(&("aus".to_string(), 2)));
        assert!(snapshot.prefixes.contains(&"baumh".to_string()));
        assert!(snapshot.prefixes.contains(&"haus".to_string()));
        assert!(snapshot.suffixes.contains(&"mhaus".to_string()));
    }
}
