use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_famd::parse_famd;
use fanotes_host::Host;
use serde_json::json;

fn host() -> (Host, std::path::PathBuf) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-notes-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
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
    host.settings.insert("uiLanguage".to_owned(), json!("de"));
    let untitled = host.dispatch("fanotes:create-note", &[json!("")]).unwrap();
    assert_eq!(untitled["relativePath"], "Unbenannte Notiz.md");
    host.settings.insert("uiLanguage".to_owned(), json!("en"));
    let english = host.dispatch("fanotes:create-note", &[json!("")]).unwrap();
    assert_eq!(english["relativePath"], "Untitled note.md");
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

#[test]
fn a_symlinked_note_cannot_leave_the_vault() {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    let outside = dir.join("outside");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), b"geheim\n").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), vault.join("Notiz.md")).unwrap();
    std::os::unix::fs::symlink(&outside, vault.join("weg")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Notiz.md")])
            .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!("Notiz.md"), json!("neu\n")])
            .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    assert_eq!(
        std::fs::read(outside.join("secret.md")).unwrap(),
        b"geheim\n"
    );
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("weg/Seite.md"), json!("raus\n")]
        )
        .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    assert!(!outside.join("Seite.md").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_saved_note_is_private_and_leaves_no_temporary_file() {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-atomic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault.clone()).unwrap();
    host.dispatch("fanotes:write-file", &[json!("Seite.md"), json!("Hallo")])
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.join("Seite.md")).unwrap(),
        "Hallo\n"
    );
    assert!(vault.join("Seite.famd").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["Seite.md", "Seite.famd"] {
            let mode = std::fs::metadata(vault.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{name}");
        }
    }
    let leftovers: Vec<_> = std::fs::read_dir(&vault)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn page_stats_keep_the_fields_the_editor_stores() {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-stats-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    let stats = json!({
        "version": 1,
        "createdAt": "2026-01-02T03:04:05.000Z",
        "modifiedAt": "2026-01-02T03:04:05.000Z",
        "firstOpenedAt": "2026-01-02T03:04:05.000Z",
        "lastOpenedAt": "2026-01-02T03:05:05.000Z",
        "lastClosedAt": null,
        "lastSavedAt": "2026-01-02T03:06:05.000Z",
        "openCount": 2,
        "saveCount": 3,
        "dwellMs": 1500,
        "focusMs": 1200,
        "longestSessionMs": 800,
        "lastSessionMs": 400,
        "activeDays": ["2026-01-02"],
        "typing": { "wordsAdded": 4, "wordsRemoved": 1 }
    });
    let mut payload = fanotes_famd::empty_famd_payload("2026-01-02T03:04:05.000Z");
    payload.page_stats = Some(stats.clone());
    let content = fanotes_famd::serialize_famd("Hallo", &payload);
    host.dispatch("fanotes:write-file", &[json!("Seite.md"), json!(content)])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-page-stats", &[json!("Seite.md")])
            .unwrap(),
        stats
    );
    host.dispatch(
        "fanotes:write-file",
        &[json!("Seite.md"), json!("Hallo nochmal\n")],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-page-stats", &[json!("Seite.md")])
            .unwrap(),
        stats
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_pdf_note_keeps_history_of_its_famd_file() {
    let dir =
        std::env::temp_dir().join(format!("fanotes-notes-pdf-history-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Buch.famd"), json!("Erste Fassung\n")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Buch.famd"), json!("Zweite Fassung\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Buch.famd")])
        .unwrap();
    let snapshots = history.as_array().unwrap();
    assert_eq!(snapshots.len(), 1);
    let id = snapshots[0]["id"].as_str().unwrap();
    let loaded = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Buch.famd"), json!(id)],
        )
        .unwrap();
    assert!(loaded["content"]
        .as_str()
        .unwrap()
        .contains("Erste Fassung"));
    assert!(!loaded["content"]
        .as_str()
        .unwrap()
        .contains("Zweite Fassung"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_decomposed_umlaut_is_the_same_note_name() {
    let (mut host, vault) = host();
    let nfd_note = "Mu\u{0308}he.md";
    let nfd_ink = "Mu\u{0308}he.famd";
    std::fs::write(vault.join(nfd_note), b"bleibt\n").unwrap();
    std::fs::write(vault.join(nfd_ink), b"ink").unwrap();
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!("Mühe")])
        .unwrap();
    assert_eq!(created["relativePath"], "Mühe 2.md");
    assert_eq!(std::fs::read(vault.join(nfd_note)).unwrap(), b"bleibt\n");
    let names: Vec<_> = host
        .dispatch("fanotes:get-tree", &[])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.iter().any(|name| name == nfd_note));
    assert!(names.iter().all(|name| name != nfd_ink));
}

#[test]
fn a_missing_folder_is_not_created_for_a_new_note() {
    let (mut host, vault) = host();
    let created = host
        .dispatch("fanotes:create-note", &[json!("Fehlt"), json!("Seite")])
        .unwrap_err();
    assert!(created.contains("Zielordner"));
    let written = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Fehlt/Seite.md"), json!("Hallo\n")],
        )
        .unwrap_err();
    assert!(written.contains("Zielordner"));
    assert!(!vault.join("Fehlt").exists());
}

#[test]
fn a_long_german_title_uses_character_length() {
    let (mut host, vault) = host();
    let title = "Ä".repeat(91);
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!(title)])
        .unwrap();
    assert_eq!(created["relativePath"], format!("{title}.md"));
    assert!(vault.join(format!("{title}.md")).is_file());
    let too_long = "Ä".repeat(181);
    let error = host
        .dispatch("fanotes:create-note", &[json!(""), json!(too_long)])
        .unwrap_err();
    assert!(error.contains("nicht erlaubt"));
    assert!(!vault.join(format!("{too_long}.md")).exists());
}
