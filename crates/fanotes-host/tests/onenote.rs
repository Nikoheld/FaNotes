use fanotes_host::Host;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;

fn host() -> (Host, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("fanotes-onenote-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    (host, vault)
}

#[test]
fn the_sample_notebook_becomes_a_searchable_note() {
    let (mut host, vault) = host();
    fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    fs::create_dir_all(vault.join(".lernwerk")).unwrap();
    fs::write(vault.join(".lernwerk/keep.txt"), b"alt").unwrap();
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fanotes/scripts/fixtures/onenote/Open Notebook.onetoc2");
    let result = host
        .dispatch(
            "fanotes:import-onenote",
            &[json!(fixture.to_string_lossy())],
        )
        .unwrap();
    assert_eq!(result["pageCount"], 1);
    assert_eq!(result["attachmentCount"], 1);
    assert_eq!(fs::read(vault.join(".lernwerk/keep.txt")).unwrap(), b"alt");
    assert!(!vault.join(".fanotes/keep.txt").exists());
    assert!(result["rootFolder"]
        .as_str()
        .unwrap()
        .starts_with("OneNote – "));
    let note_path = vault.join(result["importedNotes"][0].as_str().unwrap());
    let note = fs::read_to_string(&note_path).unwrap();
    assert!(note.starts_with("# Test Page") || note.starts_with("# Test\\ Page"));
    assert!(note.contains("fanotes-worksheet:"));
    assert!(note.contains("Lorem ipsum dolor sit amet"));
    let id = note
        .split("fanotes-worksheet:")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .trim_end_matches("-->");
    let html_path = vault.join(format!(".fanotes/worksheets/{id}.html"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&note_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&html_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let html = fs::read_to_string(html_path).unwrap();
    assert!(html.contains("fanotes-onenote-safe-v1"));
    assert!(html.contains("Content-Security-Policy"));
    assert!(html.contains("<math"));
    assert!(html.contains("<svg"));
    assert!(html.contains("src=\"data:image/jpeg;base64,"));
    assert!(!html.to_ascii_lowercase().contains("<script"));
    assert!(!html.to_ascii_lowercase().contains("javascript:"));
    assert!(!html.contains("href="));
    let manifest = fs::read_dir(vault.join(".fanotes/onenote"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("manifest.json");
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(manifest).unwrap()).unwrap();
    let stored = manifest["attachments"][0]["storedName"].as_str().unwrap();
    let digest = manifest["attachments"][0]["sha256"].as_str().unwrap();
    let batch = fs::read_dir(vault.join(".fanotes/onenote"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let attachment = fs::read(batch.join("attachments").join(stored)).unwrap();
    assert!(stored.ends_with(".fanotes-attachment"));
    assert_eq!(format!("{:x}", Sha256::digest(&attachment)), digest);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(batch.join("attachments").join(stored))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let source_name = manifest["originalSources"][0]["storedName"]
            .as_str()
            .unwrap();
        assert_eq!(
            fs::metadata(batch.join("original").join(source_name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(vault.join(result["rootFolder"].as_str().unwrap()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(batch.join("attachments"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    let archive = vault.parent().unwrap().join("export.zip");
    let seven = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fanotes/resources/onenote/linux/7za");
    let packed = std::process::Command::new(seven)
        .args([
            "a",
            "-tzip",
            archive.to_str().unwrap(),
            "Open Notebook.onetoc2",
            "New Section 1.one",
        ])
        .current_dir(fixture.parent().unwrap())
        .status()
        .unwrap();
    assert!(packed.success());
    let zipped = host
        .dispatch(
            "fanotes:import-onenote",
            &[json!(archive.to_string_lossy())],
        )
        .unwrap();
    assert_eq!(zipped["pageCount"], 1);
    assert_eq!(zipped["attachmentCount"], 1);
}

#[cfg(unix)]
#[test]
fn a_missing_onenote_source_uses_the_desktop_lstat_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "fanotes-onenote-lstat-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    let missing = dir.join("fehlt.one");
    assert_eq!(
        host.dispatch("fanotes:import-onenote", &[json!(missing.display().to_string())])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    let empty = dir.join("leer.one");
    fs::write(&empty, b"").unwrap();
    assert_eq!(
        host.dispatch("fanotes:import-onenote", &[json!(empty.display().to_string())])
            .unwrap_err(),
        "Die OneNote-Quelldatei ist leer, unsicher oder größer als 4 GB."
    );
    let locked = dir.join("locked");
    fs::create_dir(&locked).unwrap();
    let source = locked.join("Notiz.one");
    fs::write(&source, b"one").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(locked);
    assert_eq!(
        host.dispatch("fanotes:import-onenote", &[json!(source.display().to_string())])
            .unwrap_err(),
        format!(
            "EACCES: permission denied, lstat '{}'",
            source.display()
        )
    );
}

#[cfg(unix)]
#[test]
fn an_unwritable_onenote_internal_folder_reports_the_desktop_mkdir_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "fanotes-onenote-internal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    let internal = vault.join(".fanotes");
    fs::create_dir_all(&internal).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    fs::set_permissions(&internal, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            if let Some(root) = self.0.parent().and_then(|path| path.parent()) {
                let _ = fs::remove_dir_all(root);
            }
        }
    }
    let _restore = Restore(internal.clone());
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fanotes/scripts/fixtures/onenote/Open Notebook.onetoc2");
    assert_eq!(
        host.dispatch(
            "fanotes:import-onenote",
            &[json!(fixture.to_string_lossy())],
        )
        .unwrap_err(),
        format!(
            "EACCES: permission denied, mkdir '{}'",
            internal.join("onenote").display()
        )
    );
    assert!(!internal.join("onenote").exists());
}
