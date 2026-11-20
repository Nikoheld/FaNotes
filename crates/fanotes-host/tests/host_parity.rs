//! Channels added for Electron parity: `set-file-color`, `handwriting-learning`,
//! `share-open`, `convert-famd-notes`, and v2 `.famd` companions on save.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_famd::{empty_famd_payload, serialize_famd, serialize_famd_with, FamdEncoding};
use fanotes_host::{share_open_id, Host};
use serde_json::{json, Value};

struct Fixture {
    dir: PathBuf,
    vault: PathBuf,
    host: Host,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-parity-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::write(vault.join("Mathe/Notiz.md"), "# Notiz\n").unwrap();
    fs::write(vault.join("Mathe/Buch.pdf"), b"%PDF-").unwrap();
    let mut host = Host::open_hermetic(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault.clone()).unwrap();
    let vault = fs::canonicalize(vault).unwrap();
    Fixture { dir, vault, host }
}

fn file_entry<'a>(tree: &'a Value, path: &str) -> &'a Value {
    fn find<'a>(list: &'a Value, path: &str) -> Option<&'a Value> {
        for entry in list.as_array()? {
            if entry["relativePath"] == path {
                return Some(entry);
            }
            if let Some(found) = entry
                .get("children")
                .and_then(|children| find(children, path))
            {
                return Some(found);
            }
        }
        None
    }
    find(tree, path).unwrap_or_else(|| panic!("{path} missing"))
}

