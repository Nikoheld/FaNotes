//! Note companions, subject books, and local history.
//!
//! Paper style, links, backups, and page stats live in the `.famd` sidecar.
//! Subject books live in `.fanotes/subject-books.json`. History snapshots live
//! under `.fanotes/history`, keyed by the same SHA-1 as the Electron host.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fanotes_famd::{
    companion_note_path, empty_famd_payload, is_paper_style, parse_famd, parse_note_backups,
    parse_note_links, serialize_famd, strip_famd_payload, worksheet_ids_from_markdown, FamdPayload,
    NoteBackup, NoteLink,
};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use crate::vault;
use crate::Host;

const MAX_SUBJECT_BOOK_BYTES: usize = 512 * 1024;
const MAX_BOOKS: usize = 200;
const MAX_PATH: usize = 500;
const HISTORY_LIMIT: usize = 30;
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

pub fn records_history(relative: &str) -> bool {
    let lower = relative.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

pub fn is_note_text(relative: &str) -> bool {
    let lower = relative.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".famd")
}

pub fn write_note_file(
    root: &Path,
    relative: &str,
    content: &str,
    settings_paper: Option<&str>,
) -> Result<String, String> {
    let is_famd = relative.to_lowercase().ends_with(".famd");
    let body = strip_famd_payload(content);
    let markdown = if body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    };
    if !is_famd {
        let path = vault::resolve_inside(root, relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
        }
        fs::write(&path, &markdown)
            .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
    }
    attach_sidecar(root, relative, content, settings_paper)?;
    Ok(now_iso())
}

pub fn attach_sidecar(
    root: &Path,
    relative: &str,
    content: &str,
    settings_paper: Option<&str>,
) -> Result<(), String> {
    let famd_relative = companion_note_path(relative, ".famd");
    let famd_path = vault::resolve_inside(root, &famd_relative)?;
    let existing = fs::read_to_string(&famd_path)
        .ok()
        .map(|source| parse_famd(&source))
        .unwrap_or_else(|| parse_famd(""));
    let incoming = parse_famd(content);
    let body = if incoming.markdown.is_empty() {
        strip_famd_payload(content)
    } else {
        incoming.markdown
    };
    let mut payload = existing
        .payload
        .unwrap_or_else(|| empty_famd_payload(now_iso()));
    if let Some(incoming_payload) = incoming.payload {
        if incoming_payload.ink.as_ref().is_some_and(Value::is_object) {
            payload.ink = incoming_payload.ink;
        }
        if payload.paper_style.is_none() {
            payload.paper_style = incoming_payload.paper_style;
        }
        if incoming_payload.page_stats.is_some() {
            payload.page_stats = incoming_payload.page_stats;
        }
    }
    if payload.paper_style.is_none() {
        if let Some(style) = payload
            .ink
            .as_ref()
            .and_then(|ink| ink.get("paperStyle"))
            .and_then(Value::as_str)
            .filter(|style| is_paper_style(style))
        {
            payload.paper_style = Some(style.to_owned());
        }
    }
    if payload.paper_style.is_none() {
        if let Some(style) = settings_paper.filter(|style| is_paper_style(style)) {
            payload.paper_style = Some(style.to_owned());
        }
    }
    payload.updated_at = now_iso();
    payload.worksheets = worksheet_ids_from_markdown(&body);
    if let Some(parent) = famd_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    }
    fs::write(&famd_path, serialize_famd(&body, &payload))
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
    if relative.to_lowercase().ends_with(".famd") {
        let markdown_relative = companion_note_path(relative, ".md");
        if let Ok(markdown_path) = vault::resolve_inside(root, &markdown_relative) {
            if markdown_path.is_file() {
                let text = if body.ends_with('\n') {
                    body
                } else {
                    format!("{body}\n")
                };
                fs::write(markdown_path, text)
                    .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
            }
        }
    }
    Ok(())
}

pub fn read_page_stats(host: &Host, relative: &str) -> Result<Value, String> {
    let (_path, _body, payload) = load_note(host, relative)?;
    Ok(payload
        .page_stats
        .map(|stats| stats.to_value())
        .unwrap_or(Value::Null))
}

