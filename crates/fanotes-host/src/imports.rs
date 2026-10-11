//! PDF note and subject-book imports.
//!
//! A file dialog supplies the bytes when the renderer only names a folder.
//! Tests and callers that already have the file pass `{ name, bytesBase64 }`.

use std::fs;
use std::path::{Path, PathBuf};

use fanotes_famd::{companion_note_path, empty_famd_payload, serialize_famd};
use serde_json::{json, Value};

use crate::vault;
use crate::worksheets::{decode_payload_bytes, import_named_bytes};
use crate::Host;

pub fn import_worksheet(host: &Host) -> Result<Value, String> {
    let Some(path) = pick_file(
        host,
        "Bild oder PDF als Arbeitsblatt importieren",
        &["pdf", "png", "jpg", "jpeg", "webp", "gif"],
    )?
    else {
        return Ok(Value::Null);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Bild.png");
    let bytes = fs::read(&path).map_err(|_| "Das ausgewählte Arbeitsblatt ist leer.".to_owned())?;
    let extension = match name.rsplit_once('.') {
        Some((_, extension)) if !extension.is_empty() => {
            format!(".{}", extension.to_ascii_lowercase())
        }
        _ => ".png".to_owned(),
    };
    import_named_bytes(host, name, &extension, &bytes)
}

pub fn import_pdf_note(host: &Host, args: &[Value]) -> Result<Value, String> {
    let parent = args.first().and_then(Value::as_str).unwrap_or("");
    if let Some(payload) = args.get(1).filter(|value| value.is_object()) {
        return import_pdf_payload(host, parent, payload);
    }
    let Some(path) = pick_file(host, "PDF als Notiz importieren", &["pdf"])? else {
        return Ok(Value::Null);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("PDF-Notiz.pdf");
    let bytes = fs::read(&path).map_err(|_| "Die ausgewählte PDF-Datei ist leer.".to_owned())?;
    import_pdf_payload(host, parent, &json!({ "name": name, "bytes": bytes }))
}

pub fn import_subject_book(host: &Host, args: &[Value]) -> Result<Value, String> {
    let subject = args.first().and_then(Value::as_str).unwrap_or("").trim();
    if subject.is_empty() {
        return Err("Wähle zuerst ein Fach für das Buch.".to_owned());
    }
    if let Some(payload) = args.get(1).filter(|value| value.is_object()) {
        return import_pdf_payload(host, subject, payload);
    }
    let Some(path) = pick_file(host, "PDF-Buch zum Fach hinzufügen", &["pdf"])? else {
        return Ok(Value::Null);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Buch.pdf");
    let bytes = fs::read(&path).map_err(|_| "Die ausgewählte PDF-Datei ist leer.".to_owned())?;
    import_pdf_payload(host, subject, &json!({ "name": name, "bytes": bytes }))
}

fn import_pdf_payload(host: &Host, parent: &str, payload: &Value) -> Result<Value, String> {
    let root = vault_root(host)?.to_path_buf();
    let parent_relative = if parent.trim().is_empty() {
        String::new()
    } else {
        vault::normalize_relative_path(parent, true, false)?
    };
    let parent_path = if parent_relative.is_empty() {
        root.clone()
    } else {
        let path = vault::resolve_existing_entry(&root, &parent_relative)?;
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| "Der Zielordner wurde nicht gefunden.".to_owned())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Der Zielordner wurde nicht gefunden.".to_owned());
        }
        path
    };
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("PDF-Notiz.pdf");
    if !name.to_ascii_lowercase().ends_with(".pdf") && payload.get("name").is_some() {
        return Err("Es können nur PDF-Dateien als PDF-Notiz importiert werden.".to_owned());
    }
    let bytes = decode_payload_bytes(payload, 96 * 1024 * 1024)?;
    if bytes.is_empty() {
        return Err("Die ausgewählte PDF-Datei ist leer.".to_owned());
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(
            "Die ausgewählte Datei stimmt nicht mit ihrem Bild- oder PDF-Format überein."
                .to_owned(),
        );
    }
    let stem = safe_stem(file_stem(name), "PDF-Notiz")?;
    let desired = format!("{stem}.pdf");
    let candidate = unique_pdf_name(&parent_path, &desired)?;
    let absolute = parent_path.join(&candidate);
    write_new(&absolute, &bytes)?;
    let relative = if parent_relative.is_empty() {
        candidate.clone()
    } else {
        format!("{parent_relative}/{candidate}")
    };
    let famd_relative = companion_note_path(&relative, ".famd");
    if let Ok(famd_path) = vault::resolve_inside(&root, &famd_relative) {
        let _ = crate::notes::atomic_write(
            &famd_path,
            serialize_famd("", &empty_famd_payload(now_iso())).as_bytes(),
            0o600,
        );
    }
    let meta = fs::symlink_metadata(&absolute)
        .map_err(|_| "Die PDF-Datei konnte nicht gespeichert werden.".to_owned())?;
    Ok(json!({
        "relativePath": relative,
        "entry": {
            "name": candidate,
            "relativePath": relative,
            "kind": "file",
            "extension": "pdf",
            "modifiedAt": now_iso(),
            "size": meta.len(),
        }
    }))
}

fn unique_pdf_name(directory: &Path, desired: &str) -> Result<String, String> {
    let mut occupied = std::collections::HashSet::new();
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                occupied.insert(name.to_lowercase());
            }
        }
    }
    let (stem, extension) = desired
        .rsplit_once('.')
        .map(|(stem, extension)| (stem.to_owned(), format!(".{extension}")))
        .unwrap_or_else(|| (desired.to_owned(), String::new()));
    for number in 1..=10_000 {
        let candidate = if number == 1 {
            desired.to_owned()
        } else {
            format!("{stem} {number}{extension}")
        };
        let famd = format!(
            "{}.famd",
            candidate
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .unwrap_or(candidate.as_str())
        );
        if occupied.contains(&candidate.to_lowercase()) || occupied.contains(&famd.to_lowercase()) {
            continue;
        }
        return Ok(candidate);
    }
    Err("Es konnte kein eindeutiger PDF-Name erzeugt werden.".to_owned())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match crate::notes::publish_new_file(path, bytes, 0o600) {
        Ok(()) => Ok(()),
        Err(crate::notes::NewFileError::Exists) => {
            Err("Es konnte kein eindeutiger PDF-Name erzeugt werden.".to_owned())
        }
        Err(crate::notes::NewFileError::Io) => {
            Err("Die PDF-Datei konnte nicht gespeichert werden.".to_owned())
        }
    }
}

