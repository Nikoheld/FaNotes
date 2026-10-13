use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_famd::parse_famd;
use fanotes_host::Host;
use serde_json::json;

fn host() -> (Host, std::path::PathBuf) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-notes-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault.clone()).unwrap();
    (host, vault)
}

#[cfg(unix)]
#[test]
fn an_unreadable_note_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    let note = vault.join("Mathe/Seite.md");
    std::fs::write(&note, b"Hallo\n").unwrap();
    let canonical = std::fs::canonicalize(&note).unwrap();
    std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(note.clone());
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(std::fs::read(&note).unwrap(), b"Hallo\n");
}

#[cfg(unix)]
#[test]
fn an_unreadable_handwriting_file_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    let famd = vault.join("Mathe/Seite.famd");
    std::fs::write(&famd, b"<!-- fanotes-famd:v1 chars=0 -->\n").unwrap();
    let canonical = std::fs::canonicalize(&famd).unwrap();
    std::fs::set_permissions(&famd, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(famd.clone());
    assert_eq!(
        host.dispatch("fanotes:read-famd-ink", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    std::fs::set_permissions(&famd, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(famd.is_file());
}

#[cfg(unix)]
#[test]
fn an_unlistable_companion_uses_the_desktop_lstat_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    let folder = vault.join("Mathe");
    let famd = folder.join("Seite.famd");
    std::fs::write(&famd, b"INK-BLEIBT").unwrap();
    let canonical = std::fs::canonicalize(&famd).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf, u32);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(self.1));
        }
    }
    let _restore_folder = Restore(folder.clone(), 0o700);
    let lstat_error = format!(
        "EACCES: permission denied, lstat '{}'",
        canonical.display()
    );
    for channel in ["fanotes:read-note-paper-style", "fanotes:read-famd-ink"] {
        assert_eq!(
            host.dispatch(channel, &[json!("Mathe/Seite.md")])
                .unwrap_err(),
            lstat_error,
            "{channel}"
        );
    }
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(std::fs::read(&famd).unwrap(), b"INK-BLEIBT");
    let file = std::fs::OpenOptions::new().write(true).open(&famd).unwrap();
    file.set_len(40 * 1024 * 1024 + 1).unwrap();
    drop(file);
    std::fs::set_permissions(&famd, std::fs::Permissions::from_mode(0o000)).unwrap();
    let _restore_file = Restore(famd.clone(), 0o600);
    let open_error = format!(
        "EACCES: permission denied, open '{}'",
        canonical.display()
    );
    for channel in ["fanotes:read-note-paper-style", "fanotes:read-famd-ink"] {
        assert_eq!(
            host.dispatch(channel, &[json!("Mathe/Seite.md")])
                .unwrap_err(),
            open_error,
            "{channel}"
        );
    }
    std::fs::set_permissions(&famd, std::fs::Permissions::from_mode(0o600)).unwrap();
    for channel in ["fanotes:read-note-paper-style", "fanotes:read-famd-ink"] {
        assert_eq!(
            host.dispatch(channel, &[json!("Mathe/Seite.md")])
                .unwrap_err(),
            "Die Datei ist zu groß.",
            "{channel}"
        );
    }
}

#[cfg(unix)]
#[test]
fn an_unreadable_companion_does_not_look_missing() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    let note = vault.join("Mathe/Seite.md");
    let famd = vault.join("Mathe/Seite.famd");
    std::fs::write(&note, b"alt\n").unwrap();
    std::fs::write(&famd, b"INK-BLEIBT\n").unwrap();
    let canonical = std::fs::canonicalize(&famd).unwrap();
    std::fs::set_permissions(&famd, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(famd.clone());
    let expected = format!(
        "EACCES: permission denied, open '{}'",
        canonical.display()
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        expected
    );
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Seite.md"), json!("neu\n")],
        )
        .unwrap_err(),
        expected
    );
    std::fs::set_permissions(&famd, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(std::fs::read(&famd).unwrap(), b"INK-BLEIBT\n");
}

#[cfg(unix)]
#[test]
fn an_unreadable_history_index_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let history = vault.join(".fanotes/history");
    let index = std::fs::read_dir(&history)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("index.json");
    let canonical = std::fs::canonicalize(&index).unwrap();
    std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(index.clone());
    assert_eq!(
        host.dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::remove_file(&index).unwrap();
    std::fs::create_dir(&index).unwrap();
    assert_eq!(
        host.dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        "EISDIR: illegal operation on a directory, read"
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_history_snapshot_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let listed = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    let id = listed[0]["id"].as_str().unwrap().to_owned();
    let snapshot = std::fs::read_dir(vault.join(".fanotes/history"))
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path().join(format!("{id}.md"));
            path.is_file().then_some(path)
        })
        .unwrap();
    let canonical = std::fs::canonicalize(&snapshot).unwrap();
    std::fs::set_permissions(&snapshot, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(snapshot.clone());
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    std::fs::set_permissions(&snapshot, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::remove_file(&snapshot).unwrap();
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(&id)],
        )
        .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, open '{}'",
            canonical.display()
        )
    );
    std::fs::create_dir(&snapshot).unwrap();
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap_err(),
        "EISDIR: illegal operation on a directory, read"
    );
}

#[cfg(unix)]
#[test]
fn an_unsearchable_vault_reports_the_desktop_history_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, _) = host();
    let vault = host.vault.clone().unwrap();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let listed = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    let id = listed[0]["id"].as_str().unwrap();
    let index = std::fs::read_dir(vault.join(".fanotes/history"))
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path().join("index.json");
            path.is_file().then_some(path)
        })
        .unwrap();
    let canonical = std::fs::canonicalize(&index).unwrap();
    std::fs::set_permissions(&vault, std::fs::Permissions::from_mode(0o666)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(vault);
    let expected = format!("EACCES: permission denied, open '{}'", canonical.display());
    assert_eq!(
        host.dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        expected
    );
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap_err(),
        expected
    );
}

#[cfg(unix)]
#[test]
fn a_file_in_the_history_path_reports_the_desktop_open_error() {
    let (mut host, _) = host();
    let vault = host.vault.clone().unwrap();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    let index = vault.join(
        ".fanotes/history/5798959f2b2256a0bff452f5e895b16e3a8401da/index.json",
    );
    let expected = format!("ENOTDIR: not a directory, open '{}'", index.display());
    std::fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    std::fs::write(vault.join(".fanotes"), b"datei").unwrap();
    assert_eq!(
        host.dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        expected
    );
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!("snap")],
        )
        .unwrap_err(),
        expected
    );
}

