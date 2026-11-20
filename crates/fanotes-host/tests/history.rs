//! Note history through the host channels, as `electron/note-history.cjs`
//! (weekly and 12-hour tiers, the `.famd` companion beside a markdown note).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

fn host() -> (Host, PathBuf, fanotes_host::test_support::Scratch) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = fanotes_host::test_support::Scratch::new(format!(
        "fanotes-history-it-{}-{id}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let mut host = Host::open_hermetic(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault.clone()).unwrap();
    let vault = host.vault.clone().unwrap();
    (host, vault, dir)
}

fn history_dir(vault: &Path, note: &str) -> PathBuf {
    let digest = Sha1::digest(note.as_bytes());
    let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    vault.join(".fanotes/history").join(name)
}

fn index(vault: &Path, note: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(history_dir(vault, note).join("index.json")).unwrap(),
    )
    .unwrap()
}

fn list(host: &mut Host, note: &str) -> Vec<Value> {
    host.dispatch("fanotes:list-note-history", &[json!(note)])
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn a_markdown_save_keeps_the_companion_beside_the_text() {
    let (mut host, vault, dir) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Alt\n").unwrap();
    std::fs::write(vault.join("Mathe/Seite.famd"), b"companion-famd\n").unwrap();
    // The companion is not a stored famd, so the save rebuilds it; the history
    // keeps the bytes that were on disk before.
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Neu\n")],
    )
    .unwrap();
    let listed = list(&mut host, "Mathe/Seite.md");
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["id", "createdAt", "bytes"]
    );
    assert_eq!(listed[0]["bytes"], 4);
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), listed[0]["id"].clone()],
        )
        .unwrap();
    assert_eq!(snapshot["content"], "Alt\n");
    assert_eq!(snapshot["companion"], "companion-famd\n");
    let stored = index(&vault, "Mathe/Seite.md");
    let entry = &stored["snapshots"][0];
    assert_eq!(entry["tier"], "week");
    assert_eq!(entry["ext"], ".md");
    assert_eq!(entry["companion"], true);
    assert_eq!(stored["path"], "Mathe/Seite.md");
    let id = entry["id"].as_str().unwrap();
    let folder = history_dir(&vault, "Mathe/Seite.md");
    assert!(folder.join(format!("{id}.md")).is_file());
    assert!(folder.join(format!("{id}.famd")).is_file());

    // The next save within twelve hours is not a new snapshot.
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Neuer\n")],
    )
    .unwrap();
    assert_eq!(list(&mut host, "Mathe/Seite.md").len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_new_note_has_its_first_weekly_snapshot() {
    let (mut host, vault, dir) = host();
    let created = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Neu")])
        .unwrap();
    let path = created["relativePath"].as_str().unwrap().to_owned();
    // Desktop `writeFamdCompanion` snapshots the new note before its companion exists.
    let listed = list(&mut host, &path);
    assert_eq!(listed.len(), 1);
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!(path), listed[0]["id"].clone()],
        )
        .unwrap();
    assert_eq!(snapshot["content"], "# Neu\n\n");
    assert!(snapshot.get("companion").is_none());
    assert_eq!(index(&vault, &path)["snapshots"][0]["tier"], "week");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_handwriting_note_snapshot_is_a_famd_file() {
    let (mut host, vault, dir) = host();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Ink.famd"), json!("Erste\n")],
    )
    .unwrap();
    let listed = list(&mut host, "Mathe/Ink.famd");
    assert_eq!(listed.len(), 1);
    let entry = &index(&vault, "Mathe/Ink.famd")["snapshots"][0];
    assert_eq!(entry["ext"], ".famd");
    assert!(entry.get("companion").is_none());
    let id = entry["id"].as_str().unwrap();
    let folder = history_dir(&vault, "Mathe/Ink.famd");
    assert!(folder.join(format!("{id}.famd")).is_file());
    assert!(!folder.join(format!("{id}.md")).exists());
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Ink.famd"), json!(id)],
        )
        .unwrap();
    assert!(snapshot["content"].as_str().unwrap().contains("Erste"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_companion_update_snapshots_the_note_first() {
    let (mut host, vault, dir) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:set-note-paper-style",
        &[json!("Mathe/Seite.md"), json!("grid")],
    )
    .unwrap();
    let listed = list(&mut host, "Mathe/Seite.md");
    assert_eq!(listed.len(), 1);
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), listed[0]["id"].clone()],
        )
        .unwrap();
    assert_eq!(snapshot["content"], "Hallo\n");
    assert!(snapshot.get("companion").is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn opening_a_vault_prunes_expired_snapshots() {
    let (_, vault, dir) = host();
    let folder = history_dir(&vault, "Alt.md");
    std::fs::create_dir_all(&folder).unwrap();
    let mut snapshots = Vec::new();
    for (minute, tier) in [(0, None), (1, None), (2, Some("short"))] {
        let created = format!("2026-01-01T00:0{minute}:00.000Z");
        let id = format!("2026-01-01T00-0{minute}-00-000Z-aa000{minute}");
        std::fs::write(
            folder.join(format!("{id}.md")),
            format!("revision {minute}\n"),
        )
        .unwrap();
        std::fs::write(folder.join(format!("{id}.famd")), b"ink").unwrap();
        let mut entry = json!({ "id": id, "createdAt": created, "bytes": 11 });
        if let Some(tier) = tier {
            entry["tier"] = json!(tier);
        }
        snapshots.push(entry);
    }
    std::fs::write(
        folder.join("index.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "format": "fanotes-history-v1",
                "snapshots": snapshots,
                "path": "Alt.md",
            }))
            .unwrap()
        ),
    )
    .unwrap();
    let mut reopened = Host::open_hermetic(dir.join("app"));
    reopened.set_vault(vault.clone()).unwrap();
    let stored = index(&vault, "Alt.md");
    let kept = stored["snapshots"].as_array().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["id"], "2026-01-01T00-00-00-000Z-aa0000");
    assert_eq!(kept[0]["tier"], "week");
    assert_eq!(kept[0]["ext"], ".md");
    let mut names: Vec<String> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "2026-01-01T00-00-00-000Z-aa0000.famd",
            "2026-01-01T00-00-00-000Z-aa0000.md",
            "index.json",
        ]
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_electron_index_with_a_companion_reads_back() {
    // Layout written by `recordNoteHistorySnapshot(root, 'Mathe/Seite.md',
    // '# Text\n', { companion: 'companion-famd' })` in Electron.
    let (mut host, vault, dir) = host();
    let folder = history_dir(&vault, "Mathe/Seite.md");
    std::fs::create_dir_all(&folder).unwrap();
    let id = "2026-11-15T10-00-00-000Z-0a1b2c";
    std::fs::write(folder.join(format!("{id}.md")), b"# Text\n").unwrap();
    std::fs::write(folder.join(format!("{id}.famd")), b"companion-famd").unwrap();
    std::fs::write(
        folder.join("index.json"),
        format!("{{\n  \"format\": \"fanotes-history-v1\",\n  \"snapshots\": [\n    {{\n      \"id\": \"{id}\",\n      \"createdAt\": \"2026-11-15T10:00:00.000Z\",\n      \"bytes\": 7,\n      \"tier\": \"week\",\n      \"ext\": \".md\",\n      \"companion\": true\n    }}\n  ],\n  \"path\": \"Mathe/Seite.md\"\n}}\n"),
    )
    .unwrap();
    let before = std::fs::read(folder.join("index.json")).unwrap();
    let listed = list(&mut host, "Mathe/Seite.md");
    assert_eq!(
        listed,
        [json!({ "id": id, "createdAt": "2026-11-15T10:00:00.000Z", "bytes": 7 })]
    );
    // An index that is already current is not rewritten.
    assert_eq!(std::fs::read(folder.join("index.json")).unwrap(), before);
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap();
    assert_eq!(
        snapshot,
        json!({
            "id": id,
            "createdAt": "2026-11-15T10:00:00.000Z",
            "content": "# Text\n",
            "companion": "companion-famd",
        })
    );
    let _ = std::fs::remove_dir_all(dir);
}
