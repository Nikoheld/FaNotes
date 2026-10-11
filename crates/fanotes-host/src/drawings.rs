//! Drawing library files under `.fanotes/assets`, matching the Electron host.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use fanotes_famd::{
    companion_note_path, empty_famd_payload, is_paper_style, parse_famd, serialize_famd,
    strip_famd_payload, worksheet_ids_from_markdown,
};
use serde_json::{json, Value};

use crate::vault;
use crate::Host;

const MAX_DRAWING_JSON_BYTES: usize = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn vault_root(host: &Host) -> Result<&std::path::Path, String> {
    host.vault
        .as_deref()
        .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())
}

pub fn list_drawings(host: &Host) -> Result<Value, String> {
    let assets = assets_dir(vault_root(host)?)?;
    let mut drawings = Vec::new();
    let entries = match fs::read_dir(&assets) {
        Ok(entries) => entries,
        Err(_) => return Ok(json!([])),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = drawing_file_id(&name) else {
            continue;
        };
        let path = entry.path();
        let Ok(text) = read_limited(&path, MAX_DRAWING_JSON_BYTES) else {
            continue;
        };
        // Node `Buffer.toString('utf8')` keeps the drawing and replaces a bad byte.
        let text = lossy_utf8(text);
        let mtime = fs::symlink_metadata(&path)
            .ok()
            .filter(|meta| meta.is_file() && !meta.file_type().is_symlink())
            .and_then(|meta| meta.modified().ok())
            .map(crate::notes::iso_from_system_time);
        if let Ok(item) = metadata_from_json(&text, id, mtime.as_deref()) {
            drawings.push(item);
        }
    }
    drawings.sort_by(|left, right| {
        right["updatedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(left["updatedAt"].as_str().unwrap_or(""))
            .then_with(|| {
                crate::compare_names(
                    left["title"].as_str().unwrap_or(""),
                    right["title"].as_str().unwrap_or(""),
                )
            })
    });
    Ok(Value::Array(drawings))
}

pub fn read_drawing(host: &Host, raw_id: &str) -> Result<Value, String> {
    let id = drawing_id(raw_id)?;
    let path = assets_dir(vault_root(host)?)?.join(format!("{id}.json"));
    let bytes = read_limited(&path, MAX_DRAWING_JSON_BYTES).map_err(|_| {
        if path.exists() {
            "Die gespeicherte Zeichnung ist beschädigt oder kann nicht sicher gelesen werden."
                .to_owned()
        } else {
            "Die gespeicherte Zeichnung wurde nicht gefunden.".to_owned()
        }
    })?;
    let drawing_json = lossy_utf8(bytes);
    let mtime = fs::symlink_metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(crate::notes::iso_from_system_time);
    let mut item = metadata_from_json(&drawing_json, &id, mtime.as_deref())?;
    item["drawingJson"] = Value::String(drawing_json);
    Ok(item)
}

pub fn save_drawing(host: &Host, payload: &Value) -> Result<Value, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Ungültige Zeichnung.".to_owned())?;
    let id = match object.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => drawing_id(id)?,
        _ => random_id()?,
    };
    let title = safe_title(object.get("title").and_then(Value::as_str).unwrap_or(""))?;
    let drawing_json = object
        .get("drawingJson")
        .and_then(Value::as_str)
        .ok_or_else(|| "Die Zeichnungsdaten sind ungültig oder zu groß.".to_owned())?;
    let document = validate_drawing_json(drawing_json)?;
    let item = metadata_value(&document, &id)?;
    if item["title"].as_str() != Some(title.as_str()) {
        return Err("Der Zeichnungstitel stimmt nicht mit den Zeichnungsdaten überein.".to_owned());
    }
    let assets = assets_dir(vault_root(host)?)?;
    if let Some(image) = object.get("imageData").filter(|value| !value.is_null()) {
        let png = decode_png(image.as_str().unwrap_or(""))?;
        crate::notes::atomic_write(&assets.join(format!("{id}.png")), &png, 0o600)
            .map_err(|_| "Die Zeichnung konnte nicht gespeichert werden.".to_owned())?;
    }
    crate::notes::atomic_write(
        assets.join(format!("{id}.json")).as_path(),
        drawing_json.as_bytes(),
        0o600,
    )
    .map_err(|_| "Die Zeichnung konnte nicht gespeichert werden.".to_owned())?;
    if let Some(note) = object.get("noteRelativePath").and_then(Value::as_str) {
        if !note.trim().is_empty() {
            embed_in_note(host, note.trim(), &document).map_err(|error| {
                format!("Handschrift konnte nicht in die Notiz geschrieben werden: {error}")
            })?;
        }
    }
    Ok(item)
}