pub fn read_paper_style(host: &Host, relative: &str) -> Result<Value, String> {
    let (_path, _body, payload) = load_note(host, relative)?;
    if let Some(style) = payload
        .paper_style
        .as_deref()
        .filter(|style| is_paper_style(style))
    {
        return Ok(Value::String(style.to_owned()));
    }
    let ink_style = payload
        .ink
        .as_ref()
        .and_then(|ink| ink.get("paperStyle"))
        .and_then(Value::as_str)
        .filter(|style| is_paper_style(style));
    Ok(ink_style
        .map(|style| Value::String(style.to_owned()))
        .unwrap_or(Value::Null))
}

pub fn set_paper_style(host: &Host, relative: &str, paper_style: &str) -> Result<Value, String> {
    if !is_paper_style(paper_style) {
        return Err("Diese Papierart wird nicht unterstützt.".to_owned());
    }
    let (path, body, mut payload) = load_note(host, relative)?;
    payload.paper_style = Some(paper_style.to_owned());
    if let Some(object) = payload.ink.as_mut().and_then(Value::as_object_mut) {
        object.insert("paperStyle".into(), Value::String(paper_style.to_owned()));
    }
    store_note(&path, &body, &payload)?;
    Ok(Value::String(paper_style.to_owned()))
}

pub fn read_links(host: &Host, relative: &str) -> Result<Value, String> {
    let (_path, _body, payload) = load_note(host, relative)?;
    Ok(Value::Array(
        payload.note_links.iter().map(NoteLink::to_json).collect(),
    ))
}

pub fn write_links(host: &Host, relative: &str, raw: &Value) -> Result<Value, String> {
    let note = note_path(relative)?;
    let mut links = parse_note_links(raw);
    for link in &mut links {
        link.source_path = note.clone();
    }
    let links = parse_note_links(&Value::Array(links.iter().map(NoteLink::to_json).collect()));
    let (path, body, mut payload) = load_note(host, &note)?;
    payload.note_links = links;
    store_note(&path, &body, &payload)?;
    Ok(Value::Array(
        payload.note_links.iter().map(NoteLink::to_json).collect(),
    ))
}

pub fn read_backups(host: &Host, relative: &str) -> Result<Value, String> {
    let (_path, _body, payload) = load_note(host, relative)?;
    Ok(Value::Array(
        payload
            .note_backups
            .iter()
            .map(NoteBackup::to_json)
            .collect(),
    ))
}

pub fn write_backups(host: &Host, relative: &str, raw: &Value) -> Result<Value, String> {
    let note = note_path(relative)?;
    let mut backups = parse_note_backups(raw);
    for backup in &mut backups {
        backup.note_path = note.clone();
    }
    let backups = parse_note_backups(&Value::Array(
        backups.iter().map(NoteBackup::to_json).collect(),
    ));
    let (path, body, mut payload) = load_note(host, &note)?;
    payload.note_backups = backups;
    store_note(&path, &body, &payload)?;
    Ok(Value::Array(
        payload
            .note_backups
            .iter()
            .map(NoteBackup::to_json)
            .collect(),
    ))
}

pub fn read_subject_books(host: &Host) -> Result<Value, String> {
    let path = books_path(vault_root(host)?)?;
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return Ok(json!([]));
    };
    if meta.file_type().is_symlink()
        || !meta.is_file()
        || meta.len() as usize > MAX_SUBJECT_BOOK_BYTES
    {
        return Err("Die Fachbuch-Liste ist ungültig oder zu groß.".to_owned());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|_| "Die Fachbuch-Liste ist ungültig oder zu groß.".to_owned())?;
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Ok(json!([]));
    };
    let books = parsed.get("books").unwrap_or(&parsed);
    Ok(Value::Array(parse_subject_books(books)))
}

pub fn write_subject_books(host: &Host, raw: &Value) -> Result<Value, String> {
    let books = parse_subject_books(raw);
    let snapshot = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({ "version": 1, "books": books })).unwrap_or_default()
    );
    if snapshot.len() > MAX_SUBJECT_BOOK_BYTES {
        return Err("Zu viele Fachbücher für diesen Vault.".to_owned());
    }
    let path = books_path(vault_root(host)?)?;
    atomic_write(&path, snapshot.as_bytes(), 0o600)?;
    Ok(Value::Array(books))
}

