use fanotes_famd::{
    companion_note_path, empty_famd_payload, parse_famd, parse_note_backups, parse_note_links,
    serialize_famd, strip_famd_payload, worksheet_ids_from_markdown, FamdPayload, NoteBackup,
    NoteLink,
};
use serde_json::json;

const MARKDOWN: &str =
    "# Analysis\n\n$$\\int x$$\n\n<!-- fanotes-ink:abc -->\n<!-- fanotes-worksheet:ws-1 -->\n";

fn fixture() -> FamdPayload {
    let mut payload = empty_famd_payload("2026-08-14T12:00:00.000Z");
    payload.ink = Some(json!({
        "schemaVersion": 1,
        "title": "Handschrift",
        "strokes": [{ "points": [{ "x": 0.2, "y": 0.3, "t": 1, "pressure": 0.5 }] }],
        "searchTranscript": "integral"
    }));
    payload.worksheets = worksheet_ids_from_markdown(MARKDOWN);
    payload.note_links = vec![NoteLink {
        id: "nl-famd-check".into(),
        source_path: "Mathe/Skript.pdf".into(),
        target_path: "Mathe/Skript-Notiz.md".into(),
        page: 3,
        x: 0.72,
        y: 0.18,
        style: "text".into(),
        label: "Skript-Notiz".into(),
        appearance: "text".into(),
    }];
    payload.note_backups = vec![NoteBackup {
        id: "nb-famd-check".into(),
        note_path: "Mathe/Analysis.md".into(),
        created_at: "2026-08-19T12:00:00.000Z".into(),
        content: "Stand A".into(),
    }];
    payload
}

#[test]
fn check_famd_roundtrip_matches_the_electron_codec() {
    let encoded = serialize_famd(MARKDOWN, &fixture());
    let golden = "# Analysis\n\n$$\\int x$$\n\n<!-- fanotes-ink:abc -->\n<!-- fanotes-worksheet:ws-1 -->\n\n<!-- fanotes-famd:v1 chars=551 -->\n{\"schema\":\"fanotes-famd-v1\",\"updatedAt\":\"2026-08-14T12:00:00.000Z\",\"ink\":{\"schemaVersion\":1,\"title\":\"Handschrift\",\"strokes\":[{\"points\":[{\"x\":0.2,\"y\":0.3,\"t\":1,\"pressure\":0.5}]}],\"searchTranscript\":\"integral\"},\"worksheets\":[\"ws-1\"],\"noteLinks\":[{\"id\":\"nl-famd-check\",\"sourcePath\":\"Mathe/Skript.pdf\",\"targetPath\":\"Mathe/Skript-Notiz.md\",\"page\":3,\"x\":0.72,\"y\":0.18,\"style\":\"text\",\"label\":\"Skript-Notiz\",\"appearance\":\"text\"}],\"noteBackups\":[{\"id\":\"nb-famd-check\",\"notePath\":\"Mathe/Analysis.md\",\"createdAt\":\"2026-08-19T12:00:00.000Z\",\"content\":\"Stand A\"}]}\n";
    assert_eq!(encoded, golden);
    assert!(encoded.contains("<!-- fanotes-famd:v1 chars="));
    let stripped = strip_famd_payload(&encoded);
    assert!(!stripped.contains("fanotes-famd"));
    assert!(!stripped.contains("\"schema\""));
    assert!(stripped.contains("# Analysis"));
    assert_eq!(
        strip_famd_payload("{\"schema\":\"fanotes-famd-v1\",\"updatedAt\":\"2026-09-07T00:00:00.000Z\",\"ink\":null,\"worksheets\":[]}"),
        ""
    );
    assert_eq!(
        strip_famd_payload("# Hello\n\n{\"schema\":\"fanotes-famd-v1\",\"updatedAt\":\"2026-09-07T00:00:00.000Z\",\"ink\":null,\"worksheets\":[]}"),
        "# Hello"
    );

    let parsed = parse_famd(&encoded);
    let payload = parsed.payload.expect("payload");
    assert_eq!(payload.schema, "fanotes-famd-v1");
    assert_eq!(payload.ink.unwrap()["title"], "Handschrift");
    assert_eq!(payload.worksheets, vec!["ws-1".to_string()]);
    assert_eq!(payload.note_links[0].target_path, "Mathe/Skript-Notiz.md");
    assert_eq!(payload.note_links[0].page, 3);
    assert_eq!(payload.note_links[0].style, "text");
    assert_eq!(payload.note_backups[0].content, "Stand A");
    assert!(parsed.markdown.contains("$$\\int x$$"));
    assert_eq!(
        companion_note_path("Mathe/Analysis.md", ".famd"),
        "Mathe/Analysis.famd"
    );
    assert_eq!(
        companion_note_path("Mathe/Analysis.famd", ".md"),
        "Mathe/Analysis.md"
    );
    assert_eq!(
        companion_note_path("Mathe/Skript.pdf", ".famd"),
        "Mathe/Skript.famd"
    );

    let poisoned = format!("{encoded}\n<!-- fanotes-famd:v1 chars=2 -->\n{{}}");
    assert!(parse_famd(&poisoned).payload.is_none());
}

#[test]
fn note_text_stops_at_js_character_limits() {
    let links = parse_note_links(&json!([{
        "id": "nl-emoji",
        "sourcePath": "A.md",
        "targetPath": "B.md",
        "label": "😀".repeat(41),
    }]));
    assert_eq!(links[0].label, "😀".repeat(40));
    assert_eq!(links[0].label.encode_utf16().count(), 80);

    let exact = "😀".repeat(1_048_576);
    let backups = parse_note_backups(&json!([{
        "id": "nb-emoji",
        "notePath": "A.md",
        "content": format!("{exact}😀"),
    }]));
    assert_eq!(backups[0].content, exact);
    assert_eq!(backups[0].content.encode_utf16().count(), 2 * 1024 * 1024);
}

#[test]
fn note_links_follow_javascript_whitespace() {
    let links = parse_note_links(&json!([{
        "id": "nl-ws",
        "sourcePath": "\u{FEFF}/Quelle.md",
        "targetPath": "\u{0085}Ziel.md",
        "label": "A\u{FEFF}B\u{0085}C  ",
    }]));
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].source_path, "/Quelle.md");
    assert_eq!(links[0].target_path, "\u{0085}Ziel.md");
    assert_eq!(links[0].label, "A B\u{0085}C");
    let mixed = parse_note_links(&json!([{
        "sourcePath": "A.md",
        "targetPath": "B.md",
        "label": "A\u{0085} \u{FEFF}B",
    }]));
    assert_eq!(mixed[0].label, "A\u{0085} B");

    let blank_label = parse_note_links(&json!([{
        "id": "nl-blank",
        "sourcePath": "A.md",
        "targetPath": "Ordner/Ziel.md",
        "label": "\u{FEFF}",
    }]));
    assert_eq!(blank_label[0].label, "Ziel");

    assert!(parse_note_links(&json!([{
        "sourcePath": "A.md",
        "targetPath": "\u{FEFF}",
    }]))
    .is_empty());

    let backups = parse_note_backups(&json!([{
        "id": "nb-next",
        "notePath": "\u{0085}",
    }]));
    assert_eq!(backups[0].note_path, "\u{0085}");
    assert!(parse_note_backups(&json!([{
        "notePath": "\u{FEFF}",
    }]))
    .is_empty());
}
