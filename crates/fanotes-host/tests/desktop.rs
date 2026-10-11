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
    assert!(log.contains("open https://example.com/a%20b"));
    assert!(log.contains(&format!("reveal {}", vault.join("Seite.md").display())));

    let hits = host.dispatch("fanotes:search", &[json!("riesig")]).unwrap();
    assert!(hits.as_array().unwrap().is_empty());
    fs::write(vault.join("klein.md"), b"riesig\n").unwrap();
    let hits = host.dispatch("fanotes:search", &[json!("riesig")]).unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["relativePath"], "klein.md");
}
