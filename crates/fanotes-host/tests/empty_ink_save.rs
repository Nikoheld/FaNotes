//! An empty handwriting page never replaces stored ink it did not load.
//!
//! Host cases of `fanotes/scripts/check-empty-ink-save.mjs` (2 and 3):
//! `save-drawing` refuses an empty page without an undo/redo step over a
//! record or companion that still has strokes, and answers like a normal save;
//! opening a note whose `.famd` holds such an empty page while the record
//! still has strokes opens the record. Neither writes anything.

use fanotes_famd::{empty_famd_payload, serialize_famd};
use fanotes_host::Host;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const INK_ID: &str = "3f1c2b9e-8d7a-4c1e-9f0b-2a6d5e4c3b21";
const TITLE: &str = "Handschrift · Physik";

fn body() -> String {
    format!("# Physik\n\n<!-- fanotes-ink:{INK_ID} -->")
}

/// `famd.serializeFamd(BODY, { …, ink: inked }, 'v2')` from the JS codec.
fn inked_v2_companion() -> String {
    serde_json::from_str::<String>(r##""# Physik\n\n<!-- fanotes-ink:3f1c2b9e-8d7a-4c1e-9f0b-2a6d5e4c3b21 -->\n\n<!-- fanotes-famd:v2 chars=600 crc=4d143f04 -->\n{\"schema\":\"fanotes-famd-v2\",\"updatedAt\":\"2026-10-01T08:00:00.000Z\",\"ink\":{\"schemaVersion\":1,\"title\":\"Handschrift · Physik\",\"paperStyle\":\"dots\",\"updatedAt\":\"2026-11-08T21:07:22.123Z\",\"searchTranscript\":\"Kraft\",\"strokes\":[{\"id\":\"stroke-1\",\"color\":\"#1f2937\",\"baseWidth\":2.4,\"famdPts\":\"SNfp<!!!!!!!)sB!!!!!!!!!!!!!!!!!*gE!!!!!!!*gESNfp<!!!!!!!)sB!!!!!!!*MR!!!!!!!*gE!!!!!!!*gE\",\"famdPtr\":\"pen\"},{\"id\":\"stroke-2\",\"color\":\"#1f2937\",\"baseWidth\":2.4,\"famdPts\":\"dvLqM!!!!!!!)sB!!!!!!!!!!!!!!!!!*gE!!!!!!!*gEdvLqM!!!!!!!)sB!!!!!!!*MR!!!!!!!*gE!!!!!!!*gE\",\"famdPtr\":\"pen\"}]},\"worksheets\":[],\"paperStyle\":\"dots\"}\n""##).unwrap()
}

fn stroke(serial: u32, x: f64) -> Value {
    json!({
        "id": format!("stroke-{serial}"),
        "color": "#1f2937",
        "baseWidth": 2.4,
        "points": [
            { "x": x, "y": 0.2, "t": 0, "pressure": 0.5, "pointerType": "pen" },
            { "x": x + 1e-5, "y": 0.2, "t": 1, "pressure": 0.5, "pointerType": "pen" },
        ],
    })
}

/// Key order and fields of DrawingBoard `drawingPayload` for an empty board.
fn page(extra: Value) -> Value {
    let mut page = json!({
        "schemaVersion": 1,
        "title": TITLE,
        "paperStyle": "dots",
        "sourceWidth": 900,
        "sourceHeight": 1273,
        "createdAt": "2026-11-08T21:07:20.000Z",
        "updatedAt": "2026-11-08T21:07:22.123Z",
        "strokes": [],
        "searchTranscript": "",
    });
    for (key, value) in extra.as_object().unwrap() {
        page[key] = value.clone();
    }
    page
}

fn skeleton() -> Value {
    page(json!({}))
}

fn inked() -> Value {
    page(json!({ "strokes": [stroke(1, 0.1), stroke(2, 0.3)], "searchTranscript": "Kraft" }))
}

fn cleared() -> Value {
    page(
        json!({ "inkHistory": { "extras": inked()["strokes"], "undo": [[{ "extra": 0 }, { "extra": 1 }]], "redo": [] } }),
    )
}

fn undone() -> Value {
    page(
        json!({ "inkHistory": { "extras": [stroke(9, 0.2)], "undo": [], "redo": [[{ "extra": 0 }]] } }),
    )
}

fn nested_collapsed() -> Value {
    page(json!({
        "sections": [{
            "id": "a", "top": 0.1, "bodyTop": 0.2, "collapsed": true,
            "hidden": {
                "widthPx": 900, "heightPx": 300, "strokes": [],
                "sections": [{ "id": "b", "parentId": "a", "top": 0.3, "bodyTop": 0.35, "collapsed": true,
                    "hidden": { "widthPx": 900, "heightPx": 100, "strokes": [stroke(5, 0.5)], "sections": [] } }],
            },
        }],
    }))
}

fn companion_of(ink: &Value) -> String {
    let mut payload = empty_famd_payload("2026-10-01T08:00:00.000Z");
    payload.paper_style = Some("dots".to_owned());
    payload.page_stats = Some(json!({ "createdAt": "2026-09-01T07:12:44.987Z", "openCount": 41 }));
    payload.ink = Some(ink.clone());
    serialize_famd(&body(), &payload)
}

struct Vault {
    dir: fanotes_host::test_support::Scratch,
    host: Host,
}

impl Vault {
    fn new() -> Self {
        let dir = fanotes_host::test_support::Scratch::new(format!(
            "fanotes-empty-ink-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("vault/.fanotes/assets")).unwrap();
        let mut host = Host::open_hermetic(dir.join("app"));
        host.set_vault(dir.join("vault")).unwrap();
        fs::write(dir.join("vault/Physik.md"), format!("{}\n", body())).unwrap();
        Vault { dir, host }
    }

    fn record(&self) -> PathBuf {
        self.dir
            .join(format!("vault/.fanotes/assets/{INK_ID}.json"))
    }

    fn companion(&self) -> PathBuf {
        self.dir.join("vault/Physik.famd")
    }

    fn put(path: &Path, text: Option<&str>) {
        match text {
            Some(text) => fs::write(path, text).unwrap(),
            None => {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn put_record(&self, text: Option<&str>) {
        Self::put(&self.record(), text);
    }

    fn put_companion(&self, text: Option<&str>) {
        Self::put(&self.companion(), text);
    }

    fn snapshot(&self) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
        (
            fs::read(self.record()).ok(),
            fs::read(self.companion()).ok(),
        )
    }

    fn save(&mut self, document: &Value) -> Value {
        self.host
            .dispatch(
                "fanotes:save-drawing",
                &[json!({
                    "id": INK_ID,
                    "title": TITLE,
                    "drawingJson": document.to_string(),
                    "noteRelativePath": "Physik.md",
                })],
            )
            .unwrap()
    }

    /// Saves and reports whether the record and companion stayed byte-identical.
    fn refused(&mut self, document: &Value) -> bool {
        let before = self.snapshot();
        let result = self.save(document);
        assert_eq!(result["id"], INK_ID);
        assert_eq!(result["title"], TITLE);
        assert_eq!(
            result["imageRelativePath"],
            format!(".fanotes/assets/{INK_ID}.png")
        );
        assert_eq!(
            result["dataRelativePath"],
            format!(".fanotes/assets/{INK_ID}.json")
        );
        self.snapshot() == before
    }

    fn open_ink(&mut self) -> Value {
        let ink = self
            .host
            .dispatch("fanotes:read-famd-ink", &[json!("Physik.md")])
            .unwrap();
        let companion = self
            .host
            .dispatch("fanotes:read-note-companion", &[json!("Physik.md")])
            .unwrap();
        assert_eq!(
            companion["ink"], ink,
            "read-note-companion opens the same ink"
        );
        ink
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn stroke_count(text: &[u8]) -> usize {
    serde_json::from_slice::<Value>(text).unwrap()["strokes"]
        .as_array()
        .unwrap()
        .len()
}

#[test]
fn an_empty_page_is_not_written_over_stored_ink() {
    let mut vault = Vault::new();
    let inked_text = inked().to_string();
    // v1 companion with strokes, and the JS codec's v2 companion.
    for companion in [companion_of(&inked()), inked_v2_companion()] {
        vault.put_record(Some(&inked_text));
        vault.put_companion(Some(&companion));
        assert!(
            vault.refused(&skeleton()),
            "skeleton over an inked note must be refused"
        );
    }
    // Only one of the two still has strokes: still refused.
    vault.put_record(Some(&skeleton().to_string()));
    vault.put_companion(Some(&companion_of(&inked())));
    assert!(
        vault.refused(&skeleton()),
        "companion with strokes keeps the page"
    );
    vault.put_record(Some(&inked_text));
    vault.put_companion(Some(&companion_of(&skeleton())));
    assert!(
        vault.refused(&skeleton()),
        "record with strokes keeps the page"
    );
    vault.put_record(None);
    vault.put_companion(Some(&companion_of(&inked())));
    assert!(
        vault.refused(&skeleton()),
        "companion with strokes and no record keeps the page"
    );
    vault.put_record(None);
    vault.put_companion(Some(&inked_v2_companion()));
    assert!(
        vault.refused(&skeleton()),
        "a v2 companion with strokes keeps the page"
    );
}

#[test]
fn ink_in_a_collapsed_subsection_is_stored_ink() {
    let mut vault = Vault::new();
    vault.put_record(Some(&nested_collapsed().to_string()));
    vault.put_companion(Some(&companion_of(&nested_collapsed())));
    assert!(vault.refused(&skeleton()));
    vault.put_record(Some(&inked().to_string()));
    vault.put_companion(Some(&companion_of(&inked())));
    assert!(
        !vault.refused(&nested_collapsed()),
        "a page whose ink is all collapsed is not empty"
    );
}

#[test]
fn an_unreadable_or_truncated_file_is_kept() {
    let mut vault = Vault::new();
    vault.put_record(None);
    let full = companion_of(&inked());
    vault.put_companion(Some(&full[..full.len() - 40]));
    assert!(
        vault.refused(&skeleton()),
        "a truncated companion is never replaced by an empty page"
    );
    vault.put_companion(None);
    // A record that is not a regular file cannot be read: it is kept.
    fs::create_dir(vault.record()).unwrap();
    assert!(vault.refused(&skeleton()), "an unreadable record is kept");
    fs::remove_dir(vault.record()).unwrap();
    // A companion behind a directory is unreadable too.
    fs::create_dir(vault.companion()).unwrap();
    assert!(
        vault.refused(&skeleton()),
        "an unreadable companion is kept"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_record_is_kept() {
    let mut vault = Vault::new();
    let outside = vault.dir.join("outside.json");
    fs::write(&outside, skeleton().to_string()).unwrap();
    std::os::unix::fs::symlink(&outside, vault.record()).unwrap();
    vault.put_companion(None);
    assert!(vault.refused(&skeleton()));
    assert!(fs::symlink_metadata(vault.record())
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn a_deliberate_clear_or_undo_is_written() {
    let mut vault = Vault::new();
    vault.put_record(Some(&inked().to_string()));
    vault.put_companion(Some(&companion_of(&inked())));
    assert!(
        !vault.refused(&cleared()),
        "clear() / erase-all must be written"
    );
    assert_eq!(stroke_count(&fs::read(vault.record()).unwrap()), 0);
    let companion = fs::read_to_string(vault.companion()).unwrap();
    let ink = fanotes_famd::parse_famd(&companion)
        .payload
        .unwrap()
        .ink
        .unwrap();
    assert_eq!(ink["strokes"].as_array().unwrap().len(), 0);
    vault.put_record(Some(&inked().to_string()));
    vault.put_companion(Some(&companion_of(&inked())));
    assert!(
        !vault.refused(&undone()),
        "undo of the last stroke (redo step) must be written"
    );
}

#[test]
fn an_empty_page_over_nothing_is_written() {
    let mut vault = Vault::new();
    vault.put_record(Some(&skeleton().to_string()));
    vault.put_companion(Some(&companion_of(&skeleton())));
    let before = fs::read(vault.record()).unwrap();
    assert!(!vault.refused(&page(json!({ "updatedAt": "2026-11-09T10:00:00.000Z" }))));
    assert_ne!(
        fs::read(vault.record()).unwrap(),
        before,
        "empty over empty is written"
    );
    vault.put_record(None);
    vault.put_companion(None);
    assert!(
        !vault.refused(&skeleton()),
        "a new empty page has nothing to protect"
    );
    assert!(vault.record().is_file());
}

#[test]
fn pen_saves_and_large_pages_are_written() {
    let mut vault = Vault::new();
    vault.put_record(Some(&inked().to_string()));
    vault.put_companion(Some(&companion_of(&inked())));
    let more = page(json!({ "strokes": [stroke(1, 0.1), stroke(2, 0.3), stroke(3, 0.5)] }));
    assert!(!vault.refused(&more));
    assert_eq!(stroke_count(&fs::read(vault.record()).unwrap()), 3);
    assert!(
        !vault.refused(&page(json!({ "strokes": [stroke(4, 0.7)] }))),
        "fewer strokes are a normal save"
    );
    vault.put_record(Some(&inked().to_string()));
    vault.put_companion(Some(&companion_of(&inked())));
    // A drawing of 256 Ki UTF-16 units or more is never a skeleton.
    let large = page(json!({ "searchTranscript": "x".repeat(256 * 1024) }));
    assert!(
        !vault.refused(&large),
        "a large drawing is never a skeleton"
    );
    assert_eq!(stroke_count(&fs::read(vault.record()).unwrap()), 0);
}

#[test]
fn an_empty_companion_with_an_inked_record_opens_the_record() {
    let mut vault = Vault::new();
    let inked_text = inked().to_string();
    vault.put_record(Some(&inked_text));
    vault.put_companion(Some(&companion_of(&skeleton())));
    let before = vault.snapshot();
    let opened = vault.open_ink();
    assert_eq!(opened["id"], INK_ID);
    assert_eq!(opened["title"], TITLE);
    assert_eq!(opened["updatedAt"], "2026-11-08T21:07:22.123Z");
    assert_eq!(
        opened["imageRelativePath"],
        format!(".fanotes/assets/{INK_ID}.png")
    );
    assert_eq!(
        opened["dataRelativePath"],
        format!(".fanotes/assets/{INK_ID}.json")
    );
    assert_eq!(opened["drawingJson"], inked_text);
    assert_eq!(vault.snapshot(), before, "opening writes nothing");

    // Both empty: the companion, as before.
    vault.put_record(Some(&skeleton().to_string()));
    assert_eq!(vault.open_ink()["dataRelativePath"], "Physik.famd");
    // No record, or a damaged one: the companion.
    vault.put_record(None);
    assert_eq!(vault.open_ink()["dataRelativePath"], "Physik.famd");
    vault.put_record(Some("{\"strokes\":[{\"points\":[{\"x\":0.1"));
    assert_eq!(vault.open_ink()["dataRelativePath"], "Physik.famd");
    // A companion with strokes, a deliberately cleared one, collapsed ink: the companion.
    vault.put_record(Some(&inked_text));
    for ink in [
        page(json!({ "strokes": [stroke(7, 0.4)] })),
        cleared(),
        nested_collapsed(),
    ] {
        vault.put_companion(Some(&companion_of(&ink)));
        let opened = vault.open_ink();
        assert_eq!(opened["dataRelativePath"], "Physik.famd");
        let document =
            serde_json::from_str::<Value>(opened["drawingJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            document["strokes"].as_array().map(Vec::len),
            ink["strokes"].as_array().map(Vec::len)
        );
        assert_eq!(
            document.get("sections").is_some(),
            ink.get("sections").is_some()
        );
    }
    // A companion without an ink marker keeps the existing companion read.
    let mut payload = empty_famd_payload("2026-10-01T08:00:00.000Z");
    payload.ink = Some(skeleton());
    vault.put_companion(Some(&serialize_famd("# Physik\n", &payload)));
    assert_eq!(vault.open_ink()["dataRelativePath"], "Physik.famd");
}

#[cfg(unix)]
#[test]
fn the_open_fallback_does_not_follow_a_linked_asset_folder() {
    let mut vault = Vault::new();
    let outside = vault.dir.join("outside-assets");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join(format!("{INK_ID}.json")), inked().to_string()).unwrap();
    fs::remove_dir_all(vault.dir.join("vault/.fanotes/assets")).unwrap();
    std::os::unix::fs::symlink(&outside, vault.dir.join("vault/.fanotes/assets")).unwrap();
    vault.put_companion(Some(&companion_of(&skeleton())));
    assert_eq!(vault.open_ink()["dataRelativePath"], "Physik.famd");
}
