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
fn a_missing_sync_payload_does_not_clear_the_saved_login() {
    let (_vault, app, mut host) = host();
    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    host.dispatch(
        "fanotes:sync-write-state",
        &[json!(id), json!("{\"version\":1}")],
    )
    .unwrap();
    let state_path = app.join(format!("sync/state-{id}.json"));
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id)])
            .unwrap_err(),
        "Der Sync-Zustand ist ungültig."
    );
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!("nope")])
            .unwrap_err(),
        "Ungültige Vault-ID."
    );
    assert!(state_path.is_file());
    host.dispatch("fanotes:sync-write-state", &[json!(id), json!(null)])
        .unwrap();
    assert!(!state_path.exists());

    let secret = "{\"token\":\"geheim\"}";
    host.dispatch("fanotes:sync-write-secrets", &[json!(secret)])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-write-secrets", &[]).unwrap_err(),
        "Die Sync-Anmeldedaten sind ungültig."
    );
    assert_eq!(
        host.dispatch("fanotes:sync-write-secrets", &[json!(1)])
            .unwrap_err(),
        "Die Sync-Anmeldedaten sind ungültig."
    );
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[]).unwrap(),
        secret
    );
    host.dispatch("fanotes:sync-write-secrets", &[json!(null)])
        .unwrap();
    assert!(host
        .dispatch("fanotes:sync-read-secrets", &[])
        .unwrap()
        .is_null());
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
    let from_list = host
        .dispatch(
            "fanotes:sync-write",
            &[
                json!("Seite.md"),
                json!("SGFsbG8K"),
                json!([1_600_000_000_000i64]),
            ],
        )
        .unwrap();
    assert_eq!(from_list["mtimeMs"], 1_600_000_000_000i64);
    let before_ignored = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let ignored_list = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K"), json!([1, 2])],
        )
        .unwrap();
    let ignored_object = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K"), json!({})],
        )
        .unwrap();
    let after_ignored = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for stamped in [
        ignored_list["mtimeMs"].as_i64().unwrap(),
        ignored_object["mtimeMs"].as_i64().unwrap(),
    ] {
        assert!(stamped >= before_ignored.saturating_sub(5_000), "{stamped}");
        assert!(stamped <= after_ignored.saturating_add(5_000), "{stamped}");
    }
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
fn a_sync_write_accepts_a_byte_list_like_the_desktop() {
    let (vault, _app, mut host) = host();
    let written = host
        .dispatch(
            "fanotes:sync-write",
            &[
                json!("Seite.md"),
                json!([72, 97, 108, 108, 111, 10, 1.9, -1, 256]),
            ],
        )
        .unwrap();
    assert_eq!(written["size"], 9);
    assert_eq!(
        fs::read(vault.join("Seite.md")).unwrap(),
        [72, 97, 108, 108, 111, 10, 1, 255, 0]
    );
    host.dispatch("fanotes:sync-write", &[json!("leer.md"), json!([])])
        .unwrap();
    assert_eq!(fs::read(vault.join("leer.md")).unwrap(), b"");
    assert_eq!(
        host.dispatch("fanotes:sync-write", &[json!("Seite.md"), json!(5)])
            .unwrap_err(),
        "Der Sync-Inhalt muss binär sein."
    );
}

