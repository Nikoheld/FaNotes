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

/// `Date.parse` plus `toISOString`. A zoned timestamp becomes UTC with milliseconds.
///
/// `YYYY`, `+YYYYYY`, and those forms with a two-digit month and day are
/// midnight UTC. A wider year, a month or day that is not two digits, or
/// whitespace around the date is local midnight. A time without a zone is
/// local time.
/// In a daylight-saving overlap that is the earlier instant. A skipped hour
/// keeps the offset from before the transition. A day past the end of the
/// month rolls forward, and `24:00:00` is the next midnight.
pub fn canonical_iso(value: &str) -> Option<String> {
    if value.contains('(') {
        // `(comment)` is skipped, and an unclosed `(` consumes the rest.
        let omitted = omit_parentheticals(value);
        if omitted != value {
            return canonical_iso(&omitted);
        }
    }
    match rewrite_ignored_symbols(value) {
        SymbolRewrite::Illegal => return None,
        SymbolRewrite::Changed(next) => return canonical_iso(&next),
        SymbolRewrite::Same => {}
    }
    // U+2028 and U+2029 are JavaScript trim characters, and `Date.parse` rejects
    // them. Only the date-parse spaces are padding.
    let trimmed = value.trim_matches(is_date_parse_space);
    if let Some(next) = strip_leading_word(trimmed) {
        // `hello 2026-10-13` is local. The word is not part of the date.
        return canonical_iso(&next);
    }
    // A period between numbers is a hyphen. A period before a clock is a space.
    // Trailing periods make a date local. A `T` form keeps its fraction dot.
    if !has_iso_t(&trimmed) && trimmed.contains('.') {
        let normalized = rewrite_periods(&trimmed);
        if normalized != trimmed {
            if is_date_only_shape(&normalized) && !normalized.contains(',') {
                return date_only_iso(&normalized, true);
            }
            return canonical_iso(&normalized);
        }
    }
    // A comma is a space. Around a date it makes midnight local. After `T` it
    // is NaN.
    if trimmed.contains(',') {
        if has_iso_t(trimmed) {
            return None;
        }
        let normalized = commas_to_spaces(&trimmed);
        let edge = trimmed.starts_with(',') || trimmed.ends_with(',');
        if edge && is_date_only_shape(&normalized) {
            return date_only_iso(&normalized, true);
        }
        return canonical_iso(&normalized);
    }
    if has_ampm_word(trimmed) {
        // `4:00 PM` is 16:00. A `T` before AM/PM is NaN. `AM` before a date
        // is an ordinary word, so a clock that does not fold falls through.
        if has_iso_t(trimmed) {
            return None;
        }
        if let Some(normalized) = fold_ampm(trimmed) {
            return canonical_iso(&normalized);
        }
    }
    if has_english_month(trimmed) {
        let normalized = rewrite_month_name(trimmed)?;
        return canonical_iso(&normalized);
    }
    if trimmed.contains('/') {
        // `2026/10/13` is local midnight. `10/13/2026` is the same day.
        let normalized = rewrite_slash_date(trimmed)?;
        return canonical_iso(&normalized);
    }
    if let Some(normalized) = fold_spaced_numeric_offset(trimmed) {
        // `2026-10-13 16:00 +5` is 16:00 at a fixed offset.
        return canonical_iso(&normalized);
    }
    if !has_iso_t(trimmed) {
        if let Some(normalized) = fold_trailing_zone(trimmed) {
            // `16:00 EST` is a fixed offset. `(EST)` is a comment, so the
            // clock stays local.
            return canonical_iso(&normalized);
        }
    }
    let surrounded = has_date_parse_padding(value);
    // A space around `T` is NaN. A space around `2026-10-13 16:00:00Z` is ignored.
    if surrounded && has_iso_t(trimmed) {
        return None;
    }
    let source = if surrounded { trimmed } else { value };
    if is_date_only_shape(trimmed) {
        return date_only_iso(trimmed, surrounded);
    }
    // `2026 10 13` is not a year plus a clock. A tail with no colon is a legacy
    // number, such as `2026 10`. A clock that fails to parse is not an ISO time.
    let Some((year, month, day, time_at)) = split_calendar(source) else {
        return legacy_numeric_iso(trimmed);
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time_text = source.get(time_at..)?;
    let Some((mut hour, minute, second, millis, rest)) = parse_clock(time_text) else {
        // `2026-10-13 16:00:60` is a broken ISO clock. `2026 10 13 16:00`
        // is a legacy date whose tail is not one clock.
        if time_text.contains(':') && !time_text.contains(is_date_parse_space) {
            return None;
        }
        return legacy_numeric_iso(trimmed);
    };
    let (mut year, mut month, mut day) = normalize_ymd(year, month, day)?;
    if hour == 24 {
        if minute != 0 || second != 0 || millis != 0 {
            return None;
        }
        hour = 0;
        (year, month, day) = add_day(year, month, day);
    }
    let (year, month, day, hour, minute, second) = if rest.eq_ignore_ascii_case("Z") {
        (year, month, day, hour, minute, second)
    } else if rest.is_empty() {
        local_civil_to_utc(year, month, day, hour, minute, second)?
    } else {
        let offset = parse_offset(rest)?;
        shift_seconds(year, month, day, hour, minute, second, -(offset as i64))?
    };
    Some(format_civil_iso(
        year, month, day, hour, minute, second, millis,
    ))
}

fn has_english_month(value: &str) -> bool {
    month_words(value).iter().any(|word| english_month(word).is_some())
}

fn has_ampm_word(value: &str) -> bool {
    value
        .split(char::is_whitespace)
        .any(|word| word.eq_ignore_ascii_case("am") || word.eq_ignore_ascii_case("pm"))
}

fn has_iso_t(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.windows(3).any(|window| {
        window[0].is_ascii_digit()
            && (window[1] == b'T' || window[1] == b't')
            && window[2].is_ascii_digit()
    })
}

/// `4:00 PM` becomes `16:00`. `12:00 AM` and `0:00 AM` become `00:00`.
fn fold_ampm(trimmed: &str) -> Option<String> {
    let words: Vec<&str> = trimmed
        .split(char::is_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    let ampm_at = words.iter().position(|word| {
        word.eq_ignore_ascii_case("am") || word.eq_ignore_ascii_case("pm")
    })?;
    if ampm_at == 0 {
        return None;
    }
    let pm = words[ampm_at].eq_ignore_ascii_case("pm");
    let clock = ampm_clock(words[ampm_at - 1], pm)?;
    let mut kept = Vec::new();
    for (index, word) in words.iter().enumerate() {
        if index == ampm_at - 1 {
            kept.push(clock.as_str());
        } else if index == ampm_at {
            continue;
        } else {
            kept.push(*word);
        }
    }
    Some(kept.join(" "))
}

fn ampm_clock(clock: &str, pm: bool) -> Option<String> {
    if let Some(padded) = in_range_ampm_clock(clock, pm) {
        return Some(padded);
    }
    // `4:00:60 PM` is still a clock. The 60 is a date number on a month-name
    // date, so the hour changes and the rest of the field stays in the text.
    let (hour_text, rest) = clock.split_once(':')?;
    if hour_text.is_empty()
        || rest.is_empty()
        || !hour_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hour = ampm_hour(hour_text.parse().ok()?, pm)?;
    Some(format!("{hour:02}:{rest}"))
}

fn in_range_ampm_clock(clock: &str, pm: bool) -> Option<String> {
    let (body, fraction) = match clock.split_once('.') {
        Some((body, fraction))
            if !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (body, Some(fraction))
        }
        None => (clock, None),
        Some(_) => return None,
    };
    let mut numbers = Vec::new();
    for part in body.split(':') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        numbers.push(part.parse::<u32>().ok()?);
    }
    if !(2..=3).contains(&numbers.len()) {
        return None;
    }
    let hour = ampm_hour(numbers[0], pm)?;
    if numbers[1] > 59 || numbers.get(2).copied().unwrap_or(0) > 59 {
        return None;
    }
    let mut out = if numbers.len() == 3 {
        format!("{hour:02}:{:02}:{:02}", numbers[1], numbers[2])
    } else {
        format!("{hour:02}:{:02}", numbers[1])
    };
    if let Some(fraction) = fraction {
        out.push('.');
        out.push_str(fraction);
    }
    Some(out)
}

