//! Text sidecars beside vault PDFs, as in `electron/pdf-ocr.cjs`,
//! `electron/page-text.cjs` and their handlers in `electron/main.cjs`.
//!
//! * `.fanotes/pdf-ocr/<sha256[..32]>.json` (`fanotes-pdf-ocr-v1`): the local
//!   OCR transcript of a scanned PDF, valid while the PDF's size and mtime match.
//! * `.fanotes/page-text/<sha256[..32]>.json` (`fanotes-page-text-v1`): the
//!   per-page text shared with other clients for document search, valid while
//!   the PDF's size matches.
//!
//! The PDF itself is never rewritten. Records follow a renamed or moved PDF and
//! are removed with a deleted one.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{notes, vault, Host};

pub(crate) const PDF_OCR_FORMAT: &str = "fanotes-pdf-ocr-v1";
const PDF_OCR_DIRECTORY: &str = "pdf-ocr";
const OCR_MAX_PAGES: usize = 60;
const OCR_MAX_PAGE_CHARS: usize = 6_000;
pub(crate) const OCR_MAX_BYTES: u64 = 512 * 1024;
const OCR_MAX_TOTAL_CHARS: usize = OCR_MAX_PAGES * OCR_MAX_PAGE_CHARS;

pub(crate) const PAGE_TEXT_FORMAT: &str = "fanotes-page-text-v1";
const PAGE_TEXT_DIRECTORY: &str = "page-text";
const TEXT_MAX_PAGES: usize = 2000;
const TEXT_MAX_PAGE_CHARS: usize = 6000;
pub(crate) const TEXT_MAX_BYTES: u64 = 4 * 1024 * 1024;

const MAX_PDF_BYTES: f64 = 96.0 * 1024.0 * 1024.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The PDF a sidecar belongs to: its logical path, size and rounded mtime.
#[derive(Debug, Clone)]
pub(crate) struct PdfIdentity {
    pub root: PathBuf,
    pub normalized: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// `sha256(relativePath).hex.slice(0, 32) + '.json'`.
pub(crate) fn sidecar_name(relative: &str) -> String {
    let digest = Sha256::digest(relative.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}.json", &hex[..32])
}

fn sidecar_file_name(name: &str) -> bool {
    name.len() == 37
        && name.ends_with(".json")
        && name[..32]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `Number.isSafeInteger`.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        Some(number as i64)
    } else {
        None
    }
}

