use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn touch(host: &Host, relative: &str) {
    std::fs::write(host.vault.as_ref().unwrap().join(relative), b"\n").unwrap();
}

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
    touch(&host, "Bio/Blatt.md");
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
fn search_uses_the_companion_transcript_and_both_drawing_ids() {
    let mut host = host();
    let vault = host.vault.clone().unwrap();
    let old = ink_note("Sichtbarer Text", Some("Veraltet"));
    std::fs::write(vault.join("Bio/Alt.md"), old).unwrap();
    std::fs::write(
        vault.join("Bio/Alt.famd"),
        ink_note("Sichtbarer Text", Some("Aktuell")),
    )
    .unwrap();
    std::fs::write(
        vault.join("Bio/Keep.md"),
        ink_note("Notiz", Some("Behalten")),
    )
    .unwrap();
    std::fs::write(vault.join("Bio/Keep.famd"), ink_note("Notiz", None)).unwrap();

    assert!(host
        .dispatch("fanotes:search", &[json!("Veraltet")])
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        host.dispatch("fanotes:search", &[json!("Aktuell")])
            .unwrap()[0]["relativePath"],
        "Bio/Alt.md"
    );
    assert_eq!(
        host.dispatch("fanotes:search", &[json!("Behalten")])
            .unwrap()[0]["relativePath"],
        "Bio/Keep.md"
    );

    std::fs::write(
        vault.join("Bio/Blatt.md"),
        "Siehe fanotes-ink:prose\n\n<!-- fanotes-ink:marker1 -->\n",
    )
    .unwrap();
    std::fs::write(
        vault.join("Bio/Blatt.famd"),
        ink_with_id("library1", "0.50\tTinte"),
    )
    .unwrap();
    let assets = vault.join(".fanotes/assets");
    std::fs::create_dir_all(&assets).unwrap();
    for (id, transcript) in [
        ("prose", "0.10\tProsewort"),
        ("marker1", "0.20\tMarkerwort"),
        ("library1", "0.30\tLibrarywort"),
    ] {
        std::fs::write(
            assets.join(format!("{id}.json")),
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "id": id,
                "title": id,
                "strokes": [],
                "updatedAt": "2026-10-11T00:00:00.000Z",
                "searchTranscript": transcript
            }))
            .unwrap(),
        )
        .unwrap();
    }

    let prose = drawing_hit(&mut host, "Prosewort");
    assert!(prose.get("notePath").is_none());
    assert_eq!(
        drawing_hit(&mut host, "Markerwort")["notePath"],
        "Bio/Blatt.md"
    );
    assert_eq!(
        drawing_hit(&mut host, "Librarywort")["notePath"],
        "Bio/Blatt.md"
    );
}

fn ink_note(body: &str, transcript: Option<&str>) -> String {
    let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    payload.ink = Some(match transcript {
        Some(transcript) => json!({
            "schemaVersion": 1,
            "title": "Blatt",
            "strokes": [],
            "searchTranscript": transcript
        }),
        None => json!({
            "schemaVersion": 1,
            "title": "Blatt",
            "strokes": []
        }),
    });
    fanotes_famd::serialize_famd(body, &payload)
}

fn ink_with_id(id: &str, transcript: &str) -> String {
    let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    payload.ink = Some(json!({
        "schemaVersion": 1,
        "id": id,
        "title": "Blatt",
        "strokes": [],
        "searchTranscript": transcript
    }));
    fanotes_famd::serialize_famd("Siehe fanotes-ink:prose", &payload)
}

