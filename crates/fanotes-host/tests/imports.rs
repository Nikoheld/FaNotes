use base64::Engine;
use fanotes_famd::parse_famd;
use fanotes_host::Host;
use serde_json::json;

fn host() -> (Host, std::path::PathBuf) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-imports-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    (host, vault)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn a_worksheet_byte_list_follows_buffer_from() {
    let (mut host, vault) = host();
    let document = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": "Tafel.png",
                "bytes": [137.0, 80, 78, 71, 13, 10, 26, 10, 1.5, 256, -1, "1e1", true, null]
            })],
        )
        .unwrap();
    let id = document["id"].as_str().unwrap();
    assert_eq!(
        std::fs::read(vault.join(format!(".fanotes/worksheets/{id}.png"))).unwrap(),
        vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 0, 255, 10, 1, 0]
    );
    assert!(host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({ "name": "Tafel.png", "bytes": 4 })],
        )
        .is_err());
}

#[test]
fn a_worksheet_name_with_a_slash_is_not_a_title() {
    let (mut host, vault) = host();
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let error = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({ "name": "Ordner/Foto.png", "bytes": png })],
        )
        .unwrap_err();
    assert_eq!(error, "Dieser Name ist nicht erlaubt.");
    let backslash = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({ "name": "Ordner\\Foto.png", "bytes": png })],
        )
        .unwrap_err();
    assert_eq!(backslash, "Dieser Name ist nicht erlaubt.");
    assert!(!vault.join(".fanotes/worksheets").exists());
    let document = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({ "name": "My.Photo.png", "bytes": png })],
        )
        .unwrap();
    assert_eq!(document["title"], "My.Photo");
}

#[test]
fn a_dropped_image_and_a_pdf_note_land_in_the_vault() {
    let (mut host, vault) = host();
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    let document = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": "Tafel.png",
                "mimeType": "image/png",
                "bytesBase64": b64(&png),
            })],
        )
        .unwrap();
    let id = document["id"].as_str().unwrap();
    assert_eq!(document["kind"], "image");
    assert_eq!(document["title"], "Tafel");
    assert_eq!(
        std::fs::read(vault.join(format!(".fanotes/worksheets/{id}.png"))).unwrap(),
        png
    );
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!(id)])
            .unwrap()["id"],
        id
    );
    assert!(host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({ "name": "notes.txt", "bytesBase64": b64(b"hello") })],
        )
        .is_err());

    let pdf = b"%PDF-1.4\n";
    let first = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": "Skript.pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(first["relativePath"], "Mathe/Skript.pdf");
    let imported = vault.join("Mathe/Skript.pdf");
    assert_eq!(std::fs::read(&imported).unwrap(), pdf);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&imported).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let famd = std::fs::read_to_string(vault.join("Mathe/Skript.famd")).unwrap();
    assert!(parse_famd(&famd).payload.is_some());

    let second = host
        .dispatch(
            "fanotes:import-subject-book",
            &[
                json!("Mathe"),
                json!({ "name": "Skript.pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(second["relativePath"], "Mathe/Skript 2.pdf");
    assert!(host
        .dispatch("fanotes:import-subject-book", &[json!("")])
        .is_err());
}

#[test]
fn a_device_name_cannot_be_imported_as_a_note_or_worksheet() {
    let (mut host, vault) = host();
    let pdf = b"%PDF-1.4\n";
    let note_error = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": "CON.pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap_err();
    assert!(note_error.contains("nicht erlaubt"), "{note_error}");
    assert!(!vault.join("Mathe/CON.pdf").exists());

    let allowed = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": "COM10.pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(allowed["relativePath"], "Mathe/COM10.pdf");

    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    let sheet_error = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": "CON.png",
                "bytesBase64": b64(&png),
            })],
        )
        .unwrap_err();
    assert!(sheet_error.contains("nicht erlaubt"), "{sheet_error}");
    let marked = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": "a<b.png",
                "bytesBase64": b64(&png),
            })],
        )
        .unwrap_err();
    assert!(marked.contains("nicht erlaubt"), "{marked}");
    assert!(
        vault.join(".fanotes/worksheets").read_dir().is_err()
            || vault
                .join(".fanotes/worksheets")
                .read_dir()
                .unwrap()
                .next()
                .is_none()
    );
}

