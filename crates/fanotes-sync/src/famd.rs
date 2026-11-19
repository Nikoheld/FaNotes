//! The sync subset of `fanotes/src/lib/famd.ts`: what decides whether a note
//! changed (`noteSyncKind`, `canonicalSyncBytes`, `identitySyncBytes`) and the
//! page-statistics splice on download (`withLocalPageStats`).

use std::borrow::Cow;

use crate::famd_v2::{self, Encoding, FamdError};
use crate::jsjson::{self, Js, JsObject, JsString};
use crate::notemeta;

pub const FAMD_SCHEMA: &str = "fanotes-famd-v1";
const IDENTITY_STAMP: &str = "1970-01-01T00:00:00.000Z";
const PAPER_STYLES: &[&str] = &["blank", "dots", "squares", "grid", "lines", "millimeter"];
const MAX_V1_CHARS: f64 = 32.0 * 1024.0 * 1024.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteSyncKind {
    Present,
    Blank,
    Unreadable,
}

impl NoteSyncKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NoteSyncKind::Present => "present",
            NoteSyncKind::Blank => "blank",
            NoteSyncKind::Unreadable => "unreadable",
        }
    }
}

pub use crate::paths::is_famd_sync_path;

fn skip_space(text: &str, at: usize) -> usize {
    let rest = &text[at..];
    at + (rest.len() - rest.trim_start_matches(jsjson::is_js_space).len())
}

/// `<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n` at `at`: (end, digits).
fn v1_body_at(text: &str, at: usize) -> Option<(usize, &str)> {
    let mut at = at;
    if !text[at..].starts_with("<!--") {
        return None;
    }
    at = skip_space(text, at + 4);
    if !text[at..].starts_with("fanotes-famd:v1") {
        return None;
    }
    at += "fanotes-famd:v1".len();
    let spaced = skip_space(text, at);
    if spaced == at {
        return None;
    }
    at = spaced;
    if !text[at..].starts_with("chars=") {
        return None;
    }
    at += 6;
    let start = at;
    while text.as_bytes().get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    if at == start {
        return None;
    }
    let digits = &text[start..at];
    at = skip_space(text, at);
    if !text[at..].starts_with("-->\n") {
        return None;
    }
    Some((at + 4, digits))
}

/// The last match of `/(?:^|\n)<!--…-->\n/gu` with `matchAll` semantics: (index, end, digits).
fn last_v1_header(text: &str) -> Option<(usize, usize, &str)> {
    let mut last = None;
    let mut last_index = 0usize;
    let mut search = 0usize;
    while let Some(found) = text[search..].find("<!--") {
        let q = search + found;
        search = q + 1;
        let candidate = if q == 0 {
            Some(0)
        } else if text.as_bytes()[q - 1] == b'\n' {
            Some(q - 1)
        } else {
            None
        };
        let Some(p) = candidate else { continue };
        if p < last_index {
            continue;
        }
        if let Some((end, digits)) = v1_body_at(text, q) {
            last = Some((p, end, digits));
            last_index = end;
        }
    }
    last
}

fn is_sidecar_json(value: &str) -> bool {
    let trimmed = jsjson::js_trim(value);
    if !trimmed.starts_with('{') || !trimmed.contains(FAMD_SCHEMA) {
        return false;
    }
    match jsjson::parse(trimmed) {
        Ok(parsed) => {
            matches!(parsed.get("schema"), Some(Js::Str(schema)) if schema.eq_str(FAMD_SCHEMA))
        }
        Err(_) => false,
    }
}

/// `stripFamdPayload(source)`.
pub fn strip_famd_payload(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    let mut cut: Option<usize> = last_v1_header(source).map(|(index, _, _)| index);
    if let Some(v2) = famd_v2::v2_cut_index(source) {
        if cut.is_none_or(|current| v2 > current) {
            cut = Some(v2);
        }
    }
    let text = match cut {
        Some(cut) => &source[..cut],
        None => source,
    };
    let text = jsjson::js_trim_end(text);
    if is_sidecar_json(text) {
        return String::new();
    }
    if text.ends_with('}') {
        if let Some(index) = text.find("\n{") {
            if is_sidecar_json(&text[index + 1..]) {
                return jsjson::js_trim_end(&text[..index]).to_owned();
            }
        }
    }
    text.to_owned()
}