/// `Number.isInteger`.
fn js_integer(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// `/^[a-f0-9]{8}$/u`.
fn stamp_ok(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|stamp| {
        stamp.len() == 8
            && stamp
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn segments_ok(path: &str) -> bool {
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// The path check of `pdf-ocr.cjs` `sanitize` (a backslash is allowed there).
fn ocr_path_ok(path: &str) -> bool {
    let length = vault::utf16_len(path);
    (1..=4096).contains(&length) && !path.contains('\0') && segments_ok(path)
}

/// `validPath` from `page-text.cjs`.
fn page_text_path_ok(path: &str) -> bool {
    let length = vault::utf16_len(path);
    (1..=4096).contains(&length)
        && !path.contains('\0')
        && !path.contains('\\')
        && segments_ok(path)
}

fn pdf_size_ok(value: Option<&Value>) -> Option<i64> {
    safe_integer(value).filter(|size| *size >= 1 && (*size as f64) <= MAX_PDF_BYTES)
}

fn parse_json(raw: &str) -> Option<Value> {
    serde_json::from_str(raw).ok()
}

fn serialized(record: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string(record).unwrap_or_else(|_| "null".to_owned())
    )
}

// ---------------------------------------------------------------- pdf-ocr --

fn sanitize_ocr_pages(value: Option<&Value>) -> Option<Vec<Value>> {
    let list = value?.as_array()?;
    if list.len() > OCR_MAX_PAGES {
        return None;
    }
    let mut pages = Vec::with_capacity(list.len());
    let mut seen = std::collections::HashSet::new();
    let mut total = 0usize;
    for entry in list {
        let entry = entry.as_object()?;
        let page = js_integer(entry.get("page"))?;
        if !(1.0..=2000.0).contains(&page) {
            return None;
        }
        let text = entry.get("text")?.as_str()?;
        let length = vault::utf16_len(text);
        if length > OCR_MAX_PAGE_CHARS {
            return None;
        }
        let page = page as i64;
        if !seen.insert(page) {
            return None;
        }
        total += length;
        if total > OCR_MAX_TOTAL_CHARS {
            return None;
        }
        pages.push(json!({ "page": page, "text": text }));
    }
    Some(pages)
}

/// `sanitize` from `pdf-ocr.cjs`.
pub(crate) fn sanitize_pdf_ocr(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("format").and_then(Value::as_str) != Some(PDF_OCR_FORMAT) {
        return None;
    }
    let path = object.get("path")?.as_str()?;
    if !ocr_path_ok(path) {
        return None;
    }
    let size = pdf_size_ok(object.get("size"))?;
    let mtime = safe_integer(object.get("mtimeMs")).filter(|mtime| *mtime >= 0)?;
    if !stamp_ok(object.get("stamp")) {
        return None;
    }
    let pages = sanitize_ocr_pages(object.get("pages"))?;
    Some(json!({
        "format": PDF_OCR_FORMAT,
        "path": path,
        "size": size,
        "mtimeMs": mtime,
        "stamp": object.get("stamp"),
        "pages": pages,
    }))
}

/// `currentDocument`: the stored transcript while path, size and mtime match.
pub(crate) fn current_pdf_ocr(raw: &str, file: &PdfIdentity) -> Option<Value> {
    let document = sanitize_pdf_ocr(&parse_json(raw)?)?;
    let matches = document["path"].as_str() == Some(file.normalized.as_str())
        && document["size"].as_i64() == Some(file.size as i64)
        && document["mtimeMs"].as_i64() == Some(file.mtime_ms);
    matches.then_some(document)
}

/// `transcriptForFile`: the page texts joined by newlines, or empty.
pub(crate) fn pdf_ocr_transcript(raw: &str, file: &PdfIdentity) -> String {
    let Some(document) = current_pdf_ocr(raw, file) else {
        return String::new();
    };
    let texts: Vec<&str> = document["pages"]
        .as_array()
        .map(|pages| {
            pages
                .iter()
                .filter_map(|page| page["text"].as_str())
                .collect()
        })
        .unwrap_or_default();
    vault::truncate_utf16(&texts.join("\n"), OCR_MAX_TOTAL_CHARS)
}

/// `buildDocument`: the record a renderer payload stores for this PDF.
fn build_pdf_ocr(payload: &Map<String, Value>, file: &PdfIdentity) -> Option<Value> {
    // The handler passes `{ path: identity.normalized, size, stamp, pages }`.
    // `payload.size !== file.size` is a strict number comparison.
    if payload.get("size").and_then(Value::as_f64) != Some(file.size as f64) {
        return None;
    }
    if !stamp_ok(payload.get("stamp")) {
        return None;
    }
    let pages = sanitize_ocr_pages(payload.get("pages"))?;
    if file.mtime_ms < 0 || file.mtime_ms as f64 > MAX_SAFE_INTEGER {
        return None;
    }
    Some(json!({
        "format": PDF_OCR_FORMAT,
        "path": file.normalized,
        "size": file.size,
        "mtimeMs": file.mtime_ms,
        "stamp": payload.get("stamp"),
        "pages": pages,
    }))
}

// -------------------------------------------------------------- page-text --

const PAGE_SOURCES: &[&str] = &["text-layer", "ocr"];
const PAGE_STATUSES: &[&str] = &["ok", "empty", "failed", "skipped"];

fn optional_string(value: Option<&Value>, max: usize) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) if vault::utf16_len(text) <= max => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

/// `sanitize` from `page-text.cjs`.
pub(crate) fn sanitize_page_text(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("format").and_then(Value::as_str) != Some(PAGE_TEXT_FORMAT) {
        return None;
    }
    let path = object.get("path")?.as_str()?;
    if !page_text_path_ok(path) {
        return None;
    }
    let size = pdf_size_ok(object.get("size"))?;
    if !stamp_ok(object.get("stamp")) {
        return None;
    }
    let page_count =
        safe_integer(object.get("pageCount")).filter(|count| (0..=100_000).contains(count))?;
    let producer = object.get("producer")?.as_str()?;
    if vault::utf16_len(producer) > 200 {
        return None;
    }
    let ocr_engine = optional_string(object.get("ocrEngine"), 100).ok()?;
    let created_at = object.get("createdAt")?.as_str()?;
    fanotes_famd::canonical_unix_millis(created_at)?;
    let list = object.get("pages")?.as_array()?;
    if list.len() > TEXT_MAX_PAGES {
        return None;
    }
    let mut pages: Vec<(i64, Value)> = Vec::with_capacity(list.len());
    let mut seen = std::collections::HashSet::new();
    for entry in list {
        let entry = entry.as_object()?;
        let page = safe_integer(entry.get("page"))?;
        if page < 1 || page > page_count || !seen.insert(page) {
            return None;
        }
        let source = entry.get("source")?.as_str()?;
        let status = entry.get("status")?.as_str()?;
        if !PAGE_SOURCES.contains(&source) || !PAGE_STATUSES.contains(&status) {
            return None;
        }
        let text = entry.get("text")?.as_str()?;
        if vault::utf16_len(text) > TEXT_MAX_PAGE_CHARS {
            return None;
        }
        let confidence = match entry.get("confidence") {
            None => None,
            Some(value) => {
                let number = value.as_f64()?;
                if !(0.0..=1.0).contains(&number) {
                    return None;
                }
                Some(value.clone())
            }
        };
        let rotation = match entry.get("rotation") {
            None => None,
            Some(value) => {
                let number = value.as_f64()?;
                // `Set.has` uses SameValueZero: `90.0` and `-0` are members.
                if ![0.0, 90.0, 180.0, 270.0].contains(&number) {
                    return None;
                }
                Some(number as i64)
            }
        };
        let reason = optional_string(entry.get("reason"), 120).ok()?;
        let mut record = Map::new();
        record.insert("page".to_owned(), json!(page));
        record.insert("source".to_owned(), json!(source));
        record.insert("status".to_owned(), json!(status));
        record.insert("text".to_owned(), json!(text));
        if let Some(confidence) = confidence {
            record.insert("confidence".to_owned(), confidence);
        }
        if let Some(rotation) = rotation {
            record.insert("rotation".to_owned(), json!(rotation));
        }
        if let Some(reason) = reason {
            record.insert("reason".to_owned(), json!(reason));
        }
        pages.push((page, Value::Object(record)));
    }
    // `Array.prototype.sort` is stable; page numbers are unique.
    pages.sort_by_key(|(page, _)| *page);
    let mut record = Map::new();
    record.insert("format".to_owned(), json!(PAGE_TEXT_FORMAT));
    record.insert("path".to_owned(), json!(path));
    record.insert("size".to_owned(), json!(size));
    record.insert("stamp".to_owned(), object["stamp"].clone());
    record.insert("pageCount".to_owned(), json!(page_count));
    record.insert("producer".to_owned(), json!(producer));
    if let Some(engine) = ocr_engine {
        record.insert("ocrEngine".to_owned(), json!(engine));
    }
    record.insert("createdAt".to_owned(), json!(created_at));
    record.insert(
        "pages".to_owned(),
        Value::Array(pages.into_iter().map(|(_, page)| page).collect()),
    );
    Some(Value::Object(record))
}

/// `recordForFile`: the record for this path and size; the stamp is compared by the reader.
pub(crate) fn page_text_for_file(raw: &str, file: &PdfIdentity) -> Option<Value> {
    let record = sanitize_page_text(&parse_json(raw)?)?;
    let matches = record["path"].as_str() == Some(file.normalized.as_str())
        && record["size"].as_i64() == Some(file.size as i64);
    matches.then_some(record)
}

/// `buildForWrite`: the record and its bytes, or `None` when invalid or too large.
fn build_page_text(payload: &Value, file: &PdfIdentity) -> Option<(Value, String)> {
    let record = page_text_for_payload(payload, file)?;
    let text = serialized(&record);
    if text.len() as u64 > TEXT_MAX_BYTES {
        return None;
    }
    Some((record, text))
}

fn page_text_for_payload(payload: &Value, file: &PdfIdentity) -> Option<Value> {
    let record = sanitize_page_text(payload)?;
    let matches = record["path"].as_str() == Some(file.normalized.as_str())
        && record["size"].as_i64() == Some(file.size as i64);
    matches.then_some(record)
}

// --------------------------------------------------------------- handlers --

/// `pdfOcrFileIdentity`: a vault PDF, or `None` for another extension or a
/// path that is not a regular file. Path errors are the `resolveVaultPath` errors.
pub(crate) fn pdf_identity(host: &Host, relative: &str) -> Result<Option<PdfIdentity>, String> {
    let normalized = vault::normalize_relative_path(relative, false, false)?;
    if vault::posix_extname_en_us(&normalized) != ".pdf" {
        return Ok(None);
    }
    let root = host.require_vault()?.to_path_buf();
    let target = host
        .folder_locations
        .resolve_note(&root, &normalized, false)?;
    let meta =
        fs::symlink_metadata(&target).map_err(|error| vault::node_lstat_error(&target, &error))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(None);
    }
    Ok(Some(PdfIdentity {
        root,
        normalized,
        size: meta.len(),
        mtime_ms: meta.modified().map(notes::mtime_millis_of).unwrap_or(0),
    }))
}

/// The stored sidecar text, or `None` when it is missing, unsafe or too large.
fn read_sidecar(root: &Path, directory: &str, relative: &str, max: u64) -> Option<String> {
    let sidecar = format!(".fanotes/{directory}/{}", sidecar_name(relative));
    let path = vault::resolve_asset_entry(root, &sidecar).ok()?;
    let bytes = crate::read_regular_limited(&path, max).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// `ensurePdfOcrDirectory` / `ensurePageTextDirectory`.
fn ensure_sidecar_directory(
    root: &Path,
    directory: &str,
    unsafe_message: &str,
    escape_message: &str,
) -> Result<PathBuf, String> {
    let cursor = vault::ensure_internal_directory(root)?.join(directory);
    match fs::symlink_metadata(&cursor) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(unsafe_message.to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(&cursor) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(&cursor, fs::Permissions::from_mode(0o700));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(vault::node_mkdir_error(&cursor, &error)),
            }
            let created = fs::symlink_metadata(&cursor)
                .map_err(|error| vault::node_lstat_error(&cursor, &error))?;
            if created.file_type().is_symlink() || !created.is_dir() {
                return Err(unsafe_message.to_owned());
            }
        }
        Err(error) => return Err(vault::node_lstat_error(&cursor, &error)),
    }
    let root_real = fs::canonicalize(root).map_err(|_| escape_message.to_owned())?;
    let real = fs::canonicalize(&cursor).map_err(|_| escape_message.to_owned())?;
    if !vault::is_inside_root(&root_real, &real) {
        return Err(escape_message.to_owned());
    }
    Ok(cursor)
}

