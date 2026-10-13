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
fn a_new_profile_and_its_tree_cache_are_private_directories() {
    let dir = scratch();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&app).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("Seite.md"), b"# Seite\n").unwrap();
    host.set_vault(vault).unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(app.join("tree-cache-v1"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
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

#[cfg(unix)]
#[test]
fn an_unwritable_documents_folder_reports_the_desktop_vault_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch();
    let docs = dir.join("docs");
    fs::create_dir(&docs).unwrap();
    fs::set_permissions(&docs, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(docs.clone());
    let mut host = Host::open(dir.join("app"));
    host.documents_dir = Some(docs.clone());
    let vault = docs.join("FaNotes");
    assert_eq!(
        host.dispatch("fanotes:bootstrap", &[]).unwrap_err(),
        format!("EACCES: permission denied, mkdir '{}'", vault.display())
    );
    assert!(!vault.exists());

    fs::set_permissions(&docs, fs::Permissions::from_mode(0o000)).unwrap();
    let mut hidden = Host::open(dir.join("hidden-app"));
    hidden.documents_dir = Some(docs.clone());
    assert_eq!(
        hidden.dispatch("fanotes:bootstrap", &[]).unwrap_err(),
        format!("EACCES: permission denied, lstat '{}'", vault.display())
    );

    fs::set_permissions(&docs, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir(&docs).unwrap();
    fs::write(&docs, b"datei").unwrap();
    let mut file_host = Host::open(dir.join("file-app"));
    file_host.documents_dir = Some(docs.clone());
    assert_eq!(
        file_host.dispatch("fanotes:bootstrap", &[]).unwrap_err(),
        format!("ENOTDIR: not a directory, lstat '{}'", vault.display())
    );
    assert_eq!(fs::read(&docs).unwrap(), b"datei");
}

#[cfg(unix)]
#[test]
fn a_read_only_vault_is_refused_like_the_desktop() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch();
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(self.0.parent().unwrap_or(&self.0));
        }
    }
    let _restore = Restore(vault.clone());
    let mut host = Host::open(dir.join("app"));
    let canonical = fs::canonicalize(&vault).unwrap();
    let error = host
        .dispatch(
            "fanotes:select-vault",
            &[json!(canonical.to_string_lossy())],
        )
        .unwrap_err();
    assert_eq!(
        error,
        format!(
            "EACCES: permission denied, access '{}'",
            canonical.display()
        )
    );
    assert!(host.vault.is_none());
}

#[cfg(unix)]
#[test]
fn a_remembered_read_only_vault_refuses_the_note_tree() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch();
    let app = dir.join("app");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("Seite.md"), b"# Seite\n").unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(self.0.parent().unwrap_or(&self.0));
        }
    }
    let _restore = Restore(vault.clone());
    let canonical = fs::canonicalize(&vault).unwrap();
    let mut host = Host::open(app.clone());
    host.dispatch(
        "fanotes:select-vault",
        &[json!(canonical.to_string_lossy())],
    )
    .unwrap();
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o555)).unwrap();

    let mut reopened = Host::open(app);
    let boot = reopened.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["vaultPath"], canonical.to_string_lossy().as_ref());
    assert!(reopened.vault.is_some());
    let expected = format!(
        "EACCES: permission denied, access '{}'",
        canonical.display()
    );
    assert_eq!(
        reopened.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        expected
    );
    assert_eq!(
        reopened.dispatch("fanotes:get-fast-tree", &[]).unwrap_err(),
        expected
    );
    assert_eq!(
        reopened
            .dispatch("fanotes:read-file", &[json!("nope.txt")])
            .unwrap_err(),
        expected
    );
    assert!(reopened.vault.is_some());
    assert!(reopened.dispatch("fanotes:get-cached-tree", &[]).is_ok());
    assert!(reopened.dispatch("fanotes:sync-scan", &[]).is_ok());
    assert_eq!(
        reopened
            .dispatch("fanotes:write-file", &[json!("Seite.md"), json!(1)])
            .unwrap_err(),
        "Der Notizinhalt ist ungültig oder zu groß."
    );
    assert_eq!(
        reopened
            .dispatch(
                "fanotes:write-file",
                &[json!("Seite.md"), json!("# Seite\n")],
            )
            .unwrap_err(),
        expected
    );
    assert_eq!(
        reopened
            .dispatch("fanotes:complete-onboarding", &[json!(1)])
            .unwrap_err(),
        "Die Ordnerauswahl ist ungültig."
    );
}

