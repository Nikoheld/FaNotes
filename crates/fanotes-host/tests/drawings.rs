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