/// `fanotes:read-pdf-ocr`: the current transcript record or null. Never fails.
pub(crate) fn read_pdf_ocr(host: &Host, relative: Option<&Value>) -> Value {
    let Some(relative) = relative.and_then(Value::as_str) else {
        return Value::Null;
    };
    let Ok(Some(file)) = pdf_identity(host, relative) else {
        return Value::Null;
    };
    read_sidecar(
        &file.root,
        PDF_OCR_DIRECTORY,
        &file.normalized,
        OCR_MAX_BYTES,
    )
    .and_then(|raw| current_pdf_ocr(&raw, &file))
    .unwrap_or(Value::Null)
}

/// `fanotes:write-pdf-ocr`: stores the transcript, or null when the payload
/// does not fit this PDF.
pub(crate) fn write_pdf_ocr(host: &Host, payload: Option<&Value>) -> Result<Value, String> {
    let invalid = || "Die lokale PDF-Texterkennung ist ungültig.".to_owned();
    let object = payload.and_then(Value::as_object).ok_or_else(invalid)?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let file = pdf_identity(host, path)?
        .ok_or_else(|| "Nur PDF-Notizen werden lokal gelesen.".to_owned())?;
    let Some(document) = build_pdf_ocr(object, &file) else {
        return Ok(Value::Null);
    };
    let directory = ensure_sidecar_directory(
        &file.root,
        PDF_OCR_DIRECTORY,
        "Der interne PDF-Ordner ist unsicher.",
        "Der interne PDF-Ordner verlässt den Vault.",
    )?;
    notes::atomic_write(
        &directory.join(sidecar_name(&file.normalized)),
        serialized(&document).as_bytes(),
        0o600,
    )?;
    Ok(document)
}