fn ampm_hour(hour: u32, pm: bool) -> Option<u32> {
    if hour > 12 {
        return None;
    }
    if hour == 0 || hour == 12 {
        return Some(if pm { 12 } else { 0 });
    }
    Some(if pm { hour + 12 } else { hour })
}

/// Attach `EST` or `GMT+5` to the clock, and drop one trailing `(comment)`.
fn fold_trailing_zone(trimmed: &str) -> Option<String> {
    let words: Vec<&str> = trimmed
        .split(char::is_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    if words.len() < 2 {
        return None;
    }
    let mut end = words.len();
    let mut changed = false;
    if let Some(token) = words.last() {
        if token.starts_with('(') && token.ends_with(')') && token.len() > 2 {
            end -= 1;
            changed = true;
        }
    }
    if end >= 2 && words[end - 2].contains(':') {
        if let Some(suffix) = month_zone_suffix(words[end - 1]) {
            let clock = format!("{}{suffix}", words[end - 2]);
            let mut kept = Vec::new();
            for (index, word) in words.iter().enumerate() {
                if index == end - 2 {
                    kept.push(clock.clone());
                } else if index < end - 2 {
                    kept.push((*word).to_string());
                }
            }
            return Some(kept.join(" "));
        }
    }
    if changed && end > 0 {
        return Some(words[..end].join(" "));
    }
    None
}

fn month_words(value: &str) -> Vec<&str> {
    value
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|token| token.trim_matches('.'))
        .filter(|token| !token.is_empty())
        .flat_map(expand_joined_month)
        .flat_map(expand_glued_month)
        .flat_map(split_unmatched_paren)
        .collect()
}

/// `13)` is the number 13 and then a `)`. The `)` is its own word.
fn split_unmatched_paren(token: &str) -> Vec<&str> {
    if !token.contains(')') {
        return vec![token];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, character) in token.char_indices() {
        if character == ')' {
            if index > start {
                parts.push(&token[start..index]);
            }
            parts.push(")");
            start = index + character.len_utf8();
        }
    }
    if start < token.len() {
        parts.push(&token[start..]);
    }
    parts
}

enum SymbolRewrite {
    Same,
    Changed(String),
    Illegal,
}

/// Characters below `A` that are not date syntax are ignored, like `!` and `#`.
/// A `)` after a digit, or `16:00!`, is not a date. Replacing a symbol with a
/// space makes a date-only value local.
fn rewrite_ignored_symbols(value: &str) -> SymbolRewrite {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut changed = false;
    for (index, character) in chars.iter().copied().enumerate() {
        if character == ')' {
            if previous_significant(&chars, index).is_some_and(|item| item.is_ascii_digit()) {
                return SymbolRewrite::Illegal;
            }
            changed = true;
            push_separator(&mut out);
            continue;
        }
        if is_ignored_legacy_symbol(character) {
            if symbol_ends_a_clock(&chars, index) {
                return SymbolRewrite::Illegal;
            }
            changed = true;
            push_separator(&mut out);
            continue;
        }
        out.push(character);
    }
    if changed {
        SymbolRewrite::Changed(out)
    } else {
        SymbolRewrite::Same
    }
}

fn previous_significant(chars: &[char], index: usize) -> Option<char> {
    let mut cursor = index;
    while cursor > 0 {
        cursor -= 1;
        if !is_date_parse_space(chars[cursor]) {
            return Some(chars[cursor]);
        }
    }
    None
}

fn push_separator(out: &mut String) {
    if !out.ends_with(is_date_parse_space) {
        out.push(' ');
    }
}

fn is_ignored_legacy_symbol(character: char) -> bool {
    (character as u32) < u32::from(b'A')
        && !character.is_ascii_digit()
        && !is_date_parse_space(character)
        && !matches!(character, ':' | '-' | '+' | '.' | '/' | '(' | ')')
}

/// `16:00!` finalizes the clock and then sees junk. `2026-10-13!16:00` does not,
/// because the mark is before the clock.
fn symbol_ends_a_clock(chars: &[char], index: usize) -> bool {
    let mut cursor = index;
    let mut saw_colon = false;
    while cursor > 0 {
        cursor -= 1;
        if is_date_parse_space(chars[cursor]) {
            break;
        }
        if chars[cursor] == ':' {
            saw_colon = true;
        }
    }
    if !saw_colon {
        return false;
    }
    let mut ahead = index + 1;
    while ahead < chars.len() && is_ignored_legacy_symbol(chars[ahead]) {
        ahead += 1;
    }
    ahead >= chars.len() || is_date_parse_space(chars[ahead])
}

/// `hello 2026-10-13` drops `hello`. The space in front of the date stays, so
/// a date-only value is local.
fn strip_leading_word(trimmed: &str) -> Option<String> {
    let end = trimmed
        .char_indices()
        .find(|(_, character)| is_date_parse_space(*character))?
        .0;
    let word = &trimmed[..end];
    if word.is_empty()
        || !word.chars().all(|character| character.is_ascii_alphabetic())
        || english_month(word).is_some()
    {
        return None;
    }
    let rest = trimmed[end..].trim_start_matches(is_date_parse_space);
    if rest.is_empty() {
        return None;
    }
    Some(format!(" {rest}"))
}

