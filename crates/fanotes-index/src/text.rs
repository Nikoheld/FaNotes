//! Folding, query parsing and snippets: a port of `fanotes/src/lib/docSearch/text.ts`.
//!
//! JavaScript strings are UTF-16, and the TypeScript code indexes, slices and
//! maps origins in UTF-16 code units. Everything here works on `&[u16]` so
//! offsets, highlight ranges and slice boundaries are the same numbers the
//! renderer sees. Rules (from the TS module, shared with Kanti+): "Straße" =
//! "STRASSE" = "strasse", "Übung" = "Uebung" = "ubung", ligatures and
//! diacritics fold to their base letters, a word hyphenated across a line
//! break is joined, punctuation is a space.

use std::cell::RefCell;
use std::collections::HashMap;

use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use icu_properties::CodePointMapData;
use unicode_normalization::UnicodeNormalization;

pub const MAX_QUERY_TERMS: usize = 8;

/// Folded text plus, for every folded unit, the index of the original unit it came from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FoldedText {
    pub text: Vec<u16>,
    pub origin: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Snippet {
    pub text: String,
    /// `[start, end)` UTF-16 offsets into `text` of matched words.
    pub highlights: Vec<[u32; 2]>,
    /// Number of matched words in the whole text.
    pub matched: u32,
}

const SPACE: u16 = b' ' as u16;

fn category(c: char) -> GeneralCategory {
    CodePointMapData::<GeneralCategory>::new().get(c)
}

/// `/\p{L}/u`
pub fn is_letter(c: char) -> bool {
    GeneralCategoryGroup::Letter.contains(category(c))
}

/// `/\p{M}/u`
fn is_mark(c: char) -> bool {
    GeneralCategoryGroup::Mark.contains(category(c))
}

/// `/[\p{L}\p{N}]/u`
fn is_letter_or_digit(c: char) -> bool {
    let gc = category(c);
    GeneralCategoryGroup::Letter.contains(gc) || GeneralCategoryGroup::Number.contains(gc)
}

fn unit_char(unit: u16) -> Option<char> {
    char::from_u32(unit as u32)
}

/// `/\p{L}/u.test(raw[i])` for one UTF-16 unit (a lone surrogate is no letter).
fn is_letter_unit(unit: u16) -> bool {
    unit_char(unit).is_some_and(is_letter)
}

/// `c !== c.toLocaleUpperCase('de-DE') && c === c.toLocaleLowerCase('de-DE')` for one unit.
fn is_lower_letter_unit(unit: u16) -> bool {
    let Some(c) = unit_char(unit) else {
        return false;
    };
    let upper_differs = {
        let mut upper = c.to_uppercase();
        !(upper.len() == 1 && upper.next() == Some(c))
    };
    let lower_same = {
        let mut lower = c.to_lowercase();
        lower.len() == 1 && lower.next() == Some(c)
    };
    upper_differs && lower_same
}

/// JavaScript `\s` and the set `String.prototype.trim` removes.
pub fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

thread_local! {
    static FOLD_CACHE: RefCell<HashMap<u32, Box<[u16]>>> = RefCell::new(HashMap::new());
}

/// `foldChar` for one code point at or above U+0080 (or a lone surrogate).
fn fold_code_point(code_point: u32) -> Box<[u16]> {
    if let Some(cached) = FOLD_CACHE.with(|cache| cache.borrow().get(&code_point).cloned()) {
        return cached;
    }
    let folded: Box<[u16]> = match char::from_u32(code_point) {
        // A lone surrogate is neither a mark nor a letter.
        None => vec![SPACE].into_boxed_slice(),
        Some('ß') | Some('ẞ') => vec![b's' as u16, b's' as u16].into_boxed_slice(),
        Some(c) => {
            let mut kept: Vec<u16> = Vec::new();
            let mut buffer = [0u16; 2];
            for part in std::iter::once(c).nfkd() {
                if is_mark(part) {
                    continue;
                }
                if part == 'ß' {
                    kept.extend([b's' as u16, b's' as u16]);
                } else if is_letter_or_digit(part) {
                    for lower in part.to_lowercase() {
                        kept.extend_from_slice(lower.encode_utf16(&mut buffer));
                    }
                } else {
                    kept.push(SPACE);
                }
            }
            if kept.is_empty() {
                kept.push(SPACE);
            }
            kept.into_boxed_slice()
        }
    };
    FOLD_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() < 65_536 {
            cache.insert(code_point, folded.clone());
        }
    });
    folded
}

