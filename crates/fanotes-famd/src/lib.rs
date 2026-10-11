//! `fanotes-famd-v1` codec.
//!
//! The byte layout matches `fanotes/electron/famd.cjs`: a markdown body, a
//! length-prefixed `<!-- fanotes-famd:v1 chars=N -->` header, then JSON.
//! `N` is the JavaScript string length of that JSON.

use serde_json::{Map, Value};

pub const FAMD_SCHEMA: &str = "fanotes-famd-v1";
pub const FAMD_EXTENSION: &str = ".famd";
pub const MAX_FAMD_JSON_CHARS: u64 = 32 * 1024 * 1024;

const PAPER_STYLES: &[&str] = &["blank", "dots", "squares", "grid", "lines", "millimeter"];
const NOTE_LINK_STYLES: &[&str] = &["symbol", "text", "symbol-text"];

#[derive(Clone, Debug, PartialEq)]
pub struct NoteLink {
    pub id: String,
    pub source_path: String,
    pub target_path: String,
    pub page: i64,
    pub x: f64,
    pub y: f64,
    pub style: String,
    pub label: String,
    pub appearance: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NoteBackup {
    pub id: String,
    pub note_path: String,
    pub created_at: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FamdPayload {
    pub schema: String,
    pub updated_at: String,
    pub ink: Option<Value>,
    pub worksheets: Vec<String>,
    pub paper_style: Option<String>,
    pub note_links: Vec<NoteLink>,
    pub note_backups: Vec<NoteBackup>,
    pub page_stats: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedFamd {
    pub markdown: String,
    pub payload: Option<FamdPayload>,
}

pub fn empty_famd_payload(updated_at: impl Into<String>) -> FamdPayload {
    FamdPayload {
        schema: FAMD_SCHEMA.to_string(),
        updated_at: updated_at.into(),
        ink: None,
        worksheets: Vec::new(),
        paper_style: None,
        note_links: Vec::new(),
        note_backups: Vec::new(),
        page_stats: None,
    }
}

pub fn is_paper_style(value: &str) -> bool {
    PAPER_STYLES.contains(&value)
}

pub fn note_stem(relative_path: &str) -> String {
    let lower = relative_path.to_lowercase();
    for extension in [".markdown", ".famd", ".pdf", ".md"] {
        if lower.ends_with(extension) {
            return relative_path[..relative_path.len() - extension.len()].to_string();
        }
    }
    relative_path.to_string()
}

pub fn companion_note_path(relative_path: &str, extension: &str) -> String {
    format!("{}{extension}", note_stem(relative_path))
}

pub fn worksheet_ids_from_markdown(markdown: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = markdown;
    while let Some(start) = rest.find("<!--") {
        rest = &rest[start..];
        if let Some((id, consumed)) = worksheet_marker(rest) {
            ids.push(id);
            rest = &rest[consumed..];
        } else {
            rest = &rest[4..];
        }
    }
    ids
}

pub fn strip_famd_payload(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    let mut text = source.to_string();
    if let Some((index, _, _)) = last_header(&text) {
        text.truncate(index);
    }
    let trimmed = trim_end_js(&text).to_string();
    if is_famd_sidecar_json(&trimmed) {
        return String::new();
    }
    if let Some(index) = trailing_sidecar_index(&trimmed) {
        return trim_end_js(&trimmed[..index]).to_string();
    }
    trimmed
}

pub fn parse_famd(source: &str) -> ParsedFamd {
    let markdown = strip_famd_payload(source);
    if source.is_empty() {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    }
    let Some((index, end, length)) = last_header(source) else {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    };
    if !(2..=MAX_FAMD_JSON_CHARS).contains(&length) {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    }
    let Some(json) = slice_js(source, end, length as usize) else {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    };
    let _ = index;
    let Ok(parsed) = serde_json::from_str::<Value>(json) else {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    };
    let Value::Object(object) = parsed else {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    };
    if object.get("schema").and_then(Value::as_str) != Some(FAMD_SCHEMA) {
        return ParsedFamd {
            markdown,
            payload: None,
        };
    }
    ParsedFamd {
        markdown,
        payload: Some(FamdPayload::from_object(&object)),
    }
}

pub fn serialize_famd(markdown: &str, payload: &FamdPayload) -> String {
    let body = strip_famd_payload(markdown);
    let updated_at = canonical_iso(&payload.updated_at).unwrap_or_else(now_iso);
    let worksheets = if payload.worksheets.is_empty() {
        worksheet_ids_from_markdown(&body)
    } else {
        payload.worksheets.clone()
    };
    let mut object = Map::new();
    object.insert("schema".into(), Value::String(FAMD_SCHEMA.into()));
    object.insert("updatedAt".into(), Value::String(updated_at));
    object.insert("ink".into(), payload.ink.clone().unwrap_or(Value::Null));
    object.insert(
        "worksheets".into(),
        Value::Array(worksheets.into_iter().map(Value::String).collect()),
    );
    if let Some(style) = payload
        .paper_style
        .as_deref()
        .filter(|style| is_paper_style(style))
    {
        object.insert("paperStyle".into(), Value::String(style.to_string()));
    }
    let links = sanitize_note_links(&payload.note_links);
    if !links.is_empty() {
        object.insert(
            "noteLinks".into(),
            Value::Array(links.iter().map(NoteLink::to_json).collect()),
        );
    }
    let backups = sanitize_note_backups(&payload.note_backups);
    if !backups.is_empty() {
        object.insert(
            "noteBackups".into(),
            Value::Array(backups.iter().map(NoteBackup::to_json).collect()),
        );
    }
    if let Some(stats) = payload
        .page_stats
        .as_ref()
        .filter(|stats| stats.is_object())
    {
        object.insert("pageStats".into(), stats.clone());
    }
    let json = Value::Object(object).to_string();
    let header = format!("<!-- fanotes-famd:v1 chars={} -->\n{json}\n", js_len(&json));
    if body.is_empty() {
        header
    } else {
        format!("{body}\n\n{header}")
    }
}

impl FamdPayload {
    fn from_object(object: &Map<String, Value>) -> Self {
        let updated_at = object
            .get("updatedAt")
            .and_then(Value::as_str)
            .and_then(canonical_iso)
            .unwrap_or_else(now_iso);
        let worksheets = object
            .get("worksheets")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|id| is_worksheet_id(id))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let ink = object.get("ink").and_then(|value| match value {
            Value::Object(_) => Some(value.clone()),
            _ => None,
        });
        let paper_style = object
            .get("paperStyle")
            .and_then(Value::as_str)
            .filter(|style| is_paper_style(style))
            .map(str::to_string);
        let note_links = object
            .get("noteLinks")
            .map(parse_note_links_value)
            .unwrap_or_default();
        let note_backups = object
            .get("noteBackups")
            .map(parse_note_backups_value)
            .unwrap_or_default();
        let page_stats = object
            .get("pageStats")
            .filter(|stats| stats.is_object())
            .cloned();
        Self {
            schema: FAMD_SCHEMA.to_string(),
            updated_at,
            ink,
            worksheets,
            paper_style,
            note_links,
            note_backups,
            page_stats,
        }
    }
}

pub fn parse_note_links(value: &Value) -> Vec<NoteLink> {
    parse_note_links_value(value)
}

pub fn parse_note_backups(value: &Value) -> Vec<NoteBackup> {
    parse_note_backups_value(value)
}

fn parse_note_links_value(value: &Value) -> Vec<NoteLink> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut seen = Vec::new();
    let mut links = Vec::new();
    for entry in items {
        let Some(link) = sanitize_note_link(entry) else {
            continue;
        };
        if seen.iter().any(|id: &String| id == &link.id) {
            continue;
        }
        seen.push(link.id.clone());
        links.push(link);
    }
    links
}

fn sanitize_note_links(links: &[NoteLink]) -> Vec<NoteLink> {
    parse_note_links_value(&Value::Array(links.iter().map(NoteLink::to_json).collect()))
}

impl NoteLink {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("sourcePath".into(), Value::String(self.source_path.clone()));
        object.insert("targetPath".into(), Value::String(self.target_path.clone()));
        object.insert("page".into(), Value::from(self.page));
        object.insert("x".into(), json_number(self.x));
        object.insert("y".into(), json_number(self.y));
        object.insert("style".into(), Value::String(self.style.clone()));
        object.insert("label".into(), Value::String(self.label.clone()));
        object.insert("appearance".into(), Value::String(self.appearance.clone()));
        Value::Object(object)
    }
}

