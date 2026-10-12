use fanotes_host::Host;
use serde_json::json;
use std::fs;

fn host() -> (std::path::PathBuf, Host) {
    let dir = std::env::temp_dir().join(format!(
        "fanotes-worksheets-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join(".fanotes/worksheets")).unwrap();
    fs::write(vault.join(".fanotes/worksheets/blatt-1.pdf"), b"%PDF-1.4\n").unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    (dir, host)
}

#[test]
fn a_null_highlight_list_and_a_whole_page_number_still_open() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    fs::write(
        worksheets.join("blatt-1.json"),
        r#"{"schemaVersion":1.0,"id":"blatt-1","title":"Übung","kind":"pdf","mimeType":"application/pdf","sourceRelativePath":".fanotes/worksheets/blatt-1.pdf","dataRelativePath":".fanotes/worksheets/blatt-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","textBoxes":[{"id":"box-1","page":1.0,"x":0.1,"y":0.2,"width":0.3,"text":"Hallo","fontSize":16}],"highlights":null}"#,
    )
    .unwrap();
    let loaded = host
        .dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
        .unwrap();
    assert_eq!(loaded["textBoxes"][0]["page"], 1);
    assert_eq!(loaded["textBoxes"][0]["text"], "Hallo");
    assert!(loaded["highlights"].as_array().unwrap().is_empty());

    let saved = host
        .dispatch(
            "fanotes:save-worksheet",
            &[json!({
                "schemaVersion": 1,
                "id": "blatt-1",
                "title": "Übung",
                "kind": "pdf",
                "mimeType": "application/pdf",
                "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
                "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
                "createdAt": "2026-01-02T03:04:05.000Z",
                "updatedAt": "2026-01-02T03:04:05.000Z",
                "textBoxes": [],
                "highlights": {}
            })],
        )
        .unwrap();
    assert!(saved["highlights"].as_array().unwrap().is_empty());

    fs::write(
        worksheets.join("blatt-1.json"),
        r#"{"schemaVersion":1,"id":"blatt-1","title":"Übung","kind":"pdf","mimeType":"application/pdf","sourceRelativePath":".fanotes/worksheets/blatt-1.pdf","dataRelativePath":".fanotes/worksheets/blatt-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","textBoxes":[{"id":"box-1","page":1.5,"x":0.1,"y":0.2,"width":0.3,"text":"Hallo","fontSize":16}],"highlights":[]}"#,
    )
    .unwrap();
    let fraction = host
        .dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
        .unwrap_err();
    assert!(fraction.contains("Textfeldseite"), "{fraction}");
}

#[test]
fn a_pdf_worksheet_saves_reads_and_deletes() {
    let (dir, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-worksheet",
            &[json!({
                "schemaVersion": 1,
                "id": "blatt-1",
                "title": "Übung",
                "kind": "pdf",
                "mimeType": "application/pdf",
                "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
                "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
                "createdAt": "2026-01-02T03:04:05.000Z",
                "updatedAt": "2026-01-02T03:04:05.000Z",
                "textBoxes": [{
                    "id": "box-1",
                    "page": 1,
                    "x": 0.1,
                    "y": 0.2,
                    "width": 0.3,
                    "text": "Hallo",
                    "fontSize": 16
                }],
                "highlights": []
            })],
        )
        .unwrap();
    assert_eq!(saved["title"], "Übung");
    assert_eq!(saved["textBoxes"][0]["text"], "Hallo");
    assert!(dir.join("vault/.fanotes/worksheets/blatt-1.json").is_file());

    let loaded = host
        .dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
        .unwrap();
    assert_eq!(loaded["title"], "Übung");

    assert_eq!(
        host.dispatch("fanotes:delete-worksheet", &[json!("blatt-1")])
            .unwrap()["id"],
        "blatt-1"
    );
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Das Arbeitsblatt wurde nicht gefunden."
    );
    assert!(!dir.join("vault/.fanotes/worksheets/blatt-1.pdf").exists());
}

