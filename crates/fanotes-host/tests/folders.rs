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
    fs::write(vault.join("Sichtbar.md"), "x\n").unwrap();
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
    let error = host.dispatch("fanotes:get-tree", &[]).unwrap_err();
    assert!(error.contains("nicht gelesen"), "{error}");
    drop(restore);
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