fn sanitize_note_link(value: &Value) -> Option<NoteLink> {
    let object = value.as_object()?;
    let source_path = sanitize_path(object.get("sourcePath"))?;
    let target_path = sanitize_path(object.get("targetPath"))?;
    if source_path == target_path || !target_path.to_lowercase().ends_with(".md") {
        return None;
    }
    let page = object
        .get("page")
        .and_then(Value::as_i64)
        .filter(|page| (1..=10_000).contains(page))
        .unwrap_or(1);
    let x = object
        .get("x")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(0.5);
    let y = object
        .get("y")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(0.5);
    let style = object
        .get("style")
        .and_then(Value::as_str)
        .filter(|style| NOTE_LINK_STYLES.contains(style))
        .unwrap_or("symbol");
    let label = object
        .get("label")
        .and_then(Value::as_str)
        .map(|label| truncate_js(&collapse_ws(label), 80))
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| link_stem(&target_path));
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_record_id(id))
        .unwrap_or("nl-generated")
        .to_string();
    let appearance = match style {
        "text" => "text",
        "symbol-text" => "symbol-text",
        _ => "symbol",
    };
    Some(NoteLink {
        id,
        source_path,
        target_path,
        page,
        x,
        y,
        style: style.to_string(),
        label,
        appearance: appearance.to_string(),
    })
}