#[test]
fn a_damaged_worksheet_stays_until_it_can_be_read() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    fs::write(worksheets.join("blatt-1.json"), "{").unwrap();
    let error = host
        .dispatch("fanotes:delete-worksheet", &[json!("blatt-1")])
        .unwrap_err();
    assert!(error.contains("beschädigt"));
    assert!(worksheets.join("blatt-1.json").is_file());
    assert!(worksheets.join("blatt-1.pdf").is_file());

    fs::write(
        worksheets.join("blatt-1.json"),
        r#"{"schemaVersion":1,"id":"blatt-1","title":"\nÜbung","kind":"pdf","mimeType":"application/pdf","sourceRelativePath":".fanotes/worksheets/blatt-1.pdf","dataRelativePath":".fanotes/worksheets/blatt-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","textBoxes":[]}"#,
    )
    .unwrap();
    let invalid = host
        .dispatch("fanotes:delete-worksheet", &[json!("blatt-1")])
        .unwrap_err();
    assert!(invalid.contains("Arbeitsblatttitel"));
    assert!(worksheets.join("blatt-1.pdf").is_file());

    assert_eq!(
        host.dispatch("fanotes:delete-worksheet", &[json!("missing-1")])
            .unwrap()["id"],
        "missing-1"
    );
}

#[test]
fn a_zoned_worksheet_time_is_stored_as_utc() {
    let (dir, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-worksheet",
            &[json!({
                "schemaVersion": 1,
                "id": "blatt-1",
                "title": "Übung",
                "kind": "pdf",
                "mimeType": "application/pdf",
                "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
                "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
                "createdAt": "2020-06-01T12:00:00+02:00",
                "updatedAt": "2020-06-01T12:00:00+02:00",
                "textBoxes": [],
                "highlights": []
            })],
        )
        .unwrap();
    assert_eq!(saved["createdAt"], "2020-06-01T10:00:00.000Z");
    let _ = dir;
}

#[test]
fn a_worksheet_title_is_checked_before_trimming() {
    let (_dir, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-worksheet",
            &[json!({
                "schemaVersion": 1,
                "id": "blatt-1",
                "title": "  Übung  ",
                "kind": "pdf",
                "mimeType": "application/pdf",
                "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
                "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
                "createdAt": "2026-01-02T03:04:05.000Z",
                "updatedAt": "2026-01-02T03:04:05.000Z",
                "textBoxes": [],
                "highlights": []
            })],
        )
        .unwrap();
    assert_eq!(saved["title"], "Übung");
    let broken = host
        .dispatch(
            "fanotes:save-worksheet",
            &[json!({
                "schemaVersion": 1,
                "id": "blatt-1",
                "title": "\nÜbung",
                "kind": "pdf",
                "mimeType": "application/pdf",
                "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
                "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
                "createdAt": "2026-01-02T03:04:05.000Z",
                "updatedAt": "2026-01-02T03:04:05.000Z",
                "textBoxes": [],
                "highlights": []
            })],
        )
        .unwrap_err();
    assert!(broken.contains("Arbeitsblatttitel"), "{broken}");
    let too_long = format!("{} ", "A".repeat(180));
    let broken = host
        .dispatch(
            "fanotes:save-worksheet",
            &[json!({
                "schemaVersion": 1,
                "id": "blatt-1",
                "title": too_long,
                "kind": "pdf",
                "mimeType": "application/pdf",
                "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
                "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
                "createdAt": "2026-01-02T03:04:05.000Z",
                "updatedAt": "2026-01-02T03:04:05.000Z",
                "textBoxes": [],
                "highlights": []
            })],
        )
        .unwrap_err();
    assert!(broken.contains("Arbeitsblatttitel"), "{broken}");
}

#[test]
fn a_worksheet_with_a_bad_byte_still_opens() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    let mut bytes = br#"{"schemaVersion":1,"id":"blatt-1","title":"UXbung","kind":"pdf","mimeType":"application/pdf","sourceRelativePath":".fanotes/worksheets/blatt-1.pdf","dataRelativePath":".fanotes/worksheets/blatt-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","textBoxes":[],"highlights":[]}"#.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(worksheets.join("blatt-1.json"), &bytes).unwrap();

    let loaded = host
        .dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
        .unwrap();
    assert_eq!(loaded["title"], "U\u{FFFD}bung");
    assert_eq!(
        host.dispatch("fanotes:delete-worksheet", &[json!("blatt-1")])
            .unwrap()["id"],
        "blatt-1"
    );
    assert!(!worksheets.join("blatt-1.json").exists());
    assert!(!worksheets.join("blatt-1.pdf").exists());

    fs::write(
        worksheets.join("seite-1.html"),
        b"fanotes-onenote-safe-v1\xff",
    )
    .unwrap();
    fs::write(
        worksheets.join("seite-1.json"),
        r#"{"schemaVersion":1,"id":"seite-1","title":"Seite","kind":"html","mimeType":"text/html","sourceRelativePath":".fanotes/worksheets/seite-1.html","dataRelativePath":".fanotes/worksheets/seite-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","pageWidth":800,"pageHeight":900,"textBoxes":[],"highlights":[]}"#,
    )
    .unwrap();
    let page = host
        .dispatch("fanotes:read-worksheet", &[json!("seite-1")])
        .unwrap();
    assert_eq!(page["title"], "Seite");
    assert_eq!(page["kind"], "html");

    fs::write(worksheets.join("muell-1.json"), b"{\xff").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("muell-1")])
            .unwrap_err(),
        "Die Arbeitsblattdaten sind beschädigt."
    );
}

