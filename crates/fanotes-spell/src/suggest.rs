//! Correction candidates and the autocorrect rule of `spellingSuggest.ts`.

use crate::text::{
    all_letters, is_letter, lite_collate, lowercase, normalized_form, units, uppercase, Language,
};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    /// Replacement with the casing of the typed word restored.
    pub word: String,
    pub distance: u8,
    /// Lower is likelier.
    pub score: i32,
    pub language: Language,
}

pub trait SuggestionLexicon {
    fn has_word(&self, language: Language, normalized: &str) -> bool;
    fn candidate_penalty(&self, language: Language, normalized: &str) -> i32;
}

const ALPHABET_DE: &str = "abcdefghijklmnopqrstuvwxyzäöü";
const ALPHABET_EN: &str = "abcdefghijklmnopqrstuvwxyz";
const KEY_ROWS: [&str; 3] = ["qwertzuiopü", "asdfghjklöä", "yxcvbnm"];
const KEY_ROW_OFFSETS: [f64; 3] = [0.0, 0.5, 1.5];
const COMMON_WORD_BONUS: i32 = 25;
const MAX_DISTANCE_TWO_PROBES: usize = 60_000;
const COMMON_DE: &str = "der die das und ist in den von zu mit sich des auf für nicht ein eine einer eines einem einen als auch es an werden aus er hat dass sie nach wird bei noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei wenn ich wir ihr euch uns mir mich dir dich kann können muss müssen soll sollen will wollen darf dürfen mag mögen heute morgen gestern dann denn doch schon sehr viel viele wenig mal jetzt hier dort immer nie wieder alle alles etwas nichts keine kein was wer wo wann warum welche welcher welches dieser diese dieses jener seine ihre unser unsere ihrer seiner haus hause schule schüler lehrer aufgabe aufgaben stunde stunden woche wochen tag tage jahr jahre zeit mensch menschen leben arbeit text buch seite frage antwort beispiel wichtig gut schlecht neu alt gross klein lang kurz";
const COMMON_EN: &str = "the of and to in a is that for it as was with be by on not he i this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no she about their them than then some into only other could time these two may first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three";

fn common_words(language: Language) -> &'static HashSet<&'static str> {
    static SETS: OnceLock<[HashSet<&'static str>; 2]> = OnceLock::new();
    &SETS.get_or_init(|| {
        [
            COMMON_DE.split(' ').collect(),
            COMMON_EN.split(' ').collect(),
        ]
    })[language.index()]
}

fn alphabet(language: Language) -> &'static str {
    match language {
        Language::De => ALPHABET_DE,
        Language::En => ALPHABET_EN,
    }
}

/// Swiss/German QWERTZ neighbours; y and z are also neighbours of each other. Order follows the
/// insertion order of the TypeScript `Set`s.
fn key_neighbours() -> &'static HashMap<char, Vec<char>> {
    static NEIGHBOURS: OnceLock<HashMap<char, Vec<char>>> = OnceLock::new();
    NEIGHBOURS.get_or_init(|| {
        let mut positions: Vec<(char, usize, f64)> = Vec::new();
        for (row_index, row) in KEY_ROWS.iter().enumerate() {
            for (column, key) in row.chars().enumerate() {
                positions.push((key, row_index, column as f64 + KEY_ROW_OFFSETS[row_index]));
            }
        }
        let mut neighbours: HashMap<char, Vec<char>> = HashMap::new();
        for (key, row, column) in &positions {
            let near = positions
                .iter()
                .filter(|(other, other_row, other_column)| {
                    other != key
                        && row.abs_diff(*other_row) <= 1
                        && (column - other_column).abs() <= 1.0
                })
                .map(|(other, _, _)| *other)
                .collect();
            neighbours.insert(*key, near);
        }
        for (from, to) in [('y', 'z'), ('z', 'y')] {
            let list = neighbours.get_mut(&from).expect("key exists");
            if !list.contains(&to) {
                list.push(to);
            }
        }
        neighbours
    })
}

