//! `fanotes-famd-v1` codec.
//!
//! The byte layout matches `fanotes/electron/famd.cjs`: a markdown body, a
//! length-prefixed `<!-- fanotes-famd:v1 chars=N -->` header, then JSON.
//! `N` is the JavaScript string length of that JSON.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

mod v8_date;

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
    // `payload.updatedAt || now`. An empty string is the only missing time.
    // A month name or other text is written unchanged.
    let updated_at = if payload.updated_at.is_empty() {
        now_iso()
    } else {
        payload.updated_at.clone()
    };
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
    let object = value?.as_object()?;
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(canonical_iso)?;
    let modified_at = object
        .get("modifiedAt")
        .and_then(Value::as_str)
        .and_then(canonical_iso)
        .unwrap_or_else(|| created_at.clone());
    let last_opened_at = object
        .get("lastOpenedAt")
        .and_then(Value::as_str)
        .and_then(canonical_iso)
        .unwrap_or_else(|| created_at.clone());
    let dwell = js_number(object.get("dwellMs"));
    let opens = js_number(object.get("openCount"));
    let mut stats = object.clone();
    stats.insert("createdAt".into(), Value::String(created_at));
    stats.insert("modifiedAt".into(), Value::String(modified_at));
    stats.insert("lastOpenedAt".into(), Value::String(last_opened_at));
    stats.insert(
        "dwellMs".into(),
        json_number(if dwell.is_finite() && dwell >= 0.0 {
            dwell.floor()
        } else {
            0.0
        }),
    );
    stats.insert(
        "openCount".into(),
        json_number(if opens.is_finite() && opens >= 0.0 {
            opens.floor()
        } else {
            0.0
        }),
    );
    Some(Value::Object(stats))
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
    js_json_number(value)
}

/// `JSON.stringify` for a finite number.
///
/// A whole value that fits in an integer, including `-0`, is written as `16`
/// or `0`. Other values keep the shortest round trip.
pub fn js_json_number(value: f64) -> Value {
    if value == 0.0 {
        return Value::from(0);
    }
    if value.is_finite() && value.fract() == 0.0 {
        let integer = value as i64;
        if integer as f64 == value {
            return Value::from(integer);
        }
    }
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::from(0))
}

pub fn canonical_iso(value: &str) -> Option<String> {
    v8_date::canonical_iso(value)
}

/// Milliseconds since the Unix epoch for `Date.parse`, or `None` when the
/// text is not a date or the instant is outside the JavaScript time limit.
pub fn canonical_unix_millis(value: &str) -> Option<i64> {
    v8_date::unix_millis(value)
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
///
/// An array uses `ToString`, so `[12]` is `12` and `[1, 2]` is `NaN`.
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_tonumber(text).unwrap_or(f64::NAN),
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Null) => 0.0,
        Some(other) => js_tonumber(&js_value_string(other)).unwrap_or(f64::NAN),
        None => f64::NAN,
    }
}

