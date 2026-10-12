use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::{Host, SecretStore};
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
    host.secret_store = SecretStore::Memory;
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
    let stored = fs::read_to_string(app.join("sync/account.secret")).unwrap();
    assert_eq!(stored, "safe1:");
    assert!(!stored.contains("geheim"));
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

    let legacy = "{\"v\":1,\"token\":\"alt\"}";
    fs::write(app.join("sync/account.secret"), legacy).unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[]).unwrap(),
        legacy
    );
    assert_eq!(
        fs::read_to_string(app.join("sync/account.secret")).unwrap(),
        "safe1:"
    );
}

#[test]
fn a_blank_sync_secret_file_has_no_login() {
    let (_vault, app, mut host) = host();
    fs::create_dir_all(app.join("sync")).unwrap();
    fs::write(app.join("sync/account.secret"), "").unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());
    assert_eq!(
        fs::read_to_string(app.join("sync/account.secret")).unwrap(),
        ""
    );

    fs::write(app.join("sync/account.secret"), " \n\t").unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());

    fs::write(app.join("sync/account.secret"), "safe1:").unwrap();
    let error = host.dispatch("fanotes:sync-read-secrets", &[]).unwrap_err();
    assert!(error.contains("Schlüsselbund"), "{error}");
}

#[test]
fn a_sync_secret_file_with_a_bad_byte_still_opens() {
    let (_vault, app, mut host) = host();
    fs::create_dir_all(app.join("sync")).unwrap();
    let path = app.join("sync/account.secret");

    fs::write(&path, b"\xff").unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());
    assert_eq!(fs::read(&path).unwrap(), b"\xff");

    fs::write(&path, "\u{FEFF}").unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());
    assert_eq!(fs::read_to_string(&path).unwrap(), "\u{FEFF}");

    fs::write(&path, b"safe1:\xff").unwrap();
    let error = host.dispatch("fanotes:sync-read-secrets", &[]).unwrap_err();
    assert!(error.contains("Schlüsselbund"), "{error}");

    let secret = "{\"v\":1,\"token\":\"geheim\"}";
    fs::write(&path, b"safe1:").unwrap();
    host.dispatch("fanotes:sync-write-secrets", &[json!(secret)])
        .unwrap();
    fs::write(&path, b"safe1:\xff").unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[]).unwrap(),
        secret
    );

    fs::write(&path, b"plain1:\xff").unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());
    assert!(!path.exists());
    fs::write(&path, b"safe1:").unwrap();
    let error = host.dispatch("fanotes:sync-read-secrets", &[]).unwrap_err();
    assert!(error.contains("Schlüsselbund"), "{error}");
}

#[test]
fn sync_credentials_keep_a_long_unicode_secret() {
    let (_vault, _app, mut host) = host();
    let kept = "Ä".repeat(40_000);
    assert!(kept.len() > 64 * 1024);
    assert!(kept.encode_utf16().count() <= 64 * 1024);
    host.dispatch("fanotes:sync-write-secrets", &[json!(kept)])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[]).unwrap(),
        kept
    );
    let too_long = "Ä".repeat(64 * 1024 + 1);
    let error = host
        .dispatch("fanotes:sync-write-secrets", &[json!(too_long)])
        .unwrap_err();
    assert!(error.contains("ungültig"), "{error}");
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[]).unwrap(),
        kept
    );
}

#[test]
fn sync_secrets_stay_out_of_the_profile_without_a_keyring() {
    let dir = std::env::temp_dir().join(format!("fanotes-sync-locked-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.secret_store = SecretStore::Unavailable;
    host.set_vault(vault).unwrap();
    let error = host
        .dispatch(
            "fanotes:sync-write-secrets",
            &[json!("{\"token\":\"geheim\"}")],
        )
        .unwrap_err();
    assert!(error.contains("Systemschlüsselbund"));
    assert!(!app.join("sync/account.secret").exists());
    fs::create_dir_all(app.join("sync")).unwrap();
    fs::write(app.join("sync/account.secret"), "safe1:Y2lwaGVy").unwrap();
    let error = host.dispatch("fanotes:sync-read-secrets", &[]).unwrap_err();
    assert!(error.contains("Schlüsselbund"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_sync_time_follows_javascript_number() {
    let (vault, _app, mut host) = host();
    let written = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K"), json!("1600000000000")],
        )
        .unwrap();
    assert_eq!(written["mtimeMs"], 1_600_000_000_000i64);
    let fractional = host
        .dispatch(
            "fanotes:sync-write",
            &[
                json!("Seite.md"),
                json!("SGFsbG8K"),
                json!(1_600_000_000_000.9_f64),
            ],
        )
        .unwrap();
    assert_eq!(fractional["mtimeMs"], 1_600_000_000_000i64);
    assert_eq!(fs::read(vault.join("Seite.md")).unwrap(), b"Hallo\n");

    let epoch = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K"), json!(0.9_f64)],
        )
        .unwrap();
    assert_eq!(epoch["mtimeMs"], 0);
    let from_text = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K"), json!("0.9")],
        )
        .unwrap();
    assert_eq!(from_text["mtimeMs"], 0);

    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let beyond_javascript = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K"), json!(1.0e16_f64)],
        )
        .unwrap();
    let after = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let stamped = beyond_javascript["mtimeMs"].as_i64().unwrap();
    assert!(stamped >= before.saturating_sub(5_000), "{stamped}");
    assert!(stamped <= after.saturating_add(5_000), "{stamped}");
}

#[test]
fn sync_write_keeps_the_requested_time_and_a_private_folder() {
    let (vault, _app, mut host) = host();
    let written = host
        .dispatch(
            "fanotes:sync-write",
            &[
                json!("Neu/Seite.md"),
                json!("SGFsbG8K"),
                json!(1_600_000_000_000i64),
            ],
        )
        .unwrap();
    assert_eq!(written["path"], "Neu/Seite.md");
    assert_eq!(written["size"], 6);
    assert_eq!(written["mtimeMs"], 1_600_000_000_000i64);
    assert_eq!(fs::read(vault.join("Neu/Seite.md")).unwrap(), b"Hallo\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(vault.join("Neu"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(vault.join("Neu/Seite.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn a_sync_state_with_a_bad_byte_still_loads() {
    let (_vault, app, mut host) = host();
    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    host.dispatch(
        "fanotes:sync-write-state",
        &[json!(id), json!("{\"note\":\"X\"}")],
    )
    .unwrap();
    let path = app.join(format!("sync/state-{id}.json"));
    let mut bytes = fs::read(&path).unwrap();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(&path, &bytes).unwrap();
    let state = host
        .dispatch("fanotes:sync-read-state", &[json!(id)])
        .unwrap();
    assert_eq!(state, "{\"note\":\"\u{FFFD}\"}");
}
