use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> (std::path::PathBuf, std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-sync-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    let app = dir.join("app");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(app.clone());
    host.set_vault(vault.clone()).unwrap();
    (vault, app, host)
}

#[test]
fn sync_lists_files_and_keeps_account_state_outside_the_vault() {
    let (vault, app, mut host) = host();
    fs::write(vault.join("Notiz.md"), b"Hallo\n").unwrap();
    fs::create_dir_all(vault.join(".fanotes/history")).unwrap();
    fs::write(vault.join(".fanotes/history/alt.md"), b"x").unwrap();
    fs::write(vault.join(".fanotes/subject-books.json"), b"{}").unwrap();
    fs::write(vault.join(".geheim"), b"nein").unwrap();
    fs::write(vault.join("skip.tmp"), b"t").unwrap();
    fs::create_dir(vault.join("echt")).unwrap();
    fs::write(vault.join("echt/blatt.md"), b"a").unwrap();
    std::os::unix::fs::symlink(vault.join("echt"), vault.join("link")).unwrap();

    let scan = host.dispatch("fanotes:sync-scan", &[]).unwrap();
    let entries = scan.as_array().unwrap();
    let paths: Vec<&str> = entries
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"Notiz.md"));
    assert!(paths.contains(&".fanotes/subject-books.json"));
    assert!(paths.contains(&"echt/blatt.md"));
    assert!(paths.iter().all(|path| !path.contains("history")
        && !path.starts_with("link")
        && *path != ".geheim"
        && !path.ends_with(".tmp")));
    let note = entries
        .iter()
        .find(|entry| entry["path"] == "Notiz.md")
        .unwrap();
    assert_eq!(note["size"], 6);
    assert!(note["mtimeMs"].as_i64().unwrap() > 0);
    assert!(note.get("relativePath").is_none());

    assert!(host
        .dispatch("fanotes:sync-read", &[json!("link/blatt.md")])
        .is_err());
    let books = host
        .dispatch("fanotes:sync-read", &[json!(".fanotes/subject-books.json")])
        .unwrap();
    assert!(!books.as_str().unwrap().is_empty());

    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(id.len(), 32);
    assert!(id.chars().all(|ch| ch.is_ascii_hexdigit()));
    host.dispatch(
        "fanotes:sync-write-state",
        &[json!(id), json!("{\"version\":1}")],
    )
    .unwrap();
    assert!(app.join(format!("sync/state-{id}.json")).is_file());
    assert!(!vault.join(".fanotes/sync-state.json").exists());
    assert_eq!(
        host.dispatch("fanotes:sync-read-state", &[json!(id)])
            .unwrap(),
        "{\"version\":1}"
    );
    host.dispatch("fanotes:sync-write-state", &[json!(id), json!(null)])
        .unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-state", &[json!(id)])
        .unwrap()
        .is_null());

    let secret = "{\"v\":1,\"token\":\"geheim\"}";
    host.dispatch("fanotes:sync-write-secrets", &[json!(secret)])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[]).unwrap(),
        secret
    );
    let settings = fs::read_to_string(app.join("settings.json")).unwrap_or_default();
    let secrets = fs::read_to_string(app.join("secrets.json")).unwrap_or_default();
    assert!(!settings.contains("geheim"));
    assert!(!secrets.contains("geheim"));
    assert!(app.join("sync/account.secret").is_file());
    host.dispatch("fanotes:sync-write-secrets", &[json!(null)])
        .unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());

    fs::write(app.join("sync/account.secret"), "plain1:alt").unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());
    assert!(!app.join("sync/account.secret").exists());
}