fn parse_note_backups_value(value: &Value) -> Vec<NoteBackup> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut seen = Vec::new();
    let mut snapshots = Vec::new();
    for entry in items {
        let Some(snapshot) = sanitize_note_backup(entry) else {
            continue;
        };
        if seen.iter().any(|id: &String| id == &snapshot.id) {
            continue;
        }
        seen.push(snapshot.id.clone());
        snapshots.push(snapshot);
    }
    let start = snapshots.len().saturating_sub(40);
    snapshots.split_off(start)
}

fn sanitize_note_backups(backups: &[NoteBackup]) -> Vec<NoteBackup> {
    parse_note_backups_value(&Value::Array(
        backups.iter().map(NoteBackup::to_json).collect(),
    ))
}

impl NoteBackup {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("notePath".into(), Value::String(self.note_path.clone()));
        object.insert("createdAt".into(), Value::String(self.created_at.clone()));
        object.insert("content".into(), Value::String(self.content.clone()));
        Value::Object(object)
    }
}

fn sanitize_note_backup(value: &Value) -> Option<NoteBackup> {
    let object = value.as_object()?;
    let note_path = sanitize_path(object.get("notePath"))?;
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(canonical_iso)
        .unwrap_or_else(now_iso);
    let content = truncate_js(
        object.get("content").and_then(Value::as_str).unwrap_or(""),
        2 * 1024 * 1024,
    );
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_record_id(id))
        .unwrap_or("nb-generated")
        .to_string();
    Some(NoteBackup {
        id,
        note_path,
        created_at,
        content,
    })
}

fn sanitize_path(value: Option<&Value>) -> Option<String> {
    let path = value?
        .as_str()?
        .replace('\\', "/")
        .trim_start_matches('/')
        .trim()
        .to_string();
    if path.is_empty()
        || path.encode_utf16().count() > 500
        || path.contains("..")
        || path.contains('\0')
    {
        return None;
    }
    Some(path)
}

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn link_stem(target_path: &str) -> String {
    let base = target_path.rsplit('/').next().unwrap_or(target_path);
    let lower = base.to_lowercase();
    let stem = if lower.ends_with(".markdown") {
        &base[..base.len() - ".markdown".len()]
    } else if lower.ends_with(".md") {
        &base[..base.len() - 3]
    } else {
        base
    };
    if stem.is_empty() {
        "Notiz".to_string()
    } else {
        stem.to_string()
    }
}

fn is_record_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn is_worksheet_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn worksheet_marker(source: &str) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    if !source.starts_with("<!--") {
        return None;
    }
    let mut index = 4;
    index = skip_ws(source, index);
    let marker = "fanotes-worksheet:";
    if !source[index..].starts_with(marker) {
        return None;
    }
    index += marker.len();
    let id_start = index;
    while index < bytes.len() && is_worksheet_id_byte(bytes[index]) && index - id_start < 96 {
        index += 1;
    }
    if index == id_start {
        return None;
    }
    let id = source[id_start..index].to_string();
    index = skip_ws(source, index);
    if !source[index..].starts_with("-->") {
        return None;
    }
    Some((id, index + 3))
}