fn is_worksheet_id(value: &JsString) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.0.iter().all(|&unit| {
            unit < 128
                && ((unit as u8).is_ascii_alphanumeric()
                    || unit == u16::from(b'_')
                    || unit == u16::from(b'-'))
        })
}

fn is_worksheet_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// `worksheetIdsFromMarkdown`: `/<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu`.
pub fn worksheet_ids_from_markdown(markdown: &str) -> Vec<String> {
    let bytes = markdown.as_bytes();
    let mut ids = Vec::new();
    let mut search = 0;
    while let Some(found) = markdown[search..].find("<!--") {
        let start = search + found;
        let mut at = skip_space(markdown, start + 4);
        let prefix = "fanotes-worksheet:";
        let mut matched = None;
        if markdown[at..].starts_with(prefix) {
            at += prefix.len();
            let run = bytes[at..]
                .iter()
                .take_while(|&&byte| is_worksheet_char(byte))
                .count();
            for length in (1..=run.min(96)).rev() {
                let after = skip_space(markdown, at + length);
                if markdown[after..].starts_with("-->") {
                    matched = Some((markdown[at..at + length].to_owned(), after + 3));
                    break;
                }
            }
        }
        match matched {
            Some((id, end)) => {
                ids.push(id);
                search = end;
            }
            None => search = start + 1,
        }
    }
    ids
}

fn is_paper_style(value: Option<&Js>) -> bool {
    matches!(value, Some(Js::Str(style)) if PAPER_STYLES.iter().any(|candidate| style.eq_str(candidate)))
}

