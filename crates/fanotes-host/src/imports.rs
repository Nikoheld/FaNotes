//! PDF note and subject-book imports.
//!
//! A file dialog supplies the bytes when the renderer only names a folder.
//! Tests and callers that already have the file pass `{ name, bytesBase64 }`.

use std::fs;
use std::path::{Path, PathBuf};

use fanotes_famd::{companion_note_path, empty_famd_payload, serialize_famd};
use serde_json::{json, Value};

use crate::vault;
use crate::worksheets::decode_payload_bytes;
use crate::Host;

pub fn import_worksheet(host: &Host) -> Result<Value, String> {
    let (title, filters) = crate::dialogs::worksheet_import_dialog(host.ui_language());
    let Some(path) = pick_file(host, title, &filters)? else {
        return Ok(Value::Null);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Bild.png");
    crate::worksheets::import_picked_worksheet(host, &path, name)
}

pub fn import_pdf_note(host: &Host, args: &[Value]) -> Result<Value, String> {
    let parent = args.first().and_then(Value::as_str).unwrap_or("");
    if let Some(payload) = args.get(1).filter(|value| value.is_object()) {
        return import_pdf_payload(host, parent, payload);
    }
    let (title, filters) = crate::dialogs::pdf_note_import_dialog(host.ui_language());
    let Some(path) = pick_file(host, title, &filters)? else {
        return Ok(Value::Null);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("PDF-Notiz.pdf");
    let bytes = read_dialog_pdf(
        &path,
        name,
        "Es können nur PDF-Dateien als PDF-Notiz importiert werden.",
    )?;
    import_pdf_payload(host, parent, &json!({ "name": name, "bytes": bytes }))
}

pub fn import_subject_book(host: &Host, args: &[Value]) -> Result<Value, String> {
    let subject = args.first().and_then(Value::as_str).unwrap_or("");
    if vault::js_trim(subject).is_empty() {
        return Err("Wähle zuerst ein Fach für das Buch.".to_owned());
    }
    // The subject path shape is checked before the file dialog opens.
    let subject = vault::normalize_relative_path(subject, false, false)?;
    if let Some(payload) = args.get(1).filter(|value| value.is_object()) {
        return import_pdf_file(host, &subject, payload, PdfKind::Book);
    }
    let (title, filters) = crate::dialogs::subject_book_import_dialog(host.ui_language());
    let Some(path) = pick_file(host, title, &filters)? else {
        return Ok(Value::Null);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Buch.pdf");
    let bytes = read_dialog_pdf(
        &path,
        name,
        "Es können nur PDF-Dateien als Buch hinzugefügt werden.",
    )?;
    import_pdf_file(
        host,
        &subject,
        &json!({ "name": name, "bytes": bytes }),
        PdfKind::Book,
    )
}

fn import_pdf_payload(host: &Host, parent: &str, payload: &Value) -> Result<Value, String> {
    import_pdf_file(host, parent, payload, PdfKind::Note)
}

enum PdfKind {
    Note,
    Book,
}

impl PdfKind {
    fn fallback(&self, english: bool) -> &'static str {
        match (self, english) {
            (PdfKind::Note, false) => "PDF-Notiz",
            (PdfKind::Note, true) => "PDF note",
            (PdfKind::Book, false) => "Buch",
            (PdfKind::Book, true) => "Book",
        }
    }

    fn not_pdf(&self) -> &'static str {
        match self {
            PdfKind::Note => "Es können nur PDF-Dateien als PDF-Notiz importiert werden.",
            PdfKind::Book => "Es können nur PDF-Dateien als Buch hinzugefügt werden.",
        }
    }

    fn no_unique_name(&self) -> &'static str {
        match self {
            PdfKind::Note => "Es konnte kein eindeutiger PDF-Name erzeugt werden.",
            PdfKind::Book => "Es konnte kein eindeutiger Buchname erzeugt werden.",
        }
    }
}

fn import_pdf_file(
    host: &Host,
    parent: &str,
    payload: &Value,
    kind: PdfKind,
) -> Result<Value, String> {
    let root = vault_root(host)?.to_path_buf();
    let fallback = kind.fallback(host.ui_language() == "en");
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback);
    if payload.get("name").is_some()
        && !crate::vault::posix_extname(name).eq_ignore_ascii_case(".pdf")
    {
        return Err(kind.not_pdf().to_owned());
    }
    // A book subject is shaped before the file is read. A PDF note checks the
    // file first, then the destination folder.
    let book_parent = if matches!(kind, PdfKind::Book) {
        Some(vault::normalize_relative_path(parent, false, false)?)
    } else {
        None
    };
    if pdf_payload_is_empty(payload) {
        return Err("Die ausgewählte PDF-Datei ist leer.".to_owned());
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
    let parent_relative = if let Some(parent) = book_parent {
        parent
    } else if parent.is_empty() {
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
            return Err("Der gewählte Pfad ist kein Ordner.".to_owned());
        }
        path
    };
    let stem = safe_stem(file_stem(name), fallback)?;
    let desired = format!("{stem}.pdf");
    let candidate = place_new_pdf(&parent_path, &desired, &bytes, kind.no_unique_name())?;
    let absolute = parent_path.join(&candidate);
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
    let modified = meta
        .modified()
        .ok()
        .map(crate::notes::iso_from_system_time)
        .unwrap_or_else(now_iso);
    Ok(json!({
        "relativePath": relative,
        "entry": {
            "name": candidate,
            "relativePath": relative,
            "kind": "file",
            "extension": "pdf",
            "modifiedAt": modified,
            "size": meta.len(),
        }
    }))
}