#[cfg(unix)]
#[test]
fn a_file_named_history_reports_the_desktop_open_error() {
    let (mut host, _) = host();
    let vault = host.vault.clone().unwrap();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    std::fs::write(vault.join(".fanotes/history"), b"datei").unwrap();
    let index = vault.join(
        ".fanotes/history/5798959f2b2256a0bff452f5e895b16e3a8401da/index.json",
    );
    assert_eq!(
        host.dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        format!("ENOTDIR: not a directory, open '{}'", index.display())
    );
}

#[cfg(unix)]
#[test]
fn a_linked_history_folder_still_lists_its_snapshots() {
    let (mut host, _) = host();
    let vault = host.vault.clone().unwrap();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let history = vault.join(".fanotes/history");
    let stored = vault.join("gespeicherter-verlauf");
    std::fs::rename(&history, &stored).unwrap();
    std::os::unix::fs::symlink(&stored, &history).unwrap();
    let listed = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["bytes"], 6);
}

#[test]
fn a_tree_modification_time_rounds_to_the_nearest_millisecond() {
    let (mut host, vault) = host();
    let path = vault.join("Mathe/Seite.md");
    std::fs::write(&path, b"Hallo\n").unwrap();
    let when = std::time::UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 600_000);
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(when))
        .unwrap();
    drop(file);
    let stored = std::fs::metadata(&path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    assert_eq!(stored.subsec_nanos(), 600_000, "the clock kept 0.6 ms");
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let folder = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Mathe")
        .unwrap();
    let note = folder["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Seite.md")
        .unwrap();
    assert_eq!(note["modifiedAt"], "2023-11-14T22:13:20.001Z");
}

#[test]
fn a_file_is_not_a_folder_target() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Seite.md"), b"Hallo\n").unwrap();
    std::fs::write(vault.join("Andere.md"), b"Welt\n").unwrap();
    assert_eq!(
        host.dispatch("fanotes:create-folder", &[json!("Seite.md")])
            .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("Seite.md"), json!("Neu")])
            .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:move-entry",
            &[json!("Andere.md"), json!("Seite.md")],
        )
        .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:set-folder-color",
            &[json!("Seite.md"), json!("#112233")],
        )
        .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    let missing = std::fs::canonicalize(&vault).unwrap().join("Fehlt");
    assert_eq!(
        host.dispatch("fanotes:create-folder", &[json!("Fehlt")])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    assert!(vault.join("Andere.md").is_file());
    assert!(!vault.join("Neuer Ordner").exists());
}

#[test]
fn a_read_checks_the_markdown_extension_before_the_path_shape() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Seite.md"), b"Hallo\n").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("../secret.txt")])
            .unwrap_err(),
        "Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("../secret.md")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!(".fanotes/Notiz.md")])
            .unwrap_err(),
        "Interne FaNotes-Dateien sind geschützt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("notes\\page.txt")])
            .unwrap_err(),
        "Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("notes\\page.md")])
            .unwrap_err(),
        "Nur relative Vault-Pfade sind erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Seite.md/")]).unwrap(),
        json!("Hallo")
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!("../secret.txt"), json!("Text")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:list-note-history",
            &[json!("../secret.txt")],
        )
        .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
}

#[test]
fn a_note_link_reads_page_and_position_with_javascript_number() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    let links = host
        .dispatch(
            "fanotes:write-note-links",
            &[
                json!("Mathe/Seite.md"),
                json!([
                    {
                        "id": "link-a",
                        "sourcePath": "anders.md",
                        "targetPath": "Physik/Kraft.md",
                        "page": "4",
                        "x": "0.25",
                        "y": null,
                        "label": "Kraft"
                    },
                    {
                        "id": "link-b",
                        "sourcePath": "anders.md",
                        "targetPath": "Physik/Andere.md",
                        "page": "4.5",
                        "x": 0.1,
                        "y": 0.2,
                        "label": "Andere"
                    },
                    {
                        "id": "link-c",
                        "sourcePath": "anders.md",
                        "targetPath": "Physik/Liste.md",
                        "page": [9],
                        "x": [0.5],
                        "y": [1, 2],
                        "label": "Liste"
                    }
                ]),
            ],
        )
        .unwrap();
    assert_eq!(links[0]["page"], 4);
    assert_eq!(links[0]["x"].as_f64(), Some(0.25));
    assert_eq!(links[0]["y"].as_f64(), Some(0.0));
    assert_eq!(links[1]["page"], 1);
    assert_eq!(links[2]["page"], 9);
    assert_eq!(links[2]["x"].as_f64(), Some(0.5));
    assert_eq!(links[2]["y"].as_f64(), Some(0.5));
}

#[test]
fn a_saved_note_adopts_links_and_backups_from_the_trailer() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:write-note-links",
        &[
            json!("Mathe/Seite.md"),
            json!([{
                "id": "link-old",
                "sourcePath": "Mathe/Seite.md",
                "targetPath": "Physik/Alt.md",
                "label": "Alt"
            }]),
        ],
    )
    .unwrap();
    let json = r#"{"schema":"fanotes-famd-v1","updatedAt":"2026-01-02T00:00:00.000Z","ink":null,"worksheets":[],"noteLinks":[{"id":"link-new","sourcePath":"Mathe/Seite.md","targetPath":"Physik/Neu.md","page":2,"x":0.2,"y":0.3,"style":"symbol","label":"Neu","appearance":"symbol"}],"noteBackups":[{"id":"nb-keep","notePath":"Mathe/Seite.md","createdAt":"2026-01-02T00:00:00.000Z","content":"vorher"}]}"#;
    let content = format!(
        "Hallo\n\n<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
        json.encode_utf16().count()
    );
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!(content)],
    )
    .unwrap();
    let links = host
        .dispatch("fanotes:read-note-links", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(links.as_array().unwrap().len(), 1);
    assert_eq!(links[0]["id"], "link-new");
    assert_eq!(links[0]["targetPath"], "Physik/Neu.md");
    let backups = host
        .dispatch("fanotes:read-note-backups", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(backups[0]["id"], "nb-keep");
    assert_eq!(backups[0]["content"], "vorher");
}

#[cfg(unix)]
#[test]
fn an_unreadable_subject_book_list_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    std::fs::create_dir_all(vault.join(".fanotes")).unwrap();
    let path = vault.join(".fanotes/subject-books.json");
    std::fs::write(&path, b"{\"version\":1,\"books\":[]}\n").unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(path.clone());
    assert_eq!(
        host.dispatch("fanotes:read-subject-books", &[])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-subject-books", &[]).unwrap(),
        json!([])
    );
}