/// `fanotes:read-page-text`: the record for this PDF or null. Never fails.
pub(crate) fn read_page_text(host: &Host, relative: Option<&Value>) -> Value {
    let Some(relative) = relative.and_then(Value::as_str) else {
        return Value::Null;
    };
    let Ok(Some(file)) = pdf_identity(host, relative) else {
        return Value::Null;
    };
    read_sidecar(
        &file.root,
        PAGE_TEXT_DIRECTORY,
        &file.normalized,
        TEXT_MAX_BYTES,
    )
    .and_then(|raw| page_text_for_file(&raw, &file))
    .unwrap_or(Value::Null)
}

/// `fanotes:write-page-text`: stores the record, or null when it does not fit this PDF.
pub(crate) fn write_page_text(host: &Host, payload: Option<&Value>) -> Result<Value, String> {
    let invalid = || "Der Seitentext ist ungültig.".to_owned();
    let payload = payload
        .filter(|value| value.is_object())
        .ok_or_else(invalid)?;
    let path = payload
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let file = pdf_identity(host, path)?
        .ok_or_else(|| "Seitentext gibt es nur für PDF-Notizen.".to_owned())?;
    let Some((record, text)) = build_page_text(payload, &file) else {
        return Ok(Value::Null);
    };
    let directory = ensure_sidecar_directory(
        &file.root,
        PAGE_TEXT_DIRECTORY,
        "Der interne Textordner ist unsicher.",
        "Der interne Textordner verlässt den Vault.",
    )?;
    notes::atomic_write(
        &directory.join(sidecar_name(&file.normalized)),
        text.as_bytes(),
        0o600,
    )?;
    Ok(record)
}

