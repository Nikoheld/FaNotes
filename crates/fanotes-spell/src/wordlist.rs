//! Load and validation of the exhaustive OCR word lists (`de.words`, `en.words`).

use crate::text::{cmp_utf16, is_letter, normalize_word, Language};
use std::cmp::Ordering;
use std::fmt;

pub const MAX_WORD_LIST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum SpellError {
    InvalidLength,
    NotUtf8,
    Incomplete,
    WrongCount,
    InvalidEntry,
}

impl fmt::Display for SpellError {
    /// The same texts as the TypeScript loader.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidLength => "Die OCR-Wortliste besitzt eine ungültige Länge.",
            Self::NotUtf8 => "Die OCR-Wortliste ist kein gültiges UTF-8.",
            Self::Incomplete => "Die OCR-Wortliste ist unvollständig.",
            Self::WrongCount => "Die OCR-Wortlistenanzahl ist ungültig.",
            Self::InvalidEntry => "Die OCR-Wortliste enthält einen ungültigen Eintrag.",
        })
    }
}

impl std::error::Error for SpellError {}

fn is_normalized(word: &str, language: Language) -> bool {
    // Plain lower-case ASCII is its own normal form; skip the allocation for most words.
    word.bytes().all(|byte| byte.is_ascii_lowercase()) || word == normalize_word(word, language)
}

/// `/^\p{L}{3,32}$/u`
pub fn is_candidate_word(word: &str) -> bool {
    let length = word.chars().count();
    (3..=32).contains(&length) && word.chars().all(is_letter)
}

/// Decodes and validates a word list: exact size, UTF-8, trailing newline, word count, and for
/// every word strictly ascending (UTF-16 order), already normalised, 3 to 32 letters.
pub fn parse_word_list(
    bytes: &[u8],
    language: Language,
    expected_size: usize,
    expected_count: usize,
) -> Result<Vec<String>, SpellError> {
    if bytes.len() != expected_size || bytes.len() > MAX_WORD_LIST_BYTES {
        return Err(SpellError::InvalidLength);
    }
    let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let decoded = std::str::from_utf8(body).map_err(|_| SpellError::NotUtf8)?;
    let Some(without_newline) = decoded.strip_suffix('\n') else {
        return Err(SpellError::Incomplete);
    };
    let words: Vec<&str> = without_newline.split('\n').collect();
    if words.len() != expected_count {
        return Err(SpellError::WrongCount);
    }
    let mut previous = "";
    for word in &words {
        if cmp_utf16(word, previous) != Ordering::Greater
            || !is_normalized(word, language)
            || !is_candidate_word(word)
        {
            return Err(SpellError::InvalidEntry);
        }
        previous = word;
    }
    Ok(words.into_iter().map(str::to_string).collect())
}
