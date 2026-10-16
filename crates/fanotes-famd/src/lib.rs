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
/// `16:00,30` and `16:00!` are empty. The mark touches a finished clock field.
/// `16:,30` is 16:30, and `16:00:00.5!` keeps the fraction.
fn junk_glued_to_final_clock(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit()
            && (index == 0 || !matches!(bytes[index - 1], b'0'..=b'9' | b'+' | b'-'))
            && clock_ends_on_junk(bytes, index)
        {
            return true;
        }
        index += 1;
    }
    false
}

fn allowed_after_final_clock(bytes: &[u8], index: usize) -> bool {
    match bytes[index] {
        b'Z' | b'z' | b'+' | b'-' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ' => true,
        byte if byte.is_ascii() => false,
        _ => std::str::from_utf8(&bytes[index..])
            .ok()
            .and_then(|rest| rest.chars().next())
            .is_some_and(is_date_parse_space),
    }
}

fn clock_ends_on_junk(bytes: &[u8], start: usize) -> bool {
    let mut index = skip_clock_digits(bytes, start);
    if index >= bytes.len() || bytes[index] != b':' {
        return false;
    }
    let mut field = 1;
    loop {
        index += 1;
        if index < bytes.len() && bytes[index] == b':' {
            index += 1;
        }
        if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
        }
        if index >= bytes.len() || !bytes[index].is_ascii_digit() {
            return false;
        }
        let (value, end) = clock_field_value(bytes, index);
        index = end;
        // `60` is not a second, so `16:00:60.` keeps the dot. `00` is.
        let finishes = (1..=2).contains(&field) && (0..=59).contains(&value);
        field += 1;
        if index < bytes.len() && bytes[index] == b':' {
            continue;
        }
        if index < bytes.len() && bytes[index] == b'.' {
            let after = index + 1;
            // `16:00:00.5!` is a fraction. `16:00.` has no fraction digit.
            if after < bytes.len() && bytes[after].is_ascii_digit() {
                return false;
            }
            return finishes;
        }
        return finishes && index < bytes.len() && !allowed_after_final_clock(bytes, index);
    }
}

fn clock_field_value(bytes: &[u8], start: usize) -> (i32, usize) {
    let end = skip_clock_digits(bytes, start);
    let value = std::str::from_utf8(&bytes[start..end])
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(i32::MAX);
    (value, end)
}

fn skip_clock_digits(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    index
}

