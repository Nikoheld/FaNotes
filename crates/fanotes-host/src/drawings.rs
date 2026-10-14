//! Drawing library files under `.fanotes/assets`, matching the Electron host.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use fanotes_famd::{
    companion_note_path, empty_famd_payload, is_js_whitespace, is_paper_style, parse_famd,
    serialize_famd, strip_famd_payload, worksheet_ids_from_markdown,
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
    // Desktop `readdir` throws. An unlistable library is not an empty list.
    let entries = crate::read_sibling_dir(&assets)?;
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
    let bytes =
        read_limited(&path, MAX_DRAWING_JSON_BYTES).map_err(|_| drawing_read_error(&path))?;
    let drawing_json = lossy_utf8(bytes);
    let mtime = fs::symlink_metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(crate::notes::iso_from_system_time);
    // The desktop read handler reports one message for every failure after the file is found.
    let mut item =
        metadata_from_json(&drawing_json, &id, mtime.as_deref()).map_err(|_| damaged_drawing())?;
    item["drawingJson"] = Value::String(drawing_json);
    Ok(item)
}

pub fn save_drawing(host: &Host, payload: &Value) -> Result<Value, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Ungültige Zeichnung.".to_owned())?;
    let id = match object.get("id") {
        None | Some(Value::Null) => random_id()?,
        Some(Value::String(id)) if id.is_empty() => random_id()?,
        Some(Value::String(id)) => drawing_id(id)?,
        Some(_) => return Err("Ungültige Zeichnungs-ID.".to_owned()),
    };
    let title = safe_title(object.get("title").and_then(Value::as_str).unwrap_or(""))?;
    // Desktop decodes a present image before it parses the drawing JSON.
    let png = if object.contains_key("imageData") {
        let image = object
            .get("imageData")
            .and_then(Value::as_str)
            .ok_or_else(|| "Die Zeichnung enthält kein PNG.".to_owned())?;
        Some(decode_png(image)?)
    } else {
        None
    };
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
    if let Some(png) = png {
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
        if !vault::js_trim(note).is_empty() {
            embed_in_note(host, note, &document).map_err(|error| {
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
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
        }
        Ok(meta) if !meta.is_file() => {
            return Err("Die gewählte Datei ist keine reguläre Datei.".to_owned());
        }
        Ok(meta) if meta.len() as usize > MAX_FAMD_BYTES => {
            return Err("Die Datei ist zu groß.".to_owned());
        }
        Ok(_) => lossy_utf8(
            fs::read(&path).map_err(|error| crate::notes::node_open_error(&path, &error))?,
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
    matches!(
        crate::vault::posix_extname_en_us(relative).as_str(),
        ".md" | ".markdown" | ".famd" | ".pdf"
    )
}

pub(crate) fn note_ink_marker_id(markdown: &str) -> Option<String> {
    let mut rest = markdown;
    while let Some(start) = rest.find("<!--") {
        let after = skip_js_whitespace(&rest[start + 4..]);
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
    if skip_js_whitespace(&after[length..]).starts_with("-->") {
        Some(id.to_owned())
    } else {
        None
    }
}

fn skip_js_whitespace(value: &str) -> &str {
    let mut rest = value;
    while let Some(character) = rest.chars().next() {
        if !is_js_whitespace(character) {
            break;
        }
        rest = &rest[character.len_utf8()..];
    }
    rest
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
    let markdown = crate::notes::read_optional_text(&source_path)?.unwrap_or_default();
    let body = strip_famd_payload(&markdown);
    let mut payload = match crate::notes::read_optional_text(&famd_path)? {
        Some(source) => parse_famd(&source)
            .payload
            .unwrap_or_else(|| empty_famd_payload(now_iso())),
        None => empty_famd_payload(now_iso()),
    };
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
    // The desktop uses the settings paper after the drawing's own style.
    if payload.paper_style.is_none() {
        if let Some(style) = host
            .settings
            .get("paperStyle")
            .and_then(Value::as_str)
            .filter(|style| is_paper_style(style))
        {
            payload.paper_style = Some(style.to_owned());
        }
    }
    // Desktop `realpath` of the companion parent runs before the embed write.
    crate::notes::require_parent_directory(&famd_path)?;
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
    let title = vault::js_trim(raw_title);
    // `schemaVersion !== 1` treats `1.0` as the same version.
    if document.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
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

fn drawing_read_error(path: &Path) -> String {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            "Die gespeicherte Zeichnung wurde nicht gefunden.".to_owned()
        }
        _ => damaged_drawing(),
    }
}

fn damaged_drawing() -> String {
    "Die gespeicherte Zeichnung ist beschädigt oder kann nicht sicher gelesen werden.".to_owned()
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
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Die Zeichnung ist leer oder zu groß.".to_owned());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Die Bilddaten sind keine gültige PNG-Datei.".to_owned());
    }
    Ok(bytes)
}

fn safe_title(value: &str) -> Result<String, String> {
    super::safe_entry_name_or(value, "Zeichnung")
}

fn drawing_file_id(name: &str) -> Option<&str> {
    let (id, extension) = name.rsplit_once('.')?;
    // The library opens `${id}.json`. `Upper.JSON` is not that file.
    (extension == "json")
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

pub(crate) fn assets_dir(vault_root: &Path) -> Result<PathBuf, String> {
    let internal = crate::vault::ensure_internal_directory(vault_root)?;
    let assets = internal.join("assets");
    ensure_private_dir(&assets)?;
    let root_real = fs::canonicalize(vault_root)
        .map_err(|_| "Der interne Asset-Ordner verlässt den Vault.".to_owned())?;
    let real = fs::canonicalize(&assets)
        .map_err(|_| "Der interne Asset-Ordner verlässt den Vault.".to_owned())?;
    if !crate::vault::is_inside_root(&root_real, &real) {
        return Err("Der interne Asset-Ordner verlässt den Vault.".to_owned());
    }
    Ok(assets)
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    let unsafe_dir = || "Der interne Asset-Ordner ist unsicher.".to_owned();
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => Err(unsafe_dir()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| unsafe_dir())?;
            // Desktop `mkdir` uses mode `0o700`, then checks the created directory.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                    .map_err(|_| unsafe_dir())?;
            }
            let created = fs::symlink_metadata(path).map_err(|_| unsafe_dir())?;
            if created.file_type().is_symlink() || !created.is_dir() {
                return Err(unsafe_dir());
            }
            Ok(())
        }
        Err(_) => Err(unsafe_dir()),
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

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
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

/// `Date.parse` plus `toISOString`: a zoned timestamp becomes UTC with milliseconds.
pub(crate) fn canonical_iso(value: &str) -> Option<String> {
    fanotes_famd::canonical_iso(value)
}

#[cfg(test)]
mod tests {
    use super::{canonical_iso, note_ink_marker_id};

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
        assert_eq!(
            canonical_iso("2020-02-31T00:00:00Z").as_deref(),
            Some("2020-03-02T00:00:00.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02").as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        assert_eq!(
            canonical_iso("2026-1-2").as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        assert_eq!(
            canonical_iso(" 2026-01-2 ").as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        assert_eq!(
            canonical_iso("2026-2-31").as_deref(),
            Some("2026-03-03T00:00:00.000Z")
        );
        assert_eq!(canonical_iso("2026-1-2T00:00:00Z"), None);
        assert_eq!(
            canonical_iso("2026-01-02T03:04Z").as_deref(),
            Some("2026-01-02T03:04:00.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02t03:04z").as_deref(),
            Some("2026-01-02T03:04:00.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02T03:04+02:00").as_deref(),
            Some("2026-01-02T01:04:00.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02T24:00Z").as_deref(),
            Some("2026-01-03T00:00:00.000Z")
        );
        assert_eq!(canonical_iso("2026-01-02T24:01Z"), None);
        assert_eq!(canonical_iso("2026-01-02T03:04.1Z"), None);
        assert_eq!(canonical_iso("2026-01-02T3:04:05Z"), None);
        assert_eq!(canonical_iso(" 2026-01-02T03:04Z"), None);
        assert_eq!(
            canonical_iso("2026-02-31").as_deref(),
            Some("2026-03-03T00:00:00.000Z")
        );
        assert_eq!(canonical_iso("2026-01-32"), None);
        assert_eq!(
            canonical_iso("2026-01-02T24:00:00Z").as_deref(),
            Some("2026-01-03T00:00:00.000Z")
        );
        assert_eq!(canonical_iso("2026-01-02T24:00:01Z"), None);
        assert_eq!(
            canonical_iso("2026-01-02T03:04:05.1Z").as_deref(),
            Some("2026-01-02T03:04:05.100Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02T03:04:05.12Z").as_deref(),
            Some("2026-01-02T03:04:05.120Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02T03:04:05.1234Z").as_deref(),
            Some("2026-01-02T03:04:05.123Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02T03:04:05+0000").as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02t03:04:05z").as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            canonical_iso("2026-01-02 03:04:05Z").as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            canonical_iso("2026-04-31T00:00:00Z").as_deref(),
            Some("2026-05-01T00:00:00.000Z")
        );
        assert_eq!(canonical_iso("2026-01-02T03:04:60Z"), None);
        assert_eq!(canonical_iso("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn an_ink_marker_uses_javascript_whitespace() {
        assert_eq!(
            note_ink_marker_id("<!--\u{FEFF}fanotes-ink:abc\u{FEFF}-->").as_deref(),
            Some("abc")
        );
        assert_eq!(
            note_ink_marker_id("<!--\u{0085}fanotes-ink:abc-->").as_deref(),
            None
        );
        assert_eq!(
            note_ink_marker_id("<!--fanotes-ink:abc\u{0085}-->").as_deref(),
            None
        );
        assert_eq!(
            note_ink_marker_id("<!-- fanotes-ink:marker1 -->").as_deref(),
            Some("marker1")
        );
    }
}
