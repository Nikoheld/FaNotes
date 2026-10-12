//! `fanotes-famd-v1` codec.
//!
//! The byte layout matches `fanotes/electron/famd.cjs`: a markdown body, a
//! length-prefixed `<!-- fanotes-famd:v1 chars=N -->` header, then JSON.
//! `N` is the JavaScript string length of that JSON.

use std::time::{SystemTime, UNIX_EPOCH};

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
    for extension in [".markdown", ".famd", ".pdf", ".md"] {
        if let Some(stem) = strip_iu_suffix(relative_path, extension) {
            return stem.to_string();
        }
    }
    relative_path.to_string()
}

/// Drops a suffix matched by JavaScript `/\.(md|markdown|famd|pdf)$/iu`.
///
/// The Kelvin sign is `k`, so `.marKdown` is the whole `.markdown` suffix.
/// Subtracting the ASCII byte length would leave `Notiz.m`.
fn strip_iu_suffix<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    let suffix: Vec<char> = suffix.chars().collect();
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    if chars.len() < suffix.len() {
        return None;
    }
    let start = chars.len() - suffix.len();
    let matches = suffix
        .iter()
        .enumerate()
        .all(|(offset, expected)| iu_fold(chars[start + offset].1) == *expected);
    matches.then_some(&value[..chars[start].0])
}

fn iu_fold(character: char) -> char {
    match character {
        '\u{017F}' => 's',
        '\u{212A}' => 'k',
        'A'..='Z' => character.to_ascii_lowercase(),
        other => other,
    }
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
    if let Some(stats) = parse_page_stats(payload.page_stats.as_ref()) {
        object.insert("pageStats".into(), stats);
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
        let page_stats = parse_page_stats(object.get("pageStats"));
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
    let page_number = js_number(object.get("page"));
    let page = if page_number.is_finite()
        && page_number.fract() == 0.0
        && page_number.abs() <= 9_007_199_254_740_991.0
        && (1.0..=10_000.0).contains(&page_number)
    {
        page_number as i64
    } else {
        1
    };
    let x_number = js_number(object.get("x"));
    let x = if x_number.is_finite() {
        x_number.clamp(0.0, 1.0)
    } else {
        0.5
    };
    let y_number = js_number(object.get("y"));
    let y = if y_number.is_finite() {
        y_number.clamp(0.0, 1.0)
    } else {
        0.5
    };
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
        .map(str::to_owned)
        .unwrap_or_else(|| js_now_id("nl"));
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
        .map(str::to_owned)
        .unwrap_or_else(|| js_now_id("nb"));
    Some(NoteBackup {
        id,
        note_path,
        created_at,
        content,
    })
}

fn sanitize_path(value: Option<&Value>) -> Option<String> {
    let replaced = value?.as_str()?.replace('\\', "/");
    let path = trim_js(replaced.trim_start_matches('/')).to_string();
    if path.is_empty()
        || path.encode_utf16().count() > 500
        || path.contains("..")
        || path.contains('\0')
    {
        return None;
    }
    Some(path)
}

/// JavaScript `replace(/\s+/gu, ' ').trim()`.
///
/// A byte-order mark collapses into a space. U+0085 stays in the label.
fn collapse_ws(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut pending_space = false;
    let mut started = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
            if started {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            collapsed.push(' ');
            pending_space = false;
        }
        started = true;
        collapsed.push(character);
    }
    collapsed
}

fn link_stem(target_path: &str) -> String {
    let base = target_path.rsplit('/').next().unwrap_or(target_path);
    let stem = strip_iu_suffix(base, ".markdown")
        .or_else(|| strip_iu_suffix(base, ".md"))
        .unwrap_or(base);
    if stem.is_empty() {
        "Notiz".to_string()
    } else {
        stem.to_string()
    }
}

/// `Date.now().toString(36)`, prefixed like `nl-` and `nb-`.
fn js_now_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    format!("{prefix}-{}", to_base36(millis))
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut bytes = Vec::new();
    while value > 0 {
        bytes.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    bytes.reverse();
    String::from_utf8(bytes).unwrap_or_else(|_| "0".to_owned())
}