fn pick_file(host: &Host, title: &str, extensions: &[&str]) -> Result<Option<PathBuf>, String> {
    if !host.file_dialogs {
        return Err("Die Dateiauswahl ist in dieser Sitzung nicht verfügbar.".to_owned());
    }
    Ok(rfd::FileDialog::new()
        .set_title(title)
        .add_filter("Dateien", extensions)
        .pick_file())
}

fn vault_root(host: &Host) -> Result<&Path, String> {
    host.vault
        .as_deref()
        .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())
}

fn file_stem(name: &str) -> &str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|stem| !stem.is_empty())
        .unwrap_or(base)
}

fn safe_stem(value: &str, fallback: &str) -> Result<String, String> {
    let raw = value.trim();
    let name = if raw.is_empty() { fallback } else { raw };
    let cleaned = name.trim_end_matches(['.', ' ']).trim();
    if cleaned.is_empty()
        || cleaned.len() > 180
        || cleaned == "."
        || cleaned == ".."
        || cleaned.contains('/')
        || cleaned.contains('\\')
        || cleaned.chars().any(|character| character.is_control())
        || cleaned.eq_ignore_ascii_case(".fanotes")
        || cleaned.eq_ignore_ascii_case(".lernwerk")
    {
        Err("Dieser Name ist nicht erlaubt.".to_owned())
    } else {
        Ok(cleaned.to_owned())
    }
}

fn now_iso() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
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
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}