#[test]
fn a_one_dot_worksheet_name_uses_the_image_fallback() {
    let (mut host, vault) = host();
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    let dropped = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": ".pdf",
                "bytesBase64": b64(&png),
            })],
        )
        .unwrap();
    let source = dropped["sourceRelativePath"].as_str().unwrap();
    assert!(source.ends_with(".png"), "{source}");
    assert_eq!(dropped["mimeType"], "image/png");
    assert_eq!(dropped["title"], ".pdf");
    assert!(vault.join(source).is_file());

    let pdf = b"%PDF-1.4\n";
    let mismatch = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": ".pdf",
                "bytesBase64": b64(pdf),
            })],
        )
        .unwrap_err();
    assert!(mismatch.contains("stimmt nicht"), "{mismatch}");

    let typed = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": ".pdf",
                "mimeType": "application/pdf",
                "bytesBase64": b64(pdf),
            })],
        )
        .unwrap();
    assert!(typed["sourceRelativePath"]
        .as_str()
        .unwrap()
        .ends_with(".pdf"));
    assert_eq!(typed["kind"], "pdf");

    let hidden = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": ".hidden.png",
                "bytesBase64": b64(&png),
            })],
        )
        .unwrap();
    assert!(hidden["sourceRelativePath"]
        .as_str()
        .unwrap()
        .ends_with(".png"));
    assert_eq!(hidden["title"], ".hidden");
}

#[test]
fn a_blank_pdf_stem_uses_the_interface_language() {
    let (mut host, vault) = host();
    let pdf = b"%PDF-1.4\n";
    host.settings.insert("uiLanguage".to_owned(), json!("en"));
    let note = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": " .pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(note["relativePath"], "Mathe/PDF note.pdf");
    let book = host
        .dispatch(
            "fanotes:import-subject-book",
            &[
                json!("Mathe"),
                json!({ "name": " .pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(book["relativePath"], "Mathe/Book.pdf");
    assert!(vault.join("Mathe/PDF note.pdf").is_file());
    assert!(vault.join("Mathe/Book.pdf").is_file());

    host.settings.insert("uiLanguage".to_owned(), json!("de"));
    let german_note = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": " .pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(german_note["relativePath"], "Mathe/PDF-Notiz.pdf");
    let german_book = host
        .dispatch(
            "fanotes:import-subject-book",
            &[
                json!("Mathe"),
                json!({ "name": " .pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(german_book["relativePath"], "Mathe/Buch.pdf");

    let book_error = host
        .dispatch(
            "fanotes:import-subject-book",
            &[
                json!("Mathe"),
                json!({ "name": "notes.txt", "bytesBase64": b64(b"hello") }),
            ],
        )
        .unwrap_err();
    assert!(book_error.contains("als Buch"));
    let note_error = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": "notes.txt", "bytesBase64": b64(b"hello") }),
            ],
        )
        .unwrap_err();
    assert!(note_error.contains("PDF-Notiz"));
}

#[test]
fn a_next_line_import_folder_is_not_the_vault_root() {
    let (mut host, vault) = host();
    let error = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("\u{0085}"),
                json!({ "name": "Skript.pdf", "bytesBase64": b64(b"%PDF-1.4\n") }),
            ],
        )
        .unwrap_err();
    assert!(error.contains("nicht gefunden"), "{error}");
    assert!(!vault.join("Skript.pdf").exists());
}

#[test]
fn a_one_dot_pdf_name_is_not_a_pdf_import() {
    let (mut host, vault) = host();
    let payload = json!({ "name": ".pdf", "bytesBase64": b64(b"%PDF-1.4\n") });
    let note = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[json!("Mathe"), payload.clone()],
        )
        .unwrap_err();
    assert!(note.contains("PDF-Notiz"), "{note}");
    let book = host
        .dispatch("fanotes:import-subject-book", &[json!("Mathe"), payload])
        .unwrap_err();
    assert!(book.contains("als Buch"), "{book}");
    assert!(!vault.join("Mathe/.pdf").exists());
    assert!(!vault.join(".pdf").exists());
}

#[test]
fn a_subject_book_uses_the_desktop_trim_only_to_reject_a_blank_subject() {
    let (mut host, vault) = host();
    let pdf = json!({ "name": "Skript.pdf", "bytesBase64": b64(b"%PDF-1.4\n") });
    let blank = host
        .dispatch(
            "fanotes:import-subject-book",
            &[json!("\u{FEFF}"), pdf.clone()],
        )
        .unwrap_err();
    assert!(blank.contains("Wähle zuerst ein Fach"), "{blank}");
    assert!(!vault.join("Skript.pdf").exists());

    let spaced = host
        .dispatch(
            "fanotes:import-subject-book",
            &[json!(" Mathe"), pdf.clone()],
        )
        .unwrap_err();
    assert!(spaced.contains("nicht gefunden"), "{spaced}");
    assert!(!vault.join("Mathe/Skript.pdf").exists());

    let next_line = host
        .dispatch(
            "fanotes:import-subject-book",
            &[json!("\u{0085}Mathe"), pdf],
        )
        .unwrap_err();
    assert!(next_line.contains("nicht gefunden"), "{next_line}");
    assert!(!next_line.contains("Wähle zuerst ein Fach"), "{next_line}");
    assert!(!vault.join("Mathe/Skript.pdf").exists());
    assert!(!vault.join("Skript.pdf").exists());
}