#[test]
fn a_subject_book_page_follows_javascript_number() {
    let (mut host, _) = host();
    let books = host
        .dispatch(
            "fanotes:write-subject-books",
            &[json!([
                { "subjectPath": "Mathe", "bookPath": "Mathe/Buch.pdf", "lastPage": "12" },
                { "subjectPath": "Physik", "bookPath": "Physik/Buch.pdf", "lastPage": " 4 " },
                { "subjectPath": "Chemie", "bookPath": "Chemie/Buch.pdf", "lastPage": "12.5" },
                { "subjectPath": "Bio", "bookPath": "Bio/Buch.pdf", "lastPage": 9007199254740992_i64 },
                { "subjectPath": "Kunst", "bookPath": "Kunst/Buch.pdf", "lastPage": [8] },
                { "subjectPath": "Musik", "bookPath": "Musik/Buch.pdf", "lastPage": [1, 2] }
            ])],
        )
        .unwrap();
    assert_eq!(books[0]["lastPage"], 12);
    assert_eq!(books[1]["lastPage"], 4);
    assert_eq!(books[2]["lastPage"], 1);
    assert_eq!(books[3]["lastPage"], 1);
    assert_eq!(books[4]["lastPage"], 8);
    assert_eq!(books[5]["lastPage"], 1);
}

#[test]
fn a_note_with_an_invalid_byte_still_opens_and_can_be_found() {
    let (mut host, vault) = host();
    let mut bytes = b"Die Photosynthese braucht Licht.\n".to_vec();
    bytes.insert(4, 0xff);
    std::fs::write(vault.join("Mathe/Blatt.md"), &bytes).unwrap();

    let text = host
        .dispatch("fanotes:read-file", &[json!("Mathe/Blatt.md")])
        .unwrap();
    let text = text.as_str().unwrap();
    assert!(text.contains('\u{FFFD}'));
    assert!(text.contains("Photosynthese"));

    let hits = host
        .dispatch("fanotes:search", &[json!("Photosynthese")])
        .unwrap();
    assert_eq!(hits[0]["relativePath"], "Mathe/Blatt.md");

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Blatt.md"), json!("Neu\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Blatt.md")])
        .unwrap();
    let id = history[0]["id"].as_str().unwrap();
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Blatt.md"), json!(id)],
        )
        .unwrap();
    let content = snapshot["content"].as_str().unwrap();
    assert!(content.contains('\u{FFFD}'));
    assert!(content.contains("Photosynthese"));
}

#[test]
fn paper_links_books_and_history_round_trip() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();

    let style = host
        .dispatch(
            "fanotes:set-note-paper-style",
            &[json!("Mathe/Seite.md"), json!("grid")],
        )
        .unwrap();
    assert_eq!(style, "grid");
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "grid"
    );
    let famd = std::fs::read_to_string(vault.join("Mathe/Seite.famd")).unwrap();
    let parsed = parse_famd(&famd);
    assert_eq!(parsed.markdown.trim(), "Hallo");
    assert_eq!(parsed.payload.unwrap().paper_style.as_deref(), Some("grid"));

    let links = host
        .dispatch(
            "fanotes:write-note-links",
            &[
                json!("Mathe/Seite.md"),
                json!([
                    {
                        "id": "nl-1",
                        "sourcePath": "anders.md",
                        "targetPath": "Physik/Kraft.md",
                        "page": 2,
                        "x": 0.2,
                        "y": 0.4,
                        "style": "text",
                        "label": "Kraft"
                    },
                    { "sourcePath": "Mathe/Seite.md", "targetPath": "kein-ziel" }
                ]),
            ],
        )
        .unwrap();
    assert_eq!(links.as_array().unwrap().len(), 1);
    assert_eq!(links[0]["sourcePath"], "Mathe/Seite.md");
    assert_eq!(links[0]["targetPath"], "Physik/Kraft.md");
    assert_eq!(links[0]["style"], "text");

    let books = host
        .dispatch(
            "fanotes:write-subject-books",
            &[json!([
                { "subjectPath": "Mathe", "bookPath": "Mathe/Buch.pdf", "lastPage": 4 },
                { "subjectPath": "Mathe.md", "bookPath": "Mathe/Buch.pdf", "lastPage": 1 },
                { "subjectPath": "Physik", "bookPath": "notes.txt", "lastPage": 1 }
            ])],
        )
        .unwrap();
    assert_eq!(books.as_array().unwrap().len(), 1);
    assert_eq!(books[0]["lastPage"], 4);
    let stored = host.dispatch("fanotes:read-subject-books", &[]).unwrap();
    assert_eq!(stored, books);

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    let id = history[0]["id"].as_str().unwrap();
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap();
    assert_eq!(snapshot["content"], "Hallo\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let history = vault.join(".fanotes/history");
        let mode = std::fs::symlink_metadata(&history)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
        let note_dir = std::fs::read_dir(&history)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mode = std::fs::symlink_metadata(&note_dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
        let mode = std::fs::symlink_metadata(note_dir.join(format!("{id}.md")))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "grid"
    );
    assert_eq!(
        std::fs::read_to_string(vault.join("Mathe/Seite.md")).unwrap(),
        "Welt\n"
    );
}

#[test]
fn saving_markdown_keeps_the_handwriting_sidecar() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Seite.md"), b"\n").unwrap();
    let saved = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Seite.md"), json!("Ohne Umbruch")],
        )
        .unwrap();
    assert!(saved["modifiedAt"].as_str().unwrap().contains('T'));
    assert_eq!(
        std::fs::read_to_string(vault.join("Seite.md")).unwrap(),
        "Ohne Umbruch\n"
    );
    let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    payload.ink = Some(json!({
        "schemaVersion": 1,
        "title": "Seite",
        "strokes": [],
        "paperStyle": "lines"
    }));
    payload.paper_style = Some("lines".to_owned());
    std::fs::write(
        vault.join("Seite.famd"),
        fanotes_famd::serialize_famd("Ohne Umbruch", &payload),
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Seite.md"), json!("Neue Fassung\n")],
    )
    .unwrap();
    let ink = host
        .dispatch("fanotes:read-famd-ink", &[json!("Seite.md")])
        .unwrap();
    assert!(ink["drawingJson"].as_str().unwrap().contains("Seite"));
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Seite.md")])
            .unwrap(),
        "lines"
    );
}