#[test]
fn a_sync_state_directory_is_private() {
    let (_vault, app, mut host) = host();
    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    host.dispatch(
        "fanotes:sync-write-state",
        &[json!(id), json!("{\"ok\":true}")],
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(app.join("sync")).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    host.dispatch("fanotes:sync-write-secrets", &[json!("login")])
        .unwrap();
    assert!(app.join("sync/account.secret").is_file());
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

#[cfg(unix)]
#[test]
fn a_missing_sync_file_uses_the_desktop_lstat_error() {
    use std::os::unix::fs::PermissionsExt;
    let (vault, _app, mut host) = host();
    let root = fs::canonicalize(&vault).unwrap();
    let missing = root.join("fehlt.md");
    assert_eq!(
        host.dispatch("fanotes:sync-read", &[json!("fehlt.md")])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
    assert_eq!(
        host.dispatch("fanotes:sync-read", &[json!("Fehlt/Seite.md")])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            root.join("Fehlt").display()
        )
    );
    let long_name = format!("{}.md", "ä".repeat(300));
    assert_eq!(
        host.dispatch("fanotes:sync-read", &[json!(long_name.clone())])
            .unwrap_err(),
        format!(
            "ENAMETOOLONG: name too long, lstat '{}'",
            root.join(long_name).display()
        )
    );
    let hidden = root.join("Geheim");
    fs::create_dir(&hidden).unwrap();
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(hidden.clone());
    assert_eq!(
        host.dispatch("fanotes:sync-read", &[json!("Geheim/Seite.md")])
            .unwrap_err(),
        format!(
            "EACCES: permission denied, lstat '{}'",
            hidden.join("Seite.md").display()
        )
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_sync_state_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (_vault, app, mut host) = host();
    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    host.dispatch(
        "fanotes:sync-write-state",
        &[json!(id), json!("{\"version\":1}")],
    )
    .unwrap();
    let state = app.join(format!("sync/state-{id}.json"));
    fs::set_permissions(&state, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf, u32);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(self.1));
        }
    }
    let _restore_state = Restore(state.clone(), 0o600);
    assert_eq!(
        host.dispatch("fanotes:sync-read-state", &[json!(id)])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", state.display())
    );
    fs::set_permissions(&state, fs::Permissions::from_mode(0o600)).unwrap();
    let sync_dir = app.join("sync");
    fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o000)).unwrap();
    let _restore_dir = Restore(sync_dir, 0o700);
    assert_eq!(
        host.dispatch("fanotes:sync-read-state", &[json!(id)])
            .unwrap_err(),
        format!("EACCES: permission denied, lstat '{}'", state.display())
    );
    fs::set_permissions(app.join("sync"), fs::Permissions::from_mode(0o700)).unwrap();
    let secret = app.join("sync/account.secret");
    fs::write(&secret, b"safe1:aaaa").unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();
    let _restore_secret = Restore(secret.clone(), 0o600);
    assert_eq!(
        host.dispatch("fanotes:sync-read-secrets", &[])
            .unwrap_err(),
        format!("EACCES: permission denied, open '{}'", secret.display())
    );
}

#[cfg(unix)]
#[test]
fn an_undeletable_sync_state_uses_the_desktop_rm_error() {
    use std::os::unix::fs::PermissionsExt;
    let (_vault, app, mut host) = host();
    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    host.dispatch(
        "fanotes:sync-write-state",
        &[json!(id), json!("{\"version\":1}")],
    )
    .unwrap();
    let state = app.join(format!("sync/state-{id}.json"));
    let sync_dir = app.join("sync");
    fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf, u32);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(self.1));
        }
    }
    let _restore_dir = Restore(sync_dir.clone(), 0o700);
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id), json!(null)])
            .unwrap_err(),
        format!("EACCES: permission denied, lstat '{}'", state.display())
    );
    fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o555)).unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id), json!(null)])
            .unwrap_err(),
        format!("EACCES: permission denied, unlink '{}'", state.display())
    );
    fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(state.is_file());
    fs::remove_file(&state).unwrap();
    fs::create_dir(&state).unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id), json!(null)])
            .unwrap_err(),
        format!(
            "Path is a directory: rm returned EISDIR (is a directory) {}",
            state.display()
        )
    );
    assert!(state.is_dir());
    let secret = app.join("sync/account.secret");
    fs::write(&secret, b"safe1:aaaa").unwrap();
    fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o555)).unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-write-secrets", &[json!(null)])
            .unwrap_err(),
        format!("EACCES: permission denied, unlink '{}'", secret.display())
    );
    fs::set_permissions(&sync_dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(secret.is_file());
}

#[cfg(unix)]
#[test]
fn an_unwritable_sync_folder_uses_a_sixteen_hex_temporary_name() {
    use std::os::unix::fs::PermissionsExt;
    let (vault, _app, mut host) = host();
    let vault = fs::canonicalize(&vault).unwrap();
    fs::write(vault.join("Seite.md"), b"alt\n").unwrap();
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(vault.clone());
    let error = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K")],
        )
        .unwrap_err();
    let prefix = format!(
        "EACCES: permission denied, open '{}/.Seite.md.{}.",
        vault.display(),
        std::process::id()
    );
    assert!(error.starts_with(&prefix), "{error}");
    let suffix = error[prefix.len()..].trim_end_matches(".tmp'");
    assert_eq!(suffix.len(), 16, "{error}");
    assert!(
        suffix.chars().all(|character| character.is_ascii_hexdigit()),
        "{error}"
    );
    assert!(error.ends_with(".tmp'"), "{error}");
    fs::set_permissions(&vault, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(fs::read(vault.join("Seite.md")).unwrap(), b"alt\n");
}