/// A date with no month name. `5` is 1 May 2001. `10 13 2026 GMT` is
/// 13 October 2026 at midnight UTC. `4:00 PM5` is 16:00 that May.
fn legacy_numeric_iso(trimmed: &str) -> Option<String> {
    let words = month_words(trimmed);
    let (month, day, year, clock, offset) = compose_month_date(&words, true)?;
    let (year, month, day, suffix) = match offset {
        None => (year, month, day, String::new()),
        Some(minutes) => {
            let (delta, suffix) = fold_offset_days(minutes)?;
            let (year, month, day) = shift_ymd(year, month, day, delta)?;
            (year, month, day, suffix)
        }
    };
    canonical_iso(&format!(
        "{year:04}-{month:02}-{day:02}T{clock}{suffix}"
    ))
}

/// Drop balanced parenthetical groups. An unclosed `(` drops the rest of the
/// text. A `)` with no `(` stays, so `Oct 13) 2026` is not a date.
fn omit_parentheticals(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '(' {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        let mut balance = 0;
        while index < chars.len() {
            if chars[index] == '(' {
                balance += 1;
            } else if chars[index] == ')' {
                balance -= 1;
            }
            index += 1;
            if balance == 0 {
                break;
            }
        }
    }
    out
}

/// `13Oct2026` and `Oct2026` are separate fields. `GMT5` is the zone `GMT`
/// and the number 5. `PM5` is the meridiem and the number 5. A non-keyword
/// glued to a digit, as in `foo13` or `Oct13th`, stays one token so the date
/// scan rejects it.
fn expand_glued_month(token: &str) -> Vec<&str> {
    // `GMT+5` is one zone. Splitting it would turn the 5 into a date number.
    if month_zone_suffix(token).is_some()
        || token.contains(':')
        || !token.bytes().any(|byte| byte.is_ascii_digit())
        || !token.bytes().any(|byte| byte.is_ascii_alphabetic())
    {
        return vec![token];
    }
    let bytes = token.as_bytes();
    let mut runs = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_alphabetic() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                index += 1;
            }
            let letters = &token[start..index];
            if english_month(letters).is_none()
                && !exact_zone_keyword(letters)
                && !letters.eq_ignore_ascii_case("am")
                && !letters.eq_ignore_ascii_case("pm")
            {
                return vec![token];
            }
            runs.push(letters);
        } else if bytes[index].is_ascii_digit() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            runs.push(&token[start..index]);
        } else if bytes[index] == b'+' {
            let start = index;
            index += 1;
            if index >= bytes.len() || !bytes[index].is_ascii_digit() {
                return vec![token];
            }
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            runs.push(&token[start..index]);
        } else if matches!(bytes[index], b'-' | b'/' | b'.') {
            if index + 1 < bytes.len() && matches!(bytes[index + 1], b'-' | b'/' | b'.') {
                return vec![token];
            }
            index += 1;
        } else {
            return vec![token];
        }
    }
    if runs.is_empty() {
        vec![token]
    } else {
        runs
    }
}

/// `GMT`, `UT`, `Z`, and the US zone abbreviations. A longer word is not a
/// zone: `ESTX` stays one token. Months may be longer; these may not.
fn exact_zone_keyword(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "gmt" | "utc" | "ut" | "z"
            | "est"
            | "edt"
            | "cst"
            | "cdt"
            | "mst"
            | "mdt"
            | "pst"
            | "pdt"
    )
}

/// `GMT5` has no byte between the zone and the number. `GMT 5` does.
fn digits_follow_zone(zone: &str, next: &str) -> bool {
    unsigned_number(next).is_some() && zone.as_bytes().as_ptr_range().end == next.as_ptr()
}

fn glued_non_month(word: &str) -> bool {
    if word.contains(':') || month_zone_suffix(word).is_some() {
        return false;
    }
    word.bytes().any(|byte| byte.is_ascii_digit())
        && word.bytes().any(|byte| byte.is_ascii_alphabetic())
}

/// `13-Oct-26`, `13/Oct/26`, and `13.Oct.26` are three date fields. A leading
/// `+` or `-`, and separators after the year, are padding. An empty field
/// stays one token so `13-Oct--26` does not become a date.
fn expand_joined_month(token: &str) -> Vec<&str> {
    joined_month_parts(token).unwrap_or_else(|| vec![token])
}

fn joined_month_parts(token: &str) -> Option<Vec<&str>> {
    let stripped = token.trim_start_matches(['+', '-']);
    let body = stripped.trim_end_matches(['-', '/', '.']);
    if !body.contains(['-', '/', '.']) {
        return None;
    }
    let parts = split_joined_date(body);
    // `Oct-foo-2026` and `Oct--2026` keep the gap. An empty field after a
    // number, as in `13-Oct--26`, is rejected by the date scan.
    if !parts.iter().any(|part| english_month(part).is_some()) {
        return None;
    }
    Some(parts)
}

fn split_joined_date(body: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, character) in body.char_indices() {
        if matches!(character, '-' | '/' | '.') {
            parts.push(&body[start..index]);
            start = index + character.len_utf8();
        }
    }
    parts.push(&body[start..]);
    parts
}

fn unsigned_number(text: &str) -> Option<i32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// A `+` or `-` before a day or a leading year is ignored. The last number
/// of a month-name date cannot carry one.
fn signed_number(text: &str) -> Option<i32> {
    unsigned_number(text.strip_prefix(['+', '-']).unwrap_or(text))
}

/// The first three letters name the month. `Octopus` is October and `Maybe`
/// is May. A shorter word is not a month.
fn english_month(token: &str) -> Option<i32> {
    let mut letters = token.chars();
    let first = letters.next()?.to_ascii_lowercase();
    let second = letters.next()?.to_ascii_lowercase();
    let third = letters.next()?.to_ascii_lowercase();
    if !first.is_ascii_alphabetic() || !second.is_ascii_alphabetic() || !third.is_ascii_alphabetic()
    {
        return None;
    }
    match (first, second, third) {
        ('j', 'a', 'n') => Some(1),
        ('f', 'e', 'b') => Some(2),
        ('m', 'a', 'r') => Some(3),
        ('a', 'p', 'r') => Some(4),
        ('m', 'a', 'y') => Some(5),
        ('j', 'u', 'n') => Some(6),
        ('j', 'u', 'l') => Some(7),
        ('a', 'u', 'g') => Some(8),
        ('s', 'e', 'p') => Some(9),
        ('o', 'c', 't') => Some(10),
        ('n', 'o', 'v') => Some(11),
        ('d', 'e', 'c') => Some(12),
        _ => None,
    }
}

fn is_weekday_name(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "sun" | "sunday"
            | "mon"
            | "monday"
            | "tue"
            | "tues"
            | "tuesday"
            | "wed"
            | "wednesday"
            | "thu"
            | "thur"
            | "thurs"
            | "thursday"
            | "fri"
            | "friday"
            | "sat"
            | "saturday"
    )
}

fn legacy_year_number(year: i32) -> Option<i32> {
    if year >= 100 {
        return Some(year);
    }
    if (0..=49).contains(&year) {
        return Some(2000 + year);
    }
    if (50..=99).contains(&year) {
        return Some(1900 + year);
    }
    None
}