#[test]
fn renaming_and_deleting_a_note_moves_its_companion() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:set-note-paper-style",
        &[json!("Mathe/Seite.md"), json!("grid")],
    )
    .unwrap();
    let renamed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md"), json!("Blatt.md")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Blatt.md");
    assert!(!vault.join("Mathe/Seite.famd").exists());
    assert!(vault.join("Mathe/Blatt.famd").is_file());
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Blatt.md")])
            .unwrap(),
        "grid"
    );
    host.dispatch("fanotes:create-folder", &[json!(""), json!("Physik")])
        .unwrap();
    host.dispatch(
        "fanotes:move-entry",
        &[json!("Mathe/Blatt.md"), json!("Physik")],
    )
    .unwrap();
    assert!(vault.join("Physik/Blatt.famd").is_file());
    assert!(!vault.join("Mathe/Blatt.famd").exists());
    host.dispatch("fanotes:trash-entry", &[json!("Physik/Blatt.md")])
        .unwrap();
    assert!(!vault.join("Physik/Blatt.md").exists());
    assert!(!vault.join("Physik/Blatt.famd").exists());
}

#[test]
fn a_new_note_adopts_an_existing_handwriting_companion() {
    let (mut host, vault) = host();
    let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
    payload.ink = Some(json!({
        "schemaVersion": 1,
        "title": "Seite",
        "strokes": [],
        "searchTranscript": "Handschrift"
    }));
    std::fs::write(
        vault.join("Mathe/Seite.famd"),
        fanotes_famd::serialize_famd("Alte Handschrift", &payload),
    )
    .unwrap();

    let created = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
        .unwrap();
    assert_eq!(created["relativePath"], "Mathe/Seite.md");
    assert_eq!(
        std::fs::read_to_string(vault.join("Mathe/Seite.md")).unwrap(),
        "# Seite\n\n"
    );
    let famd = std::fs::read_to_string(vault.join("Mathe/Seite.famd")).unwrap();
    let parsed = parse_famd(&famd);
    assert!(parsed.markdown.contains("# Seite"));
    assert!(!parsed.markdown.contains("Alte Handschrift"));
    assert_eq!(
        parsed.payload.unwrap().ink.unwrap()["searchTranscript"],
        "Handschrift"
    );
    let names: Vec<_> = host.dispatch("fanotes:get-tree", &[]).unwrap()[0]["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["Seite.md"]);

    let second = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
        .unwrap();
    assert_eq!(second["relativePath"], "Mathe/Seite 2.md");
}

#[test]
fn a_companion_read_follows_the_desktop_file_check() {
    let (mut host, vault) = host();
    std::fs::create_dir(vault.join("Mathe/Ordner.md")).unwrap();
    let mut payload = fanotes_famd::empty_famd_payload("2026-01-02T03:04:05.000Z");
    payload.page_stats = Some(json!({"words": 2}));
    std::fs::write(
        vault.join("Mathe/Ordner.famd"),
        fanotes_famd::serialize_famd("", &payload),
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-page-stats", &[json!("Mathe/Ordner.md")])
            .unwrap(),
        json!({"words": 2})
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-links", &[json!("Mathe/Leer.md")])
            .unwrap(),
        json!([])
    );

    std::fs::create_dir(vault.join("Mathe/Kaputt.famd")).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-famd-ink", &[json!("Mathe/Kaputt.md")])
            .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-page-stats", &[json!("Mathe/Kaputt.md")])
            .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    let before = std::fs::read(vault.join("Mathe/Ordner.famd")).unwrap();
    assert_eq!(
        host.dispatch(
            "fanotes:set-note-paper-style",
            &[json!("Mathe/Ordner.md"), json!("grid")],
        )
        .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Ordner.md"), json!("Hallo\n")],
        )
        .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert_eq!(
        std::fs::read(vault.join("Mathe/Ordner.famd")).unwrap(),
        before
    );
}

#[test]
fn a_directory_named_like_a_note_cannot_be_read() {
    let (mut host, vault) = host();
    std::fs::create_dir(vault.join("Mathe/Seite.md")).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Seite.md"), json!("Hallo\n")],
        )
        .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
}

#[test]
fn a_missing_markdown_note_is_not_created_by_writing() {
    let (mut host, vault) = host();
    let missing = std::fs::canonicalize(vault.join("Mathe")).unwrap().join("Neu.md");
    let missing_error = format!(
        "ENOENT: no such file or directory, lstat '{}'",
        missing.display()
    );
    let error = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Neu.md"), json!("Hallo\n")],
        )
        .unwrap_err();
    assert_eq!(error, missing_error);
    assert!(!vault.join("Mathe/Neu.md").exists());
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/Neu.md")])
            .unwrap_err(),
        missing_error
    );

    let saved = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Neu.famd"), json!("Hallo\n")],
        )
        .unwrap();
    assert!(saved["modifiedAt"].as_str().unwrap().contains('T'));
    assert!(vault.join("Mathe/Neu.famd").is_file());
    assert!(!vault.join("Mathe/Neu.md").exists());
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/Neu.famd")])
            .unwrap(),
        "Hallo"
    );
}

#[test]
fn a_kelvin_markdown_note_stores_handwriting_beside_the_same_stem() {
    let (mut host, vault) = host();
    let name = "Notiz.mar\u{212A}down";
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!(name)])
        .unwrap();
    assert_eq!(created["relativePath"], name);
    assert_eq!(created["entry"]["extension"], "markdown");
    assert!(vault.join(name).is_file());
    assert!(vault.join("Notiz.famd").is_file());
    assert!(!vault.join("Notiz.m.famd").exists());
    let sidecar = std::fs::read_to_string(vault.join("Notiz.famd")).unwrap();
    assert!(sidecar.contains("# Notiz"));
}