#[test]
fn a_sync_write_onto_a_directory_reports_the_desktop_rename_error() {
    let (vault, _app, mut host) = host();
    let vault = fs::canonicalize(&vault).unwrap();
    let target = vault.join("Seite.md");
    fs::create_dir(&target).unwrap();
    let error = host
        .dispatch(
            "fanotes:sync-write",
            &[json!("Seite.md"), json!("SGFsbG8K")],
        )
        .unwrap_err();
    let prefix = format!(
        "EISDIR: illegal operation on a directory, rename '{}/.Seite.md.{}.",
        vault.display(),
        std::process::id()
    );
    assert!(error.starts_with(&prefix), "{error}");
    let hex = error[prefix.len()..].split(".tmp'").next().unwrap();
    assert_eq!(hex.len(), 16, "{error}");
    assert!(hex.chars().all(|character| character.is_ascii_hexdigit()), "{error}");
    assert!(
        error.ends_with(&format!(".tmp' -> '{}'", target.display())),
        "{error}"
    );
    assert!(target.is_dir());
    let leftovers: Vec<_> = fs::read_dir(&vault)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[cfg(unix)]
#[test]
fn an_unwritable_sync_folder_reports_the_desktop_unlink_error() {
    use std::os::unix::fs::PermissionsExt;
    let (vault, app, mut host) = host();
    let vault = fs::canonicalize(&vault).unwrap();
    host.trash_dir = Some(app.join("trash"));
    let folder = vault.join("Mathe");
    fs::create_dir(&folder).unwrap();
    let note = folder.join("Seite.md");
    fs::write(&note, b"Hallo\n").unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(folder.clone());
    assert_eq!(
        host.dispatch("fanotes:sync-remove", &[json!("Mathe/Seite.md")])
            .unwrap_err(),
        format!("EACCES: permission denied, unlink '{}'", note.display())
    );
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(fs::read(&note).unwrap(), b"Hallo\n");
}

#[cfg(unix)]
#[test]
fn an_unwritable_sync_parent_reports_the_desktop_mkdir_error() {
    use std::os::unix::fs::PermissionsExt;
    let (vault, _app, mut host) = host();
    let vault = fs::canonicalize(&vault).unwrap();
    let folder = vault.join("Mathe");
    fs::create_dir(&folder).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(folder.clone());
    let created = folder.join("Neu");
    assert_eq!(
        host.dispatch(
            "fanotes:sync-write",
            &[json!("Mathe/Neu/Seite.md"), json!("SGFsbG8K")],
        )
        .unwrap_err(),
        format!("EACCES: permission denied, mkdir '{}'", created.display())
    );
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!created.exists());
    assert!(!created.join("Seite.md").exists());
}

#[cfg(unix)]
#[test]
fn a_nested_sync_folder_reports_the_full_desktop_mkdir_path() {
    use std::os::unix::fs::PermissionsExt;
    let (vault, _app, mut host) = host();
    let vault = fs::canonicalize(&vault).unwrap();
    let folder = vault.join("Mathe");
    fs::create_dir(&folder).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(folder.clone());
    let created = folder.join("Neu/Tief");
    assert_eq!(
        host.dispatch(
            "fanotes:sync-write",
            &[json!("Mathe/Neu/Tief/Seite.md"), json!("SGFsbG8K")],
        )
        .unwrap_err(),
        format!("EACCES: permission denied, mkdir '{}'", created.display())
    );
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!folder.join("Neu").exists());
}

#[cfg(unix)]
#[test]
fn an_unwritable_sync_profile_reports_the_desktop_mkdir_error() {
    use std::os::unix::fs::PermissionsExt;
    let (_vault, app, mut host) = host();
    let id = host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let sync_dir = app.join("sync");
    assert!(!sync_dir.exists());
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(app.clone());
    fs::set_permissions(&app, fs::Permissions::from_mode(0o555)).unwrap();
    let payload = json!("{\"ok\":true}");
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id), payload.clone()])
            .unwrap_err(),
        format!(
            "EACCES: permission denied, mkdir '{}'",
            sync_dir.display()
        )
    );
    assert!(!sync_dir.exists());

    fs::set_permissions(&app, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&sync_dir, b"datei").unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id), payload.clone()])
            .unwrap_err(),
        format!("EEXIST: file already exists, mkdir '{}'", sync_dir.display())
    );
    assert_eq!(fs::read(&sync_dir).unwrap(), b"datei");
    fs::remove_file(&sync_dir).unwrap();

    std::os::unix::fs::symlink("missing-sync-target", &sync_dir).unwrap();
    assert_eq!(
        host.dispatch("fanotes:sync-write-state", &[json!(id), payload.clone()])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, mkdir '{}'",
            sync_dir.display()
        )
    );
    assert!(sync_dir.symlink_metadata().unwrap().file_type().is_symlink());
    fs::remove_file(&sync_dir).unwrap();

    let elsewhere = app.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &sync_dir).unwrap();
    host.dispatch("fanotes:sync-write-state", &[json!(id), payload])
        .unwrap();
    assert!(elsewhere.join(format!("state-{id}.json")).is_file());
    assert!(sync_dir.symlink_metadata().unwrap().file_type().is_symlink());
}