#[test]
fn a_document_colour_is_stored_shown_and_follows_the_file() {
    let mut f = fixture();
    let set = |host: &mut Host, path: &str, color: Value| {
        host.dispatch("fanotes:set-file-color", &[json!(path), color])
    };
    assert_eq!(
        set(&mut f.host, "Mathe/Notiz.md", json!("#AABBCC")).unwrap(),
        json!({ "color": "#aabbcc" })
    );
    set(&mut f.host, "Mathe/Buch.pdf", json!("#112233")).unwrap();
    let stored = fs::read_to_string(f.vault.join(".fanotes/file-colors.json")).unwrap();
    assert_eq!(
        stored,
        "{\n  \"version\": 1,\n  \"colors\": {\n    \"Mathe/Buch.pdf\": \"#112233\",\n    \"Mathe/Notiz.md\": \"#aabbcc\"\n  }\n}\n"
    );
    assert!(
        !f.vault.join(".fanotes/folder-colors.json").exists(),
        "documents never land in the folder list"
    );
    for channel in [
        "fanotes:get-tree",
        "fanotes:get-fast-tree",
        "fanotes:get-cached-tree",
    ] {
        let tree = f.host.dispatch(channel, &[]).unwrap();
        assert_eq!(
            file_entry(&tree, "Mathe/Notiz.md")["color"],
            "#aabbcc",
            "{channel}"
        );
        assert!(
            file_entry(&tree, "Mathe").get("color").is_none(),
            "{channel}"
        );
    }
    // Rename, move and trash carry the colour along or drop it.
    f.host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Notiz.md"), json!("Neu")],
        )
        .unwrap();
    f.host
        .dispatch("fanotes:rename-entry", &[json!("Mathe"), json!("Physik")])
        .unwrap();
    let tree = f.host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(file_entry(&tree, "Physik/Neu.md")["color"], "#aabbcc");
    f.host
        .dispatch("fanotes:trash-entry", &[json!("Physik/Buch.pdf")])
        .unwrap();
    let stored = fs::read_to_string(f.vault.join(".fanotes/file-colors.json")).unwrap();
    assert!(
        stored.contains("\"Physik/Neu.md\": \"#aabbcc\"") && !stored.contains("Buch.pdf"),
        "{stored}"
    );
    // Clearing works; clearing a colour that is not set writes nothing.
    assert_eq!(
        set(&mut f.host, "Physik/Neu.md", Value::Null).unwrap(),
        json!({ "color": null })
    );
    let before = fs::metadata(f.vault.join(".fanotes/file-colors.json"))
        .unwrap()
        .modified()
        .unwrap();
    set(&mut f.host, "Physik/Neu.md", Value::Null).unwrap();
    assert_eq!(
        fs::metadata(f.vault.join(".fanotes/file-colors.json"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
}

#[test]
fn a_document_colour_rejects_bad_input_and_paths() {
    let mut f = fixture();
    let error = |host: &mut Host, path: Value, color: Value| {
        host.dispatch("fanotes:set-file-color", &[path, color])
            .unwrap_err()
    };
    assert_eq!(
        error(&mut f.host, json!("Mathe/Notiz.md"), json!("red")),
        "Ungültige Dokumentfarbe."
    );
    assert_eq!(
        error(&mut f.host, json!("Mathe/Notiz.md"), json!(7)),
        "Ungültige Dokumentfarbe."
    );
    assert_eq!(
        error(&mut f.host, json!(3), json!("#000000")),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        error(&mut f.host, json!("../x.md"), json!("#000000")),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        error(&mut f.host, json!(".fanotes/x.md"), json!("#000000")),
        "Interne FaNotes-Dateien sind geschützt."
    );
    assert_eq!(
        error(&mut f.host, json!("Mathe"), json!("#000000")),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert!(error(&mut f.host, json!("Mathe/Fehlt.md"), json!("#000000")).contains("ENOENT"));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(f.vault.join("Mathe/Notiz.md"), f.vault.join("Link.md"))
            .unwrap();
        assert_eq!(
            error(&mut f.host, json!("Link.md"), json!("#000000")),
            "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
        );
    }
    assert!(!f.vault.join(".fanotes/file-colors.json").exists());
    // An unreadable colour list does not break the tree.
    fs::create_dir_all(f.vault.join(".fanotes/file-colors.json")).unwrap();
    assert!(f.host.dispatch("fanotes:get-tree", &[]).is_ok());
}

#[test]
fn handwriting_learning_checks_its_arguments_like_the_desktop() {
    let mut f = fixture();
    let call =
        |host: &mut Host, args: &[Value]| host.dispatch("fanotes:handwriting-learning", args);
    assert_eq!(call(&mut f.host, &[]).unwrap(), Value::Null);
    assert_eq!(call(&mut f.host, &[json!("scan")]).unwrap(), Value::Null);
    assert_eq!(
        call(&mut f.host, &[json!("delete")]).unwrap_err(),
        "Invalid learning operation"
    );
    assert_eq!(
        call(&mut f.host, &[Value::Null]).unwrap_err(),
        "Invalid learning operation"
    );
    assert_eq!(
        call(&mut f.host, &[json!("retrieve"), json!({ "text": 1 })]).unwrap_err(),
        "Invalid handwriting text query"
    );
    assert_eq!(
        call(
            &mut f.host,
            &[json!("retrieve"), json!({ "text": "x".repeat(8001) })]
        )
        .unwrap_err(),
        "Invalid handwriting text query"
    );
    assert_eq!(
        call(
            &mut f.host,
            &[json!("retrieve"), json!({ "text": "Hallo" })]
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        call(&mut f.host, &[json!("templates"), json!({})]).unwrap_err(),
        "Training library is too large"
    );
    let huge = Value::Array(vec![json!("x".repeat(1024 * 1024)); 13]);
    assert_eq!(
        call(&mut f.host, &[json!("templates"), huge]).unwrap_err(),
        "Training library is too large"
    );
    assert_eq!(
        call(&mut f.host, &[json!("templates"), json!([])]).unwrap(),
        Value::Null
    );
}

#[test]
fn a_share_link_is_delivered_once() {
    let id = "0123456789abcdef0123456789ABCDEF";
    assert_eq!(
        share_open_id(&["fanotes".into(), format!("FANOTES://share/{id}")]),
        Some(id.to_ascii_lowercase())
    );
    assert_eq!(share_open_id(&["fanotes://share/123".into()]), None);
    assert_eq!(
        share_open_id(&["fanotes://share/".into(), "0123".into()]),
        None
    );
    let mut f = fixture();
    assert!(!f.host.queue_share_open(&["--flag".into()]));
    assert!(f.host.queue_share_open(&[format!("fanotes://share/{id}/")]));
    assert_eq!(f.host.take_share_open(), Some(id.to_ascii_lowercase()));
    assert_eq!(f.host.take_share_open(), None);
    // The event channel dispatches like the other events.
    assert_eq!(
        f.host.dispatch("fanotes:share-open", &[]).unwrap(),
        Value::Null
    );
}

fn ink() -> Value {
    json!({ "strokes": [{ "id": "s-1", "color": "#1f2933", "width": 2.4, "tool": "pen",
        "points": [{ "x": 0.1, "y": 0.2, "pressure": 0.5, "t": 12 }, { "x": 0.3, "y": 0.4, "pressure": 0.6, "t": 20 }] }] })
}

#[test]
fn convert_famd_notes_rewrites_v1_notes_and_leaves_the_rest() {
    let mut f = fixture();
    let mut payload = empty_famd_payload("2026-10-31T08:00:00.000Z");
    payload.ink = Some(ink());
    let v1 = serialize_famd("# Alt", &payload);
    fs::write(f.vault.join("Mathe/Alt.famd"), &v1).unwrap();
    fs::write(
        f.vault.join("Mathe/Kaputt.famd"),
        "x\n<!-- fanotes-famd:v1 chars=9 -->\n{broken\n",
    )
    .unwrap();
    fs::create_dir_all(f.vault.join(".fanotes")).unwrap();
    fs::write(f.vault.join(".fanotes/Intern.famd"), &v1).unwrap();
    let counts = f.host.dispatch("fanotes:convert-famd-notes", &[]).unwrap();
    assert_eq!(counts, json!({ "converted": 1, "skipped": 1, "failed": 1 }));
    let converted = fs::read_to_string(f.vault.join("Mathe/Alt.famd")).unwrap();
    assert_eq!(
        converted,
        serialize_famd_with("# Alt", &payload, FamdEncoding::V2)
    );
    assert!(converted.contains("fanotes-famd:v2"));
    assert_eq!(
        fs::read_to_string(f.vault.join(".fanotes/Intern.famd")).unwrap(),
        v1
    );
    let leftovers: Vec<_> = fs::read_dir(f.vault.join("Mathe"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".famd-new"))
        .collect();
    assert!(leftovers.is_empty());
    // A second run finds nothing to do.
    let counts = f.host.dispatch("fanotes:convert-famd-notes", &[]).unwrap();
    assert_eq!(counts["converted"], 0);
}

#[test]
fn a_text_save_keeps_the_handwriting_of_a_v2_companion() {
    let mut f = fixture();
    let mut payload = empty_famd_payload("2026-10-31T08:00:00.000Z");
    payload.ink = Some(ink());
    fs::write(
        f.vault.join("Mathe/Notiz.famd"),
        serialize_famd_with("# Notiz", &payload, FamdEncoding::V2),
    )
    .unwrap();
    f.host
        .dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Notiz.md"), json!("# Notiz\n\nNeu\n")],
        )
        .unwrap();
    let companion = fs::read_to_string(f.vault.join("Mathe/Notiz.famd")).unwrap();
    assert!(companion.contains("fanotes-famd:v2"), "a v2 note stays v2");
    let parsed = fanotes_famd::parse_famd(&companion);
    assert_eq!(parsed.markdown, "# Notiz\n\nNeu");
    let strokes = &parsed.payload.unwrap().ink.unwrap()["strokes"];
    assert_eq!(
        strokes[0]["points"].as_array().unwrap().len(),
        2,
        "the ink survived the save"
    );
    // A damaged v2 companion is refused, not replaced.
    let damaged = companion
        .replacen("fanotes-famd:v2", "fanotes-famd:v2 ", 1)
        .replace("!", "~");
    fs::write(f.vault.join("Mathe/Notiz.famd"), &damaged).unwrap();
    assert!(f
        .host
        .dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Notiz.md"), json!("# Weg\n")]
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(f.vault.join("Mathe/Notiz.famd")).unwrap(),
        damaged
    );
}

#[test]
fn a_new_note_gets_a_compact_companion() {
    let mut f = fixture();
    let created = f
        .host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Frisch")])
        .unwrap();
    assert_eq!(created["relativePath"], "Mathe/Frisch.md");
    let companion = fs::read_to_string(f.vault.join("Mathe/Frisch.famd")).unwrap();
    assert!(companion.contains("fanotes-famd:v2"), "{companion}");
}
