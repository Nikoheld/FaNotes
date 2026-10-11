use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> (std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-rename-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::create_dir_all(vault.join("Physik")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    (dir.join("vault"), host)
}

#[test]
fn rename_keeps_the_extension_and_move_numbers_a_collision() {
    let (vault, mut host) = host();
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
            &[json!("Mathe/Seite.md"), json!("Blatt")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Blatt.md");
    assert!(vault.join("Mathe/Blatt.famd").is_file());
    assert!(!vault.join("Mathe/Seite.md").exists());
    assert_eq!(
        host.dispatch("fanotes:read-note-paper-style", &[json!("Mathe/Blatt.md")])
            .unwrap(),
        "grid"
    );
    assert_eq!(
        host.dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Blatt.md"), json!("Blatt.exe")],
        )
        .unwrap_err(),
        "Dieser Dateityp wird nicht unterstützt."
    );

    host.dispatch(
        "fanotes:write-file",
        &[json!("Physik/Blatt.md"), json!("da\n")],
    )
    .unwrap();
    let moved = host
        .dispatch(
            "fanotes:move-entry",
            &[json!("Mathe/Blatt.md"), json!("Physik")],
        )
        .unwrap();
    assert_eq!(moved, "Physik/Blatt 2.md");
    assert!(vault.join("Physik/Blatt 2.famd").is_file());
    assert!(vault.join("Physik/Blatt.md").is_file());
    assert_eq!(
        host.dispatch(
            "fanotes:read-note-paper-style",
            &[json!("Physik/Blatt 2.md")]
        )
        .unwrap(),
        "grid"
    );

    host.dispatch("fanotes:create-folder", &[json!(""), json!("Ordner")])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:move-entry", &[json!("Ordner"), json!("Ordner")])
            .unwrap_err(),
        "Ein Ordner kann nicht in sich selbst verschoben werden."
    );
}
