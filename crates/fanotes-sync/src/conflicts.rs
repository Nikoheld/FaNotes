//! `fanotes/src/lib/sync/conflicts.ts`: conflict copy names, grouping, fingerprints.

use chrono::{NaiveDate, TimeZone};
use serde::Serialize;

use crate::crypto::sha256_hex;
use crate::famd;
use crate::jsjson::JsString;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConflictPair {
    pub path: String,
    #[serde(rename = "copyPath")]
    pub copy_path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictGroup {
    pub id: String,
    pub title: String,
    pub path: String,
    pub copy_path: String,
    pub pairs: Vec<ConflictPair>,
    pub device: Option<String>,
    pub at: Option<String>,
    pub original_missing: bool,
    pub internal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedConflictCopy {
    pub original_path: String,
    pub device: String,
    pub at: Option<String>,
    pub copy_stem: String,
}

fn split_path(path: &str) -> (&str, &str, &str, &str) {
    let (directory, name) = match path.rfind('/') {
        Some(slash) => (&path[..slash + 1], &path[slash + 1..]),
        None => ("", path),
    };
    match name.rfind('.') {
        Some(dot) if dot > 0 => (directory, name, &name[..dot], &name[dot..]),
        _ => (directory, name, name, ""),
    }
}

fn is_line_terminator(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn digits(text: &str, count: usize) -> Option<(&str, &str)> {
    if text.len() < count || !text.as_bytes()[..count].iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((&text[..count], &text[count..]))
}

/// ` (\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})(?: (\d{1,13}))?\)$` on `rest`.
fn date_tail(rest: &str) -> Option<[u32; 5]> {
    let rest = rest.strip_prefix(' ')?;
    let (year, rest) = digits(rest, 4)?;
    let rest = rest.strip_prefix('-')?;
    let (month, rest) = digits(rest, 2)?;
    let rest = rest.strip_prefix('-')?;
    let (day, rest) = digits(rest, 2)?;
    let rest = rest.strip_prefix(' ')?;
    let (hour, rest) = digits(rest, 2)?;
    let rest = rest.strip_prefix('-')?;
    let (minute, rest) = digits(rest, 2)?;
    let ok = if rest == ")" {
        true
    } else if let Some(number) = rest
        .strip_prefix(' ')
        .and_then(|tail| tail.strip_suffix(')'))
    {
        (1..=13).contains(&number.len()) && number.bytes().all(|byte| byte.is_ascii_digit())
    } else {
        false
    };
    ok.then(|| [year, month, day, hour, minute].map(|part| part.parse().unwrap_or(0)))
}

/// `new Date(year, month - 1, day, hour, minute).toISOString()` in local time.
fn local_iso(parts: [u32; 5]) -> Option<String> {
    let [year, month, day, hour, minute] = parts;
    let year = if year <= 99 { year + 1900 } else { year };
    let months = i64::from(year) * 12 + i64::from(month) - 1;
    let first = NaiveDate::from_ymd_opt(
        months.div_euclid(12) as i32,
        months.rem_euclid(12) as u32 + 1,
        1,
    )?;
    let local = first.and_hms_opt(0, 0, 0)?
        + chrono::Duration::days(i64::from(day) - 1)
        + chrono::Duration::hours(i64::from(hour))
        + chrono::Duration::minutes(i64::from(minute));
    let instant = match chrono::Local.from_local_datetime(&local) {
        chrono::LocalResult::Single(at) => at.timestamp_millis(),
        chrono::LocalResult::Ambiguous(first, _) => first.timestamp_millis(),
        chrono::LocalResult::None => {
            // A skipped local time uses the offset before the transition.
            let before = chrono::Local
                .from_local_datetime(&(local - chrono::Duration::days(1)))
                .earliest()?;
            let offset = chrono::Offset::fix(before.offset()).local_minus_utc();
            local.and_utc().timestamp_millis() - i64::from(offset) * 1000
        }
    };
    Some(crate::notemeta::iso_from_millis(instant as f64))
}

/// `parseConflictCopyPath(path)`.
pub fn parse_conflict_copy_path(path: &str) -> Option<ParsedConflictCopy> {
    let (directory, _, stem, extension) = split_path(path);
    const MARK: &str = " (Konflikt ";
    let mut candidates: Vec<usize> = stem.match_indices(MARK).map(|(index, _)| index).collect();
    candidates.reverse();
    for index in candidates {
        let original = &stem[..index];
        if original.is_empty() || original.chars().any(is_line_terminator) {
            continue;
        }
        let rest = &stem[index + MARK.len()..];
        // `(.+?)`: the shortest device after which the date tail matches.
        for (offset, character) in rest
            .char_indices()
            .skip(1)
            .chain(std::iter::once((rest.len(), ' ')))
        {
            let device = &rest[..offset];
            if device.chars().any(is_line_terminator) {
                break;
            }
            let _ = character;
            if let Some(parts) = date_tail(&rest[offset..]) {
                return Some(ParsedConflictCopy {
                    original_path: format!("{directory}{original}{extension}"),
                    device: crate::jsjson::js_trim(device).to_owned(),
                    at: local_iso(parts),
                    copy_stem: format!("{directory}{stem}"),
                });
            }
        }
    }
    None
}

pub fn is_conflict_copy_path(path: &str) -> bool {
    parse_conflict_copy_path(path).is_some()
}

/// `keptVersionPath(copyPath)`: `Name (Fassung …).ext`.
pub fn kept_version_path(copy_path: &str) -> String {
    let (directory, _, stem, extension) = split_path(copy_path);
    // `stem.replace(/ \(Konflikt (.+)\)$/u, ' (Fassung $1)')`: the first ` (Konflikt ` whose rest ends with `)`.
    let mut next = stem.to_owned();
    if let Some(index) = stem.find(" (Konflikt ") {
        let inner = &stem[index + " (Konflikt ".len()..];
        if let Some(body) = inner.strip_suffix(')') {
            if !body.is_empty() && !body.chars().any(is_line_terminator) {
                next = format!("{} (Fassung {body})", &stem[..index]);
            }
        }
    }
    format!("{directory}{next}{extension}")
}

/// `numberedVariant(path, number)`.
pub fn numbered_variant(path: &str, number: u64) -> String {
    let (directory, _, stem, extension) = split_path(path);
    let open = match stem.strip_suffix(')') {
        Some(open) => open.to_owned(),
        None => format!("{stem} ("),
    };
    format!("{directory}{open} {number}){extension}")
}

fn note_title(path: &str) -> String {
    let (_, name, _, _) = split_path(path);
    let name = JsString::from_str(name);
    crate::paths::strip_note_extension(&name)
        .unwrap_or(name)
        .to_string_lossy()
}

fn is_note_text(path: &str) -> bool {
    let lower: String = path
        .chars()
        .map(|character| {
            if character == '\u{212A}' {
                'k'
            } else {
                character.to_ascii_lowercase()
            }
        })
        .collect();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// `String#localeCompare` with the default (German) collation.
pub fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> =
        std::sync::OnceLock::new();
    let collator = COLLATOR.get_or_init(|| {
        let prefs = icu_collator::CollatorPreferences::from(icu_locale_core::locale!("de"));
        icu_collator::Collator::try_new(prefs, icu_collator::options::CollatorOptions::default())
            .ok()
    });
    match collator {
        Some(collator) => collator.compare(left, right),
        None => left.cmp(right),
    }
}

/// `groupConflicts(present, recorded)`; `present` in iteration order.
pub fn group_conflicts(present: &[String], recorded: &[(String, String)]) -> Vec<ConflictGroup> {
    let present_set: std::collections::HashSet<&str> = present.iter().map(String::as_str).collect();
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, (Vec<ConflictPair>, String, Option<String>)> =
        std::collections::HashMap::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for copy_path in present {
        if !seen.insert(copy_path.as_str()) {
            continue;
        }
        let Some(parsed) = parse_conflict_copy_path(copy_path) else {
            continue;
        };
        if !groups.contains_key(&parsed.copy_stem) {
            order.push(parsed.copy_stem.clone());
        }
        let group = groups
            .entry(parsed.copy_stem.clone())
            .or_insert_with(|| (Vec::new(), parsed.device.clone(), parsed.at.clone()));
        group.0.push(ConflictPair {
            path: parsed.original_path.clone(),
            copy_path: copy_path.clone(),
        });
        if let Some((_, noted)) = recorded.iter().find(|(path, _)| path == copy_path) {
            group.2 = Some(noted.clone());
        }
    }
    let mut out: Vec<ConflictGroup> = order
        .into_iter()
        .map(|id| {
            let (mut pairs, device, at) = groups.remove(&id).expect("grouped");
            pairs.sort_by(|left, right| locale_compare(&left.path, &right.path));
            let primary = pairs
                .iter()
                .find(|pair| is_note_text(&pair.path))
                .unwrap_or(&pairs[0])
                .clone();
            ConflictGroup {
                id,
                title: note_title(&primary.path),
                path: primary.path.clone(),
                copy_path: primary.copy_path.clone(),
                original_missing: pairs
                    .iter()
                    .all(|pair| !present_set.contains(pair.path.as_str())),
                internal: primary.path.starts_with(".fanotes/"),
                pairs,
                device: (!device.is_empty()).then_some(device),
                at,
            }
        })
        .collect();
    out.sort_by(|left, right| {
        locale_compare(
            right.at.as_deref().unwrap_or(""),
            left.at.as_deref().unwrap_or(""),
        )
        .then_with(|| locale_compare(&left.title, &right.title))
    });
    out
}

/// `conflictFingerprint(path, bytes)`.
pub fn conflict_fingerprint(path: &str, bytes: Option<&[u8]>) -> Option<String> {
    let bytes = bytes?;
    match famd::identity_sync_bytes(path, bytes) {
        Ok(Some(identity)) => Some(sha256_hex(&identity)),
        _ => Some(sha256_hex(bytes)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_copy_names() {
        let parsed =
            parse_conflict_copy_path("Mathe/Algebra (Konflikt Mein Laptop 2026-11-15 09-04).md")
                .unwrap();
        assert_eq!(parsed.original_path, "Mathe/Algebra.md");
        assert_eq!(parsed.device, "Mein Laptop");
        assert_eq!(
            parse_conflict_copy_path("Mathe/Algebra (Konflikt Tablet 2026-11-15 09-04 2).famd")
                .unwrap()
                .device,
            "Tablet"
        );
        assert!(parse_conflict_copy_path("Mathe/Algebra.md").is_none());
        assert_eq!(
            kept_version_path("A (Konflikt Tablet 2026-11-15 09-04).md"),
            "A (Fassung Tablet 2026-11-15 09-04).md"
        );
        assert_eq!(
            numbered_variant("A (Konflikt T 2026-11-15 09-04).md", 2),
            "A (Konflikt T 2026-11-15 09-04 2).md"
        );
        assert_eq!(numbered_variant("A.md", 3), "A ( 3).md");
    }

    #[test]
    fn groups_note_pairs() {
        let present: Vec<String> = [
            "N.md",
            "N.famd",
            "N (Konflikt X 2026-01-01 10-00).md",
            "N (Konflikt X 2026-01-01 10-00).famd",
            "Solo (Konflikt X 2026-01-01 10-00).pdf",
        ]
        .iter()
        .map(|path| path.to_string())
        .collect();
        let grouped = group_conflicts(&present, &[]);
        assert_eq!(grouped.len(), 2);
        let note = grouped.iter().find(|group| group.title == "N").unwrap();
        assert_eq!(note.pairs.len(), 2);
        assert_eq!(note.path, "N.md");
        assert!(
            grouped
                .iter()
                .find(|group| group.title == "Solo")
                .unwrap()
                .original_missing
        );
    }
}
