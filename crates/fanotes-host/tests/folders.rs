use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;
use std::fs;

fn host() -> (Host, std::path::PathBuf, std::path::PathBuf) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-folders-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.set_vault(vault.clone()).unwrap();
    (host, vault, app)
}

#[test]
fn a_markdown_note_keeps_a_kelvin_sign_in_its_extension() {
    let (mut host, vault, _) = host();
    let name = "Notiz.mar\u{212A}down";
    fs::write(vault.join("Notiz.mar\u{017F}down"), "langes s\n").unwrap();
    let created = host
        .dispatch("fanotes:create-note", &[json!(""), json!(name)])
        .unwrap();
    assert_eq!(created["relativePath"], name);
    assert_eq!(created["entry"]["extension"], "markdown");
    host.dispatch(
        "fanotes:write-file",
        &[json!(name), json!("Kelvinwort in der Notiz\n")],
    )
    .unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let file = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap();
    assert_eq!(file["extension"], "markdown");
    assert!(tree
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["name"] != "Notiz.mar\u{017F}down"));
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!(name)])
            .unwrap()
            .as_str(),
        Some("Kelvinwort in der Notiz")
    );
    let hits = host
        .dispatch("fanotes:search", &[json!("Kelvinwort")])
        .unwrap();
    assert!(hits
        .as_array()
        .unwrap()
        .iter()
        .any(|hit| hit["relativePath"] == name));
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert!(cached
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == name && entry["extension"] == "markdown"));
}

#[test]
fn a_kelvin_sign_cannot_name_the_legacy_internal_folder() {
    let (mut host, vault, _) = host();
    let kelvin = ".lernwer\u{212A}";
    assert_eq!(
        host.dispatch("fanotes:create-folder", &[json!(""), json!(kelvin)])
            .unwrap_err(),
        "Dieser Name ist nicht erlaubt."
    );
    assert!(!vault.join(kelvin).exists());
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!(format!("{kelvin}/Notiz.md")), json!("Hallo")]
        )
        .unwrap_err(),
        "Interne FaNotes-Dateien sind geschützt."
    );
}

#[test]
fn an_invalid_folder_color_is_reported_before_the_folder_check() {
    let (mut host, vault, _) = host();
    fs::write(vault.join("Seite.md"), b"Hallo\n").unwrap();
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!("Seite.md"), json!(1)])
            .unwrap_err(),
        "Ungültige Ordnerfarbe."
    );
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!("Fehlt"), json!(false)])
            .unwrap_err(),
        "Ungültige Ordnerfarbe."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:set-folder-color",
            &[json!("Seite.md"), json!("#112233")],
        )
        .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!("../x"), json!(1)])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!(1), json!("#112233")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    let missing = fs::canonicalize(&vault).unwrap().join("Fehlt");
    assert_eq!(
        host.dispatch(
            "fanotes:set-folder-color",
            &[json!("Fehlt"), json!("#112233")],
        )
        .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    host.dispatch(
        "fanotes:set-folder-color",
        &[json!("Mathe"), json!("#A1B2C3")],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!("Mathe")])
            .unwrap_err(),
        "Ungültige Ordnerfarbe."
    );
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!("Seite.md")])
            .unwrap_err(),
        "Ungültige Ordnerfarbe."
    );
    assert_eq!(
        host.dispatch("fanotes:set-folder-color", &[json!("Mathe"), json!("blau")])
            .unwrap_err(),
        "Ungültige Ordnerfarbe."
    );
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let mathe = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Mathe")
        .unwrap();
    assert_eq!(mathe["color"], "#a1b2c3");
    assert!(vault.join("Seite.md").is_file());
    let stored = fs::read_to_string(vault.join(".fanotes/folder-colors.json")).unwrap();
    assert!(stored.contains("Mathe"));
    assert!(!stored.contains("Seite"));
    assert!(!stored.contains("Fehlt"));
}

