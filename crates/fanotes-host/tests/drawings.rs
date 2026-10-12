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
fn a_drawing_image_follows_the_desktop_png_checks() {
    let (dir, mut host) = host();
    let assets = dir.join("vault/.fanotes/assets");
    let missing = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "ohne-bild",
                "title": "Skizze",
                "drawingJson": drawing("Skizze"),
                "imageData": null,
            })],
        )
        .unwrap_err();
    assert!(missing.contains("kein PNG"), "{missing}");
    assert!(!assets.join("ohne-bild.json").exists());

    let empty = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "leer-bild",
                "title": "Skizze",
                "drawingJson": drawing("Skizze"),
                "imageData": "data:image/png;base64,",
            })],
        )
        .unwrap_err();
    assert!(empty.contains("leer oder zu groß"), "{empty}");

    let saved = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "mit-bild",
                "title": "Skizze",
                "drawingJson": drawing("Skizze"),
                "imageData": "data:image/png;base64,iVBORw0KGgo=",
            })],
        )
        .unwrap();
    assert_eq!(saved["id"], "mit-bild");
    assert_eq!(
        std::fs::read(assets.join("mit-bild.png")).unwrap(),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    );
}

#[test]
fn a_drawing_title_uses_the_desktop_entry_name_rules() {
    let (_dir, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "leer-1",
                "title": "",
                "drawingJson": drawing("Zeichnung"),
            })],
        )
        .unwrap();
    assert_eq!(saved["title"], "Zeichnung");

    let mismatch = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "leer-2",
                "title": " \u{FEFF}",
                "drawingJson": drawing("Skizze"),
            })],
        )
        .unwrap_err();
    assert!(mismatch.contains("stimmt nicht"), "{mismatch}");

    let device = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "con-1",
                "title": "CON",
                "drawingJson": drawing("CON"),
            })],
        )
        .unwrap_err();
    assert!(device.contains("nicht erlaubt"), "{device}");

    let marked = host
        .dispatch(
            "fanotes:save-drawing",
            &[json!({
                "id": "mark-1",
                "title": "a<b",
                "drawingJson": drawing("a<b"),
            })],
        )
        .unwrap_err();
    assert!(marked.contains("nicht erlaubt"), "{marked}");
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
fn the_drawing_library_opens_only_a_lowercase_json_suffix() {
    let (dir, mut host) = host();
    let assets = dir.join("vault/.fanotes/assets");
    fs::create_dir_all(&assets).unwrap();
    let document = |title: &str, transcript: &str| {
        format!(
            r#"{{"schemaVersion":1,"title":"{title}","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z","searchTranscript":"0.20\t{transcript}"}}"#
        )
    };
    fs::write(assets.join("keep.json"), document("Behalten", "Echtwort")).unwrap();
    fs::write(
        assets.join("keep.json.json"),
        document("Doppelt", "Doppelwort"),
    )
    .unwrap();
    fs::write(assets.join("Upper.JSON"), document("Gross", "Grosswort")).unwrap();
    fs::create_dir(assets.join("ordner.json")).unwrap();

    let listed = host.dispatch("fanotes:list-drawings", &[]).unwrap();
    let titles: Vec<_> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["title"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(titles, vec!["Behalten".to_owned()]);

    let upper = host
        .dispatch("fanotes:search", &[json!("Grosswort")])
        .unwrap();
    assert!(upper.as_array().unwrap().is_empty());
    let hidden = host
        .dispatch("fanotes:search", &[json!("Doppelwort")])
        .unwrap();
    assert!(hidden.as_array().unwrap().is_empty());
}

#[test]
fn a_drawing_with_a_bad_byte_still_opens() {
    let (dir, mut host) = host();
    let assets = dir.join("vault/.fanotes/assets");
    fs::create_dir_all(&assets).unwrap();
    let mut bytes = br#"{"schemaVersion":1,"title":"SkiXze","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z","searchTranscript":"0.20\tWort"}"#.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(assets.join("skizze.json"), &bytes).unwrap();
    fs::write(assets.join("muell.json"), b"{\xff").unwrap();

    let listed = host.dispatch("fanotes:list-drawings", &[]).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], "skizze");
    assert_eq!(listed[0]["title"], "Ski\u{FFFD}ze");

    let loaded = host
        .dispatch("fanotes:read-drawing", &[json!("skizze")])
        .unwrap();
    assert_eq!(loaded["title"], "Ski\u{FFFD}ze");
    assert!(loaded["drawingJson"]
        .as_str()
        .unwrap()
        .contains("Ski\u{FFFD}ze"));
    let damaged =
        "Die gespeicherte Zeichnung ist beschädigt oder kann nicht sicher gelesen werden.";
    assert_eq!(
        host.dispatch("fanotes:read-drawing", &[json!("muell")])
            .unwrap_err(),
        damaged
    );
    fs::write(
        assets.join("falsch.json"),
        br#"{"schemaVersion":2,"title":"Nein","strokes":[]}"#,
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-drawing", &[json!("falsch")])
            .unwrap_err(),
        damaged
    );

    let hits = host.dispatch("fanotes:search", &[json!("Wort")]).unwrap();
    assert_eq!(hits[0]["drawingId"], "skizze");
    assert_eq!(hits[0]["title"], "Ski\u{FFFD}ze");
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