#[test]
fn a_second_note_is_numbered_and_reads_without_the_sidecar() {
    let (mut host, vault) = host();
    let first = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
        .unwrap();
    assert_eq!(first["relativePath"], "Mathe/Seite.md");
    assert_eq!(first["entry"]["kind"], "file");
    assert_eq!(first["entry"]["name"], "Seite.md");
    assert_eq!(first["entry"]["extension"], "md");
    assert_eq!(
        std::fs::read_to_string(vault.join("Mathe/Seite.md")).unwrap(),
        "# Seite\n\n"
    );
    let second = host
        .dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
        .unwrap();
    assert_eq!(second["relativePath"], "Mathe/Seite 2.md");
    host.settings.insert("uiLanguage".to_owned(), json!("de"));
    let untitled = host.dispatch("fanotes:create-note", &[json!("")]).unwrap();
    assert_eq!(untitled["relativePath"], "Unbenannte Notiz.md");
    host.settings.insert("uiLanguage".to_owned(), json!("en"));
    let english = host.dispatch("fanotes:create-note", &[json!("")]).unwrap();
    assert_eq!(english["relativePath"], "Untitled note.md");
    let marked = host
        .dispatch(
            "fanotes:create-note",
            &[json!("Mathe"), json!("\u{0085}Blatt")],
        )
        .unwrap();
    assert_eq!(marked["relativePath"], "Mathe/\u{0085}Blatt.md");
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!(""), json!("Blatt.txt")])
            .unwrap_err(),
        "Neue Notizen müssen Markdown-Dateien sein."
    );
    assert_eq!(
        host.dispatch("fanotes:create-folder", &[json!(1), json!("Physik")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert!(!vault.join("Physik").exists());
    assert!(!vault.join("New folder").exists());
    let numbered_note = host
        .dispatch("fanotes:create-note", &[json!(1), json!("Zahl")])
        .unwrap();
    assert_eq!(numbered_note["relativePath"], "Zahl.md");
    let null_note = host
        .dispatch("fanotes:create-note", &[json!(null), json!("Leer")])
        .unwrap();
    assert_eq!(null_note["relativePath"], "Leer.md");
    let null_folder = host
        .dispatch("fanotes:create-folder", &[json!(null), json!(null)])
        .unwrap();
    assert_eq!(null_folder["relativePath"], "New folder");
    let numbered_folder = host
        .dispatch("fanotes:create-folder", &[json!(""), json!(1)])
        .unwrap();
    assert_eq!(numbered_folder["relativePath"], "New folder 2");
    let omitted_folder = host.dispatch("fanotes:create-folder", &[]).unwrap();
    assert_eq!(omitted_folder["relativePath"], "New folder 3");
    let folder = host
        .dispatch("fanotes:create-folder", &[json!(""), json!("Ordner")])
        .unwrap();
    assert_eq!(folder["entry"]["kind"], "folder");
    let folder_again = host
        .dispatch("fanotes:create-folder", &[json!(""), json!("Ordner")])
        .unwrap();
    assert_eq!(folder_again["relativePath"], "Ordner 2");
    let saved = host
        .dispatch(
            "fanotes:write-recognition-model",
            &[json!("{\"version\":1}")],
        )
        .unwrap();
    assert!(saved["modifiedAt"].as_str().unwrap().contains('T'));
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap(),
        "{\"version\":1}"
    );
    std::fs::write(
        vault.join("Mathe/Seite.md"),
        "Hallo\n\n<!-- fanotes-famd:v1 chars=2 -->\n{}\n",
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "Hallo"
    );
    assert!(host
        .dispatch("fanotes:read-file", &[json!("Mathe/Seite.pdf")])
        .is_err());
}

#[test]
fn a_symlinked_note_cannot_leave_the_vault() {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    let outside = dir.join("outside");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), b"geheim\n").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), vault.join("Notiz.md")).unwrap();
    std::os::unix::fs::symlink(&outside, vault.join("weg")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Notiz.md")])
            .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!("Notiz.md"), json!("neu\n")])
            .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    assert_eq!(
        std::fs::read(outside.join("secret.md")).unwrap(),
        b"geheim\n"
    );
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("weg/Seite.md"), json!("raus\n")]
        )
        .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    assert!(!outside.join("Seite.md").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_saved_note_is_private_and_leaves_no_temporary_file() {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-atomic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    std::fs::write(vault.join("Seite.md"), b"\n").unwrap();
    host.set_vault(vault.clone()).unwrap();
    host.dispatch("fanotes:write-file", &[json!("Seite.md"), json!("Hallo")])
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.join("Seite.md")).unwrap(),
        "Hallo\n"
    );
    assert!(vault.join("Seite.famd").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["Seite.md", "Seite.famd"] {
            let mode = std::fs::metadata(vault.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{name}");
        }
    }
    let leftovers: Vec<_> = std::fs::read_dir(&vault)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn page_stats_keep_the_fields_the_editor_stores() {
    let dir = std::env::temp_dir().join(format!("fanotes-notes-stats-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(vault.join("Seite.md"), b"\n").unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    let stats = json!({
        "version": 1,
        "createdAt": "2026-01-02T03:04:05.000Z",
        "modifiedAt": "2026-01-02T03:04:05.000Z",
        "firstOpenedAt": "2026-01-02T03:04:05.000Z",
        "lastOpenedAt": "2026-01-02T03:05:05.000Z",
        "lastClosedAt": null,
        "lastSavedAt": "2026-01-02T03:06:05.000Z",
        "openCount": 2,
        "saveCount": 3,
        "dwellMs": 1500,
        "focusMs": 1200,
        "longestSessionMs": 800,
        "lastSessionMs": 400,
        "activeDays": ["2026-01-02"],
        "typing": { "wordsAdded": 4, "wordsRemoved": 1 }
    });
    let mut payload = fanotes_famd::empty_famd_payload("2026-01-02T03:04:05.000Z");
    payload.page_stats = Some(stats.clone());
    let content = fanotes_famd::serialize_famd("Hallo", &payload);
    host.dispatch("fanotes:write-file", &[json!("Seite.md"), json!(content)])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-page-stats", &[json!("Seite.md")])
            .unwrap(),
        stats
    );
    host.dispatch(
        "fanotes:write-file",
        &[json!("Seite.md"), json!("Hallo nochmal\n")],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-page-stats", &[json!("Seite.md")])
            .unwrap(),
        stats
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_pdf_note_keeps_history_of_its_famd_file() {
    let dir =
        std::env::temp_dir().join(format!("fanotes-notes-pdf-history-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Buch.famd"), json!("Erste Fassung\n")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Buch.famd"), json!("Zweite Fassung\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Buch.famd")])
        .unwrap();
    let snapshots = history.as_array().unwrap();
    assert_eq!(snapshots.len(), 1);
    let id = snapshots[0]["id"].as_str().unwrap();
    let loaded = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Buch.famd"), json!(id)],
        )
        .unwrap();
    assert!(loaded["content"]
        .as_str()
        .unwrap()
        .contains("Erste Fassung"));
    assert!(!loaded["content"]
        .as_str()
        .unwrap()
        .contains("Zweite Fassung"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_newer_capital_does_not_take_the_lowercase_note_name() {
    let (mut host, vault) = host();
    let capital = "\u{A7CE}.md";
    std::fs::write(vault.join(capital), b"bleibt\n").unwrap();
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!("\u{A7CF}")])
        .unwrap();
    assert_eq!(created["relativePath"], "\u{A7CF}.md");
    assert_eq!(std::fs::read(vault.join(capital)).unwrap(), b"bleibt\n");
    assert!(vault.join("\u{A7CF}.md").is_file());
}

#[test]
fn a_decomposed_umlaut_is_the_same_note_name() {
    let (mut host, vault) = host();
    let nfd_note = "Mu\u{0308}he.md";
    let nfd_ink = "Mu\u{0308}he.famd";
    std::fs::write(vault.join(nfd_note), b"bleibt\n").unwrap();
    std::fs::write(vault.join(nfd_ink), b"ink").unwrap();
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!("Mühe")])
        .unwrap();
    assert_eq!(created["relativePath"], "Mühe 2.md");
    assert_eq!(std::fs::read(vault.join(nfd_note)).unwrap(), b"bleibt\n");
    let names: Vec<_> = host
        .dispatch("fanotes:get-tree", &[])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.iter().any(|name| name == nfd_note));
    assert!(names.iter().all(|name| name != nfd_ink));
}

