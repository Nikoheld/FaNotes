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
    fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    fs::write(vault.join("Physik/Blatt.md"), b"\n").unwrap();
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

#[test]
fn a_missing_child_is_reported_before_a_move_into_itself() {
    let (vault, mut host) = host();
    fs::create_dir_all(vault.join("Ordner/Innen")).unwrap();
    fs::write(vault.join("Ordner/Seite.md"), b"Hallo\n").unwrap();
    assert_eq!(
        host.dispatch(
            "fanotes:move-entry",
            &[json!("Ordner"), json!("Ordner/Fehlt")],
        )
        .unwrap_err(),
        "Der Eintrag wurde nicht gefunden."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:move-entry",
            &[json!("Ordner"), json!("Ordner/Seite.md")],
        )
        .unwrap_err(),
        "Der gewählte Pfad ist kein Ordner."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:move-entry",
            &[json!("Ordner"), json!("Ordner/Innen")],
        )
        .unwrap_err(),
        "Ein Ordner kann nicht in sich selbst verschoben werden."
    );
    assert_eq!(
        host.dispatch("fanotes:move-entry", &[json!("Ordner"), json!("../x")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert!(vault.join("Ordner/Innen").is_dir());
    assert!(vault.join("Ordner/Seite.md").is_file());
}

#[test]
fn a_symlinked_folder_cannot_rename_move_or_receive_a_note() {
    let dir = std::env::temp_dir().join(format!("fanotes-rename-link-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    let outside = dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("Seite.md"), b"bleibt\n").unwrap();
    fs::create_dir_all(&vault).unwrap();
    std::os::unix::fs::symlink(&outside, vault.join("weg")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault).unwrap();
    let message = "Symbolische Links sind innerhalb des Vaults nicht erlaubt.";
    assert_eq!(
        host.dispatch(
            "fanotes:rename-entry",
            &[json!("weg/Seite.md"), json!("Neu.md")]
        )
        .unwrap_err(),
        message
    );
    assert_eq!(
        host.dispatch("fanotes:move-entry", &[json!("weg/Seite.md"), json!("")])
            .unwrap_err(),
        message
    );
    assert_eq!(
        host.dispatch("fanotes:trash-entry", &[json!("weg/Seite.md")])
            .unwrap_err(),
        message
    );
    assert_eq!(
        host.dispatch("fanotes:create-note", &[json!("weg"), json!("Neu")])
            .unwrap_err(),
        message
    );
    assert_eq!(fs::read(outside.join("Seite.md")).unwrap(), b"bleibt\n");
    assert!(!outside.join("Neu.md").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_blank_rename_keeps_a_valid_name_and_rejects_a_device_name() {
    let (vault, mut host) = host();
    fs::write(vault.join("Mathe/Seite.md"), "Hallo\n").unwrap();
    let kept = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md"), json!("  ")],
        )
        .unwrap();
    assert_eq!(kept, "Mathe/Seite.md");
    assert_eq!(fs::read(vault.join("Mathe/Seite.md")).unwrap(), b"Hallo\n");

    fs::write(vault.join("Mathe/CON.md"), "x\n").unwrap();
    assert_eq!(
        host.dispatch("fanotes:rename-entry", &[json!("Mathe/CON.md"), json!("")])
            .unwrap_err(),
        "Dieser Name ist nicht erlaubt."
    );
    assert!(vault.join("Mathe/CON.md").is_file());

    let renamed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md"), json!("Notiz\u{FEFF}")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Notiz.md");
    assert_eq!(
        host.dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Notiz.md"), json!("CON\u{FEFF}")]
        )
        .unwrap_err(),
        "Dieser Name ist nicht erlaubt."
    );
    let kept_next_line = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Notiz.md"), json!("Blatt\u{0085}")],
        )
        .unwrap();
    assert_eq!(kept_next_line, "Mathe/Blatt\u{0085}.md");
}

#[test]
fn an_unchanged_rename_returns_the_path_the_caller_sent() {
    let (vault, mut host) = host();
    fs::write(vault.join("Mathe/Seite.md"), "Hallo\n").unwrap();
    let slash = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md/"), json!("  ")],
        )
        .unwrap();
    assert_eq!(slash, "Mathe/Seite.md/");
    let prefixed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("./Mathe/Seite.md"), json!(1)],
        )
        .unwrap();
    assert_eq!(prefixed, "./Mathe/Seite.md");
    assert_eq!(fs::read(vault.join("Mathe/Seite.md")).unwrap(), b"Hallo\n");
    let renamed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md/"), json!("Blatt")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Blatt.md");
    assert!(vault.join("Mathe/Blatt.md").is_file());
}

