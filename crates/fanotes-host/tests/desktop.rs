use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> (std::path::PathBuf, std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-desktop-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    host.open_log = Some(dir.join("opened.log"));
    (dir, vault, host)
}

#[test]
fn a_file_in_a_reveal_path_is_not_a_folder() {
    let (dir, vault, mut host) = host();
    fs::write(vault.join("Seite.md"), b"Notiz\n").unwrap();
    fs::create_dir(vault.join("Mathe")).unwrap();
    fs::write(vault.join("Mathe/Kraft.md"), b"Kraft\n").unwrap();
    assert_eq!(
        host.dispatch("fanotes:reveal-in-folder", &[json!("Seite.md/innen")])
            .unwrap_err(),
        "Ein Pfadbestandteil ist kein Ordner."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:reveal-in-folder",
            &[json!("Seite.md/innen/noch")],
        )
        .unwrap_err(),
        "Ein Pfadbestandteil ist kein Ordner."
    );
    let missing = fs::canonicalize(&vault).unwrap().join("Fehlt");
    assert_eq!(
        host.dispatch("fanotes:reveal-in-folder", &[json!("Fehlt")])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    host.dispatch("fanotes:reveal-in-folder", &[json!("Seite.md")])
        .unwrap();
    host.dispatch("fanotes:reveal-in-folder", &[json!("Mathe/Kraft.md")])
        .unwrap();
    host.dispatch("fanotes:reveal-in-folder", &[json!(".fanotes")])
        .unwrap();
    let log = fs::read_to_string(dir.join("opened.log")).unwrap();
    assert!(log.contains(&format!("reveal {}", vault.join("Seite.md").display())));
    assert!(log.contains(&format!(
        "reveal {}",
        vault.join("Mathe/Kraft.md").display()
    )));
    assert!(log.contains(&format!(
        "reveal {}",
        vault.join(".fanotes").display()
    )));
}

#[test]
fn links_open_and_notes_are_revealed_without_leaving_the_vault() {
    let (dir, vault, mut host) = host();
    fs::write(vault.join("Seite.md"), b"Notiz\n").unwrap();
    fs::write(vault.join("gross.md"), b"riesig\n").unwrap();
    let huge = fs::OpenOptions::new()
        .write(true)
        .open(vault.join("gross.md"))
        .unwrap();
    huge.set_len(16 * 1024 * 1024 + 1).unwrap();

    assert_eq!(
        host.dispatch("fanotes:open-external", &[json!("ftp://example.com")])
            .unwrap_err(),
        "Nur sichere HTTP(S)-Links ohne Zugangsdaten sind erlaubt."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:open-external",
            &[json!("https://user:pass@example.com/card")],
        )
        .unwrap_err(),
        "Nur sichere HTTP(S)-Links ohne Zugangsdaten sind erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:open-external", &[json!("not a link")])
            .unwrap_err(),
        "Ungültiger externer Link."
    );
    host.dispatch(
        "fanotes:open-external",
        &[json!("https://example.com/card")],
    )
    .unwrap();
    host.dispatch(
        "fanotes:open-external",
        &[json!("https://:@example.com/card")],
    )
    .unwrap();
    assert_eq!(
        host.dispatch(
            "fanotes:open-external",
            &[json!("https://user:@example.com/card")],
        )
        .unwrap_err(),
        "Nur sichere HTTP(S)-Links ohne Zugangsdaten sind erlaubt."
    );
    host.dispatch("fanotes:open-external", &[json!("https://EXAMPLE.COM/a b")])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:open-external", &[json!("https://example.com%00")])
            .unwrap_err(),
        "Ungültiger externer Link."
    );
    host.dispatch("fanotes:reveal-in-folder", &[json!("Seite.md")])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:reveal-in-folder", &[json!("../secret.md")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );

    let log = fs::read_to_string(dir.join("opened.log")).unwrap();
    assert!(log.contains("open https://example.com/card"));
    assert!(!log.contains(":@"));
    assert!(log.contains("open https://example.com/a%20b"));
    assert!(log.contains(&format!("reveal {}", vault.join("Seite.md").display())));

    let hits = host.dispatch("fanotes:search", &[json!("riesig")]).unwrap();
    assert!(hits.as_array().unwrap().is_empty());
    fs::write(vault.join("klein.md"), b"riesig\n").unwrap();
    let hits = host.dispatch("fanotes:search", &[json!("riesig")]).unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["relativePath"], "klein.md");
}

