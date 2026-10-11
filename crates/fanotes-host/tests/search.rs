use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> Host {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-search-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Bio")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    host
}

#[test]
fn search_returns_title_excerpt_and_handwriting_anchor() {
    let mut host = host();
    host.dispatch(
        "fanotes:write-file",
        &[
            json!("Bio/Blatt.md"),
            json!("Die Photosynthese braucht Licht.\n"),
        ],
    )
    .unwrap();
    host.dispatch("fanotes:create-note", &[json!("Bio"), json!("Leer")])
        .unwrap();
    let created =
        std::fs::read_to_string(host.vault.as_ref().unwrap().join("Bio/Leer.md")).unwrap();
    assert_eq!(created, "# Leer\n\n");

    assert!(host
        .dispatch("fanotes:search", &[json!("  ")])
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let hits = host
        .dispatch("fanotes:search", &[json!("Photosynthese")])
        .unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["relativePath"], "Bio/Blatt.md");
    assert_eq!(hits[0]["title"], "Blatt");
    assert_eq!(hits[0]["kind"], "note");
    assert!(hits[0]["excerpt"]
        .as_str()
        .unwrap()
        .contains("Photosynthese"));
    assert!(hits[0]["matches"].as_u64().unwrap() >= 1);

    let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    payload.ink = Some(json!({
        "schemaVersion": 1,
        "title": "Blatt",
        "strokes": [],
        "searchTranscript": "0.42\tChlorophyll"
    }));
    std::fs::write(
        host.vault.as_ref().unwrap().join("Bio/Blatt.famd"),
        fanotes_famd::serialize_famd("Die Photosynthese braucht Licht.", &payload),
    )
    .unwrap();
    let ink_hits = host
        .dispatch("fanotes:search", &[json!("Chlorophyll")])
        .unwrap();
    assert_eq!(ink_hits[0]["relativePath"], "Bio/Blatt.md");
    assert_eq!(ink_hits[0]["inkAnchor"]["y"], 0.42);

    std::fs::write(
        host.vault.as_ref().unwrap().join("Bio/Blatt.famd"),
        fanotes_famd::serialize_famd("Die Photosynthese braucht Licht.", &{
            let mut umlaut = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
            umlaut.ink = Some(json!({
                "schemaVersion": 1,
                "title": "Blatt",
                "strokes": [],
                "searchTranscript": "0.42\täpfel"
            }));
            umlaut
        }),
    )
    .unwrap();
    let short = host.dispatch("fanotes:search", &[json!("ä")]).unwrap();
    assert!(short[0].get("inkAnchor").is_none());
    let longer = host.dispatch("fanotes:search", &[json!("äp")]).unwrap();
    assert_eq!(longer[0]["inkAnchor"]["y"], 0.42);

    let drawing = json!({
        "schemaVersion": 1,
        "id": "sketch1",
        "title": "Skizze",
        "strokes": [],
        "updatedAt": "2026-10-11T00:00:00.000Z",
        "searchTranscript": "0.20\tBaumkrone"
    });
    host.dispatch(
        "fanotes:save-drawing",
        &[json!({
            "id": "sketch1",
            "title": "Skizze",
            "drawingJson": drawing.to_string(),
            "noteRelativePath": "Bio/Blatt.md"
        })],
    )
    .unwrap();
    let drawings = host
        .dispatch("fanotes:search", &[json!("Baumkrone")])
        .unwrap();
    let drawing_hit = drawings
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["kind"] == "drawing")
        .unwrap();
    assert_eq!(drawing_hit["drawingId"], "sketch1");
    assert_eq!(drawing_hit["title"], "Skizze");
    assert_eq!(drawing_hit["notePath"], "Bio/Blatt.md");
    assert_eq!(drawing_hit["inkAnchor"]["y"], 0.2);
}

#[test]
fn drawing_search_uses_the_library_title_and_skips_invalid_files() {
    let mut host = host();
    let assets = host.vault.as_ref().unwrap().join(".fanotes/assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(
        assets.join("padded.json"),
        r#"{"schemaVersion":1,"title":"  Skizze  ","strokes":[],"updatedAt":"2026-10-11T00:00:00.000Z","searchTranscript":"0.20\tBaumkrone"}"#,
    )
    .unwrap();
    std::fs::write(
        assets.join("broken.json"),
        r#"{"schemaVersion":2,"title":"Geheim","searchTranscript":"Verborgen"}"#,
    )
    .unwrap();

    let hits = host
        .dispatch("fanotes:search", &[json!("Baumkrone")])
        .unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["title"], "Skizze");
    assert_eq!(hits[0]["drawingId"], "padded");
    assert_eq!(hits[0]["kind"], "drawing");

    let hidden = host
        .dispatch("fanotes:search", &[json!("Verborgen")])
        .unwrap();
    assert!(hidden.as_array().unwrap().is_empty());
}

