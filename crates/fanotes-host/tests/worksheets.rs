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