#[test]
fn a_new_entry_checks_the_parent_before_the_name() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Seite.md"), b"Hallo\n").unwrap();
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("Seite.md"), json!("CON")])
            .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:create-note",
            &[json!("Seite.md"), json!("Blatt.txt")],
        )
        .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch("fanotes:create-folder", &[json!("Seite.md"), json!("CON")])
            .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    let missing = std::fs::canonicalize(&vault).unwrap().join("Fehlt");
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("Fehlt"), json!("CON")])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("../x"), json!("CON")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!(""), json!("CON")])
            .unwrap_err(),
        "Dieser Name ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("Mathe"), json!("Blatt.txt")])
            .unwrap_err(),
        "Neue Notizen müssen Markdown-Dateien sein."
    );
    assert!(!vault.join("Fehlt").exists());
    assert!(vault.join("Seite.md").is_file());
    assert!(!vault.join("CON").exists());
}

#[test]
fn a_missing_folder_is_not_created_for_a_new_note() {
    let (mut host, vault) = host();
    let missing = std::fs::canonicalize(&vault).unwrap().join("Fehlt");
    let created = host
        .dispatch("fanotes:create-note", &[json!("Fehlt"), json!("Seite")])
        .unwrap_err();
    assert_eq!(
        created,
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    let written = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Fehlt/Seite.md"), json!("Hallo\n")],
        )
        .unwrap_err();
    assert_eq!(
        written,
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    let nested = std::fs::canonicalize(&vault).unwrap().join("Fehlt");
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("Fehlt/Innen/Seite.md"), json!("Hallo\n")],
        )
        .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            nested.display()
        )
    );
    assert!(!vault.join("Fehlt").exists());
}

#[test]
fn a_long_german_title_uses_character_length() {
    let (mut host, vault) = host();
    let title = "Ä".repeat(91);
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!(title)])
        .unwrap();
    assert_eq!(created["relativePath"], format!("{title}.md"));
    assert!(vault.join(format!("{title}.md")).is_file());
    let too_long = "Ä".repeat(181);
    let error = host
        .dispatch("fanotes:create-note", &[json!(""), json!(too_long)])
        .unwrap_err();
    assert!(error.contains("nicht erlaubt"));
    assert!(!vault.join(format!("{too_long}.md")).exists());
    let kept = format!("Notiz{}", '\u{0080}');
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!(kept)])
        .unwrap();
    assert_eq!(created["relativePath"], format!("{kept}.md"));
    let rejected = host
        .dispatch(
            "fanotes:create-note",
            &[json!(""), json!(format!("Notiz{}", '\u{007f}'))],
        )
        .unwrap_err();
    assert!(rejected.contains("nicht erlaubt"));
}

#[test]
fn a_history_index_with_an_invalid_byte_still_lists_its_snapshots() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let history_root = vault.join(".fanotes/history");
    let index = std::fs::read_dir(&history_root)
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path().join("index.json");
            path.is_file().then_some(path)
        })
        .unwrap();
    let mut bytes = std::fs::read(&index).unwrap();
    let marker = bytes
        .windows(6)
        .position(|window| window == b"Hallo\n" || window == br#""path""#)
        .unwrap();
    bytes.insert(marker + 1, 0xff);
    std::fs::write(&index, &bytes).unwrap();

    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    let id = history[0]["id"].as_str().unwrap();
    let snapshot = host
        .dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!(id)],
        )
        .unwrap();
    assert_eq!(snapshot["content"], "Hallo\n");
}

#[test]
fn history_uses_the_desktop_trim_for_a_blank_note() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    std::fs::write(vault.join("Mathe/Neben.md"), b"\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("\u{FEFF}")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert!(history.as_array().unwrap().is_empty());

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Neben.md"), json!("\u{0085}")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Neben.md"), json!("Hallo\n")],
    )
    .unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Neben.md")])
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
}

#[test]
fn listing_history_does_not_create_the_internal_folder() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    std::fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(history, json!([]));
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-history",
            &[json!("Mathe/Seite.md"), json!("missing-id")],
        )
        .unwrap_err(),
        "Dieser Verlaufseintrag existiert nicht mehr."
    );
    assert!(!vault.join(".fanotes").exists());
    assert!(!vault.join(".lernwerk").exists());
}

#[test]
fn recording_history_keeps_a_legacy_internal_folder() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    std::fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    std::fs::create_dir_all(vault.join(".lernwerk")).unwrap();
    std::fs::write(vault.join(".lernwerk/keep.txt"), b"alt").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Neu\n")],
    )
    .unwrap();
    assert!(vault.join(".lernwerk/keep.txt").is_file());
    assert!(!vault.join(".fanotes/keep.txt").exists());
    let history = host
        .dispatch("fanotes:list-note-history", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["bytes"], 6);
}

#[test]
fn a_history_index_uses_the_desktop_indentation() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Welt\n")],
    )
    .unwrap();
    let index = std::fs::read_dir(vault.join(".fanotes/history"))
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path().join("index.json");
            path.is_file().then_some(path)
        })
        .unwrap();
    let text = std::fs::read_to_string(index).unwrap();
    assert!(
        text.starts_with("{\n  \"format\": \"fanotes-history-v1\",\n  \"snapshots\": [\n"),
        "{text}"
    );
    assert!(text.contains("\n      \"id\": \""), "{text}");
    assert!(text.contains("\n      \"createdAt\": \""), "{text}");
    assert!(text.contains("\n      \"bytes\": 6\n"), "{text}");
    assert!(
        text.contains("\n  \"path\": \"Mathe/Seite.md\"\n}\n"),
        "{text}"
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_recognition_model_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    let path = vault.join(".fanotes/recognition-model.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"{\"version\":1}\n").unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(path.clone());
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"version\":1}\n");
}