#[test]
fn a_blank_move_target_returns_the_note_to_the_vault_root() {
    let (vault, mut host) = host();
    fs::write(vault.join("Mathe/Seite.md"), b"\n").unwrap();
    fs::write(vault.join("Mathe/Andere.md"), b"\n").unwrap();
    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Seite.md"), json!("Hallo\n")],
    )
    .unwrap();
    let moved = host
        .dispatch(
            "fanotes:move-entry",
            &[json!("Mathe/Seite.md"), json!("   ")],
        )
        .unwrap();
    assert_eq!(moved, "Seite.md");
    assert!(vault.join("Seite.md").is_file());
    assert!(vault.join("Seite.famd").is_file());
    assert!(!vault.join("Mathe/Seite.md").exists());
    assert!(!vault.join("Mathe/Seite.famd").exists());

    host.dispatch(
        "fanotes:write-file",
        &[json!("Mathe/Andere.md"), json!("Hallo\n")],
    )
    .unwrap();
    let moved = host
        .dispatch(
            "fanotes:move-entry",
            &[json!("Mathe/Andere.md"), json!("\u{FEFF}")],
        )
        .unwrap();
    assert_eq!(moved, "Andere.md");
    assert!(vault.join("Andere.md").is_file());
}

#[test]
fn renaming_a_note_adopts_a_legacy_internal_folder_and_its_color() {
    let (vault, mut host) = host();
    fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    fs::remove_dir_all(vault.join(".fanotes")).unwrap();
    fs::create_dir_all(vault.join(".lernwerk")).unwrap();
    fs::write(vault.join(".lernwerk/keep.txt"), b"alt").unwrap();
    fs::write(
        vault.join(".lernwerk/folder-colors.json"),
        "{\n  \"version\": 1,\n  \"colors\": {\n    \"Mathe/Seite.md\": \"#112233\"\n  }\n}\n",
    )
    .unwrap();
    let renamed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md"), json!("Blatt")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Blatt.md");
    assert!(vault.join("Mathe/Blatt.md").is_file());
    assert_eq!(fs::read(vault.join(".fanotes/keep.txt")).unwrap(), b"alt");
    assert!(!vault.join(".lernwerk").exists());
    let colors = fs::read_to_string(vault.join(".fanotes/folder-colors.json")).unwrap();
    assert!(colors.contains("Mathe/Blatt.md"), "{colors}");
    assert!(!colors.contains("Mathe/Seite.md"), "{colors}");
    assert!(colors.contains("#112233"), "{colors}");
}

#[test]
fn a_rename_replaces_an_existing_companion_and_a_move_avoids_it() {
    let (vault, mut host) = host();
    fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    fs::write(vault.join("Mathe/Seite.famd"), b"alt\n").unwrap();
    fs::write(vault.join("Mathe/Ziel.famd"), b"fremd\n").unwrap();
    let renamed = host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Mathe/Seite.md"), json!("Ziel")],
        )
        .unwrap();
    assert_eq!(renamed, "Mathe/Ziel.md");
    assert_eq!(fs::read(vault.join("Mathe/Ziel.md")).unwrap(), b"Hallo\n");
    assert_eq!(fs::read(vault.join("Mathe/Ziel.famd")).unwrap(), b"alt\n");
    assert!(!vault.join("Mathe/Seite.md").exists());
    assert!(!vault.join("Mathe/Seite.famd").exists());

    fs::write(vault.join("Physik/Andere.famd"), b"bleibt\n").unwrap();
    fs::write(vault.join("Mathe/Andere.md"), b"Notiz\n").unwrap();
    fs::write(vault.join("Mathe/Andere.famd"), b"eigen\n").unwrap();
    let moved = host
        .dispatch(
            "fanotes:move-entry",
            &[json!("Mathe/Andere.md"), json!("Physik")],
        )
        .unwrap();
    assert_eq!(moved, "Physik/Andere 2.md");
    assert_eq!(
        fs::read(vault.join("Physik/Andere.famd")).unwrap(),
        b"bleibt\n"
    );
    assert_eq!(
        fs::read(vault.join("Physik/Andere 2.famd")).unwrap(),
        b"eigen\n"
    );
}