#[test]
fn a_string_page_size_opens_like_the_desktop() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    fs::write(worksheets.join("seite-1.html"), b"fanotes-onenote-safe-v1").unwrap();
    fs::write(
        worksheets.join("seite-1.json"),
        r#"{"schemaVersion":1,"id":"seite-1","title":"Seite","kind":"html","mimeType":"text/html","sourceRelativePath":".fanotes/worksheets/seite-1.html","dataRelativePath":".fanotes/worksheets/seite-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","pageWidth":"800.5","pageHeight":" 1200 ","textBoxes":[],"highlights":[]}"#,
    )
    .unwrap();
    let page = host
        .dispatch("fanotes:read-worksheet", &[json!("seite-1")])
        .unwrap();
    assert_eq!(page["pageWidth"], 801);
    assert_eq!(page["pageHeight"], 1200);

    fs::write(
        worksheets.join("seite-1.json"),
        r#"{"schemaVersion":1,"id":"seite-1","title":"Seite","kind":"html","mimeType":"text/html","sourceRelativePath":".fanotes/worksheets/seite-1.html","dataRelativePath":".fanotes/worksheets/seite-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","pageWidth":"800px","pageHeight":900,"textBoxes":[],"highlights":[]}"#,
    )
    .unwrap();
    let broken = host
        .dispatch("fanotes:read-worksheet", &[json!("seite-1")])
        .unwrap_err();
    assert!(broken.contains("Größe"), "{broken}");

    fs::write(
        worksheets.join("seite-1.json"),
        r#"{"schemaVersion":1,"id":"seite-1","title":"Seite","kind":"html","mimeType":"text/html","sourceRelativePath":".fanotes/worksheets/seite-1.html","dataRelativePath":".fanotes/worksheets/seite-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","pageWidth":[800.5],"pageHeight":[1200],"textBoxes":[],"highlights":[]}"#,
    )
    .unwrap();
    let listed = host
        .dispatch("fanotes:read-worksheet", &[json!("seite-1")])
        .unwrap();
    assert_eq!(listed["pageWidth"], 801);
    assert_eq!(listed["pageHeight"], 1200);
    fs::write(
        worksheets.join("seite-1.json"),
        r#"{"schemaVersion":1,"id":"seite-1","title":"Seite","kind":"html","mimeType":"text/html","sourceRelativePath":".fanotes/worksheets/seite-1.html","dataRelativePath":".fanotes/worksheets/seite-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","pageWidth":[1,2],"pageHeight":900,"textBoxes":[],"highlights":[]}"#,
    )
    .unwrap();
    let pair = host
        .dispatch("fanotes:read-worksheet", &[json!("seite-1")])
        .unwrap_err();
    assert!(pair.contains("Größe"), "{pair}");
}

#[test]
fn an_html_safety_marker_must_sit_in_the_desktop_prefix() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    let json = r#"{"schemaVersion":1,"id":"seite-1","title":"Seite","kind":"html","mimeType":"text/html","sourceRelativePath":".fanotes/worksheets/seite-1.html","dataRelativePath":".fanotes/worksheets/seite-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","pageWidth":800,"pageHeight":900,"textBoxes":[],"highlights":[]}"#;
    fs::write(worksheets.join("seite-1.json"), json).unwrap();

    let mut early = b"fanotes-onenote-safe-v1".to_vec();
    early.extend(std::iter::repeat(b'x').take(9000));
    fs::write(worksheets.join("seite-1.html"), &early).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("seite-1")])
            .unwrap()["title"],
        "Seite"
    );

    let mut late = vec![b'x'; 8192];
    late.extend(b"fanotes-onenote-safe-v1");
    fs::write(worksheets.join("seite-1.html"), &late).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("seite-1")])
            .unwrap_err(),
        "Die importierte OneNote-Seite hat ihre Sicherheitsmarkierung verloren."
    );
}