/// A file dialog PDF is checked the same way as a picked worksheet.
///
/// The extension comes first. A directory or symlink is not a regular file,
/// and a file past 96 MiB is too big before any bytes are read.
fn read_dialog_pdf(path: &Path, name: &str, not_pdf: &str) -> Result<Vec<u8>, String> {
    if vault::posix_extname_en_us(name) != ".pdf" {
        return Err(not_pdf.to_owned());
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Die Datei ist keine reguläre Datei.".to_owned());
    }
    if meta.len() > 96 * 1024 * 1024 {
        return Err("Die Datei ist zu groß.".to_owned());
    }
    if meta.len() == 0 {
        return Err("Die ausgewählte PDF-Datei ist leer.".to_owned());
    }
    fs::read(path).map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())
}

fn pdf_payload_is_empty(payload: &Value) -> bool {
    match payload
        .get("bytesBase64")
        .or_else(|| payload.get("bytes"))
    {
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::String(text)) => text.is_empty(),
        _ => false,
    }
}

/// Pick a free PDF name and create it. A name that appears between the
/// directory listing and the create, the way the desktop `EEXIST` loop does,
/// is skipped and the next number is tried.
fn place_new_pdf(
    directory: &Path,
    desired: &str,
    bytes: &[u8],
    exhausted: &str,
) -> Result<String, String> {
    let mut occupied = std::collections::HashSet::new();
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                occupied.insert(crate::vault::entry_name_key(name));
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
        if occupied.contains(&crate::vault::entry_name_key(&candidate))
            || occupied.contains(&crate::vault::entry_name_key(&famd))
        {
            continue;
        }
        match crate::notes::publish_new_file(&directory.join(&candidate), bytes, 0o600) {
            Ok(()) => return Ok(candidate),
            Err(crate::notes::NewFileError::Exists) => continue,
            Err(crate::notes::NewFileError::Io) => {
                return Err("Die PDF-Datei konnte nicht gespeichert werden.".to_owned());
            }
        }
    }
    Err(exhausted.to_owned())
}

fn pick_file(
    host: &Host,
    title: &str,
    filters: &[crate::dialogs::DialogFilter],
) -> Result<Option<PathBuf>, String> {
    if !host.file_dialogs {
        return Err("Die Dateiauswahl ist in dieser Sitzung nicht verfügbar.".to_owned());
    }
    let mut dialog = rfd::FileDialog::new().set_title(title);
    for (name, extensions) in filters {
        dialog = dialog.add_filter(*name, *extensions);
    }
    Ok(dialog.pick_file())
}

fn vault_root(host: &Host) -> Result<&Path, String> {
    host.vault
        .as_deref()
        .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())
}

/// `path.basename`, then the stem from `path.extname`.
///
/// Linux `path.basename` leaves a backslash in the name. `My\Notes.pdf` is
/// refused. Windows `path.basename` treats `\` as a separator.
fn file_stem(name: &str) -> &str {
    let base = if cfg!(windows) {
        name.rsplit(['/', '\\']).next().unwrap_or(name)
    } else {
        name.rsplit('/').next().unwrap_or(name)
    };
    base.rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|stem| !stem.is_empty())
        .unwrap_or(base)
}

fn safe_stem(value: &str, fallback: &str) -> Result<String, String> {
    super::safe_entry_name_or(value, fallback)
}

#[cfg(test)]
mod tests {
    use super::{import_pdf_payload, import_subject_book, read_dialog_pdf};
    use crate::Host;
    use serde_json::json;