/// `readPdfOcrTranscript` for vault search: the transcript of a PDF the walk
/// already found, or empty.
pub(crate) fn search_transcript(root: &Path, relative: &str, meta: &fs::Metadata) -> String {
    let Ok(normalized) = vault::normalize_relative_path(relative, false, false) else {
        return String::new();
    };
    let file = PdfIdentity {
        root: root.to_path_buf(),
        normalized,
        size: meta.len(),
        mtime_ms: meta.modified().map(notes::mtime_millis_of).unwrap_or(0),
    };
    read_sidecar(root, PDF_OCR_DIRECTORY, &file.normalized, OCR_MAX_BYTES)
        .map(|raw| pdf_ocr_transcript(&raw, &file))
        .unwrap_or_default()
}

fn sidecar_names(directory: &Path) -> Option<Vec<String>> {
    let meta = fs::symlink_metadata(directory).ok()?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return None;
    }
    let mut names: Vec<String> = fs::read_dir(directory)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| sidecar_file_name(name))
        .collect();
    names.sort();
    Some(names)
}

fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        Some(to.to_owned())
    } else if path.starts_with(&format!("{from}/")) {
        Some(format!("{to}{}", &path[from.len()..]))
    } else {
        None
    }
}

fn under(path: &str, from: &str) -> bool {
    path == from || path.starts_with(&format!("{from}/"))
}

/// `rewritePdfOcrSidecars`: a transcript follows its renamed or moved PDF
/// (with the PDF's current size and mtime) and is removed with a deleted one.
pub(crate) fn rewrite_pdf_ocr_sidecars(host: &Host, root: &Path, from: &str, to: Option<&str>) {
    let directory = root.join(".fanotes").join(PDF_OCR_DIRECTORY);
    let Some(names) = sidecar_names(&directory) else {
        return;
    };
    for name in names {
        let file_path = directory.join(&name);
        let Ok(bytes) = notes::read_nofollow_limited(&file_path, OCR_MAX_BYTES) else {
            continue;
        };
        let Some(document) = parse_json(&String::from_utf8_lossy(&bytes))
            .as_ref()
            .and_then(sanitize_pdf_ocr)
        else {
            continue;
        };
        let path = document["path"].as_str().unwrap_or("").to_owned();
        if !under(&path, from) {
            continue;
        }
        let Some(to) = to else {
            let _ = fs::remove_file(&file_path);
            continue;
        };
        let Some(next_path) = moved_path(&path, from, to) else {
            continue;
        };
        let pdf = host
            .folder_locations
            .resolve_note(root, &next_path, false)
            .ok()
            .and_then(|target| fs::symlink_metadata(target).ok())
            .filter(|meta| meta.is_file() && !meta.file_type().is_symlink());
        let Some(pdf) = pdf else {
            let _ = fs::remove_file(&file_path);
            continue;
        };
        let mut next = document;
        next["path"] = json!(next_path);
        next["size"] = json!(pdf.len());
        next["mtimeMs"] = json!(pdf.modified().map(notes::mtime_millis_of).unwrap_or(0));
        let destination = directory.join(sidecar_name(&next_path));
        if notes::atomic_write(&destination, serialized(&next).as_bytes(), 0o600).is_ok()
            && destination != file_path
        {
            let _ = fs::remove_file(&file_path);
        }
    }
}