const FAMD_INK_ID: &str = "famd-ink";
const MAX_FAMD_BYTES: usize = 40 * 1024 * 1024;

/// Handwriting stored in the note's `.famd` companion.
///
/// PDF books, `.markdown` notes, and `.md` notes all share that companion.
/// The result is a drawing-library document whose `dataRelativePath` names
/// the companion, matching the Electron host.
pub fn read_famd_ink(host: &Host, relative: &str) -> Result<Value, String> {
    let note = vault::normalize_relative_path(relative, false, false)?;
    if !is_note_path(&note) {
        return Err("Es dürfen nur Markdown-Dateien, PDF-Notizen und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned());
    }
    let famd_relative = companion_note_path(&note, ".famd");
    let path = vault::resolve_note_file(vault_root(host)?, &famd_relative)?;
    let source = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(_) => return Err("Die Datei konnte nicht gelesen werden.".to_owned()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err("Die Notiz ist keine sichere reguläre Datei.".to_owned());
        }
        Ok(meta) if meta.len() as usize > MAX_FAMD_BYTES => {
            return Err("Die Datei ist zu groß.".to_owned());
        }
        Ok(_) => lossy_utf8(
            fs::read(&path).map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?,
        ),
    };
    let parsed = parse_famd(&source);
    let Some(payload) = parsed.payload else {
        return Ok(Value::Null);
    };
    let Some(ink) = payload.ink.as_ref().filter(|ink| ink.is_object()) else {
        return Ok(Value::Null);
    };
    let drawing_json = ink.to_string();
    let document = validate_drawing_json(&drawing_json)?;
    let marker = note_ink_marker_id(&parsed.markdown);
    let raw_id = document.get("id").and_then(Value::as_str);
    let metadata_id = if let Some(marker) = marker.clone() {
        Ok(marker)
    } else if let Some(raw_id) = raw_id {
        drawing_id(raw_id)
    } else {
        Ok(FAMD_INK_ID.to_owned())
    };
    if let Ok(id) = metadata_id {
        if let Ok(mut item) = library_metadata(&document, &id, Some(payload.updated_at.as_str())) {
            item["drawingJson"] = Value::String(drawing_json);
            item["dataRelativePath"] = Value::String(famd_relative);
            return Ok(item);
        }
    }
    let id = marker
        .or_else(|| raw_id.map(str::to_owned))
        .unwrap_or_else(|| FAMD_INK_ID.to_owned());
    let title = document
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Handschrift");
    Ok(json!({
        "id": id,
        "title": title,
        "updatedAt": payload.updated_at,
        "imageRelativePath": "",
        "dataRelativePath": famd_relative,
        "drawingJson": drawing_json,
    }))
}

fn is_note_path(relative: &str) -> bool {
    let lower = relative.to_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".famd")
        || lower.ends_with(".pdf")
}

pub(crate) fn note_ink_marker_id(markdown: &str) -> Option<String> {
    let mut rest = markdown;
    while let Some(start) = rest.find("<!--") {
        let after = rest[start + 4..].trim_start();
        if let Some(id) = ink_marker_at(after) {
            return Some(id);
        }
        rest = &rest[start + 4..];
    }
    None
}

fn ink_marker_at(after: &str) -> Option<String> {
    let after = after.strip_prefix("fanotes-ink:")?;
    let length = after
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
        .count();
    if !(1..=96).contains(&length) {
        return None;
    }
    let id = &after[..length];
    if after[length..].trim_start().starts_with("-->") {
        Some(id.to_owned())
    } else {
        None
    }
}

fn embed_in_note(host: &Host, note_path: &str, drawing: &Value) -> Result<(), String> {
    let vault_root = vault_root(host)?;
    let note = vault::normalize_relative_path(note_path, false, false)?;
    if !is_note_path(&note) {
        return Err("Es dürfen nur Markdown-Dateien, PDF-Notizen und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned());
    }
    let famd_relative = companion_note_path(&note, ".famd");
    let famd_path = vault::resolve_note_file(vault_root, &famd_relative)?;
    // A PDF note keeps its text in the companion. Other notes keep it in the
    // file the editor opened, including `.markdown`.
    let source_relative = if note.to_lowercase().ends_with(".pdf") {
        famd_relative
    } else {
        note
    };
    let source_path = vault::resolve_note_file(vault_root, &source_relative)?;
    let markdown = crate::notes::read_lossy_string(&source_path).unwrap_or_default();
    let body = strip_famd_payload(&markdown);
    let mut payload = crate::notes::read_lossy_string(&famd_path)
        .and_then(|source| parse_famd(&source).payload)
        .unwrap_or_else(|| empty_famd_payload(now_iso()));
    payload.ink = Some(drawing.clone());
    payload.updated_at = now_iso();
    payload.worksheets = worksheet_ids_from_markdown(&body);
    if payload.paper_style.is_none() {
        if let Some(style) = drawing.get("paperStyle").and_then(Value::as_str) {
            if is_paper_style(style) {
                payload.paper_style = Some(style.to_owned());
            }
        }
    }
    if let Some(parent) = famd_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    }
    crate::notes::atomic_write(
        &famd_path,
        serialize_famd(&body, &payload).as_bytes(),
        0o600,
    )?;
    Ok(())
}