/// The editor stores page stats with fields beyond the five companion keys.
/// An object is kept whole. An array is not a stats record.
fn parse_page_stats(value: Option<&Value>) -> Option<Value> {
    value.filter(|stats| stats.is_object()).cloned()
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

/// `Date.parse` plus `toISOString`. A zoned timestamp becomes UTC with milliseconds.
///
/// A date without a time is midnight UTC. A time without a zone is local time.
/// A day past the end of the month rolls forward, and `24:00:00` is the next midnight.
pub fn canonical_iso(value: &str) -> Option<String> {
    let trimmed = trim_js(value);
    if is_date_only_shape(trimmed) {
        return date_only_iso(trimmed);
    }
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: i32 = value.get(5..7)?.parse().ok()?;
    let day: i32 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if bytes.len() == 10 {
        let (year, month, day) = normalize_ymd(year, month, day)?;
        return Some(format!("{year:04}-{month:02}-{day:02}T00:00:00.000Z"));
    }
    let separator = *bytes.get(10)?;
    if separator != b'T' && separator != b't' && separator != b' ' {
        return None;
    }
    if bytes.len() < 16 || bytes.get(13) != Some(&b':') {
        return None;
    }
    let mut hour: i32 = value.get(11..13)?.parse().ok()?;
    let minute: i32 = value.get(14..16)?.parse().ok()?;
    // `2026-01-02T03:04Z` has no seconds. A fraction there is not a time.
    let (second, mut index) = if bytes.get(16) == Some(&b':') {
        let second = value.get(17..19)?.parse().ok()?;
        (second, 19)
    } else if bytes.get(16) == Some(&b'.') {
        return None;
    } else {
        (0, 16)
    };
    if !(0..=24).contains(&hour) || !(0..=59).contains(&minute) || !(0..=59).contains(&second) {
        return None;
    }
    let mut millis = 0u32;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        let digits = value.get(start..index)?;
        let taken = digits.chars().take(3).collect::<String>();
        let parsed: u32 = taken.parse().ok()?;
        millis = parsed * 10u32.pow((3 - taken.len()) as u32);
    }
    let (mut year, mut month, mut day) = normalize_ymd(year, month, day)?;
    if hour == 24 {
        if minute != 0 || second != 0 || millis != 0 {
            return None;
        }
        hour = 0;
        (year, month, day) = add_day(year, month, day);
    }
    let rest = value.get(index..)?;
    let (year, month, day, hour, minute, second) = if rest.eq_ignore_ascii_case("Z") {
        (year, month, day, hour, minute, second)
    } else if rest.is_empty() {
        local_civil_to_utc(year, month, day, hour, minute, second)?
    } else {
        let offset = parse_offset(rest)?;
        shift_seconds(year, month, day, hour, minute, second, -(offset as i64))?
    };
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

/// A calendar date with no time. Month and day may be one digit.
fn is_date_only_shape(value: &str) -> bool {
    !value
        .bytes()
        .any(|byte| matches!(byte, b'T' | b't' | b' ' | b'+'))
        && value.bytes().filter(|byte| *byte == b'-').count() == 2
}

fn date_only_iso(value: &str) -> Option<String> {
    let mut parts = value.split('-');
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    if parts.next().is_some()
        || year.len() != 4
        || !(1..=2).contains(&month.len())
        || !(1..=2).contains(&day.len())
        || !year.bytes().all(|byte| byte.is_ascii_digit())
        || !month.bytes().all(|byte| byte.is_ascii_digit())
        || !day.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let year: i32 = year.parse().ok()?;
    let month: i32 = month.parse().ok()?;
    let day: i32 = day.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (year, month, day) = normalize_ymd(year, month, day)?;
    Some(format!("{year:04}-{month:02}-{day:02}T00:00:00.000Z"))
}

fn parse_offset(rest: &str) -> Option<i32> {
    let bytes = rest.as_bytes();
    let sign = match bytes.first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let (hour, minute) = if rest.len() == 5 && bytes[1..].iter().all(u8::is_ascii_digit) {
        (
            rest.get(1..3)?.parse::<i32>().ok()?,
            rest.get(3..5)?.parse::<i32>().ok()?,
        )
    } else if rest.len() == 6 && bytes.get(3) == Some(&b':') {
        (
            rest.get(1..3)?.parse::<i32>().ok()?,
            rest.get(4..6)?.parse::<i32>().ok()?,
        )
    } else {
        return None;
    };
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some(sign * (hour * 3600 + minute * 60))
}

fn normalize_ymd(mut year: i32, mut month: i32, mut day: i32) -> Option<(i32, i32, i32)> {
    if !(1..=12).contains(&month) || day < 1 || day > 31 {
        return None;
    }
    while day > days_in_month(year, month as u32) as i32 {
        day -= days_in_month(year, month as u32) as i32;
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
    }
    if !(0..10_000).contains(&year) {
        return None;
    }
    Some((year, month, day))
}

fn add_day(mut year: i32, mut month: i32, mut day: i32) -> (i32, i32, i32) {
    day += 1;
    if day > days_in_month(year, month as u32) as i32 {
        day = 1;
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
    }
    (year, month, day)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn local_civil_to_utc(
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let assumed = unix_from_utc(year, month, day, hour, minute, second)?;
    let mut utc = assumed;
    for _ in 0..3 {
        let offset = local_offset_seconds(utc);
        let next = assumed - offset;
        if next == utc {
            break;
        }
        utc = next;
    }
    civil_from_unix(utc)
}

fn local_offset_seconds(utc_secs: i64) -> i64 {
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    let seconds = utc_secs as libc::time_t;
    unsafe {
        if libc::localtime_r(&seconds, &mut tm).is_null() {
            return 0;
        }
        tm.tm_gmtoff as i64
    }
}

fn shift_seconds(
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    delta: i64,
) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let unix = unix_from_utc(year, month, day, hour, minute, second)?.checked_add(delta)?;
    civil_from_unix(unix)
}

fn unix_from_utc(
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
) -> Option<i64> {
    let days = days_from_civil(year, month as u32, day as u32)?;
    days.checked_mul(86_400)?
        .checked_add(hour as i64 * 3600 + minute as i64 * 60 + second as i64)
}

fn civil_from_unix(seconds: i64) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400) as i32;
    let (year, month, day) = civil_from_days(days)?;
    Some((
        year,
        month,
        day,
        day_seconds / 3600,
        (day_seconds % 3600) / 60,
        day_seconds % 60,
    ))
}