fn drawing_hit(host: &mut Host, query: &str) -> serde_json::Value {
    host.dispatch("fanotes:search", &[json!(query)])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["kind"] == "drawing")
        .cloned()
        .unwrap()
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
    std::fs::write(
        assets.join("newline.json"),
        "{\"schemaVersion\":1,\"title\":\"\\nGeheim\",\"strokes\":[],\"updatedAt\":\"2026-10-11T00:00:00.000Z\",\"searchTranscript\":\"0.20\\tZeilenumbruch\"}",
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
    let newline = host
        .dispatch("fanotes:search", &[json!("Zeilenumbruch")])
        .unwrap();
    assert!(newline.as_array().unwrap().is_empty());
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
    assert_eq!(
        host.dispatch("fanotes:search", &[json!("Geheimwort")])
            .unwrap_err(),
        "Der interne FaNotes-Ordner ist unsicher."
    );
    assert!(outside.join("assets/leak.json").is_file());
    std::fs::remove_file(&internal).unwrap();
    std::fs::create_dir_all(&internal).unwrap();

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
fn search_keeps_a_case_pair_the_desktop_does_not_fold() {
    let mut host = host();
    touch(&host, "Bio/Zeichen.md");
    let upper = "\u{A7CE}";
    let lower = "\u{A7CF}";
    host.dispatch(
        "fanotes:write-file",
        &[
            json!("Bio/Zeichen.md"),
            json!(format!("Vor {upper} nach\n")),
        ],
    )
    .unwrap();
    let missed = host.dispatch("fanotes:search", &[json!(lower)]).unwrap();
    assert!(
        missed.as_array().unwrap().is_empty(),
        "{missed}"
    );
    let found = host.dispatch("fanotes:search", &[json!(upper)]).unwrap();
    assert_eq!(found[0]["relativePath"], "Bio/Zeichen.md");
    let nearby = host.dispatch("fanotes:search", &[json!("nach")]).unwrap();
    assert_eq!(nearby[0]["relativePath"], "Bio/Zeichen.md");
}

#[test]
fn search_finds_sharp_s_written_as_ss() {
    let mut host = host();
    touch(&host, "Bio/Weg.md");
    host.dispatch(
        "fanotes:write-file",
        &[json!("Bio/Weg.md"), json!("Die Straße ist lang.\n")],
    )
    .unwrap();
    let hits = host.dispatch("fanotes:search", &[json!("strasse")]).unwrap();
    assert_eq!(hits[0]["relativePath"], "Bio/Weg.md");
    let excerpt = hits[0]["excerpt"].as_str().unwrap();
    assert!(excerpt.contains("Straße"), "{excerpt}");
}

#[test]
fn search_excerpt_follows_a_case_fold_that_grows() {
    let mut host = host();
    touch(&host, "Bio/Istanbul.md");
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
    touch(&host, "Bio/Umlaut.md");
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
        touch(&host, &format!("Bio/{name}.md"));
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
    touch(&host, "Bio/Emoji.md");
    host.dispatch(
        "fanotes:write-file",
        &[json!("Bio/Emoji.md"), json!("Nur das letzte Zeichen.\n")],
    )
    .unwrap();
    let query = format!("{}Zeichen", "😀".repeat(250));
    let hits = host.dispatch("fanotes:search", &[json!(query)]).unwrap();
    assert!(hits.as_array().unwrap().is_empty());
}

#[test]
fn search_ignores_a_companion_above_the_desktop_limit() {
    let mut host = host();
    let vault = host.vault.clone().unwrap();
    std::fs::write(vault.join("Bio/Seite.md"), "Hallo Welt\n").unwrap();
    let companion = vault.join("Bio/Seite.famd");
    std::fs::write(&companion, ink_note("Notiz", Some("Geheimwort"))).unwrap();
    let hits = host
        .dispatch("fanotes:search", &[json!("Geheimwort")])
        .unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);

    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&companion)
        .unwrap();
    file.set_len(40 * 1024 * 1024 + 1).unwrap();
    drop(file);
    let hidden = host
        .dispatch("fanotes:search", &[json!("Geheimwort")])
        .unwrap();
    assert!(hidden.as_array().unwrap().is_empty());
    let kept = host.dispatch("fanotes:search", &[json!("Hallo")]).unwrap();
    assert_eq!(kept.as_array().unwrap().len(), 1);
    assert_eq!(kept[0]["relativePath"], "Bio/Seite.md");
}

#[test]
fn search_skips_a_note_that_cannot_be_read() {
    let mut host = host();
    let vault = host.vault.clone().unwrap();
    let note = vault.join("Bio/Geheim.md");
    std::fs::write(&note, "Inhalt\n").unwrap();
    let before = host.dispatch("fanotes:search", &[json!("Geheim")]).unwrap();
    assert_eq!(before.as_array().unwrap().len(), 1);

    let mut permissions = std::fs::metadata(&note).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o000);
    }
    std::fs::set_permissions(&note, permissions).unwrap();
    let hidden = host.dispatch("fanotes:search", &[json!("Geheim")]).unwrap();
    assert!(hidden.as_array().unwrap().is_empty());
    let content = host.dispatch("fanotes:search", &[json!("Inhalt")]).unwrap();
    assert!(content.as_array().unwrap().is_empty());

    let mut permissions = std::fs::metadata(&note).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o600);
    }
    std::fs::set_permissions(&note, permissions).unwrap();
}

#[test]
fn search_trims_a_byte_order_mark_and_keeps_a_next_line() {
    let mut host = host();
    touch(&host, "Bio/Blatt.md");
    host.dispatch(
        "fanotes:write-file",
        &[
            json!("Bio/Blatt.md"),
            json!("Die Photosynthese braucht Licht.\n"),
        ],
    )
    .unwrap();
    let found = host
        .dispatch("fanotes:search", &[json!("\u{FEFF}Photosynthese")])
        .unwrap();
    assert_eq!(found[0]["relativePath"], "Bio/Blatt.md");
    let missed = host
        .dispatch("fanotes:search", &[json!("\u{0085}Photosynthese")])
        .unwrap();
    assert!(missed.as_array().unwrap().is_empty());
}