#[test]
fn a_non_string_argument_uses_the_desktop_message() {
    let (_dir, vault, mut host) = host();
    fs::write(vault.join("Seite.md"), b"Hallo\n").unwrap();
    fs::create_dir(vault.join("Ordner")).unwrap();
    fs::write(vault.join("Ordner").join("Innen.md"), b"Innen\n").unwrap();

    assert_eq!(
        host.dispatch("fanotes:search", &[json!(1)]).unwrap_err(),
        "Ungültige Suchanfrage."
    );
    assert_eq!(
        host.dispatch("fanotes:read-drawing", &[json!(1)]).unwrap_err(),
        "Ungültige Zeichnungs-ID."
    );
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!(false)])
            .unwrap_err(),
        "Ungültige Arbeitsblatt-ID."
    );
    assert_eq!(
        host.dispatch("fanotes:delete-worksheet", &[json!(1)])
            .unwrap_err(),
        "Ungültige Arbeitsblatt-ID."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!(1)]).unwrap_err(),
        "Ungültiger Markdown-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!(1), json!("Text")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!("Bild.png"), json!(1)])
            .unwrap_err(),
        "Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!("Seite.md"), json!(1)])
            .unwrap_err(),
        "Der Notizinhalt ist ungültig oder zu groß."
    );
    assert_eq!(fs::read(vault.join("Seite.md")).unwrap(), b"Hallo\n");
    assert_eq!(
        host.dispatch("fanotes:write-recognition-model", &[json!(1)])
            .unwrap_err(),
        "Das Handschriftmodell ist ungültig oder zu groß."
    );
    for channel in [
        "fanotes:read-famd-ink",
        "fanotes:read-note-page-stats",
        "fanotes:read-note-paper-style",
        "fanotes:read-note-links",
        "fanotes:write-note-links",
        "fanotes:read-note-backups",
        "fanotes:write-note-backups",
    ] {
        assert_eq!(
            host.dispatch(channel, &[json!(1)]).unwrap_err(),
            "Ungültiger Notizpfad.",
            "{channel}"
        );
    }
    assert_eq!(
        host.dispatch(
            "fanotes:set-note-paper-style",
            &[json!(1), json!("kein-papier")],
        )
        .unwrap_err(),
        "Diese Papierart wird nicht unterstützt."
    );
    assert_eq!(
        host.dispatch("fanotes:set-note-paper-style", &[json!(1), json!("dots")])
            .unwrap_err(),
        "Ungültiger Notizpfad."
    );
    assert_eq!(
        host.dispatch("fanotes:set-note-paper-style", &[json!("Seite.md"), json!(1)])
            .unwrap_err(),
        "Diese Papierart wird nicht unterstützt."
    );
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!(1), json!("#112233")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:rename-entry", &[json!(1), json!("Neu.md")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:rename-entry", &[json!("Seite.md"), json!(1)])
            .unwrap(),
        json!("Seite.md")
    );
    assert!(vault.join("Seite.md").is_file());
    assert_eq!(
        host.dispatch("fanotes:move-entry", &[json!(1), json!("Ordner")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:move-entry", &[json!("Ordner/Innen.md"), json!(false)])
            .unwrap(),
        json!("Innen.md")
    );
    assert!(vault.join("Innen.md").is_file());
    assert_eq!(
        host.dispatch("fanotes:trash-entry", &[json!(1)]).unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:reveal-in-folder", &[json!(false)])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:open-subject-book-popout", &[json!(1)])
            .unwrap_err(),
        "Ungültiger Buchpfad."
    );
    assert_eq!(
        host.dispatch("fanotes:list-note-history", &[json!(1)])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-history", &[json!(1), json!("abc")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-history", &[json!("../Seite.md"), json!(" ")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-history", &[json!("Seite.txt"), json!(1)])
            .unwrap_err(),
        "Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-history", &[json!("Seite.md"), json!(1)])
            .unwrap_err(),
        "Dieser Verlaufseintrag existiert nicht mehr."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-history", &[json!("Seite.md"), json!({})])
            .unwrap_err(),
        "Ungültiger Verlaufseintrag."
    );
    assert_eq!(
        host.dispatch("fanotes:read-note-history", &[json!("Seite.md")])
            .unwrap_err(),
        "Dieser Verlaufseintrag existiert nicht mehr."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-data-url", &[json!(1)])
            .unwrap_err(),
        "Ungültiger Bildpfad."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!(false)])
            .unwrap_err(),
        "Ungültiger Dateipfad."
    );
    assert_eq!(
        host.dispatch("fanotes:open-external", &[json!(1)]).unwrap_err(),
        "Ungültiger externer Link."
    );
}