/// `payloadFromParsed(parsed)`.
fn payload_from_parsed(parsed: &Js) -> Option<JsObject> {
    let Js::Obj(raw) = parsed else { return None };
    let schema_ok = matches!(raw.get("schema"), Some(Js::Str(schema)) if schema.eq_str(FAMD_SCHEMA) || schema.eq_str(famd_v2::FAMD_V2_SCHEMA));
    if !schema_ok {
        return None;
    }
    let worksheets: Vec<Js> = match raw.get("worksheets") {
        Some(Js::Arr(items)) => items
            .iter()
            .filter(|item| matches!(item, Js::Str(id) if is_worksheet_id(id)))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    let ink = match raw.get("ink") {
        Some(value @ Js::Obj(_)) => value.clone(),
        _ => Js::Null,
    };
    let updated_at = match raw.get("updatedAt") {
        Some(Js::Str(text)) => text
            .to_str()
            .and_then(|text| fanotes_famd::canonical_iso(&text))
            .unwrap_or_else(notemeta::now_iso),
        _ => notemeta::now_iso(),
    };
    let note_links = notemeta::note_links_parsed(raw.get("noteLinks"));
    let note_backups = notemeta::note_backups_parsed(raw.get("noteBackups"));
    let page_stats = match raw.get("pageStats") {
        Some(value) if value.truthy() => {
            let now = notemeta::date_parse(&JsString::from_str(&updated_at))
                .filter(|ms| *ms != 0.0)
                .unwrap_or_else(notemeta::now_ms);
            Some(notemeta::parse_page_stats(Some(value), now))
        }
        _ => None,
    };
    let text_fields = notemeta::note_text_fields_parsed(raw.get("textFields"));
    let tombstones = notemeta::note_text_field_tombstones_parsed(raw.get("textFieldTombstones"));
    let annotations = notemeta::annotations_parsed(raw.get("annotations"));
    let mut out = JsObject::new();
    out.define_str("schema", Js::str(FAMD_SCHEMA));
    out.define_str("updatedAt", Js::str(&updated_at));
    out.define_str("ink", ink);
    out.define_str("worksheets", Js::Arr(worksheets));
    if is_paper_style(raw.get("paperStyle")) {
        out.define_str(
            "paperStyle",
            raw.get("paperStyle").cloned().expect("checked"),
        );
    }
    if !note_links.is_empty() {
        out.define_str("noteLinks", Js::Arr(note_links));
    }
    if !note_backups.is_empty() {
        out.define_str("noteBackups", Js::Arr(note_backups));
    }
    if let Some(stats) = page_stats {
        out.define_str("pageStats", stats);
    }
    if !text_fields.is_empty() {
        out.define_str("textFields", Js::Arr(text_fields));
    }
    if !tombstones.is_empty() {
        out.define_str("textFieldTombstones", Js::Arr(tombstones));
    }
    if !annotations.is_empty() {
        out.define_str("annotations", Js::Arr(annotations));
    }
    Some(out)
}

pub struct ParsedFamd {
    pub markdown: String,
    pub payload: Option<JsObject>,
}

/// `parseFamd(source)`. An active v2 document that does not decode is an error, as in TypeScript.
pub fn parse_famd(source: &str) -> Result<ParsedFamd, FamdError> {
    let markdown = strip_famd_payload(source);
    if source.is_empty() {
        return Ok(ParsedFamd {
            markdown: String::new(),
            payload: None,
        });
    }
    if famd_v2::is_active_v2(source) {
        let stored = famd_v2::read_v2_payload(source)?;
        let payload = payload_from_parsed(&Js::Obj(stored))
            .ok_or_else(|| FamdError("famd v2 payload".to_owned()))?;
        return Ok(ParsedFamd {
            markdown,
            payload: Some(payload),
        });
    }
    let Some((_, end, digits)) = last_v1_header(source) else {
        return Ok(ParsedFamd {
            markdown,
            payload: None,
        });
    };
    let length: f64 = digits.parse().unwrap_or(f64::INFINITY);
    if !jsjson::is_safe_integer(length) || length < 2.0 || length > MAX_V1_CHARS {
        return Ok(ParsedFamd {
            markdown,
            payload: None,
        });
    }
    let rest = &source[end..];
    let Some(json_end) = jsjson::byte_offset_of_unit(rest, length as usize) else {
        return Ok(ParsedFamd {
            markdown,
            payload: None,
        });
    };
    let payload = jsjson::parse(&rest[..json_end])
        .ok()
        .and_then(|parsed| payload_from_parsed(&parsed));
    Ok(ParsedFamd { markdown, payload })
}

/// `serializeFamd(markdown, payload, encoding)`.
pub fn serialize_famd(
    markdown: &str,
    payload: &JsObject,
    encoding: Encoding,
) -> Result<String, FamdError> {
    let body = strip_famd_payload(markdown);
    let mut next = JsObject::new();
    next.define_str("schema", Js::str(FAMD_SCHEMA));
    next.define_str(
        "updatedAt",
        match payload.get("updatedAt") {
            Some(value) if value.truthy() => value.clone(),
            _ => Js::str(&notemeta::now_iso()),
        },
    );
    next.define_str(
        "ink",
        match payload.get("ink") {
            Some(value) if value.truthy() && value.is_object_like() => value.clone(),
            _ => Js::Null,
        },
    );
    let worksheets = match payload.get("worksheets") {
        Some(Js::Arr(items)) if !items.is_empty() => items.clone(),
        _ => worksheet_ids_from_markdown(&body)
            .into_iter()
            .map(|id| Js::str(&id))
            .collect(),
    };
    next.define_str("worksheets", Js::Arr(worksheets));
    if is_paper_style(payload.get("paperStyle")) {
        next.define_str(
            "paperStyle",
            payload.get("paperStyle").cloned().expect("checked"),
        );
    }
    let links = notemeta::note_links_serialized(payload.get("noteLinks"));
    if !links.is_empty() {
        next.define_str("noteLinks", Js::Arr(links));
    }
    let backups = notemeta::note_backups_parsed(payload.get("noteBackups"));
    if !backups.is_empty() {
        next.define_str("noteBackups", Js::Arr(backups));
    }
    if let Some(stats) = payload.get("pageStats").filter(|value| value.truthy()) {
        next.define_str("pageStats", stats.clone());
    }
    let fields = notemeta::note_text_fields_parsed(payload.get("textFields"));
    if !fields.is_empty() {
        next.define_str("textFields", Js::Arr(fields));
    }
    let tombstones =
        notemeta::note_text_field_tombstones_parsed(payload.get("textFieldTombstones"));
    if !tombstones.is_empty() {
        next.define_str("textFieldTombstones", Js::Arr(tombstones));
    }
    let annotations = notemeta::annotations_parsed(payload.get("annotations"));
    if !annotations.is_empty() {
        next.define_str("annotations", Js::Arr(annotations));
    }
    if encoding == Encoding::V2 {
        return famd_v2::encode_v2_document(&body, &next);
    }
    let json = jsjson::stringify(&Js::Obj(next));
    let prefix = if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n\n")
    };
    Ok(format!(
        "{prefix}<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
        jsjson::utf16_len(&json)
    ))
}