#[test]
fn a_markdown_note_does_not_hide_its_handwriting_file() {
    let mut host = host();
    let vault = host.vault.clone().unwrap();
    let payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    std::fs::write(vault.join("Bio/Kapitel.markdown"), b"Nur die Notiz\n").unwrap();
    std::fs::write(
        vault.join("Bio/Kapitel.famd"),
        fanotes_famd::serialize_famd("Nur die Handschrift", &payload),
    )
    .unwrap();
    let hits = host
        .dispatch("fanotes:search", &[json!("Handschrift")])
        .unwrap();
    let paths: Vec<_> = hits
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|hit| hit["relativePath"].as_str())
        .collect();
    assert_eq!(paths, ["Bio/Kapitel.famd"]);

    std::fs::write(vault.join("Bio/Seite.md"), b"Notizdatei\n").unwrap();
    std::fs::write(
        vault.join("Bio/Seite.famd"),
        fanotes_famd::serialize_famd("Versteckte Handschrift", &payload),
    )
    .unwrap();
    let hidden = host
        .dispatch("fanotes:search", &[json!("Versteckte")])
        .unwrap();
    assert!(hidden.as_array().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_linux_note_name_keeps_its_backslash() {
    let mut host = host();
    let vault = host.vault.clone().unwrap();
    std::fs::create_dir_all(vault.join("Ordner")).unwrap();
    std::fs::write(vault.join("My\\Notes.md"), b"Backslashwort\n").unwrap();
    std::fs::write(
        vault.join("Ordner").join("My\\Notes.md"),
        b"Verschachtelt\n",
    )
    .unwrap();

    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let paths: Vec<_> = tree
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|entry| {
            let mut found = Vec::new();
            if entry["relativePath"].as_str() == Some("My\\Notes.md") {
                found.push(entry["relativePath"].as_str().unwrap());
            }
            if let Some(children) = entry["children"].as_array() {
                for child in children {
                    if let Some(path) = child["relativePath"].as_str() {
                        found.push(path);
                    }
                }
            }
            found
        })
        .collect();
    assert!(paths.contains(&"My\\Notes.md"), "{tree}");
    assert!(paths.contains(&"Ordner/My\\Notes.md"), "{tree}");

    let root_hit = host
        .dispatch("fanotes:search", &[json!("Backslashwort")])
        .unwrap();
    assert_eq!(root_hit[0]["relativePath"], "My\\Notes.md");
    assert_eq!(root_hit[0]["title"], "My\\Notes");
    let nested_hit = host
        .dispatch("fanotes:search", &[json!("Verschachtelt")])
        .unwrap();
    assert_eq!(nested_hit[0]["relativePath"], "Ordner/My\\Notes.md");
    assert_eq!(nested_hit[0]["title"], "My\\Notes");

    let scan = host.dispatch("fanotes:sync-scan", &[]).unwrap();
    let synced: Vec<_> = scan
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["path"].as_str())
        .collect();
    assert!(synced.contains(&"My\\Notes.md"), "{scan}");
    assert!(synced.contains(&"Ordner/My\\Notes.md"), "{scan}");
}

#[test]
fn search_uses_the_desktop_asset_folder_checks() {
    let mut ready = host();
    let vault = ready.vault.clone().unwrap();
    std::fs::write(vault.join("Bio/Blatt.md"), "Licht\n").unwrap();
    assert!(ready
        .dispatch("fanotes:search", &[json!("Licht")])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|hit| hit["relativePath"] == "Bio/Blatt.md"));
    let assets = vault.join(".fanotes/assets");
    assert!(assets.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&assets).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    std::fs::remove_dir(vault.join(".fanotes/assets")).unwrap();
    std::fs::write(vault.join(".fanotes/assets"), b"not a folder").unwrap();
    assert_eq!(
        ready
            .dispatch("fanotes:search", &[json!("Licht")])
            .unwrap_err(),
        "Der interne Asset-Ordner ist unsicher."
    );
    assert_eq!(
        ready.dispatch("fanotes:list-drawings", &[]).unwrap_err(),
        "Der interne Asset-Ordner ist unsicher."
    );

    let mut blocked = host();
    let vault = blocked.vault.clone().unwrap();
    std::fs::write(vault.join("Bio/Blatt.md"), "Licht\n").unwrap();
    std::fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    std::fs::write(vault.join(".fanotes"), b"not a folder").unwrap();
    assert_eq!(
        blocked
            .dispatch("fanotes:search", &[json!("Licht")])
            .unwrap_err(),
        "Der interne FaNotes-Ordner ist unsicher."
    );
    assert_eq!(
        blocked.dispatch("fanotes:list-drawings", &[]).unwrap_err(),
        "Der interne FaNotes-Ordner ist unsicher."
    );
}
