use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> (std::path::PathBuf, std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-trash-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault.clone()).unwrap();
    (dir, vault, host)
}

#[test]
fn deleted_notes_go_to_the_trash_and_the_tree_sorts_numbers() {
    let (dir, vault, mut host) = host();
    fs::write(vault.join("Seite 10.md"), b"zehn\n").unwrap();
    fs::write(vault.join("Seite 2.md"), b"zwei\n").unwrap();
    fs::write(vault.join("Seite 2.famd"), b"companion").unwrap();
    let names: Vec<_> = host
        .dispatch("fanotes:get-tree", &[])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["Seite 2.md", "Seite 10.md"]);

    host.dispatch("fanotes:trash-entry", &[json!("Seite 2.md")])
        .unwrap();
    assert!(!vault.join("Seite 2.md").exists());
    assert!(!vault.join("Seite 2.famd").exists());
    let files = fs::read_dir(dir.join("trash/files")).unwrap();
    let stored: Vec<_> = files
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(stored.iter().any(|name| name == "Seite 2.md"));
    assert!(stored.iter().any(|name| name == "Seite 2.famd"));
    let info = fs::read_to_string(dir.join("trash/info/Seite 2.md.trashinfo")).unwrap();
    assert!(info.starts_with("[Trash Info]\nPath="));
    assert!(info.contains("Seite%202.md"));
    assert!(info.contains("DeletionDate="));

    fs::write(vault.join("kopie.md"), b"weg\n").unwrap();
    host.dispatch("fanotes:sync-remove", &[json!("kopie.md")])
        .unwrap();
    assert!(!vault.join("kopie.md").exists());
    assert!(dir.join("trash/files/kopie.md").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.join("trash/info/Seite 2.md.trashinfo"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for folder in ["trash", "trash/files", "trash/info"] {
            assert_eq!(
                fs::metadata(dir.join(folder)).unwrap().permissions().mode() & 0o777,
                0o700,
                "{folder}"
            );
        }
        let info = dir.join("trash/info");
        fs::set_permissions(&info, fs::Permissions::from_mode(0o500)).unwrap();
        fs::write(vault.join("zurueck.md"), b"bleibt\n").unwrap();
        let error = host
            .dispatch("fanotes:trash-entry", &[json!("zurueck.md")])
            .unwrap_err();
        assert!(error.contains("Papierkorb"));
        assert_eq!(fs::read(vault.join("zurueck.md")).unwrap(), b"bleibt\n");
        assert!(!dir.join("trash/files/zurueck.md").exists());
        fs::set_permissions(&info, fs::Permissions::from_mode(0o700)).unwrap();
    }
}