    #[test]
    fn an_imported_pdf_reports_the_file_modification_time() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-pdf-mtime-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = dir.join("vault");
        std::fs::create_dir_all(vault.join("Mathe")).unwrap();
        let mut host = Host::open(dir.join("app"));
        host.set_vault(vault.clone()).unwrap();
        let result = import_pdf_payload(
            &host,
            "Mathe",
            &json!({ "name": "Skript.pdf", "bytes": b"%PDF-1.4\n".to_vec() }),
        )
        .unwrap();
        let path = vault.join("Mathe/Skript.pdf");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(
            result["entry"]["modifiedAt"],
            crate::notes::iso_from_system_time(modified)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backslash_in_a_pdf_name_stays_in_the_linux_file_name() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-pdf-backslash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = dir.join("vault");
        std::fs::create_dir_all(vault.join("Mathe")).unwrap();
        let mut host = Host::open(dir.join("app"));
        host.set_vault(vault.clone()).unwrap();
        let bytes = json!(b"%PDF-1.4\n".to_vec());
        let slash = import_pdf_payload(
            &host,
            "Mathe",
            &json!({ "name": "Ordner/Foto.pdf", "bytes": bytes }),
        )
        .unwrap();
        assert_eq!(slash["entry"]["name"], "Foto.pdf");
        let named = import_pdf_payload(
            &host,
            "Mathe",
            &json!({ "name": "My\\Notes.pdf", "bytes": bytes }),
        );
        if cfg!(windows) {
            assert_eq!(named.unwrap()["entry"]["name"], "Notes.pdf");
        } else {
            assert_eq!(named.unwrap_err(), "Dieser Name ist nicht erlaubt.");
            assert!(!vault.join("Mathe/Notes.pdf").exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_picked_worksheet_uses_the_desktop_file_messages() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-worksheet-pick-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = dir.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let mut host = Host::open(dir.join("app"));
        host.set_vault(vault.clone()).unwrap();
        let empty = dir.join("Leer.PDF");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            crate::worksheets::import_picked_worksheet(&host, &empty, "Leer.PDF").unwrap_err(),
            "Das ausgewählte Arbeitsblatt ist leer."
        );
        let text = dir.join("notes.txt");
        std::fs::write(&text, b"hello").unwrap();
        assert_eq!(
            crate::worksheets::import_picked_worksheet(&host, &text, "notes.txt").unwrap_err(),
            "Es werden PDF-, PNG-, JPEG-, WebP- und GIF-Arbeitsblätter unterstützt."
        );
        let fake = dir.join("Tafel.png");
        std::fs::write(&fake, b"not a png").unwrap();
        assert_eq!(
            crate::worksheets::import_picked_worksheet(&host, &fake, "Tafel.png").unwrap_err(),
            "Die ausgewählte Datei stimmt nicht mit ihrem Bild- oder PDF-Format überein."
        );
        assert!(!vault.join(".fanotes/worksheets").exists());
        let png = dir.join("Tafel.png");
        std::fs::write(&png, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        let document =
            crate::worksheets::import_picked_worksheet(&host, &png, "Tafel.PNG").unwrap();
        assert_eq!(document["title"], "Tafel");
        assert!(document["sourceRelativePath"]
            .as_str()
            .unwrap()
            .ends_with(".png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pdf_dialog_checks_the_extension_before_the_file() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-pdf-dialog-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let note = "Es können nur PDF-Dateien als PDF-Notiz importiert werden.";
        let text = dir.join("notes.txt");
        std::fs::create_dir(&text).unwrap();
        assert_eq!(read_dialog_pdf(&text, "notes.txt", note).unwrap_err(), note);
        let folder = dir.join("Buch.pdf");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            read_dialog_pdf(&folder, "Buch.pdf", note).unwrap_err(),
            "Die Datei ist keine reguläre Datei."
        );
        let empty = dir.join("Leer.pdf");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            read_dialog_pdf(&empty, "Leer.pdf", note).unwrap_err(),
            "Die ausgewählte PDF-Datei ist leer."
        );
        let huge = dir.join("Gross.pdf");
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(96 * 1024 * 1024 + 1).unwrap();
        assert_eq!(
            read_dialog_pdf(&huge, "Gross.pdf", note).unwrap_err(),
            "Die Datei ist zu groß."
        );
        #[cfg(unix)]
        {
            let real = dir.join("echt.pdf");
            std::fs::write(&real, b"%PDF-1.4\n").unwrap();
            let link = dir.join("Link.pdf");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(
                read_dialog_pdf(&link, "Link.pdf", note).unwrap_err(),
                "Die Datei ist keine reguläre Datei."
            );
            assert_eq!(std::fs::read(&real).unwrap(), b"%PDF-1.4\n");
        }
        let ready = dir.join("Skript.PDF");
        std::fs::write(&ready, b"%PDF-1.4\n").unwrap();
        assert_eq!(
            read_dialog_pdf(&ready, "Skript.PDF", note).unwrap(),
            b"%PDF-1.4\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_subject_book_dialog_rejects_the_folder_shape_before_opening_a_file() {
        let dir = std::env::temp_dir().join(format!(
            "fanotes-book-shape-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = dir.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let mut host = Host::open(dir.join("app"));
        host.file_dialogs = false;
        host.set_vault(vault).unwrap();
        assert_eq!(
            import_subject_book(&host, &[json!("../geheim")]).unwrap_err(),
            "Pfad-Traversal ist nicht erlaubt."
        );
        let _ = std::fs::remove_dir_all(&dir);
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