pub fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub fn from_utf16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

struct Folder<'a> {
    raw: &'a [u16],
    out: Vec<u16>,
    origin: Vec<u32>,
    last: u16,
}

impl Folder<'_> {
    fn push(&mut self, unit: u16, from: usize) {
        if unit == SPACE && (self.out.is_empty() || self.last == SPACE) {
            return;
        }
        // German digraphs: the "e" of ae/oe/ue is dropped on both sides of a match.
        if unit == b'e' as u16 && matches!(self.last, 0x61 | 0x6f | 0x75) && from > 0 {
            let previous = self.raw[from - 1] | 32;
            if matches!(previous, 97 | 111 | 117) {
                return;
            }
        }
        self.out.push(unit);
        self.origin.push(from as u32);
        self.last = unit;
    }
}

/// `foldSearch(raw)`.
pub fn fold_search(raw: &[u16]) -> FoldedText {
    let end = raw.len();
    let mut folder = Folder {
        raw,
        out: Vec::with_capacity(raw.len()),
        origin: Vec::with_capacity(raw.len()),
        last: 0,
    };
    let mut index = 0;
    while index < end {
        let code = raw[index];
        if (97..=122).contains(&code) || (48..=57).contains(&code) {
            folder.push(code, index);
            index += 1;
            continue;
        }
        if (65..=90).contains(&code) {
            folder.push(code + 32, index);
            index += 1;
            continue;
        }
        if code == 0x00ad {
            index += 1;
            continue;
        }
        if code == b'-' as u16 && index > 0 && is_letter_unit(raw[index - 1]) {
            let mut next = index + 1;
            while next < end && matches!(raw[next], 0x20 | 0x09 | 0x0d) {
                next += 1;
            }
            if next < end && raw[next] == 0x0a {
                let mut after = next + 1;
                while after < end && matches!(raw[after], 0x20 | 0x09) {
                    after += 1;
                }
                if after < end && is_lower_letter_unit(raw[after]) {
                    index = after;
                    continue;
                }
            }
        }
        if code < 128 {
            folder.push(SPACE, index);
            index += 1;
            continue;
        }
        // Astral characters are one code point but two UTF-16 units.
        let (code_point, width) = if (0xd800..0xdc00).contains(&code)
            && index + 1 < raw.len()
            && (0xdc00..0xe000).contains(&raw[index + 1])
        {
            (
                0x10000 + (((code as u32) - 0xd800) << 10) + ((raw[index + 1] as u32) - 0xdc00),
                2,
            )
        } else {
            (code as u32, 1)
        };
        let folded = fold_code_point(code_point);
        for &unit in folded.iter() {
            folder.push(unit, index);
        }
        index += width;
    }
    while folder.out.last() == Some(&SPACE) {
        folder.out.pop();
        folder.origin.pop();
    }
    FoldedText {
        text: folder.out,
        origin: folder.origin,
    }
}

pub fn fold_plain(raw: &str) -> String {
    from_utf16(&fold_search(&utf16(raw)).text)
}

pub fn fold_plain_units(raw: &[u16]) -> Vec<u16> {
    fold_search(raw).text
}

/// `tokenize(folded)`: words of folded text.
pub fn tokenize(folded: &[u16]) -> impl Iterator<Item = &[u16]> {
    folded
        .split(|&unit| unit == SPACE)
        .filter(|token| !token.is_empty())
}

/// `parseDocQuery(raw).terms`: folded, distinct terms, at most 8.
pub fn parse_doc_query(raw: &str) -> Vec<Vec<u16>> {
    let units = utf16(raw);
    let head = &units[..units.len().min(200)];
    let folded = fold_plain_units(head);
    let mut terms: Vec<Vec<u16>> = Vec::new();
    for token in tokenize(&folded) {
        if !terms.iter().any(|known| known == token) {
            terms.push(token.to_vec());
        }
    }
    terms.truncate(MAX_QUERY_TERMS);
    terms
}

