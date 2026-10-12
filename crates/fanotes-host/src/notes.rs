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

/// Node `Buffer.toString('utf8')`: invalid bytes become U+FFFD and the rest stays.
pub(crate) fn read_lossy_string(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

pub fn records_history(relative: &str) -> bool {
    is_note_text(relative)
}

pub fn is_note_text(relative: &str) -> bool {
    matches!(
        crate::vault::posix_extname_en_us(relative).as_str(),
        ".md" | ".markdown" | ".famd"
    )
}

pub fn write_note_file(
    root: &Path,
    relative: &str,
    content: &str,
    settings_paper: Option<&str>,
) -> Result<String, String> {
    let is_famd = crate::vault::posix_extname_en_us(relative) == ".famd";
    let body = strip_famd_payload(content);
    let markdown = if body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    };
    let written = if is_famd {
        vault::resolve_note_file(root, relative)?
    } else {
        let path = vault::resolve_note_file(root, relative)?;
        require_parent_directory(&path)?;
        // The desktop creates a missing `.famd` on save. A missing markdown
        // note is not created here; that is `create-note`.
        if !path.is_file() {
            return Err("Der Eintrag wurde nicht gefunden.".to_owned());
        }
        atomic_write(&path, markdown.as_bytes(), 0o600)?;
        path
    };
    attach_sidecar(root, relative, content, settings_paper)?;
    Ok(file_mtime_iso(&written))
}

fn file_mtime_iso(path: &Path) -> String {
    fs::symlink_metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(iso_from_system_time)
        .unwrap_or_else(now_iso)
}

fn require_parent_directory(path: &Path) -> Result<(), String> {
    let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return Err("Der Zielordner wurde nicht gefunden.".to_owned());
    };
    let meta = fs::symlink_metadata(parent)
        .map_err(|_| "Der Zielordner wurde nicht gefunden.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Der Zielordner wurde nicht gefunden.".to_owned());
    }
    Ok(())
}

pub fn attach_sidecar(
    root: &Path,
    relative: &str,
    content: &str,
    settings_paper: Option<&str>,
) -> Result<(), String> {
    let famd_relative = companion_note_path(relative, ".famd");
    let famd_path = vault::resolve_note_file(root, &famd_relative)?;
    let existing = read_lossy_string(&famd_path)
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
    atomic_write(
        &famd_path,
        serialize_famd(&body, &payload).as_bytes(),
        0o600,
    )?;
    if relative.to_lowercase().ends_with(".famd") {
        let markdown_relative = companion_note_path(relative, ".md");
        if let Ok(markdown_path) = vault::resolve_note_file(root, &markdown_relative) {
            if markdown_path.is_file() {
                let text = if body.ends_with('\n') {
                    body
                } else {
                    format!("{body}\n")
                };
                atomic_write(&markdown_path, text.as_bytes(), 0o600)?;
            }
        }
    }
    Ok(())
}

pub fn read_page_stats(host: &Host, relative: &str) -> Result<Value, String> {
    Ok(read_companion(host, relative)?
        .and_then(|payload| payload.page_stats)
        .unwrap_or(Value::Null))
}