pub fn canonical_iso(value: &str) -> Option<String> {
    if let Some(end) = value.find('\0') {
        // A NUL ends the date string. `2026-10-13\016:00` is the UTC date,
        // and `\02026-10-13` is empty.
        return canonical_iso(&value[..end]);
    }
    if let Some(next) = tighten_slash_spaces(value) {
        // `2026/ 10/13` is the slash date. A space after a clock stays, so
        // `16:00 / 10/13/2026` does not become `16:00/10/13/2026`.
        return canonical_iso(&next);
    }
    if value.contains('(') {
        // `(comment)` is skipped, and an unclosed `(` consumes the rest.
        // The mark is a separator: `2026-10-13(EST)` stays local, while
        // `16:00(EST)` finalized the clock and is empty.
        if parenthetical_breaks_final_time(value) {
            return None;
        }
        let omitted = omit_parentheticals(value);
        if omitted != value {
            return canonical_iso(&omitted);
        }
    }
    if junk_glued_to_final_clock(value) {
        // `16:00,30` and `16:00!` finalized the clock. `16:00 ,30` has a
        // space first, and `16:00:00.5!` finalized through the fraction.
        // A clock inside `(...)` is a comment, so it is removed first.
        return None;
    }
    if let Some(next) = separate_slash_after_fraction(value) {
        // `16:00:00.5/1` keeps the fraction. The slash is only a separator.
        return canonical_iso(&next);
    }
    if let Some(next) = separate_dot_after_fraction(value) {
        // `16:00:00.5.1` keeps the fraction. The second dot starts a new field.
        return canonical_iso(&next);
    }
    if let Some(next) = separate_colon_after_word(value) {
        // `note: 10/13/2026` is the slash date. The colon is a separator, and
        // `note` is a garbage word. `note10/13/2026` has no separator.
        return canonical_iso(&next);
    }
    if let Some(next) = separate_finished_date_clock(value) {
        // `2026-10-13/16:00` and `2026-10-13:16:00` are 16:00 local.
        // `Oct 13 2026/16:00` uses the slash the same way. `10/13/2026` has
        // no clock, and a `T` form keeps its own separator.
        return canonical_iso(&next);
    }
    match rewrite_ignored_symbols(value) {
        SymbolRewrite::Illegal => return None,
        SymbolRewrite::Changed(next) => return canonical_iso(&next),
        SymbolRewrite::Same => {}
    }
    if let Some(next) = strip_leading_field_marks(value) {
        // `4: :5` is 4:05. `+5: :30` is +5:30. A colon or dot at the start
        // of a field is only a separator.
        return canonical_iso(&next);
    }
    if let Some(next) = join_open_clock_fields(value) {
        // `4: 5 PM` is `4:5 PM`. An open field takes the next number.
        return canonical_iso(&next);
    }
    if let Some(next) = separate_second_offset_sign(value) {
        // `+5-30` is `+5` and then `-30`. The later sign replaces the offset.
        return canonical_iso(&next);
    }
    // U+2028 and U+2029 are JavaScript trim characters, and `Date.parse` rejects
    // them. Only the date-parse spaces are padding.
    let trimmed = value.trim_matches(is_date_parse_space);
    // `-000000-10-13` drops the invalid negative zero once. The remainder is
    // legacy, so `-10-13` is 13 October 2001 and a second `-000000` is year 0.
    // `-000001-10-13 EST` stays in year -1. A leading space stays legacy.
    if !value.starts_with(is_date_parse_space) {
        if let Some(rest) = strip_negative_zero_year(trimmed) {
            if rest.is_empty() {
                return None;
            }
            return canonical_iso(&format!(" {rest}"));
        }
        if negative_expanded_bare_offset(trimmed) {
            return None;
        }
        if let Some(iso) = negative_expanded_zone_iso(trimmed) {
            return Some(iso);
        }
    }
    // `+002026-10-13 16:00` is local 16:00. The plus and six digits are the
    // numeric year, then the usual hyphen rules. A date with no clock stays UTC.
    if positive_expanded_bare_offset(trimmed) {
        return None;
    }
    if let Some(next) = rewrite_positive_expanded_clock(trimmed) {
        return canonical_iso(&next);
    }
    if let Some(rest) = strip_leading_signs(trimmed) {
        // Signs before the first number are padding. The space keeps a
        // date-only value local and rejects a `T` form.
        return canonical_iso(&format!(" {rest}"));
    }
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
                if let Some(iso) = date_only_iso(&normalized, true) {
                    return Some(iso);
                }
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
    if let Some(next) = separate_meridiem_offset(value) {
        // `PM+5` and `PM+5:30` are a meridiem and then an offset.
        return canonical_iso(&next);
    }
    match prefer_last_meridiem(trimmed) {
        // `4:00 PM AM` is 4:00. The later meridiem replaces the earlier one.
        // `2026-10-13 PM 4:00` is empty: the meridiem sits after a number.
        MeridiemPass::Illegal => return None,
        MeridiemPass::Changed(next) => return canonical_iso(&next),
        MeridiemPass::Same => {}
    }
    if has_ampm_word(trimmed) {
        // `4:00 PM` is 16:00. A `T` before AM/PM is NaN. `AM` before a date
        // is an ordinary word, so a clock that does not fold falls through.
        if has_iso_t(trimmed) {
            return None;
        }
        if let Some(normalized) = fold_ampm(trimmed) {
            // A leading space still chooses the legacy year. `4:00 PM` must
            // not drop it.
            return canonical_iso(&keep_leading_space(value, normalized));
        }
    }
    if !value.starts_with(is_date_parse_space) && finished_date_has_an_extra_hyphen(trimmed) {
        // `2026-10-13-` and `2026-10-13- January` already finished the strict
        // date. A leading space is legacy, so that hyphen is skipped.
        return None;
    }
    if has_english_month(trimmed) {
        let normalized = rewrite_month_name(trimmed)?;
        return canonical_iso(&normalized);
    }
    if trimmed.contains('/') {
        // `16:00: 10/13/2026` finalizes the second and then sees `/`.
        if open_clock_before_slash(trimmed) {
            return None;
        }
        // `2026/10/13` is local midnight. `10/13/2026` is the same day.
        // A slash that is not that date is ignored, so `/2026-10-13` is local.
        if let Some(normalized) = rewrite_slash_date(trimmed) {
            return canonical_iso(&normalized);
        }
        return canonical_iso(&trimmed.replace('/', " "));
    }
    if let Some(normalized) = fold_spaced_numeric_offset(trimmed) {
        // `2026-10-13 16:00 +5` is 16:00 at a fixed offset. A leading space
        // on a negative expanded year keeps the legacy 2013 reading, so the
        // offset stays a separate word.
        let legacy_negative_year = value.starts_with(is_date_parse_space)
            && trimmed
                .split(is_date_parse_space)
                .next()
                .is_some_and(|date| negative_expanded_ymd(date).is_some());
        if !legacy_negative_year {
            return canonical_iso(&normalized);
        }
    }
    if !has_iso_t(trimmed) {
        if let Some(normalized) = fold_trailing_zone(trimmed) {
            // `16:00 EST` is a fixed offset. `(EST)` is a comment, so the
            // clock stays local. A leading space on `-000001-10-13 16:00 GMT+5`
            // is the legacy 2013 date. Folding the zone would drop that space.
            let legacy_negative_year = value.starts_with(is_date_parse_space)
                && trimmed
                    .split(is_date_parse_space)
                    .next()
                    .is_some_and(|date| negative_expanded_ymd(date).is_some());
            if !legacy_negative_year {
                return canonical_iso(&keep_leading_space(value, normalized));
            }
        }
    }
    if let Some(iso) = trailing_hyphen_iso(trimmed) {
        // `2026-10-` stops before a strict ISO date, so that midnight is local.
        return Some(iso);
    }
    let surrounded = has_date_parse_padding(value);
    // A space around `T` is NaN. A space around `2026-10-13 16:00:00Z` is ignored.
    if surrounded && has_iso_t(trimmed) {
        return None;
    }
    let source = if surrounded { trimmed } else { value };
    if is_date_only_shape(trimmed) {
        // `2026-10-13` is UTC. `2026-10-13Z` is the same instant with a zone
        // glued on, so a failed date-only parse continues as a legacy number.
        // U+2028 and U+2029 are not date separators, so they stay empty.
        // `-000001-10-13 ` already read year -1. The trailing space makes
        // midnight local. A leading space is still the legacy 2013 date.
        if surrounded && !value.starts_with(is_date_parse_space) {
            if let Some((year, month, day)) = negative_expanded_ymd(trimmed) {
                let (year, month, day, hour, minute, second) =
                    local_civil_to_utc(year, month, day, 0, 0, 0)?;
                return format_civil_iso(year, month, day, hour, minute, second, 0);
            }
        }
        if let Some(iso) = date_only_iso(trimmed, surrounded) {
            return Some(iso);
        }
        if !trimmed
            .chars()
            .any(|character| matches!(character, '\u{0085}' | '\u{2028}' | '\u{2029}'))
        {
            return legacy_numeric_iso(trimmed);
        }
        return None;
    }
    // A leading space keeps `-000001-10-13 16:00` on the legacy path, which
    // reads 10 January 2013. A trailing space does not: the year was already
    // read, and the date stays in year -1.
    if value.starts_with(is_date_parse_space) {
        if let Some((year, _, _, _)) = split_calendar(trimmed) {
            if year < 0
                && trimmed.as_bytes().first() == Some(&b'-')
                && trimmed[1..]
                    .bytes()
                    .take_while(|byte| byte.is_ascii_digit())
                    .count()
                    == 6
            {
                return legacy_numeric_iso(trimmed);
            }
        }
    }
    // `2026 10 13` is not a year plus a clock. A tail with no colon is a legacy
    // number, such as `2026 10`. A clock that fails to parse is not an ISO time.
    let Some((year, month, day, time_at)) = split_calendar(source) else {
        return legacy_numeric_iso(trimmed);
    };
    // A finished `0000-01-01` is year 0. A space before the clock did not
    // finish that ES5 date, so the three numbers are read again. `0001-10-13`
    // is 10 January 2013, because 1 can be a day. `0000-01-01` is 1 January
    // 2000, because 0 cannot. A `T` form keeps the year it already read.
    let (year, month, day) = if !has_iso_t(source) && (1..=31).contains(&year) {
        (legacy_year_number(day)?, year, month)
    } else if !has_iso_t(source) && (0..=99).contains(&year) {
        (legacy_year_number(year)?, month, day)
    } else {
        (year, month, day)
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time_text = source.get(time_at..)?;
    let Some((mut hour, minute, second, millis, rest)) = parse_clock(time_text) else {
        // A `T` clock that is not a finished ES5 time is empty. `T16:00 EST`
        // does not fall through to the legacy parser. A space before the
        // clock is legacy: `16:` is 16:00, `4:5` is 4:05, and `16:.5` is 16:05.
        // `2026-10-13 16:00:60` is a broken clock. A negative expanded year
        // keeps that short clock; the legacy reread would turn it into 2013.
        if has_iso_t(source) {
            return None;
        }
        if let Some(iso) = negative_expanded_legacy_clock(source, year, month, day, time_text) {
            return Some(iso);
        }
        return legacy_numeric_iso(trimmed);
    };
    let (mut year, mut month, mut day) = normalize_ymd(year, month, day)?;
    if rest.contains(is_date_parse_space) {
        // `2026-10-13T16:00:00Z GMT+5` already read `T`, so the extra zone is
        // empty. `24:00 GMT-530` is still one clock. Rolling the day here and
        // again inside that clock would skip an extra day. `EST+5:30` on a
        // negative expanded year replaces the name and keeps that year.
        if has_iso_t(source) {
            return None;
        }
        if let Some(iso) = negative_expanded_legacy_clock(source, year, month, day, time_text) {
            return Some(iso);
        }
        return legacy_numeric_iso(trimmed);
    }
    if hour == 24 {
        // A `T` form rejects any later nonzero fraction digit. A space before
        // the clock uses the scaled milliseconds, so `.000000001` is still
        // zero and `.0001234567` is not.
        if minute != 0
            || second != 0
            || millis != 0
            || (has_iso_t(source) && iso_fraction_has_nonzero(time_text))
        {
            return None;
        }
        hour = 0;
        (year, month, day) = add_day(year, month, day);
    }
    let (year, month, day, hour, minute, second) = if rest.eq_ignore_ascii_case("Z") {
        (year, month, day, hour, minute, second)
    } else if rest.is_empty() {
        local_civil_to_utc(year, month, day, hour, minute, second)?
    } else if let Some(offset) = parse_offset(rest) {
        shift_seconds(year, month, day, hour, minute, second, -(offset as i64))?
    } else if !has_iso_t(source) {
        // `16:000` is 16:00. The extra digit is not an ISO zone.
        return legacy_numeric_iso(trimmed);
    } else {
        return None;
    };
    format_civil_iso(year, month, day, hour, minute, second, millis)
}

/// `16:` and `4:5` on `-000001-10-13` are local mean time in that year.
/// `16:00 EST+5:30` is 16:00 at UTC+5:30. Reading the hyphen date again as a
/// legacy number would make the year 2013.
fn negative_expanded_legacy_clock(
    source: &str,
    year: i32,
    month: i32,
    day: i32,
    time_text: &str,
) -> Option<String> {
    if year >= 0
        || source.as_bytes().first() != Some(&b'-')
        || source[1..]
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
            != 6
    {
        return None;
    }
    let words: Vec<&str> = time_text
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    let (clock, offset_minutes) = if words.len() >= 2 {
        // `16:00 GMT-530` is an offset. `16:00 GMT+5 EST` keeps the later zone.
        let clock = legacy_clock_text(words[0])?;
        if clock.contains(['+', '-', 'Z', 'z']) {
            return None;
        }
        let mut minutes = None;
        for zone in &words[1..] {
            minutes = Some(zone_offset_minutes(zone)?);
        }
        (clock, minutes)
    } else if let Some(clock) = words.first() {
        (legacy_clock_text(clock)?, None)
    } else {
        return None;
    };
    let (delta, suffix) = match offset_minutes {
        Some(minutes) => fold_offset_days(minutes)?,
        None => (0, String::new()),
    };
    let (year, month, day) = if delta == 0 {
        (year, month, day)
    } else {
        shift_ymd(year, month, day, delta)?
    };
    let date = format!("{}-{:02}-{:02}", legacy_iso_year(year), month, day);
    canonical_iso(&format!("{date}T{clock}{suffix}"))
}

fn has_english_month(value: &str) -> bool {
    month_words(value).iter().any(|word| english_month(word).is_some())
}

fn is_ampm_word(word: &str) -> bool {
    word.eq_ignore_ascii_case("am") || word.eq_ignore_ascii_case("pm")
}

enum MeridiemPass {
    Same,
    Illegal,
    Changed(String),
}

/// Keep the last meridiem that applies to a clock. A meridiem before any
/// number is ignored. A meridiem after a number and before the clock is empty.
fn prefer_last_meridiem(trimmed: &str) -> MeridiemPass {
    let words: Vec<&str> = trimmed
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    if words.iter().filter(|word| is_ampm_word(word)).count() < 2 {
        return MeridiemPass::Same;
    }
    let mut time_started = false;
    let mut number_seen = false;
    let mut last_meridiem = None;
    let mut kept = Vec::new();
    let mut clock_at = None;
    for word in words {
        if is_ampm_word(word) {
            if !time_started && number_seen {
                return MeridiemPass::Illegal;
            }
            if time_started {
                last_meridiem = Some(word);
            }
            continue;
        }
        if word.contains(':') && word.starts_with(|character: char| character.is_ascii_digit()) {
            time_started = true;
            clock_at = Some(kept.len());
            kept.push(word);
            continue;
        }
        if word.bytes().any(|byte| byte.is_ascii_digit()) {
            number_seen = true;
        }
        kept.push(word);
    }
    let Some(meridiem) = last_meridiem else {
        return MeridiemPass::Changed(kept.join(" "));
    };
    let Some(at) = clock_at else {
        return MeridiemPass::Illegal;
    };
    kept.insert(at + 1, meridiem);
    MeridiemPass::Changed(kept.join(" "))
}

/// `4:00 PM+5:30` is 16:00 at UTC+5:30. The sign starts the offset. `4:00PM+5`
/// stays one word, and `PMGMT` is not an offset.
fn separate_meridiem_offset(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len() + 1);
    let mut changed = false;
    let mut index = 0;
    while index < chars.len() {
        if meridiem_boundary(&chars, index)
            && index + 2 < chars.len()
            && matches!(chars[index + 2], '+' | '-')
        {
            out.push(chars[index]);
            out.push(chars[index + 1]);
            out.push(' ');
            changed = true;
            index += 2;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    if changed { Some(out) } else { None }
}

fn meridiem_boundary(chars: &[char], index: usize) -> bool {
    if index + 1 >= chars.len() {
        return false;
    }
    let first = chars[index].to_ascii_lowercase();
    let second = chars[index + 1].to_ascii_lowercase();
    if !matches!((first, second), ('a', 'm') | ('p', 'm')) {
        return false;
    }
    index == 0 || !chars[index - 1].is_ascii_alphanumeric()
}

fn has_ampm_word(value: &str) -> bool {
    value
        .split(is_date_parse_space)
        .any(|word| word.eq_ignore_ascii_case("am") || word.eq_ignore_ascii_case("pm"))
}

/// `-000000-10-13` drops the invalid negative zero. The rest is the date.
fn keep_leading_space(value: &str, normalized: String) -> String {
    if value.starts_with(is_date_parse_space) {
        format!(" {normalized}")
    } else {
        normalized
    }
}

fn strip_negative_zero_year(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix("-000000")?;
    if rest.starts_with(|character: char| character.is_ascii_digit()) {
        return None;
    }
    Some(rest.trim_start_matches(is_date_parse_space))
}

fn negative_expanded_ymd(date: &str) -> Option<(i32, i32, i32)> {
    let bytes = date.as_bytes();
    if bytes.first() != Some(&b'-') || bytes.len() < 7 {
        return None;
    }
    if !bytes[1..7].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let year: i32 = date[..7].parse().ok()?;
    if year >= 0 {
        return None;
    }
    let rest = &date[7..];
    if rest.is_empty() {
        return Some((year, 1, 1));
    }
    let rest = rest.strip_prefix('-')?;
    let (month, day) = if let Some((month, day)) = rest.split_once('-') {
        if day.contains('-') {
            return None;
        }
        (month, day)
    } else {
        (rest, "01")
    };
    let two = |text: &str| text.len() == 2 && text.bytes().all(|byte| byte.is_ascii_digit());
    if !two(month) || !two(day) {
        return None;
    }
    let month: i32 = month.parse().ok()?;
    let day: i32 = day.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

/// `+5` and `EST+5` after a negative expanded year are empty. A clock is not.
fn negative_expanded_bare_offset(trimmed: &str) -> bool {
    let Some((date, time)) = trimmed.split_once(is_date_parse_space) else {
        return false;
    };
    let time = time.trim_start_matches(is_date_parse_space);
    if time.is_empty() || negative_expanded_ymd(date).is_none() {
        return false;
    }
    let Some(first) = time.split(is_date_parse_space).find(|word| !word.is_empty()) else {
        return false;
    };
    if first.starts_with(|character: char| character.is_ascii_digit()) {
        return false;
    }
    signed_offset_word(first)
}

fn negative_expanded_zone_iso(trimmed: &str) -> Option<String> {
    let (date, zone) = trimmed.split_once(is_date_parse_space)?;
    let words: Vec<&str> = zone
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    if words.is_empty()
        || words
            .iter()
            .any(|word| word.starts_with(|character: char| character.is_ascii_digit()))
    {
        return None;
    }
    let (year, month, day) = negative_expanded_ymd(date)?;
    // `EST GMT+5` keeps the later zone. Every word has to be a zone.
    let mut minutes = None;
    for word in words {
        minutes = Some(zone_offset_minutes(word)?);
    }
    let (delta, suffix) = fold_offset_days(minutes?)?;
    let (year, month, day) = shift_ymd(year, month, day, delta)?;
    canonical_iso(&format!(
        "{}-{:02}-{:02}T00:00:00{suffix}",
        legacy_iso_year(year),
        month,
        day
    ))
}

/// `EST`, `GMT-530`, `EST+5:30`, and `+5`. A spilled field is not an offset.
fn zone_offset_minutes(word: &str) -> Option<i64> {
    let parsed = if let Some(tail) = named_zone_offset_tail(word) {
        parse_legacy_offset(tail)?
    } else {
        legacy_zone_offset(word).or_else(|| parse_legacy_offset(word))?
    };
    if !parsed.spilled.is_empty() || !parsed.time_fields.is_empty() || parsed.minute_sign != 0 {
        return None;
    }
    Some(parsed.minutes)
}

fn positive_expanded_bare_offset(trimmed: &str) -> bool {
    let Some((date, time)) = trimmed.split_once(is_date_parse_space) else {
        return false;
    };
    let time = time.trim_start_matches(is_date_parse_space);
    if time.is_empty() {
        return false;
    }
    let Some(rest) = date.strip_prefix('+') else {
        return false;
    };
    if rest.len() < 6 || !rest.as_bytes()[..6].iter().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    if !expanded_year_tail(&rest[6..]) {
        return false;
    }
    let Some(first) = time.split(is_date_parse_space).find(|word| !word.is_empty()) else {
        return false;
    };
    first.starts_with(['+', '-']) || (named_zone_offset_tail(first).is_some() && !utc_zone_word(first))
}

fn rewrite_positive_expanded_clock(trimmed: &str) -> Option<String> {
    let (date, time) = trimmed.split_once(is_date_parse_space)?;
    let time = time.trim_start_matches(is_date_parse_space);
    if time.is_empty() {
        return None;
    }
    let first = time.split(is_date_parse_space).find(|word| !word.is_empty())?;
    // `+002026-10-13 +5` is empty. `EST+5` is empty. `EST` and `GMT+5` stay.
    if first.starts_with(['+', '-']) || (named_zone_offset_tail(first).is_some() && !utc_zone_word(first))
    {
        return None;
    }
    let rest = date.strip_prefix('+')?;
    if rest.len() < 6 || !rest.as_bytes()[..6].iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year: i32 = rest[..6].parse().ok()?;
    let tail = &rest[6..];
    if !expanded_year_tail(tail) {
        return None;
    }
    Some(format!("{year}{tail} {time}"))
}

fn expanded_year_tail(tail: &str) -> bool {
    if tail.is_empty() {
        return true;
    }
    let Some(body) = tail.strip_prefix('-') else {
        return false;
    };
    let two = |text: &str| text.len() == 2 && text.bytes().all(|byte| byte.is_ascii_digit());
    let parts: Vec<&str> = body.split('-').collect();
    match parts.as_slice() {
        [month] => two(month),
        [month, day] => two(month) && two(day),
        _ => false,
    }
}

fn has_iso_t(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.windows(3).any(|window| {
        window[0].is_ascii_digit()
            && (window[1] == b'T' || window[1] == b't')
            && window[2].is_ascii_digit()
    })
}

/// True when a `T` clock fraction contains any nonzero digit, including one
/// past the first three milliseconds.
fn iso_fraction_has_nonzero(time: &str) -> bool {
    let Some((_, fraction)) = time.split_once('.') else {
        return false;
    };
    fraction
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .any(|byte| byte != b'0')
}

/// `4:00 PM` becomes `16:00`. `12:00 AM` and `0:00 AM` become `00:00`.
fn fold_ampm(trimmed: &str) -> Option<String> {
    let words: Vec<&str> = trimmed
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    let ampm_at = words.iter().position(|word| {
        word.eq_ignore_ascii_case("am") || word.eq_ignore_ascii_case("pm")
    })?;
    if ampm_at == 0 {
        return None;
    }
    // `13:Oct:2026 4:00 PM` already has a clock. Folding `4:00 PM` into
    // `16:00` would fill the open minute. The second clock is empty.
    if words[..ampm_at - 1].iter().any(|word| {
        word.contains(':') && word.starts_with(|character: char| character.is_ascii_digit())
    }) {
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
    if hour_text.is_empty() || !hour_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if rest.is_empty() {
        // `4: PM` is 16:00. The missing minute is zero.
        return legacy_meridiem_clock(clock, pm);
    }
    let hour = ampm_hour(hour_text.parse().ok()?, pm)?;
    Some(format!("{hour:02}:{rest}"))
}

fn legacy_meridiem_clock(clock: &str, pm: bool) -> Option<String> {
    let mut time = MonthTime::new();
    let mut dates = Vec::new();
    let mut offset = None;
    let mut minute_sign = 0i64;
    let mut glued_meridiem = None;
    take_month_clock(
        clock,
        &mut time,
        &mut dates,
        &mut offset,
        &mut minute_sign,
        &mut glued_meridiem,
    )?;
    if time.index == 0 || !dates.is_empty() || offset.is_some() || minute_sign != 0 {
        return None;
    }
    finish_month_time(
        &time,
        Some(glued_meridiem.unwrap_or(if pm { 12 } else { 0 })),
    )
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
        .split(is_date_parse_space)
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
    // `16:00 EST` is a clock. `16:00+5 EST` already names an offset, so the
    // later zone replaces it instead of being glued onto the number.
    // `GMT+24:00 EST` is two zones; the colon belongs to the offset.
    if end >= 2
        && words[end - 2].starts_with(|character: char| character.is_ascii_digit())
        && words[end - 2].contains(':')
        && !words[end - 2].contains(['+', '-'])
    {
        if let Some(suffix) = month_zone_suffix(words[end - 1]) {
            // `16:00Z GMT` replaces `Z`. Gluing another `Z` would make `16:00ZZ`.
            let clock_body = words[end - 2]
                .strip_suffix(['Z', 'z'])
                .filter(|body| !body.ends_with(['Z', 'z']))
                .unwrap_or(words[end - 2]);
            let clock = format!("{clock_body}{suffix}");
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

/// `2026.` loses a padding dot. `2026.5.` keeps the last dot so a fraction
/// with no digits stays empty.
fn trim_date_token(token: &str) -> &str {
    let trimmed = token.trim_matches('.');
    if token.ends_with('.') && trimmed.contains('.') {
        token.trim_start_matches('.')
    } else {
        trimmed
    }
}

fn month_words(value: &str) -> Vec<&str> {
    let raw: Vec<&str> = value
        .split(is_date_parse_space)
        .flat_map(|piece| piece.split(','))
        .map(trim_date_token)
        .filter(|token| !token.is_empty())
        .collect();
    let mut words = Vec::new();
    let mut open_clock = false;
    for token in raw {
        // `16:00: 2026-10-13` keeps the hyphen word. The 10 is seconds and
        // `-13` is the offset. Splitting it first would lose that sign.
        if open_clock && is_hyphen_number_run(token) {
            words.push(token);
            open_clock = false;
            continue;
        }
        words.extend(
            expand_joined_month(token)
                .into_iter()
                .flat_map(expand_glued_month)
                .flat_map(expand_hyphen_numbers)
                .flat_map(split_unmatched_paren),
        );
        if token_is_open_clock(token) {
            open_clock = true;
        } else if token.chars().any(|character| character.is_ascii_digit()) {
            open_clock = false;
        }
    }
    words
}

/// `16:00: 10/13/2026` is empty. The slash follows a finished field.
fn open_clock_before_slash(value: &str) -> bool {
    let mut open = false;
    for token in value
        .split(is_date_parse_space)
        .filter(|token| !token.is_empty())
    {
        if open && token.contains('/') {
            return true;
        }
        if token_is_open_clock(token) {
            open = true;
        } else if token.chars().any(|character| character.is_ascii_digit()) {
            open = false;
        }
    }
    false
}

/// `16:00:` still has an open second. `16:00` and `16:00:5` do not.
fn token_is_open_clock(token: &str) -> bool {
    token.ends_with(':')
        && token.starts_with(|character: char| character.is_ascii_digit())
        && token.contains(':')
}

/// `2026-10-13` and `2026-10+13` are digits separated by one sign at a time.
fn is_hyphen_number_run(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_digit() || !bytes[bytes.len() - 1].is_ascii_digit() {
        return false;
    }
    let mut saw_sign = false;
    let mut previous_sign = false;
    for byte in bytes {
        if byte.is_ascii_digit() {
            previous_sign = false;
            continue;
        }
        if matches!(*byte, b'+' | b'-') && !previous_sign {
            saw_sign = true;
            previous_sign = true;
            continue;
        }
        return false;
    }
    saw_sign && !previous_sign
}

/// `2026-10-13` next to `GMT` is three numbers and a zone. A month word such
/// as `13-Oct-26` stays one token for the month scan.
fn expand_hyphen_numbers(token: &str) -> Vec<&str> {
    if let Some(parts) = split_hyphen_zone(token) {
        return parts;
    }
    if let Some(parts) = split_number_before_clock(token) {
        return parts;
    }
    if token.contains(':') || !token.contains('-') {
        return vec![token];
    }
    // `-10-13` keeps its sign. After a number it is an extra sign. At the
    // start it is still 10 and 13, which the date composer decides.
    if token.starts_with(['+', '-']) && token[1..].contains('-') {
        return vec![token];
    }
    let body = token.strip_prefix('-').unwrap_or(token);
    if !body.contains('-') && !body.ends_with('-') {
        return vec![token];
    }
    let mut parts: Vec<&str> = body.split('-').collect();
    // `10-13-` is 10 and 13. `10-13--` and `10--13` are not dates.
    let trailing = parts.last() == Some(&"");
    if trailing {
        parts.pop();
    }
    if parts.is_empty()
        || parts.iter().any(|part| unsigned_number(part).is_none())
        || (parts.len() < 2 && !trailing)
    {
        return vec![token];
    }
    parts
}

/// `13-5:30` is the day 13 and then 5:30. The hyphen is skipped.
fn split_number_before_clock(token: &str) -> Option<Vec<&str>> {
    let bytes = token.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == 0 || bytes.get(index) != Some(&b'-') {
        return None;
    }
    let clock = &token[index + 1..];
    let clock_bytes = clock.as_bytes();
    let mut digit = 0;
    while digit < clock_bytes.len() && clock_bytes[digit].is_ascii_digit() {
        digit += 1;
    }
    if digit == 0 || clock_bytes.get(digit) != Some(&b':') {
        return None;
    }
    Some(vec![&token[..index], clock])
}

/// `2026-10-13-EST` is the date and then `EST`. The hyphen is skipped.
fn split_hyphen_zone(token: &str) -> Option<Vec<&str>> {
    let (body, zone) = token.rsplit_once('-')?;
    if !exact_zone_keyword(zone) || !body.contains('-') || body.ends_with('-') {
        return None;
    }
    let mut parts: Vec<&str> = body.split('-').collect();
    if parts.len() < 2 || parts.iter().any(|part| unsigned_number(part).is_none()) {
        return None;
    }
    parts.push(&token[token.len() - zone.len()..]);
    Some(parts)
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
            // `4:00 PM)` and `16:00Z)` already read a number. The `)` does
            // not have to touch that digit. `Oct) 13` has no digit yet.
            if chars[..index].iter().any(|item| item.is_ascii_digit()) {
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

fn push_separator(out: &mut String) {
    if !out.ends_with(is_date_parse_space) {
        out.push(' ');
    }
}

/// `16:00:00.5` is a fraction: the dot follows a clock field. `Oct.13` is a
/// month and a symbol, so those digits are not milliseconds.
fn fraction_digits_before(chars: &[char], index: usize) -> bool {
    let mut digit = index;
    while digit > 0 && chars[digit - 1].is_ascii_digit() {
        digit -= 1;
    }
    if digit < 2 || digit == index || chars[digit - 1] != '.' {
        return false;
    }
    // `16:00:00.5.1` is a real fraction: digits, dot, digits, then another dot.
    // `16:.5.5` is not. The first dot only opens the field.
    chars[digit - 2].is_ascii_digit()
}

fn separate_slash_after_fraction(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut changed = false;
    let mut out = String::with_capacity(value.len());
    for (index, character) in chars.iter().copied().enumerate() {
        if character == '/' && clock_fraction_dot(&chars, index) {
            out.push(' ');
            changed = true;
        } else {
            out.push(character);
        }
    }
    if changed { Some(out) } else { None }
}

/// A slash or colon between a finished date and a clock is only a separator.
///
/// `2026-10-13/16:00`, `2026-10-13:16:00`, and `Oct 13 2026/16:00` are 16:00
/// local. `10/13/2026` has no clock. `Oct 13 2026:16:00` is not a date: a
/// colon after a month name does not separate the clock.
fn separate_finished_date_clock(value: &str) -> Option<String> {
    if let Some(next) = separate_colon_after_hyphen_date(value) {
        return Some(next);
    }
    separate_slash_before_clock(value)
}

fn separate_colon_after_hyphen_date(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b':' {
            index += 1;
            continue;
        }
        let raw_prefix = &value[..index];
        let prefix = raw_prefix.trim_start_matches(is_date_parse_space);
        if prefix_is_strict_hyphen_date(prefix) {
            let suffix = value[index + 1..].trim_start_matches(is_date_parse_space);
            // `2026-10-13:` and `2026-10-13:EST` ignore the colon. A digit
            // there is another field, so `2026-10-13:16` stays empty.
            if !suffix_is_legacy_clock(suffix)
                && !suffix.starts_with(|character: char| character.is_ascii_digit())
            {
                let mut next = String::with_capacity(value.len() + 1);
                next.push_str(raw_prefix);
                next.push(' ');
                next.push_str(&value[index + 1..]);
                return Some(next);
            }
        }
        if prefix_is_strict_hyphen_date(prefix)
            && suffix_is_legacy_clock(value[index + 1..].trim_start_matches(is_date_parse_space))
        {
            // `2026-10-13:16:00` starts at the first character, so ES5 keeps
            // 13 October and reads 16:00. A leading space is legacy: 13 is the
            // hour. An expanded year keeps the ES5 split.
            let leading_space = raw_prefix.len() != prefix.len();
            let four_digit_year = prefix.as_bytes().first().is_some_and(u8::is_ascii_digit);
            if leading_space && four_digit_year {
                return legacy_hyphen_colon_time(prefix, &value[index + 1..]);
            }
            let mut next = String::with_capacity(value.len() + 1);
            next.push_str(raw_prefix);
            next.push(' ');
            next.push_str(&value[index + 1..]);
            return Some(next);
        }
        index += 1;
    }
    None
}

/// `note:10/13/2026` and `hello:Oct 13 2026`. A colon after a word is only a
/// separator. `16:00` and `16::30` follow a digit, so those colons stay.
/// `note10/13/2026` has no colon, and a word glued to a number stays empty.
fn separate_colon_after_word(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut changed = false;
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != ':' || !colon_follows_word(&chars, index) {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        push_separator(&mut out);
        changed = true;
        index += 1;
        while index < chars.len() && chars[index] == ':' {
            index += 1;
        }
    }
    if changed { Some(out) } else { None }
}

/// The nearest character that is not a space or a colon is a word character.
fn colon_follows_word(chars: &[char], index: usize) -> bool {
    let mut cursor = index;
    while cursor > 0 {
        cursor -= 1;
        if chars[cursor] == ':' || is_date_parse_space(chars[cursor]) {
            continue;
        }
        return is_v8_word_char(chars[cursor]);
    }
    false
}

/// ` 2026-10-13:16:00` is 13:16 on 1 October. The last hyphen field is the
/// hour because the colon is attached to it. ` 2026:16:00` has no date left.
fn legacy_hyphen_colon_time(prefix: &str, suffix: &str) -> Option<String> {
    let mut fields: Vec<&str> = prefix.split('-').collect();
    let hour = fields.pop()?;
    if fields.is_empty() || hour.is_empty() {
        return None;
    }
    let dates = fields
        .iter()
        .map(|field| field.parse::<i32>().ok())
        .collect::<Option<Vec<_>>>()?;
    let (month, day, year) = numeric_month_day_year(&dates)?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let clock = format!(
        "{hour}:{}",
        suffix.trim_start_matches(is_date_parse_space)
    );
    Some(format!(
        "{}-{month:02}-{day:02} {clock}",
        legacy_iso_year(year)
    ))
}

fn separate_slash_before_clock(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'/' {
            index += 1;
            continue;
        }
        if index > 0
            && bytes[index - 1].is_ascii_digit()
            && suffix_is_legacy_clock(value[index + 1..].trim_start_matches(is_date_parse_space))
        {
            let mut next = String::with_capacity(value.len() + 1);
            next.push_str(&value[..index]);
            next.push(' ');
            next.push_str(&value[index + 1..]);
            return Some(next);
        }
        index += 1;
    }
    None
}

/// `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or the same with `±YYYYYY`.
fn prefix_is_strict_hyphen_date(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = if matches!(bytes[0], b'+' | b'-') {
        if bytes.len() < 7 || !bytes[1..7].iter().all(u8::is_ascii_digit) {
            return false;
        }
        7
    } else if bytes.len() >= 4 && bytes[..4].iter().all(u8::is_ascii_digit) {
        4
    } else {
        return false;
    };
    let mut fields = 0;
    while index < bytes.len() {
        if bytes[index] != b'-' || fields == 2 {
            return false;
        }
        if index + 3 > bytes.len()
            || !bytes[index + 1].is_ascii_digit()
            || !bytes[index + 2].is_ascii_digit()
        {
            return false;
        }
        index += 3;
        fields += 1;
    }
    true
}

/// `16:00`, `4:5`, and `16:00 EST`. Another slash means this is not the clock.
/// `2026GMT+24:00` is a year glued to an offset: the colon comes after letters.
fn suffix_is_legacy_clock(suffix: &str) -> bool {
    if suffix.is_empty() || suffix.contains('/') {
        return false;
    }
    let first = suffix.split(is_date_parse_space).next().unwrap_or("");
    let bytes = first.as_bytes();
    if bytes.first().is_none_or(|byte| !byte.is_ascii_digit()) {
        return false;
    }
    let mut saw_colon = false;
    for byte in bytes {
        if byte.is_ascii_alphabetic() {
            return saw_colon;
        }
        if *byte == b':' {
            saw_colon = true;
            continue;
        }
        // `2026!16:00` is a year and a clock, not one clock. `!` is ignored
        // later. `16:00+5` still belongs to the clock.
        if byte.is_ascii_digit() || matches!(*byte, b'.' | b'+' | b'-') {
            continue;
        }
        return false;
    }
    saw_colon
}

fn tighten_slash_spaces(value: &str) -> Option<String> {
    if !value.contains('/') {
        return None;
    }
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut changed = false;
    let mut index = 0;
    while index < chars.len() {
        if is_date_parse_space(chars[index]) {
            let mut end = index;
            while end < chars.len() && is_date_parse_space(chars[end]) {
                end += 1;
            }
            if end < chars.len() && chars[end] == '/' && !token_before_has_colon(&out) {
                changed = true;
                index = end;
                continue;
            }
            out.extend(chars[index..end].iter());
            index = end;
            continue;
        }
        if chars[index] == '/' {
            out.push('/');
            let mut end = index + 1;
            while end < chars.len() && is_date_parse_space(chars[end]) {
                end += 1;
            }
            if end > index + 1 {
                changed = true;
            }
            index = end;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    if changed { Some(out) } else { None }
}

fn token_before_has_colon(text: &str) -> bool {
    text.chars()
        .rev()
        .take_while(|character| !is_date_parse_space(*character))
        .any(|character| character == ':')
}

/// The dot is a second dot after a real clock fraction, as in
/// `16:00:00.5.1`. `2026.5.1` is not: its first dot does not follow a colon.
fn clock_fraction_dot(chars: &[char], index: usize) -> bool {
    if !fraction_digits_before(chars, index) {
        return false;
    }
    let mut digit = index;
    while digit > 0 && chars[digit - 1].is_ascii_digit() {
        digit -= 1;
    }
    let mut cursor = digit.saturating_sub(1);
    while cursor > 0 && chars[cursor - 1].is_ascii_digit() {
        cursor -= 1;
    }
    cursor > 0 && chars[cursor - 1] == ':'
}

fn separate_dot_after_fraction(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut changed = false;
    let mut out = String::with_capacity(value.len());
    let mut token_has_colon = false;
    for (index, character) in chars.iter().copied().enumerate() {
        if is_date_parse_space(character) {
            token_has_colon = false;
            out.push(character);
            continue;
        }
        if character == ':' {
            token_has_colon = true;
        }
        if character == '.' && token_has_colon && clock_fraction_dot(&chars, index) {
            out.push(' ');
            changed = true;
            token_has_colon = false;
            continue;
        }
        out.push(character);
    }
    if changed { Some(out) } else { None }
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
    // `16:,` is still 16:00. The comma follows an open field, not a finished one.
    if chars[index] == ',' && index > 0 && chars[index - 1] == ':' {
        return false;
    }
    // `16:00:00.5!` finished through the fraction. The mark is ignored.
    if fraction_digits_before(chars, index) {
        return false;
    }
    let mut ahead = index + 1;
    while ahead < chars.len() && is_ignored_legacy_symbol(chars[ahead]) {
        ahead += 1;
    }
    ahead >= chars.len() || is_date_parse_space(chars[ahead])
}

/// `++2026-10-13` drops both signs. One sign and six digits, as in
/// `+002026`, stays an expanded ISO year.
fn strip_leading_signs(trimmed: &str) -> Option<&str> {
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    while index < bytes.len() && matches!(bytes[index], b'+' | b'-') {
        index += 1;
    }
    if index == 0 {
        return None;
    }
    if index == 1 {
        let digits = trimmed[index..]
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 6 {
            return None;
        }
    }
    let rest = trimmed[index..].trim_start_matches(is_date_parse_space);
    if rest.is_empty() {
        return None;
    }
    Some(rest)
}

/// `hello 2026-10-13` drops `hello`. A word continues through every non-space
/// character at or above `A`, so `hello_world 10/13/2026` drops that word too.
/// `Oct_13` stays, because it names a month. The space keeps a date local.
fn strip_leading_word(trimmed: &str) -> Option<String> {
    let end = trimmed
        .char_indices()
        .find(|(_, character)| is_date_parse_space(*character))?
        .0;
    let word = &trimmed[..end];
    if word.is_empty()
        || !word.chars().all(is_v8_word_char)
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
    let year_text = legacy_iso_year(year);
    canonical_iso(&format!(
        "{year_text}-{month:02}-{day:02}T{clock}{suffix}"
    ))
}

/// `16:00(EST)` finalizes the minutes and then sees a comment, which is empty.
/// `16:00:00.5(EST)` already finished through the fraction. `+05:30(EST)` is
/// an offset, and `16:(EST)` never finalized a field.
fn parenthetical_breaks_final_time(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    chars.iter().enumerate().any(|(index, character)| {
        *character == '(' && finalized_time_before(&chars, index)
    })
}

fn finalized_time_before(chars: &[char], paren: usize) -> bool {
    if paren == 0 || !chars[paren - 1].is_ascii_digit() {
        return false;
    }
    let mut start = paren;
    while start > 0 && chars[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start > 0 && chars[start - 1] == '.' {
        return false;
    }
    if start == 0 || chars[start - 1] != ':' {
        return false;
    }
    let mut head = start;
    while head > 0 && chars[head - 1] == ':' {
        let colon = head - 1;
        if colon == 0 || !chars[colon - 1].is_ascii_digit() {
            return false;
        }
        let mut number = colon;
        while number > 0 && chars[number - 1].is_ascii_digit() {
            number -= 1;
        }
        head = number;
    }
    !(head > 0 && matches!(chars[head - 1], '+' | '-'))
}

/// Drop balanced parenthetical groups. An unclosed `(` drops the rest of the
/// text. A `)` with no `(` stays, so `Oct 13) 2026` is not a date. The comment
/// is a separator, so `2026-10-13(EST)` is not strict ISO.
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
        push_separator(&mut out);
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

/// A `Date.parse` word continues through every non-space character at or
/// above `A`. `_`, `~`, and `é` stay inside `Oct_13`.
fn is_v8_word_char(character: char) -> bool {
    (character as u32) >= u32::from(b'A') && !is_date_parse_space(character)
}

/// `13:Oct` is hour 13 and October. The colon stays on the clock, and the
/// month is the next word. `2026` cannot be a day, so the day is 1.
/// `13Oct:2026` has no colon before the month, so it stays one token.
/// A `-` after the month is skipped. `.` and `/` are symbols, so
/// `13:Oct-2026` and `13:Oct.2026` keep `2026` as a date field.
fn split_time_colon_month(token: &str) -> Option<Vec<&str>> {
    let bytes = token.as_bytes();
    if bytes.first().is_none_or(|byte| !byte.is_ascii_digit()) || !token.contains(':') {
        return None;
    }
    let mut index = 0;
    while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b':') {
        index += 1;
    }
    if index == 0 || index == bytes.len() || bytes[index - 1] != b':' {
        return None;
    }
    let month_at = index;
    while index < bytes.len() {
        let character = token[index..].chars().next()?;
        if !is_v8_word_char(character) {
            break;
        }
        index += character.len_utf8();
    }
    if month_at == index || english_month(&token[month_at..index]).is_none() {
        return None;
    }
    let mut parts = vec![&token[..month_at], &token[month_at..index]];
    index = skip_separator_after_month(token, index);
    if index < token.len() {
        parts.extend(expand_glued_month(&token[index..]));
    }
    Some(parts)
}

/// V8 skips one `-` after a month name. `.` and `/` are their own symbols
/// and are ignored. A second `-`, as in `13:Oct--2026`, stays a sign.
fn skip_separator_after_month(token: &str, mut index: usize) -> usize {
    let bytes = token.as_bytes();
    if bytes.get(index) == Some(&b'-') {
        index += 1;
    }
    while index < bytes.len() && matches!(bytes[index], b'.' | b'/') {
        index += 1;
    }
    index
}

/// `13Oct2026` and `Oct2026` are separate fields. `GMT5` is the zone `GMT`
/// and the number 5. `PM5` is the meridiem and the number 5. A non-keyword
/// glued to a digit, as in `foo13` or `Oct13th`, stays one token so the date
/// scan rejects it. `Oct_13` is October 13: the underscore continues the
/// month word and the digits are the next field. `13:Oct` is hour 13 and
/// October: a month after a time colon is its own word.
fn expand_glued_month(token: &str) -> Vec<&str> {
    if let Some(parts) = split_zone_before_clock(token) {
        return parts;
    }
    if let Some(parts) = split_time_colon_month(token) {
        return parts;
    }
    // `GMT+5` is one zone. Splitting it would turn the 5 into a date number.
    if month_zone_suffix(token).is_some()
        || !token.bytes().any(|byte| byte.is_ascii_digit())
        || !token.chars().any(is_v8_word_char)
    {
        return vec![token];
    }
    let bytes = token.as_bytes();
    let mut runs = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if token[index..].chars().next().is_some_and(is_v8_word_char) {
            let start = index;
            while index < bytes.len() {
                let Some(character) = token[index..].chars().next() else {
                    break;
                };
                if !is_v8_word_char(character) {
                    break;
                }
                index += character.len_utf8();
            }
            let letters = &token[start..index];
            if english_month(letters).is_none()
                && !exact_zone_keyword(letters)
                && !letters.eq_ignore_ascii_case("am")
                && !letters.eq_ignore_ascii_case("pm")
            {
                return vec![token];
            }
            // `13Oct2026GMT+24:00` keeps the offset on the zone word. A bare
            // `GMT+24` still splits, so the 24 can be a day before a date.
            // `GMT+5:`, `GMT+:30`, and `GMT+5::30` are not plain `H:MM`, but
            // every colon still belongs to that offset.
            if exact_zone_keyword(letters)
                && index < bytes.len()
                && matches!(bytes[index], b'+' | b'-')
            {
                let mut cursor = index + 1;
                while cursor < bytes.len() && is_glued_offset_mark(bytes[cursor]) {
                    cursor += 1;
                }
                if bytes[index + 1..cursor].contains(&b':') {
                    index = cursor;
                }
            }
            runs.push(&token[start..index]);
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
        } else if bytes[index] == b'-'
            && runs.last().is_some_and(|word| exact_zone_keyword(word))
            && bytes.get(index + 1).is_some_and(u8::is_ascii_digit)
        {
            // `GMT+530` keeps the `+`. `GMT-530` must keep the `-` too.
            // A skipped hyphen leaves `530`, which is a date number.
            let start = index;
            index += 1;
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
/// Digits, colons, dots, and slashes inside `GMT+5::30`. A letter ends the offset.
fn is_glued_offset_mark(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b':' | b'.' | b'/')
}

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

/// `Z16:00` is the zone and then a clock. The digit is glued to the keyword.
fn glued_clock_follows_zone(zone: &str, next: &str) -> bool {
    next.starts_with(|character: char| character.is_ascii_digit())
        && zone.as_bytes().as_ptr_range().end == next.as_ptr()
}

/// `Z16:00` and `EST16:00` are a zone keyword and then a clock.
fn split_zone_before_clock(token: &str) -> Option<Vec<&str>> {
    let bytes = token.as_bytes();
    let mut end = bytes.len().min(3);
    while end > 0 {
        if bytes.get(end).is_some_and(u8::is_ascii_digit) && exact_zone_keyword(&token[..end]) {
            return Some(vec![&token[..end], &token[end..]]);
        }
        end -= 1;
    }
    None
}

/// `foo13` and `T16:00` glue a word to a digit. `Oct_13` was already split.
/// A colon later in the token does not separate that word from the digit.
fn glued_non_month(word: &str) -> bool {
    if month_zone_suffix(word).is_some() {
        return false;
    }
    if keyword_touches_digit(word) {
        return true;
    }
    if word.contains(':') {
        return false;
    }
    word.bytes().any(|byte| byte.is_ascii_digit()) && word.chars().any(is_v8_word_char)
}

/// `T16:00` is the keyword `T` and then a number. `T:16:00` has a separator
/// between them, so the clock remains. `16:00Z5` is a zone after the clock.
fn keyword_touches_digit(word: &str) -> bool {
    let chars: Vec<char> = word.chars().collect();
    let mut index = 0;
    let mut saw_colon = false;
    while index < chars.len() {
        if chars[index] == ':' {
            saw_colon = true;
            index += 1;
            continue;
        }
        if !is_v8_word_char(chars[index]) {
            index += 1;
            continue;
        }
        let after_colon = saw_colon;
        while index < chars.len() && is_v8_word_char(chars[index]) {
            index += 1;
        }
        if !after_colon && index < chars.len() && chars[index].is_ascii_digit() {
            return true;
        }
    }
    false
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

/// `10/13/2026` and `10//13` are the numbers 10, 13, 2026 and 10, 13.
/// An empty slash is only a separator.
fn slash_date_numbers(word: &str) -> Option<Vec<i32>> {
    if !word.contains('/') || word.bytes().any(|byte| byte.is_ascii_alphabetic()) {
        return None;
    }
    let mut numbers = Vec::new();
    for part in word.split('/') {
        if part.is_empty() {
            continue;
        }
        numbers.push(unsigned_number(part)?);
    }
    Some(numbers)
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

/// `YYYY` for years 0 through 9999. `10000` is `+010000`, the form
/// `Date.parse` reads as an expanded year.
fn legacy_iso_year(year: i32) -> String {
    if (0..10_000).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    }
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
    let year_text = legacy_iso_year(year);
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{clock}{suffix}"
    ))
}

/// A slash date's tail is a clock, a zone, or both. `GMT+5: 1` keeps the
/// minutes open until that later number. A number past 59 is another date field.
fn slash_offset_words(words: &[&str]) -> Option<(Option<String>, Option<i64>, Vec<i32>)> {
    if words.is_empty() {
        return None;
    }
    let mut index = 0;
    let mut clock = None;
    if words[0].starts_with(|character: char| character.is_ascii_digit()) && words[0].contains(':')
    {
        if let Some(sign_at) = words[0].rfind(['+', '-']) {
            if sign_at > 0 && words[0][..sign_at].contains(':') {
                let (body, embedded) = words[0].split_at(sign_at);
                let parsed = parse_legacy_offset(embedded)?;
                return finish_slash_offset(Some(body.to_string()), parsed, &words[1..]);
            }
        }
        clock = Some(words[0].to_string());
        index = 1;
    }
    if index == words.len() {
        return Some((clock, None, Vec::new()));
    }
    let parsed = if let Some(parsed) = legacy_zone_offset(words[index]) {
        parsed
    } else if let Some(parsed) = parse_legacy_offset(words[index]) {
        parsed
    } else if clock.is_some() {
        // `16:00 EST+5:30` uses +5:30. Without a clock, `EST+5:30` is empty.
        let tail = named_zone_offset_tail(words[index])?;
        parse_legacy_offset(tail)?
    } else {
        return None;
    };
    finish_slash_offset(clock, parsed, &words[index + 1..])
}

/// `16:` plus a later `3` is `16:03:00`. A finished `16:00` cannot take another
/// field. Four fields are hour, minute, second, and milliseconds.
fn merge_offset_clock(clock: Option<String>, fields: &[i32]) -> Option<Option<String>> {
    if fields.is_empty() {
        return Some(clock);
    }
    let mut parts = Vec::new();
    if let Some(clock) = clock {
        if !clock.ends_with(':') {
            return None;
        }
        let body = clock.trim_end_matches(':');
        if !body.is_empty() {
            for part in body.split(':') {
                if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                parts.push(part.parse::<i32>().ok()?);
            }
        }
    }
    parts.extend(fields);
    if parts.len() > 4 {
        return None;
    }
    while parts.len() < 3 {
        parts.push(0);
    }
    let hour = parts[0];
    let minute = parts[1];
    let second = parts[2];
    let millis = if parts.len() == 4 { parts[3] } else { 0 };
    let midnight = hour == 24 && minute == 0 && second == 0 && millis == 0;
    if (!(0..=23).contains(&hour) && !midnight)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
        || !(0..=999).contains(&millis)
    {
        return None;
    }
    let text = if millis == 0 {
        format!("{hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{hour:02}:{minute:02}:{second:02}.{millis:03}")
    };
    Some(Some(text))
}

fn finish_slash_offset(
    clock: Option<String>,
    parsed: LegacyOffset,
    rest: &[&str],
) -> Option<(Option<String>, Option<i64>, Vec<i32>)> {
    let clock = merge_offset_clock(clock, &parsed.time_fields)?;
    let mut minutes = parsed.minutes;
    let mut spill = parsed.spilled;
    let mut minute_sign = parsed.minute_sign;
    for word in rest {
        if let Some(number) = unsigned_number(word) {
            if minute_sign != 0 && (0..=59).contains(&number) {
                minutes += minute_sign * i64::from(number);
                minute_sign = 0;
            } else {
                spill.push(number);
            }
            continue;
        }
        if minute_sign == 0 {
            if let Some(zone) = legacy_zone_offset(word) {
                if zone.minute_sign == 0 && zone.spilled.is_empty() && zone.time_fields.is_empty()
                {
                    minutes = zone.minutes;
                    continue;
                }
            }
            // `16:00 GMT EST+5:30` keeps +5:30. The number replaces EST.
            if clock.is_some() {
                if let Some(tail) = named_zone_offset_tail(word) {
                    if let Some(next) = parse_legacy_offset(tail) {
                        if next.minute_sign == 0
                            && next.spilled.is_empty()
                            && next.time_fields.is_empty()
                        {
                            minutes = next.minutes;
                            continue;
                        }
                    }
                }
            }
            // `+5 +6` keeps the later offset.
            if let Some(next) = parse_legacy_offset(word) {
                if next.minute_sign == 0 && next.spilled.is_empty() && next.time_fields.is_empty()
                {
                    minutes = next.minutes;
                    continue;
                }
            }
        }
        return None;
    }
    Some((clock, Some(minutes), spill))
}

/// `YYYY/M/D` or `M/D/YYYY`. A date alone is local midnight. `T` is not a separator.
/// `10/13/2026 +5` has no clock, so the sign is not an offset. `GMT+5`
/// is allowed because GMT is UTC. `EST+5` is not.
fn slash_signed_offset_without_time(trimmed: &str, time: &Option<String>) -> bool {
    if time.is_some() {
        return false;
    }
    let words: Vec<&str> = trimmed
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    if words.iter().copied().any(utc_zone_word) {
        return false;
    }
    words.iter().copied().any(signed_offset_word)
}

fn utc_zone_word(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    lower == "z"
        || lower == "ut"
        || lower.starts_with("gmt")
        || lower.starts_with("utc")
        || lower.starts_with("ut+")
        || lower.starts_with("ut-")
}

fn signed_offset_word(word: &str) -> bool {
    word.starts_with(['+', '-']) || (named_zone_offset_tail(word).is_some() && !utc_zone_word(word))
}

/// `16:00` and `4:5` can sit in front of a slash date. `16:00/10/13` cannot.
fn slash_clock_word(word: &str) -> bool {
    let bytes = word.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_digit()
        && word.contains(':')
        && !word.contains('/')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || *byte == b':')
}

fn rewrite_slash_date(trimmed: &str) -> Option<String> {
    if has_iso_t(trimmed) {
        return None;
    }
    let mut offset_minutes = None;
    let mut zone_spill = Vec::new();
    let (date, time) = if let Some(index) = trimmed.find(is_date_parse_space) {
        let rest = trimmed[index..].trim_start_matches(is_date_parse_space);
        let words: Vec<&str> = rest
            .split(is_date_parse_space)
            .filter(|word| !word.is_empty())
            .collect();
        if slash_clock_word(&trimmed[..index]) {
            if let Some(slash_at) = words.iter().position(|word| word.contains('/')) {
                let clock_word = &trimmed[..index];
                let mut with_clock = vec![clock_word];
                with_clock.extend_from_slice(&words[..slash_at]);
                with_clock.extend_from_slice(&words[slash_at + 1..]);
                let (clock, minutes, spill) = if with_clock.len() == 1 {
                    (Some(clock_word.to_string()), None, Vec::new())
                } else {
                    let Some(parsed) = slash_offset_words(&with_clock) else {
                        return None;
                    };
                    parsed
                };
                offset_minutes = minutes;
                zone_spill = spill;
                (words[slash_at], clock)
            } else if let Some((clock, minutes, spill)) = slash_offset_words(&words) {
                offset_minutes = minutes;
                zone_spill = spill;
                (&trimmed[..index], clock)
            } else {
                let Some(time) = slash_time_and_zone(rest) else {
                    return None;
                };
                (&trimmed[..index], Some(time))
            }
        } else if let Some((clock, minutes, spill)) = slash_offset_words(&words) {
            offset_minutes = minutes;
            zone_spill = spill;
            (&trimmed[..index], clock)
        } else {
            let Some(time) = slash_time_and_zone(rest) else {
                return None;
            };
            (&trimmed[..index], Some(time))
        }
    } else {
        let (date, zone) = split_glued_slash_zone(trimmed);
        if let Some(zone) = zone {
            let parsed = legacy_zone_offset(zone)?;
            let clock = merge_offset_clock(None, &parsed.time_fields)?;
            offset_minutes = Some(parsed.minutes);
            zone_spill = parsed.spilled;
            (date, clock)
        } else {
            (date, None)
        }
    };
    if slash_signed_offset_without_time(trimmed, &time) {
        return None;
    }
    let fields: Vec<&str> = date.split('/').filter(|part| !part.is_empty()).collect();
    if fields.is_empty() || fields.len() > 3 {
        return None;
    }
    let mut numbers = fields
        .iter()
        .map(|part| part.parse::<i32>().ok())
        .collect::<Option<Vec<_>>>()?;
    // `10/13 GMT+5:70` reads 70 as the year. A fourth number is not a date.
    if numbers.len() + zone_spill.len() > 3 {
        return None;
    }
    numbers.extend(zone_spill);
    let first = numbers[0];
    // A missing day or year is 1. `2026/10` is 1 October, and `10/13` is
    // 13 October 2001. `2026/` is 1 January 2026.
    let second = numbers.get(1).copied().unwrap_or(1);
    let third = numbers.get(2).copied().unwrap_or(1);
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
    let year_text = legacy_iso_year(year);
    Some(format!("{year_text}-{month:02}-{day:02}T{clock}{suffix}"))
}

/// `10/13/2026EST` is the slash date plus `EST`. The zone starts at the first
/// character that is not a digit or a slash.
fn split_glued_slash_zone(token: &str) -> (&str, Option<&str>) {
    let bytes = token.as_bytes();
    let mut index = 0;
    while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'/') {
        index += 1;
    }
    if index == 0 || index == bytes.len() {
        return (token, None);
    }
    let zone = &token[index..];
    if legacy_zone_offset(zone).is_some() {
        (&token[..index], Some(zone))
    } else {
        (token, None)
    }
}

/// `16:00 EST` keeps the offset. `(EST)` is a comment, so the clock stays local.
fn slash_time_and_zone(rest: &str) -> Option<String> {
    let words: Vec<&str> = rest
        .split(is_date_parse_space)
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
            if words[end - 2].starts_with(|character: char| character.is_ascii_digit())
                && words[end - 2].contains(':')
            {
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
    let lone_z = time
        .strip_suffix(['Z', 'z'])
        .filter(|clock| !clock.ends_with(['Z', 'z']));
    let (body, zone) = if let Some(clock) = lone_z {
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
        Some(_) => return legacy_clock_text(time),
    };
    let mut numbers = Vec::new();
    for part in clock.split(':') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return legacy_clock_text(time);
        }
        numbers.push(part.parse::<u32>().ok()?);
    }
    if !(2..=3).contains(&numbers.len()) || numbers.iter().any(|number| *number > 99) {
        return legacy_clock_text(time);
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

/// `16:` is 16:00:00. `16::30` is 16:00:30. `16:.5` skips the dot and is 16:05.
fn legacy_clock_text(time: &str) -> Option<String> {
    let mut legacy = MonthTime::new();
    let mut dates = Vec::new();
    let mut offset = None;
    let mut minute_sign = 0i64;
    let mut meridiem = None;
    take_month_clock(
        time,
        &mut legacy,
        &mut dates,
        &mut offset,
        &mut minute_sign,
        &mut meridiem,
    )?;
    if legacy.index == 0 || !dates.is_empty() || minute_sign != 0 {
        return None;
    }
    let clock = finish_month_time(&legacy, meridiem)?;
    match offset {
        None => Some(clock),
        Some(minutes) => {
            let (delta, suffix) = fold_offset_days(minutes)?;
            if delta != 0 {
                return None;
            }
            Some(format!("{clock}{suffix}"))
        }
    }
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

/// `13:Oct-2026.5` is 13:05. The dot after the year is ignored, and `5`
/// fills the open minute. `5.1` is a fraction of that field, so it lands in
/// the next slot and is not a date. A slash after a finished field is empty.
fn apply_dotted_clock_number(
    word: &str,
    time: &mut MonthTime,
    dates: &mut Vec<i32>,
) -> Option<bool> {
    if word.is_empty()
        || !(word.contains('.') || word.contains('/'))
        || !word
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'/'))
    {
        return None;
    }
    let bytes = word.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if matches!(bytes[index], b'.' | b'/') {
            index += 1;
            continue;
        }
        if !bytes[index].is_ascii_digit() {
            return Some(false);
        }
        let (number, _, next) = read_clock_number(bytes, index)?;
        let expecting = time.expecting(number);
        if expecting && next < bytes.len() && bytes[next] == b'.' {
            let mut end = next + 1;
            if end >= bytes.len() || !bytes[end].is_ascii_digit() {
                return Some(false);
            }
            let fraction_at = end;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end < bytes.len() {
                return Some(false);
            }
            let fraction = &word[fraction_at..end];
            let digits = if fraction.len() > 9 {
                &fraction[..9]
            } else {
                fraction
            };
            let value: i32 = digits.parse().ok()?;
            time.add(number)?;
            time.add_final(clock_milliseconds(value, digits.len()))?;
            return Some(true);
        }
        if expecting {
            time.add_final(number)?;
            index = next;
            if index < bytes.len() && bytes[index] == b'/' {
                return Some(false);
            }
            continue;
        }
        push_date_number(dates, number)?;
        index = next;
    }
    Some(true)
}

fn compose_month_date(
    words: &[&str],
    numeric: bool,
) -> Option<(i32, i32, i32, String, Option<i64>)> {
    let mut month = None;
    let mut dates = Vec::new();
    let mut time = MonthTime::new();
    let mut offset = None;
    let mut minute_sign = 0i64;
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
        // `2026 -10-13` is an extra sign after a number. `-10-13` at the
        // start is 13 October. A clock may still read `-10-13` as offsets.
        if let Some(body) = word.strip_prefix(['+', '-']) {
            if body.contains('-') && time.index == 0 && offset != Some(0) {
                if number_seen {
                    return None;
                }
                for part in body.split('-').filter(|part| !part.is_empty()) {
                    let number = unsigned_number(part)?;
                    push_date_number(&mut dates, number)?;
                }
                number_seen = true;
                continue;
            }
        }
        // `16:00 EST+5:30` is 16:00 at UTC+5:30. The number replaces the name.
        // Before a clock, `EST+5:30` is empty. `EST` alone stays EST, and
        // `GMT+5:30` is still the keyword offset.
        if let Some(tail) = named_zone_offset_tail(word) {
            if time.index == 0 {
                return None;
            }
            let parsed = parse_legacy_offset(tail)?;
            for number in parsed.spilled {
                push_date_number(&mut dates, number)?;
            }
            offset = Some(parsed.minutes);
            minute_sign = parsed.minute_sign;
            for number in parsed.time_fields {
                time.add(number)?;
            }
            continue;
        }
        // `13:Oct-2026/5` keeps 2026 as the year. The slash is a separator
        // and 5 fills the open minute. A finished clock still reads
        // `10/13/2026` as a slash date.
        if (1..=3).contains(&time.index) {
            if let Some(done) = apply_dotted_clock_number(word, &mut time, &mut dates) {
                if !done {
                    return None;
                }
                number_seen = true;
                continue;
            }
        }
        if !numeric {
            if let Some(numbers) = slash_date_numbers(word) {
                // `10/13/2026 January` keeps 10 and 13. The month name
                // replaces the slash month, and a third number is ignored.
                if !numbers.is_empty() {
                    for number in numbers {
                        push_date_number(&mut dates, number)?;
                    }
                    number_seen = true;
                }
                continue;
            }
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
        if month_zone_suffix(word).is_some() || zone_keyword_tail(word).is_some() {
            // `GMT5` before any number is not a date. `GMT 5` ignores `GMT`.
            // `GMT+5` before a number ignores the keyword and the sign, so the
            // 5 is a date field. `5:30` in that position is a clock.
            // After a number, `GMT+24:00` is an offset even though the hour
            // is past 23. `GMT+5:60` keeps hour 5 and stores 60 as a date.
            if !number_seen {
                if let Some(tail) = zone_keyword_tail(word) {
                    let body = tail.strip_prefix(['+', '-']).unwrap_or(tail);
                    if body.starts_with(|character: char| character.is_ascii_digit()) {
                        if body.contains(':') {
                            take_month_clock(
                                body,
                                &mut time,
                                &mut dates,
                                &mut offset,
                                &mut minute_sign,
                                &mut hour_offset,
                            )?;
                        } else if let Some(number) = unsigned_number(body) {
                            push_date_number(&mut dates, number)?;
                        } else {
                            return None;
                        }
                        number_seen = true;
                        continue;
                    }
                    // `GMT+:30` ignores the keyword, the sign, and the colon.
                    // 30 is a date number. `GMT+:` ignores the whole token.
                    match digits_after_offset_marks(body) {
                        Some(Some(number)) => {
                            push_date_number(&mut dates, number)?;
                            number_seen = true;
                        }
                        Some(None) => {}
                        None => return None,
                    }
                    continue;
                }
                if words
                    .get(index + 1)
                    .copied()
                    .is_some_and(|next| glued_clock_follows_zone(word, next))
                {
                    return None;
                }
                continue;
            }
            let parsed = legacy_zone_offset(word)?;
            for number in parsed.spilled {
                push_date_number(&mut dates, number)?;
            }
            offset = Some(parsed.minutes);
            minute_sign = parsed.minute_sign;
            for number in parsed.time_fields {
                time.add(number)?;
            }
            continue;
        }
        if word.contains(':') && word.starts_with(|character: char| character.is_ascii_digit()) {
            take_month_clock(
                word,
                &mut time,
                &mut dates,
                &mut offset,
                &mut minute_sign,
                &mut hour_offset,
            )?;
            number_seen = true;
            continue;
        }
        // `+5` after a clock, or after `GMT`, is a fixed offset. `+5` with no
        // clock is not. A later `EST` replaces it.
        if word.starts_with(['+', '-'])
            && word.len() > 1
            && (time.index > 0 || offset == Some(0))
        {
            let parsed = parse_legacy_offset(word)?;
            for number in parsed.spilled {
                push_date_number(&mut dates, number)?;
            }
            offset = Some(parsed.minutes);
            minute_sign = parsed.minute_sign;
            for number in parsed.time_fields {
                time.add(number)?;
            }
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
            // A later `AM` or `PM` replaces the earlier one.
            hour_offset = Some(if word.eq_ignore_ascii_case("pm") { 12 } else { 0 });
            continue;
        }
        if let Some(done) = apply_dotted_clock_number(word, &mut time, &mut dates) {
            if !done {
                return None;
            }
            number_seen = true;
            continue;
        }
        if let Some(done) = take_open_clock_hyphen(
            word,
            &mut time,
            &mut dates,
            &mut offset,
            &mut minute_sign,
        ) {
            if !done {
                return None;
            }
            number_seen = true;
            continue;
        }
        if let Some((number, signed)) = date_number_word(word) {
            if signed && number_seen {
                return None;
            }
            // An open offset minute wins over a clock minute and a date field.
            if !signed && minute_sign != 0 && (0..=59).contains(&number) {
                offset = Some(offset.unwrap_or(0) + minute_sign * i64::from(number));
                minute_sign = 0;
                number_seen = true;
                continue;
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
/// `16:00: 2026-10-13` is 16:00:10 on 1 January 2026 at UTC−13.
/// The number that finishes the open field makes the next hyphen an offset.
fn take_open_clock_hyphen(
    word: &str,
    time: &mut MonthTime,
    dates: &mut Vec<i32>,
    offset: &mut Option<i64>,
    minute_sign: &mut i64,
) -> Option<bool> {
    if !(1..=3).contains(&time.index) || !is_hyphen_number_run(word) {
        return None;
    }
    take_open_clock_hyphen_tail(word, time, dates, offset, minute_sign)
}

fn take_open_clock_hyphen_tail(
    word: &str,
    time: &mut MonthTime,
    dates: &mut Vec<i32>,
    offset: &mut Option<i64>,
    minute_sign: &mut i64,
) -> Option<bool> {
    if !(1..=3).contains(&time.index) {
        return None;
    }
    let bytes = word.as_bytes();
    let mut index = 0;
    loop {
        if index >= bytes.len() {
            return Some(true);
        }
        if matches!(bytes[index], b'+' | b'-') {
            // The sign before a date number was skipped. The sign after the
            // number that finishes the clock is the offset.
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if start == index {
            return Some(false);
        }
        let number = unsigned_number(&word[start..index])?;
        if time.expecting(number) {
            time.add_final(number)?;
            if index == bytes.len() {
                return Some(true);
            }
            let sign = if bytes[index] == b'+' {
                1i64
            } else if bytes[index] == b'-' {
                -1
            } else {
                return Some(false);
            };
            index += 1;
            let offset_start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            if offset_start == index || index != bytes.len() {
                return Some(false);
            }
            let offset_text = &word[offset_start..index];
            let offset_number = unsigned_number(offset_text)?;
            let minutes = match offset_text.len() {
                1 | 2 => sign * i64::from(offset_number) * 60,
                3 | 4 => {
                    let hour = i64::from(offset_number / 100);
                    let minute = i64::from(offset_number % 100);
                    sign * (hour * 60 + minute)
                }
                _ => return Some(false),
            };
            *offset = Some(minutes);
            *minute_sign = 0;
            return Some(true);
        }
        push_date_number(dates, number)?;
    }
}

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
    minute_sign: &mut i64,
    hour_offset: &mut Option<i32>,
) -> Option<()> {
    let (body, embedded) = split_clock_tail(word);
    let mut time_fields = Vec::new();
    // `16:00Z+5` splits into `16:00Z` and `+5`. The body sets UTC, then the
    // tail replaces it. Applying the tail first lets `Z` wipe `+5`.
    let mut pending_offset = None;
    if !embedded.is_empty() {
        if embedded.eq_ignore_ascii_case("Z") {
            pending_offset = Some((0, 0));
        } else {
            let parsed = parse_legacy_offset(embedded)?;
            for number in parsed.spilled {
                push_date_number(dates, number)?;
            }
            pending_offset = Some((parsed.minutes, parsed.minute_sign));
            time_fields = parsed.time_fields;
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
                // `16:::30` and `16::.5` still fill the next field: the extra
                // colon or dot is only a separator.
                if time.index != 0 {
                    return None;
                }
                time.add(number)?;
                time.add(0)?;
                index += 1;
                while index < bytes.len() && matches!(bytes[index], b':' | b'.') {
                    index += 1;
                }
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
            // `4:00:00.5PM` is 16:00:00.500. The fraction finished the clock,
            // so a meridiem may touch it. `4:00PM` is still empty.
            if consume_fraction_meridiem(bytes, index, hour_offset) {
                break;
            }
            // `16:00:00.5EST` is 16:00:00.500 EST. The fraction does not
            // require whitespace before the next token. `16:00EST` is empty.
            if consume_fraction_zone(bytes, index, offset)? {
                break;
            }
            if index != bytes.len() && !consume_glued_z(bytes, index, dates, offset)? {
                return None;
            }
            break;
        }
        if time.expecting(number) {
            time.add_final(number)?;
            // `16:.5` is 16:05. `16:.5.5` finalized the minute and then saw `.`.
            if index < bytes.len() && bytes[index] == b'.' {
                return None;
            }
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
        // `16:00:2026-10-13` keeps going. 2026 is the year, 10 is the open
        // second, and `-13` is the offset.
        if index < bytes.len() && matches!(bytes[index], b'+' | b'-') {
            let rest = &body[index..];
            if let Some(done) =
                take_open_clock_hyphen_tail(rest, time, dates, offset, minute_sign)
            {
                if !done {
                    return None;
                }
                return Some(());
            }
        }
        if index != bytes.len() {
            return None;
        }
        break;
    }
    if let Some((minutes, sign)) = pending_offset {
        *offset = Some(minutes);
        *minute_sign = sign;
    }
    for number in time_fields {
        time.add(number)?;
    }
    Some(())
}

/// `16:00Z` and `16:00Z5`. `16:00EST` is not a date: only `Z` may touch a
/// finished clock.
/// `4:00:00.5PM` and `4:00:00.5AM`. An empty tail is also finished.
fn consume_fraction_meridiem(bytes: &[u8], index: usize, hour_offset: &mut Option<i32>) -> bool {
    let Ok(rest) = std::str::from_utf8(&bytes[index..]) else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    if rest.eq_ignore_ascii_case("pm") {
        *hour_offset = Some(12);
        return true;
    }
    if rest.eq_ignore_ascii_case("am") {
        *hour_offset = Some(0);
        return true;
    }
    false
}

/// `16:00:00.5EST` and `16:00:00.5GMT+5` name a zone after the fraction.
/// `16:00:00.5foo` does not. `Z5` is a date number, so this stays false.
fn consume_fraction_zone(bytes: &[u8], index: usize, offset: &mut Option<i64>) -> Option<bool> {
    if index >= bytes.len() {
        return Some(false);
    }
    let rest = std::str::from_utf8(&bytes[index..]).ok()?;
    let Some(parsed) = legacy_zone_offset(rest) else {
        return Some(false);
    };
    if !parsed.spilled.is_empty() || !parsed.time_fields.is_empty() || parsed.minute_sign != 0 {
        return Some(false);
    }
    *offset = Some(parsed.minutes);
    Some(true)
}

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
    push_date_number(dates, number)?;
    if end == bytes.len() {
        return Some(true);
    }
    // `16:00Z2026-10-13` is 16:00 UTC on that date. The hyphen is not an offset.
    if bytes[end] == b'-' {
        let rest = std::str::from_utf8(&bytes[end + 1..]).ok()?;
        if rest.is_empty() {
            return Some(true);
        }
        for part in rest.split('-') {
            push_date_number(dates, unsigned_number(part)?)?;
        }
        return Some(true);
    }
    None
}

fn split_clock_tail(token: &str) -> (&str, &str) {
    if let Some(body) = token.strip_suffix(['Z', 'z']) {
        // `16:00Z` is UTC. `16:00ZZ` is one garbage word. `16:00+5Z` keeps
        // the sign so `Z` can replace `+5`.
        if body.contains(':')
            && !body.contains(['+', '-'])
            && !body.ends_with(['Z', 'z'])
        {
            return (body, &token[body.len()..]);
        }
    }
    let bytes = token.as_bytes();
    let mut saw_colon = false;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if byte == b':' {
            saw_colon = true;
            continue;
        }
        if !saw_colon || index == 0 || (byte != b'+' && byte != b'-') {
            continue;
        }
        // `16:00-5` and `4:00:00.5PM+5` are offsets. `16:00:2026-10-13` is
        // the next field: a long digit run before `-` stays in the clock word.
        let mut start = index;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        let digits = index - start;
        let clock_field = (1..=2).contains(&digits)
            && std::str::from_utf8(&bytes[start..index])
                .ok()
                .and_then(|text| text.parse::<i32>().ok())
                .is_some_and(|number| (0..=59).contains(&number));
        let tail = &token[index + 1..];
        if byte == b'+' || tail.contains(':') || clock_field || !bytes[index - 1].is_ascii_digit() {
            return token.split_at(index);
        }
        break;
    }
    (token, "")
}

struct LegacyOffset {
    minutes: i64,
    spilled: Vec<i32>,
    /// `+5:` still needs its minutes. `1` means the next minute is added;
    /// `-1` means it is subtracted. `0` means the minute is already final.
    minute_sign: i64,
    /// Numbers followed by `:` after the offset hour. `GMT+5:3:0` stores 3
    /// here and keeps 0 as the offset minute.
    time_fields: Vec<i32>,
}

/// `+5EST` and `+5:30Z` end in a zone keyword. `+5` and `+5GMT5` do not.
fn offset_zone_suffix(text: &str) -> Option<&str> {
    const KEYWORDS: [&str; 12] = [
        "gmt", "utc", "est", "edt", "cst", "cdt", "mst", "mdt", "pst", "pdt", "ut", "z",
    ];
    for keyword in KEYWORDS {
        if text.len() <= keyword.len() {
            continue;
        }
        let split_at = text.len() - keyword.len();
        // `UTä` ends inside a multibyte letter. The suffix has to start
        // on a character boundary.
        if !text.is_char_boundary(split_at) {
            continue;
        }
        let (prefix, suffix) = text.split_at(split_at);
        if !suffix.eq_ignore_ascii_case(keyword) {
            continue;
        }
        let before = prefix.chars().next_back()?;
        if before.is_ascii_alphabetic() || !prefix.bytes().any(|byte| byte.is_ascii_digit()) {
            continue;
        }
        return Some(suffix);
    }
    None
}

/// `+5`, `+0530`, `+:30`, `+5:30`, and `+5:30.5`. A missing hour is 0.
/// A dot is skipped, so `+5.30` is five hours and 30 is a date number.
/// `+5:.5` is five hours and five minutes. `+5:60.5` spills 60 and keeps
/// the 5 as the minutes. A minute followed by `:` is not an offset.
/// `+5:` leaves the minute open for a later number. Minutes past 59 in
/// `HHMM` count as extra hours.
fn parse_legacy_offset(text: &str) -> Option<LegacyOffset> {
    // `+5EST` is EST. The keyword comes last, so it replaces the number.
    if let Some(zone) = offset_zone_suffix(text) {
        return legacy_zone_offset(zone);
    }
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
    let mut index = 0;
    let (value, length) = if bytes[0].is_ascii_digit() {
        let (value, length, next) = read_clock_number(bytes, 0)?;
        index = next;
        (value, length)
    } else {
        (0, 0)
    };
    let mut minute_pending = false;
    let (hour, mut minute) = if index < bytes.len() && bytes[index] == b':' {
        index += 1;
        minute_pending = true;
        (i64::from(value), 0i64)
    } else {
        match length {
            1 | 2 => (i64::from(value), 0),
            3 | 4 => (i64::from(value / 100), i64::from(value % 100)),
            _ => return None,
        }
    };
    let mut spilled = Vec::new();
    let mut time_fields = Vec::new();
    while index < bytes.len() {
        // `+5::30` is +5:30. Extra colons before the minute are ignored.
        // A dot or slash is skipped, so `+5:.5` and `+5:/30` fill the minute.
        // `+5/30` has no open minute, so 30 is a date number.
        if bytes[index] == b'.' || bytes[index] == b':' || bytes[index] == b'/' {
            index += 1;
            continue;
        }
        if !bytes[index].is_ascii_digit() {
            return None;
        }
        let (number, _, next) = read_clock_number(bytes, index)?;
        index = next;
        if index < bytes.len() && bytes[index] == b':' {
            // `GMT+5:3:0` uses 3 as the hour of a clock, not as the minutes.
            index += 1;
            time_fields.push(number);
            continue;
        }
        if minute_pending && (0..=59).contains(&number) {
            minute = i64::from(number);
            minute_pending = false;
        } else {
            spilled.push(number);
        }
    }
    Some(LegacyOffset {
        minutes: sign * (hour * 60 + minute),
        spilled,
        minute_sign: if minute_pending { sign } else { 0 },
        time_fields,
    })
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
    let parsed = parse_legacy_offset(words[2])?;
    // `+5:30:00` has a third field. `+5:30` and `+5::30` do not.
    if !parsed.spilled.is_empty() || !parsed.time_fields.is_empty() {
        return None;
    }
    // `16:00+5 -30` keeps `-30`. The sign glued to the clock was replaced.
    // `16:00Z +5` drops `Z`. The number is the later zone. `16:00ZZ` is
    // one garbage word, so that `Z` stays.
    let clock_word = match words[1].strip_suffix(['Z', 'z']) {
        Some(body) if !body.ends_with(['Z', 'z']) => body,
        _ => words[1],
    };
    let clock = slash_clock(strip_glued_offset(clock_word))?;
    let (delta, suffix) = fold_offset_days(parsed.minutes)?;
    let date = shift_hyphen_date(words[0], delta)?;
    Some(format!("{date}T{clock}{suffix}"))
}

fn strip_glued_offset(clock: &str) -> &str {
    if let Some(sign_at) = clock.rfind(['+', '-']) {
        if sign_at > 0 && clock[..sign_at].contains(':') {
            return &clock[..sign_at];
        }
    }
    clock
}

fn shift_hyphen_date(date: &str, delta: i32) -> Option<String> {
    // A leftover clock makes three hyphen fields legacy. `1-10-13` is 10
    // January 2013, because 1 can be a day. `0000-01-01` is 1 January 2000,
    // because 0 cannot. `10000-10-13` stays year 10000. `-000001-10-13` stays
    // year -1; the sign is part of the year, not a field break.
    if let Some((year, month, day)) = expanded_hyphen_ymd(date) {
        // `-000000` is an invalid expanded year, so a legacy clock uses the
        // 0–99 window. Year -1 is outside that window and stays negative.
        let year = if (0..=99).contains(&year) {
            legacy_year_number(year)?
        } else {
            year
        };
        return shifted_hyphen_iso((year, month, day), delta);
    }
    let mut parts = date.split('-');
    let first: i32 = parts.next()?.parse().ok()?;
    let second: i32 = parts.next()?.parse().ok()?;
    let third: i32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let (year, month, day) = if (1..=31).contains(&first) {
        (legacy_year_number(third)?, first, second)
    } else if (0..=99).contains(&first) {
        (legacy_year_number(first)?, second, third)
    } else {
        (first, second, third)
    };
    shifted_hyphen_iso((year, month, day), delta)
}

fn expanded_hyphen_ymd(date: &str) -> Option<(i32, i32, i32)> {
    if !date.starts_with(['+', '-']) || date.len() < 7 {
        return None;
    }
    if !date.as_bytes()[1..7].iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year: i32 = date[..7].parse().ok()?;
    let rest = date[7..].strip_prefix('-')?;
    let (month, day) = rest.split_once('-')?;
    if day.contains('-') || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let month: i32 = month.parse().ok()?;
    let day: i32 = day.parse().ok()?;
    Some((year, month, day))
}

fn shifted_hyphen_iso((year, month, day): (i32, i32, i32), delta: i32) -> Option<String> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (year, month, day) = if delta == 0 {
        (year, month, day)
    } else {
        shift_ymd(year, month, day, delta)?
    };
    Some(format!("{}-{:02}-{:02}", legacy_iso_year(year), month, day))
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

/// `GMT+5` and `UTC+5:30` keep the signed tail. `EST` and `GMT` have none.
fn ascii_prefix(word: &str, length: usize) -> Option<&str> {
    if word.len() >= length && word.is_char_boundary(length) {
        Some(&word[..length])
    } else {
        None
    }
}

/// `EST+5:30` is the offset `+5:30`. `EST` has no tail. `GMT+5:30` does not
/// use this form; the keyword already owns that signed tail.
fn named_zone_offset_tail(word: &str) -> Option<&str> {
    let bytes = word.as_bytes();
    if bytes.len() < 5 || !bytes[..3].iter().all(u8::is_ascii_alphabetic) {
        return None;
    }
    if !matches!(
        word[..3].to_ascii_lowercase().as_str(),
        "est" | "edt" | "cst" | "cdt" | "mst" | "mdt" | "pst" | "pdt"
    ) {
        return None;
    }
    let tail = &word[3..];
    if tail.len() > 1 && matches!(tail.as_bytes()[0], b'+' | b'-') {
        Some(tail)
    } else {
        None
    }
}

fn zone_keyword_tail(word: &str) -> Option<&str> {
    // `Mäy` is two bytes into the second letter. A prefix slice has to land
    // on a character boundary, or the date parser panics.
    let prefix = if ascii_prefix(word, 3).is_some_and(|text| text.eq_ignore_ascii_case("gmt")) {
        3
    } else if ascii_prefix(word, 3).is_some_and(|text| text.eq_ignore_ascii_case("utc")) {
        3
    } else if ascii_prefix(word, 2).is_some_and(|text| text.eq_ignore_ascii_case("ut")) {
        2
    } else {
        return None;
    };
    let rest = &word[prefix..];
    if rest.starts_with(['+', '-']) && rest.len() > 1 {
        Some(rest)
    } else {
        None
    }
}

/// `GMT+:30` keeps 30. `GMT+:` has no number. `GMT+:30x` is not a date.
fn digits_after_offset_marks(body: &str) -> Option<Option<i32>> {
    let bytes = body.as_bytes();
    let mut index = 0;
    while index < bytes.len() && matches!(bytes[index], b':' | b'.') {
        index += 1;
    }
    if index == bytes.len() {
        return Some(None);
    }
    if !bytes[index].is_ascii_digit() {
        return None;
    }
    let (number, _, next) = read_clock_number(bytes, index)?;
    if next != bytes.len() {
        return None;
    }
    Some(Some(number))
}

/// `GMT+24:00` is 24 hours ahead. `GMT+5:` has no minutes. `GMT+5:60` keeps
/// the 5 hours and returns 60 as a date number. `EST` has no signed tail.
fn legacy_zone_offset(word: &str) -> Option<LegacyOffset> {
    if let Some(tail) = zone_keyword_tail(word) {
        return parse_legacy_offset(tail);
    }
    let suffix = month_zone_suffix(word)?;
    Some(LegacyOffset {
        minutes: suffix_east_minutes(&suffix)?,
        spilled: Vec::new(),
        minute_sign: 0,
        time_fields: Vec::new(),
    })
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
            && after_digits.is_none_or(|character| {
                matches!(character, '.' | '-' | ',')
                    || is_date_parse_space(character)
                    || character.is_ascii_alphabetic()
            })
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
        // `13:Oct-2026.5.` keeps the last dot: it is a fraction with no digits.
        if chars.get(next).is_some() {
            out.extend(chars[index..next].iter().copied());
        } else {
            let token_start = out.rfind([' ', '\t', ',']).map(|at| at + 1).unwrap_or(0);
            if out.contains(':') && out[token_start..].contains('.') {
                out.push('.');
            }
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

/// `:30` and `.5` at the start of a field are the numbers 30 and 5.
/// `:30` and `.5` at the start of a field are the numbers 30 and 5.
/// The mark is still a separator, so `.2026-10-13` is local and
/// `.2026-10-13T16:00` is empty.
fn strip_leading_field_marks(value: &str) -> Option<String> {
    let mut changed = false;
    let mut out = String::with_capacity(value.len());
    let mut at_token_start = true;
    for character in value.chars() {
        if is_date_parse_space(character) {
            at_token_start = true;
            out.push(character);
            continue;
        }
        if at_token_start && matches!(character, ':' | '.') {
            changed = true;
            if !out.ends_with(is_date_parse_space) {
                out.push(' ');
            }
            continue;
        }
        at_token_start = false;
        out.push(character);
    }
    if changed { Some(out) } else { None }
}

/// `4: 5: 6` is `4:5:6`. A field that ends in `:` takes the next number.
fn join_open_clock_fields(value: &str) -> Option<String> {
    let words: Vec<&str> = value
        .split(is_date_parse_space)
        .filter(|word| !word.is_empty())
        .collect();
    let mut joined: Vec<String> = Vec::new();
    let mut changed = false;
    for word in words {
        if joined.last().is_some_and(|previous| previous.ends_with(':'))
            && word.bytes().all(|byte| byte.is_ascii_digit())
            && !word.is_empty()
        {
            joined.last_mut().unwrap().push_str(word);
            changed = true;
        } else {
            joined.push(word.to_string());
        }
    }
    if changed {
        Some(joined.join(" "))
    } else {
        None
    }
}

/// `+5-30` after a clock is a later offset of −30. Before a clock it is 30 May.
fn separate_second_offset_sign(value: &str) -> Option<String> {
    let mut changed = false;
    let mut out = String::with_capacity(value.len());
    let mut token = String::new();
    let mut clock_seen = false;
    for character in value.chars() {
        if is_date_parse_space(character) {
            if !token.is_empty() {
                push_offset_token(&token, clock_seen, &mut out, &mut changed);
                if token_has_clock(&token) {
                    clock_seen = true;
                }
                token.clear();
            }
            out.push(character);
        } else {
            token.push(character);
        }
    }
    if !token.is_empty() {
        push_offset_token(&token, clock_seen, &mut out, &mut changed);
    }
    if changed { Some(out) } else { None }
}

fn token_has_clock(token: &str) -> bool {
    if has_iso_t(token) {
        return false;
    }
    token
        .as_bytes()
        .windows(2)
        .any(|pair| pair[0].is_ascii_digit() && pair[1] == b':')
}

fn push_offset_token(token: &str, clock_before: bool, out: &mut String, changed: &mut bool) {
    if let Some(split) = split_second_offset_sign(token, clock_before) {
        out.push_str(&split);
        *changed = true;
    } else {
        out.push_str(token);
    }
}

fn split_second_offset_sign(token: &str, clock_before: bool) -> Option<String> {
    // `+5-30` before a clock is 30 May. After a clock it is UTC−30.
    // A `T` form does not take a second sign.
    if has_iso_t(token) {
        return None;
    }
    let bytes = token.as_bytes();
    let mut offset_started = false;
    let mut seen_clock = clock_before;
    let mut saw_zone = false;
    let mut split_at = None;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if byte == b':' {
            if index > 0 && bytes[index - 1].is_ascii_digit() {
                seen_clock = true;
            }
            continue;
        }
        if byte.eq_ignore_ascii_case(&b'z') && seen_clock && index > 0 && bytes[index - 1].is_ascii_digit()
        {
            // `16:00Z2026-10-13` is a date after UTC. Those hyphens stay.
            saw_zone = true;
            continue;
        }
        if saw_zone {
            continue;
        }
        if byte != b'+' && byte != b'-' {
            continue;
        }
        let starts_offset = seen_clock
            && (index == 0 || offset_started || sign_starts_offset(&token[..index]));
        if !starts_offset {
            continue;
        }
        if offset_started
            && bytes[index - 1].is_ascii_digit()
            && bytes.get(index + 1).is_some_and(|next| next.is_ascii_digit())
        {
            split_at = Some(index);
            break;
        }
        offset_started = true;
    }
    let index = split_at?;
    let mut split = String::with_capacity(token.len() + 1);
    split.push_str(&token[..index]);
    split.push(' ');
    split.push_str(&token[index..]);
    Some(split)
}

/// A sign after a clock or a zone word starts an offset. A sign after `Oct`
/// is a date hyphen.
fn sign_starts_offset(before: &str) -> bool {
    if before.contains(':') {
        return true;
    }
    let start = before
        .rfind(|character: char| !character.is_ascii_alphabetic())
        .map(|index| index + 1)
        .unwrap_or(0);
    matches!(
        before[start..].to_ascii_lowercase().as_str(),
        "ut" | "utc" | "z" | "gmt" | "cdt" | "cst" | "edt" | "est" | "mdt" | "mst"
            | "pdt" | "pst" | "am" | "pm"
    )
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

fn finished_date_has_an_extra_hyphen(trimmed: &str) -> bool {
    let head = trimmed
        .split_once(is_date_parse_space)
        .map(|(head, _)| head)
        .unwrap_or(trimmed);
    let expanded = head.starts_with(['+', '-'])
        && head[1..].bytes().take_while(|byte| byte.is_ascii_digit()).count() == 6;
    let date_at = if expanded { 7 } else { 4 };
    let bytes = head.as_bytes();
    if bytes.len() < date_at + 6 {
        return false;
    }
    let year_ok = if expanded {
        iso_date_year(&head[..7])
    } else {
        iso_date_year(&head[..4])
    };
    year_ok
        && bytes[date_at] == b'-'
        && bytes[date_at + 1].is_ascii_digit()
        && bytes[date_at + 2].is_ascii_digit()
        && bytes[date_at + 3] == b'-'
        && bytes[date_at + 4].is_ascii_digit()
        && bytes[date_at + 5].is_ascii_digit()
        && bytes.get(date_at + 6) == Some(&b'-')
}

/// `2026-` and `2026-10-` stop before a strict ISO date, so midnight is local.
/// `2026- GMT` is that midnight at GMT. A finished `2026-10-13-` is empty.
fn trailing_hyphen_iso(trimmed: &str) -> Option<String> {
    let (head, zone) = if let Some((head, rest)) = trimmed.split_once(is_date_parse_space) {
        let rest = rest.trim_start_matches(is_date_parse_space);
        if rest.is_empty() || rest.contains(is_date_parse_space) {
            return None;
        }
        (head, Some(rest))
    } else {
        (trimmed, None)
    };
    if !head.ends_with('-') || head.ends_with("--") {
        return None;
    }
    let body = &head[..head.len() - 1];
    if body.is_empty() || body.ends_with('-') {
        return None;
    }
    let (year, month, day) = unfinished_hyphen_ymd(body)?;
    if let Some(zone) = zone {
        // `(10)` is a comment, so `2026-(10)-13` is `2026- -13`. A bare
        // signed number is not a zone. `GMT-5` and `EST` still are.
        if zone.starts_with(['+', '-']) {
            return None;
        }
        let parsed = legacy_zone_offset(zone).or_else(|| parse_legacy_offset(zone))?;
        if !parsed.time_fields.is_empty() || !parsed.spilled.is_empty() {
            return None;
        }
        let delta = parsed.minutes.checked_mul(-60)?;
        let (year, month, day, hour, minute, second) =
            shift_seconds(year, month, day, 0, 0, 0, delta)?;
        return format_civil_iso(year, month, day, hour, minute, second, 0);
    }
    let (year, month, day, hour, minute, second) = local_civil_to_utc(year, month, day, 0, 0, 0)?;
    format_civil_iso(year, month, day, hour, minute, second, 0)
}

fn unfinished_hyphen_ymd(body: &str) -> Option<(i32, i32, i32)> {
    let expanded = body.starts_with(['+', '-'])
        && body[1..].bytes().take_while(|byte| byte.is_ascii_digit()).count() == 6
        && (body.len() == 7 || body.as_bytes().get(7) == Some(&b'-'));
    let (year_text, rest) = if expanded {
        (&body[..7], body[7..].strip_prefix('-').unwrap_or(""))
    } else if let Some(rest) = body.strip_prefix(['+', '-']) {
        if let Some((year, rest)) = rest.split_once('-') {
            (year, rest)
        } else {
            (rest, "")
        }
    } else if let Some((year, rest)) = body.split_once('-') {
        (year, rest)
    } else {
        (body, "")
    };
    if year_text.is_empty() || rest.split('-').any(|part| part.is_empty() && !rest.is_empty()) {
        return None;
    }
    let mut parts = vec![year_text];
    if !rest.is_empty() {
        parts.extend(rest.split('-'));
    }
    if parts.len() > 3 {
        return None;
    }
    if parts.len() == 3 && iso_date_year(parts[0]) && parts[1].len() == 2 && parts[2].len() == 2 {
        return None;
    }
    let numbers = parts
        .iter()
        .map(|part| part.parse::<i32>().ok())
        .collect::<Option<Vec<_>>>()?;
    let iso_year = iso_date_year(parts[0]);
    match numbers.as_slice() {
        [first] if !iso_year && (1..=31).contains(first) => {
            if !(1..=12).contains(first) {
                return None;
            }
            Some((2001, *first, 1))
        }
        [first] => {
            let year = if iso_year { *first } else { legacy_year_number(*first)? };
            Some((year, 1, 1))
        }
        [first, month] => {
            let year = if iso_year { *first } else { legacy_year_number(*first)? };
            if !(1..=12).contains(month) {
                return None;
            }
            Some((year, *month, 1))
        }
        [first, month, day] => {
            let year = if iso_year { *first } else { legacy_year_number(*first)? };
            if !(1..=12).contains(month) || !(1..=31).contains(day) {
                return None;
            }
            Some((year, *month, *day))
        }
        _ => None,
    }
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
    // A short field means the ES5 date did not finish. `0000-1-1` is year
    // 2000. `0001-10-5` is 10 January 2005, because 1 can be a day.
    let (year, month, day) = if legacy_local && (1..=31).contains(&year) {
        (legacy_year_number(day)?, year, month)
    } else if legacy_local && (0..=99).contains(&year) {
        (legacy_year_number(year)?, month, day)
    } else {
        (year, month, day)
    };
    let (year, month, day) = normalize_ymd(year, month, day)?;
    if legacy_local {
        let (year, month, day, hour, minute, second) =
            local_civil_to_utc(year, month, day, 0, 0, 0)?;
        return format_civil_iso(year, month, day, hour, minute, second, 0);
    }
    format_civil_iso(year, month, day, 0, 0, 0, 0)
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
    format_civil_iso(year, month, day, hour, minute, second, 0)
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
) -> Option<String> {
    // TimeClip: ±8.64e15 ms is the last representable instant. One millisecond
    // past `+275760-09-13T00:00:00.000Z` is empty.
    let seconds = unix_from_utc(year, month, day, hour, minute, second)?;
    let instant = seconds.checked_mul(1000)?.checked_add(i64::from(millis))?;
    if instant.abs() > 8_640_000_000_000_000 {
        return None;
    }
    let year_text = if (0..10_000).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
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
    let hour_text = time.get(0..2)?;
    let minute_text = time.get(3..5)?;
    // `+5:30` is a signed offset, not a clock. The hour and minute are digits.
    if !hour_text.bytes().all(|byte| byte.is_ascii_digit())
        || !minute_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hour: i32 = hour_text.parse().ok()?;
    let minute: i32 = minute_text.parse().ok()?;
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
        // Nine significant digits, then three millisecond digits. Leading
        // zeros count in the length, so `0001234567` is 1 ms, not 0.
        let (number, length, end) = read_clock_number(digits.as_bytes(), 0)?;
        if end != digits.len() {
            return None;
        }
        millis = clock_milliseconds(number, length) as u32;
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
}