fn metadata_from_json(
    drawing_json: &str,
    id: &str,
    fallback_time: Option<&str>,
) -> Result<Value, String> {
    let document = validate_drawing_json(drawing_json)?;
    library_metadata(&document, id, fallback_time)
}

fn metadata_value(document: &Value, id: &str) -> Result<Value, String> {
    library_metadata(document, id, Some(&now_iso()))
}

pub(crate) fn library_metadata(
    document: &Value,
    id: &str,
    fallback_time: Option<&str>,
) -> Result<Value, String> {
    let raw_title = document.get("title").and_then(Value::as_str).unwrap_or("");
    let title = raw_title.trim();
    if document.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        || title.is_empty()
        || crate::vault::utf16_len(raw_title) > 180
        || crate::vault::has_c0_or_del(raw_title)
        || !document.get("strokes").is_some_and(Value::is_array)
    {
        return Err("Die Zeichnungsdatei hat ein ungültiges Format.".to_owned());
    }
    let updated_at = document
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(canonical_iso)
        .or_else(|| fallback_time.and_then(canonical_iso))
        .ok_or_else(|| "Die Zeichnungsdatei enthält kein gültiges Änderungsdatum.".to_owned())?;
    Ok(json!({
        "id": id,
        "title": title,
        "updatedAt": updated_at,
        "imageRelativePath": format!(".fanotes/assets/{id}.png"),
        "dataRelativePath": format!(".fanotes/assets/{id}.json"),
    }))
}

fn validate_drawing_json(drawing_json: &str) -> Result<Value, String> {
    if drawing_json.len() > MAX_DRAWING_JSON_BYTES {
        return Err("Die Zeichnungsdaten sind ungültig oder zu groß.".to_owned());
    }
    let document: Value = serde_json::from_str(drawing_json)
        .map_err(|_| "Die Zeichnungsdaten sind kein gültiges JSON.".to_owned())?;
    if !document.is_object() {
        return Err("Die Zeichnungsdaten sind kein gültiges JSON.".to_owned());
    }
    Ok(document)
}

fn decode_png(image_data: &str) -> Result<Vec<u8>, String> {
    let encoded = image_data
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "Die Zeichnung ist keine gültige PNG-Data-URL.".to_owned())?;
    if encoded.len() % 4 != 0
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Die Zeichnung ist keine gültige PNG-Data-URL.".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Die Zeichnung ist keine gültige PNG-Data-URL.".to_owned())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Die Bilddaten sind keine gültige PNG-Datei.".to_owned());
    }
    Ok(bytes)
}

fn safe_title(value: &str) -> Result<String, String> {
    let name = value.trim().trim_end_matches(['.', ' ']).trim();
    if name.is_empty()
        || crate::vault::utf16_len(name) > 180
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || crate::vault::has_c0_or_del(name)
        || name.eq_ignore_ascii_case(".fanotes")
        || name.eq_ignore_ascii_case(".lernwerk")
    {
        return Err("Dieser Name ist nicht erlaubt.".to_owned());
    }
    Ok(name.to_owned())
}

fn drawing_file_id(name: &str) -> Option<&str> {
    let (id, extension) = name.rsplit_once('.')?;
    extension
        .eq_ignore_ascii_case("json")
        .then_some(id)
        .filter(|id| drawing_id(id).is_ok())
}