#[test]
fn a_missing_configured_vault_is_not_replaced() {
    let dir = scratch();
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    let missing = dir.join("nas").join("Notizen");
    fs::write(app.join("vault-path"), format!("{}\n", missing.display())).unwrap();
    let mut host = Host::open(app.clone());
    host.documents_dir = Some(dir.join("docs"));
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["vaultPath"], missing.to_string_lossy().as_ref());
    assert!(host.vault.is_none());
    assert!(!dir.join("docs").join("FaNotes").exists());
    assert_eq!(
        fs::read_to_string(app.join("vault-path")).unwrap().trim(),
        missing.to_string_lossy()
    );
    assert_eq!(
        host.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        "Der gewählte Vault ist kein sicherer Ordner."
    );
    assert!(!missing.exists());

    fs::create_dir_all(&missing).unwrap();
    fs::write(missing.join("Seite.md"), b"# Seite\n").unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert!(tree
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "Seite.md"));
    assert_eq!(
        host.vault.as_deref(),
        Some(fs::canonicalize(&missing).unwrap().as_path())
    );
    assert_eq!(
        fs::read_to_string(app.join("vault-path")).unwrap().trim(),
        missing.to_string_lossy()
    );
}

#[test]
fn a_vault_path_keeps_a_trailing_space_in_the_folder_name() {
    let dir = scratch();
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    let plain = dir.join("Notizen");
    let spaced = dir.join("Notizen ");
    fs::create_dir_all(&plain).unwrap();
    fs::create_dir_all(&spaced).unwrap();
    fs::write(plain.join("Falsch.md"), b"# Falsch\n").unwrap();
    fs::write(spaced.join("Seite.md"), b"# Seite\n").unwrap();
    fs::write(
        app.join("vault-path"),
        format!("{}\n", spaced.display()),
    )
    .unwrap();
    let mut host = Host::open(app);
    host.documents_dir = Some(dir.join("docs"));
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    let canonical = fs::canonicalize(&spaced).unwrap();
    assert_eq!(boot["vaultPath"], canonical.to_string_lossy().as_ref());
    assert_eq!(boot["vaultName"], "Notizen ");
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let names: Vec<&str> = tree
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .collect();
    assert!(names.contains(&"Seite.md"));
    assert!(!names.contains(&"Falsch.md"));
    assert!(!dir.join("docs").join("FaNotes").exists());
}

#[test]
fn a_missing_vault_path_resolves_before_the_cache_lookup() {
    let dir = scratch();
    let app = dir.join("app");
    let vault = dir.join("notes");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("Seite.md"), b"# Seite\n").unwrap();
    let mut host = Host::open(app.clone());
    host.set_vault(vault.clone()).unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    drop(host);
    fs::remove_dir_all(&vault).unwrap();
    let spelled = dir.join("other").join("..").join("notes");
    fs::write(
        app.join("vault-path"),
        format!("{}/\n", spelled.display()),
    )
    .unwrap();
    let mut host = Host::open(app);
    host.documents_dir = Some(dir.join("docs"));
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["vaultPath"], vault.to_string_lossy().as_ref());
    assert_eq!(boot["vaultName"], "notes");
    assert!(!dir.join("docs").join("FaNotes").exists());
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert!(cached
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "Seite.md"));
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
        "Die Datei ist zu groß."
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

#[test]
fn a_welcome_note_with_a_bad_byte_still_receives_the_shortcut_fix() {
    let dir = scratch();
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut bytes = "Notiz X\nMit `Strg+Z` holst du eine versehentliche Löschung sofort zurück.\n"
        .as_bytes()
        .to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(vault.join("Willkommen.md"), &bytes).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    let welcome = fs::read_to_string(vault.join("Willkommen.md")).unwrap();
    assert!(welcome.contains("**Strg+Z**"));
    assert!(!welcome.contains("`Strg+Z`"));
    assert!(welcome.contains('\u{FFFD}'));
}