#[test]
fn handwriting_with_a_bad_byte_still_opens() {
    let (dir, mut host) = host();
    fs::write(dir.join("vault").join("Notiz.md"), "Hallo\n").unwrap();
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "skizze-1",
            "title": "Skizze",
            "drawingJson": drawing("Skizze"),
            "noteRelativePath": "Notiz.md",
        })],
    )
    .unwrap();
    let famd_path = dir.join("vault").join("Notiz.famd");
    let mut bytes = fs::read(&famd_path).unwrap();
    let needle = b"Skizze";
    let start = bytes
        .windows(needle.len())
        .position(|window| window == needle)
        .unwrap();
    bytes[start + 2] = 0xff;
    fs::write(&famd_path, &bytes).unwrap();

    let loaded = host
        .dispatch("fanotes:read-famd-ink", &[json!("Notiz.md")])
        .unwrap();
    assert_eq!(loaded["title"], "Sk\u{FFFD}zze");
    assert!(loaded["drawingJson"]
        .as_str()
        .unwrap()
        .contains("Sk\u{FFFD}zze"));

    let brace = bytes.iter().position(|byte| *byte == b'{').unwrap();
    bytes[brace] = 0xff;
    fs::write(&famd_path, &bytes).unwrap();
    assert!(host
        .dispatch("fanotes:read-famd-ink", &[json!("Notiz.md")])
        .unwrap()
        .is_null());
}

#[test]
fn a_drawing_schema_version_of_one_point_zero_still_opens() {
    let (dir, mut host) = host();
    let assets = dir.join("vault/.fanotes/assets");
    fs::create_dir_all(&assets).unwrap();
    fs::write(
        assets.join("skizze.json"),
        r#"{"schemaVersion":1.0,"title":"Skizze","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z"}"#,
    )
    .unwrap();
    let listed = host.dispatch("fanotes:list-drawings", &[]).unwrap();
    assert_eq!(listed[0]["title"], "Skizze");
    let loaded = host
        .dispatch("fanotes:read-drawing", &[json!("skizze")])
        .unwrap();
    assert_eq!(loaded["title"], "Skizze");

    fs::write(
        assets.join("halb.json"),
        r#"{"schemaVersion":1.5,"title":"Halb","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z"}"#,
    )
    .unwrap();
    let listed = host.dispatch("fanotes:list-drawings", &[]).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(
        host.dispatch("fanotes:read-drawing", &[json!("halb")])
            .unwrap_err(),
        "Die gespeicherte Zeichnung ist beschädigt oder kann nicht sicher gelesen werden."
    );
}

#[test]
fn handwriting_uses_the_settings_paper_when_the_note_has_none() {
    let (dir, mut host) = host();
    let vault = dir.join("vault");
    fs::write(vault.join("Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "paperStyle": "grid" })],
    )
    .unwrap();
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "skizze",
            "title": "Skizze",
            "drawingJson": drawing("Skizze"),
            "noteRelativePath": "Seite.md"
        })],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Seite.md")])
            .unwrap(),
        "grid"
    );

    host.dispatch(
        "fanotes:set-note-paper-style",
        &[json!("Seite.md"), json!("lines")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "skizze",
            "title": "Skizze",
            "drawingJson": drawing("Skizze"),
            "noteRelativePath": "Seite.md"
        })],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Seite.md")])
            .unwrap(),
        "lines"
    );

    fs::write(vault.join("Andere.md"), b"x\n").unwrap();
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "skizze-2",
            "title": "Skizze",
            "drawingJson": r#"{"schemaVersion":1,"title":"Skizze","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z","paperStyle":"squares"}"#,
            "noteRelativePath": "Andere.md"
        })],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Andere.md")])
            .unwrap(),
        "squares"
    );
}