#[test]
fn a_bad_mark_reports_a_different_position_error_than_a_text_box() {
    let (_dir, mut host) = host();
    let mut document = json!({
        "schemaVersion": 1,
        "id": "blatt-1",
        "title": "Übung",
        "kind": "pdf",
        "mimeType": "application/pdf",
        "sourceRelativePath": ".fanotes/worksheets/blatt-1.pdf",
        "dataRelativePath": ".fanotes/worksheets/blatt-1.json",
        "createdAt": "2026-01-02T03:04:05.000Z",
        "updatedAt": "2026-01-02T03:04:05.000Z",
        "textBoxes": [],
        "highlights": [{
            "id": "mark-1",
            "page": 1,
            "x": "nein",
            "y": 0.2,
            "width": 0.2,
            "height": 0.2
        }]
    });
    assert_eq!(
        host.dispatch("fanotes:save-worksheet", &[document.clone()])
            .unwrap_err(),
        "Eine Markierungsposition ist ungültig."
    );
    document["highlights"] = json!([]);
    document["textBoxes"] = json!([{
        "id": "box-1",
        "page": 1,
        "x": "nein",
        "y": 0.2,
        "width": 0.3,
        "text": "Hallo",
        "fontSize": 16
    }]);
    assert_eq!(
        host.dispatch("fanotes:save-worksheet", &[document])
            .unwrap_err(),
        "Eine Textfeldposition ist ungültig."
    );
}

#[test]
fn a_worksheet_source_uses_the_desktop_file_checks() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    let json = r#"{"schemaVersion":1,"id":"blatt-1","title":"Übung","kind":"pdf","mimeType":"application/pdf","sourceRelativePath":".fanotes/worksheets/blatt-1.pdf","dataRelativePath":".fanotes/worksheets/blatt-1.json","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","textBoxes":[],"highlights":[]}"#;
    fs::write(worksheets.join("blatt-1.json"), json).unwrap();
    fs::remove_file(worksheets.join("blatt-1.pdf")).unwrap();
    fs::create_dir(worksheets.join("blatt-1.pdf")).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Die Datei ist keine reguläre Datei."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:save-worksheet",
            &[serde_json::from_str::<serde_json::Value>(json).unwrap()]
        )
        .unwrap_err(),
        "Die Datei ist keine reguläre Datei."
    );

    fs::remove_dir(worksheets.join("blatt-1.pdf")).unwrap();
    let file = fs::File::create(worksheets.join("blatt-1.pdf")).unwrap();
    file.set_len(96 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Die Datei ist zu groß."
    );
}

#[test]
fn a_worksheet_json_uses_the_desktop_file_messages() {
    let (dir, mut host) = host();
    let worksheets = dir.join("vault/.fanotes/worksheets");
    fs::create_dir(worksheets.join("blatt-1.json")).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Die Datei ist keine reguläre Datei."
    );
    fs::remove_dir(worksheets.join("blatt-1.json")).unwrap();
    let file = fs::File::create(worksheets.join("blatt-1.json")).unwrap();
    file.set_len(4 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Die Datei ist zu groß."
    );
    fs::remove_file(worksheets.join("blatt-1.json")).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Das Arbeitsblatt wurde nicht gefunden."
    );
}

#[test]
fn a_worksheet_folder_uses_the_desktop_directory_checks() {
    let (dir, mut host) = host();
    let internal = dir.join("vault/.fanotes");
    fs::remove_dir_all(internal.join("worksheets")).unwrap();
    fs::write(internal.join("worksheets"), b"not a folder").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Der interne Arbeitsblatt-Ordner ist unsicher."
    );

    fs::remove_dir_all(&internal).unwrap();
    fs::write(&internal, b"not a folder").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!("blatt-1")])
            .unwrap_err(),
        "Der interne FaNotes-Ordner ist unsicher."
    );
}