/// `Oct 13, 2026`, `13 Oct 2026`, and `2026 Oct 13`. `13-Oct` is 13 October
/// 2001 and `Oct 2026` is 1 October 2026. A date alone is local midnight, so
/// the result has no `Z`.
///
/// An out-of-range time field is not a time. `Oct 13 16:00:60` is 16:00 in
/// 1960, and `Oct 13 2026 16:00:60` is 16:00 because the day and year are
/// already set. The third date number is ignored. A fourth is not a date.
fn rewrite_month_name(trimmed: &str) -> Option<String> {
    let words = month_words(trimmed);
    let (month, day, year, clock, offset) = compose_month_date(&words, false)?;
    let (year, month, day, suffix) = match offset {
        None => (year, month, day, String::new()),
        Some(minutes) => {
            let (delta, suffix) = fold_offset_days(minutes)?;
            let (year, month, day) = shift_ymd(year, month, day, delta)?;
            (year, month, day, suffix)
        }
    };
    Some(format!("{year:04}-{month:02}-{day:02}T{clock}{suffix}"))
}

/// `YYYY/M/D` or `M/D/YYYY`. A date alone is local midnight. `T` is not a separator.
fn rewrite_slash_date(trimmed: &str) -> Option<String> {
    if has_iso_t(trimmed) {
        return None;
    }
    let mut offset_minutes = None;
    let (date, time) = if let Some(index) = trimmed.find(char::is_whitespace) {
        let rest = trimmed[index..].trim_start();
        let words: Vec<&str> = rest
            .split(char::is_whitespace)
            .filter(|word| !word.is_empty())
            .collect();
        if words.len() == 2 && words[0].contains(':') {
            if let Some((minutes, spilled)) = parse_legacy_offset(words[1]) {
                if !spilled.is_empty() {
                    return None;
                }
                offset_minutes = Some(minutes);
                (&trimmed[..index], Some(words[0].to_string()))
            } else {
                let Some(time) = slash_time_and_zone(rest) else {
                    return None;
                };
                (&trimmed[..index], Some(time))
            }
        } else {
            let Some(time) = slash_time_and_zone(rest) else {
                return None;
            };
            (&trimmed[..index], Some(time))
        }
    } else {
        (trimmed, None)
    };
    let mut parts = date.split('/');
    let first: i32 = parts.next()?.parse().ok()?;
    let second: i32 = parts.next()?.parse().ok()?;
    let third: i32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let (year, month, day) = if (1..=12).contains(&first) {
        (legacy_year_number(third)?, first, second)
    } else if first == 0 || first >= 32 {
        (legacy_year_number(first)?, second, third)
    } else {
        return None;
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let clock = match time {
        Some(time) => slash_clock(&time)?,
        None => "00:00:00".to_string(),
    };
    let (year, month, day, suffix) = match offset_minutes {
        None => (year, month, day, String::new()),
        Some(minutes) => {
            let (delta, suffix) = fold_offset_days(minutes)?;
            let (year, month, day) = shift_ymd(year, month, day, delta)?;
            (year, month, day, suffix)
        }
    };
    Some(format!("{year:04}-{month:02}-{day:02}T{clock}{suffix}"))
}

/// `16:00 EST` keeps the offset. `(EST)` is a comment, so the clock stays local.
fn slash_time_and_zone(rest: &str) -> Option<String> {
    let words: Vec<&str> = rest
        .split(char::is_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    if words.is_empty() {
        return None;
    }
    let mut end = words.len();
    if words[end - 1].starts_with('(') && words[end - 1].ends_with(')') && words[end - 1].len() > 2
    {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut zone = String::new();
    if end >= 2 {
        if let Some(suffix) = month_zone_suffix(words[end - 1]) {
            if words[end - 2].contains(':') {
                zone = suffix;
                end -= 1;
            }
        }
    }
    if end != 1 {
        return None;
    }
    Some(format!("{}{zone}", words[0]))
}

fn slash_clock(time: &str) -> Option<String> {
    let (body, zone) = if let Some(clock) = time.strip_suffix(['Z', 'z']) {
        (clock, &time[clock.len()..])
    } else if let Some(sign_at) = time.rfind(['+', '-']) {
        if sign_at == 0 {
            return None;
        }
        (&time[..sign_at], &time[sign_at..])
    } else {
        (time, "")
    };
    let (clock, fraction) = match body.split_once('.') {
        Some((clock, fraction))
            if !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (clock, Some(fraction))
        }
        None => (body, None),
        Some(_) => return None,
    };
    let mut numbers = Vec::new();
    for part in clock.split(':') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        numbers.push(part.parse::<u32>().ok()?);
    }
    if !(2..=3).contains(&numbers.len()) || numbers.iter().any(|number| *number > 99) {
        return None;
    }
    let mut padded = if numbers.len() == 3 {
        format!("{:02}:{:02}:{:02}", numbers[0], numbers[1], numbers[2])
    } else {
        format!("{:02}:{:02}:00", numbers[0], numbers[1])
    };
    if let Some(fraction) = fraction {
        padded.push('.');
        padded.push_str(fraction);
    }
    padded.push_str(zone);
    Some(padded)
}

struct MonthTime {
    slots: [i32; 4],
    index: usize,
}

impl MonthTime {
    fn new() -> Self {
        Self {
            slots: [0; 4],
            index: 0,
        }
    }

    /// The next field must be a minute, second, or millisecond in range.
    /// `60` does not qualify, so it falls through to the date numbers.
    fn expecting(&self, number: i32) -> bool {
        match self.index {
            1 => (0..=59).contains(&number),
            2 => (0..=59).contains(&number),
            3 => (0..=999).contains(&number),
            _ => false,
        }
    }

    fn add(&mut self, number: i32) -> Option<()> {
        if self.index >= 4 {
            return None;
        }
        self.slots[self.index] = number;
        self.index += 1;
        Some(())
    }

    fn add_final(&mut self, number: i32) -> Option<()> {
        self.add(number)?;
        while self.index < 4 {
            self.slots[self.index] = 0;
            self.index += 1;
        }
        Some(())
    }
}

fn compose_month_date(
    words: &[&str],
    numeric: bool,
) -> Option<(i32, i32, i32, String, Option<i64>)> {
    let mut month = None;
    let mut dates = Vec::new();
    let mut time = MonthTime::new();
    let mut offset = None;
    let mut hour_offset = None;
    let mut number_seen = false;
    for (index, word) in words.iter().copied().enumerate() {
        if word.is_empty() {
            if number_seen {
                return None;
            }
            continue;
        }
        if glued_non_month(word) {
            return None;
        }
        if let Some(found) = english_month(word) {
            month = Some(found);
            continue;
        }
        if is_weekday_name(word) {
            if number_seen {
                return None;
            }
            continue;
        }
        if month_zone_suffix(word).is_some() {
            // `GMT5` before any number is not a date. `GMT 5` ignores `GMT`.
            if !number_seen {
                if words
                    .get(index + 1)
                    .copied()
                    .is_some_and(|next| digits_follow_zone(word, next))
                {
                    return None;
                }
                continue;
            }
            offset = Some(suffix_east_minutes(&month_zone_suffix(word)?)?);
            continue;
        }
        if word.contains(':') && word.starts_with(|character: char| character.is_ascii_digit()) {
            take_month_clock(word, &mut time, &mut dates, &mut offset)?;
            number_seen = true;
            continue;
        }
        // `+5` after a clock, or after `GMT`, is a fixed offset. `+5` with no
        // clock is not. A later `EST` replaces it.
        if word.starts_with(['+', '-'])
            && word.len() > 1
            && (time.index > 0 || offset == Some(0))
        {
            let (minutes, spilled) = parse_legacy_offset(word)?;
            for number in spilled {
                push_date_number(&mut dates, number)?;
            }
            offset = Some(minutes);
            number_seen = true;
            continue;
        }
        if word.eq_ignore_ascii_case("am") || word.eq_ignore_ascii_case("pm") {
            if time.index == 0 {
                if number_seen {
                    return None;
                }
                // `PM5` before a clock is not a date. `PM 5` ignores `PM`.
                if words
                    .get(index + 1)
                    .copied()
                    .is_some_and(|next| digits_follow_zone(word, next))
                {
                    return None;
                }
                continue;
            }
            if hour_offset.is_some() {
                return None;
            }
            hour_offset = Some(if word.eq_ignore_ascii_case("pm") { 12 } else { 0 });
            continue;
        }
        if let Some((number, signed)) = date_number_word(word) {
            if signed && number_seen {
                return None;
            }
            if !signed && time.expecting(number) {
                time.add_final(number)?;
            } else {
                push_date_number(&mut dates, number)?;
            }
            number_seen = true;
            continue;
        }
        if number_seen {
            return None;
        }
    }
    if dates.is_empty() {
        return None;
    }
    // A named month uses the first two numbers. The third is ignored.
    // With no month name, one to three numbers are month-day-year unless the
    // first number cannot be a day, in which case they are year-month-day.
    // A missing field is 1, so `5` is 1 May 2001 and `2026` is 1 January.
    let (month, day, year) = if let Some(month) = month {
        let first = dates[0];
        let second = dates.get(1).copied().unwrap_or(1);
        let (day, year) = if (1..=31).contains(&first) {
            (first, legacy_year_number(second)?)
        } else {
            (second, legacy_year_number(first)?)
        };
        if !(1..=31).contains(&day) {
            return None;
        }
        (month, day, year)
    } else if numeric {
        numeric_month_day_year(&dates)?
    } else {
        return None;
    };
    Some((
        month,
        day,
        year,
        finish_month_time(&time, hour_offset)?,
        offset,
    ))
}

/// No month name. `10 13 2026` is month, day, year. `2026 10 13` is
/// year, month, day. A missing field is 1.
fn numeric_month_day_year(dates: &[i32]) -> Option<(i32, i32, i32)> {
    let first = dates[0];
    let second = dates.get(1).copied().unwrap_or(1);
    let third = dates.get(2).copied().unwrap_or(1);
    let (year, month, day) = if !(1..=31).contains(&first) {
        (legacy_year_number(first)?, second, third)
    } else {
        (legacy_year_number(third)?, first, second)
    };
    if !(1..=12).contains(&month) || day < 1 {
        return None;
    }
    Some((month, day, year))
}

/// `+2026` before the first number is 2026. After a number, the sign is not
/// part of a date field.
fn date_number_word(word: &str) -> Option<(i32, bool)> {
    if let Some(number) = unsigned_number(word) {
        return Some((number, false));
    }
    if word.starts_with(['+', '-']) {
        return Some((signed_number(word)?, true));
    }
    None
}

fn push_date_number(dates: &mut Vec<i32>, number: i32) -> Option<()> {
    if dates.len() >= 3 {
        return None;
    }
    dates.push(number);
    Some(())
}

fn take_month_clock(
    word: &str,
    time: &mut MonthTime,
    dates: &mut Vec<i32>,
    offset: &mut Option<i64>,
) -> Option<()> {
    let (body, embedded) = split_clock_tail(word);
    if !embedded.is_empty() {
        if embedded.eq_ignore_ascii_case("Z") {
            *offset = Some(0);
        } else {
            let (minutes, spilled) = parse_legacy_offset(embedded)?;
            for number in spilled {
                push_date_number(dates, number)?;
            }
            *offset = Some(minutes);
        }
    }
    let bytes = body.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let (number, _length, next) = read_clock_number(bytes, index)?;
        index = next;
        if index < bytes.len() && bytes[index] == b':' {
            index += 1;
            if index < bytes.len() && bytes[index] == b':' {
                // `16::30` is 16:00:30. A second `::` is not a time.
                if time.index != 0 {
                    return None;
                }
                time.add(number)?;
                time.add(0)?;
                index += 1;
                continue;
            }
            time.add(number)?;
            // `16:00:.5` ignores the dot and reads 5 as the next field.
            if index < bytes.len() && bytes[index] == b'.' {
                index += 1;
            }
            continue;
        }
        if index < bytes.len() && bytes[index] == b'.' && time.expecting(number) {
            index += 1;
            time.add(number)?;
            let (fraction, length, next) = read_clock_number(bytes, index)?;
            index = next;
            time.add_final(clock_milliseconds(fraction, length))?;
            if index != bytes.len() && !consume_glued_z(bytes, index, dates, offset)? {
                return None;
            }
            break;
        }
        if time.expecting(number) {
            time.add_final(number)?;
            if index != bytes.len() && !consume_glued_z(bytes, index, dates, offset)? {
                return None;
            }
            break;
        }
        // `60` is not a second or a minute. It is a date number, and a dot
        // after it does not make the following digits milliseconds.
        push_date_number(dates, number)?;
        if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
            continue;
        }
        if index != bytes.len() {
            return None;
        }
        break;
    }
    Some(())
}