/// `inkHasMarks(value, depth)`.
pub fn ink_has_marks(value: Option<&Js>, depth: usize) -> bool {
    let Some(value) = value else { return false };
    // A collapsed subsection parks its strokes eight levels under the famd payload.
    if !value.truthy() || depth > 24 {
        return false;
    }
    match value {
        Js::Arr(items) => items
            .iter()
            .any(|item| ink_has_marks(Some(item), depth + 1)),
        Js::Obj(record) => {
            if matches!(record.get("famdPts"), Some(Js::Str(text)) if !text.is_empty()) {
                return true;
            }
            if matches!(record.get("points"), Some(Js::Arr(items)) if !items.is_empty()) {
                return true;
            }
            if matches!(record.get("figurePaths"), Some(Js::Arr(items)) if !items.is_empty()) {
                return true;
            }
            if let Some(Js::Arr(strokes)) = record.get("strokes") {
                if strokes
                    .iter()
                    .any(|stroke| ink_has_marks(Some(stroke), depth + 1))
                {
                    return true;
                }
            }
            ink_has_marks(record.get("ink"), depth + 1)
                || ink_has_marks(record.get("hidden"), depth + 1)
                || ink_has_marks(record.get("sections"), depth + 1)
        }
        _ => false,
    }
}

/// `textFieldsHaveText`: a text box with text, or study annotations with content.
fn text_fields_have_text(payload: &JsObject) -> bool {
    let fields = match payload.get("textFields") {
        Some(Js::Arr(fields)) => fields.iter().any(
            |field| matches!(field.get("text"), Some(Js::Str(text)) if !text.trim().is_empty()),
        ),
        _ => false,
    };
    fields || notemeta::annotations_have_content(payload.get("annotations"))
}

fn blank_or_present(markdown: &str, payload: Option<&JsObject>) -> NoteSyncKind {
    let has_ink = payload.is_some_and(|payload| ink_has_marks(Some(&Js::Obj(payload.clone())), 0));
    let has_fields = payload.is_some_and(text_fields_have_text);
    if jsjson::js_trim(markdown).is_empty() && !has_ink && !has_fields {
        NoteSyncKind::Blank
    } else {
        NoteSyncKind::Present
    }
}

/// `noteSyncKind(path, bytes)`.
pub fn note_sync_kind(path: &str, bytes: &[u8]) -> NoteSyncKind {
    if bytes.is_empty() {
        return NoteSyncKind::Blank;
    }
    if !is_famd_sync_path(path) {
        return NoteSyncKind::Present;
    }
    let text = jsjson::text_decode(bytes);
    if famd_v2::is_active_v2(&text) {
        let Ok(stored) = famd_v2::read_v2_payload(&text) else {
            return NoteSyncKind::Unreadable;
        };
        let Some(payload) = payload_from_parsed(&Js::Obj(stored)) else {
            return NoteSyncKind::Unreadable;
        };
        return blank_or_present(&strip_famd_payload(&text), Some(&payload));
    }
    let parsed = match parse_famd(&text) {
        Ok(parsed) => parsed,
        Err(_) => return NoteSyncKind::Unreadable,
    };
    let stored = text.contains("fanotes-famd:v1") || text.contains("fanotes-famd:v2");
    if stored && parsed.payload.is_none() {
        return NoteSyncKind::Unreadable;
    }
    blank_or_present(&parsed.markdown, parsed.payload.as_ref())
}

/// `canonicalSyncBytes(path, bytes)`; borrowed when the bytes are returned unchanged.
pub fn canonical_sync_bytes<'a>(path: &str, bytes: &'a [u8]) -> Result<Cow<'a, [u8]>, FamdError> {
    if !is_famd_sync_path(path) {
        return Ok(Cow::Borrowed(bytes));
    }
    let text = jsjson::text_decode(bytes);
    let parsed = parse_famd(&text)?;
    let Some(mut payload) = parsed.payload else {
        return Ok(Cow::Borrowed(bytes));
    };
    if !payload.get("pageStats").is_some_and(Js::truthy) {
        return Ok(Cow::Borrowed(bytes));
    }
    payload.remove("pageStats");
    let serialized = serialize_famd(
        &parsed.markdown,
        &payload,
        famd_v2::encoding_for_save(&text),
    )?;
    Ok(Cow::Owned(serialized.into_bytes()))
}