#[cfg(unix)]
#[test]
fn an_unlistable_recognition_model_uses_the_desktop_lstat_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault) = host();
    let directory = vault.join(".fanotes");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("recognition-model.json");
    std::fs::write(&path, b"{\"version\":1}\n").unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(directory.clone());
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap_err(),
        format!(
            "EACCES: permission denied, lstat '{}'",
            canonical.display()
        )
    );
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"version\":1}\n");
}

#[test]
fn a_recognition_model_with_a_bad_byte_still_loads() {
    let (mut host, vault) = host();
    std::fs::create_dir_all(vault.join(".fanotes")).unwrap();
    let mut bytes = br#"{"version":1,"name":"X"}"#.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    std::fs::write(vault.join(".fanotes/recognition-model.json"), &bytes).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap(),
        json!("{\"version\":1,\"name\":\"\u{FFFD}\"}")
    );
}

#[test]
fn a_recognition_model_file_uses_the_desktop_checks() {
    let (mut host, vault) = host();
    let directory = vault.join(".fanotes");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("recognition-model.json");
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert_eq!(
        host.dispatch("fanotes:write-recognition-model", &[json!("{}")])
            .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert!(path.is_dir());
    std::fs::remove_dir(&path).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("elsewhere", &path).unwrap();
        assert_eq!(
            host.dispatch("fanotes:read-recognition-model", &[])
                .unwrap_err(),
            "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
        );
        std::fs::remove_file(&path).unwrap();
    }
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(20 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap_err(),
        "Die Datei ist zu groß."
    );
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap(),
        serde_json::Value::Null
    );
}

#[test]
fn reading_a_recognition_model_leaves_a_legacy_internal_folder() {
    let (mut host, vault) = host();
    std::fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    std::fs::create_dir_all(vault.join(".lernwerk")).unwrap();
    std::fs::write(vault.join(".lernwerk/keep.txt"), b"alt").unwrap();

    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap(),
        serde_json::Value::Null
    );
    assert!(!vault.join(".fanotes").exists());
    assert_eq!(
        std::fs::read(vault.join(".lernwerk/keep.txt")).unwrap(),
        b"alt"
    );

    host.dispatch("fanotes:write-recognition-model", &[json!("{}")])
        .unwrap();
    assert_eq!(
        std::fs::read(vault.join(".fanotes/recognition-model.json")).unwrap(),
        b"{}"
    );
    assert_eq!(
        std::fs::read(vault.join(".lernwerk/keep.txt")).unwrap(),
        b"alt"
    );

    std::fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    std::fs::write(vault.join(".fanotes"), b"datei").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-recognition-model", &[])
            .unwrap_err(),
        "Ein Pfadbestandteil ist kein Ordner."
    );
    assert_eq!(
        host.dispatch("fanotes:write-recognition-model", &[json!("{}")])
            .unwrap_err(),
        "Ein Pfadbestandteil ist kein Ordner."
    );
    assert_eq!(std::fs::read(vault.join(".fanotes")).unwrap(), b"datei");

    #[cfg(unix)]
    {
        std::fs::remove_file(vault.join(".fanotes")).unwrap();
        std::os::unix::fs::symlink("elsewhere", vault.join(".fanotes")).unwrap();
        assert_eq!(
            host.dispatch("fanotes:read-recognition-model", &[])
                .unwrap_err(),
            "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
        );
        assert_eq!(
            host.dispatch("fanotes:write-recognition-model", &[json!("{}")],)
                .unwrap_err(),
            "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
        );
        assert!(vault
            .join(".fanotes")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
    }
}

#[test]
fn a_subject_book_with_a_bad_byte_stays_in_the_list() {
    let (mut host, vault) = host();
    std::fs::create_dir_all(vault.join(".fanotes")).unwrap();
    let mut bytes = br#"{"version":1,"books":[{"subjectPath":"MaXthe","bookPath":"Mathe/Buch.pdf","lastPage":4}]}"#.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    std::fs::write(vault.join(".fanotes/subject-books.json"), &bytes).unwrap();

    let books = host.dispatch("fanotes:read-subject-books", &[]).unwrap();
    assert_eq!(books.as_array().unwrap().len(), 1);
    assert_eq!(books[0]["subjectPath"], "Ma\u{FFFD}the");
    assert_eq!(books[0]["bookPath"], "Mathe/Buch.pdf");
    assert_eq!(books[0]["lastPage"], 4);

    std::fs::write(vault.join(".fanotes/subject-books.json"), b"{\xff").unwrap();
    let books = host.dispatch("fanotes:read-subject-books", &[]).unwrap();
    assert!(books.as_array().unwrap().is_empty());
}

#[test]
fn a_note_link_trims_a_byte_order_mark_and_keeps_a_next_line() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();
    let links = host
        .dispatch(
            "fanotes:write-note-links",
            &[
                json!("Mathe/Seite.md"),
                json!([
                    {
                        "id": "nl-feff",
                        "sourcePath": "anders.md",
                        "targetPath": "\u{FEFF}Physik/Kraft.md",
                        "label": "A\u{FEFF}B\u{0085}C  "
                    },
                    {
                        "id": "nl-next",
                        "sourcePath": "anders.md",
                        "targetPath": "\u{0085}Physik/Andere.md",
                        "label": "\u{0085}"
                    },
                    {
                        "id": "nl-blank",
                        "sourcePath": "anders.md",
                        "targetPath": "Ordner/Ziel.md",
                        "label": "\u{FEFF}"
                    },
                    {
                        "id": "nl-tail",
                        "sourcePath": "anders.md",
                        "targetPath": "Ziel.md\u{0085}"
                    }
                ]),
            ],
        )
        .unwrap();
    assert_eq!(links.as_array().unwrap().len(), 3);
    assert_eq!(links[0]["targetPath"], "Physik/Kraft.md");
    assert_eq!(links[0]["label"], "A B\u{0085}C");
    assert_eq!(links[1]["targetPath"], "\u{0085}Physik/Andere.md");
    assert_eq!(links[1]["label"], "\u{0085}");
    assert_eq!(links[2]["targetPath"], "Ordner/Ziel.md");
    assert_eq!(links[2]["label"], "Ziel");
    let stored = host
        .dispatch("fanotes:read-note-links", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(stored, links);
}

