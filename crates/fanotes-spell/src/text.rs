//! Text helpers that reproduce JavaScript string semantics.

use std::cmp::Ordering;
use unicode_general_category::{get_general_category, GeneralCategory as Category};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Language {
    De,
    En,
}

impl Language {
    pub fn parse(code: &str) -> Option<Self> {
        match code {
            "de" => Some(Self::De),
            "en" => Some(Self::En),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::De => "de",
            Self::En => "en",
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::De => 0,
            Self::En => 1,
        }
    }
}

/// `\p{L}`
pub fn is_letter(character: char) -> bool {
    matches!(
        get_general_category(character),
        Category::UppercaseLetter
            | Category::LowercaseLetter
            | Category::TitlecaseLetter
            | Category::ModifierLetter
            | Category::OtherLetter
    )
}

/// `/^\p{L}+$/u`
pub fn all_letters(text: &str) -> bool {
    !text.is_empty() && text.chars().all(is_letter)
}

pub fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// JavaScript `<` on strings: UTF-16 code unit order.
pub fn cmp_utf16(first: &str, second: &str) -> Ordering {
    first.encode_utf16().cmp(second.encode_utf16())
}

/// `toLocaleLowerCase('de-CH' | 'en-US')`: neither locale has tailoring over the default mapping.
pub fn lowercase(text: &str) -> String {
    text.to_lowercase()
}

pub fn uppercase(text: &str) -> String {
    text.to_uppercase()
}

fn is_edge_mark(character: char) -> bool {
    matches!(character, '\'' | '\u{2019}' | '-')
}

/// `normalizeWord` of `spelling.ts`: NFC, lower case, edge apostrophes and hyphens stripped, and
/// for German ß folded to ss.
pub fn normalize_word(word: &str, language: Language) -> String {
    let composed: String = word.nfc().collect();
    let lower = lowercase(&composed);
    let trimmed = lower.trim_matches(is_edge_mark);
    match language {
        Language::De => trimmed.replace('ß', "ss"),
        Language::En => trimmed.to_string(),
    }
}

/// `normalizedForm` of `spellingSuggest.ts`: like `normalize_word` without the edge trimming.
pub fn normalized_form(word: &str, language: Language) -> String {
    let composed: String = word.nfc().collect();
    let lower = lowercase(&composed);
    match language {
        Language::De => lower.replace('ß', "ss"),
        Language::En => lower,
    }
}

/// Approximation of ICU `de` collation for score ties when no `Intl` is around: letters compare
/// without accents and case first, then by accent, then lower case before upper case.
pub fn lite_collate(first: &str, second: &str) -> Ordering {
    let base = |text: &str| -> Vec<char> {
        text.nfd()
            .filter(|character| get_general_category(*character) != Category::NonspacingMark)
            .flat_map(char::to_lowercase)
            .collect()
    };
    let accents = |text: &str| -> Vec<char> { text.nfd().flat_map(char::to_lowercase).collect() };
    base(first)
        .cmp(&base(second))
        .then_with(|| accents(first).cmp(&accents(second)))
        .then_with(|| {
            let case_key = |text: &str| -> Vec<bool> {
                text.chars()
                    .map(|character| character.is_uppercase())
                    .collect()
            };
            case_key(first).cmp(&case_key(second))
        })
}
