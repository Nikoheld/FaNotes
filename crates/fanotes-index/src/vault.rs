//! What the index reads from a vault, with the rules of the desktop host and
//! the TS extractor (`electron/main.cjs` tree, `docSearch/extract.ts`):
//! dot names and symlinks are never read, a `.famd` beside a `.md`/`.pdf` is
//! that document's companion, root `Hausaufgaben.md`/`Kalender.md` stay out,
//! notes are cut into 6,000-character chunks, handwriting comes from the
//! stored `searchTranscript`, PDF page text from the `fanotes-page-text-v1`
//! sidecar the renderer writes (this crate does not run pdf.js or OCR), and
//! `Name.story/` projects are searched scene by scene (`docSearch/story.ts`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::famd::{cut_utf16, famd_transcript, strip_famd_payload};
use crate::index::{IndexUnit, UnitKind, UnitSource};
use crate::text::{from_utf16, is_js_space, is_letter, utf16};

const MAX_TREE_DEPTH: usize = 80;
const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FAMD_BYTES: u64 = 40 * 1024 * 1024;
const MAX_WORKSHEET_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PAGE_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 96 * 1024 * 1024;
const MAX_STORY_FILE_BYTES: u64 = 16 * 1024 * 1024;
const NOTE_CHUNK: usize = 6000;
const MAX_NOTE_CHARS: usize = 2_000_000;
const PAGE_MAX_CHARS: usize = 6000;
const MAX_WORKSHEETS: usize = 40;
const PDF_MIN_TEXT: usize = 20;
const EXCLUDED_ROOT_NOTES: [&str; 2] = ["hausaufgaben.md", "kalender.md"];
pub const PAGE_TEXT_DIRECTORY: &str = ".fanotes/page-text";
pub const WORKSHEET_DIRECTORY: &str = ".fanotes/worksheets";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocKind {
    Note,
    Pdf,
    Story,
}