fn umlaut_pair(character: char) -> Option<char> {
    match character {
        'a' => Some('ä'),
        'ä' => Some('a'),
        'o' => Some('ö'),
        'ö' => Some('o'),
        'u' => Some('ü'),
        'ü' => Some('u'),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    Transpose,
    Double,
    Near,
    Umlaut,
    Delete,
    Insert,
    Replace,
}

impl EditKind {
    pub fn cost(self) -> i32 {
        match self {
            Self::Transpose => 0,
            Self::Double | Self::Near | Self::Umlaut => 1,
            Self::Delete | Self::Insert => 2,
            Self::Replace => 3,
        }
    }
}

pub struct Edit {
    pub word: String,
    pub kind: EditKind,
}

fn join(letters: &[char]) -> String {
    letters.iter().collect()
}

/// `editsAtDistanceOne`, same edit order as the TypeScript version.
pub fn edits_at_distance_one(word: &str, alphabet: &str, likely_only: bool) -> Vec<Edit> {
    let letters: Vec<char> = word.chars().collect();
    let neighbours = key_neighbours();
    let mut edits = Vec::new();
    for index in 0..letters.len() {
        let before = join(&letters[..index]);
        let after = join(&letters[index + 1..]);
        let removed = letters[index];
        let doubled = (index > 0 && letters[index - 1] == removed)
            || letters.get(index + 1) == Some(&removed);
        edits.push(Edit {
            word: format!("{before}{after}"),
            kind: if doubled {
                EditKind::Double
            } else {
                EditKind::Delete
            },
        });
        if index + 1 < letters.len() && letters[index] != letters[index + 1] {
            edits.push(Edit {
                word: format!(
                    "{before}{}{}{}",
                    letters[index + 1],
                    letters[index],
                    join(&letters[index + 2..])
                ),
                kind: EditKind::Transpose,
            });
        }
        edits.push(Edit {
            word: format!("{before}{removed}{removed}{after}"),
            kind: EditKind::Double,
        });
        let umlaut = umlaut_pair(removed);
        if let Some(umlaut) = umlaut {
            if alphabet.contains(umlaut) {
                edits.push(Edit {
                    word: format!("{before}{umlaut}{after}"),
                    kind: EditKind::Umlaut,
                });
            }
        }
        let near_keys = neighbours.get(&removed);
        for near in near_keys.into_iter().flatten() {
            if alphabet.contains(*near) && umlaut != Some(*near) {
                edits.push(Edit {
                    word: format!("{before}{near}{after}"),
                    kind: EditKind::Near,
                });
            }
        }
        if likely_only {
            continue;
        }
        for letter in alphabet.chars() {
            if letter == removed
                || umlaut == Some(letter)
                || near_keys.is_some_and(|near| near.contains(&letter))
            {
                continue;
            }
            edits.push(Edit {
                word: format!("{before}{letter}{after}"),
                kind: EditKind::Replace,
            });
        }
    }
    if likely_only {
        return edits;
    }
    for index in 0..=letters.len() {
        let before = join(&letters[..index]);
        let after = join(&letters[index..]);
        for letter in alphabet.chars() {
            if (index > 0 && letters[index - 1] == letter) || letters.get(index) == Some(&letter) {
                continue;
            }
            edits.push(Edit {
                word: format!("{before}{letter}{after}"),
                kind: EditKind::Insert,
            });
        }
    }
    edits
}

/// `restoreWordCase`
pub fn restore_word_case(typed: &str, replacement: &str, language: Language) -> String {
    let letters: Vec<char> = typed
        .chars()
        .filter(|character| is_letter(*character))
        .collect();
    let is_upper = |character: char| {
        let text = character.to_string();
        uppercase(&text) == text && lowercase(&text) != text
    };
    if letters.len() > 1 && letters.iter().all(|character| is_upper(*character)) {
        return uppercase(replacement);
    }
    let _ = language;
    if let Some(first) = letters.first() {
        if is_upper(*first) {
            let mut characters = replacement.chars();
            return match characters.next() {
                Some(head) => format!("{}{}", uppercase(&head.to_string()), characters.as_str()),
                None => String::new(),
            };
        }
    }
    replacement.to_string()
}

fn from_units(slice: &[u16]) -> Option<String> {
    String::from_utf16(slice).ok()
}

/// All results of `suggestCorrections` before the final sort and `limit`: the TypeScript code
/// sorts by score and breaks ties with ICU `localeCompare`. Callers with `Intl` re-sort ties;
/// this function orders them with `lite_collate`.
pub fn suggest_all(
    typed: &str,
    languages: &[Language],
    lexicon: &dyn SuggestionLexicon,
    max_distance: u8,
) -> Vec<Suggestion> {
    let mut results = Results::default();
    for &language in languages {
        let lower = normalized_form(typed, language);
        if !all_letters(&lower) {
            continue;
        }
        let lower_units = units(&lower);
        let alphabet = alphabet(language);
        let common = common_words(language);
        let consider = |results: &mut Results, candidate: &str, distance: u8, cost: i32| {
            if candidate.is_empty() || candidate == lower || !lexicon.has_word(language, candidate)
            {
                return;
            }
            let candidate_units = units(candidate);
            let first_letter_penalty =
                i32::from(candidate_units.first() != lower_units.first()) * 5;
            let length_penalty = candidate_units.len().abs_diff(lower_units.len()) as i32;
            let bonus = if common.contains(candidate) {
                COMMON_WORD_BONUS
            } else {
                0
            };
            let uncertainty = lexicon.candidate_penalty(language, candidate);
            let score =
                i32::from(distance) * 100 + cost * 10 + first_letter_penalty + length_penalty
                    - bonus
                    + uncertainty;
            let restored = restore_word_case(typed, candidate, language);
            results.offer(Suggestion {
                word: restored,
                distance,
                score,
                language,
            });
        };
        let first_edits = edits_at_distance_one(&lower, alphabet, false);
        for edit in &first_edits {
            consider(&mut results, &edit.word, 1, edit.kind.cost());
        }
        // "auchdas" -> "auch das": a missing space between two known words.
        if lower_units.len() >= 4 {
            for split in 2..=lower_units.len() - 2 {
                let (Some(head), Some(tail)) = (
                    from_units(&lower_units[..split]),
                    from_units(&lower_units[split..]),
                ) else {
                    continue;
                };
                let listed = |part: &str| {
                    lexicon.has_word(language, part)
                        && lexicon.candidate_penalty(language, part) == 0
                };
                if listed(&head) && listed(&tail) {
                    let restored = format!("{} {tail}", restore_word_case(typed, &head, language));
                    let common_count = i32::from(common.contains(head.as_str()))
                        + i32::from(common.contains(tail.as_str()));
                    if !results.contains(&restored) {
                        results.offer(Suggestion {
                            word: restored,
                            distance: 1,
                            score: 100 + EditKind::Double.cost() * 10 + 2 - common_count * 4,
                            language,
                        });
                    }
                }
            }
        }
        let found_at_one = results
            .items
            .iter()
            .filter(|item| item.language == language && item.distance == 1)
            .count();
        if max_distance >= 2 && lower_units.len() >= 5 && found_at_one < 2 {
            let mut seen: HashSet<String> = HashSet::new();
            let mut probes = 0usize;
            let mut ordered: Vec<&Edit> = first_edits.iter().collect();
            ordered.sort_by_key(|edit| edit.kind.cost());
            'outer: for first in ordered {
                for second in edits_at_distance_one(&first.word, alphabet, true) {
                    if !seen.insert(second.word.clone()) {
                        continue;
                    }
                    probes += 1;
                    if probes > MAX_DISTANCE_TWO_PROBES {
                        break 'outer;
                    }
                    consider(
                        &mut results,
                        &second.word,
                        2,
                        first.kind.cost() + second.kind.cost(),
                    );
                }
            }
        }
    }
    let mut items = results.items;
    items.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| lite_collate(&left.word, &right.word))
    });
    items
}