#[test]
fn a_non_string_addon_or_sync_argument_uses_the_desktop_message() {
    let (_dir, vault, mut host) = host();
    assert_eq!(
        host.dispatch("fanotes:addons-remove", &[json!(1)])
            .unwrap_err(),
        "Ungültige Add-on-ID."
    );
    assert_eq!(
        host.dispatch("fanotes:addons-read-data", &[json!(false)])
            .unwrap_err(),
        "Ungültige Add-on-ID."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:addons-read-file",
            &[json!("Not An Id"), json!(1)],
        )
        .unwrap_err(),
        "Ungültige Add-on-ID."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:addons-read-file",
            &[json!("margin-notes"), json!(1)],
        )
        .unwrap_err(),
        "Ungültiger Dateiname."
    );
    assert_eq!(
        host.dispatch("fanotes:addons-write-files", &[json!(1), json!({})])
            .unwrap_err(),
        "Ungültige Add-on-ID."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:addons-write-files",
            &[json!("margin-notes"), json!(1)],
        )
        .unwrap_err(),
        "Keine Dateien übergeben."
    );
    assert_eq!(
        host.dispatch("fanotes:addons-write-data", &[json!(1), json!(1)])
            .unwrap_err(),
        "Add-on-Daten müssen ein String sein."
    );
    assert_eq!(
        host.dispatch("fanotes:addons-write-data", &[json!(1), json!("{\"ok\":1}")])
            .unwrap_err(),
        "Ungültige Add-on-ID."
    );
    assert_eq!(
        host.dispatch("fanotes:addons-fetch", &[json!(1)]).unwrap_err(),
        "Ungültige Add-on-Adresse."
    );
    assert_eq!(
        host.dispatch("fanotes:addons-net-fetch", &[json!(1)])
            .unwrap_err(),
        "Ungültige URL."
    );
    assert_eq!(
        host.dispatch("fanotes:sync-read", &[json!(1)]).unwrap_err(),
        "Ungültiger Sync-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:sync-remove", &[json!(false)])
            .unwrap_err(),
        "Ungültiger Sync-Pfad."
    );
    assert_eq!(
        host.dispatch("fanotes:sync-write", &[json!(1), json!(1)])
            .unwrap_err(),
        "Der Sync-Inhalt muss binär sein."
    );
    let before: Vec<_> = fs::read_dir(&vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        host.dispatch("fanotes:sync-write", &[json!(1), json!("aGVsbG8=")])
            .unwrap_err(),
        "Ungültiger Sync-Pfad."
    );
    let after: Vec<_> = fs::read_dir(&vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(before, after);
    assert_eq!(
        host.dispatch("fanotes:lm-studio-list-models", &[json!(1)])
            .unwrap_err(),
        "Die LM-Studio-Adresse ist ungültig."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:lm-studio-list-models",
            &[json!("not a url"), json!(1)],
        )
        .unwrap_err(),
        "Gib eine vollständige LM-Studio-Adresse wie http://127.0.0.1:1234 ein."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:lm-studio-list-models",
            &[json!("http://127.0.0.1:1234"), json!(1)],
        )
        .unwrap_err(),
        "Das LM-Studio-API-Token ist ungültig."
    );
}