/// `16:00Z` and `16:00Z5`. `16:00EST` is not a date: only `Z` may touch a
/// finished clock.
fn consume_glued_z(
    bytes: &[u8],
    index: usize,
    dates: &mut Vec<i32>,
    offset: &mut Option<i64>,
) -> Option<bool> {
    if index >= bytes.len() || !bytes[index].eq_ignore_ascii_case(&b'z') {
        return Some(false);
    }
    let next = index + 1;
    *offset = Some(0);
    if next == bytes.len() {
        return Some(true);
    }
    if !bytes[next].is_ascii_digit() {
        return None;
    }
    let (number, _, end) = read_clock_number(bytes, next)?;
    if end != bytes.len() {
        return None;
    }
    push_date_number(dates, number)?;
    Some(true)
}

fn split_clock_tail(token: &str) -> (&str, &str) {
    if let Some(body) = token.strip_suffix(['Z', 'z']) {
        if body.contains(':') {
            return (body, &token[body.len()..]);
        }
    }
    if let Some(sign_at) = token.rfind(['+', '-']) {
        if sign_at > 0 && token[..sign_at].contains(':') {
            return token.split_at(sign_at);
        }
    }
    (token, "")
}

/// `+5`, `+0530`, `+5:30`, and `+5:60`. Minutes past 59 in `HHMM` count as
/// extra hours. A minute after `:` that is past 59 is a date number instead,
/// and the offset minute stays 0. `+5:30:00` is not an offset.
fn parse_legacy_offset(text: &str) -> Option<(i64, Vec<i32>)> {
    let (sign, rest) = if let Some(rest) = text.strip_prefix('+') {
        (1i64, rest)
    } else if let Some(rest) = text.strip_prefix('-') {
        (-1i64, rest)
    } else {
        return None;
    };
    if rest.is_empty() {
        return None;
    }
    let bytes = rest.as_bytes();
    let (value, length, next) = read_clock_number(bytes, 0)?;
    let tail = &rest[next..];
    let (hour, minute, spilled) = if tail.is_empty() {
        match length {
            1 | 2 => (i64::from(value), 0i64, Vec::new()),
            3 | 4 => (i64::from(value / 100), i64::from(value % 100), Vec::new()),
            _ => return None,
        }
    } else if let Some(after) = tail.strip_prefix(':') {
        if after.is_empty() {
            (i64::from(value), 0, Vec::new())
        } else {
            let (minute_value, _minute_length, minute_next) =
                read_clock_number(after.as_bytes(), 0)?;
            if minute_next != after.len() {
                return None;
            }
            if (0..=59).contains(&minute_value) {
                (i64::from(value), i64::from(minute_value), Vec::new())
            } else {
                (i64::from(value), 0, vec![minute_value])
            }
        }
    } else {
        return None;
    };
    Some((sign * (hour * 60 + minute), spilled))
}

