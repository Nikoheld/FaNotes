use std::fs::{self, File};
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn scratch() -> std::path::PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-startup-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_missing_vault_starts_in_documents_with_a_welcome_note() {
    let dir = scratch();
    let mut host = Host::open(dir.join("app"));
    host.documents_dir = Some(dir.join("docs"));
    host.settings.insert("uiLanguage".to_owned(), json!("de"));
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    let vault = dir.join("docs").join("FaNotes");
    assert_eq!(boot["vaultPath"], vault.to_string_lossy().as_ref());
    assert_eq!(boot["onboardingRequired"], true);
    let welcome = fs::read_to_string(vault.join("Willkommen.md")).unwrap();
    assert!(welcome.starts_with("# Willkommen bei FaNotes\n"));
    assert!(welcome.contains("Viel Freude beim Festhalten deiner Gedanken!\n"));
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Willkommen.md")])
            .unwrap_err(),
        "Bitte schließe zuerst die FaNotes-Ersteinrichtung ab."
    );
    let again = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(again["vaultPath"], boot["vaultPath"]);

    let mut restored = Host::open(dir.join("app"));
    restored.documents_dir = Some(dir.join("elsewhere"));
    let restored_boot = restored.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(restored_boot["vaultPath"], boot["vaultPath"]);
    assert_eq!(restored_boot["onboardingRequired"], true);
}

#[test]
fn an_existing_documents_folder_is_reused() {
    let dir = scratch();
    let vault = dir.join("docs").join("FaNotes");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("Notiz.md"), b"Hallo\n").unwrap();
    let mut host = Host::open(dir.join("app"));
    host.documents_dir = Some(dir.join("docs"));
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["onboardingRequired"], false);
    assert!(!vault.join("Willkommen.md").exists());
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Notiz.md")])
            .unwrap(),
        "Hallo"
    );
}

#[test]
fn an_oversized_note_is_rejected() {
    let dir = scratch();
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    let huge = vault.join("gross.md");
    let file = File::create(&huge).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("gross.md")])
            .unwrap_err(),
        "Der Notizinhalt ist ungültig oder zu groß."
    );
    let oversized = "x".repeat(16 * 1024 * 1024 + 1);
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!("klein.md"), json!(oversized)])
            .unwrap_err(),
        "Der Notizinhalt ist ungültig oder zu groß."
    );
    assert!(!vault.join("klein.md").exists());
}

#[test]
fn an_untouched_welcome_note_is_refreshed() {
    let dir = scratch();
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let legacy = r#"# Willkommen bei FaNotes

Deine Notizen liegen als normale Markdown-Dateien in diesem Ordner. Du kannst sie jederzeit auch mit anderen Editoren öffnen.

## Schnellstart

- Wähle links einen Bereich oder erstelle einen eigenen Ordner.
- Schreibe mit Tastatur oder Grafiktablett direkt auf derselben Notizseite.
- Importiere Bilder oder PDFs als Arbeitsblätter und fülle sie mit Textfeldern oder dem Stift aus.
- Konvertierte Mathematik wird als LaTeX gespeichert und sauber gesetzt dargestellt.
- Mit `[[Notizname]]` kannst du später Wissensseiten miteinander verbinden.

Viel Freude beim Lernen!
"#;
    fs::write(vault.join("Willkommen.md"), legacy).unwrap();
    fs::write(
        vault.join("Welcome.md"),
        "Mine.\nPress `Ctrl+Z` to restore something you erased by accident.\n",
    )
    .unwrap();
    fs::write(vault.join("Eigene.md"), "Nicht anfassen.\n").unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    let welcome = fs::read_to_string(vault.join("Willkommen.md")).unwrap();
    assert!(welcome.contains("## Kleine Handschrift-Übung"));
    assert!(welcome.contains("**Strg+Z**"));
    assert!(!welcome.contains("`Strg+Z`"));
    let english = fs::read_to_string(vault.join("Welcome.md")).unwrap();
    assert!(english.starts_with("Mine.\n"));
    assert!(english.contains("Press **Ctrl+Z** to restore something you erased by accident."));
    assert!(!english.contains("`Ctrl+Z`"));
    assert_eq!(
        fs::read_to_string(vault.join("Eigene.md")).unwrap(),
        "Nicht anfassen.\n"
    );

    let linked = dir.join("linked");
    fs::create_dir_all(&linked).unwrap();
    fs::write(dir.join("target.md"), legacy).unwrap();
    std::os::unix::fs::symlink(dir.join("target.md"), linked.join("Willkommen.md")).unwrap();
    host.set_vault(linked).unwrap();
    assert_eq!(fs::read_to_string(dir.join("target.md")).unwrap(), legacy);
}