fn is_worksheet_id_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn last_header(source: &str) -> Option<(usize, usize, u64)> {
    let mut found = None;
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let starts = index == 0 || bytes[index - 1] == b'\n';
        if starts {
            if let Some((relative_end, length)) = header_at(&source[index..]) {
                found = Some((index, index + relative_end, length));
                index += relative_end;
                continue;
            }
        }
        index += 1;
    }
    found
}

fn header_at(source: &str) -> Option<(usize, u64)> {
    if !source.starts_with("<!--") {
        return None;
    }
    let mut index = 4;
    index = skip_ws(source, index);
    let tag = "fanotes-famd:v1";
    if !source[index..].starts_with(tag) {
        return None;
    }
    index += tag.len();
    let after_tag = index;
    index = skip_ws(source, index);
    if index == after_tag {
        return None;
    }
    if !source[index..].starts_with("chars=") {
        return None;
    }
    index += "chars=".len();
    let digits = index;
    while index < source.len() && source.as_bytes()[index].is_ascii_digit() {
        index += 1;
    }
    if digits == index {
        return None;
    }
    let length: u64 = source[digits..index].parse().ok()?;
    index = skip_ws(source, index);
    if !source[index..].starts_with("-->\n") {
        return None;
    }
    Some((index + 4, length))
}

fn is_famd_sidecar_json(value: &str) -> bool {
    let trimmed = trim_js(value);
    if !trimmed.starts_with('{') || !trimmed.contains(FAMD_SCHEMA) {
        return false;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("schema")
                .and_then(Value::as_str)
                .map(|schema| schema == FAMD_SCHEMA)
        })
        .unwrap_or(false)
}

fn trailing_sidecar_index(text: &str) -> Option<usize> {
    let trimmed_len = trim_end_js(text).len();
    let core = &text[..trimmed_len];
    let close = core.rfind('}')?;
    let mut newline = None;
    let bytes = core.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() && index < close {
        if bytes[index] == b'\n' && bytes[index + 1] == b'{' {
            newline = Some(index);
            break;
        }
        index += 1;
    }
    let newline = newline?;
    let captured = &core[newline + 1..=close];
    if is_famd_sidecar_json(captured) {
        Some(newline)
    } else {
        None
    }
}

fn skip_ws(source: &str, mut index: usize) -> usize {
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if !is_js_whitespace(ch) {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

/// JavaScript `String.prototype.trim` and the `/u` flag of `\s`.
///
/// U+FEFF is whitespace. U+0085 is not.
pub fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&character)
}

pub fn trim_js(value: &str) -> &str {
    let start = value
        .char_indices()
        .find(|(_, character)| !is_js_whitespace(*character))
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    let end = value[start..]
        .char_indices()
        .rev()
        .find(|(_, character)| !is_js_whitespace(*character))
        .map(|(index, character)| start + index + character.len_utf8())
        .unwrap_or(start);
    &value[start..end]
}

fn trim_end_js(value: &str) -> &str {
    value.trim_end_matches(is_js_whitespace)
}

fn slice_js(source: &str, start_byte: usize, js_chars: usize) -> Option<&str> {
    let tail = source.get(start_byte..)?;
    let mut taken = 0;
    let mut end = 0;
    for ch in tail.chars() {
        let units = if (ch as u32) > 0xFFFF { 2 } else { 1 };
        if taken + units > js_chars {
            return None;
        }
        taken += units;
        end += ch.len_utf8();
        if taken == js_chars {
            return Some(&tail[..end]);
        }
    }
    None
}

fn js_len(value: &str) -> usize {
    value
        .chars()
        .map(|ch| if (ch as u32) > 0xFFFF { 2 } else { 1 })
        .sum()
}

fn truncate_js(value: &str, max_units: usize) -> String {
    let mut taken = 0;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let units = character.len_utf16();
        if taken + units > max_units {
            break;
        }
        taken += units;
        end = index + character.len_utf8();
    }
    value[..end].to_owned()
}

fn json_number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::from(0))
}

fn canonical_iso(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[17..19].iter().all(u8::is_ascii_digit)
        && bytes[20..23].iter().all(u8::is_ascii_digit)
    {
        return Some(value.to_string());
    }
    None
}

fn now_iso() -> String {
    "1970-01-01T00:00:00.000Z".to_string()
}