fn suffix_east_minutes(suffix: &str) -> Option<i64> {
    if suffix.eq_ignore_ascii_case("Z") {
        return Some(0);
    }
    let (sign, rest) = if let Some(rest) = suffix.strip_prefix('+') {
        (1i64, rest)
    } else if let Some(rest) = suffix.strip_prefix('-') {
        (-1i64, rest)
    } else {
        return None;
    };
    let (hour, minute) = rest.split_once(':')?;
    let hour: i64 = hour.parse().ok()?;
    let minute: i64 = minute.parse().ok()?;
    Some(sign * (hour * 60 + minute))
}

/// A legacy offset can be more than 23 hours. Whole days move to the date so
/// the remaining `±HH:MM` is a normal zone.
fn fold_offset_days(mut east_minutes: i64) -> Option<(i32, String)> {
    let day = 24 * 60;
    let mut day_delta = 0i64;
    if east_minutes >= day {
        let days = east_minutes / day;
        east_minutes -= days * day;
        day_delta -= days;
    } else if east_minutes <= -day {
        let days = (-east_minutes) / day;
        east_minutes += days * day;
        day_delta += days;
    }
    let day_delta = i32::try_from(day_delta).ok()?;
    if east_minutes == 0 {
        return Some((day_delta, "Z".to_string()));
    }
    let sign = if east_minutes < 0 { '-' } else { '+' };
    let abs = east_minutes.abs();
    Some((
        day_delta,
        format!("{sign}{:02}:{:02}", abs / 60, abs % 60),
    ))
}

fn shift_ymd(year: i32, month: i32, day: i32, delta: i32) -> Option<(i32, i32, i32)> {
    if delta == 0 {
        return Some((year, month, day));
    }
    let days = days_from_civil(year, month as u32, day as u32)?;
    civil_from_days(days + i64::from(delta))
}

/// `2026-10-13 16:00 +5` is a fixed offset. The result is an ISO time.
fn fold_spaced_numeric_offset(trimmed: &str) -> Option<String> {
    let words: Vec<&str> = trimmed
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    if words.len() != 3 || !words[1].contains(':') {
        return None;
    }
    let (minutes, spilled) = parse_legacy_offset(words[2])?;
    if !spilled.is_empty() {
        return None;
    }
    let clock = slash_clock(words[1])?;
    let (delta, suffix) = fold_offset_days(minutes)?;
    let date = shift_hyphen_date(words[0], delta)?;
    Some(format!("{date}T{clock}{suffix}"))
}

fn shift_hyphen_date(date: &str, delta: i32) -> Option<String> {
    if delta == 0 {
        return Some(date.to_string());
    }
    let mut parts = date.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: i32 = parts.next()?.parse().ok()?;
    let day: i32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let (year, month, day) = shift_ymd(year, month, day, delta)?;
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// Leading zeros count in the length and not in the value. Nine significant
/// digits are kept.
fn read_clock_number(bytes: &[u8], start: usize) -> Option<(i32, usize, usize)> {
    if start >= bytes.len() || !bytes[start].is_ascii_digit() {
        return None;
    }
    let mut index = start;
    while index < bytes.len() && bytes[index] == b'0' {
        index += 1;
    }
    let mut value = 0i32;
    let mut significant = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        if significant < 9 {
            value = value * 10 + i32::from(bytes[index] - b'0');
        }
        significant += 1;
        index += 1;
    }
    Some((value, index - start, index))
}

fn clock_milliseconds(number: i32, mut length: usize) -> i32 {
    if length < 3 {
        return if length == 1 {
            number * 100
        } else if length == 2 {
            number * 10
        } else {
            number
        };
    }
    if length > 9 {
        length = 9;
    }
    let mut factor = 1i32;
    while length > 3 {
        factor *= 10;
        length -= 1;
    }
    number / factor
}

fn finish_month_time(time: &MonthTime, hour_offset: Option<i32>) -> Option<String> {
    let mut slots = time.slots;
    let mut index = time.index;
    while index < 4 {
        slots[index] = 0;
        index += 1;
    }
    if let Some(offset) = hour_offset {
        let hour = slots[0];
        if !(0..=12).contains(&hour) {
            return None;
        }
        slots[0] = hour % 12 + offset;
    }
    let hour = slots[0];
    let minute = slots[1];
    let second = slots[2];
    let millis = slots[3];
    let midnight = hour == 24 && minute == 0 && second == 0 && millis == 0;
    if !(0..=23).contains(&hour) && !midnight {
        return None;
    }
    if !(0..=59).contains(&minute) || !(0..=59).contains(&second) || !(0..=999).contains(&millis) {
        return None;
    }
    if millis == 0 {
        Some(format!("{hour:02}:{minute:02}:{second:02}"))
    } else {
        Some(format!("{hour:02}:{minute:02}:{second:02}.{millis:03}"))
    }
}