/// One searchable document of the vault and what its index entry depends on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocSource {
    pub path: String,
    pub title: String,
    pub kind: DocKind,
    pub fingerprint: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocStatus {
    Indexed,
    /// Readable, but part of it is not available here yet (PDF without page text).
    Partial,
    Unsupported,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Extracted {
    pub units: Vec<IndexUnit>,
    pub status: DocStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub issues: Vec<String>,
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `path.replace(/\.[^./]+$/u, '')`
pub fn stem_of(path: &str) -> &str {
    match path.rfind('.') {
        Some(dot) if !path[dot + 1..].is_empty() && !path[dot + 1..].contains('/') => &path[..dot],
        _ => path,
    }
}

/// `(path.split('/').pop()).replace(/\.[^.]+$/u, '')`
pub fn title_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[..dot].to_owned(),
        _ => name.to_owned(),
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

pub fn absolute(root: &Path, relative: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    path.extend(relative.split('/'));
    path
}

fn stamp(metadata: &fs::Metadata) -> String {
    let nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}:{nanos}", metadata.len())
}

fn file_stamp(root: &Path, relative: &str) -> String {
    fs::symlink_metadata(absolute(root, relative))
        .ok()
        .filter(|m| m.is_file())
        .map(|m| stamp(&m))
        .unwrap_or_else(|| "-".to_owned())
}

/// `.fanotes/page-text/<first 32 hex of sha256(path)>.json`
pub fn page_text_sidecar(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    let hex: String = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{PAGE_TEXT_DIRECTORY}/{hex}.json")
}

fn story_fingerprint(root: &Path, relative: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut stack = vec![(relative.to_owned(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(absolute(root, &dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let child = join(&dir, &name);
            if kind.is_dir() && depth < 4 {
                stack.push((child, depth + 1));
            } else if kind.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    parts.push(format!("{child}={}", stamp(&metadata)));
                }
            }
        }
    }
    parts.sort();
    let digest = Sha256::digest(parts.join("\n").as_bytes());
    digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The searchable documents directly inside `dir` (vault-relative), and its subfolders.
pub fn list_dir(root: &Path, dir: &str) -> (Vec<DocSource>, Vec<String>) {
    let mut files: Vec<(String, String)> = Vec::new();
    let mut stories: Vec<String> = Vec::new();
    let mut folders: Vec<String> = Vec::new();
    let Ok(entries) = fs::read_dir(absolute(root, dir)) else {
        return (Vec::new(), Vec::new());
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if name.to_lowercase().ends_with(".story") {
                stories.push(join(dir, &name));
            } else {
                folders.push(join(dir, &name));
            }
        } else if kind.is_file() {
            let extension = extension_of(&name);
            if matches!(extension.as_str(), "md" | "markdown" | "famd" | "pdf") {
                files.push((name, extension));
            }
        }
    }
    // `omitFamdCompanions`: a `.famd` whose stem names a note or PDF here is its companion.
    let fold_stem = |name: &str| title_of(name).nfc().collect::<String>().to_lowercase();
    let note_stems: HashSet<String> = files
        .iter()
        .filter(|(_, ext)| matches!(ext.as_str(), "md" | "markdown" | "pdf"))
        .map(|(name, _)| fold_stem(name))
        .collect();
    files.retain(|(name, ext)| ext != "famd" || !note_stems.contains(&fold_stem(name)));
    let present: HashSet<String> = files.iter().map(|(name, _)| join(dir, name)).collect();
    let mut sources = Vec::new();
    for (name, extension) in &files {
        let path = join(dir, name);
        if dir.is_empty() && EXCLUDED_ROOT_NOTES.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        let stem = stem_of(&path);
        let companion = format!("{stem}.famd");
        let (kind, fingerprint) = match extension.as_str() {
            "pdf" => (
                DocKind::Pdf,
                format!(
                    "{}|{}|{}",
                    file_stamp(root, &path),
                    file_stamp(root, &companion),
                    file_stamp(root, &page_text_sidecar(&path))
                ),
            ),
            "md" => (
                DocKind::Note,
                format!(
                    "{}|{}",
                    file_stamp(root, &path),
                    file_stamp(root, &companion)
                ),
            ),
            "famd" => {
                if present.contains(&format!("{stem}.pdf"))
                    || present.contains(&format!("{stem}.md"))
                {
                    continue;
                }
                (DocKind::Note, file_stamp(root, &path))
            }
            _ => continue,
        };
        sources.push(DocSource {
            title: title_of(&path),
            path,
            kind,
            fingerprint,
        });
    }
    for path in stories {
        sources.push(DocSource {
            title: title_of(&path),
            fingerprint: story_fingerprint(root, &path),
            path,
            kind: DocKind::Story,
        });
    }
    (sources, folders)
}

/// Every searchable document of the vault, sorted by UTF-16 path order.
pub fn list_sources(root: &Path) -> Vec<DocSource> {
    let mut out = Vec::new();
    let mut stack = vec![(String::new(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let (sources, folders) = list_dir(root, &dir);
        out.extend(sources);
        if depth < MAX_TREE_DEPTH {
            stack.extend(folders.into_iter().map(|folder| (folder, depth + 1)));
        }
    }
    sort_paths(&mut out);
    out
}

pub fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub fn sort_paths(sources: &mut [DocSource]) {
    sources.sort_by(|a, b| utf16_cmp(&a.path, &b.path));
}

fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.kind().to_string())?;
    if !metadata.is_file() {
        return Err("not a regular file".to_owned());
    }
    if metadata.len() > max {
        return Err("too large".to_owned());
    }
    fs::read(path).map_err(|error| error.kind().to_string())
}

fn read_text(root: &Path, relative: &str, max: u64) -> Result<String, String> {
    read_limited(&absolute(root, relative), max)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn trim_js(text: &str) -> &str {
    text.trim_matches(|c: char| (c as u32) < 0x10000 && is_js_space(c as u32 as u16))
}

/// `chunk(text)` of `extract.ts`, in UTF-16 units.
pub fn chunk(text: &str) -> Vec<String> {
    let units = utf16(text);
    let mut rest: &[u16] = &units[..units.len().min(MAX_NOTE_CHARS)];
    let mut parts = Vec::new();
    let floor = (NOTE_CHUNK as f64 * 0.6) as usize;
    let last_index = |slice: &[u16], unit: u16| {
        (0..=NOTE_CHUNK.min(slice.len() - 1))
            .rev()
            .find(|&at| slice[at] == unit)
    };
    while rest.len() > NOTE_CHUNK {
        let mut cut = last_index(rest, b'\n' as u16);
        if cut.is_none_or(|cut| cut < floor) {
            cut = last_index(rest, b' ' as u16);
        }
        let cut = match cut {
            Some(cut) if cut >= floor => cut,
            _ => NOTE_CHUNK,
        };
        parts.push(from_utf16(&rest[..cut]));
        rest = &rest[cut..];
    }
    let tail = from_utf16(rest);
    if !trim_js(&tail).is_empty() {
        parts.push(tail);
    }
    parts
}

/// `/<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu` matches: (start, end, id).
fn worksheet_markers(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(offset) = text[search..].find("<!--") {
        let start = search + offset;
        let mut at = start + 4;
        let skip = |at: &mut usize| {
            while let Some(c) = text[*at..].chars().next() {
                if (c as u32) < 0x10000 && is_js_space(c as u32 as u16) {
                    *at += c.len_utf8()
                } else {
                    break;
                }
            }
        };
        skip(&mut at);
        let matched = (|| {
            let rest = text[at..].strip_prefix("fanotes-worksheet:")?;
            let id_len = rest
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
                .count();
            if id_len == 0 || id_len > 96 {
                return None;
            }
            let id = rest[..id_len].to_owned();
            let mut end = at + "fanotes-worksheet:".len() + id_len;
            skip(&mut end);
            text[end..].starts_with("-->").then(|| (end + 3, id))
        })();
        match matched {
            Some((end, id)) => {
                out.push((start, end, id));
                search = end;
            }
            None => search = start + 4,
        }
    }
    out
}

fn replace_worksheet_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end, _) in worksheet_markers(text) {
        out.push_str(&text[at..start]);
        out.push(' ');
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

fn unit(path: &str, kind: UnitKind, n: usize, source: UnitSource, text: String) -> IndexUnit {
    let name = match kind {
        UnitKind::Note => "note",
        UnitKind::Ink => "ink",
        UnitKind::PdfPage => "pdf-page",
        UnitKind::Worksheet => "worksheet",
        UnitKind::Annotations => "annotations",
        UnitKind::Scene => "scene",
    };
    IndexUnit {
        id: format!("{path}#{name}:{n}"),
        path: path.to_owned(),
        kind,
        page: None,
        worksheet_id: None,
        source,
        confidence: None,
        text,
    }
}

fn is_finite_number(value: Option<&Value>, min: f64, max: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.is_finite() && number >= min && number <= max)
}

fn valid_id(value: &str) -> bool {
    (1..=96).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The worksheet text the TS extractor indexes: title, then typed boxes. Null when the host would refuse it.
fn worksheet_text(root: &Path, id: &str) -> Option<(String, String, String)> {
    let raw = read_text(
        root,
        &format!("{WORKSHEET_DIRECTORY}/{id}.json"),
        MAX_WORKSHEET_BYTES,
    )
    .ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let object = value.as_object()?;
    if object.get("id").and_then(Value::as_str) != Some(id)
        || object.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
    {
        return None;
    }
    let title = object.get("title")?.as_str()?;
    if trim_js(title).is_empty()
        || title.encode_utf16().count() > 180
        || title.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
    {
        return None;
    }
    let source = object.get("sourceRelativePath")?.as_str()?;
    let extension = extension_of(source.rsplit('/').next().unwrap_or(source));
    let kind = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" => "image",
        "pdf" => "pdf",
        "html" => "html",
        _ => return None,
    };
    if object.get("kind").and_then(Value::as_str) != Some(kind) {
        return None;
    }
    let expected = [
        format!(".fanotes/worksheets/{id}.{extension}"),
        format!(".lernwerk/worksheets/{id}.{extension}"),
    ];
    if !expected.iter().any(|path| path == source) {
        return None;
    }
    let boxes = object.get("textBoxes")?.as_array()?;
    if boxes.len() > 2000 {
        return None;
    }
    let mut typed: Vec<&str> = Vec::new();
    for entry in boxes {
        let entry = entry.as_object()?;
        if !entry
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(valid_id)
            || !entry
                .get("page")
                .and_then(Value::as_f64)
                .is_some_and(|page| page.fract() == 0.0 && (1.0..=2000.0).contains(&page))
            || !is_finite_number(entry.get("x"), 0.0, 1.0)
            || !is_finite_number(entry.get("y"), 0.0, 1.0)
            || !is_finite_number(entry.get("width"), 0.05, 1.0)
            || !is_finite_number(entry.get("fontSize"), 8.0, 96.0)
        {
            return None;
        }
        let text = entry.get("text")?.as_str()?;
        if text.encode_utf16().count() > 20_000 || text.contains('\0') {
            return None;
        }
        if !text.is_empty() {
            typed.push(text);
        }
    }
    // The host also requires the source file next to the JSON.
    let source_name = source.rsplit('/').next()?;
    let source_meta = fs::symlink_metadata(absolute(
        root,
        &format!("{WORKSHEET_DIRECTORY}/{source_name}"),
    ))
    .ok()?;
    if !source_meta.is_file() {
        return None;
    }
    Some((trim_js(title).to_owned(), typed.join("\n"), kind.to_owned()))
}

fn extract_note(root: &Path, source: &DocSource) -> Extracted {
    let max = if source.path.to_lowercase().ends_with(".famd") {
        MAX_FAMD_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    let raw = match read_text(root, &source.path, max) {
        Ok(text) => strip_famd_payload(&text),
        Err(error) => {
            return Extracted {
                units: Vec::new(),
                status: DocStatus::Failed,
                reason: Some(format!("Lesen: {error}")),
                issues: Vec::new(),
            }
        }
    };
    let mut units = Vec::new();
    let markdown = replace_worksheet_markers(&strip_famd_payload(&raw));
    for (index, text) in chunk(&markdown).into_iter().enumerate() {
        units.push(unit(
            &source.path,
            UnitKind::Note,
            index + 1,
            UnitSource::Text,
            text,
        ));
    }
    let companion = format!("{}.famd", stem_of(&source.path));
    let transcript = read_text(root, &companion, MAX_FAMD_BYTES)
        .ok()
        .and_then(|text| famd_transcript(&text))
        .unwrap_or_default();
    if !trim_js(&transcript).is_empty() {
        for (index, text) in chunk(&transcript).into_iter().enumerate() {
            units.push(unit(
                &source.path,
                UnitKind::Ink,
                index + 1,
                UnitSource::Transcript,
                text,
            ));
        }
    }
    let mut issues = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for (_, _, id) in worksheet_markers(&raw) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    for (index, id) in ids.iter().take(MAX_WORKSHEETS).enumerate() {
        let n = index + 1;
        let Some((title, typed, kind)) = worksheet_text(root, id) else {
            issues.push(format!("worksheet {n}: worksheet-missing"));
            continue;
        };
        if kind == "image" {
            issues.push(format!("worksheet {n}: ocr-not-native"));
        }
        let text = [title, typed]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let text = cut_utf16(&text, PAGE_MAX_CHARS);
        if !trim_js(&text).is_empty() {
            let mut sheet = unit(&source.path, UnitKind::Worksheet, n, UnitSource::Text, text);
            sheet.page = Some(n as u32);
            sheet.worksheet_id = Some(id.clone());
            units.push(sheet);
        }
    }
    Extracted {
        units,
        status: DocStatus::Indexed,
        reason: None,
        issues,
    }
}

/// `pdfByteStamp`: FNV-1a over the length bytes, every ⌊len/4096⌋-th byte and the last byte.
pub fn pdf_byte_stamp(path: &Path, length: u64) -> std::io::Result<String> {
    let mut hash: u32 = 0x811c_9dc5;
    let mut mix = |value: u32| {
        hash ^= value & 0xff;
        hash = hash.wrapping_mul(0x0100_0193);
    };
    let length32 = length as u32;
    for shift in [0, 8, 16, 24] {
        mix(length32 >> shift);
    }
    let step = (length / 4096).max(1);
    let mut file = fs::File::open(path)?;
    if length <= 8 * 1024 * 1024 {
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes)?;
        let mut index = 0u64;
        while index < length {
            mix(bytes.get(index as usize).copied().unwrap_or(0) as u32);
            index += step;
        }
        if length > 0 {
            mix(bytes.get(length as usize - 1).copied().unwrap_or(0) as u32);
        }
    } else {
        let mut byte = [0u8; 1];
        let mut read_at = |file: &mut fs::File, at: u64| -> std::io::Result<u32> {
            file.seek(SeekFrom::Start(at))?;
            Ok(match file.read(&mut byte)? {
                1 => byte[0] as u32,
                _ => 0,
            })
        };
        let mut index = 0u64;
        while index < length {
            let value = read_at(&mut file, index)?;
            mix(value);
            index += step;
        }
        let value = read_at(&mut file, length - 1)?;
        mix(value);
    }
    Ok(format!("{hash:08x}"))
}

fn valid_record_path(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 4096
        && !value.contains('\0')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

/// `sanitizePageTextRecord` + `pageTextRecordMatches`: the `ok` pages, or None.
fn page_text_pages(
    root: &Path,
    path: &str,
    size: u64,
    stamp: &str,
) -> Option<Vec<(u32, UnitSource, Option<f64>, String)>> {
    let raw = read_text(root, &page_text_sidecar(path), MAX_PAGE_TEXT_BYTES).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let record = value.as_object()?;
    if record.get("format")?.as_str()? != "fanotes-page-text-v1" {
        return None;
    }
    let record_path = record.get("path")?.as_str()?;
    if !valid_record_path(record_path) || record_path != path {
        return None;
    }
    let record_size = safe_integer(record.get("size"))?;
    if record_size < 1 || record_size as u64 > MAX_PDF_BYTES || record_size as u64 != size {
        return None;
    }
    let record_stamp = record.get("stamp")?.as_str()?;
    if record_stamp.len() != 8
        || !record_stamp
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || record_stamp != stamp
    {
        return None;
    }
    let page_count = safe_integer(record.get("pageCount"))?;
    if !(0..=100_000).contains(&page_count) {
        return None;
    }
    if !record
        .get("producer")?
        .as_str()
        .is_some_and(|text| text.encode_utf16().count() <= 200)
    {
        return None;
    }
    if let Some(engine) = record.get("ocrEngine") {
        if !engine
            .as_str()
            .is_some_and(|text| text.encode_utf16().count() <= 100)
        {
            return None;
        }
    }
    record.get("createdAt")?.as_str()?;
    let pages = record.get("pages")?.as_array()?;
    if pages.len() > 2000 {
        return None;
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in pages {
        let page = entry.as_object()?;
        let number = safe_integer(page.get("page"))?;
        if number < 1 || number > page_count || !seen.insert(number) {
            return None;
        }
        let source = match page.get("source")?.as_str()? {
            "text-layer" => UnitSource::TextLayer,
            "ocr" => UnitSource::Ocr,
            _ => return None,
        };
        let status = page.get("status")?.as_str()?;
        if !matches!(status, "ok" | "empty" | "failed" | "skipped") {
            return None;
        }
        let text = page.get("text")?.as_str()?;
        if text.encode_utf16().count() > PAGE_MAX_CHARS {
            return None;
        }
        let confidence = match page.get("confidence") {
            None => None,
            Some(value) => Some(value.as_f64().filter(|c| (0.0..=1.0).contains(c))?),
        };
        if let Some(rotation) = page.get("rotation") {
            if !rotation
                .as_f64()
                .is_some_and(|r| [0.0, 90.0, 180.0, 270.0].contains(&r))
            {
                return None;
            }
        }
        if let Some(reason) = page.get("reason") {
            if !reason
                .as_str()
                .is_some_and(|text| text.encode_utf16().count() <= 120)
            {
                return None;
            }
        }
        if status == "ok" {
            out.push((number as u32, source, confidence, text.to_owned()));
        }
    }
    out.sort_by_key(|page| page.0);
    Some(out)
}

fn collapsed_len(text: &str) -> usize {
    let units = utf16(text);
    let mut length = 0usize;
    let mut space = false;
    let mut started = false;
    for unit in units {
        if is_js_space(unit) {
            space = true;
        } else {
            if space && started {
                length += 1;
            }
            length += 1;
            space = false;
            started = true;
        }
    }
    length
}

fn letter_count(text: &str) -> usize {
    text.chars().filter(|&c| is_letter(c)).count()
}

fn extract_pdf(root: &Path, source: &DocSource) -> Extracted {
    let file = absolute(root, &source.path);
    let size = match fs::symlink_metadata(&file) {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => {
            return Extracted {
                units: Vec::new(),
                status: DocStatus::Failed,
                reason: Some("Lesen: not a file".into()),
                issues: Vec::new(),
            }
        }
        Err(error) => {
            return Extracted {
                units: Vec::new(),
                status: DocStatus::Failed,
                reason: Some(format!("Lesen: {}", error.kind())),
                issues: Vec::new(),
            }
        }
    };
    if size > MAX_PDF_BYTES {
        return Extracted {
            units: Vec::new(),
            status: DocStatus::Unsupported,
            reason: Some("Datei grösser als 96 MB".into()),
            issues: Vec::new(),
        };
    }
    let mut units = Vec::new();
    let companion = format!("{}.famd", stem_of(&source.path));
    if let Ok(text) = read_text(root, &companion, MAX_FAMD_BYTES) {
        let markdown = replace_worksheet_markers(&strip_famd_payload(&strip_famd_payload(&text)));
        let markdown = trim_js(&markdown);
        if !markdown.is_empty() {
            units.push(unit(
                &source.path,
                UnitKind::Annotations,
                1,
                UnitSource::Text,
                cut_utf16(markdown, PAGE_MAX_CHARS),
            ));
        }
    }
    let stamp = match pdf_byte_stamp(&file, size) {
        Ok(stamp) => stamp,
        Err(error) => {
            return Extracted {
                units,
                status: DocStatus::Failed,
                reason: Some(format!("Lesen: {}", error.kind())),
                issues: Vec::new(),
            }
        }
    };
    let Some(pages) = page_text_pages(root, &source.path, size, &stamp) else {
        return Extracted {
            units,
            status: DocStatus::Partial,
            reason: Some("no-page-text".into()),
            issues: Vec::new(),
        };
    };
    let mut issues = Vec::new();
    for (page, kind, confidence, text) in pages {
        let usable = match kind {
            UnitSource::TextLayer => collapsed_len(&text) >= PDF_MIN_TEXT,
            _ => letter_count(&text) >= 3,
        };
        if !usable {
            issues.push(format!("pdf-page {page}: no-letters"));
            continue;
        }
        let mut entry = unit(&source.path, UnitKind::PdfPage, page as usize, kind, text);
        entry.page = Some(page);
        if kind == UnitSource::Ocr {
            entry.confidence = confidence;
        }
        units.push(entry);
    }
    Extracted {
        units,
        status: DocStatus::Indexed,
        reason: None,
        issues,
    }
}

fn scene_text(value: &Value) -> Option<String> {
    let scene = value.as_object()?;
    if scene.get("format")?.as_str()? != "fanotes-story-scene-v1" {
        return None;
    }
    let paragraphs: Vec<&serde_json::Map<String, Value>> = scene
        .get("paragraphs")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let mut live: Vec<&serde_json::Map<String, Value>> = paragraphs
        .into_iter()
        .filter(|p| p.get("deleted") != Some(&Value::Bool(true)))
        .collect();
    let key = |p: &serde_json::Map<String, Value>| {
        p.get("key")
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty())
            .map(str::to_owned)
    };
    if live.iter().all(|p| key(p).is_some()) {
        let id = |p: &serde_json::Map<String, Value>| {
            p.get("id").and_then(Value::as_str).unwrap_or("").to_owned()
        };
        live.sort_by(|a, b| {
            utf16_cmp(&key(a).unwrap_or_default(), &key(b).unwrap_or_default())
                .then_with(|| utf16_cmp(&id(a), &id(b)))
        });
    }
    let lines: Vec<String> = live
        .iter()
        .map(|p| {
            let runs = p
                .get("runs")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let text: String = runs
                .iter()
                .filter_map(Value::as_object)
                .map(|run| run.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect();
            text.replace("\r\n", "\n").replace('\r', "\n")
        })
        .collect();
    Some(lines.join("\n"))
}

fn binder_scene_ids(nodes: &[Value], out: &mut Vec<String>) {
    for node in nodes {
        let Some(node) = node.as_object() else {
            continue;
        };
        if node.get("kind").and_then(Value::as_str) == Some("scene") {
            if let Some(id) = node.get("id").and_then(Value::as_str) {
                if !out.iter().any(|known| known == id) {
                    out.push(id.to_owned());
                }
            }
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            binder_scene_ids(children, out);
        }
    }
}

fn valid_scene_id(id: &str) -> bool {
    (6..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// `storySearchUnits` of `docSearch/story.ts`.
fn extract_story(root: &Path, source: &DocSource) -> Extracted {
    let mut scenes: HashMap<String, String> = HashMap::new();
    if let Ok(entries) = fs::read_dir(absolute(root, &format!("{}/scenes", source.path))) {
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let Some(id) = name.strip_suffix(".json").filter(|id| valid_scene_id(id)) else {
                continue;
            };
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(raw) = read_text(
                root,
                &format!("{}/scenes/{name}", source.path),
                MAX_STORY_FILE_BYTES,
            ) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(text) = scene_text(&value) {
                scenes.insert(id.to_owned(), text);
            }
        }
    }
    let mut order: Vec<String> = Vec::new();
    if let Ok(raw) = read_text(
        root,
        &format!("{}/story.json", source.path),
        MAX_STORY_FILE_BYTES,
    ) {
        if let Ok(manifest) = serde_json::from_str::<Value>(&raw) {
            if manifest.get("format").and_then(Value::as_str) == Some("fanotes-story-v1") {
                if let Some(binder) = manifest.get("binder").and_then(Value::as_array) {
                    binder_scene_ids(binder, &mut order);
                }
            }
        }
    }
    order.retain(|id| scenes.contains_key(id));
    let mut rest: Vec<String> = scenes
        .keys()
        .filter(|id| !order.contains(id))
        .cloned()
        .collect();
    rest.sort_by(|a, b| utf16_cmp(a, b));
    order.extend(rest);
    let mut units = Vec::new();
    let mut n = 0;
    for (index, id) in order.iter().enumerate() {
        for text in chunk(&scenes[id]) {
            n += 1;
            let mut entry = unit(&source.path, UnitKind::Scene, n, UnitSource::Text, text);
            entry.page = Some(index as u32 + 1);
            units.push(entry);
        }
    }
    Extracted {
        units,
        status: DocStatus::Indexed,
        reason: None,
        issues: Vec::new(),
    }
}

/// The units of one document, in the order the TS extractor commits them.
pub fn extract(root: &Path, source: &DocSource) -> Extracted {
    match source.kind {
        DocKind::Note => extract_note(root, source),
        DocKind::Pdf => extract_pdf(root, source),
        DocKind::Story => extract_story(root, source),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_chunks() {
        assert_eq!(stem_of("a/b.PDF"), "a/b");
        assert_eq!(stem_of("a.b/c"), "a.b/c");
        assert_eq!(title_of("Ordner/Roman.story"), "Roman");
        assert_eq!(
            page_text_sidecar("a.pdf").len(),
            PAGE_TEXT_DIRECTORY.len() + 1 + 32 + 5
        );
        let long = "wort ".repeat(3000);
        let parts = chunk(&long);
        assert_eq!(parts.concat(), long);
        assert!(parts.iter().all(|part| part.len() <= NOTE_CHUNK));
        assert!(chunk("   ").is_empty());
        assert_eq!(
            replace_worksheet_markers("a<!-- fanotes-worksheet:ab_1 -->b"),
            "a b"
        );
        assert_eq!(collapsed_len("  a \n b  "), 3);
    }
}
