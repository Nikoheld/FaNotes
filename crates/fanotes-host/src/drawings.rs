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
        if !name.ends_with(".json") {
            continue;
        }
        let id = name.trim_end_matches(".json");
        if drawing_id(id).is_err() {
            continue;
        }
        let path = assets.join(format!("{id}.json"));
        let Ok(text) = read_limited(&path, MAX_DRAWING_JSON_BYTES) else {
            continue;
        };
        let Ok(text) = String::from_utf8(text) else {
            continue;
        };
        if let Ok(item) = metadata_from_json(&text, id) {
            drawings.push(item);
        }
    }
    drawings.sort_by(|left, right| {
        right["updatedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(left["updatedAt"].as_str().unwrap_or(""))
            .then_with(|| {
                left["title"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(right["title"].as_str().unwrap_or(""))
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
    let drawing_json = String::from_utf8(bytes)
        .map_err(|_| "Die Zeichnungsdaten sind kein gültiges JSON.".to_owned())?;
    let mut item = metadata_from_json(&drawing_json, &id)?;
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
        fs::write(assets.join(format!("{id}.png")), png)
            .map_err(|_| "Die Zeichnung konnte nicht gespeichert werden.".to_owned())?;
    }
    fs::write(assets.join(format!("{id}.json")), drawing_json)
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

fn embed_in_note(host: &Host, note_path: &str, drawing: &Value) -> Result<(), String> {
    let vault_root = vault_root(host)?;
    let note = vault::normalize_relative_path(note_path, false, false)?;
    let markdown_path = vault::resolve_inside(vault_root, &companion_note_path(&note, ".md"))?;
    let famd_relative = companion_note_path(&note, ".famd");
    let famd_path = vault::resolve_inside(vault_root, &famd_relative)?;
    let markdown = fs::read_to_string(&markdown_path).unwrap_or_default();
    let body = strip_famd_payload(&markdown);
    let mut payload = fs::read_to_string(&famd_path)
        .ok()
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
    fs::write(famd_path, serialize_famd(&body, &payload))
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
    let _ = markdown_path;
    Ok(())
}

fn metadata_from_json(drawing_json: &str, id: &str) -> Result<Value, String> {
    let document = validate_drawing_json(drawing_json)?;
    metadata_value(&document, id)
}

fn metadata_value(document: &Value, id: &str) -> Result<Value, String> {
    let title = document
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if document.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        || title.is_empty()
        || title.len() > 180
        || title.chars().any(|character| character.is_control())
        || !document.get("strokes").is_some_and(Value::is_array)
    {
        return Err("Die Zeichnungsdatei hat ein ungültiges Format.".to_owned());
    }
    let updated_at = document
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|value| chrono_like(value))
        .map(str::to_owned)
        .unwrap_or_else(now_iso);
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
        || name.len() > 180
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|character| character.is_control())
        || name.eq_ignore_ascii_case(".fanotes")
        || name.eq_ignore_ascii_case(".lernwerk")
    {
        return Err("Dieser Name ist nicht erlaubt.".to_owned());
    }
    Ok(name.to_owned())
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
    let internal = vault_root.join(".fanotes");
    ensure_private_dir(&internal)?;
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

fn chrono_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && value.ends_with('Z')
}
