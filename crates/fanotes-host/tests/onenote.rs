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