pub fn read_paper_style(host: &Host, relative: &str) -> Result<Value, String> {
    let Some(payload) = read_companion(host, relative)? else {
        return Ok(Value::Null);
    };
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
    let links = read_companion(host, relative)?.map(|payload| payload.note_links);
    Ok(Value::Array(
        links
            .unwrap_or_default()
            .iter()
            .map(NoteLink::to_json)
            .collect(),
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
    let backups = read_companion(host, relative)?.map(|payload| payload.note_backups);
    Ok(Value::Array(
        backups
            .unwrap_or_default()
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
    let raw = fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
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
    let content = read_lossy_string(&directory.join(format!("{snapshot_id}.md")))
        .ok_or_else(|| "Dieser Verlaufseintrag existiert nicht mehr.".to_owned())?;
    Ok(json!({
        "id": snapshot_id,
        "createdAt": entry.get("createdAt").and_then(Value::as_str).unwrap_or(""),
        "content": content,
    }))
}

pub fn record_history(vault_root: &Path, relative: &str, content: &str) -> Result<(), String> {
    if vault::js_trim(content).is_empty() {
        return Ok(());
    }
    let bytes = content.len();
    if bytes == 0 || bytes > MAX_SNAPSHOT_BYTES {
        return Ok(());
    }
    let directory = history_dir(vault_root, relative)?;
    ensure_private_history_dir(&directory)?;
    let mut index = read_history_index(&directory)?;
    if let Some(last) = index
        .get("snapshots")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
    {
        if read_lossy_string(&directory.join(format!("{last}.md"))).as_deref() == Some(content) {
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
    atomic_write(&snapshot_path, content.as_bytes(), 0o600)
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

const MAX_COMPANION_BYTES: u64 = 40 * 1024 * 1024;

/// Reads of page stats, paper, links, and backups look only at the companion.
///
/// A missing companion is empty. A directory in its place uses the desktop
/// file error. The note path itself can be a directory.
fn read_companion(host: &Host, relative: &str) -> Result<Option<FamdPayload>, String> {
    let root = vault_root(host)?;
    let note = note_path(relative)?;
    let famd_relative = companion_note_path(&note, ".famd");
    let path = vault::resolve_note_file(root, &famd_relative)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Die Datei konnte nicht gelesen werden.".to_owned()),
        Ok(meta) if meta.file_type().is_symlink() => {
            Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned())
        }
        Ok(meta) if !meta.is_file() => {
            Err("Die gewählte Datei ist keine reguläre Datei.".to_owned())
        }
        Ok(meta) if meta.len() > MAX_COMPANION_BYTES => Err("Die Datei ist zu groß.".to_owned()),
        Ok(_) => Ok(read_lossy_string(&path).and_then(|source| parse_famd(&source).payload)),
    }
}

fn load_note(host: &Host, relative: &str) -> Result<(PathBuf, String, FamdPayload), String> {
    let root = vault_root(host)?;
    let note = note_path(relative)?;
    let famd_relative = companion_note_path(&note, ".famd");
    let famd_path = vault::resolve_note_file(root, &famd_relative)?;
    let source = read_lossy_string(&famd_path).unwrap_or_default();
    let parsed = if source.is_empty() {
        parse_famd("")
    } else {
        parse_famd(&source)
    };
    let markdown = if note.to_lowercase().ends_with(".pdf") {
        parsed.markdown.clone()
    } else {
        let markdown_path = vault::resolve_note_file(root, &note)?;
        read_lossy_string(&markdown_path).unwrap_or_else(|| parsed.markdown.clone())
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
    atomic_write(path, serialize_famd(body, payload).as_bytes(), 0o600)
}

fn note_path(relative: &str) -> Result<String, String> {
    let path = vault::normalize_relative_path(relative, false, false)?;
    if is_note_extension(&path) {
        Ok(path)
    } else {
        Err("Es dürfen nur Markdown-Dateien, PDF-Notizen und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned())
    }
}

fn markdown_path(relative: &str) -> Result<String, String> {
    let path = vault::normalize_relative_path(relative, false, false)?;
    if is_note_text(&path) {
        Ok(path)
    } else {
        Err("Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned())
    }
}

fn is_note_extension(path: &str) -> bool {
    matches!(
        vault::posix_extname_en_us(path).as_str(),
        ".md" | ".markdown" | ".famd" | ".pdf"
    )
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
    let page = subject_book_page(object.get("lastPage"));
    Some(json!({
        "subjectPath": subject_path,
        "bookPath": book_path,
        "lastPage": page,
    }))
}

/// Desktop `Number(lastPage)` followed by `Number.isSafeInteger`.
fn subject_book_page(value: Option<&Value>) -> i64 {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => vault::js_tonumber(text).unwrap_or(f64::NAN),
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    };
    if number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= 9_007_199_254_740_991.0
        && number >= 1.0
    {
        number as i64
    } else {
        1
    }
}

fn sanitize_folder_path(value: Option<&str>) -> Option<String> {
    let raw = value?.replace('\\', "/");
    let path = vault::js_trim(raw.trim_matches('/')).to_string();
    let lower = path.to_lowercase();
    if path.is_empty()
        || crate::vault::utf16_len(&path) > MAX_PATH
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
    let raw = value?.replace('\\', "/");
    let path = vault::js_trim(raw.trim_start_matches('/')).to_string();
    if path.is_empty()
        || crate::vault::utf16_len(&path) > MAX_PATH
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

fn ensure_private_history_dir(directory: &Path) -> Result<(), String> {
    if let Some(parent) = directory.parent() {
        if fs::symlink_metadata(parent).is_err() {
            ensure_private_history_dir(parent)?;
        }
    }
    match fs::symlink_metadata(directory) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            Err("Der Verlauf konnte nicht gespeichert werden.".to_owned())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory)
                .map_err(|_| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?;
            }
            Ok(())
        }
        Err(_) => Err("Der Verlauf konnte nicht gespeichert werden.".to_owned()),
    }
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
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "format": "fanotes-history-v1", "snapshots": [] }));
        }
        Err(_) => return Err("Der Verlauf konnte nicht gelesen werden.".to_owned()),
    };
    let raw = String::from_utf8_lossy(&bytes);
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
    atomic_write_with_mtime(path, bytes, mode, None)
}

pub(crate) fn atomic_write_with_mtime(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    mtime: Option<SystemTime>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    }
    let temporary = temporary_path(path)?;
    if let Err(error) = write_exclusive(&temporary, bytes, mode) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Some(mtime) = mtime {
        // Stamp the temporary file. The final name then appears with the
        // sync time already set, matching the Electron sync host.
        let _ = filetime::set_file_mtime(&temporary, filetime::FileTime::from_system_time(mtime));
    }
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("Die Datei konnte nicht geschrieben werden.".to_owned());
    }
    sync_parent(path);
    Ok(())
}