/// Insertion-ordered results keyed by the restored word, like the TypeScript `Map`.
#[derive(Default)]
struct Results {
    items: Vec<Suggestion>,
    index_of: HashMap<String, usize>,
}

impl Results {
    fn contains(&self, word: &str) -> bool {
        self.index_of.contains_key(word)
    }

    /// Adds the suggestion, or replaces an existing one with a worse score.
    fn offer(&mut self, suggestion: Suggestion) {
        match self.index_of.get(&suggestion.word) {
            Some(&position) => {
                if self.items[position].score > suggestion.score {
                    self.items[position] = suggestion;
                }
            }
            None => {
                self.index_of
                    .insert(suggestion.word.clone(), self.items.len());
                self.items.push(suggestion);
            }
        }
    }
}

/// The rule that decides whether a candidate is sure enough to apply while typing
/// (`decideAutocorrect`). `is_proper_name` is the answer for `normalized_form(typed, En)`.
/// Returns the index into `suggestions`.
pub fn decide_autocorrect(
    typed: &str,
    suggestions: &[Suggestion],
    language: Option<Language>,
    sentence_start: bool,
    is_proper_name: bool,
) -> Option<usize> {
    let length = typed.encode_utf16().count();
    if !(3..=24).contains(&length) || !all_letters(typed) {
        return None;
    }
    let letters: Vec<char> = typed.chars().collect();
    let upper: Vec<char> = letters
        .iter()
        .copied()
        .filter(|letter| {
            let text = letter.to_string();
            text != lowercase(&text) && text == uppercase(&text)
        })
        .collect();
    // Acronyms and camelCase are deliberate spellings.
    if upper.len() > 1 {
        return None;
    }
    let capitalised = upper.len() == 1 && letters[0] == upper[0];
    if upper.len() == 1 && !capitalised {
        return None;
    }
    if is_proper_name {
        return None;
    }
    if capitalised && language == Some(Language::En) && !sentence_start {
        return None;
    }
    let mut nearest = suggestions
        .iter()
        .enumerate()
        .filter(|(_, suggestion)| suggestion.distance == 1 && !suggestion.word.contains(' '));
    let (best_index, best) = nearest.next()?;
    if best.score >= 100 + EditKind::Replace.cost() * 10 {
        return None;
    }
    if let Some((_, runner_up)) = nearest.next() {
        if runner_up.score - best.score < 20 {
            return None;
        }
    }
    Some(best_index)
}