/// `identitySyncBytes(path, bytes)`: `None` for an unreadable note.
pub fn identity_sync_bytes<'a>(
    path: &str,
    bytes: &'a [u8],
) -> Result<Option<Cow<'a, [u8]>>, FamdError> {
    if note_sync_kind(path, bytes) == NoteSyncKind::Unreadable {
        return Ok(None);
    }
    if !is_famd_sync_path(path) {
        return Ok(Some(Cow::Borrowed(bytes)));
    }
    let text = jsjson::text_decode(bytes);
    let parsed = parse_famd(&text)?;
    let Some(payload) = parsed.payload else {
        return canonical_sync_bytes(path, bytes).map(Some);
    };
    let mut rest = payload.clone();
    rest.remove("pageStats");
    let ink = rest.remove("ink");
    let stable_ink = match ink {
        Some(Js::Obj(object)) => {
            let mut next = object.spread();
            next.define_str("updatedAt", Js::str(IDENTITY_STAMP));
            Js::Obj(next)
        }
        Some(other) => other,
        None => Js::Null,
    };
    rest.define_str("updatedAt", Js::str(IDENTITY_STAMP));
    rest.define_str("ink", stable_ink);
    let serialized = serialize_famd(&parsed.markdown, &rest, famd_v2::encoding_for_save(&text))?;
    Ok(Some(Cow::Owned(serialized.into_bytes())))
}

/// `withLocalPageStats(downloaded, local)`.
pub fn with_local_page_stats(downloaded: &str, local: &str) -> Result<String, FamdError> {
    let stats = parse_famd(local)?.payload.and_then(|payload| {
        payload
            .get("pageStats")
            .filter(|value| value.truthy())
            .cloned()
    });
    let Some(stats) = stats else {
        return Ok(downloaded.to_owned());
    };
    let remote = parse_famd(downloaded)?;
    let Some(payload) = remote.payload else {
        return Ok(downloaded.to_owned());
    };
    let mut next = payload.spread();
    next.define_str("pageStats", stats);
    serialize_famd(
        &remote.markdown,
        &next,
        famd_v2::encoding_for_save(downloaded),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ink_famd(updated_at: &str) -> String {
        let points: Vec<String> = (0..30)
            .map(|index| format!("{{\"x\":{index},\"y\":1}}"))
            .collect();
        let json = format!(
            "{{\"schema\":\"fanotes-famd-v1\",\"updatedAt\":\"{updated_at}\",\"ink\":{{\"strokes\":[{{\"points\":[{}]}}],\"updatedAt\":\"{updated_at}\"}},\"worksheets\":[]}}",
            points.join(",")
        );
        format!(
            "# Seite\n\n{}\n\n<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
            "Wort ".repeat(40),
            json.len()
        )
    }

    #[test]
    fn timestamps_do_not_change_identity() {
        let a = ink_famd("2026-01-01T00:00:00.000Z");
        let b = ink_famd("2026-02-02T00:00:00.000Z");
        let id_a = identity_sync_bytes("N.famd", a.as_bytes())
            .unwrap()
            .unwrap()
            .into_owned();
        let id_b = identity_sync_bytes("N.famd", b.as_bytes())
            .unwrap()
            .unwrap()
            .into_owned();
        assert_eq!(id_a, id_b);
        assert_eq!(
            note_sync_kind("N.famd", a.as_bytes()),
            NoteSyncKind::Present
        );
    }

    #[test]
    fn truncated_and_blank_notes() {
        assert_eq!(
            note_sync_kind(
                "N.famd",
                b"<!-- fanotes-famd:v1 chars=20 -->\n{\"truncated\":"
            ),
            NoteSyncKind::Unreadable
        );
        let blank = "{\"schema\":\"fanotes-famd-v1\",\"updatedAt\":\"2026-03-03T00:00:00.000Z\",\"ink\":null,\"worksheets\":[]}";
        let file = format!("<!-- fanotes-famd:v1 chars={} -->\n{blank}\n", blank.len());
        assert_eq!(
            note_sync_kind("N.famd", file.as_bytes()),
            NoteSyncKind::Blank
        );
        assert_eq!(note_sync_kind("N.png", b""), NoteSyncKind::Blank);
        assert_eq!(note_sync_kind("N.png", b"x"), NoteSyncKind::Present);
    }

    #[test]
    fn worksheet_markers_backtrack() {
        assert_eq!(
            worksheet_ids_from_markdown(
                "a <!-- fanotes-worksheet:abc--> b <!--fanotes-worksheet:x_y  -->"
            ),
            vec!["abc", "x_y"]
        );
    }
}
