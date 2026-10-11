use fanotes_famd::parse_famd;
use fanotes_host::Host;
use serde_json::json;

fn host() -> (Host, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    (host, vault)
}

#[test]
fn paper_links_books_and_history_round_trip() {
    let (mut host, vault) = host();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();

    let style = host
        .dispatch(
            "fanotes:set-note-paper-style",
            &[json!("Mathe/Seite.md"), json!("grid")],
        )
        .unwrap();
    assert_eq!(style, "grid");
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "grid"
    );
    let famd = std::fs::read_to_string(vault.join("Mathe/Seite.famd")).unwrap();
    let parsed = parse_famd(&famd);
    assert_eq!(parsed.markdown.trim(), "Hallo");
    assert_eq!(parsed.payload.unwrap().paper_style.as_deref(), Some("grid"));

    let links = host
        .dispatch(
            "fanotes:write-note-links",
            &[
                json!("Mathe/Seite.md"),
                json!([
                    {
                        "id": "nl-1",
                        "sourcePath": "anders.md",
                        "targetPath": "Physik/Kraft.md",
                        "page": 2,
                        "x": 0.2,
                        "y": 0.4,
                        "style": "text",
                        "label": "Kraft"
                    },
                    { "sourcePath": "Mathe/Seite.md", "targetPath": "kein-ziel" }
                ]),
            ],
        )
        .unwrap();
    assert_eq!(links.as_array().unwrap().len(), 1);
    assert_eq!(links[0]["sourcePath"], "Mathe/Seite.md");
    assert_eq!(links[0]["targetPath"], "Physik/Kraft.md");
    assert_eq!(links[0]["style"], "text");

    let books = host
        .dispatch(
            "fanotes:write-subject-books",
            &[json!([
                { "subjectPath": "Mathe", "bookPath": "Mathe/Buch.pdf", "lastPage": 4 },
                { "subjectPath": "Mathe.md", "bookPath": "Mathe/Buch.pdf", "lastPage": 1 },
                { "subjectPath": "Physik", "bookPath": "notes.txt", "lastPage": 1 }
            ])],
        )
        .unwrap();
    assert_eq!(books.as_array().unwrap().len(), 1);
    assert_eq!(books[0]["lastPage"], 4);
    let stored = host.dispatch("fanotes:read-subject-books", &[]).unwrap();
    assert_eq!(stored, books);

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    let id = history[0]["id"].as_str().unwrap();
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap();
    assert_eq!(snapshot["content"], "Hallo\n");
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "grid"
    );
    assert_eq!(
        std::fs::read_to_string(vault.join("Mathe/Seite.md")).unwrap(),
        "Welt\n"
    );
}

#[test]
fn saving_markdown_keeps_the_handwriting_sidecar() {
    let (mut host, vault) = host();
    let saved = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Seite.md"), json!("Ohne Umbruch")],
        )
        .unwrap();
    assert!(saved["modifiedAt"].as_str().unwrap().contains('T'));
    assert_eq!(
        std::fs::read_to_string(vault.join("Seite.md")).unwrap(),
        "Ohne Umbruch\n"
    );
    let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    payload.ink = Some(json!({
        "schemaVersion": 1,
        "title": "Seite",
        "strokes": [],
        "paperStyle": "lines"
    }));
    payload.paper_style = Some("lines".to_owned());
    std::fs::write(
        vault.join("Seite.famd"),
        fanotes_famd::serialize_famd("Ohne Umbruch", &payload),
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Seite.md"), json!("Neue Fassung\n")],
    )
    .unwrap();
    let ink = host
        .dispatch("fanotes:read-famd-ink", &[json!("Seite.md")])
        .unwrap();
    assert!(ink["drawingJson"].as_str().unwrap().contains("Seite"));
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Seite.md")])
            .unwrap(),
        "lines"
    );
}

#[test]
fn renaming_and_deleting_a_note_moves_its_companion() {
    let (mut host, vault) = host();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:set-note-paper-style",
        &[json!("Mathe/Seite.md"), json!("grid")],
    )
    .unwrap();
    let renamed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md"), json!("Blatt.md")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Blatt.md");
    assert!(!vault.join("Mathe/Seite.famd").exists());
    assert!(vault.join("Mathe/Blatt.famd").is_file());
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Blatt.md")])
            .unwrap(),
        "grid"
    );
    host.dispatch("fanotes:create-folder", &[json!(""), json!("Physik")])
        .unwrap();
    host.dispatch(
        "fanotes:move-entry",
        &[json!("Mathe/Blatt.md"), json!("Physik")],
    )
    .unwrap();
    assert!(vault.join("Physik/Blatt.famd").is_file());
    assert!(!vault.join("Mathe/Blatt.famd").exists());
    host.dispatch("fanotes:trash-entry", &[json!("Physik/Blatt.md")])
        .unwrap();
    assert!(!vault.join("Physik/Blatt.md").exists());
    assert!(!vault.join("Physik/Blatt.famd").exists());
}

#[test]
fn a_second_note_is_numbered_and_reads_without_the_sidecar() {
    let (mut host, vault) = host();
    let first = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
        .unwrap();
    assert_eq!(first["relativePath"], "Mathe/Seite.md");
    assert_eq!(first["entry"]["kind"], "file");
    assert_eq!(first["entry"]["name"], "Seite.md");
    assert_eq!(first["entry"]["extension"], "md");
    assert_eq!(
        std::fs::read_to_string(vault.join("Mathe/Seite.md")).unwrap(),
        "# Seite\n\n"
    );
    let second = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
        .unwrap();
    assert_eq!(second["relativePath"], "Mathe/Seite 2.md");
    let untitled = host.dispatch("fanotes:create-note", &[json!("")]).unwrap();
    assert_eq!(untitled["relativePath"], "Unbenannte Notiz.md");
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!(""), json!("Blatt.txt")])
            .unwrap_err(),
        "Neue Notizen müssen Markdown-Dateien sein."
    );
    let folder = host
        .dispatch("fanotes:create-folder", &[json!(""), json!("Ordner")])
        .unwrap();
    assert_eq!(folder["entry"]["kind"], "folder");
    let folder_again = host
        .dispatch("fanotes:create-folder", &[json!(""), json!("Ordner")])
        .unwrap();
    assert_eq!(folder_again["relativePath"], "Ordner 2");
    let saved = host
        .dispatch(
            "fanotes:write-recognition-model",
            &[json!("{\"version\":1}")],
        )
        .unwrap();
    assert!(saved["modifiedAt"].as_str().unwrap().contains('T'));
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap(),
        "{\"version\":1}"
    );
    std::fs::write(
        vault.join("Mathe/Seite.md"),
        "Hallo\n\n<!-- fanotes-famd:v1 chars=2 -->\n{}\n",
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "Hallo"
    );
    assert!(host
        .dispatch("fanotes:read-file", &[json!("Mathe/Seite.pdf")])
        .is_err());
}