#[test]
fn search_skips_companions_links_and_notes_buried_too_deep() {
    let mut host = host();
    let vault = host.vault.clone().unwrap();
    std::fs::write(vault.join("Bio/Formel.md"), "Apfel\n").unwrap();
    std::fs::write(vault.join("Bio/Formel.FAMD"), "Birne\n").unwrap();
    let hits = host.dispatch("fanotes:search", &[json!("Birne")]).unwrap();
    assert!(hits.as_array().unwrap().is_empty());
    assert_eq!(
        host.dispatch("fanotes:search", &[json!("Apfel")]).unwrap()[0]["relativePath"],
        "Bio/Formel.md"
    );

    let outside = vault.parent().unwrap().join("outside");
    std::fs::create_dir_all(outside.join("assets")).unwrap();
    std::fs::write(
        outside.join("assets/leak.json"),
        r#"{"schemaVersion":1,"title":"Draussen","strokes":[],"updatedAt":"2026-01-02T03:04:05.000Z","searchTranscript":"Geheimwort"}"#,
    )
    .unwrap();
    let internal = vault.join(".fanotes");
    if internal.symlink_metadata().is_ok() {
        std::fs::remove_dir_all(&internal).unwrap();
    }
    std::os::unix::fs::symlink(&outside, &internal).unwrap();
    let leaked = host
        .dispatch("fanotes:search", &[json!("Geheimwort")])
        .unwrap();
    assert!(leaked.as_array().unwrap().is_empty());
    assert_eq!(
        std::fs::read(outside.join("assets/leak.json"))
            .unwrap()
            .len()
            > 0,
        true
    );

    let mut deep = vault.join("tief");
    for _ in 0..81 {
        deep.push("ebene");
    }
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(deep.join("Unten.md"), "Vergraben\n").unwrap();
    let buried = host
        .dispatch("fanotes:search", &[json!("Vergraben")])
        .unwrap();
    assert!(buried.as_array().unwrap().is_empty());
}

#[test]
fn search_excerpt_follows_a_case_fold_that_grows() {
    let mut host = host();
    let body = format!("{}Zielwort am Ende.\n", "İ".repeat(120));
    host.dispatch(
        "fanotes:write-file",
        &[json!("Bio/Istanbul.md"), json!(body)],
    )
    .unwrap();
    let hits = host
        .dispatch("fanotes:search", &[json!("Zielwort")])
        .unwrap();
    assert_eq!(hits[0]["relativePath"], "Bio/Istanbul.md");
    let excerpt = hits[0]["excerpt"].as_str().unwrap();
    assert!(excerpt.contains("Zielwort"), "{excerpt}");
}

#[test]
fn a_search_excerpt_keeps_95_characters_before_the_match() {
    let mut host = host();
    let body = format!("{}Zielwort am Ende.\n", "Ä".repeat(100));
    host.dispatch("fanotes:write-file", &[json!("Bio/Umlaut.md"), json!(body)])
        .unwrap();
    let hits = host
        .dispatch("fanotes:search", &[json!("Zielwort")])
        .unwrap();
    let excerpt = hits[0]["excerpt"].as_str().unwrap();
    assert!(excerpt.starts_with('…'), "{excerpt}");
    assert!(excerpt.contains("Zielwort"), "{excerpt}");
    assert_eq!(
        excerpt
            .chars()
            .filter(|character| *character == 'Ä')
            .count(),
        95
    );
}

#[test]
fn equal_search_hits_follow_german_dictionary_order() {
    let mut host = host();
    for name in ["Seite 2", "Seite 10", "Apfel", "Äpfel", "Strasse", "Straße"] {
        host.dispatch(
            "fanotes:write-file",
            &[json!(format!("Bio/{name}.md")), json!("Licht\n")],
        )
        .unwrap();
    }
    let hits = host.dispatch("fanotes:search", &[json!("Licht")]).unwrap();
    let titles: Vec<_> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["title"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        titles,
        vec!["Apfel", "Äpfel", "Seite 10", "Seite 2", "Strasse", "Straße"]
    );
}

#[test]
fn a_search_query_stops_at_500_utf16_units() {
    let mut host = host();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Bio/Emoji.md"), json!("Nur das letzte Zeichen.\n")],
    )
    .unwrap();
    let query = format!("{}Zeichen", "😀".repeat(250));
    let hits = host.dispatch("fanotes:search", &[json!(query)]).unwrap();
    assert!(hits.as_array().unwrap().is_empty());
}