pub fn list_history(host: &Host, relative: &str) -> Result<Value, String> {
    let note = markdown_path(relative)?;
    let directory = history_dir(vault_root(host)?, &note)?;
    let index = read_history_index(&directory)?;
    let snapshots = index
        .get("snapshots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(Value::Array(snapshots.into_iter().rev().collect()))
}

pub fn read_history(host: &Host, relative: &str, snapshot_id: &str) -> Result<Value, String> {
    if !is_snapshot_id(snapshot_id) {
        return Err("Ungültiger Verlaufseintrag.".to_owned());
    }
    let note = markdown_path(relative)?;
    let directory = history_dir(vault_root(host)?, &note)?;
    let index = read_history_index(&directory)?;
    let entry = index
        .get("snapshots")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(snapshot_id))
                .cloned()
        })
        .ok_or_else(|| "Dieser Verlaufseintrag existiert nicht mehr.".to_owned())?;
    let content = fs::read_to_string(directory.join(format!("{snapshot_id}.md")))
        .map_err(|_| "Dieser Verlaufseintrag existiert nicht mehr.".to_owned())?;
    Ok(json!({
        "id": snapshot_id,
        "createdAt": entry.get("createdAt").and_then(Value::as_str).unwrap_or(""),
        "content": content,
    }))
}

pub fn record_history(vault_root: &Path, relative: &str, content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Ok(());
    }
    let bytes = content.len();
    if bytes == 0 || bytes > MAX_SNAPSHOT_BYTES {
        return Ok(());
    }
    let directory = history_dir(vault_root, relative)?;
    fs::create_dir_all(&directory)
        .map_err(|_| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?;
    let mut index = read_history_index(&directory)?;
    if let Some(last) = index
        .get("snapshots")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
    {
        if fs::read_to_string(directory.join(format!("{last}.md")))
            .ok()
            .as_deref()
            == Some(content)
        {
            return Ok(());
        }
    }
    let created_at = now_iso();
    let id = format!(
        "{}-{}",
        created_at.replace([':', '.'], "-"),
        random_suffix()?
    );
    let snapshot_path = directory.join(format!("{id}.md"));
    fs::write(&snapshot_path, content)
        .map_err(|_| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?;
    index["path"] = Value::String(relative.to_owned());
    index["format"] = Value::String("fanotes-history-v1".to_owned());
    index
        .as_object_mut()
        .ok_or_else(|| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?
        .entry("snapshots")
        .or_insert_with(|| json!([]));
    index["snapshots"]
        .as_array_mut()
        .ok_or_else(|| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?
        .push(json!({ "id": id, "createdAt": created_at, "bytes": bytes }));
    if atomic_write(
        &directory.join("index.json"),
        format!("{}\n", index).as_bytes(),
        0o600,
    )
    .is_err()
    {
        let _ = fs::remove_file(&snapshot_path);
        return Err("Der Verlauf konnte nicht gespeichert werden.".to_owned());
    }
    trim_history(&directory, &mut index)?;
    Ok(())
}

fn trim_history(directory: &Path, index: &mut Value) -> Result<(), String> {
    let Some(snapshots) = index.get_mut("snapshots").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    if snapshots.len() <= HISTORY_LIMIT {
        return Ok(());
    }
    let removed: Vec<Value> = snapshots
        .drain(0..snapshots.len() - HISTORY_LIMIT)
        .collect();
    if atomic_write(
        &directory.join("index.json"),
        format!("{}\n", index).as_bytes(),
        0o600,
    )
    .is_err()
    {
        return Ok(());
    }
    for entry in removed {
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            if is_snapshot_id(id) {
                let _ = fs::remove_file(directory.join(format!("{id}.md")));
            }
        }
    }
    Ok(())
}

fn load_note(host: &Host, relative: &str) -> Result<(PathBuf, String, FamdPayload), String> {
    let root = vault_root(host)?;
    let note = note_path(relative)?;
    let famd_relative = companion_note_path(&note, ".famd");
    let famd_path = vault::resolve_inside(root, &famd_relative)?;
    let source = fs::read_to_string(&famd_path).unwrap_or_default();
    let parsed = if source.is_empty() {
        parse_famd("")
    } else {
        parse_famd(&source)
    };
    let markdown = if note.to_lowercase().ends_with(".pdf") {
        parsed.markdown.clone()
    } else {
        let markdown_path = vault::resolve_inside(root, &note)?;
        fs::read_to_string(markdown_path).unwrap_or_else(|_| parsed.markdown.clone())
    };
    let body = strip_famd_payload(&markdown);
    let mut payload = parsed
        .payload
        .unwrap_or_else(|| empty_famd_payload(now_iso()));
    payload.updated_at = now_iso();
    payload.worksheets = worksheet_ids_from_markdown(&body);
    Ok((famd_path, body, payload))
}

fn store_note(path: &Path, body: &str, payload: &FamdPayload) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    }
    fs::write(path, serialize_famd(body, payload))
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())
}