fn drawing_id(value: &str) -> Result<String, String> {
    let ok = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if ok {
        Ok(value.to_owned())
    } else {
        Err("Ungültige Zeichnungs-ID.".to_owned())
    }
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Ungültige Zeichnungs-ID.".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn assets_dir(vault_root: &Path) -> Result<PathBuf, String> {
    let internal = crate::vault::ensure_internal_directory(vault_root)
        .map_err(|_| "Der interne Asset-Ordner ist unsicher.".to_owned())?;
    let assets = internal.join("assets");
    ensure_private_dir(&assets)?;
    Ok(assets)
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            Err("Der interne Asset-Ordner ist unsicher.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(_) => {
            fs::create_dir_all(path)
                .map_err(|_| "Der interne Asset-Ordner ist unsicher.".to_owned())?;
            Ok(())
        }
    }
}

/// Node `Buffer.toString('utf8')`: invalid bytes become U+FFFD and the rest stays.
fn lossy_utf8(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

fn read_limited(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() as usize > max {
        return Err("Die Datei ist ungültig oder zu groß.".to_owned());
    }
    fs::read(path).map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())
}

fn now_iso() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs();
    let millis = elapsed.subsec_millis();
    let days = secs / 86_400;
    let time = secs % 86_400;
    let (year, month, day) = civil_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

fn civil_date(mut days: u64) -> (i32, u32, u32) {
    let mut year = 1970i32;
    loop {
        let year_days = if is_leap(year) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let months = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for length in months {
        if days < length {
            return (year, month, days as u32 + 1);
        }
        days -= length;
        month += 1;
    }
    (year, 12, 31)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// `Date.parse` plus `toISOString`: a zoned timestamp becomes UTC with milliseconds.
pub(crate) fn canonical_iso(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
    {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: i32 = value.get(5..7)?.parse().ok()?;
    let day: i32 = value.get(8..10)?.parse().ok()?;
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let hour: i32 = value.get(11..13)?.parse().ok()?;
    let minute: i32 = value.get(14..16)?.parse().ok()?;
    let second: i32 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month as u32) as i32
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0u32;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start || index - start > 9 {
            return None;
        }
        let digits = value.get(start..index)?;
        let parsed: u32 = digits.parse().ok()?;
        millis = if digits.len() >= 3 {
            parsed / 10u32.pow((digits.len() - 3) as u32)
        } else {
            parsed * 10u32.pow((3 - digits.len()) as u32)
        };
    }
    let rest = value.get(index..)?;
    let offset_minutes = if rest == "Z" {
        0
    } else if rest.len() == 6
        && (rest.starts_with('+') || rest.starts_with('-'))
        && rest.as_bytes().get(3) == Some(&b':')
    {
        let sign = if rest.starts_with('+') { 1 } else { -1 };
        let offset_hour: i32 = rest.get(1..3)?.parse().ok()?;
        let offset_minute: i32 = rest.get(4..6)?.parse().ok()?;
        if !(0..=23).contains(&offset_hour) || !(0..=59).contains(&offset_minute) {
            return None;
        }
        sign * (offset_hour * 60 + offset_minute)
    } else {
        return None;
    };
    let (year, month, day, hour, minute) =
        shift_minutes(year, month, day, hour, minute, offset_minutes)?;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

fn shift_minutes(
    mut year: i32,
    mut month: i32,
    mut day: i32,
    hour: i32,
    minute: i32,
    offset_minutes: i32,
) -> Option<(i32, u32, u32, u32, u32)> {
    let mut total = hour * 60 + minute - offset_minutes;
    while total < 0 {
        total += 24 * 60;
        day -= 1;
        if day < 1 {
            month -= 1;
            if month < 1 {
                month = 12;
                year -= 1;
            }
            day = days_in_month(year, month as u32) as i32;
        }
    }
    while total >= 24 * 60 {
        total -= 24 * 60;
        day += 1;
        let length = days_in_month(year, month as u32) as i32;
        if day > length {
            day = 1;
            month += 1;
            if month > 12 {
                month = 1;
                year += 1;
            }
        }
    }
    if !(0..10_000).contains(&year) || day < 1 {
        return None;
    }
    Some((
        year,
        month as u32,
        day as u32,
        (total / 60) as u32,
        (total % 60) as u32,
    ))
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

#[cfg(test)]
mod tests {
    use super::canonical_iso;

    #[test]
    fn drawing_dates_become_utc_with_milliseconds() {
        assert_eq!(
            canonical_iso("2026-01-02T03:04:05.000Z").as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02T03:04:05Z").as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            canonical_iso("2020-06-01T12:00:00+02:00").as_deref(),
            Some("2020-06-01T10:00:00.000Z")
        );
        assert_eq!(
            canonical_iso("2020-01-01T01:00:00+02:00").as_deref(),
            Some("2019-12-31T23:00:00.000Z")
        );
        assert_eq!(canonical_iso("2020-02-31T00:00:00Z"), None);
    }
}