#[test]
fn a_profile_path_drops_a_missing_parent_segment_before_creating_folders() {
    let dir = scratch();
    let config_home = dir.join("config");
    let legacy = config_home.join("Lernwerk Notes");
    let vault = dir.join("vault");
    fs::create_dir_all(&legacy).unwrap();
    fs::create_dir_all(&vault).unwrap();
    fs::write(
        legacy.join("config.json"),
        serde_json::to_string(&json!({
            "version": 2,
            "vaultPath": vault,
            "settings": { "theme": "midnight" }
        }))
        .unwrap(),
    )
    .unwrap();
    let spelled = config_home.join("missing").join("..").join("FaNotes");
    let mut host = Host::open(spelled);
    assert!(!config_home.join("missing").exists());
    assert!(config_home.join("FaNotes").is_dir());
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["vaultPath"], vault.to_string_lossy().as_ref());
    assert_eq!(boot["settings"]["theme"], "midnight");
}

#[test]
fn an_electron_profile_supplies_the_vault_and_settings() {
    let dir = scratch();
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let legacy = dir.join("Lernwerk Notes");
    fs::create_dir_all(&legacy).unwrap();
    let config = json!({
        "version": 1,
        "vaultPath": vault,
        "settings": {
            "theme": "midnight",
            "recognitionMode": "math",
            "openAiApiKey": "sk-from-electron",
            "geminiApiKey": "fanotes-secret-v1:abc"
        }
    });
    fs::write(
        legacy.join("config.json"),
        serde_json::to_string(&config).unwrap(),
    )
    .unwrap();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["vaultPath"], vault.to_string_lossy().as_ref());
    assert_eq!(boot["settings"]["theme"], "midnight");
    assert_eq!(boot["settings"]["recognitionMode"], "auto");
    assert_eq!(boot["settings"]["lastRecognitionMode"], "math");
    assert_eq!(boot["settings"]["openAiApiKey"], "");
    let settings = fs::read_to_string(app.join("settings.json")).unwrap();
    assert!(!settings.contains("sk-from-electron"));
    assert!(!settings.contains("fanotes-secret-v1"));
    fs::write(
        legacy.join("config.json"),
        r#"{"version":3,"settings":{"theme":"forest"}}"#,
    )
    .unwrap();
    let mut again = Host::open(app);
    assert_eq!(
        again.dispatch("fanotes:bootstrap", &[]).unwrap()["settings"]["theme"],
        "midnight"
    );
}

#[test]
fn an_electron_config_with_a_bad_byte_still_imports() {
    let dir = scratch();
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    let mut bytes = format!(
        r#"{{"version":2,"vaultPath":"{}","settings":{{"syncDeviceName":"LaXptop"}}}}"#,
        vault.display()
    )
    .into_bytes();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(app.join("config.json"), &bytes).unwrap();
    let mut host = Host::open(app);
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["vaultPath"], vault.to_string_lossy().as_ref());
    assert_eq!(boot["settings"]["syncDeviceName"], "La\u{FFFD}ptop");
}

#[test]
fn a_long_unicode_vault_path_is_remembered() {
    let dir = scratch();
    let legacy = dir.join("Lernwerk Notes");
    fs::create_dir_all(&legacy).unwrap();
    let vault = format!("/Notizen/{}", "Ä".repeat(3000));
    assert!(vault.len() > 4096);
    assert!(vault.encode_utf16().count() <= 4096);
    fs::write(
        legacy.join("config.json"),
        json!({ "version": 3, "vaultPath": vault }).to_string(),
    )
    .unwrap();
    let app = dir.join("app");
    let _host = Host::open(app.clone());
    let stored = fs::read_to_string(app.join("vault-path")).unwrap();
    assert_eq!(stored.trim(), vault);

    let other = dir.join("other-app");
    let too_long = format!("/{}/", "Ä".repeat(4096));
    fs::write(
        legacy.join("config.json"),
        json!({ "version": 3, "vaultPath": too_long }).to_string(),
    )
    .unwrap();
    let _again = Host::open(other.clone());
    assert!(!other.join("vault-path").exists());
}