fn note_path(relative: &str) -> Result<String, String> {
    let path = vault::normalize_relative_path(relative, false, false)?;
    let lower = path.to_lowercase();
    if lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".famd")
        || lower.ends_with(".pdf")
    {
        Ok(path)
    } else {
        Err("Es dürfen nur Markdown-Dateien, PDF-Notizen und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned())
    }
}

fn markdown_path(relative: &str) -> Result<String, String> {
    let path = vault::normalize_relative_path(relative, false, false)?;
    let lower = path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".famd") {
        Ok(path)
    } else {
        Err("Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned())
    }
}

fn parse_subject_books(value: &Value) -> Vec<Value> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut seen = Vec::new();
    let mut books = Vec::new();
    for entry in items {
        let Some(book) = sanitize_subject_book(entry) else {
            continue;
        };
        let subject = book["subjectPath"].as_str().unwrap_or("").to_owned();
        if seen.iter().any(|existing: &String| existing == &subject) {
            continue;
        }
        seen.push(subject);
        books.push(book);
        if books.len() == MAX_BOOKS {
            break;
        }
    }
    books
}

fn sanitize_subject_book(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let subject_path = sanitize_folder_path(object.get("subjectPath").and_then(Value::as_str))?;
    let book_path = sanitize_pdf_path(object.get("bookPath").and_then(Value::as_str))?;
    let page = object
        .get("lastPage")
        .and_then(Value::as_i64)
        .filter(|page| *page >= 1)
        .unwrap_or(1);
    Some(json!({
        "subjectPath": subject_path,
        "bookPath": book_path,
        "lastPage": page,
    }))
}

fn sanitize_folder_path(value: Option<&str>) -> Option<String> {
    let path = value?
        .replace('\\', "/")
        .trim_matches('/')
        .trim()
        .to_string();
    let lower = path.to_lowercase();
    if path.is_empty()
        || path.len() > MAX_PATH
        || path.contains("..")
        || path.contains('\0')
        || lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".famd")
        || lower.ends_with(".pdf")
    {
        return None;
    }
    Some(path)
}

fn sanitize_pdf_path(value: Option<&str>) -> Option<String> {
    let path = value?
        .replace('\\', "/")
        .trim_start_matches('/')
        .trim()
        .to_string();
    if path.is_empty()
        || path.len() > MAX_PATH
        || path.contains("..")
        || path.contains('\0')
        || !path.to_lowercase().ends_with(".pdf")
    {
        return None;
    }
    Some(path)
}

fn books_path(root: &Path) -> Result<PathBuf, String> {
    Ok(crate::vault::ensure_internal_directory(root)?.join("subject-books.json"))
}

fn history_dir(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut hasher = Sha1::new();
    hasher.update(relative.replace('\\', "/").as_bytes());
    let digest = hasher.finalize();
    let name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let history = crate::vault::ensure_internal_directory(root)?.join("history");
    if let Ok(meta) = fs::symlink_metadata(&history) {
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Der Verlaufsordner ist unsicher.".to_owned());
        }
    }
    Ok(history.join(name))
}

fn read_history_index(directory: &Path) -> Result<Value, String> {
    let path = directory.join("index.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "format": "fanotes-history-v1", "snapshots": [] }));
        }
        Err(_) => return Err("Der Verlauf konnte nicht gelesen werden.".to_owned()),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(parsed)
            if parsed.get("format").and_then(Value::as_str) == Some("fanotes-history-v1")
                && parsed.get("snapshots").is_some_and(Value::is_array) =>
        {
            Ok(parsed)
        }
        Ok(_) | Err(_) => Ok(json!({ "format": "fanotes-history-v1", "snapshots": [] })),
    }
}

fn is_snapshot_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn random_suffix() -> Result<String, String> {
    let mut bytes = [0u8; 3];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    }
    let temporary = path.with_file_name(format!(
        ".{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    fs::write(&temporary, bytes)
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    fs::rename(&temporary, path)
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())
}

fn vault_root(host: &Host) -> Result<&Path, String> {
    host.vault
        .as_deref()
        .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())
}

pub(crate) fn iso_from_system_time(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or_default();
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

fn now_iso() -> String {
    iso_from_system_time(SystemTime::now())
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