pub fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return if from <= haystack.len() {
            Some(from)
        } else {
            None
        };
    }
    if needle.len() > haystack.len() {
        return None;
    }
    let first = needle[0];
    let last_start = haystack.len() - needle.len();
    let mut at = from;
    while at <= last_start {
        at += haystack[at..=last_start]
            .iter()
            .position(|&unit| unit == first)?;
        if &haystack[at..at + needle.len()] == needle {
            return Some(at);
        }
        at += 1;
    }
    None
}

fn last_index_of(haystack: &[u16], unit: u16, from: usize) -> Option<usize> {
    if haystack.is_empty() {
        return None;
    }
    let start = from.min(haystack.len() - 1);
    (0..=start).rev().find(|&index| haystack[index] == unit)
}

/// `matchRanges`: ranges of whole folded words that start with a query term.
pub fn match_ranges(folded: &[u16], terms: &[Vec<u16>], max: usize) -> Vec<[usize; 2]> {
    let mut ranges: Vec<[usize; 2]> = Vec::new();
    for term in terms {
        let mut from = 0;
        while ranges.len() < max {
            let Some(at) = index_of(folded, term, from) else {
                break;
            };
            if at == 0 || folded[at - 1] == SPACE {
                let mut end = at + term.len();
                while end < folded.len() && folded[end] != SPACE {
                    end += 1;
                }
                ranges.push([at, end]);
            }
            from = at + 1;
        }
    }
    ranges.sort_by_key(|range| range[0]);
    ranges
}

/// True when some word of `folded` starts with `term` (`matchRanges(text, [term], 1).length > 0`).
pub fn has_word_prefix(folded: &[u16], term: &[u16]) -> bool {
    let mut from = 0;
    while let Some(at) = index_of(folded, term, from) {
        if at == 0 || folded[at - 1] == SPACE {
            return true;
        }
        from = at + 1;
    }
    false
}

fn trim_end_js(units: &[u16]) -> &[u16] {
    let mut end = units.len();
    while end > 0 && is_js_space(units[end - 1]) {
        end -= 1;
    }
    &units[..end]
}

pub fn trim_js(units: &[u16]) -> &[u16] {
    let mut start = 0;
    while start < units.len() && is_js_space(units[start]) {
        start += 1;
    }
    trim_end_js(&units[start..])
}

struct Collapsed {
    text: Vec<u16>,
    map: Vec<usize>,
}

fn collapse(original: &[u16], start: usize, end: usize) -> Collapsed {
    let mut text: Vec<u16> = Vec::new();
    let mut map: Vec<usize> = Vec::new();
    let mut space = false;
    for (offset, &unit) in original[start..end].iter().enumerate() {
        if is_js_space(unit) {
            if !space && !text.is_empty() {
                text.push(SPACE);
                map.push(start + offset);
            }
            space = true;
            continue;
        }
        space = false;
        text.push(unit);
        map.push(start + offset);
    }
    let trimmed = trim_end_js(&text).len();
    text.truncate(trimmed);
    Collapsed { text, map }
}