#[test]
fn a_reset_profile_does_not_import_the_electron_config_again() {
    let dir = scratch();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.dispatch("fanotes:reset-app-data", &[]).unwrap();
    let trap = dir.join("should-not-open");
    fs::create_dir_all(&trap).unwrap();
    let legacy = dir.join("Lernwerk Notes");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(
        legacy.join("config.json"),
        format!(
            r#"{{"version":3,"vaultPath":"{}","settings":{{"theme":"midnight"}}}}"#,
            trap.display()
        ),
    )
    .unwrap();
    drop(host);
    let _ = Host::open(app.clone());
    let settings = fs::read_to_string(app.join("settings.json")).unwrap_or_default();
    assert!(!settings.contains("midnight"));
    assert!(!app.join("vault-path").exists());
    assert!(app.join(".fanotes-legacy-migration-v1-complete").is_file());
    assert!(!app.join(".fanotes-reset-complete").exists());
}

#[test]
fn an_imported_vault_symlink_opens_the_real_folder() {
    let dir = scratch();
    let real = dir.join("real");
    fs::create_dir_all(real.join("Mathe")).unwrap();
    fs::write(real.join("Seite.md"), b"Hallo\n").unwrap();
    let link = dir.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    fs::write(
        app.join("config.json"),
        json!({
            "version": 3,
            "vaultPath": link,
            "settings": { "theme": "midnight" }
        })
        .to_string(),
    )
    .unwrap();
    let mut host = Host::open(app);
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(
        boot["vaultPath"],
        fs::canonicalize(&real).unwrap().to_string_lossy().as_ref()
    );
    assert_eq!(boot["settings"]["theme"], "midnight");
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert!(tree
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "Mathe"));
}

#[test]
fn reopening_a_linked_vault_uses_the_real_folder_and_refreshes_the_welcome_note() {
    let dir = scratch();
    let real = dir.join("real");
    fs::create_dir_all(&real).unwrap();
    fs::write(
        real.join("Willkommen.md"),
        "Mit `Strg+Z` holst du eine versehentliche Löschung sofort zurück.\n",
    )
    .unwrap();
    fs::create_dir_all(real.join("Mathe")).unwrap();
    let link = dir.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    fs::write(app.join("vault-path"), format!("{}\n", link.display())).unwrap();
    let mut host = Host::open(app);
    assert_eq!(
        host.vault.as_deref(),
        Some(fs::canonicalize(&real).unwrap().as_path())
    );
    let welcome = fs::read_to_string(real.join("Willkommen.md")).unwrap();
    assert!(welcome.contains("**Strg+Z**"));
    assert!(!welcome.contains("`Strg+Z`"));
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert!(tree
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "Mathe"));
}

#[test]
fn optional_recognition_models_stay_uninstalled_with_the_renderer_shape() {
    let dir = scratch();
    let mut host = Host::open(dir.join("app"));
    let math = host
        .dispatch("fanotes:enhanced-math-get-state", &[])
        .unwrap();
    assert_eq!(math["supported"], false);
    assert_eq!(math["installed"], false);
    assert_eq!(math["downloading"], false);
    assert_eq!(math["modelId"], "posformer-crohme-q4-k");
    assert_eq!(math["size"], 10_316_032);
    assert_eq!(math["license"], "CC-BY-NC-SA-3.0");
    assert_eq!(
        math["homepage"],
        "https://huggingface.co/cstr/posformer-crohme-GGUF"
    );
    assert_eq!(
        host.dispatch(
            "fanotes:enhanced-math-install",
            &[json!({ "acceptLicense": true })]
        )
        .unwrap_err(),
        "PosFormer ist nicht installiert."
    );
    assert_eq!(
        host.dispatch("fanotes:enhanced-math-recognize", &[json!({})])
            .unwrap_err(),
        "PosFormer ist nicht installiert."
    );

    let qwen = host.dispatch("fanotes:qwen-vision-get-state", &[]).unwrap();
    assert_eq!(qwen["supported"], false);
    assert_eq!(qwen["installed"], false);
    assert_eq!(qwen["downloading"], false);
    assert_eq!(qwen["runtimeInstalling"], false);
    assert_eq!(qwen["runtimeReady"], false);
    assert_eq!(qwen["runtimePhase"], "idle");
    assert!(qwen["runtimeMessage"].is_null());
    assert_eq!(qwen["npu"], false);
    assert_eq!(qwen["genai"], false);
    assert_eq!(qwen["devices"], json!([]));
    assert!(qwen["npuDevice"].is_null());
    assert!(qwen["host"].is_null());
    assert!(qwen["openvinoVersion"].is_null());
    assert_eq!(qwen["modelId"], "qwen3-vl-2b-int4-npu");
    assert_eq!(
        qwen["label"],
        "Empfohlen · Qwen3-VL 2B · OpenVINO INT4 · NPU"
    );
    assert_eq!(qwen["recommended"], true);
    assert_eq!(qwen["precision"], "int4");
    assert_eq!(qwen["device"], "NPU");
    assert_eq!(qwen["license"], "Apache-2.0");
    assert_eq!(
        qwen["homepage"],
        "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct"
    );
    assert_eq!(qwen["repo"], "shawnxhong/Qwen3-VL-2B-Instruct-ov-int4");
    assert_eq!(
        qwen["error"],
        "Qwen Vision ist in diesem Paket nicht enthalten."
    );
    assert!(qwen["installHint"].is_null());
    assert_eq!(
        host.dispatch(
            "fanotes:qwen-vision-install",
            &[json!({ "acceptLicense": true })]
        )
        .unwrap_err(),
        "Qwen Vision ist nicht installiert."
    );
    assert_eq!(
        host.dispatch("fanotes:qwen-vision-recognize", &[json!({})])
            .unwrap_err(),
        "Qwen Vision ist nicht installiert."
    );
}