fn month_zone_suffix(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    let hours: i32 = match lower.as_str() {
        "gmt" | "utc" | "ut" | "z" => return Some("Z".to_string()),
        "est" => -5,
        "edt" => -4,
        "cst" => -6,
        "cdt" => -5,
        "mst" => -7,
        "mdt" => -6,
        "pst" => -8,
        "pdt" => -7,
        _ => return month_gmt_suffix(&lower),
    };
    let sign = if hours < 0 { '-' } else { '+' };
    Some(format!("{sign}{:02}:00", hours.abs()))
}

fn month_gmt_suffix(lower: &str) -> Option<String> {
    let rest = if let Some(rest) = lower.strip_prefix("gmt") {
        rest
    } else if let Some(rest) = lower.strip_prefix("utc") {
        rest
    } else if let Some(rest) = lower.strip_prefix("ut") {
        rest
    } else {
        return None;
    };
    if rest.is_empty() {
        return Some("Z".to_string());
    }
    let (sign, body) = if let Some(body) = rest.strip_prefix('+') {
        ('+', body)
    } else if let Some(body) = rest.strip_prefix('-') {
        ('-', body)
    } else {
        return None;
    };
    let (hour, minute) = if let Some((hour, minute)) = body.split_once(':') {
        (hour.parse::<i32>().ok()?, minute.parse::<i32>().ok()?)
    } else if body.len() <= 2 && body.bytes().all(|byte| byte.is_ascii_digit()) {
        (body.parse().ok()?, 0)
    } else if body.len() == 4 && body.bytes().all(|byte| byte.is_ascii_digit()) {
        (body[..2].parse().ok()?, body[2..].parse().ok()?)
    } else {
        return None;
    };
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some(format!("{sign}{hour:02}:{minute:02}"))
}

/// A calendar date with no time: `YYYY`, `±YYYYYY`, or the same with a month and day.
fn is_date_only_shape(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let body = value.strip_prefix(['+', '-']).unwrap_or(value);
    !body
        .bytes()
        .any(|byte| matches!(byte, b'T' | b't' | b' ' | b'+'))
        && body.bytes().filter(|byte| *byte == b'-').count() <= 2
}

/// `YYYY` or `+YYYYYY` / `-YYYYYY`. `02026` and `+2026` are not this form.
fn iso_date_year(year: &str) -> bool {
    match year.as_bytes() {
        [b'0'..=b'9', b'0'..=b'9', b'0'..=b'9', b'0'..=b'9'] => true,
        [b'+' | b'-', rest @ ..] => rest.len() == 6 && rest.iter().all(|byte| byte.is_ascii_digit()),
        _ => false,
    }
}

/// A `.` before `HH:` is a space. A `.` between date fields is a hyphen.
/// A `.` after a colon, followed by digits, stays the fraction. Trailing
/// periods are dropped.
fn rewrite_periods(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '.' {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        let mut next = index;
        while next < chars.len() && chars[next] == '.' {
            next += 1;
        }
        let digits = chars[next..]
            .iter()
            .take_while(|character| character.is_ascii_digit())
            .count();
        let after_digits = chars.get(next + digits).copied();
        if digits > 0 && after_digits == Some(':') {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            index = next;
            continue;
        }
        if digits > 0
            && !out.contains(':')
            && after_digits.is_none_or(|character| matches!(character, '.' | '-' | ','))
        {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            index = next;
            continue;
        }
        if digits > 0 && out.contains(':') && next == index + 1 {
            out.push('.');
            index = next;
            continue;
        }
        // `p.m.` is not `pm`. Only a period at the end of the text is padding.
        if chars.get(next).is_some() {
            out.extend(chars[index..next].iter().copied());
        }
        index = next;
    }
    out
}

/// Turns commas into spaces and collapses repeated separators.
fn commas_to_spaces(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character == ',' || character == ' ' {
            if !out.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(character);
    }
    out
}

fn has_date_parse_padding(value: &str) -> bool {
    value.trim_matches(is_date_parse_space).len() != value.len()
}

/// `Date.parse` whitespace. U+2028 and U+2029 are not included.
fn is_date_parse_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn date_only_iso(value: &str, surrounded: bool) -> Option<String> {
    if !surrounded {
        if let Some(instant) = iso_hyphen_date(value) {
            return Some(instant);
        }
    }
    legacy_hyphen_date(value)
}

/// `YYYY` and `±YYYYYY`, with optional month and day. A short month or day is
/// local midnight. Any other shape returns `None` so the legacy order can run.
fn iso_hyphen_date(value: &str) -> Option<String> {
    let (year, month, day) = split_date_only(value)?;
    if !iso_date_year(year) {
        return None;
    }
    let year: i32 = year.parse().ok()?;
    let mut legacy_local = false;
    let (month, day) = match (month, day) {
        (None, _) => (1, 1),
        (Some(month), None) => {
            if month.is_empty() || !month.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            if month.len() != 2 {
                legacy_local = true;
            }
            let month: i32 = month.parse().ok()?;
            if !(1..=12).contains(&month) {
                return None;
            }
            (month, 1)
        }
        (Some(month), Some(day)) => {
            if month.is_empty()
                || day.is_empty()
                || !month.bytes().all(|byte| byte.is_ascii_digit())
                || !day.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            if month.len() != 2 || day.len() != 2 {
                legacy_local = true;
            }
            let month: i32 = month.parse().ok()?;
            let day: i32 = day.parse().ok()?;
            if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
                return None;
            }
            (month, day)
        }
    };
    let (year, month, day) = normalize_ymd(year, month, day)?;
    if legacy_local {
        let (year, month, day, hour, minute, second) =
            local_civil_to_utc(year, month, day, 0, 0, 0)?;
        return Some(format_civil_iso(year, month, day, hour, minute, second, 0));
    }
    Some(format_civil_iso(year, month, day, 0, 0, 0, 0))
}