#[test]
fn a_rewritten_link_source_is_returned_before_the_file_check() {
    let (mut host, vault) = host();
    std::fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    let links = host
        .dispatch(
            "fanotes:write-note-links",
            &[
                json!("Mathe/Seite.md"),
                json!([{
                    "id": "self",
                    "sourcePath": "anders.md",
                    "targetPath": "Mathe/Seite.md"
                }]),
            ],
        )
        .unwrap();
    assert_eq!(links.as_array().unwrap().len(), 1);
    assert_eq!(links[0]["sourcePath"], "Mathe/Seite.md");
    assert_eq!(links[0]["targetPath"], "Mathe/Seite.md");
    assert_eq!(links[0]["label"], "Seite");
    let stored = host
        .dispatch("fanotes:read-note-links", &[json!("Mathe/Seite.md")])
        .unwrap();
    assert_eq!(stored, json!([]));

    let segment = "a".repeat(200);
    let relative = format!("{segment}/{segment}/{segment}/Seite.md");
    assert!(relative.encode_utf16().count() > 500);
    let folder = vault.join(&segment).join(&segment).join(&segment);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("Seite.md"), b"Hallo\n").unwrap();
    let backups = host
        .dispatch(
            "fanotes:write-note-backups",
            &[
                json!(relative),
                json!([{ "id": "nb-long", "notePath": "anders.md", "content": "alt" }]),
            ],
        )
        .unwrap();
    assert_eq!(backups.as_array().unwrap().len(), 1);
    assert_eq!(backups[0]["notePath"], relative);
    assert_eq!(backups[0]["content"], "alt");
    let stored_backups = host
        .dispatch("fanotes:read-note-backups", &[json!(relative)])
        .unwrap();
    assert_eq!(stored_backups, json!([]));
}

#[test]
fn a_dotfile_with_one_dot_is_not_a_note() {
    let (mut host, vault) = host();
    let error = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Mathe/.md"), json!("Hallo\n")],
        )
        .unwrap_err();
    assert!(error.contains("Markdown"), "{error}");
    assert!(!vault.join("Mathe/.md").exists());
    std::fs::write(vault.join("Mathe/.hidden.md"), b"\n").unwrap();

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/.hidden.md"), json!("Geheim\n")],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Mathe/.hidden.md")])
            .unwrap(),
        "Geheim"
    );

    let ink = host
        .dispatch("fanotes:read-famd-ink", &[json!("Mathe/.pdf")])
        .unwrap_err();
    assert!(ink.contains("PDF-Notizen"), "{ink}");
}

#[test]
fn a_famd_save_does_not_create_a_missing_folder() {
    let (mut host, vault) = host();
    let missing = std::fs::canonicalize(&vault).unwrap().join("Neu");
    let error = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Neu/Seite.famd"), json!("Hallo\n")],
        )
        .unwrap_err();
    assert_eq!(
        error,
        format!(
            "ENOENT: no such file or directory, realpath '{}'",
            missing.display()
        )
    );
    let nested = std::fs::canonicalize(&vault)
        .unwrap()
        .join("Neu")
        .join("Innen");
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("Neu/Innen/Seite.famd"), json!("Hallo\n")],
        )
        .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, realpath '{}'",
            nested.display()
        )
    );
    assert!(!vault.join("Neu").exists());

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.famd"), json!("Hallo\n")],
    )
    .unwrap();
    assert!(vault.join("Mathe/Seite.famd").is_file());
    assert!(!vault.join("Neu").exists());
}

#[test]
fn a_companion_save_does_not_create_a_missing_folder() {
    let (mut host, vault) = host();
    let link = json!([{
        "id": "link-a",
        "targetPath": "Physik/Kraft.md",
        "page": 1,
        "x": 0.2,
        "y": 0.3
    }]);
    for (channel, args) in [
        (
            "fanotes:set-note-paper-style",
            json!(["Neu/Seite.md", "lines"]),
        ),
        ("fanotes:write-note-links", json!(["Neu/Seite.md", link])),
        (
            "fanotes:write-note-backups",
            json!(["Neu/Seite.md", [{ "content": "alt" }]]),
        ),
    ] {
        let error = host
            .dispatch(channel, args.as_array().unwrap())
            .unwrap_err();
        assert!(
            error.starts_with("ENOENT: no such file or directory, open '"),
            "{channel}: {error}"
        );
        assert!(error.contains("/Neu/.Seite.famd."), "{channel}: {error}");
        assert!(error.ends_with(".tmp'"), "{channel}: {error}");
    }
    assert!(!vault.join("Neu").exists());

    host.dispatch(
        "fanotes:set-note-paper-style",
        &[json!("Mathe/Seite.md"), json!("lines")],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Seite.md")])
            .unwrap(),
        "lines"
    );
    assert!(vault.join("Mathe/Seite.famd").is_file());
    assert!(!vault.join("Neu").exists());
}

#[cfg(unix)]
#[test]
fn an_unwritable_note_folder_uses_a_twenty_hex_temporary_name() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, _) = host();
    let vault = host.vault.clone().unwrap();
    let folder = vault.join("Mathe");
    let note = folder.join("Seite.md");
    std::fs::write(&note, b"Hallo\n").unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(folder.clone());
    let error = host
        .dispatch(
            "fanotes:write-file",
            &[json!("Mathe/Seite.md"), json!("Welt\n")],
        )
        .unwrap_err();
    let prefix = format!(
        "EACCES: permission denied, open '{}/.Seite.md.{}.",
        folder.display(),
        std::process::id()
    );
    assert!(error.starts_with(&prefix), "{error}");
    let suffix = error[prefix.len()..].trim_end_matches(".tmp'");
    assert_eq!(suffix.len(), 20, "{error}");
    assert!(
        suffix.chars().all(|character| character.is_ascii_hexdigit()),
        "{error}"
    );
    assert!(error.ends_with(".tmp'"), "{error}");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(std::fs::read(&note).unwrap(), b"Hallo\n");
}

#[cfg(unix)]
#[test]
fn an_unwritable_folder_reports_the_desktop_create_errors() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, _) = host();
    let folder = host.vault.clone().unwrap().join("Mathe");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(folder.clone());
    let note = folder.join("Seite.md");
    let created = folder.join("Neu");
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("Mathe"), json!("Seite")])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", note.display())
    );
    assert_eq!(
        host.dispatch("fanotes:create-folder", &[json!("Mathe"), json!("Neu")])
            .unwrap_err(),
        format!("EACCES: permission denied, mkdir '{}'", created.display())
    );
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!note.exists());
    assert!(!created.exists());
}