/// Copy `source` onto `destination` as a private file.
///
/// The bytes are flushed before the final name appears, and the mode is the
/// requested one. A world-readable OneNote export therefore does not stay
/// world-readable inside the vault.
pub(crate) fn atomic_copy(source: &Path, destination: &Path, mode: u32) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    }
    let temporary = temporary_path(destination)?;
    if let Err(error) = copy_exclusive(&temporary, source, mode) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if fs::rename(&temporary, destination).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("Die Datei konnte nicht geschrieben werden.".to_owned());
    }
    sync_parent(destination);
    Ok(())
}

fn temporary_path(path: &Path) -> Result<PathBuf, String> {
    let suffix = random_suffix().unwrap_or_else(|_| std::process::id().to_string());
    Ok(path.with_file_name(format!(
        ".{}.{}.{suffix}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id()
    )))
}

#[derive(Debug)]
pub(crate) enum NewFileError {
    Exists,
    Io,
}

/// Publish bytes at `path` only when that path is absent.
///
/// A hard link fails for a file, directory, or symlink, so an import cannot
/// replace a note that already uses the name. Filesystems without hard links
/// fall back to an exclusive create. The bytes are flushed before the name
/// appears, and the file mode is private.
pub(crate) fn publish_new_file(path: &Path, bytes: &[u8], mode: u32) -> Result<(), NewFileError> {
    let _parent = parent_directory(path)?;
    let temporary = temporary_path(path).map_err(|_| NewFileError::Io)?;
    if write_exclusive(&temporary, bytes, mode).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(NewFileError::Io);
    }
    match fs::hard_link(&temporary, path) {
        Ok(()) => {
            let _ = fs::remove_file(&temporary);
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&temporary);
            return Err(NewFileError::Exists);
        }
        Err(error) if link_unsupported(&error) => {
            if write_exclusive(path, bytes, mode).is_err() {
                let _ = fs::remove_file(&temporary);
                return Err(NewFileError::Io);
            }
            let _ = fs::remove_file(&temporary);
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            return Err(NewFileError::Io);
        }
    }
    sync_parent(path);
    Ok(())
}

fn parent_directory(path: &Path) -> Result<&Path, NewFileError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or(NewFileError::Io)?;
    let meta = fs::symlink_metadata(parent).map_err(|_| NewFileError::Io)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(NewFileError::Io);
    }
    Ok(parent)
}

fn link_unsupported(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::Unsupported
            | std::io::ErrorKind::CrossesDevices
    )
}

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

fn write_exclusive(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let mut file = open_new_file(path, mode)?;
    if std::io::Write::write_all(&mut file, bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("Die Datei konnte nicht geschrieben werden.".to_owned());
    }
    set_private_mode(path, mode);
    Ok(())
}

fn copy_exclusive(path: &Path, source: &Path, mode: u32) -> Result<(), String> {
    let meta = fs::symlink_metadata(source)
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Die Datei konnte nicht geschrieben werden.".to_owned());
    }
    let mut input = fs::File::open(source)
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
    let mut output = open_new_file(path, mode)?;
    if std::io::copy(&mut input, &mut output)
        .and_then(|_| output.sync_all())
        .is_err()
    {
        drop(output);
        let _ = fs::remove_file(path);
        return Err("Die Datei konnte nicht geschrieben werden.".to_owned());
    }
    set_private_mode(path, mode);
    Ok(())
}

fn open_new_file(path: &Path, mode: u32) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
        let nofollow = if cfg!(target_os = "linux") {
            0x20000
        } else if cfg!(target_os = "macos") {
            0x0100
        } else {
            0
        };
        if nofollow != 0 {
            options.custom_flags(nofollow);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    options
        .open(path)
        .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())
}

fn set_private_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
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

#[cfg(test)]
mod publish_tests {
    use super::{file_mtime_iso, publish_new_file, write_note_file, NewFileError};

    #[test]
    fn a_new_file_stays_private_and_an_existing_name_is_left_alone() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-publish-{}-{}",
            std::process::id(),
            super::random_suffix().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("Skript.pdf");
        publish_new_file(&target, b"%PDF-1.4\n", 0o600).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-1.4\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(matches!(
            publish_new_file(&target, b"replaced", 0o600),
            Err(NewFileError::Exists)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-1.4\n");

        #[cfg(unix)]
        {
            let outside = dir.join("outside");
            std::fs::write(&outside, b"bleibt").unwrap();
            let link = dir.join("link.pdf");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(matches!(
                publish_new_file(&link, b"%PDF-1.4\n", 0o600),
                Err(NewFileError::Exists)
            ));
            assert_eq!(std::fs::read(&outside).unwrap(), b"bleibt");
        }

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_note_reports_the_file_modification_time() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-mtime-{}-{}",
            std::process::id(),
            super::random_suffix().unwrap()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Mathe")).unwrap();
        std::fs::write(dir.join("Mathe/Seite.md"), b"alt\n").unwrap();
        let stamp = write_note_file(&dir, "Mathe/Seite.md", "Hallo", None).unwrap();
        let path = dir.join("Mathe/Seite.md");
        assert_eq!(stamp, file_mtime_iso(&path));
        let famd = write_note_file(&dir, "Mathe/Seite.famd", "Rand\n", None).unwrap();
        assert_eq!(famd, file_mtime_iso(&dir.join("Mathe/Seite.famd")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
