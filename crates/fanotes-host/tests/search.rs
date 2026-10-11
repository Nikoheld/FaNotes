use fanotes_host::Host;
use serde_json::json;

fn host() -> Host {
    let dir = std::env::temp_dir().join(format!("fanotes-search-{}", std::process::id()));
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
}