/// `rewritePageTextSidecars`: page text follows a renamed or moved PDF and is
/// removed with a deleted one.
pub(crate) fn rewrite_page_text_sidecars(root: &Path, from: &str, to: Option<&str>) {
    let directory = root.join(".fanotes").join(PAGE_TEXT_DIRECTORY);
    let Some(names) = sidecar_names(&directory) else {
        return;
    };
    for name in names {
        let file_path = directory.join(&name);
        let Ok(bytes) = notes::read_nofollow_limited(&file_path, TEXT_MAX_BYTES) else {
            continue;
        };
        let Some(record) = parse_json(&String::from_utf8_lossy(&bytes))
            .as_ref()
            .and_then(sanitize_page_text)
        else {
            continue;
        };
        let path = record["path"].as_str().unwrap_or("").to_owned();
        if !under(&path, from) {
            continue;
        }
        let Some(to) = to else {
            let _ = fs::remove_file(&file_path);
            continue;
        };
        let Some(next_path) = moved_path(&path, from, to) else {
            continue;
        };
        let mut next = record;
        next["path"] = json!(next_path);
        let destination = directory.join(sidecar_name(&next_path));
        if notes::atomic_write(&destination, serialized(&next).as_bytes(), 0o600).is_ok()
            && destination != file_path
        {
            let _ = fs::remove_file(&file_path);
        }
    }
}