#[cfg(unix)]
#[test]
fn a_failed_vault_switch_reports_the_desktop_open_error_and_keeps_the_vault() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch();
    let app = dir.join("app");
    let current = dir.join("current");
    let next = dir.join("next");
    fs::create_dir_all(&current).unwrap();
    fs::create_dir_all(&next).unwrap();
    fs::write(current.join("Seite.md"), b"# Alt\n").unwrap();
    let current = fs::canonicalize(&current).unwrap();
    let next = fs::canonicalize(&next).unwrap();
    let mut host = Host::open(app.clone());
    host.set_vault(current.clone()).unwrap();
    fs::write(app.join("vault-path"), format!("{}", current.display())).unwrap();
    fs::set_permissions(&app, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(self.0.parent().unwrap_or(&self.0));
        }
    }
    let _restore = Restore(app.clone());
    let error = host
        .dispatch("fanotes:select-vault", &[json!(next.to_string_lossy())])
        .unwrap_err();
    let app = fs::canonicalize(&app).unwrap();
    let prefix = format!(
        "EACCES: permission denied, open '{}/.vault-path.{}.",
        app.display(),
        std::process::id()
    );
    assert!(error.starts_with(&prefix), "{error}");
    let hex = error[prefix.len()..].trim_end_matches(".tmp'");
    assert_eq!(hex.len(), 20, "{error}");
    assert!(
        hex.chars().all(|character| character.is_ascii_hexdigit()),
        "{error}"
    );
    assert!(error.ends_with(".tmp'"), "{error}");
    assert_eq!(host.vault.as_deref(), Some(current.as_path()));
    assert_eq!(
        fs::read_to_string(app.join("vault-path")).unwrap(),
        current.display().to_string()
    );
    assert!(!next.join("Willkommen.md").exists());
    assert!(!next.join("Welcome.md").exists());
}

#[cfg(unix)]
#[test]
fn an_unwritable_profile_reports_the_desktop_vault_path_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.documents_dir = Some(dir.join("docs"));
    host.settings.insert("uiLanguage".to_owned(), json!("de"));
    fs::set_permissions(&app, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(self.0.parent().unwrap_or(&self.0));
        }
    }
    let _restore = Restore(app.clone());
    let error = host.dispatch("fanotes:bootstrap", &[]).unwrap_err();
    let app = fs::canonicalize(&app).unwrap();
    let prefix = format!(
        "EACCES: permission denied, open '{}/.vault-path.{}.",
        app.display(),
        std::process::id()
    );
    assert!(error.starts_with(&prefix), "{error}");
    let hex = error[prefix.len()..].trim_end_matches(".tmp'");
    assert_eq!(hex.len(), 20, "{error}");
    assert!(host.vault.is_none());
    assert!(dir.join("docs/FaNotes/Willkommen.md").is_file());
    assert!(!app.join("vault-path").exists());
}