fn days_from_civil(mut year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u32;
    let day_of_year =
        (153 * (month as i32 + if month > 2 { -3 } else { 9 }) as u32 + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era as i64 * 146_097 + day_of_era as i64 - 719_468)
}

fn civil_from_days(days: i64) -> Option<(i32, i32, i32)> {
    let shifted = days.checked_add(719_468)?;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u32;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era as i32 + era as i32 * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 {
        month_part + 3
    } else {
        month_part - 9
    };
    Some((year + i32::from(month <= 2), month as i32, day as i32))
}

fn now_iso() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = elapsed.subsec_millis();
    let Some((year, month, day, hour, minute, second)) = civil_from_unix(elapsed.as_secs() as i64)
    else {
        return "1970-01-01T00:00:00.000Z".to_string();
    };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// `Number(string)`: the whole string is one numeric literal after JavaScript trim.
///
/// A sign applies to decimals and `Infinity`. `0x` / `0b` / `0o` are unsigned.
/// `800px`, `1e`, and `+0x10` are not numbers.
pub fn js_tonumber(value: &str) -> Option<f64> {
    let text = trim_js(value);
    if text.is_empty() {
        return Some(0.0);
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'b' | b'B' => Some(2),
            b'o' | b'O' => Some(8),
            _ => None,
        };
        if let Some(radix) = radix {
            return integer_literal(&text[2..], radix);
        }
    }
    decimal_literal(text)
}

fn integer_literal(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let mut value = 0.0_f64;
    for byte in digits.bytes() {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return None,
        };
        if u32::from(digit) >= radix {
            return None;
        }
        value = value.mul_add(f64::from(radix), f64::from(digit));
        if !value.is_finite() {
            return Some(f64::INFINITY);
        }
    }
    Some(value)
}

fn decimal_literal(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut index = 0;
    if bytes
        .first()
        .is_some_and(|byte| matches!(byte, b'+' | b'-'))
    {
        index = 1;
    }
    if text[index..].eq("Infinity") {
        return text.parse().ok();
    }
    let mut saw_digit = false;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        saw_digit = true;
        index += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            saw_digit = true;
            index += 1;
        }
    }
    if !saw_digit {
        return None;
    }
    if bytes
        .get(index)
        .is_some_and(|byte| matches!(byte, b'e' | b'E'))
    {
        index += 1;
        if bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            index += 1;
        }
        let exponent = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent {
            return None;
        }
    }
    if index != bytes.len() {
        return None;
    }
    text.parse().ok()
}