/// `String(value)` for `RegExp.test` and `Number` on arrays and objects.
pub fn js_value_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(number) => number.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_value_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_famd, parse_note_links, serialize_famd, FamdPayload, FAMD_SCHEMA};

    #[test]
    fn a_year_or_year_month_is_the_first_day() {
        assert_eq!(
            super::canonical_iso("2026").as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            super::canonical_iso("2026-01").as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            super::canonical_iso("2026T00:00:00Z").as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            super::canonical_iso("2026-01T03:04Z").as_deref(),
            Some("2026-01-01T03:04:00.000Z")
        );
        assert_eq!(
            super::canonical_iso("2026T24:00:00Z").as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        assert_eq!(
            super::canonical_iso("2026-01T24:00:00+02:00").as_deref(),
            Some("2026-01-01T22:00:00.000Z")
        );
        assert_eq!(super::canonical_iso("2026-1T00:00:00Z"), None);
        assert_eq!(super::canonical_iso("2026-1-2T00:00:00Z"), None);
        assert_eq!(super::canonical_iso("2026-00"), None);
        assert_eq!(super::canonical_iso("2026-13"), None);
    }

    #[test]
    fn a_local_time_uses_the_desktop_daylight_saving_choice() {
        // `Date.parse` without a zone uses the local zone. In an overlap it
        // keeps the earlier instant. A skipped hour uses the offset from
        // before the transition.
        with_tz("Europe/Berlin", || {
            assert_eq!(
                super::canonical_iso("2026-10-25T02:30:00").as_deref(),
                Some("2026-10-25T00:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-25T02:30:00.123").as_deref(),
                Some("2026-10-25T00:30:00.123Z")
            );
            assert_eq!(
                super::canonical_iso("2026-03-29T02:30:00").as_deref(),
                Some("2026-03-29T01:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-01-02T03:04:05").as_deref(),
                Some("2026-01-02T02:04:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-07-02T03:04:05").as_deref(),
                Some("2026-07-02T01:04:05.000Z")
            );
        });
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-11-01T01:30:00").as_deref(),
                Some("2026-11-01T05:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-03-08T02:30:00").as_deref(),
                Some("2026-03-08T07:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-01-02T03:04:05").as_deref(),
                Some("2026-01-02T08:04:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-07-02T03:04:05").as_deref(),
                Some("2026-07-02T07:04:05.000Z")
            );
        });
        with_tz("Australia/Lord_Howe", || {
            assert_eq!(
                super::canonical_iso("2026-01-02T03:04:05").as_deref(),
                Some("2026-01-01T16:04:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-07-02T03:04:05").as_deref(),
                Some("2026-07-01T16:34:05.000Z")
            );
        });
    }

    #[test]
    fn a_month_name_is_local_midnight() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("Oct 13, 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13, 2026 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13, 2026 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_hyphenated_month_matches_date_parse() {
        with_tz("America/New_York", || {
            // `Tuesday, 13-Oct-26 16:00:00 GMT` is 13 October 2026 at 16:00 UTC.
            assert_eq!(
                super::canonical_iso("13-Oct-26 16:00:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Tuesday, 13-Oct-26 16:00:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Wed, 13-Oct-26 16:00:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            // A date alone is local midnight. `2026 Oct 13` is year, month, day.
            assert_eq!(
                super::canonical_iso("13-Oct-26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-Oct-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026 Oct 13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13/Oct/26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13.Oct.26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("32-Oct-26").as_deref(),
                Some("2032-10-26T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("00-Oct-13").as_deref(),
                Some("2000-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct-26 16:00:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct-26 16:00:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct-26 4:00:00 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("32-Oct-32"), None);
            assert_eq!(super::canonical_iso("13-Oct-+26"), None);
            assert_eq!(super::canonical_iso("13-Oct-26T16:00:00 GMT"), None);
        });
    }

    #[test]
    fn a_month_and_one_number_defaults_the_missing_field() {
        with_tz("America/New_York", || {
            // A day without a year is 2001. A year without a day is the 1st.
            assert_eq!(
                super::canonical_iso("13-Oct").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13 Oct").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-26").as_deref(),
                Some("2001-10-26T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-Oct").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("32-Oct").as_deref(),
                Some("2032-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("00-Oct").as_deref(),
                Some("2000-10-01T04:00:00.000Z")
            );
            // 32 is a year, so the following number is the day.
            assert_eq!(
                super::canonical_iso("Oct 32 16").as_deref(),
                Some("2032-10-16T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16").as_deref(),
                Some("2016-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-2026 16:00 GMT").as_deref(),
                Some("2026-10-01T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct 16:00").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13 Oct 16:00 EST").as_deref(),
                Some("2001-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 GMT").as_deref(),
                Some("2001-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Tue, 13-Oct").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct +2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("13 Oct +16"), None);
            assert_eq!(super::canonical_iso("Oct"), None);
        });
    }

    #[test]
    fn words_before_a_month_date_are_ignored() {
        with_tz("America/New_York", || {
            // `Date.parse` skips words until the month or a number. A word after
            // the date is NaN. `GMT` before the date is not a zone.
            assert_eq!(
                super::canonical_iso("foo Oct 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo 13 Oct 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello Tuesday, 13-Oct-26 16:00:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo 13-Oct").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("the 13 Oct 16:00 EST").as_deref(),
                Some("2001-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("EST 13-Oct-26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("AM Oct 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo Oct 2026 4:00 PM").as_deref(),
                Some("2026-10-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo Monday, Oct 13, 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("the 32-Oct").as_deref(),
                Some("2032-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("note Oct 13, 2026 16:00:00.5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("13 Oct 2026 foo"), None);
            assert_eq!(super::canonical_iso("Oct 2026 foo"), None);
            assert_eq!(super::canonical_iso("13 foo Oct 2026"), None);
            assert_eq!(super::canonical_iso("2026 foo Oct 13"), None);
            assert_eq!(super::canonical_iso("Oct 2026 AM"), None);
        });
    }

    #[test]
    fn a_word_between_the_month_and_its_number_is_ignored() {
        with_tz("America/New_York", || {
            // Noise is skipped only before the first number. The last month name wins.
            assert_eq!(
                super::canonical_iso("Oct foo 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo Oct foo 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo 13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo 13 16:00").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo 2026 GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo 13 2026 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct Tuesday 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo 32 16").as_deref(),
                Some("2032-10-16T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-foo-2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo-Oct-2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct--2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo bar 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct foo +2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            // `Nov` replaces `Oct`. November 2026 is standard time.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 Nov").as_deref(),
                Some("2026-11-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-Nov-2026").as_deref(),
                Some("2026-11-01T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 foo 2026"), None);
            assert_eq!(super::canonical_iso("Oct foo 13 foo 2026"), None);
            assert_eq!(super::canonical_iso("13 Oct foo 2026"), None);
            assert_eq!(super::canonical_iso("13-Oct--26"), None);
            assert_eq!(super::canonical_iso("13--Oct"), None);
        });
    }

    #[test]
    fn a_trailing_number_after_a_month_date_is_ignored() {
        with_tz("America/New_York", || {
            // One bare number after the day and year is not a time. `Oct 13 16`
            // is still 13 October 2016, because that 16 is the year.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13 Oct 2026 16").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo Oct 13 2026 16").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT 16").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 16").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 16 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 5 2026").as_deref(),
                Some("2005-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 2026 16 99").as_deref(),
                Some("2026-10-16T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 Nov 16").as_deref(),
                Some("2026-11-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5 16").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16").as_deref(),
                Some("2016-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16 17"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16 hello"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 +16"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16.5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 16 17"), None);
        });
    }

    #[test]
    fn an_out_of_range_month_time_field_is_a_date_number() {
        with_tz("America/New_York", || {
            // `16:00:60` is 16:00. The 60 is a date number. With a day and a
            // year already set, that extra number is ignored.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:100").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:01:60").as_deref(),
                Some("2026-10-13T20:01:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 24:00:60").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:60").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:59").as_deref(),
                Some("2026-10-13T20:00:59.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            // No year yet, so the out-of-range field is the year, including 1960.
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:60").as_deref(),
                Some("1960-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:70").as_deref(),
                Some("1970-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:2026").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 16:00:2026").as_deref(),
                Some("2026-10-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 16:60").as_deref(),
                Some("1960-10-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:60 GMT").as_deref(),
                Some("1960-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:100").as_deref(),
                Some("0100-10-13T20:56:02.000Z")
            );
            // The next in-range number fills the open time slot.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 16").as_deref(),
                Some("2026-10-13T20:00:16.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 16 GMT").as_deref(),
                Some("2026-10-13T16:00:16.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:60 16").as_deref(),
                Some("1960-10-13T20:00:16.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:2026 61").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:60.5").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:60.5").as_deref(),
                Some("1960-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60.5").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60.05").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60.50").as_deref(),
                Some("2026-10-13T20:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:60.5").as_deref(),
                Some("1960-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:60.500").as_deref(),
                Some("1960-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:59.5").as_deref(),
                Some("2026-10-13T20:00:59.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:59.05").as_deref(),
                Some("2026-10-13T20:00:59.050Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00:60 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 4:00:60 PM").as_deref(),
                Some("1960-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:60 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00:60 PM EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 4:00:2026 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:5 PM").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13T16:00:60Z"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00:60"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00:60 PM"), None);
            assert_eq!(super::canonical_iso("10/13/2026 16:00:60"), None);
            // `10/13 16:00:60` has no year yet, so 60 is 1960. A finished
            // slash date still rejects that second.
            assert_eq!(
                super::canonical_iso("10/13 16:00:60").as_deref(),
                Some("1960-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:60").as_deref(),
                Some("1960-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00:60 EST").as_deref(),
                Some("1960-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 24:00:60").as_deref(),
                Some("1960-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00:60 16").as_deref(),
                Some("1960-10-13T20:00:16.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 4:00:60 PM").as_deref(),
                Some("1960-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00:70").as_deref(),
                Some("1970-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00:59").as_deref(),
                Some("2001-10-13T20:00:59.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16:60:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:60 61"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:60.500"), None);
            assert_eq!(super::canonical_iso("Oct 2026 16:00:60"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16 16:00:60"), None);
            assert_eq!(super::canonical_iso("Oct 13 16:00:2026 61 62"), None);
        });
    }

    #[test]
    fn a_hyphen_run_after_an_open_clock_is_an_offset() {
        with_tz("America/New_York", || {
            // `60` is the year. `10` fills the open second, and `-2026` is
            // UTC−20:26. The middle `-13` is replaced. A finished second
            // still reads the hyphen run as a date.
            assert_eq!(
                super::canonical_iso("16:00:60 10-13-2026").as_deref(),
                Some("1960-01-02T12:26:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:60 10-13-2026").as_deref(),
                Some("1960-01-02T12:36:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:60 1-2-3").as_deref(),
                Some("1960-01-01T19:00:01.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:60 10-13").as_deref(),
                Some("1960-01-02T05:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:60 1-25").as_deref(),
                Some("1960-01-02T17:00:01.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:2026 10-13-2026").as_deref(),
                Some("2026-01-02T12:26:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:60 GMT 10-13-2026").as_deref(),
                Some("1960-01-02T12:26:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:60 10-13-2026 EST").as_deref(),
                Some("1960-01-01T21:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:30 1-2-3").as_deref(),
                Some("2003-01-02T21:00:30.000Z")
            );
            assert_eq!(super::canonical_iso("24:00:60 10-13-2026"), None);
            assert_eq!(super::canonical_iso("16:00:60 2026-10-13"), None);
        });
    }

    #[test]
    fn a_sign_after_a_leading_word_is_padding() {
        with_tz("America/New_York", || {
            // `hello+5` is May. The word and the sign are ignored before the
            // first number. A month keeps the sign as a separator, and a
            // clock after the sign is empty.
            assert_eq!(
                super::canonical_iso("hello+5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMe-5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("x+5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("note+2026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct+5").as_deref(),
                Some("2001-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("hello+5:30"), None);
            assert_eq!(super::canonical_iso("abc+13"), None);
        });
    }

    #[test]
    fn a_numeric_offset_after_a_time_is_a_fixed_zone() {
        with_tz("America/New_York", || {
            // `+5` after a clock is five hours east of UTC. A sign with no clock
            // is not an offset. The last zone word wins.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 -5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +05:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:3").as_deref(),
                Some("2026-10-13T10:57:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +0530").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +530").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:60").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +0560").as_deref(),
                Some("2026-10-13T10:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 +16").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +24").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 -24").as_deref(),
                Some("2026-10-14T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 24:00 +5").as_deref(),
                Some("2026-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:30.5 +5").as_deref(),
                Some("2026-10-13T11:00:30.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT +5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 +5 PM").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 EST +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +24").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 +5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 EST +5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +5:30:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 PM +5"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00+24:00"), None);
        });
    }

    #[test]
    fn a_longer_month_word_uses_its_first_three_letters() {
        with_tz("America/New_York", || {
            // `Date.parse` treats any word whose first three letters name a month
            // as that month. Digits glued to that word are separate fields.
            assert_eq!(
                super::canonical_iso("Octopus 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Octxxx 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("OCTOPUS 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Market 13 2026").as_deref(),
                Some("2026-03-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Maybe 13 2026").as_deref(),
                Some("2026-05-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Julian 4 2026").as_deref(),
                Some("2026-07-04T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Janitor 2026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Decemberish 13 2026").as_deref(),
                Some("2026-12-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Septober 13 2026").as_deref(),
                Some("2026-09-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Augusto 13 2026").as_deref(),
                Some("2026-08-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Aprilfool 2026").as_deref(),
                Some("2026-04-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Octopus-26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13.Octopus.26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13/Octopus/26").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13octopus2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4Jul2026").as_deref(),
                Some("2026-07-04T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026Oct13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Octopus Novemberish 2026").as_deref(),
                Some("2026-11-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo Octopus 13 2026 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Octopus 32 16").as_deref(),
                Some("2032-10-16T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Ma 13 2026"), None);
            assert_eq!(super::canonical_iso("Octopus"), None);
            assert_eq!(super::canonical_iso("Octopus 13 foo 2026"), None);
            assert_eq!(super::canonical_iso("foo13 Oct 2026"), None);
            assert_eq!(super::canonical_iso("Oct13th"), None);
            assert_eq!(super::canonical_iso("13th Oct 2026"), None);
        });
    }

    #[test]
    fn a_zone_keyword_glued_to_digits_is_still_a_zone() {
        with_tz("America/New_York", || {
            // `GMT5` is the zone `GMT` and then the number 5. Before any number,
            // that glue is not a date. `16:00EST` stays empty; only `Z` may sit
            // against a finished clock.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 GMT5").as_deref(),
                Some("2005-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 EST13").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 EST13").as_deref(),
                Some("2013-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 UT5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 UTC5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 Z5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("oct 13 2026 gmt5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct13EST2026").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13OctEST2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026PST").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 pst8").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 EDT4").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 CDT5").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 CST6").as_deref(),
                Some("2026-10-13T06:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 MST7").as_deref(),
                Some("2026-10-13T07:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 MDT6").as_deref(),
                Some("2026-10-13T06:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 PDT7").as_deref(),
                Some("2026-10-13T07:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 2026 GMT5").as_deref(),
                Some("2026-10-05T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13UT5").as_deref(),
                Some("2005-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct13GMT5").as_deref(),
                Some("2005-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026UTC").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct-26GMT5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5GMT Oct 13 2026").as_deref(),
                Some("2013-10-05T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Wed Oct 13 2026 GMT5").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT5").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 EST5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 UT5").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00Z5").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5Z5").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16::30Z5").as_deref(),
                Some("2026-10-13T16:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:60 GMT5").as_deref(),
                Some("2026-10-13T16:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 GMT5").as_deref(),
                Some("2026-10-13T16:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:60 GMT5").as_deref(),
                Some("1960-10-13T16:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 24:00 GMT5").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("EST Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Z Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("GMT5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("EST13 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("UT5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("Z5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("Oct GMT5"), None);
            assert_eq!(super::canonical_iso("Oct GMT5 13 2026"), None);
            assert_eq!(super::canonical_iso("hello GMT5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMTX5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 ESTX13"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00EST"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00GMT5"), None);
            assert_eq!(super::canonical_iso("foo5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("AM5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 4:00PM5"), None);
            // Node 22. A month or zone between numbers is its own word, and the
            // clock stays on the colon. A dot before the zone is only a separator.
            assert_eq!(
                super::canonical_iso("2026Oct16:00").as_deref(),
                Some("2026-10-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026EST16:00").as_deref(),
                Some("2026-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026Z16:00").as_deref(),
                Some("2026-01-01T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.EST").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.Z").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10.EST").as_deref(),
                Some("2001-10-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct16:00").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct16:002026").as_deref(),
                Some("2026-10-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:EST2026").as_deref(),
                Some("2026-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.EST16:00").as_deref(),
                Some("2026-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13.Oct16:00").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026Oct16:00:00.5").as_deref(),
                Some("2026-10-01T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026Oct16::30").as_deref(),
                Some("2026-10-01T20:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026Oct16:00:00.5EST").as_deref(),
                Some("2026-10-01T21:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("2026Oct16:00.5"), None);
            assert_eq!(super::canonical_iso("2026Oct16::30EST"), None);
            assert_eq!(super::canonical_iso("2026Oct4:00PM"), None);
            assert_eq!(super::canonical_iso("16:00EST"), None);
        });
    }

    #[test]
    fn a_meridiem_glued_to_digits_is_still_a_meridiem() {
        with_tz("America/New_York", || {
            // `PM5` is `PM` and then the number 5. Before a clock, that glue is
            // not a date. `4:00PM5` stays empty because the meridiem touches the clock.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM5").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 AM5").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM50").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM 5").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:00 PM5 Oct 13 2026").as_deref(),
                Some("2013-10-05T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 12:00 AM5").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 12:00 PM5").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:5 PM5").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00:30 PM5").as_deref(),
                Some("2026-10-13T20:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00:60 PM5").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:60 PM5").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 4:00 PM5 Oct 13 2026").as_deref(),
                Some("2013-10-05T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 11:00 PM5").as_deref(),
                Some("2026-10-14T03:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("PM 5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("AM Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM EST5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 4:00 PM5").as_deref(),
                Some("2005-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 4:00:60 PM5").as_deref(),
                Some("1960-10-13T20:00:05.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 4:00PM5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 4:00AM5"), None);
            assert_eq!(super::canonical_iso("4:00PM5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("PM5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("AM5 Oct 13 2026"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 PM5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 4 PM5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 4:00 PMX5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 4:00 p.m.5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 11 PM5"), None);
            assert_eq!(super::canonical_iso("16:00 PM5 Oct 13 2026"), None);
        });
    }

    #[test]
    fn a_number_without_a_month_is_a_legacy_date() {
        with_tz("America/New_York", || {
            // One number from 1 to 31 is that month in 2001. A larger number is
            // 1 January of that year. A zone or a clock does not need a month name.
            assert_eq!(
                super::canonical_iso("5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("12").as_deref(),
                Some("2001-12-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("32").as_deref(),
                Some("2032-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50").as_deref(),
                Some("1950-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 GMT").as_deref(),
                Some("2001-05-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5GMT").as_deref(),
                Some("2001-05-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5EST").as_deref(),
                Some("2001-05-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50GMT").as_deref(),
                Some("1950-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1 GMT").as_deref(),
                Some("2001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("12 GMT").as_deref(),
                Some("2001-12-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("32 GMT").as_deref(),
                Some("2032-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 GMT").as_deref(),
                Some("2001-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 10 13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026 10").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026 10 GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 16:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026 10 13 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 4:00 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:00 PM5").as_deref(),
                Some("2001-05-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:00:60 PM5").as_deref(),
                Some("1960-01-01T21:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("5GMT5").as_deref(),
                Some("2001-05-05T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5EST13").as_deref(),
                Some("2001-05-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026EST").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0 1 2").as_deref(),
                Some("2000-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99 1 2").as_deref(),
                Some("1999-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 16:00 +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026 24:00 GMT").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("13"), None);
            assert_eq!(super::canonical_iso("31"), None);
            assert_eq!(super::canonical_iso("hello 13"), None);
            assert_eq!(super::canonical_iso("13 GMT"), None);
            assert_eq!(super::canonical_iso("13 2026 GMT"), None);
            assert_eq!(super::canonical_iso("10 13 2026 GMT5"), None);
            assert_eq!(super::canonical_iso("10 13 2026 4:00 PM5"), None);
            assert_eq!(super::canonical_iso("4:00 PM"), None);
            assert_eq!(super::canonical_iso("16:00"), None);
            assert_eq!(super::canonical_iso("16:00 GMT"), None);
            assert_eq!(super::canonical_iso("13 1 2026"), None);
            assert_eq!(super::canonical_iso("10 13 2026 16:00:60"), None);
            assert_eq!(super::canonical_iso("10 13 2026 16:60"), None);
        });
    }

    #[test]
    fn a_hyphen_date_keeps_a_zone_keyword() {
        with_tz("America/New_York", || {
            // `2026-10-13` alone is UTC. The same fields with `GMT` stay UTC, and
            // `EST` is midnight Eastern. A fourth number is not a date.
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 UTC").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13Z").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 Z").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1 GMT").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1GMT").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10 GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2-31-1 GMT").as_deref(),
                Some("2001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2-31-1GMT").as_deref(),
                Some("2001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-02-31 GMT").as_deref(),
                Some("2026-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("49-1-1 GMT").as_deref(),
                Some("2049-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99-1-2 EST").as_deref(),
                Some("1999-01-02T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 GMT5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 EST5"), None);
            assert_eq!(super::canonical_iso("13-1-2026 GMT"), None);
        });
    }

    #[test]
    fn a_leading_gmt_offset_is_a_date_field() {
        with_tz("America/New_York", || {
            // Before any number, `GMT+5` ignores the keyword and the sign. The 5
            // is a date field. After a number, the same token is an offset.
            assert_eq!(
                super::canonical_iso("GMT+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT-5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("UTC+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("UT+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello GMT+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+05 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+24 Oct 13 2026").as_deref(),
                Some("2013-10-24T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT +5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT-5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT +5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 GMT+5").as_deref(),
                Some("2001-04-30T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+5:30 Oct 13 2026").as_deref(),
                Some("2026-10-13T09:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+0530 Oct 13 2026").as_deref(),
                Some("0530-10-13T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT-5").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:30").as_deref(),
                Some("2026-10-12T18:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT-5").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT-5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+05:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+ Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 +5"), None);
        });
    }

    #[test]
    fn parentheses_are_comments_in_a_date() {
        with_tz("America/New_York", || {
            // A parenthetical group is skipped, including an unclosed one. A `)`
            // with no `(`, after a number, is not a date.
            assert_eq!(
                super::canonical_iso("Oct 13 (2026)").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct (13) 2026").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 (foo) 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 (comment) 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 (EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 (foo (bar) baz) 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 (2026").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 (EST) GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(") Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo(bar) Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("(EST) Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 (16:00)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 (16) 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("((EST)) Oct 13 2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 (PM)").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM (EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 (foo)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 (EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 (EST) GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 (EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 (comment)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13) 2026"), None);
            assert_eq!(super::canonical_iso("4:00 PM)"), None);
            assert_eq!(super::canonical_iso("16:00Z)"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00 PM)"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00 PM) EST"), None);
            assert_eq!(super::canonical_iso("2026 EST)"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 EST)"), None);
            assert_eq!(super::canonical_iso("4:00 PM )"), None);
            assert_eq!(
                super::canonical_iso("Oct) 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("EST) 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello) 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Monday) Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(")16:00 2026-10-13").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 ) 16:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 )"), None);
            assert_eq!(super::canonical_iso("13 (Oct) 2026"), None);
            assert_eq!(super::canonical_iso("2026-10-13)"), None);
        });
    }

    #[test]
    fn a_glued_parenthetical_keeps_a_date_local() {
        with_tz("America/New_York", || {
            // A `(` stops a strict ISO date, so the calendar stays local. The
            // same mark after a finished clock is empty. A fraction, `Z`, or a
            // real zone after the comment still counts.
            assert_eq!(
                super::canonical_iso("2026-10-13(EST)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13(GMT)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13()").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026(EST)").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10(EST)").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("(EST)2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("((EST))2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13(EST").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13(EST)16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13(EST)GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13Z(EST)").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026(EST)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5(EST)").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z(EST)").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+05:00(EST)").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM(EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13(EST)").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50(EST)").as_deref(),
                Some("1950-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13(EST)16:00").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00(EST)"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00(EST)"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00(EST)"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00:123(EST)"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00(EST)"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00:00Z(EST)"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00(EST"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00(EST)"), None);
        });
    }

    #[test]
    fn a_space_before_an_open_clock_fills_the_missing_fields() {
        with_tz("America/New_York", || {
            // A legacy clock may leave a field empty. `16:` is 16:00, `16::30`
            // is 16:00:30, and `16:.5` is 16:05. A `T` clock still needs two digits.
            assert_eq!(
                super::canonical_iso("2026-10-13 16:").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16::").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16::00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16::30").as_deref(),
                Some("2026-10-13T20:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:5").as_deref(),
                Some("2026-10-13T08:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:5:6").as_deref(),
                Some("2026-10-13T08:05:06.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 016:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:000").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:.5").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:.5").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00:.5").as_deref(),
                Some("2026-10-13T20:00:00.005Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00:123").as_deref(),
                Some("2026-10-13T20:00:00.123Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00:5").as_deref(),
                Some("2026-10-13T20:00:00.005Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:(EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24:").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24::").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16::30").as_deref(),
                Some("1950-10-13T21:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:5").as_deref(),
                Some("1950-10-13T09:05:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00::"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:60:"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00:1234"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:"), None);
            assert_eq!(super::canonical_iso("2026-10-13T4:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13T016:00"), None);
            assert_eq!(super::canonical_iso("1950-10-13T16:"), None);
        });
    }

    #[test]
    fn a_later_zone_replaces_a_numeric_offset() {
        with_tz("America/New_York", || {
            // `+5` is an offset until a zone keyword follows it. That keyword
            // replaces the offset, including `+24`, so the day does not move.
            // `16:00EST` is still empty: only `Z` may touch a finished clock.
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5:30 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:+5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+24 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00-5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5UTC").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5EDT").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5PST").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+24EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00+5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00+5EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00+5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00+5EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z-5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+05:00").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+0500").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z -5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z EST GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+5 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+24").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00Z2026-10-13").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00ZZ"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00zz"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00Zz"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00ZZ"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00ZEST"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00Zfoo"), None);
            assert_eq!(super::canonical_iso("16:00ZZ 2026-10-13"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00+5 GMT").as_deref(),
                Some("1950-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00+5EST").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00+24EST").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00EST"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00+5GMT5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00+5Z5"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00+5"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00EST"), None);
        });
    }

    #[test]
    fn a_meridiem_can_carry_an_offset() {
        with_tz("America/New_York", || {
            // `PM+5` is the meridiem and then an offset. `4:00PM+5` is empty
            // because the meridiem touches the clock. A `T` form is empty too.
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5:3").as_deref(),
                Some("2026-10-13T10:57:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+0530").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM-5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 AM+5").as_deref(),
                Some("2026-10-12T23:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 12:00 AM+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 12:00 PM+5").as_deref(),
                Some("2026-10-13T07:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+24").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 pm+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:5 PM+5").as_deref(),
                Some("2026-10-13T11:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4: PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 4:00 PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 4: PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00 PM+5").as_deref(),
                Some("1950-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00 PM+5EST").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 12:00 AM+5").as_deref(),
                Some("1950-10-12T19:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 4:00PM+5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00 PMGMT"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00 PM+"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 PM+5"), None);
            assert_eq!(super::canonical_iso("2026-10-13T4:00 PM+5"), None);
            assert_eq!(super::canonical_iso("1950-10-13T4:00 PM+5"), None);
        });
    }

    #[test]
    fn a_later_meridiem_replaces_an_earlier_one() {
        with_tz("America/New_York", || {
            // The last `AM` or `PM` is the one that changes the hour. A meridiem
            // after a number and before the clock is not a date.
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 AM PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM AM").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 AM AM").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 12:00 PM AM").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 12:00 AM PM").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM AM+5").as_deref(),
                Some("2026-10-12T23:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 AM PM+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM PM EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM AM EST").as_deref(),
                Some("2026-10-13T09:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM EST AM").as_deref(),
                Some("2026-10-13T09:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM GMT AM").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM AM PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: PM AM").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:5 PM AM").as_deref(),
                Some("2026-10-13T08:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 AM PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 4:00 PM AM").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("PM Oct 13 2026 4:00 AM").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:00 PM 2026-10-13 AM").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00 PM AM").as_deref(),
                Some("1950-10-13T09:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00 AM PM").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00 PM AM EST").as_deref(),
                Some("1950-10-13T09:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 PM 4:00 AM"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00 PM 5 AM"), None);
            assert_eq!(super::canonical_iso("2026-10-13T4:00 PM AM"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 PM AM"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00PM AM"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00 PMAM"), None);
            assert_eq!(super::canonical_iso("1950-10-13 PM 4:00 AM"), None);
        });
    }

    #[test]
    fn a_fraction_can_carry_a_glued_meridiem() {
        with_tz("America/New_York", || {
            // `4:00:00.5PM` is 16:00:00.500. The fraction finished the clock, so
            // `PM` may touch it. `4:00PM` and `4:00.5PM` are still empty.
            // A later slash offset replaces the earlier one: `+5 +6` is UTC+6.
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.5PM").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.5pm").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.5AM").as_deref(),
                Some("2026-10-13T08:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 12:00:00.5AM").as_deref(),
                Some("2026-10-13T04:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.123PM").as_deref(),
                Some("2026-10-13T20:00:00.123Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.5PM+5").as_deref(),
                Some("2026-10-13T11:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.5PM EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00:00.5PM").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 4:00:00.5PM").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5 +6").as_deref(),
                Some("2026-10-13T10:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +6 +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5 +6 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00:00.5PM").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00:00.5AM").as_deref(),
                Some("1950-10-13T09:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00:00.5PM EST").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 4:00.5PM"), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00:00PM"), None);
            assert_eq!(super::canonical_iso("1950-10-13 4:00:00PM"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5est").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5EDT").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5PST").as_deref(),
                Some("2026-10-14T00:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5CDT").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5GMT").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5UTC").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5UT").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5Z").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.500EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5GMT+5").as_deref(),
                Some("2026-10-13T11:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5GMT+5:30").as_deref(),
                Some("2026-10-13T10:30:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5EST GMT").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00:00.5EST").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00.5foo"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00.5EST5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00.5Z5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00EST"), None);
            assert_eq!(super::canonical_iso("16:00:00.5EST"), None);
        });
    }

    #[test]
    fn an_extra_colon_in_an_offset_is_ignored() {
        with_tz("America/New_York", || {
            // `+5::30` is +5:30. Extra colons before the minute are ignored.
            // `+5::` is +5:00. A colon after a minute number still starts a clock.
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5::").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5:::").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00.5PM+5::30").as_deref(),
                Some("2026-10-13T10:30:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5::30 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5::30").as_deref(),
                Some("1950-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5::").as_deref(),
                Some("1950-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00:00.5PM+5::30").as_deref(),
                Some("1950-10-13T10:30:00.500Z")
            );
        });
    }

    #[test]
    fn a_field_may_start_with_a_colon() {
        with_tz("America/New_York", || {
            // `4: :5` is 4:05. `+5: :30` is +5:30. The colon at the start of
            // the next field is only a separator.
            assert_eq!(
                super::canonical_iso("2026-10-13 4: :5").as_deref(),
                Some("2026-10-13T08:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: :5 PM").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5: :30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5:. :5").as_deref(),
                Some("2026-10-13T10:55:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 4: :5 PM").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4: :5 PM").as_deref(),
                Some("2026-10-13T20:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct :13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 :16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4: :5").as_deref(),
                Some("1950-10-13T09:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4: :5 PM").as_deref(),
                Some("1950-10-13T21:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5: :30").as_deref(),
                Some("1950-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5:. :5").as_deref(),
                Some("1950-10-13T10:55:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/1950 4: :5 PM").as_deref(),
                Some("1950-10-13T21:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct :13 1950").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 :16:00").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_later_sign_replaces_a_glued_offset() {
        with_tz("America/New_York", || {
            // `+5-30` after a clock is UTC−30. Before a clock it is 30 May.
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5-30").as_deref(),
                Some("2026-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5-3").as_deref(),
                Some("2026-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00+5-30").as_deref(),
                Some("2026-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5-30").as_deref(),
                Some("2026-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5-3:30").as_deref(),
                Some("2026-10-13T19:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5:30-8").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 -5+8").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5-30").as_deref(),
                Some("2026-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5-3").as_deref(),
                Some("2026-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM+5-3").as_deref(),
                Some("2026-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5-30 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+5-3").as_deref(),
                Some("2026-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-13-2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+5-30").as_deref(),
                Some("2001-05-30T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+5-30").as_deref(),
                Some("2001-05-30T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13T16:00+5-30"), None);
            assert_eq!(super::canonical_iso("2026-10-13-5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 --5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +-5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5-+8"), None);
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5-30").as_deref(),
                Some("1950-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5-3").as_deref(),
                Some("1950-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00+5-30").as_deref(),
                Some("1950-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 GMT+5-3:30").as_deref(),
                Some("1950-10-13T19:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5:30-8").as_deref(),
                Some("1950-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/1950 16:00 +5-30").as_deref(),
                Some("1950-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 +5-3").as_deref(),
                Some("1950-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 4:00 PM+5-3").as_deref(),
                Some("1950-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 +5-30 EST").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 EST+5-3").as_deref(),
                Some("1950-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z-10-13").as_deref(),
                Some("2026-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z-10").as_deref(),
                Some("2026-10-14T02:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z-13").as_deref(),
                Some("2026-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00-10-13").as_deref(),
                Some("2026-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+5-30").as_deref(),
                Some("2026-10-14T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z+10-13").as_deref(),
                Some("2026-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z +10 -13").as_deref(),
                Some("2026-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00Z-10-13 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00Z-13").as_deref(),
                Some("1950-10-14T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00Z-10-13"), None);
            assert_eq!(
                super::canonical_iso("16:00 GMT+5: 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 +5: 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 GMT+5: 2026-10").as_deref(),
                Some("2026-01-01T10:50:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: +5 2026-10-13").as_deref(),
                Some("2026-01-02T05:10:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: GMT+5 2026-10-13").as_deref(),
                Some("2026-01-02T05:10:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: EST 2026-10-13").as_deref(),
                Some("2026-01-02T05:10:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: GMT+5: 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 GMT+5: 2026-10-13 EST").as_deref(),
                Some("2026-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:00.5 GMT+5: 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("4:5 GMT+5: 2026-10-13").as_deref(),
                Some("2026-01-01T17:05:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00 GMT+5: 30"), None);
            assert_eq!(super::canonical_iso("16:00 GMT+5: 2026-60-13"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5:").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5: 30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: +5.30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: +5/30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:: +5.30").as_deref(),
                Some("2026-10-13T11:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:: +5/30").as_deref(),
                Some("2026-10-13T11:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00: +5.30").as_deref(),
                Some("2026-10-13T11:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:+5.30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: GMT+5.30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: GMT+5/30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: UTC+5/30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: -5.30").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: +5.3").as_deref(),
                Some("2026-10-13T11:03:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: +5.5").as_deref(),
                Some("2026-10-12T23:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16: +5.30 EST").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: +5.5 EST").as_deref(),
                Some("2026-10-13T09:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:60 +5.30").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:60 +5.30").as_deref(),
                Some("2026-10-13T11:00:30.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5.30"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5/30"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16: +5.60"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16: +5.30EST"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16::30 +5.10"), None);
            assert_eq!(super::canonical_iso("16: +5.30"), None);
            assert_eq!(
                super::canonical_iso("16: GMT+5: 2026/10/13").as_deref(),
                Some("2026-01-01T11:03:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:: GMT+5: 2026/10/13").as_deref(),
                Some("2026-01-01T10:50:13.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: GMT+5: 2026/1/2").as_deref(),
                Some("2026-01-01T11:01:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: +5/30 10/13/2026").as_deref(),
                Some("2026-10-13T11:30:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00 GMT+5: 10/13/2026"), None);
            assert_eq!(super::canonical_iso("16: +5 10/13/2026"), None);
            assert_eq!(super::canonical_iso("16: 10/13/2026"), None);
            assert_eq!(super::canonical_iso("16: GMT+5 10/13/2026"), None);
            assert_eq!(super::canonical_iso("16: GMT+5:30 10/13/2026"), None);
            assert_eq!(super::canonical_iso("16: +5 2026/10/13"), None);
            assert_eq!(super::canonical_iso("16:: 2026/1/2"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00Z-10-13"), None);
        });
    }

    #[test]
    fn a_month_name_replaces_a_slash_date() {
        with_tz("America/New_York", || {
            // `10/13/2026 January` is 10 January 2013. The first number is the
            // day, the second is the year, and the slash month is replaced.
            assert_eq!(
                super::canonical_iso("10/13/2026 January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13 January").as_deref(),
                Some("2026-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 January 16:00").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 January").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1/2/3 January").as_deref(),
                Some("2002-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13/10/2026 January").as_deref(),
                Some("2010-01-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/32/2026 January").as_deref(),
                Some("2032-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 January EST").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/13/01 January").as_deref(),
                Some("2026-01-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99/1/2 January").as_deref(),
                Some("1999-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 Oct").as_deref(),
                Some("2013-10-10T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("January 10/13/2026").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10//13 January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/ January").as_deref(),
                Some("2001-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("/10/13/2026 January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/50 January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("10/13/2026 January +5"), None);
            assert_eq!(super::canonical_iso("10/13/2026 January PM"), None);
            assert_eq!(super::canonical_iso("10/13/2026/1 January"), None);
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950/10/13 January").as_deref(),
                Some("1950-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/1950 January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950/13/01 January").as_deref(),
                Some("1950-01-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/1950 Oct").as_deref(),
                Some("2013-10-10T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950/10/13 January 16:00").as_deref(),
                Some("1950-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/1950 January EST").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_trailing_hyphen_is_padding_before_a_month() {
        with_tz("America/New_York", || {
            // `10-13- January` is 10 January 2013. The last hyphen is padding.
            // `2026-10-13- January` already finished a strict date, so it is empty.
            assert_eq!(
                super::canonical_iso("10-13- January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10- January").as_deref(),
                Some("2001-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10-13-2026- January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10- January").as_deref(),
                Some("2026-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-10-13- January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10-13- January 16:00").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10-13- Oct").as_deref(),
                Some("2013-10-10T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1-2- January").as_deref(),
                Some("2002-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99-1- January").as_deref(),
                Some("1999-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10-13-50- January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13- January"), None);
            assert_eq!(super::canonical_iso("10-13-- January"), None);
            assert_eq!(super::canonical_iso("10--13 January"), None);
            assert_eq!(
                super::canonical_iso("10-13-2026-").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10- January").as_deref(),
                Some("1950-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-13- January").as_deref(),
                Some("1950-01-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10-13-1950- January").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("1950-10-13- January"), None);
            assert_eq!(
                super::canonical_iso("10-13-1950-").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_non_ascii_letter_does_not_panic() {
        with_tz("America/New_York", || {
            // `Octöber` is October because the first three letters match and a
            // longer word is still a month. `Mäy` is not May, and it must not panic.
            assert_eq!(
                super::canonical_iso("Octöber 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Octöber 13 2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Mäy 13 2026"), None);
            assert_eq!(
                super::canonical_iso("ä 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 ä"), None);
            assert_eq!(super::canonical_iso("xä 13 2026"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 UTä"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5ä"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 GMT+5ä"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 ESTö"), None);
            assert_eq!(
                super::canonical_iso("Octöber 13 1950").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Octöber 13 1950 16:00").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("ä 1950-10-13").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("1950-10-13 ä"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00 UTä"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00 +5ä"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00 GMT+5ä"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00 ESTö"), None);
        });
    }

    #[test]
    fn a_comma_glued_to_a_finished_clock_is_empty() {
        with_tz("America/New_York", || {
            // `16:00,30` finished the clock on the comma. A space before the
            // comma is an ordinary separator, and a fraction may keep the comma.
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00,30"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00, 30"), None);
            assert_eq!(super::canonical_iso("Oct 13 16:00,30"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00,"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00,"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00,30"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16::30,"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:.5,"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:30,5"), None);
            assert_eq!(super::canonical_iso("10/13/2026 16:00,30"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 ,30").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 , 30").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13, 2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16: Oct 13, 2026"), None);
            assert_eq!(super::canonical_iso("16: Oct 13,2026"), None);
            assert_eq!(super::canonical_iso("16: EST Oct 13, 2026"), None);
            assert_eq!(super::canonical_iso("16: +5 Oct 13, 2026"), None);
            assert_eq!(super::canonical_iso("16: 13, Oct 2026"), None);
            assert_eq!(super::canonical_iso("16:00, Oct 13 2026"), None);
            assert_eq!(
                super::canonical_iso("16: Oct 13 2026").as_deref(),
                Some("2026-10-01T20:13:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:,13 Oct 2026").as_deref(),
                Some("2026-10-01T20:13:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5,").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13,16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:00 PM, Oct 13 2026").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16: Oct 13!2026"), None);
            assert_eq!(super::canonical_iso("16: Oct 13! 2026"), None);
            assert_eq!(super::canonical_iso("16: Oct 13. 2026"), None);
            assert_eq!(super::canonical_iso("16: Oct 13?2026"), None);
            assert_eq!(
                super::canonical_iso("Oct 13!2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:!").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:! EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5:").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5: EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5:2026").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5:EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("16:!"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5,1").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00.05,1").as_deref(),
                Some("2026-10-13T20:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM,5").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:,30").as_deref(),
                Some("2026-10-13T20:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13, 2026,").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 1950 16:00,30"), None);
            assert_eq!(super::canonical_iso("1950-10-13 16:00,"), None);
            assert_eq!(super::canonical_iso("Oct 13 1950 16::30,"), None);
            assert_eq!(super::canonical_iso("10/13/1950 16:00,30"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 ,30").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00:00.5,1").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00.05,1").as_deref(),
                Some("1950-10-13T21:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 4:00 PM,5").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:,30").as_deref(),
                Some("1950-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13, 1950,").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn junk_glued_to_a_finished_clock_is_empty() {
        with_tz("America/New_York", || {
            // `16:00!` and `16:00.` finished the clock. A space before the mark
            // is ordinary, and a fraction may keep the mark.
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00!"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00."), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00/"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00#"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16::30."), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:.5."), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00."), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00!"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 !").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 .").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 /").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5!").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5.").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5/").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM!").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:,").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 )"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 x"), None);
            // Node 22. Junk glued to a finished field rejects the date even when
            // a zone follows it. An open field still ignores the mark.
            assert_eq!(super::canonical_iso("2026-10-13 16:00!GMT"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00#+5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00!+5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 24:00!GMT"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 16:!GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:!GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 !GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.5!GMT").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("4:00 PM!5").as_deref(),
                Some("2001-05-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 (16:00)").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 1950 16:00!"), None);
            assert_eq!(super::canonical_iso("Oct 13 1950 16:00."), None);
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 !").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00Z").as_deref(),
                Some("1950-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00+5").as_deref(),
                Some("1950-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00:00.5!").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 (16:00)").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_dot_after_a_fraction_starts_a_new_field() {
        with_tz("America/New_York", || {
            // `16:00:00.5.1` keeps 16:00:00.500. The second dot starts a date
            // field. A full date has no room for that field.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5.1").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:00.5.1").as_deref(),
                Some("2001-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00.05.1").as_deref(),
                Some("2026-10-13T20:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.50.1").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00.5.1"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00.05.1"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:00.5.1.2"), None);
            assert_eq!(
                super::canonical_iso("10.13.2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5.").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00:00.5.1").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00.05.1").as_deref(),
                Some("1950-10-13T21:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00:00.50.1").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("1950-10-13 16:00:00.5.1"), None);
            assert_eq!(super::canonical_iso("Oct 13 1950 16:00:00.5.1.2"), None);
            assert_eq!(
                super::canonical_iso("10.13.1950").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00:00.5.").as_deref(),
                Some("1950-10-13T21:00:00.500Z")
            );
        });
    }

    #[test]
    fn a_slash_inside_an_offset_is_a_separator() {
        with_tz("America/New_York", || {
            // `+5/30` is five hours, and 30 is a date number. `+5:/30` is
            // five hours and thirty minutes because the minute was still open.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5/30").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:/30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:30/1").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00 +5/30").as_deref(),
                Some("2030-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5/30").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5/30"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 GMT+5/30"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 16:00:00.5/1").as_deref(),
                Some("2001-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 +5/30").as_deref(),
                Some("1950-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 +5:/30").as_deref(),
                Some("1950-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 +5:30/1").as_deref(),
                Some("1950-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:00 GMT+5/30").as_deref(),
                Some("1950-10-13T11:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("1950-10-13 16:00 +5/30"), None);
            assert_eq!(
                super::canonical_iso("10/13/1950").as_deref(),
                Some("1950-10-13T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn ignored_symbols_and_leading_words_make_a_legacy_date() {
        with_tz("America/New_York", || {
            // A pure ISO date is UTC. The same fields with ignored symbols or a
            // leading word are local. `16:00!` and a `)` after a digit are not dates.
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13!").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("#2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(")2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("*2026-10-13*").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("!!2026-10-13!!").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("#2026-10-13 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13!16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo 2026-10-13 16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo 10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("#10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 2026-10").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("*2026*").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 2026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("foo bar 2026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 99").as_deref(),
                Some("1999-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 0").as_deref(),
                Some("2000-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 50").as_deref(),
                Some("1950-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026 10 13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 10 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 2026 10 13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 32 1 2").as_deref(),
                Some("2032-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 2 31 1").as_deref(),
                Some("2001-03-03T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00!"), None);
            assert_eq!(super::canonical_iso("2026-10-13)"), None);
            assert_eq!(super::canonical_iso("x2026-10-13"), None);
            assert_eq!(super::canonical_iso("2026 hello"), None);
            assert_eq!(super::canonical_iso("hello 13 2026"), None);
            assert_eq!(super::canonical_iso("~2026-10-13"), None);
        });
    }

    #[test]
    fn a_slash_date_is_local_midnight() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026/10/13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("/2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13/").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00/10/13/2026"), None);
            assert_eq!(
                super::canonical_iso("2026/10/13 16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_dot_after_minutes_fills_seconds() {
        with_tz("America/New_York", || {
            // `16:00.05` is 16:00:50. A fraction after the seconds stays
            // milliseconds, and `.5` is 500 seconds, so that date is empty.
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.05").as_deref(),
                Some("2026-10-13T20:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.005").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.059").as_deref(),
                Some("2026-10-13T20:00:59.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 4:5.05").as_deref(),
                Some("2026-10-13T08:05:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00:00.05").as_deref(),
                Some("2026-10-13T20:00:00.050Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.05Z").as_deref(),
                Some("2026-10-13T16:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.05 EST").as_deref(),
                Some("2026-10-13T21:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00.05 +5").as_deref(),
                Some("2026-10-13T11:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00.005 +5").as_deref(),
                Some("2026-10-13T11:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:5.05 +5").as_deref(),
                Some("2026-10-12T23:05:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.05 +5").as_deref(),
                Some("2026-10-13T11:00:00.050Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00.05 +5").as_deref(),
                Some("1950-10-13T11:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/1950 16:00.05").as_deref(),
                Some("1950-10-13T21:00:50.000Z")
            );
            assert_eq!(super::canonical_iso("10/13/2026 16:00.5"), None);
            assert_eq!(super::canonical_iso("10/13/2026 16:00.60"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00.5 +5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00.60 +5"), None);
        });
    }

    #[test]
    fn a_clock_before_a_slash_date_stays_on_that_day() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("16:00 10/13/2026").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:5 10/13/2026").as_deref(),
                Some("2026-10-13T08:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 10/13/2026 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 10/13/1950").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00/10/13/2026"), None);
            assert_eq!(
                super::canonical_iso("10/13/2026!16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/ 10/13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026 /10 /13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/ 13/ 2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 / 10/13/2026").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00 13/10/2026"), None);
            assert_eq!(
                super::canonical_iso("16:00 EST 10/13/2026").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 GMT 10/13/2026").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:5 EST 10/13/2026").as_deref(),
                Some("2026-10-13T09:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 EST 10/13/1950").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("10/13/2026 +5"), None);
            assert_eq!(super::canonical_iso("10/13/2026 EST+5"), None);
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
        });
    }

    #[test]
    fn an_extra_sign_after_a_number_is_empty() {
        with_tz("America/New_York", || {
            // Node 22. A `+` or `-` after a number is an offset only when a clock
            // was already seen and the digits are glued to the sign. `-10-13` at
            // the start is still 13 October 2001. A later offset replaces an
            // earlier one, so `16:00 -10-13` ends at UTC−13.
            assert_eq!(super::canonical_iso("2026 -10-13"), None);
            assert_eq!(super::canonical_iso("2026 -10-13 16:00"), None);
            assert_eq!(super::canonical_iso("2026-10 -13"), None);
            assert_eq!(super::canonical_iso("2026-10 -13 16:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13 -5"), None);
            assert_eq!(super::canonical_iso("2026-10-13 +10-13"), None);
            assert_eq!(super::canonical_iso("Oct 13 -2026"), None);
            assert_eq!(super::canonical_iso("13 -Oct 2026"), None);
            assert_eq!(super::canonical_iso("2026 - 10 - 13"), None);
            assert_eq!(super::canonical_iso("2026 +10-13"), None);
            assert_eq!(super::canonical_iso("+5 2026-10-13"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 - 5"), None);
            assert_eq!(super::canonical_iso("16:00 -10-13"), None);
            assert_eq!(super::canonical_iso("2026-10-13 -10-13"), None);
            assert_eq!(
                super::canonical_iso("Oct -13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-10-13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-10-13 16:00").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 -5").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 -5:30").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT -5").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 -10-13").as_deref(),
                Some("2026-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 16:00").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000000-10-13").as_deref(),
                Some("2000-10-13T04:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_keyword_glued_to_a_number_is_empty() {
        with_tz("America/New_York", || {
            // Node 22. `T` is a keyword. Glued to a number it is empty, even
            // when a colon follows that number. A separator before the number
            // leaves the clock, and a separated `T` is an ordinary word.
            assert_eq!(super::canonical_iso("T16:00 2026-10-13"), None);
            assert_eq!(super::canonical_iso("t16:00 2026-10-13"), None);
            assert_eq!(super::canonical_iso("T2026-10-13"), None);
            assert_eq!(super::canonical_iso("xx16:00 2026-10-13"), None);
            assert_eq!(super::canonical_iso("note16:00 2026-10-13"), None);
            assert_eq!(super::canonical_iso("Z16:00 2026-10-13"), None);
            assert_eq!(super::canonical_iso("GMT16:00 2026-10-13"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 Z16:00").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 EST16:00").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 PST16:00").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13:").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13::").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13:16"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13:EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13: GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13:16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 2026-10-13-").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13-"), None);
            assert_eq!(
                super::canonical_iso(" 2026-10-13-").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00 2026-10-13--"), None);
            // Node 22. An open field takes the next in-range number. The hyphen
            // after that number is an offset, so `10-13` is 10 seconds at UTC−13.
            assert_eq!(
                super::canonical_iso("16:00: 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 2026-10+13").as_deref(),
                Some("2026-01-01T03:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 2026-10+5").as_deref(),
                Some("2026-01-01T11:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 2026-10+0530").as_deref(),
                Some("2026-01-01T10:30:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 70-5").as_deref(),
                Some("1970-01-01T21:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("16: 2026-10-13").as_deref(),
                Some("2026-01-02T05:10:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00: 10-5").as_deref(),
                Some("2026-10-13T21:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00: 10-5").as_deref(),
                Some("2026-10-13T21:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 2026-10-13 GMT").as_deref(),
                Some("2026-01-01T16:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 5-30 2026").as_deref(),
                Some("2026-01-02T22:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 2026-1").as_deref(),
                Some("2026-01-01T21:00:01.000Z")
            );
            assert_eq!(
                super::canonical_iso("4:00: PM 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:5 2026-10-13").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 2026").as_deref(),
                Some("2026-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00: 13 2026").as_deref(),
                Some("2026-01-01T21:00:13.000Z")
            );
            assert_eq!(
                super::canonical_iso("1:2: 2026-10-13").as_deref(),
                Some("2026-01-01T14:02:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:00: 2026-10-13").as_deref(),
                Some("2026-01-02T05:00:00.010Z")
            );
            assert_eq!(super::canonical_iso("16:00:: 2026-10-13"), None);
            assert_eq!(super::canonical_iso("16:00: 10"), None);
            assert_eq!(
                super::canonical_iso("16:00 2026-10-13-EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00 2026-10-13-GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13-EST"), None);
            assert_eq!(
                super::canonical_iso("16:00:2026-10-13").as_deref(),
                Some("2026-01-02T05:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:0002026-10-13").as_deref(),
                Some("2026-01-02T05:10:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:0012026-10-13").as_deref(),
                Some("+012026-01-02T05:10:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:10-5 2026").as_deref(),
                Some("2026-01-01T21:00:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("16:00Z5").as_deref(),
                Some("2001-05-01T16:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00Z5"), None);
            assert_eq!(super::canonical_iso("24:00: 2026-10-13"), None);
            assert_eq!(super::canonical_iso("16:602026-10-13"), None);
            assert_eq!(super::canonical_iso("16:1002026-10-13"), None);
            // `GMT+5` before any number ignores the keyword and the sign. 5 is
            // the day, 13 is the year, and 2026 is an extra field.
            assert_eq!(
                super::canonical_iso("GMT+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13:Oct:2026").as_deref(),
                Some("2026-10-01T17:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13:Oct-2026").as_deref(),
                Some("2026-10-01T17:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13:Oct.2026").as_deref(),
                Some("2026-10-01T17:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13:Oct/2026").as_deref(),
                Some("2026-10-01T17:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("13:Oct:2026:5"), None);
            assert_eq!(super::canonical_iso("16:.5.5"), None);
            assert_eq!(super::canonical_iso("16:00:.5.5"), None);
            assert_eq!(
                super::canonical_iso("Oct 13-5:30").as_deref(),
                Some("2001-10-13T09:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13-5:30:10").as_deref(),
                Some("2001-10-13T09:30:10.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13-16:00 EST").as_deref(),
                Some("2001-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13-Oct-5:30").as_deref(),
                Some("2001-10-13T09:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct-13-5:30").as_deref(),
                Some("2001-10-13T09:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-Oct-13-5:30").as_deref(),
                Some("2026-10-13T09:30:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13--5:30"), None);
            assert_eq!(
                super::canonical_iso("Oct 13-5:30 GMT").as_deref(),
                Some("2001-10-13T05:30:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:.5/5"), None);
            assert_eq!(super::canonical_iso("16:00:.5/1"), None);
            assert_eq!(
                super::canonical_iso("16:00:00.5/1").as_deref(),
                Some("2001-01-01T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("13-5:30 Oct").as_deref(),
                Some("2001-10-13T09:30:00.000Z")
            );
            assert_eq!(super::canonical_iso("13-5:30-2026"), None);
            assert_eq!(
                super::canonical_iso("Oct 13-24:00").as_deref(),
                Some("2001-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13-4:00 PM").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00:.500"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00.5 GMT"), None);
            assert_eq!(super::canonical_iso("16:00.5.1"), None);
            assert_eq!(
                super::canonical_iso("16:00:00.500!1").as_deref(),
                Some("2001-01-01T21:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("16:00:00.500! 2026").as_deref(),
                Some("2026-01-01T21:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 16:00:00.500!1"), None);
            assert_eq!(
                super::canonical_iso("16:00Z2026-10-13").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("16:00: 10/13/2026"), None);
            assert_eq!(super::canonical_iso("16:00: 2026/10/13"), None);
            assert_eq!(
                super::canonical_iso("16:00 10/13/2026").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("hello16:00 10/13/2026"), None);
            assert_eq!(super::canonical_iso("  T16:00 2026-10-13"), None);
            assert_eq!(
                super::canonical_iso("T 16:00 2026-10-13").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("T 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("T:16:00 2026-10-13").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("T: 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_nul_ends_the_date_string() {
        with_tz("America/New_York", || {
            // Node 22. The scanner stops at NUL, so the rest of the text is
            // never a clock or a month. A leading NUL leaves nothing to parse.
            // Year 202 is local mean time, about UTC−4:56:02.
            assert_eq!(super::canonical_iso("\u{0}2026-10-13"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13\u{0}").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13\u{0}16:00").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 \u{0}").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026\u{0} 10-13").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("202\u{0}6-10-13").as_deref(),
                Some("0202-01-01T04:56:02.000Z")
            );
            assert_eq!(super::canonical_iso("Oct\u{0} 13 2026"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16\u{0}:00"), None);
            assert_eq!(super::canonical_iso("hello\u{0} 2026-10-13"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13T16:00\u{0}").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00\u{0}").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13\u{0} 2026").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10\u{0}/13").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("4\u{0}").as_deref(),
                Some("2001-04-01T05:00:00.000Z")
            );
            // A control below `A` is ignored. DEL is a word, so it rejects the date.
            assert_eq!(super::canonical_iso("2026\u{1}-10-13"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13\u{1}16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("\u{1}2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13\u{7f}"), None);
            assert_eq!(super::canonical_iso("\u{7f}2026-10-13"), None);
            assert_eq!(super::canonical_iso("2026-10-13\u{7f}16:00"), None);
        });
    }

    #[test]
    fn a_slash_date_keeps_a_named_zone() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026/10/13 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13 16:00:00 (EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_slash_date_keeps_a_zone_keyword() {
        with_tz("America/New_York", || {
            // `10/13/2026` is local midnight. `GMT` makes that midnight UTC, and
            // `EST` makes it Eastern. A fourth number is not a date.
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026Z").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 Z").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026UTC").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5/1/01 GMT").as_deref(),
                Some("2001-05-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2/31/1 GMT").as_deref(),
                Some("2001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13 16:00:00.5 GMT").as_deref(),
                Some("2026-10-13T16:00:00.500Z")
            );
            assert_eq!(super::canonical_iso("10/13/2026 GMT5"), None);
            assert_eq!(super::canonical_iso("10/13/2026EST5"), None);
        });
    }

    #[test]
    fn a_two_field_slash_date_is_a_legacy_date() {
        with_tz("America/New_York", || {
            // A slash is only a separator. Two fields follow the numeric rule, and
            // a missing field is 1. `2026/10/13` stays the three-field local date.
            assert_eq!(
                super::canonical_iso("2026/10/13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10 GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10Z").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/1").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5/1").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5/1 GMT").as_deref(),
                Some("2001-05-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("01/02").as_deref(),
                Some("2001-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2/31").as_deref(),
                Some("2001-03-03T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2/31 GMT").as_deref(),
                Some("2001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0/1").as_deref(),
                Some("2000-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("32/1").as_deref(),
                Some("2032-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99/1").as_deref(),
                Some("1999-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50/1").as_deref(),
                Some("1950-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10 EST").as_deref(),
                Some("2026-10-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 EST").as_deref(),
                Some("2001-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10 16:00").as_deref(),
                Some("2026-10-01T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10 16:00 GMT").as_deref(),
                Some("2026-10-01T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("/10").as_deref(),
                Some("2001-10-01T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("10/2026"), None);
            assert_eq!(super::canonical_iso("13/1"), None);
            assert_eq!(super::canonical_iso("2026/13"), None);
            assert_eq!(super::canonical_iso("13/2026"), None);
            assert_eq!(super::canonical_iso("2026/10/13/1"), None);
        });
    }

    #[test]
    fn repeated_leading_signs_are_padding() {
        with_tz("America/New_York", || {
            // Signs before the first number are padding. The date is local unless
            // a zone says otherwise. A `T` after those signs is not a date.
            assert_eq!(
                super::canonical_iso("++2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+++2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("--2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-+2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+-2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++2026-10-13 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++2026-1-1").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++5").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++ 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++2026-10-13 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++++2026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("--2026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-+5 Oct 13 2026").as_deref(),
                Some("2013-10-05T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("++2026-02-31").as_deref(),
                Some("2026-03-03T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 ++"), None);
            assert_eq!(super::canonical_iso("++2026-10-13T16:00"), None);
        });
    }

    #[test]
    fn a_pm_clock_is_twelve_hours_later() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("Oct 13, 2026 4:00 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13, 2026 12:00 AM").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_named_zone_after_a_hyphen_date_is_a_fixed_offset() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00 (EST)").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_numeric_offset_glued_to_a_named_zone_replaces_that_zone() {
        with_tz("America/New_York", || {
            // After a clock, `EST+5:30` is UTC+5:30. `EST` alone stays EST.
            // The same number on `GMT` was already that offset.
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EDT+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 PST+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+5:").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+:30").as_deref(),
                Some("2026-10-13T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+24:00").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST-24:00").as_deref(),
                Some("2026-10-14T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST-5:30").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EDT-5:30").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 PST-5:30").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST-5:").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST-:30").as_deref(),
                Some("2026-10-13T16:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST-5::30").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5:").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+:30").as_deref(),
                Some("2026-10-13T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT+24:00").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 GMT-24:00").as_deref(),
                Some("2026-10-14T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 EST+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 EST+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 EST+5:").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 EST+:30").as_deref(),
                Some("2026-10-13T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 EST+5::30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 EST-24:00").as_deref(),
                Some("2026-10-14T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 EST+5:30").as_deref(),
                Some("1950-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 EST-5:30").as_deref(),
                Some("1950-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00 EST").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 EST+5:30"), None);
            assert_eq!(super::canonical_iso("2026-10-13 EST+5:30"), None);
            assert_eq!(super::canonical_iso("10/13/2026 EST+5:30"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 EST+5:30:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 EST+5:60"), None);
        });
    }

    #[test]
    fn a_short_hyphen_date_is_local_midnight() {
        // `2026-01` and `2026-10-03` are UTC. A one-digit month or day is local.
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-1").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-3").as_deref(),
                Some("2026-10-03T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-01-1").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-2-31").as_deref(),
                Some("2026-03-03T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-01").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-03").as_deref(),
                Some("2026-10-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-02-31").as_deref(),
                Some("2026-03-03T00:00:00.000Z")
            );
        });
    }

    #[test]
    fn whitespace_around_a_date_makes_it_local_midnight() {
        // `2026-10-13` is UTC. The same text with surrounding whitespace is local.
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" 2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 ").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" 2026-10-13 ").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13\n").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13\t").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("\u{00A0}2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" 2026-01 ").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" 2026 ").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" 2026-10 ").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-02-31 ").as_deref(),
                Some("2026-03-03T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso(" 2026-10-13T16:00:00Z"), None);
            assert_eq!(
                super::canonical_iso(" 2026-10-13 16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_wide_year_is_local_midnight() {
        // Four digits and `+YYYYYY` stay UTC. Any other year width is local.
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-11").as_deref(),
                Some("2026-11-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-02-31").as_deref(),
                Some("2026-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("02026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("02026-11").as_deref(),
                Some("2026-11-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("02026").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("002026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("02026-02-31").as_deref(),
                Some("2026-03-03T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("02026-10-13T00:00:00Z"), None);
        });
    }

    #[test]
    fn an_extra_month_digit_is_local_midnight() {
        // Two digits stay UTC. Any other month or day width is local.
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-010-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-010").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-003").as_deref(),
                Some("2026-10-03T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-0010-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-02-31").as_deref(),
                Some("2026-03-03T00:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-010-32"), None);
            assert_eq!(super::canonical_iso("2026-00"), None);
            assert_eq!(super::canonical_iso("2026-010-13T00:00:00Z"), None);
        });
    }

    #[test]
    fn a_negative_expanded_year_stays_utc() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("-000001-01-01").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-01").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-02-31").as_deref(),
                Some("-000001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+000000-01-01").as_deref(),
                Some("0000-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+009999-01-01").as_deref(),
                Some("9999-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+010000-01-01").as_deref(),
                Some("+010000-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-1-1").as_deref(),
                Some("-000001-01-01T04:56:02.000Z")
            );
        });
    }

    #[test]
    fn an_expanded_year_keeps_its_clock() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("-000001-01-01T00:00:00Z").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-01-01T00:00:00").as_deref(),
                Some("-000001-01-01T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13T00:00:00Z").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13T16:00:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-02-31T00:00:00Z").as_deref(),
                Some("-000001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001T00:00:00Z").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-11T00:00:00Z").as_deref(),
                Some("2026-11-01T00:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("02026-10-13T00:00:00Z"), None);
            assert_eq!(
                super::canonical_iso("-000001-01-01T24:00:00Z").as_deref(),
                Some("-000001-01-02T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+010000-01-01T00:00:00.500Z").as_deref(),
                Some("+010000-01-01T00:00:00.500Z")
            );
        });
    }

    #[test]
    fn a_short_first_field_is_month_day_year() {
        // A hyphen date that is not `YYYY-MM-DD` or `±YYYYYY-MM-DD` uses the
        // legacy field order. `2-1-1` is 1 February 2001, local.
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("-00001-01-01").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2-1-1").as_deref(),
                Some("2001-02-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1-2-3").as_deref(),
                Some("2003-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1-2").as_deref(),
                Some("2001-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("49-1-1").as_deref(),
                Some("2049-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50-1-1").as_deref(),
                Some("1950-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2-31-1").as_deref(),
                Some("2001-03-03T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("13-1-1"), None);
            assert_eq!(super::canonical_iso("-00001-01-01T00:00:00Z"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-01-01").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-01-01").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_comma_separates_a_date_from_its_clock() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13,").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(",2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13,,").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13,16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13,16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13,,16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13T16:00:00Z,"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00:00,"), None);
        });
    }

    #[test]
    fn a_period_separates_a_date_from_its_clock() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13.").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10.").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13...").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10.13.2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("13.10.2026"), None);
            assert_eq!(
                super::canonical_iso(".2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(":2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso(".2026-10-13T16:00"), None);
            assert_eq!(super::canonical_iso(":2026-10-13T16:00"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13.16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13.16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13.16:00:00.5").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2-1-1.").as_deref(),
                Some("2001-02-01T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13T16:00:00."), None);
            assert_eq!(
                super::canonical_iso("2026-10-13T16:00:00.5").as_deref(),
                Some("2026-10-13T20:00:00.500Z")
            );
        });
    }

    #[test]
    fn a_dotted_date_keeps_a_zone_keyword() {
        with_tz("America/New_York", || {
            // A dot between numbers is a separator. The date is local unless a
            // zone says otherwise. `13.10.2026` is not a month-day-year date.
            assert_eq!(
                super::canonical_iso("2026.10.13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10.13.2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026..10.13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2.31.1").as_deref(),
                Some("2001-03-03T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10.13.2026 GMT").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10.13.2026EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10 GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2.31.1 GMT").as_deref(),
                Some("2001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13.16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026.10.13 16:00 GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("13.10.2026"), None);
        });
    }

    #[test]
    fn a_line_separator_is_not_date_padding() {
        with_tz("America/New_York", || {
            assert_eq!(super::canonical_iso("\u{2028}2026-10-13"), None);
            assert_eq!(super::canonical_iso("2026-10-13\u{2028}"), None);
            assert_eq!(super::canonical_iso("\u{2029}2026-10-13"), None);
            assert_eq!(super::canonical_iso("2026-10-13\u{2029}"), None);
            assert_eq!(
                super::canonical_iso("\u{FEFF}2026-10-13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            // U+FEFF is a date-parse space between fields, not part of a word.
            assert_eq!(
                super::canonical_iso("Oct 13\u{FEFF}2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13\u{FEFF}16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026\u{FEFF}16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct\u{FEFF}13\u{FEFF}2026 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
        });
    }

    #[test]
    fn serialize_keeps_the_update_time_it_was_given() {
        let payload = FamdPayload {
            schema: FAMD_SCHEMA.to_string(),
            updated_at: "Oct 13, 2026".to_string(),
            ink: None,
            worksheets: Vec::new(),
            paper_style: None,
            note_links: Vec::new(),
            note_backups: Vec::new(),
            page_stats: None,
        };
        let saved = serialize_famd("", &payload);
        assert!(
            saved.contains("\"updatedAt\":\"Oct 13, 2026\""),
            "{saved}"
        );
        let invalid = FamdPayload {
            updated_at: "not-a-date".to_string(),
            ..payload
        };
        let saved = serialize_famd("", &invalid);
        assert!(saved.contains("\"updatedAt\":\"not-a-date\""), "{saved}");
    }

    #[test]
    fn a_dotted_meridiem_is_not_a_clock() {
        with_tz("America/New_York", || {
            assert_eq!(super::canonical_iso("2026-10-13 4:00:00 p.m."), None);
            assert_eq!(super::canonical_iso("2026-10-13 4:00:00 P.M."), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00 pm").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4:00:00 PM.").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST.").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_gmt_colon_offset_can_pass_twenty_three_hours() {
        with_tz("America/New_York", || {
            // `GMT+24:00` is an offset of 24 hours. `GMT+5:` omits the minutes.
            // `GMT+5:60` keeps the 5 hours and uses 60 as a date number. Before
            // any number, `GMT+24:00` is the clock 24:00.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+25:00").as_deref(),
                Some("2026-10-11T23:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24:30").as_deref(),
                Some("2026-10-11T23:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT-24:00").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT-5:").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 UTC+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 UT+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+24:00").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+24:30").as_deref(),
                Some("2026-10-12T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT-24:00").as_deref(),
                Some("2026-10-14T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5:").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 UTC+99:30").as_deref(),
                Some("2026-10-09T12:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 UT+24:00").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:60").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5:60").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 GMT+5:60").as_deref(),
                Some("1960-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24:00 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 16:00 GMT+24:00").as_deref(),
                Some("2001-04-30T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 GMT+24:00").as_deref(),
                Some("2026-10-12T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+5:").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13 16:00 GMT+24:30").as_deref(),
                Some("2026-10-12T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+24:00").as_deref(),
                Some("2001-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10 GMT+24:00").as_deref(),
                Some("2026-09-30T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("/10 GMT+24:00").as_deref(),
                Some("2001-09-30T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+5:70").as_deref(),
                Some("1970-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+5:60").as_deref(),
                Some("1960-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026GMT+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+24:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct13GMT+24:00").as_deref(),
                Some("2001-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+24:00 Oct 13 2026").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+5: Oct 13 2026").as_deref(),
                Some("2026-10-01T09:13:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13T16:00+24:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:30:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +5:30:00"), None);
            assert_eq!(super::canonical_iso("10/13/2026 GMT+5:60"), None);
            assert_eq!(super::canonical_iso("2026-10-13 GMT+5:60"), None);
            assert_eq!(super::canonical_iso("GMT+24:00"), None);
        });
    }

    #[test]
    fn a_dotted_offset_keeps_the_hour_and_a_later_number() {
        with_tz("America/New_York", || {
            // `+:30` is an offset of 30 minutes. `+5:30.5` is +5:30, and the 5
            // is a date number. `+5.30` is +5 hours. Before any number, `GMT+:30`
            // ignores the keyword and the colon, so 30 is a day.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +:").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 -:").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +:30").as_deref(),
                Some("2026-10-13T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +:3").as_deref(),
                Some("2026-10-13T15:57:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +:00").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +000:").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:30.5").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:30..5").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5.30").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5.5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:.5").as_deref(),
                Some("2026-10-13T10:55:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:30.0").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:60.5").as_deref(),
                Some("2026-10-13T10:55:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00 +5:30.5").as_deref(),
                Some("2005-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 16:00 +5:60.5").as_deref(),
                Some("1960-10-13T10:55:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 16:00 +5:30.5").as_deref(),
                Some("2001-05-05T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+:").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+:30").as_deref(),
                Some("2026-10-12T23:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:30.5").as_deref(),
                Some("2026-10-12T18:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5:30.5").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5.30").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5:30.5 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00 +5:30.5").as_deref(),
                Some("2005-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00 +5:60.5").as_deref(),
                Some("1960-10-13T10:55:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+5:30.5").as_deref(),
                Some("2005-10-12T18:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+: Oct 13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+:30 Oct 13 2026").as_deref(),
                Some("2013-10-30T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +5:30:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:30:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5:30.5"), None);
            assert_eq!(super::canonical_iso("10/13/2026 16:00 +5:30.5"), None);
            assert_eq!(super::canonical_iso("10/13/2026 GMT+5:30.5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +5:30x"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 +:"), None);
            assert_eq!(super::canonical_iso("Oct 2026 +5:30.5"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +."), None);
            assert_eq!(super::canonical_iso("GMT+:30x Oct 13 2026"), None);
        });
    }

    #[test]
    fn a_later_number_can_be_the_offset_minute() {
        with_tz("America/New_York", || {
            // `GMT+5:` leaves the minutes open. The next number from 0 through 59
            // fills them. `60` is a date number, and a later zone still wins.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5: 1").as_deref(),
                Some("2026-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:60 1").as_deref(),
                Some("2026-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 GMT+5:60 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5: 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5: 01").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5: 60").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +5: 60 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5: 1 2").as_deref(),
                Some("2026-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24: 30").as_deref(),
                Some("2026-10-11T23:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:60 1 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 UTC+5: 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 UT+5: 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 +: 1").as_deref(),
                Some("2026-10-13T15:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 -: 1").as_deref(),
                Some("2026-10-13T16:01:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00 -5: 1").as_deref(),
                Some("2026-10-13T21:01:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00+5: 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT-5: 1").as_deref(),
                Some("2026-10-13T05:01:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16: +5: 30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 GMT+5: 1").as_deref(),
                Some("2001-04-30T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 GMT+5:60 1").as_deref(),
                Some("1960-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5:").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5: 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10 GMT+5: 1").as_deref(),
                Some("2026-09-30T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+5: 1").as_deref(),
                Some("2001-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+5:60 1").as_deref(),
                Some("1960-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+5: 1").as_deref(),
                Some("2026-10-12T18:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00 +5: 1").as_deref(),
                Some("2026-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 16:00 +5: 1").as_deref(),
                Some("2001-10-13T10:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Wed Oct 13 2026 GMT+5: 1").as_deref(),
                Some("2026-10-12T18:59:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:60 70"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:60 1 2"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16 +5: 30"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 +5: 1"), None);
            assert_eq!(super::canonical_iso("10/13/2026 GMT+5:60 1"), None);
            assert_eq!(super::canonical_iso("2026/10 GMT+5:60 1"), None);
        });
    }

    #[test]
    fn a_colon_after_an_offset_starts_a_clock() {
        with_tz("America/New_York", || {
            // `GMT+5:3:0` is 03:00 at UTC+5. The 3 starts a clock, and the last 0
            // is the offset minute. `GMT+24:00:00` is midnight 24 hours ahead.
            // A clock that is already finished cannot grow.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24:00:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:0").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+0:0:0").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24:0:0").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:0:0").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+05:03:00").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:15:0").as_deref(),
                Some("2026-10-12T22:15:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:0:15").as_deref(),
                Some("2026-10-12T21:45:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+24:00:00:30").as_deref(),
                Some("2026-10-11T23:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:4:5:6").as_deref(),
                Some("2026-10-12T21:58:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:1:2:3:4:5").as_deref(),
                Some("2026-10-12T19:57:03.004Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:4:5:6:7").as_deref(),
                Some("2026-10-12T21:57:05.006Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3: 1").as_deref(),
                Some("2026-10-12T21:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 GMT+5:3:0 EST").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16: GMT+5:3:0").as_deref(),
                Some("2026-10-13T11:03:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00: GMT+5:3:0").as_deref(),
                Some("2026-10-13T11:00:03.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 GMT+24:00:00").as_deref(),
                Some("2001-04-30T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5 GMT+5:3:0").as_deref(),
                Some("2001-04-30T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50 GMT+5:3:0").as_deref(),
                Some("1949-12-31T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+5:3:0").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+24:00:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13 GMT+5:3:0").as_deref(),
                Some("2001-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026/10/13 GMT+5:3:0").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT+5:3:0").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 GMT+24:00:00").as_deref(),
                Some("2026-10-12T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026 GMT+5:3: 1").as_deref(),
                Some("2026-10-12T21:59:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Wed Oct 13 2026 GMT+5:3:0").as_deref(),
                Some("2026-10-12T22:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("GMT+5:3:0 Oct 13 2026").as_deref(),
                Some("2026-10-13T09:03:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 GMT+5:3:0"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:30:0"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:60:0"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:99:0"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 GMT+5:1:2:3:4:5:6"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 GMT+24:00:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 GMT+0:0:0"), None);
            assert_eq!(super::canonical_iso("10/13/2026 16:00 GMT+5:3:0"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 GMT+24:00:00"), None);
        });
    }

    #[test]
    fn a_space_before_hour_24_ignores_later_fraction_digits() {
        with_tz("America/New_York", || {
            // A `T` form rejects any later nonzero fraction digit. A space before
            // the clock keeps the first three millisecond digits, so
            // `24:00:00.000000001` is still the next midnight.
            assert_eq!(super::canonical_iso("2026-10-13T24:00:00.000000001"), None);
            assert_eq!(super::canonical_iso("2026-10-13T24:00:00.0001"), None);
            assert_eq!(super::canonical_iso("2026-10-13T24:00:00.000000001Z"), None);
            assert_eq!(super::canonical_iso("2026-10-13T24:00:00.1"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 24:00:00.000000001").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24:00:00.0001").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24:00:00.000").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24:00:00.0").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24:00:00.000000001Z").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 24:00:00.0001Z").as_deref(),
                Some("2026-10-14T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 24:00:00.000000001").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 24:00:00.0001").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.000000001").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13T24:00:00.000").as_deref(),
                Some("2026-10-14T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 24:00:00.000000001").as_deref(),
                Some("1950-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 24:00:00.000000001Z").as_deref(),
                Some("1950-10-14T00:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13 24:00:00.001"), None);
            assert_eq!(super::canonical_iso("2026-10-13 24:00:00.100000000"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 24:00:00.001"), None);
            assert_eq!(super::canonical_iso("1950-10-13T24:00:00.000000001"), None);
        });
    }

    #[test]
    fn a_trailing_hyphen_keeps_an_unfinished_date_local() {
        with_tz("America/New_York", || {
            // A trailing hyphen stops a strict ISO date, so the midnight is local.
            // `2026-10-13-` already has a day, and that extra hyphen is empty.
            assert_eq!(
                super::canonical_iso("2026-").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1-").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-1-").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-2026-").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-").as_deref(),
                Some("2026-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("5-").as_deref(),
                Some("2001-05-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0-").as_deref(),
                Some("2000-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("32-").as_deref(),
                Some("2032-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("50-").as_deref(),
                Some("1950-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99-").as_deref(),
                Some("1999-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99-10-").as_deref(),
                Some("1999-10-01T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026- GMT").as_deref(),
                Some("2026-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026- GMT+5").as_deref(),
                Some("2025-12-31T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10- EST").as_deref(),
                Some("2026-10-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026- EST").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10- GMT").as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026- GMT-5").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026- GMT-0500").as_deref(),
                Some("2026-01-01T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-(10)-13"), None);
            assert_eq!(super::canonical_iso("2026-(10)-13 16:00"), None);
            assert_eq!(super::canonical_iso("2026- -13"), None);
            assert_eq!(super::canonical_iso("2026- -5"), None);
            assert_eq!(super::canonical_iso("2026- +5"), None);
            assert_eq!(super::canonical_iso("2026- +5:30"), None);
            assert_eq!(super::canonical_iso("2026- +13"), None);
            assert_eq!(super::canonical_iso("2026-10- -5"), None);
            assert_eq!(super::canonical_iso("2026-10- -13"), None);
            assert_eq!(super::canonical_iso("2026-10- +5:30"), None);
            assert_eq!(super::canonical_iso("2026--13"), None);
            assert_eq!(super::canonical_iso("2026-(10)-"), None);
            assert_eq!(super::canonical_iso("2026-10-13-(5)"), None);
            assert_eq!(super::canonical_iso("2026-10-13-"), None);
            assert_eq!(super::canonical_iso("2026-10-01-"), None);
            assert_eq!(super::canonical_iso("2026--"), None);
            assert_eq!(super::canonical_iso("2026-10--"), None);
            assert_eq!(super::canonical_iso("13-"), None);
            assert_eq!(super::canonical_iso("2026-13-"), None);
            assert_eq!(super::canonical_iso("2026-10-13-1"), None);
            assert_eq!(super::canonical_iso("2026-10-13 -"), None);
            assert_eq!(super::canonical_iso("2026-10-13-EST"), None);
        });
    }

    fn with_tz(tz: &str, check: impl FnOnce()) {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        unsafe extern "C" {
            fn tzset();
        }
        struct Restore(Option<String>);
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe extern "C" {
                    fn tzset();
                }
                match self.0.take() {
                    Some(value) => unsafe { std::env::set_var("TZ", value) },
                    None => unsafe { std::env::remove_var("TZ") },
                }
                unsafe { tzset() };
            }
        }
        let previous = std::env::var("TZ").ok();
        let _restore = Restore(previous);
        unsafe { std::env::set_var("TZ", tz) };
        unsafe { tzset() };
        check();
    }

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
    fn page_stats_without_a_creation_time_are_omitted() {
        let json = format!(
            r#"{{"schema":"{FAMD_SCHEMA}","updatedAt":"2026-01-02T00:00:00.000Z","ink":null,"worksheets":[],"pageStats":{{"words":2,"typing":{{"wordsAdded":4}}}}}}"#
        );
        let source = format!(
            "<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
            super::js_len(&json)
        );
        assert!(parse_famd(&source).payload.unwrap().page_stats.is_none());

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
        assert!(parse_famd(&saved).payload.unwrap().page_stats.is_none());
    }

    #[test]
    fn page_stats_follow_the_desktop_creation_time() {
        with_tz("America/New_York", || {
            let json = format!(
                r#"{{"schema":"{FAMD_SCHEMA}","updatedAt":"2026-01-02T00:00:00.000Z","ink":null,"worksheets":[],"pageStats":{{"createdAt":"Oct 13, 2026","dwellMs":1.9,"openCount":-3,"words":2}}}}"#
            );
            let source = format!(
                "<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
                super::js_len(&json)
            );
            let stats = parse_famd(&source).payload.unwrap().page_stats.unwrap();
            assert_eq!(stats["createdAt"], "2026-10-13T04:00:00.000Z");
            assert_eq!(stats["modifiedAt"], "2026-10-13T04:00:00.000Z");
            assert_eq!(stats["lastOpenedAt"], "2026-10-13T04:00:00.000Z");
            assert_eq!(stats["dwellMs"], 1);
            assert_eq!(stats["openCount"], 0);
            assert_eq!(stats["words"], 2);
        });
    }

    #[test]
    fn a_note_link_position_uses_javascript_number_text() {
        let link = super::NoteLink {
            id: "nl-edge".into(),
            source_path: "a.md".into(),
            target_path: "b.md".into(),
            page: 1,
            x: 0.0,
            y: 1.0,
            style: "symbol".into(),
            label: "Rand".into(),
            appearance: "symbol".into(),
        };
        let json = link.to_json().to_string();
        assert!(json.contains("\"x\":0"), "{json}");
        assert!(json.contains("\"y\":1"), "{json}");
        assert!(!json.contains("0.0"), "{json}");
        assert!(!json.contains("1.0"), "{json}");
        assert_eq!(super::js_json_number(-0.0).to_string(), "0");
        assert_eq!(super::js_json_number(16.0).to_string(), "16");
        assert_eq!(super::js_json_number(-16.0).to_string(), "-16");
        assert_eq!(super::js_json_number(0.5).to_string(), "0.5");
    }

    #[test]
    fn a_compact_gmt_offset_matches_date_parse() {
        with_tz("America/New_York", || {
            // Node 22 `Date.parse`, TZ=America/New_York. Three digits are HMM.
            // Two digits are hours, even past 23. `HHMM` minutes past 59 carry
            // into the next hour. A spilled colon minute makes the ISO form empty.
            let cases = [
                ("2026-10-13 16:00 GMT+530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 16:00 GMT+53", Some("2026-10-11T11:00:00.000Z")),
                ("2026-10-13 16:00 GMT+24", Some("2026-10-12T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT+24:00", Some("2026-10-12T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT+2360", Some("2026-10-12T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT+2399", Some("2026-10-12T15:21:00.000Z")),
                ("2026-10-13 16:00 GMT+130", Some("2026-10-13T14:30:00.000Z")),
                ("2026-10-13 16:00 GMT+001", Some("2026-10-13T15:59:00.000Z")),
                ("2026-10-13 16:00 GMT+5:", Some("2026-10-13T11:00:00.000Z")),
                ("2026-10-13 16:00 GMT+5:3", Some("2026-10-13T10:57:00.000Z")),
                ("2026-10-13 16:00 GMT+3:5", Some("2026-10-13T12:55:00.000Z")),
                ("2026-10-13 16:00 GMT+0530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 16:00 GMT+2400", Some("2026-10-12T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT+9999", Some("2026-10-09T11:21:00.000Z")),
                ("2026-10-13 16:00 GMT+90", Some("2026-10-09T22:00:00.000Z")),
                ("2026-10-13 16:00 GMT-530", Some("2026-10-13T21:30:00.000Z")),
                ("2026-10-13 16:00 GMT-53", Some("2026-10-15T21:00:00.000Z")),
                ("2026-10-13 16:00 GMT-24", Some("2026-10-14T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT-2360", Some("2026-10-14T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT-5:", Some("2026-10-13T21:00:00.000Z")),
                ("2026-10-13 16:00 UTC-530", Some("2026-10-13T21:30:00.000Z")),
                ("2026-10-13 16:00 UT-530", Some("2026-10-13T21:30:00.000Z")),
                ("2026-10-13 16:00 EST-530", Some("2026-10-13T21:30:00.000Z")),
                ("2026-10-13 GMT-530", Some("2026-10-13T05:30:00.000Z")),
                ("2026-10-13 GMT-53", Some("2026-10-15T05:00:00.000Z")),
                ("Oct 13 2026 GMT-530", Some("2026-10-13T05:30:00.000Z")),
                ("Oct 13 2026 16:00 GMT-530", Some("2026-10-13T21:30:00.000Z")),
                ("Oct 13 2026 GMT-53", Some("2026-10-15T05:00:00.000Z")),
                ("10/13/2026 16:00 GMT-530", Some("2026-10-13T21:30:00.000Z")),
                ("10/13/2026 GMT-530", Some("2026-10-13T05:30:00.000Z")),
                ("5 GMT-530", Some("2001-05-01T05:30:00.000Z")),
                ("GMT-530 Oct 13 2026", Some("0530-10-13T04:56:02.000Z")),
                ("GMT+530 Oct 13 2026", Some("0530-10-13T04:56:02.000Z")),
                ("GMT-53 Oct 13 2026", Some("1953-10-13T05:00:00.000Z")),
                ("2026-10-13 16:00 GMT+000", Some("2026-10-13T16:00:00.000Z")),
                ("2026-10-13 16:00 GMT+100", Some("2026-10-13T15:00:00.000Z")),
                ("2026-10-13 16:00 UTC+530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 16:00 UT+530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 16:00 gmt+530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 GMT+530", Some("2026-10-12T18:30:00.000Z")),
                ("2026-10-13 GMT+53", Some("2026-10-10T19:00:00.000Z")),
                ("Oct 13 2026 16:00 GMT+530", Some("2026-10-13T10:30:00.000Z")),
                ("Oct 13 2026 16:00 GMT+53", Some("2026-10-11T11:00:00.000Z")),
                ("10/13/2026 16:00 GMT+530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 4:00 PM GMT+530", Some("2026-10-13T10:30:00.000Z")),
                ("2026-10-13 16:00 GMT+530 EST", Some("2026-10-13T21:00:00.000Z")),
                ("2026-10-13 16:00 GMT+5:60", None),
                ("2026-10-13 16:00 GMT+5:30.5", None),
                ("2026-10-13 16:00 GMT+12345", None),
                ("2026-10-13T16:00:00 GMT+530", None),
            ];
            for (input, expected) in cases {
                assert_eq!(
                    super::canonical_iso(input).as_deref(),
                    expected,
                    "{input}"
                );
            }
        });
    }

    #[test]
    fn a_repeated_colon_after_an_empty_minute_is_a_separator() {
        with_tz("America/New_York", || {
            // `16:::30` is 16:00:30. `16::.5` is 16:00:05. A finished
            // `16:00:::` is empty, and a `T` clock does not use this rule.
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:::30").as_deref(),
                Some("2026-10-13T20:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16::.5").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16::.").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:::5 PM").as_deref(),
                Some("2026-10-13T20:00:05.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16::30.5").as_deref(),
                Some("2026-10-13T20:00:30.500Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16:::30").as_deref(),
                Some("1950-10-13T21:00:30.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 1950 16::.5").as_deref(),
                Some("1950-10-13T21:00:05.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:::30"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:::30"), None);
        });
    }

    #[test]
    fn a_third_offset_field_on_a_hyphen_date_is_empty() {
        with_tz("America/New_York", || {
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5:30:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +05:30:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 -5:30:00"), None);
            assert_eq!(super::canonical_iso("2026-10-13 16:00 +5:3:0"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13T16:00:00+05:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00 +5:30:00"), None);
        });
    }

    #[test]
    fn a_strict_iso_year_before_the_epoch_keeps_its_calendar() {
        with_tz("America/New_York", || {
            // Year 0 and year -1 are real ISO instants. A leading space still
            // uses the legacy window.
            assert_eq!(
                super::canonical_iso("0000-01-01").as_deref(),
                Some("0000-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-10-13").as_deref(),
                Some("0000-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13").as_deref(),
                Some("-000001-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-01-01").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-01-01").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
            // `-000001-10-13 16:00` is year -1 local time. October -1 in New
            // York is local mean time, UTC−4:56:02. A leading space is still
            // 10 January 2013. `1950-10-13 16:00` stays local EST.
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13T16:00:00").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            // `16:` is 16:00 and `4:5` is 4:05. `16:0` and `16::30` are the
            // same local mean time. `EST+5:30` replaces the name with +5:30.
            // A leading space is still 10 January 2013.
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 4:5").as_deref(),
                Some("-000001-10-13T09:01:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 EST+5:30").as_deref(),
                Some("-000001-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:0").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16::30").as_deref(),
                Some("-000001-10-13T20:56:32.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 4:5 PM").as_deref(),
                Some("-000001-10-13T21:01:02.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 16:00").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 16:").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 4:5").as_deref(),
                Some("2013-01-10T09:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 16:00 EST+5:30").as_deref(),
                Some("2013-01-10T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1950-10-13 16:00").as_deref(),
                Some("1950-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 EST+5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            // `-000000` drops the invalid expanded year once. The rest is
            // legacy, so 13 October 2001. A second `-000000` is year 0.
            // `EST` and `GMT+5` on year -1 stay in that year. A leading
            // space is still 2013. `+5` with no clock is empty.
            assert_eq!(
                super::canonical_iso("-000000-10-13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10-13 16:00").as_deref(),
                Some("2001-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10-13 4:5").as_deref(),
                Some("2001-10-13T08:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10-13 EST").as_deref(),
                Some("2001-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10-13 GMT+5").as_deref(),
                Some("2001-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10").as_deref(),
                Some("2001-10-01T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("-000000 16:00"), None);
            assert_eq!(super::canonical_iso("-000000"), None);
            assert_eq!(
                super::canonical_iso("-000000-000000").as_deref(),
                Some("2000-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-000001-10-13").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000000-10-13").as_deref(),
                Some("2000-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10-13 ").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 EST").as_deref(),
                Some("-000001-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 GMT+5").as_deref(),
                Some("-000001-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 GMT").as_deref(),
                Some("-000001-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 PST").as_deref(),
                Some("-000001-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001 EST").as_deref(),
                Some("-000001-01-01T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("-000001-10-13 +5"), None);
            assert_eq!(super::canonical_iso("-000001-10-13 EST+5"), None);
            assert_eq!(
                super::canonical_iso(" -000001-10-13 EST").as_deref(),
                Some("2013-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 EST").as_deref(),
                Some("-000001-10-13T21:00:00.000Z")
            );
            // `0000-01-01` alone is year 0. A legacy clock uses the 0–99
            // window, so that day is 1 January 2000. Year 100 stays 100.
            assert_eq!(
                super::canonical_iso("0000-01-01").as_deref(),
                Some("0000-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-01-01T16:00").as_deref(),
                Some("0000-01-01T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-01-01 16:00").as_deref(),
                Some("2000-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-01-01 16:00 +5").as_deref(),
                Some("2000-01-01T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-01-01 16:00 GMT+5").as_deref(),
                Some("2000-01-01T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-01-01 EST").as_deref(),
                Some("2000-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-01-01 GMT+5").as_deref(),
                Some("1999-12-31T19:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("0000-01-01 +5"), None);
            assert_eq!(
                super::canonical_iso("0000-10-13 16:00").as_deref(),
                Some("2000-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000 16:00").as_deref(),
                Some("2000-01-01T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0049-06-15 16:00").as_deref(),
                Some("2049-06-15T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0050-06-15 16:00").as_deref(),
                Some("1950-06-15T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0099-12-31 16:00").as_deref(),
                Some("1999-12-31T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0100-01-01 16:00").as_deref(),
                Some("0100-01-01T20:56:02.000Z")
            );
            // `0001-10-13 16:00` is 10 January 2013. The `T` form stays year 1.
            assert_eq!(
                super::canonical_iso("0001-10-13 16:00").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0001-10-13 16:00 +5").as_deref(),
                Some("2013-01-10T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+000001-10-13 16:00 +5").as_deref(),
                Some("2013-01-10T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("1-10-13 16:00 +5").as_deref(),
                Some("2013-01-10T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0001-10 16:00").as_deref(),
                Some("2001-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0001-10-13T16:00").as_deref(),
                Some("0001-10-13T20:56:02.000Z")
            );
            assert_eq!(super::canonical_iso("0013-10-13 16:00"), None);
            assert_eq!(
                super::canonical_iso("10000-10-13 16:00 +5").as_deref(),
                Some("+010000-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+010000-10-13 16:00 +5").as_deref(),
                Some("+010000-10-13T11:00:00.000Z")
            );
            // `+5:30` needs a clock. A leading space keeps the 2013 reading.
            // Without that space, `GMT+5` stays on year -1.
            assert_eq!(super::canonical_iso("2026-10-13 +5:30"), None);
            assert_eq!(super::canonical_iso("2026-10-13 +5"), None);
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00 +5:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 GMT+5").as_deref(),
                Some("-000001-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 16:00 GMT+5").as_deref(),
                Some("2013-01-10T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001-10-13 16:00 +5").as_deref(),
                Some("2013-01-10T11:00:00.000Z")
            );
            // A trailing space does not reread year -1 as 2013. A short
            // field on year 0 uses the legacy window.
            assert_eq!(
                super::canonical_iso("-000001-10-13 ").as_deref(),
                Some("-000001-10-13T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 +5").as_deref(),
                Some("-000001-10-13T11:00:00.000Z")
            );
            // `GMT-530` is UTC−5:30. A later zone replaces the earlier one.
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 GMT-530").as_deref(),
                Some("-000001-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 GMT+530").as_deref(),
                Some("-000001-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00 GMT+5 EST").as_deref(),
                Some("-000001-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 EST GMT+5").as_deref(),
                Some("-000001-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 GMT-530").as_deref(),
                Some("-000001-10-13T05:30:00.000Z")
            );
            // `24:00` is the next midnight, once. The zone is applied after that.
            assert_eq!(
                super::canonical_iso("-000001-10-13 24:00 GMT-530").as_deref(),
                Some("-000001-10-14T05:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 24:00 GMT+530").as_deref(),
                Some("-000001-10-13T18:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 24:00 EST GMT+5").as_deref(),
                Some("-000001-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 24:00 GMT+5 EST").as_deref(),
                Some("-000001-10-14T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 24:00 PST+5").as_deref(),
                Some("-000001-10-13T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0000-1-1").as_deref(),
                Some("2000-01-01T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("0001-10-5").as_deref(),
                Some("2005-01-10T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000000-10-13 16:00 +5").as_deref(),
                Some("2000-10-13T11:00:00.000Z")
            );
            // `+275760-09-13` is the last UTC midnight. Local time that day,
            // and one millisecond past that midnight, are empty.
            assert_eq!(
                super::canonical_iso("+275760-09-13").as_deref(),
                Some("+275760-09-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+275760-09-13T00:00:00.000Z").as_deref(),
                Some("+275760-09-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("275760-09-13 GMT").as_deref(),
                Some("+275760-09-13T00:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("+275760-09-13T00:00:00.001Z"), None);
            assert_eq!(super::canonical_iso("275760-09-13"), None);
            assert_eq!(super::canonical_iso("275760-09-13 16:00"), None);
            assert_eq!(super::canonical_iso("275760-09-13 16:00 GMT-5"), None);
            assert_eq!(super::canonical_iso("+275760-09-14"), None);
            // Once `T` is read, leftover text is empty. It is not a legacy date.
            assert_eq!(
                super::canonical_iso("2026-10-13T16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13T16:00 EST"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00:00Z GMT+5"), None);
            assert_eq!(super::canonical_iso("+002026-10-13T16:00:00Z GMT+5"), None);
            assert_eq!(super::canonical_iso(" +002026-10-13T16:00:00Z GMT+5"), None);
            assert_eq!(super::canonical_iso(" 2026-10-13T16:00:00Z"), None);
            assert_eq!(super::canonical_iso("2026-10-13T16:00:00Z "), None);
        });
    }

    #[test]
    fn a_month_name_year_10000_is_local_midnight() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("Oct 13 10000").as_deref(),
                Some("+010000-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13 Oct 10000").as_deref(),
                Some("+010000-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct10000").as_deref(),
                Some("+010000-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 10000 16:00").as_deref(),
                Some("+010000-10-13T20:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_slash_or_colon_between_a_date_and_a_clock_is_a_separator() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("Oct 13 2026/16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13/16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13:16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13:16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13T16:00:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13T16:00:00+05:30").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(super::canonical_iso("Oct 13 2026:16:00"), None);
            assert_eq!(super::canonical_iso("10/13/2026:16:00"), None);
        });
    }

    #[test]
    fn a_glued_irregular_gmt_offset_matches_the_spaced_form() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+5: 16:00").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+:30 16:00").as_deref(),
                Some("2026-10-13T15:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+5::30 16:00").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT-5: 16:00").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT-:30 16:00").as_deref(),
                Some("2026-10-13T16:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT-5::30 16:00").as_deref(),
                Some("2026-10-13T21:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+5:").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT-5:").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+:30").as_deref(),
                Some("2026-10-12T23:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+5::30").as_deref(),
                Some("2026-10-12T18:30:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13Oct2026GMT+5:30 16:00").as_deref(),
                Some("2026-10-13T10:30:00.000Z")
            );
        });
    }

    #[test]
    fn a_long_fraction_keeps_nine_significant_digits() {
        with_tz("America/New_York", || {
            // Node 22 `Date.parse` plus `toISOString`. Nine significant
            // digits, then three millisecond digits. `0001234567` is 1 ms.
            // A space before hour 24 uses that scaled value, so a nonzero
            // result is empty. A `T` hour of 24 still rejects any nonzero digit.
            let cases = [
                (
                    "1970-01-01T00:00:00.0001234567Z",
                    Some("1970-01-01T00:00:00.001Z"),
                ),
                (
                    "1970-01-01T00:00:00.00012345678Z",
                    Some("1970-01-01T00:00:00.012Z"),
                ),
                (
                    "1970-01-01T00:00:00.000123456789Z",
                    Some("1970-01-01T00:00:00.123Z"),
                ),
                (
                    "1970-01-01T00:00:00.0123456789Z",
                    Some("1970-01-01T00:00:00.123Z"),
                ),
                (
                    "1970-01-01T00:00:00.00123456789Z",
                    Some("1970-01-01T00:00:00.123Z"),
                ),
                (
                    "1970-01-01T00:00:00.0000123456789Z",
                    Some("1970-01-01T00:00:00.123Z"),
                ),
                (
                    "1970-01-01T00:00:00.1234567899Z",
                    Some("1970-01-01T00:00:00.123Z"),
                ),
                (
                    "1970-01-01T00:00:00.000000001234Z",
                    Some("1970-01-01T00:00:00.000Z"),
                ),
                (
                    "1970-01-01T00:00:00.5Z",
                    Some("1970-01-01T00:00:00.500Z"),
                ),
                (
                    "1970-01-01t00:00:00.0001234567z",
                    Some("1970-01-01T00:00:00.001Z"),
                ),
                (
                    "1970-01-01T00:00:00.0001234567",
                    Some("1970-01-01T05:00:00.001Z"),
                ),
                (
                    "1970-01-01 00:00:00.0001234567",
                    Some("1970-01-01T05:00:00.001Z"),
                ),
                (
                    "1970-01-01 00:00:00.0123456789",
                    Some("1970-01-01T05:00:00.123Z"),
                ),
                (
                    "1970-01-01T00:00:00.0001234567+05:30",
                    Some("1969-12-31T18:30:00.001Z"),
                ),
                (
                    "1969-12-31T23:59:59.0001234567Z",
                    Some("1969-12-31T23:59:59.001Z"),
                ),
                (
                    "2026-10-13T16:00:00.0001234567Z",
                    Some("2026-10-13T16:00:00.001Z"),
                ),
                (
                    "2026-10-13T16:00:00.0123456789Z",
                    Some("2026-10-13T16:00:00.123Z"),
                ),
                (
                    "2026-10-13 16:00:00.0123456789",
                    Some("2026-10-13T20:00:00.123Z"),
                ),
                (
                    "2026-02-31T00:00:00.0001234567Z",
                    Some("2026-03-03T00:00:00.001Z"),
                ),
                (
                    "Oct 13 2026 16:00:00.0001234567",
                    Some("2026-10-13T20:00:00.001Z"),
                ),
                (
                    "10/13/2026 16:00:00.0123456789",
                    Some("2026-10-13T20:00:00.123Z"),
                ),
                ("1970-01-01T24:00:00.0001234567Z", None),
                ("1970-01-01T24:00:00.0000000001Z", None),
                ("1970-01-01 24:00:00.0001234567", None),
                (
                    "1970-01-01 24:00:00.0000000001",
                    Some("1970-01-02T05:00:00.000Z"),
                ),
            ];
            for (input, expected) in cases {
                assert_eq!(super::canonical_iso(input).as_deref(), expected, "{input}");
            }
        });
    }

    #[test]
    fn a_month_word_continues_through_characters_at_or_above_a() {
        with_tz("America/New_York", || {
            // Node 22 `Date.parse`. A word is every non-space character at or
            // above `A`, so `Oct_13` is October 13 and `Oct_32` is October of
            // year 32. A non-month word glued to a digit is empty.
            let cases = [
                ("Oct_13", Some("2001-10-13T04:00:00.000Z")),
                ("Oct_13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct~13", Some("2001-10-13T04:00:00.000Z")),
                ("13Oct_2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct_32", Some("2032-10-01T04:00:00.000Z")),
                ("Jan_32", Some("2032-01-01T05:00:00.000Z")),
                ("Octé13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct\u{7f}13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct😀13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("november_the_13 2026", Some("2026-11-13T05:00:00.000Z")),
                ("May~~~6 2026", Some("2026-05-06T04:00:00.000Z")),
                ("May~ 6 2026", Some("2026-05-06T04:00:00.000Z")),
                ("Oct_13 2026 16:00", Some("2026-10-13T20:00:00.000Z")),
                ("Oct_13 2026 4:00 PM", Some("2026-10-13T20:00:00.000Z")),
                ("Oct_13 2026 GMT", Some("2026-10-13T00:00:00.000Z")),
                ("Oct_13 2026 EST", Some("2026-10-13T05:00:00.000Z")),
                ("DEC_31 99", Some("1999-12-31T05:00:00.000Z")),
                ("Dec_31 99 23:00", Some("2000-01-01T04:00:00.000Z")),
                ("13oct_2026GMT+5", Some("2026-10-12T19:00:00.000Z")),
                ("13Oct_2026GMT", Some("2026-10-13T00:00:00.000Z")),
                ("Sep~10 2026", Some("2026-09-10T04:00:00.000Z")),
                ("January_the_1", Some("2001-01-01T05:00:00.000Z")),
                ("preamble_ Oct_13 26 4::5", Some("2026-10-13T08:00:05.000Z")),
                ("Oct_13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct_13,2026", Some("2026-10-13T04:00:00.000Z")),
                (
                    "Saturday, Oct_13, 2026 4:5 PM",
                    Some("2026-10-13T20:05:00.000Z"),
                ),
                ("Feb_29 2024", Some("2024-02-29T05:00:00.000Z")),
                ("marketplace_13 2026", Some("2026-03-13T04:00:00.000Z")),
                (
                    "hello_world Oct 13 2026 4:5 PM EST",
                    Some("2026-10-13T21:05:00.000Z"),
                ),
                ("note: Oct_13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct_foo13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("October_13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("oct123", Some("0123-10-01T04:56:02.000Z")),
                ("foo[bar13 Oct 2026", None),
                ("on_Oct_13 2026", None),
                ("May ~6 2026", None),
                ("Oct _13 2026", None),
                ("12~31 2026", None),
                ("Oct_13_2026", None),
                ("Oct13_2026", None),
                ("Oct_13th", None),
                ("4:00_PM Oct 13 2026", None),
                ("oct123def", None),
                ("A1", None),
            ];
            for (input, expected) in cases {
                assert_eq!(super::canonical_iso(input).as_deref(), expected, "{input}");
            }
        });
    }

    #[test]
    fn a_colon_after_a_word_is_a_separator() {
        with_tz("America/New_York", || {
            // Node 22 `Date.parse`. `note` is a garbage word and `:` is only
            // a separator, so `note: 10/13/2026` is 13 October local midnight.
            // `note10/13/2026` glues the word to the number and stays empty.
            // A leading space before `2026-10-13:16:00` makes 13 the hour.
            let cases = [
                ("note: 10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("note:10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("note : 10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("note:  10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("NOTE: 10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("hello: Oct 13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("hello:Oct 13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("hello : Oct 13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("see: 2026-10-13", Some("2026-10-13T04:00:00.000Z")),
                ("see:2026-10-13", Some("2026-10-13T04:00:00.000Z")),
                ("see : 2026-10-13", Some("2026-10-13T04:00:00.000Z")),
                ("note: 16:00 Oct 13 2026", Some("2026-10-13T20:00:00.000Z")),
                ("note:16:00 Oct 13 2026", Some("2026-10-13T20:00:00.000Z")),
                ("note : 16:00 Oct 13 2026", Some("2026-10-13T20:00:00.000Z")),
                ("note: 4:00 PM Oct 13 2026", Some("2026-10-13T20:00:00.000Z")),
                ("note:4:5 Oct 13 2026", Some("2026-10-13T08:05:00.000Z")),
                ("note: 10/13/1950", Some("1950-10-13T05:00:00.000Z")),
                ("note:10/13/1950", Some("1950-10-13T05:00:00.000Z")),
                ("note : 10/13/1950", Some("1950-10-13T05:00:00.000Z")),
                ("hello: Oct 13 1950", Some("1950-10-13T05:00:00.000Z")),
                ("see: 1950-10-13", Some("1950-10-13T05:00:00.000Z")),
                ("see:1950-10-13", Some("1950-10-13T05:00:00.000Z")),
                ("note: 16:00 Oct 13 1950", Some("1950-10-13T21:00:00.000Z")),
                ("note: 2026-10-13", Some("2026-10-13T04:00:00.000Z")),
                ("note:2026-10-13", Some("2026-10-13T04:00:00.000Z")),
                ("note: 2026-10-13 16:00", Some("2026-10-13T20:00:00.000Z")),
                ("note:2026-10-13 16:00", Some("2026-10-13T20:00:00.000Z")),
                ("see: 2026-10", Some("2026-10-01T04:00:00.000Z")),
                ("see:2026", Some("2026-01-01T05:00:00.000Z")),
                ("see: 10 13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("see:10 13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("note:10/13/2026 16:00", Some("2026-10-13T20:00:00.000Z")),
                ("note:10/13/2026 :16:00", Some("2026-10-13T20:00:00.000Z")),
                ("note: 10/13/2026 GMT", Some("2026-10-13T00:00:00.000Z")),
                ("note:10/13/2026EST", Some("2026-10-13T05:00:00.000Z")),
                ("note: 10/13/2026 EST", Some("2026-10-13T05:00:00.000Z")),
                ("GMT:10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("EST: 10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("AM: 4:00 Oct 13 2026", Some("2026-10-13T08:00:00.000Z")),
                ("hello_world:10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("hello_world: 10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("foo:bar 10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("note::10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("note: :10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct:13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("May:6 2026", Some("2026-05-06T04:00:00.000Z")),
                ("marketplace:13 2026", Some("2026-03-13T04:00:00.000Z")),
                ("note:Oct_13 2026", Some("2026-10-13T04:00:00.000Z")),
                ("note:Oct_13", Some("2001-10-13T04:00:00.000Z")),
                ("Oct:13:2026", Some("2026-10-01T17:00:00.000Z")),
                ("hello:Oct:13:2026", Some("2026-10-01T17:00:00.000Z")),
                ("note:2026-10-13:16:00", Some("2026-10-01T17:16:00.000Z")),
                ("note 2026-10-13:16:00", Some("2026-10-01T17:16:00.000Z")),
                (" 2026-10-13:16:00", Some("2026-10-01T17:16:00.000Z")),
                (" 2026-10-13: 16:00", Some("2026-10-01T17:16:00.000Z")),
                (" 2026-10-13:4:5", Some("2026-10-01T17:04:05.000Z")),
                (" 2026-10-13:16:00 EST", Some("2026-10-01T18:16:00.000Z")),
                (" 2026-10-13:16:00Z", Some("2026-10-01T13:16:00.000Z")),
                (" 2026-10:16:00", Some("2026-01-01T15:16:00.000Z")),
                ("#2026-10-13:16:00", Some("2026-10-01T17:16:00.000Z")),
                ("10/13/2026", Some("2026-10-13T04:00:00.000Z")),
                ("Oct_13", Some("2001-10-13T04:00:00.000Z")),
                ("2026-10-13:16:00", Some("2026-10-13T20:00:00.000Z")),
                ("note10/13/2026", None),
                ("note:16:00", None),
                ("note:10/13/2026:16:00", None),
                (" 2026:16:00", None),
                ("Oct 13 2026:16:00", None),
                ("10/13/2026:16:00", None),
                ("on_Oct_13 2026", None),
                ("x:2026-10-13T16:00:00Z", None),
            ];
            for (input, expected) in cases {
                assert_eq!(super::canonical_iso(input).as_deref(), expected, "{input}");
            }
        });
    }

    #[test]
    fn a_month_after_a_time_colon_defaults_the_day() {
        with_tz("America/New_York", || {
            // Node 22 `Date.parse`. `13:` is an hour and `Oct` is the month.
            // `2026` cannot be a day, so it is the year and the day is 1.
            // A `-` after the month is skipped. `.` and `/` are symbols, so
            // the following number is still a date field. October 2026 is
            // EDT, so 13:00 local is 17:00 UTC. `30` fills the open minute.
            // `13` fits that minute, so `13:Oct-13` has no date.
            // `13:Oct.13.2026` is empty: that dot is not a clock fraction.
            // October 1950 is EST, so 13:00 local is 18:00 UTC.
            let cases = [
                ("13:Oct:2026", Some("2026-10-01T17:00:00.000Z")),
                ("13:Oct 2026", Some("2026-10-01T17:00:00.000Z")),
                ("4:May:2026", Some("2026-05-01T08:00:00.000Z")),
                ("13:October:2026", Some("2026-10-01T17:00:00.000Z")),
                ("13:Oct:2026 30", Some("2026-10-01T17:30:00.000Z")),
                ("13:Oct:1950", Some("1950-10-01T18:00:00.000Z")),
                ("16:Oct:13", None),
                ("13:Oct:13", None),
                ("13:Oct-2026", Some("2026-10-01T17:00:00.000Z")),
                ("13:Oct.2026", Some("2026-10-01T17:00:00.000Z")),
                ("13:Oct/2026", Some("2026-10-01T17:00:00.000Z")),
                ("4:May-2026", Some("2026-05-01T08:00:00.000Z")),
                ("13:October-2026", Some("2026-10-01T17:00:00.000Z")),
                ("13:Oct-2026 30", Some("2026-10-01T17:30:00.000Z")),
                ("13:Oct-1950", Some("1950-10-01T18:00:00.000Z")),
                ("13:Oct-13", None),
                ("16:Oct-13", None),
                ("13:Oct.13.2026", None),
                ("13:Oct-2026.5", Some("2026-10-01T17:05:00.000Z")),
                ("13:Oct-2026.05", Some("2026-10-01T17:05:00.000Z")),
                ("13:Oct:2026.5", Some("2026-10-01T17:05:00.000Z")),
                ("13:Oct 2026.5", Some("2026-10-01T17:05:00.000Z")),
                ("4:May-2026.5", Some("2026-05-01T08:05:00.000Z")),
                ("4:May-2026.15", Some("2026-05-01T08:15:00.000Z")),
                ("13:00:Oct-2026.5", Some("2026-10-01T17:00:05.000Z")),
                ("13:00:Oct-2026.5.1", Some("2026-10-01T17:00:05.100Z")),
                ("13:Oct-1950.5", Some("1950-10-01T18:05:00.000Z")),
                ("13:Oct-2026.60", None),
                ("13:Oct-2026.5.1", None),
                ("13:Oct-2026.5.", None),
                ("13:Oct-2026.5/1", None),
                ("13:Oct-2026/5", Some("2026-10-01T17:05:00.000Z")),
                ("13:Oct-2026/05", Some("2026-10-01T17:05:00.000Z")),
                ("13:Oct:2026/5", Some("2026-10-01T17:05:00.000Z")),
                ("13:Oct 2026/5", Some("2026-10-01T17:05:00.000Z")),
                ("4:May-2026/5", Some("2026-05-01T08:05:00.000Z")),
                ("13:00:Oct-2026/5", Some("2026-10-01T17:00:05.000Z")),
                ("13:Oct-1950/5", Some("1950-10-01T18:05:00.000Z")),
                ("13:Oct-2026/60", None),
                ("13:Oct-2026/5/1", None),
                ("Oct 13 2026/5", Some("2026-10-13T04:00:00.000Z")),
                ("2026/5", Some("2026-05-01T04:00:00.000Z")),
            ];
            for (input, expected) in cases {
                assert_eq!(super::canonical_iso(input).as_deref(), expected, "{input}");
            }
        });
    }

    #[test]
    fn a_second_clock_after_a_time_colon_month_is_empty() {
        with_tz("America/New_York", || {
            assert_eq!(super::canonical_iso("13:Oct:2026 4:00 PM"), None);
            assert_eq!(super::canonical_iso("Monday 13:Oct:2026 4:00 PM"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 2026 4:00 PM").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("13:Oct:2026").as_deref(),
                Some("2026-10-01T17:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_positive_expanded_year_with_a_clock_is_local() {
        with_tz("America/New_York", || {
            assert_eq!(
                super::canonical_iso("+002026-10-13").as_deref(),
                Some("2026-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13 16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13 4:5").as_deref(),
                Some("2026-10-13T08:05:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13 16:00 EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+000001-10-13 16:00").as_deref(),
                Some("2013-01-10T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+010000-10-13 16:00").as_deref(),
                Some("+010000-10-13T20:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+000100-10-13 16:00").as_deref(),
                Some("0100-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13 EST").as_deref(),
                Some("2026-10-13T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13 GMT+5").as_deref(),
                Some("2026-10-12T19:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("+002026-10-13 +5"), None);
            assert_eq!(super::canonical_iso("+002026-10-13 PST+5"), None);
        });
    }

    #[test]
    fn date_parse_reads_open_clocks_and_dotted_seconds() {
        with_tz("America/New_York", || {
            // A colon before a zone leaves the open field at zero.
            assert_eq!(
                super::canonical_iso("2026-10-13 16:GMT").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:EST").as_deref(),
                Some("2026-10-13T21:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:+5").as_deref(),
                Some("2026-10-13T11:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 4: :5Z").as_deref(),
                Some("2026-10-13T04:05:00.000Z")
            );
            // `16:00.05` is 50 seconds. A fraction may be glued to an offset.
            assert_eq!(
                super::canonical_iso("10/13/2026 16:00.05").as_deref(),
                Some("2026-10-13T20:00:50.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13 16:00:00.500-5").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
            // A clock field past 59 is a date number. `60` is the year 1960.
            assert_eq!(
                super::canonical_iso("5/6 16:60").as_deref(),
                Some("1960-05-06T20:00:00.000Z")
            );
            // A second clock, or a bare number glued to Z, is empty.
            assert_eq!(super::canonical_iso("2026-10-13 16:00 16:00 Z"), None);
            assert_eq!(super::canonical_iso("10/13/2026 0Z"), None);
            // `4Z` fills the missing day of a year/month slash date.
            assert_eq!(
                super::canonical_iso("2026/10 4Z").as_deref(),
                Some("2026-10-04T00:00:00.000Z")
            );
            // A negative expanded year stays in that year when Z is glued on.
            assert_eq!(
                super::canonical_iso("-000001-10-13Z").as_deref(),
                Some("-000001-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13 16:00:00.5GMT").as_deref(),
                Some("-000001-10-13T16:00:00.500Z")
            );
        });
    }

    #[test]
    fn a_line_separator_inside_a_month_is_not_a_year() {
        with_tz("America/New_York", || {
            // U+2028 and U+2029 are word characters. Two of them around the
            // day are a garbage word after a number, so the date is empty.
            // One of them stays inside the month word.
            assert_eq!(super::canonical_iso("Oct\u{2028}13\u{2028}2026"), None);
            assert_eq!(super::canonical_iso("Oct\u{2029}13\u{2029}2026"), None);
            assert_eq!(super::canonical_iso("\u{2028}October13 2026"), None);
            assert_eq!(
                super::canonical_iso("Oct\u{2028}13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct\u{2029}13 2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_colon_takes_the_last_short_hyphen_field_as_the_hour() {
        with_tz("America/New_York", || {
            // `2026-1-2:16:00` is 02:16 on 1 January. The colon attaches to 2.
            // A strict `2026-10-13:16:00` keeps 13 as the day.
            assert_eq!(
                super::canonical_iso("2026-1-2:16:00").as_deref(),
                Some("2026-01-01T07:16:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1-2:").as_deref(),
                Some("2026-01-01T07:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1-2:4:00 PM").as_deref(),
                Some("2026-01-01T19:04:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1-2:16:00.5").as_deref(),
                Some("2026-01-01T07:16:00.500Z")
            );
            assert_eq!(
                super::canonical_iso("2026-7-2:16:00 EST").as_deref(),
                Some("2026-07-01T07:16:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("99-1-2:16:00").as_deref(),
                Some("1999-01-01T07:16:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-1-2:16:00").as_deref(),
                Some("2026-01-01T07:16:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-1-2:16:00").as_deref(),
                Some("-000001-01-01T07:12:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1-2-3:16:00").as_deref(),
                Some("2026-01-02T08:16:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-1-2").as_deref(),
                Some("2026-01-02T05:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13:16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("2026-10-13-16:00"), None);
            assert_eq!(super::canonical_iso("+002026-10-13-16:00"), None);
            assert_eq!(
                super::canonical_iso("Oct 13 2026 :5-04:00").as_deref(),
                Some("2026-10-13T08:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Oct 13 2026 16:00:00.5 EST").as_deref(),
                Some("2026-10-13T21:00:00.500Z")
            );
        });
    }

    #[test]
    fn a_fullwidth_digit_prefix_is_a_word() {
        with_tz("America/New_York", || {
            // Fullwidth digits are letters to `Date.parse`. `２０２６` is a
            // garbage word, then `-` is skipped, and `10-13` is 13 October 2001.
            assert_eq!(
                super::canonical_iso("２０２６-10-13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("２０２６-10-13-").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("２-10-13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("hello-10-13").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("Monday-1-").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("２026-10-13"), None);
            assert_eq!(super::canonical_iso("10-hello-13"), None);
        });
    }

    #[test]
    fn a_sign_after_a_slash_field_is_empty() {
        with_tz("America/New_York", || {
            // A later sign is not the year. The first field may still be signed.
            assert_eq!(super::canonical_iso("01/01/+002026"), None);
            assert_eq!(super::canonical_iso("01/01/-000000"), None);
            assert_eq!(super::canonical_iso("10/13/+2026"), None);
            assert_eq!(super::canonical_iso("2026/+10/13"), None);
            assert_eq!(super::canonical_iso("1/1/+002026"), None);
            assert_eq!(super::canonical_iso("10/13/-5"), None);
            assert_eq!(
                super::canonical_iso("+002026/10/13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+2026/10/13").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("10/13/2026").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_negative_expanded_year_keeps_slash_fields() {
        with_tz("America/New_York", || {
            // Slashes are not ES5 hyphens, so year -1 stays on local mean time.
            // A day past 31 is empty. Two-digit hyphens stay UTC.
            assert_eq!(
                super::canonical_iso("-000001/01/01").as_deref(),
                Some("-000001-01-01T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001/10/13").as_deref(),
                Some("-000001-10-13T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001/02/31").as_deref(),
                Some("-000001-03-03T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-2-31").as_deref(),
                Some("-000001-03-03T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001/10").as_deref(),
                Some("-000001-10-01T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-").as_deref(),
                Some("-000001-01-01T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-271821/10/01").as_deref(),
                Some("-271821-10-01T04:56:02.000Z")
            );
            assert_eq!(super::canonical_iso("-000001/01/32"), None);
            assert_eq!(super::canonical_iso("-000001-01-32"), None);
            assert_eq!(super::canonical_iso("-000001/13/1"), None);
            assert_eq!(super::canonical_iso("-000001-01-00"), None);
            assert_eq!(super::canonical_iso("-000001-10-13-"), None);
            assert_eq!(
                super::canonical_iso("-000001-01-01").as_deref(),
                Some("-000001-01-01T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-02-31").as_deref(),
                Some("-000001-03-03T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso(" -000001/01/01").as_deref(),
                Some("2001-01-01T05:00:00.000Z")
            );
        });
    }

    #[test]
    fn a_trailing_dot_keeps_a_negative_expanded_year() {
        with_tz("America/New_York", || {
            // The dot makes midnight local. Year -1 stays negative.
            assert_eq!(
                super::canonical_iso("-000001-10-13.").as_deref(),
                Some("-000001-10-13T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001.").as_deref(),
                Some("-000001-01-01T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10.").as_deref(),
                Some("-000001-10-01T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-1-13.").as_deref(),
                Some("-000001-01-13T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13..").as_deref(),
                Some("-000001-10-13T04:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13").as_deref(),
                Some("-000001-10-13T00:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000000-10-13.").as_deref(),
                Some("2001-10-13T04:00:00.000Z")
            );
            assert_eq!(
                super::canonical_iso("+002026-10-13.").as_deref(),
                Some("2026-10-13T04:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("-000001-13."), None);
        });
    }

    #[test]
    fn a_newline_before_a_negative_year_clock_is_a_separator() {
        with_tz("America/New_York", || {
            // Tab, newline, and a no-break space are the same break as a space.
            // Year -1 keeps its local mean time instead of becoming 2013.
            assert_eq!(
                super::canonical_iso("-000001-10-13\n16:00").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13\t16:00").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("-000001-10-13\u{00a0}16:00").as_deref(),
                Some("-000001-10-13T20:56:02.000Z")
            );
            assert_eq!(
                super::canonical_iso("2026-10-13\n16:00").as_deref(),
                Some("2026-10-13T20:00:00.000Z")
            );
            assert_eq!(super::canonical_iso("-000001-10-13\u{2028}16:00"), None);
        });
    }
}