/// `makeSnippet(original, terms, 160)`.
pub fn make_snippet(original: &[u16], terms: &[Vec<u16>], width: usize) -> Snippet {
    let folded = fold_search(original);
    let ranges = match_ranges(&folded.text, terms, 256);
    if ranges.is_empty() {
        let collapsed = collapse(original, 0, original.len().min(width * 2));
        let text = &collapsed.text[..collapsed.text.len().min(width)];
        return Snippet {
            text: from_utf16(text),
            highlights: Vec::new(),
            matched: 0,
        };
    }
    let first_start = folded.origin.get(ranges[0][0]).copied().unwrap_or(0) as usize;
    let mut start = first_start.saturating_sub(width / 3);
    if start > 0 {
        match last_index_of(original, SPACE, first_start) {
            Some(space) if space >= start => start = space + 1,
            _ => {
                if let Some(next_space) = index_of(original, &[SPACE], start) {
                    if next_space < first_start {
                        start = next_space + 1;
                    }
                }
            }
        }
    }
    let end = original.len().min(start + width * 2);
    let collapsed = collapse(original, start, end);
    let text = &collapsed.text[..collapsed.text.len().min(width)];
    let mut highlights: Vec<[usize; 2]> = Vec::new();
    for &[fold_start, fold_end] in &ranges {
        let Some(&orig_start) = folded.origin.get(fold_start) else {
            continue;
        };
        let orig_start = orig_start as usize;
        let orig_end = folded
            .origin
            .get(fold_end.wrapping_sub(1))
            .map(|&value| value as usize)
            .unwrap_or(orig_start)
            + 1;
        let Some(from) = collapsed.map.iter().position(|&value| value >= orig_start) else {
            continue;
        };
        if from >= text.len() {
            continue;
        }
        let to = collapsed
            .map
            .iter()
            .position(|&value| value >= orig_end)
            .unwrap_or(collapsed.map.len())
            .min(text.len());
        if to > from && !highlights.iter().any(|&[a, b]| from < b && to > a) {
            highlights.push([from, to]);
        }
    }
    let prefix: &[u16] = if start > 0 { &[0x2026, SPACE] } else { &[] };
    let mut out: Vec<u16> = Vec::with_capacity(text.len() + 4);
    out.extend_from_slice(prefix);
    out.extend_from_slice(text);
    if start + width < original.len() {
        out.extend_from_slice(&[SPACE, 0x2026]);
    }
    Snippet {
        text: from_utf16(&out),
        highlights: highlights
            .iter()
            .map(|&[a, b]| [(a + prefix.len()) as u32, (b + prefix.len()) as u32])
            .collect(),
        matched: ranges.len() as u32,
    }
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn digits_end(units: &[u16], from: usize) -> usize {
    let mut end = from;
    while end < units.len() && (48..=57).contains(&units[end]) {
        end += 1;
    }
    end
}

/// End of `\d+(?:\.\d+)?` at `from`, or None when there is no digit.
fn number_end(units: &[u16], from: usize) -> Option<usize> {
    let end = digits_end(units, from);
    if end == from {
        return None;
    }
    if end < units.len() && units[end] == b'.' as u16 {
        let fraction = digits_end(units, end + 1);
        if fraction > end + 1 {
            return Some(fraction);
        }
    }
    Some(end)
}

/// `text.replace(/^[ \t]*\d+(?:\.\d+)?\t/gmu, '')`: transcript lines without their page position.
pub fn strip_transcript_positions(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut index = 0;
    let mut line_start = true;
    while index < text.len() {
        if line_start {
            let mut cursor = index;
            while cursor < text.len() && matches!(text[cursor], 0x20 | 0x09) {
                cursor += 1;
            }
            // `[ \t]*` may give back tabs; only `\d` can follow, so greedy is exact.
            if let Some(end) = number_end(text, cursor) {
                if end < text.len() && text[end] == 0x09 {
                    index = end + 1;
                    line_start = false;
                    // The match ends after a tab, so this position is not a line start.
                    continue;
                }
            }
        }
        let unit = text[index];
        out.push(unit);
        line_start = is_line_terminator(unit);
        index += 1;
    }
    out
}

/// `/^\s*(\d+(?:\.\d+)?)\t(.*)$/u` on one line: the position and the rest.
fn positioned_line(line: &[u16]) -> Option<(f64, &[u16])> {
    let mut cursor = 0;
    while cursor < line.len() && is_js_space(line[cursor]) {
        cursor += 1;
    }
    // `\s*` also eats tabs; the number cannot start with one, so this is exact.
    let end = number_end(line, cursor)?;
    if end >= line.len() || line[end] != 0x09 {
        return None;
    }
    let rest = &line[end + 1..];
    if rest.iter().any(|&unit| is_line_terminator(unit)) {
        return None;
    }
    let number: f64 = from_utf16(&line[cursor..end]).parse().ok()?;
    Some((number, rest))
}

/// `inkLineY`: y of the first transcript line containing every term (or the first term).
pub fn ink_line_y(transcript: &[u16], terms: &[Vec<u16>]) -> Option<f64> {
    let lines: Vec<&[u16]> = transcript
        .split(|&unit| unit == 0x0a)
        .filter(|line| !trim_js(line).is_empty())
        .collect();
    let parsed: Vec<(Option<f64>, Vec<u16>)> = lines
        .iter()
        .map(|line| match positioned_line(line) {
            Some((y, rest)) => (Some(y.clamp(0.0, 1.0)), fold_plain_units(rest)),
            None => (None, fold_plain_units(line)),
        })
        .collect();
    let mut index = parsed
        .iter()
        .position(|(_, text)| terms.iter().all(|term| has_word_prefix(text, term)));
    if index.is_none() {
        index = parsed
            .iter()
            .position(|(_, text)| terms.iter().any(|term| has_word_prefix(text, term)));
    }
    let index = index?;
    if let Some(y) = parsed[index].0 {
        return Some(y);
    }
    Some(if parsed.len() == 1 {
        0.15
    } else {
        index as f64 / (parsed.len() - 1) as f64
    })
}

/// `hashText(folded)`: `${length}:${fnv1a32 hex}` over UTF-16 units, as a pair.
pub fn hash_text(folded: &[u16]) -> (u32, u32) {
    let mut hash: u32 = 0x811c_9dc5;
    for &unit in folded {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    (folded.len() as u32, hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(text: &str) -> String {
        fold_plain(text)
    }

    #[test]
    fn german_folding_matches_kanti_rules() {
        assert_eq!(f("Straße"), f("STRASSE"));
        assert_eq!(f("Straße"), "strasse");
        assert_eq!(f("Übung"), f("Uebung"));
        assert_eq!(f("Übung"), f("ubung"));
        assert_eq!(f("München"), f("Muenchen"));
        assert_eq!(f("Größe"), f("GROESSE"));
        assert_eq!(f("FInanzen"), "finanzen");
        assert_eq!(f("Café"), "cafe");
        assert_eq!(f("Integral-\nrechnung"), "integralrechnung");
        assert_eq!(f("Ab-\n  sätze"), "absatze");
        assert_eq!(f("Nord-Süd"), "nord sud");
        assert_eq!(f("soft\u{ad}hyphen"), "softhyphen");
        assert_eq!(f("  E = m·c²!  "), "e m c2");
        assert_eq!(f("ﬁnden Ærger"), "finden ærger");
    }

    #[test]
    fn origin_map_points_back_into_the_original() {
        let raw = utf16("Größe ändern");
        let folded = fold_search(&raw);
        assert_eq!(from_utf16(&folded.text), "grosse andern");
        assert_eq!(folded.text.len(), folded.origin.len());
        let at = index_of(&folded.text, &utf16("andern"), 0).unwrap();
        assert_eq!(folded.origin[at], 6);
    }

    #[test]
    fn queries_are_distinct_folded_terms() {
        let terms: Vec<String> = parse_doc_query("  Straße, STRASSE; Übung ")
            .iter()
            .map(|t| from_utf16(t))
            .collect();
        assert_eq!(terms, ["strasse", "ubung"]);
        assert_eq!(parse_doc_query("a b c d e f g h i j").len(), 8);
        let terms: Vec<String> = parse_doc_query("\"); DROP TABLE --")
            .iter()
            .map(|t| from_utf16(t))
            .collect();
        assert_eq!(terms, ["drop", "table"]);
        assert!(parse_doc_query("").is_empty());
    }

    #[test]
    fn snippets_highlight_the_original_words() {
        let original = format!(
            "Einleitung. {}Die Größe der Straße ist gemessen. {}",
            "Füllwort ".repeat(30),
            "Ende ".repeat(30)
        );
        let original = utf16(&original);
        let snippet = make_snippet(&original, &parse_doc_query("grosse strasse"), 160);
        let text = utf16(&snippet.text);
        assert!(text.len() <= 170);
        let marked: Vec<String> = snippet
            .highlights
            .iter()
            .map(|&[a, b]| from_utf16(&text[a as usize..b as usize]))
            .collect();
        assert_eq!(marked, ["Größe", "Straße"]);
        assert!(snippet.text.starts_with("… "));
    }

    #[test]
    fn transcript_positions_are_stripped_per_line() {
        let text = utf16("0.1000\tPhotosynthese\n  0.62\tChlorophyll\nfrei 1\tnicht");
        assert_eq!(
            from_utf16(&strip_transcript_positions(&text)),
            "Photosynthese\nChlorophyll\nfrei 1\tnicht"
        );
        let y = ink_line_y(
            &utf16("0.1000\tPhotosynthese\n0.6200\tChlorophyll ist grün"),
            &parse_doc_query("chlorophyll"),
        );
        assert_eq!(y, Some(0.62));
        let y = ink_line_y(&utf16("eins\nzwei\ndrei"), &parse_doc_query("drei"));
        assert_eq!(y, Some(1.0));
    }
}
