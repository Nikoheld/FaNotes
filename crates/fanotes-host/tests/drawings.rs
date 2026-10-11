use fanotes_famd::parse_famd;
use fanotes_host::Host;
use serde_json::json;
use std::fs;

fn host() -> (std::path::PathBuf, Host) {
    let dir = std::env::temp_dir().join(format!(
        "fanotes-drawings-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("vault")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(dir.join("vault")).unwrap();
    (dir, host)
}

fn drawing(title: &str) -> String {
    format!(
        r#"{{"schemaVersion":1,"title":"{title}","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z"}}"#
    )
}

#[test]
fn drawings_round_trip_and_land_in_the_note() {
    let (dir, mut host) = host();
    fs::write(dir.join("vault").join("Notiz.md"), "Hallo\n").unwrap();
    let saved = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "skizze-1",
                "title": "Skizze",
                "drawingJson": drawing("Skizze"),
                "noteRelativePath": "Notiz.md",
            })],
        )
        .unwrap();
    assert_eq!(saved["id"], "skizze-1");
    assert_eq!(saved["title"], "Skizze");
    assert_eq!(saved["dataRelativePath"], ".fanotes/assets/skizze-1.json");
    assert!(dir.join("vault/.fanotes/assets/skizze-1.json").is_file());

    let listed = host.dispatch("fanotes:list-drawings", &[]).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["title"], "Skizze");

    let loaded = host
        .dispatch("fanotes:read-drawing", &[json!("skizze-1")])
        .unwrap();
    assert!(loaded["drawingJson"]
        .as_str()
        .unwrap()
        .contains("\"title\":\"Skizze\""));

    let famd = fs::read_to_string(dir.join("vault").join("Notiz.famd")).unwrap();
    let parsed = parse_famd(&famd);
    assert_eq!(parsed.markdown.trim(), "Hallo");
    assert_eq!(parsed.payload.unwrap().ink.unwrap()["title"], "Skizze");
    assert_eq!(
        host.dispatch("fanotes:read-drawing", &[json!("../secret")])
            .unwrap_err(),
        "Ungültige Zeichnungs-ID."
    );
}

#[test]
fn handwriting_is_not_saved_through_a_symlink_folder() {
    let (dir, mut host) = host();
    let outside = dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("Notiz.md"), b"geheim\n").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("vault/weg")).unwrap();
    let error = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "skizze-2",
                "title": "Skizze",
                "drawingJson": drawing("Skizze"),
                "noteRelativePath": "weg/Notiz.md",
            })],
        )
        .unwrap_err();
    assert!(error.contains("Symbolische Links"));
    assert!(!outside.join("Notiz.famd").exists());
    assert_eq!(fs::read(outside.join("Notiz.md")).unwrap(), b"geheim\n");
}

#[test]
fn pdf_and_markdown_notes_reopen_their_handwriting() {
    let (dir, mut host) = host();
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::write(vault.join("Mathe/Buch.pdf"), b"%PDF-1.4\n").unwrap();
    let payload = fanotes_famd::empty_famd_payload("2026-01-02T03:04:05.000Z");
    fs::write(
        vault.join("Mathe/Buch.famd"),
        fanotes_famd::serialize_famd("Randnotiz zum Kapitel", &payload),
    )
    .unwrap();
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "buch-1",
            "title": "Skizze",
            "drawingJson": drawing("Skizze"),
            "noteRelativePath": "Mathe/Buch.pdf",
        })],
    )
    .unwrap();
    let saved = parse_famd(&fs::read_to_string(vault.join("Mathe/Buch.famd")).unwrap());
    assert_eq!(saved.markdown.trim(), "Randnotiz zum Kapitel");
    assert_eq!(saved.payload.unwrap().ink.unwrap()["title"], "Skizze");
    let book = host
        .dispatch("fanotes:read-famd-ink", &[json!("Mathe/Buch.pdf")])
        .unwrap();
    assert_eq!(book["id"], "famd-ink");
    assert_eq!(book["title"], "Skizze");
    assert_eq!(book["dataRelativePath"], "Mathe/Buch.famd");
    assert_eq!(book["updatedAt"], "2026-01-02T03:04:05.000Z");
    assert!(book["drawingJson"]
        .as_str()
        .unwrap()
        .contains("\"title\":\"Skizze\""));
    assert!(host
        .dispatch("fanotes:read-famd-ink", &[json!("Mathe/Leer.pdf")])
        .unwrap()
        .is_null());

    let assets = vault.join(".fanotes/assets");
    fs::create_dir_all(&assets).unwrap();
    fs::write(
        assets.join("alt.json"),
        r#"{"schemaVersion":1,"title":"Alt","strokes":[]}"#,
    )
    .unwrap();
    filetime::set_file_mtime(
        assets.join("alt.json"),
        filetime::FileTime::from_unix_time(1_600_000_000, 0),
    )
    .unwrap();
    fs::write(
        assets.join("neu.json"),
        r#"{"schemaVersion":1,"title":"Neu","strokes":[],"updatedAt":"2021-01-01T00:00:00Z"}"#,
    )
    .unwrap();
    fs::write(
        assets.join("zone.json"),
        r#"{"schemaVersion":1,"title":"Zone","strokes":[],"updatedAt":"2020-06-01T12:00:00+02:00"}"#,
    )
    .unwrap();
    let listed = host.dispatch("fanotes:list-drawings", &[]).unwrap();
    let titles: Vec<_> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["title"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(titles, vec!["Skizze", "Neu", "Alt", "Zone"]);
    let by_title = |name: &str| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["title"] == name)
            .unwrap()
    };
    assert_eq!(by_title("Neu")["updatedAt"], "2021-01-01T00:00:00.000Z");
    assert_eq!(by_title("Zone")["updatedAt"], "2020-06-01T10:00:00.000Z");
    assert_eq!(by_title("Alt")["updatedAt"], "2020-09-13T12:26:40.000Z");

    fs::write(
        vault.join("Kapitel.markdown"),
        "Text\n\n<!-- fanotes-ink:skizze-1 -->\n",
    )
    .unwrap();
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "skizze-1",
            "title": "Skizze",
            "drawingJson": drawing("Skizze"),
            "noteRelativePath": "Kapitel.markdown",
        })],
    )
    .unwrap();
    let chapter = host
        .dispatch("fanotes:read-famd-ink", &[json!("Kapitel.markdown")])
        .unwrap();
    assert_eq!(chapter["dataRelativePath"], "Kapitel.famd");
    assert_eq!(chapter["id"], "skizze-1");
    assert_eq!(chapter["title"], "Skizze");
    assert_eq!(
        host.dispatch("fanotes:read-famd-ink", &[json!("Bild.png")])
            .unwrap_err(),
        "Es dürfen nur Markdown-Dateien, PDF-Notizen und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
}