#[test]
fn folder_color_survives_a_rename_and_the_vault_is_remembered() {
    let (mut host, vault, app) = host();
    let painted = host
        .dispatch(
            "fanotes:set-folder-color",
            &[json!("Mathe"), json!("#A1B2C3")],
        )
        .unwrap();
    assert_eq!(painted["color"], "#a1b2c3");
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(tree[0]["name"], "Mathe");
    assert_eq!(tree[0]["color"], "#a1b2c3");

    host.dispatch("fanotes:rename-entry", &[json!("Mathe"), json!("Physik")])
        .unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(tree[0]["relativePath"], "Physik");
    assert_eq!(tree[0]["color"], "#a1b2c3");

    let cleared = host
        .dispatch("fanotes:set-folder-color", &[json!("Physik"), json!(null)])
        .unwrap();
    assert!(cleared["color"].is_null());
    assert!(host
        .dispatch(
            "fanotes:set-folder-color",
            &[json!("Physik"), json!("blue")],
        )
        .is_err());

    for name in ["zoo", "apfel", "äpfel", "straße", "strasse", "ä"] {
        host.dispatch("fanotes:create-folder", &[json!(""), json!(name)])
            .unwrap();
        host.dispatch("fanotes:set-folder-color", &[json!(name), json!("#112233")])
            .unwrap();
    }
    let stored = fs::read_to_string(vault.join(".fanotes/folder-colors.json")).unwrap();
    let keys: Vec<_> = stored
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix('"')
                .and_then(|rest| rest.split('"').next())
        })
        .filter(|key| *key != "version" && *key != "colors")
        .collect();
    assert_eq!(
        keys,
        vec!["ä", "apfel", "äpfel", "strasse", "straße", "zoo"]
    );

    let other = vault.parent().unwrap().join("other-vault");
    std::fs::create_dir_all(&other).unwrap();
    let switched = host
        .dispatch("fanotes:select-vault", &[json!(other.to_string_lossy())])
        .unwrap();
    assert_eq!(switched["vaultPath"], other.to_string_lossy().as_ref());

    let mut restored = Host::open(app);
    assert_eq!(
        restored.dispatch("fanotes:bootstrap", &[]).unwrap()["vaultPath"],
        other.to_string_lossy().as_ref()
    );
}

#[test]
fn the_tree_shows_pdf_notes_and_hides_their_famd_companion() {
    let (mut host, vault, _) = host();
    fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    fs::write(vault.join("Mathe/Seite.famd"), b"companion").unwrap();
    fs::write(vault.join("Mathe/Skript.pdf"), b"%PDF-1.4\n").unwrap();
    fs::write(vault.join("Mathe/lose.famd"), b"alone").unwrap();
    fs::write(vault.join("Mathe/bild.png"), b"png").unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let folder = &tree[0];
    assert_eq!(folder["kind"], "folder");
    let names: Vec<_> = folder["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["bild.png", "lose.famd", "Seite.md", "Skript.pdf"]
    );
    assert!(folder["children"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["extension"] == "pdf"));
}