/// Both sidecar kinds, after a rename, move (`to = Some`) or trash (`to = None`).
pub(crate) fn follow_entry(host: &Host, root: &Path, from: &str, to: Option<&str>) {
    rewrite_pdf_ocr_sidecars(host, root, from, to);
    rewrite_page_text_sidecars(root, from, to);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(path: &str, size: u64, mtime_ms: i64) -> PdfIdentity {
        PdfIdentity {
            root: PathBuf::from("/vault"),
            normalized: path.to_owned(),
            size,
            mtime_ms,
        }
    }

    #[test]
    fn the_sidecar_name_is_the_first_half_of_the_sha256() {
        // node -e "require('crypto').createHash('sha256').update('Mathe/Buch.pdf').digest('hex').slice(0,32)"
        let name = sidecar_name("Mathe/Buch.pdf");
        assert_eq!(name.len(), 37);
        assert!(sidecar_file_name(&name));
        assert!(!sidecar_file_name("ABCDEF0123456789abcdef0123456789.json"));
        assert!(!sidecar_file_name(
            "0123456789abcdef0123456789abcdef.json.tmp"
        ));
    }

    #[test]
    fn ocr_pages_follow_the_desktop_limits() {
        let page = |page: Value, text: &str| json!({ "page": page, "text": text });
        assert!(sanitize_ocr_pages(Some(&json!([page(json!(1), "a")]))).is_some());
        assert!(sanitize_ocr_pages(Some(&json!([page(json!(2.0), "a")]))).is_some());
        assert!(sanitize_ocr_pages(Some(&json!([page(json!(0), "a")]))).is_none());
        assert!(sanitize_ocr_pages(Some(&json!([page(json!(2001), "a")]))).is_none());
        assert!(sanitize_ocr_pages(Some(&json!([page(json!(1.5), "a")]))).is_none());
        assert!(
            sanitize_ocr_pages(Some(&json!([page(json!(1), "a"), page(json!(1), "b")]))).is_none()
        );
        assert!(sanitize_ocr_pages(Some(&json!([page(json!(1), &"x".repeat(6001))]))).is_none());
        let many: Vec<Value> = (1..=61).map(|index| page(json!(index), "a")).collect();
        assert!(sanitize_ocr_pages(Some(&Value::Array(many))).is_none());
        assert!(sanitize_ocr_pages(Some(&json!([[]]))).is_none());
        assert!(sanitize_ocr_pages(Some(&json!("pages"))).is_none());
    }

    #[test]
    fn a_stale_ocr_record_is_not_the_current_transcript() {
        let record = json!({
            "format": PDF_OCR_FORMAT, "path": "a.pdf", "size": 10, "mtimeMs": 5,
            "stamp": "0123abcd", "pages": [{ "page": 2, "text": "zwei" }, { "page": 1, "text": "eins" }],
        })
        .to_string();
        let file = identity("a.pdf", 10, 5);
        assert_eq!(pdf_ocr_transcript(&record, &file), "zwei\neins");
        assert!(current_pdf_ocr(&record, &identity("a.pdf", 11, 5)).is_none());
        assert!(current_pdf_ocr(&record, &identity("a.pdf", 10, 6)).is_none());
        assert!(current_pdf_ocr(&record, &identity("b.pdf", 10, 5)).is_none());
        assert_eq!(pdf_ocr_transcript("{", &file), "");
        let bad_stamp = record.replace("0123abcd", "0123ABCD");
        assert!(current_pdf_ocr(&bad_stamp, &file).is_none());
    }

    #[test]
    fn page_text_records_are_sanitized_like_page_text_cjs() {
        let base = json!({
            "format": PAGE_TEXT_FORMAT, "path": "Mathe/Buch.pdf", "size": 1200, "stamp": "deadbeef",
            "pageCount": 3, "producer": "fanotes", "createdAt": "2026-11-09T10:00:00.000Z",
            "pages": [
                { "page": 3, "source": "ocr", "status": "ok", "text": "drei", "confidence": 0.5, "rotation": 90.0, "extra": 1 },
                { "page": 1, "source": "text-layer", "status": "empty", "text": "" },
            ],
        });
        let record = sanitize_page_text(&base).expect("valid record");
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"format":"fanotes-page-text-v1","path":"Mathe/Buch.pdf","size":1200,"stamp":"deadbeef","pageCount":3,"producer":"fanotes","createdAt":"2026-11-09T10:00:00.000Z","pages":[{"page":1,"source":"text-layer","status":"empty","text":""},{"page":3,"source":"ocr","status":"ok","text":"drei","confidence":0.5,"rotation":90}]}"#
        );
        let with = |key: &str, value: Value| {
            let mut next = base.clone();
            next[key] = value;
            sanitize_page_text(&next)
        };
        assert!(with("path", json!("Mathe\\Buch.pdf")).is_none());
        assert!(with("path", json!("Mathe/../Buch.pdf")).is_none());
        assert!(with("size", json!(0)).is_none());
        assert!(with("size", json!(96 * 1024 * 1024 + 1)).is_none());
        assert!(
            with("pageCount", json!(2)).is_none(),
            "page 3 is past pageCount"
        );
        assert!(with("producer", json!("x".repeat(201))).is_none());
        assert!(with("ocrEngine", Value::Null).is_none());
        assert!(with("ocrEngine", json!("tesseract")).is_some());
        assert!(with("createdAt", json!("not a date")).is_none());
        let mut page = base.clone();
        page["pages"][0]["rotation"] = json!(45);
        assert!(sanitize_page_text(&page).is_none());
        page["pages"][0]["rotation"] = json!(0);
        page["pages"][0]["confidence"] = json!(1.5);
        assert!(sanitize_page_text(&page).is_none());
        page["pages"][0]["confidence"] = json!(1);
        page["pages"][0]["source"] = json!("vision");
        assert!(sanitize_page_text(&page).is_none());
    }

    #[test]
    fn a_page_text_write_must_fit_the_file_and_the_byte_cap() {
        let file = identity("a.pdf", 100, 1);
        let record = |pages: Value| {
            json!({
                "format": PAGE_TEXT_FORMAT, "path": "a.pdf", "size": 100, "stamp": "00000000",
                "pageCount": 2000, "producer": "p", "createdAt": "2026-11-09T10:00:00Z", "pages": pages,
            })
        };
        assert!(build_page_text(&record(json!([])), &file).is_some());
        assert!(build_page_text(&record(json!([])), &identity("a.pdf", 101, 1)).is_none());
        assert!(build_page_text(&record(json!([])), &identity("b.pdf", 100, 1)).is_none());
        // 2000 pages of 6000 three-byte characters are far past 4 MiB.
        let pages: Vec<Value> = (1..=800)
            .map(|page| json!({ "page": page, "source": "ocr", "status": "ok", "text": "€".repeat(6000) }))
            .collect();
        assert!(sanitize_page_text(&record(Value::Array(pages.clone()))).is_some());
        assert!(build_page_text(&record(Value::Array(pages)), &file).is_none());
    }
}