/// `Number(value)` for a JSON value. A missing value is `NaN`, like `undefined`.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_tonumber(text).unwrap_or(f64::NAN),
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_famd, parse_note_links, serialize_famd, FamdPayload, FAMD_SCHEMA};

    #[test]
    fn a_bad_companion_timestamp_uses_the_current_time() {
        let json = format!(
            r#"{{"schema":"{FAMD_SCHEMA}","updatedAt":"not-a-date","ink":null,"worksheets":[]}}"#
        );
        let source = format!(
            "<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
            super::js_len(&json)
        );
        let updated = parse_famd(&source).payload.unwrap().updated_at;
        assert_ne!(updated, "1970-01-01T00:00:00.000Z");
        assert!(updated.ends_with('Z'), "{updated}");
        assert_eq!(updated.len(), 24, "{updated}");
    }

    #[test]
    fn a_note_link_reads_page_and_position_with_javascript_number() {
        let links = parse_note_links(&serde_json::json!([
            {
                "id": "link-a",
                "sourcePath": "anders.md",
                "targetPath": "Physik/Kraft.md",
                "page": "4",
                "x": "0.25",
                "y": null,
                "label": "Kraft"
            },
            {
                "id": "link-b",
                "sourcePath": "anders.md",
                "targetPath": "Physik/Andere.md",
                "page": "4.5",
                "x": 0.1,
                "y": 0.2,
                "label": "Andere"
            }
        ]));
        assert_eq!(links[0].page, 4);
        assert_eq!(links[0].x, 0.25);
        assert_eq!(links[0].y, 0.0);
        assert_eq!(links[1].page, 1);
    }

    #[test]
    fn a_missing_link_or_backup_id_uses_the_desktop_clock() {
        assert_eq!(super::to_base36(0), "0");
        assert_eq!(super::to_base36(35), "z");
        assert_eq!(super::to_base36(36), "10");
        assert_eq!(super::to_base36(1_760_270_000_000), "mgnnb4ow");

        let links = parse_note_links(&serde_json::json!([{
            "sourcePath": "a.md",
            "targetPath": "b.md"
        }]));
        assert!(links[0].id.starts_with("nl-"), "{}", links[0].id);
        assert_ne!(links[0].id, "nl-generated");

        let backups = super::parse_note_backups(&serde_json::json!([
            { "notePath": "a.md", "content": "eins" },
            { "notePath": "a.md", "id": "nb-keep", "content": "zwei" },
            { "notePath": "a.md", "id": "bad id", "content": "drei" }
        ]));
        assert!(backups.iter().any(|backup| backup.id == "nb-keep"));
        assert!(backups.len() == 2 || backups.len() == 3, "{backups:?}");
        for backup in &backups {
            if backup.id == "nb-keep" {
                continue;
            }
            assert!(backup.id.starts_with("nb-"), "{}", backup.id);
            assert_ne!(backup.id, "nb-generated");
        }
    }

    #[test]
    fn page_stats_keep_editor_fields_without_a_creation_time() {
        let json = format!(
            r#"{{"schema":"{FAMD_SCHEMA}","updatedAt":"2026-01-02T00:00:00.000Z","ink":null,"worksheets":[],"pageStats":{{"words":2,"typing":{{"wordsAdded":4}}}}}}"#
        );
        let source = format!(
            "<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
            super::js_len(&json)
        );
        let stats = parse_famd(&source).payload.unwrap().page_stats.unwrap();
        assert_eq!(stats["words"], 2);
        assert_eq!(stats["typing"]["wordsAdded"], 4);

        let payload = FamdPayload {
            schema: FAMD_SCHEMA.to_string(),
            updated_at: "2026-01-02T00:00:00.000Z".to_string(),
            ink: None,
            worksheets: Vec::new(),
            paper_style: None,
            note_links: Vec::new(),
            note_backups: Vec::new(),
            page_stats: Some(serde_json::json!({ "words": 2 })),
        };
        let saved = serialize_famd("", &payload);
        let again = parse_famd(&saved).payload.unwrap().page_stats.unwrap();
        assert_eq!(again["words"], 2);
    }
}