/// A hyphen date that is not `YYYY` or `±YYYYYY`.
///
/// `2-1-1` is 1 February 2001. A month and day without a year use 2001.
/// A leading `+` or `-` is ignored. The result is local midnight.
fn legacy_hyphen_date(value: &str) -> Option<String> {
    let body = value.strip_prefix(['+', '-']).unwrap_or(value);
    if body.is_empty() {
        return None;
    }
    let fields: Vec<&str> = body.split('-').collect();
    if fields.is_empty()
        || fields.len() > 3
        || fields
            .iter()
            .any(|field| field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let numbers = fields
        .iter()
        .map(|field| field.parse::<i32>().ok())
        .collect::<Option<Vec<_>>>()?;
    let (year, month, day) = match numbers.as_slice() {
        // `5` is 1 May 2001. `13` is not a month, so it is not a date.
        // `32` and `0` are 1 January of that legacy year.
        [first] if (1..=31).contains(first) => (2001, *first, 1),
        [year] => (legacy_year_number(*year)?, 1, 1),
        [first, second] if (1..=12).contains(first) && (1..=31).contains(second) => {
            (2001, *first, *second)
        }
        [first, second] if *first == 0 || *first >= 32 => (legacy_year_number(*first)?, *second, 1),
        [first, second, third] if (1..=12).contains(first) => {
            (legacy_year_number(*third)?, *first, *second)
        }
        [first, second, third] if *first == 0 || *first >= 32 => {
            (legacy_year_number(*first)?, *second, *third)
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (year, month, day) = normalize_ymd(year, month, day)?;
    let (year, month, day, hour, minute, second) =
        local_civil_to_utc(year, month, day, 0, 0, 0)?;
    Some(format_civil_iso(year, month, day, hour, minute, second, 0))
}

/// `YYYY-MM-DD` or `±YYYYYY-MM-DD`, then optional month and day text.
///
/// A leading minus is the year sign, not a field separator. `-00001` is not
/// six digits, so it stays out of this form.
fn split_date_only(value: &str) -> Option<(&str, Option<&str>, Option<&str>)> {
    let expanded = value.starts_with(['+', '-'])
        && value[1..]
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
            == 6;
    let (year, rest) = if expanded {
        let year = &value[..7];
        match value[7..].strip_prefix('-') {
            None if value.len() == 7 => return Some((year, None, None)),
            None => return None,
            Some(rest) => (year, rest),
        }
    } else if let Some((year, rest)) = value.split_once('-') {
        (year, rest)
    } else {
        return Some((value, None, None));
    };
    if rest.is_empty() {
        return None;
    }
    if let Some((month, day)) = rest.split_once('-') {
        if day.is_empty() || day.contains('-') {
            return None;
        }
        Some((year, Some(month), Some(day)))
    } else {
        Some((year, Some(rest), None))
    }
}

fn format_civil_iso(
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millis: u32,
) -> String {
    let year_text = if (0..10_000).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!("{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// `YYYY`, `±YYYYYY`, then an optional two-digit month and day, then the clock.
///
/// A date-time month or day is two digits, so `2026-1T...` is not a time.
/// `02026-10-13T...` is not a year.
fn split_calendar(value: &str) -> Option<(i32, i32, i32, usize)> {
    let bytes = value.as_bytes();
    let (year, mut index) = if bytes.first().is_some_and(|byte| matches!(byte, b'+' | b'-')) {
        if bytes.len() < 8 || !bytes[1..7].iter().all(u8::is_ascii_digit) {
            return None;
        }
        (value[..7].parse().ok()?, 7)
    } else {
        if bytes.len() < 5 || !bytes[..4].iter().all(u8::is_ascii_digit) {
            return None;
        }
        (value[..4].parse().ok()?, 4)
    };
    if matches!(bytes.get(index), Some(b'T' | b't' | b' ')) {
        return Some((year, 1, 1, index + 1));
    }
    if bytes.get(index) != Some(&b'-')
        || bytes.len() < index + 4
        || !bytes[index + 1..index + 3].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let month: i32 = value[index + 1..index + 3].parse().ok()?;
    index += 3;
    if matches!(bytes.get(index), Some(b'T' | b't' | b' ')) {
        return Some((year, month, 1, index + 1));
    }
    if bytes.get(index) != Some(&b'-')
        || bytes.len() < index + 4
        || !bytes[index + 1..index + 3].iter().all(u8::is_ascii_digit)
        || !matches!(bytes.get(index + 3), Some(b'T' | b't' | b' '))
    {
        return None;
    }
    let day: i32 = value[index + 1..index + 3].parse().ok()?;
    Some((year, month, day, index + 4))
}

/// `HH:mm`, optional seconds, and an optional fraction. The remainder is the zone.
fn parse_clock(time: &str) -> Option<(i32, i32, i32, u32, &str)> {
    let bytes = time.as_bytes();
    if bytes.len() < 5 || bytes.get(2) != Some(&b':') {
        return None;
    }
    let hour: i32 = time.get(0..2)?.parse().ok()?;
    let minute: i32 = time.get(3..5)?.parse().ok()?;
    // `2026-01-02T03:04Z` has no seconds. A fraction there is not a time.
    let (second, mut index) = if bytes.get(5) == Some(&b':') {
        let second = time.get(6..8)?.parse().ok()?;
        (second, 8)
    } else if bytes.get(5) == Some(&b'.') {
        return None;
    } else {
        (0, 5)
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
        let digits = time.get(start..index)?;
        let taken = digits.chars().take(3).collect::<String>();
        let parsed: u32 = taken.parse().ok()?;
        millis = parsed * 10u32.pow((3 - taken.len()) as u32);
    }
    Some((hour, minute, second, millis, time.get(index..)?))
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
    if !(-999_999..=999_999).contains(&year) {
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
    let mut earliest = None;
    for isdst in [0, 1] {
        let Some(utc) = mktime_local(year, month, day, hour, minute, second, isdst) else {
            continue;
        };
        if local_civil_is(utc, year, month, day, hour, minute, second) {
            earliest = Some(earliest.map_or(utc, |current: i64| current.min(utc)));
        }
    }
    let utc = if let Some(utc) = earliest {
        utc
    } else {
        // No instant has this civil time. `mktime` with `tm_isdst == -1`
        // applies the offset from before the transition.
        mktime_local(year, month, day, hour, minute, second, -1)?
    };
    civil_from_unix(utc)
}

fn mktime_local(
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    isdst: i32,
) -> Option<i64> {
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    tm.tm_year = year - 1900;
    tm.tm_mon = month - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = minute;
    tm.tm_sec = second;
    tm.tm_isdst = isdst;
    let previous = std::io::Error::last_os_error();
    unsafe { *libc::__errno_location() = 0 };
    let result = unsafe { libc::mktime(&mut tm) };
    let failed = result == -1 && std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0;
    unsafe { *libc::__errno_location() = previous.raw_os_error().unwrap_or(0) };
    if failed { None } else { Some(result as i64) }
}

fn local_civil_is(
    utc: i64,
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
) -> bool {
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    let seconds = utc as libc::time_t;
    unsafe {
        if libc::localtime_r(&seconds, &mut tm).is_null() {
            return false;
        }
    }
    tm.tm_year == year - 1900
        && tm.tm_mon == month - 1
        && tm.tm_mday == day
        && tm.tm_hour == hour
        && tm.tm_min == minute
        && tm.tm_sec == second
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
            assert_eq!(super::canonical_iso("Oct 13 2026 16:60:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:60 61"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16:00:60.500"), None);
            assert_eq!(super::canonical_iso("Oct 2026 16:00:60"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 16 16:00:60"), None);
            assert_eq!(super::canonical_iso("Oct 13 16:00:2026 61 62"), None);
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
            assert_eq!(super::canonical_iso("Oct 13 2026 ) 16:00"), None);
            assert_eq!(super::canonical_iso("Oct 13 2026 )"), None);
            assert_eq!(super::canonical_iso("13 (Oct) 2026"), None);
            assert_eq!(super::canonical_iso("2026-10-13)"), None);
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
                super::canonical_iso("2026/10/13 16:00:00Z").as_deref(),
                Some("2026-10-13T16:00:00.000Z")
            );
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
}
