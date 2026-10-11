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