#[test]
fn a_legacy_lernwerk_directory_becomes_fanotes() {
    let dir = std::env::temp_dir().join(format!("fanotes-legacy-internal-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::create_dir_all(vault.join(".lernwerk")).unwrap();
    fs::write(
        vault.join(".lernwerk/folder-colors.json"),
        r##"{"version":1,"colors":{"Mathe":"#112233"}}"##,
    )
    .unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    assert!(!vault.join(".lernwerk").exists());
    assert!(vault.join(".fanotes/folder-colors.json").is_file());
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let mathe = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Mathe")
        .unwrap();
    assert_eq!(mathe["color"], "#112233");

    let kept = dir.join("kept");
    fs::create_dir_all(kept.join(".fanotes")).unwrap();
    fs::create_dir_all(kept.join(".lernwerk")).unwrap();
    fs::write(
        kept.join(".fanotes/folder-colors.json"),
        r##"{"colors":{"A":"#abcdef"}}"##,
    )
    .unwrap();
    fs::write(
        kept.join(".lernwerk/folder-colors.json"),
        r##"{"colors":{"B":"#000000"}}"##,
    )
    .unwrap();
    fs::create_dir_all(kept.join("A")).unwrap();
    host.set_vault(kept.clone()).unwrap();
    assert!(kept.join(".lernwerk").is_dir());
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let folder = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "A")
        .unwrap();
    assert_eq!(folder["color"], "#abcdef");

    let unsafe_vault = dir.join("unsafe");
    fs::create_dir_all(&unsafe_vault).unwrap();
    std::os::unix::fs::symlink(dir.join("app"), unsafe_vault.join(".lernwerk")).unwrap();
    host.set_vault(unsafe_vault.clone()).unwrap();
    let error = host.dispatch("fanotes:get-tree", &[]).unwrap_err();
    assert!(error.contains("unsicher") || error.contains("verlässt"));
    assert!(unsafe_vault
        .join(".lernwerk")
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!unsafe_vault.join(".fanotes").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_tree_sorts_umlauts_with_their_base_letters() {
    let (mut host, vault, _) = host();
    for name in [
        "Zen.md",
        "Äpfel.md",
        "Banane.md",
        "Straße.md",
        "Apfel.md",
        "Seite 10.md",
        "Seite 2.md",
        "Mu\u{0308}he.md",
    ] {
        fs::write(vault.join(name), b"x\n").unwrap();
    }
    let names: Vec<_> = host
        .dispatch("fanotes:get-tree", &[])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "file")
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    let index = |name: &str| names.iter().position(|entry| entry == name).unwrap();
    assert!(index("Apfel.md") < index("Banane.md"));
    assert!(index("Äpfel.md") < index("Banane.md"));
    assert!(index("Äpfel.md") < index("Zen.md"));
    assert!(index("Straße.md") < index("Zen.md"));
    assert!(index("Seite 2.md") < index("Seite 10.md"));
    assert!(index("Mu\u{0308}he.md") < index("Zen.md"));
}

#[test]
fn an_unreadable_name_does_not_hide_the_rest_of_the_tree() {
    let (mut host, vault, _) = host();
    let mut directory = vault.clone();
    while directory.to_string_lossy().len() + 80 < 3950 {
        let used = directory.to_string_lossy().len();
        let piece = (3940usize.saturating_sub(used + 1)).clamp(1, 200);
        directory.push("d".repeat(piece));
        fs::create_dir(&directory).unwrap();
    }
    fs::write(directory.join("ok.md"), "Sichtwort\n").unwrap();
    let dir_len = directory.to_string_lossy().len();
    let name_len = (4099usize.saturating_sub(dir_len + 1)).clamp(4, 255);
    let name = format!("{}.md", "y".repeat(name_len - 3));
    let status = std::process::Command::new("python3")
        .arg("-c")
        .arg(format!(
            "import os; fd = os.open({dir:?}, os.O_RDONLY); os.close(os.open({name:?}, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o644, dir_fd=fd)); os.close(fd)",
            dir = directory,
            name = name,
        ))
        .status()
        .unwrap();
    assert!(status.success());
    assert!(std::fs::symlink_metadata(directory.join(&name)).is_err());

    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap().to_string();
    assert!(tree.contains("ok.md"), "{tree}");
    assert!(!tree.contains(&name), "{tree}");
    let fast = host
        .dispatch("fanotes:get-fast-tree", &[])
        .unwrap()
        .to_string();
    assert!(fast.contains("ok.md"));
    let hits = host
        .dispatch("fanotes:search", &[json!("Sichtwort")])
        .unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert!(hits[0]["relativePath"].as_str().unwrap().ends_with("ok.md"));
}

#[test]
fn a_fast_tree_skips_a_folder_that_cannot_be_listed() {
    let (mut host, vault, _) = host();
    let hidden = vault.join("Geheim");
    fs::create_dir(&hidden).unwrap();
    fs::write(hidden.join("versteckt.md"), "x\n").unwrap();
    fs::write(vault.join("Sichtbar.md"), "Sichtwort\n").unwrap();
    let canonical = fs::canonicalize(&hidden).unwrap();
    let restore = RestoreMode(hidden.clone());
    let mut permissions = fs::metadata(&hidden).unwrap().permissions();
    permissions.set_readonly(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o000);
    }
    fs::set_permissions(&hidden, permissions).unwrap();

    let fast = host
        .dispatch("fanotes:get-fast-tree", &[])
        .unwrap()
        .to_string();
    assert!(fast.contains("Sichtbar.md"), "{fast}");
    assert!(!fast.contains("Geheim"), "{fast}");
    let expected = format!(
        "EACCES: permission denied, scandir '{}'",
        canonical.display()
    );
    assert_eq!(
        host.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        expected
    );
    assert_eq!(
        host.dispatch("fanotes:search", &[json!("Sichtwort")]).unwrap_err(),
        expected
    );
    drop(restore);
}

#[cfg(unix)]
#[test]
fn an_unreadable_folder_color_file_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault, _) = host();
    fs::create_dir_all(vault.join(".fanotes")).unwrap();
    let path = vault.join(".fanotes/folder-colors.json");
    fs::write(
        &path,
        br##"{"version":1,"colors":{"Mathe":"#A1B2C3"}}"##,
    )
    .unwrap();
    let canonical = fs::canonicalize(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(path.clone());
    assert_eq!(
        host.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        format!("EACCES: permission denied, open '{}'", canonical.display())
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(tree[0]["name"], "Mathe");
    assert_eq!(tree[0]["color"], "#a1b2c3");
}

#[cfg(unix)]
#[test]
fn an_unlistable_vault_metadata_folder_uses_the_desktop_lstat_error() {
    use std::os::unix::fs::PermissionsExt;
    let (mut host, vault, _) = host();
    let internal = vault.join(".fanotes");
    fs::create_dir_all(&internal).unwrap();
    let colors = internal.join("folder-colors.json");
    let books = internal.join("subject-books.json");
    fs::write(&colors, br##"{"version":1,"colors":{"Mathe":"#A1B2C3"}}"##).unwrap();
    fs::write(&books, b"{\"version\":1,\"books\":[]}\n").unwrap();
    let colors_path = fs::canonicalize(&colors).unwrap();
    let books_path = fs::canonicalize(&books).unwrap();
    fs::set_permissions(&internal, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(internal.clone());
    assert_eq!(
        host.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        format!(
            "EACCES: permission denied, lstat '{}'",
            colors_path.display()
        )
    );
    assert_eq!(
        host.dispatch("fanotes:read-subject-books", &[]).unwrap_err(),
        format!(
            "EACCES: permission denied, lstat '{}'",
            books_path.display()
        )
    );
    fs::set_permissions(&internal, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(fs::read(&colors).unwrap(), br##"{"version":1,"colors":{"Mathe":"#A1B2C3"}}"##);
}

#[test]
fn a_folder_color_with_a_bad_byte_still_paints_the_folder() {
    let (mut host, vault, _) = host();
    fs::create_dir_all(vault.join(".fanotes")).unwrap();
    let mut bytes = br##"{"version":1,"note":"X","colors":{"Mathe":"#A1B2C3"}}"##.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(vault.join(".fanotes/folder-colors.json"), &bytes).unwrap();

    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(tree[0]["name"], "Mathe");
    assert_eq!(tree[0]["color"], "#a1b2c3");

    fs::write(vault.join(".fanotes/folder-colors.json"), b"{\xff").unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert!(tree[0]["color"].is_null());
}

struct RestoreMode(std::path::PathBuf);

impl Drop for RestoreMode {
    fn drop(&mut self) {
        let Ok(meta) = fs::metadata(&self.0) else {
            return;
        };
        let mut permissions = meta.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o700);
        }
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&self.0, permissions);
    }
}
