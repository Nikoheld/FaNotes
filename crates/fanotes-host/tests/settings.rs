use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::{Host, SecretStore};
use serde_json::json;

fn host() -> (std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-settings-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.secret_store = SecretStore::Memory;
    host.set_vault(vault).unwrap();
    (dir.join("app"), host)
}

#[test]
fn invalid_settings_stay_on_the_previous_value() {
    let (app, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({
                "theme": "midnight",
                "paperStyle": "nope",
                "editorFontSize": 99,
                "memoryBudgetMb": 100,
                "defaultFolder": "../secret",
                "customCss": "body { background: url(https://evil.test/x) }",
                "unknown": true,
                "openAiApiKey": "sk-live-secret"
            })],
        )
        .unwrap();
    assert_eq!(saved["theme"], "midnight");
    assert_eq!(saved["paperStyle"], "dots");
    assert_eq!(saved["editorFontSize"], 16);
    assert_eq!(saved["memoryBudgetMb"], 0);
    assert_eq!(saved["defaultFolder"], "Eingang");
    assert_eq!(saved["customCss"], "");
    assert!(saved.get("unknown").is_none());
    assert_eq!(saved["openAiApiKey"], "");
    let settings = fs::read_to_string(app.join("settings.json")).unwrap();
    assert!(!settings.contains("sk-live-secret"));
    assert!(!settings.contains("unknown"));
    let secrets = host.dispatch("fanotes:load-secure-settings", &[]).unwrap();
    assert_eq!(secrets["openAiApiKey"], "sk-live-secret");

    let mut reopened = Host::open(app.clone());
    reopened.secret_store = SecretStore::Memory;
    reopened
        .set_vault(app.parent().unwrap().join("vault"))
        .unwrap();
    reopened
        .dispatch(
            "fanotes:save-settings",
            &[json!({ "lastOpenNotePath": "Mathe/Seite.md", "openAiApiKey": "" })],
        )
        .unwrap();
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        "sk-live-secret"
    );
    reopened
        .dispatch("fanotes:save-settings", &[json!({ "openAiApiKey": "" })])
        .unwrap();
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        ""
    );
    assert!(!app.join("secrets.json").exists());
}

#[test]
fn api_keys_from_a_plaintext_file_move_into_the_secret_store() {
    let (app, mut host) = host();
    fs::write(
        app.join("secrets.json"),
        r#"{"openAiApiKey":"sk-from-disk"}"#,
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[]).unwrap()["openAiApiKey"],
        "sk-from-disk"
    );
    assert!(!app.join("secrets.json").exists());
    let mut reopened = Host::open(app.clone());
    reopened.secret_store = SecretStore::Memory;
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        "sk-from-disk"
    );
}

#[test]
fn a_missing_keyring_does_not_store_api_keys_in_the_profile() {
    let dir = std::env::temp_dir().join(format!("fanotes-settings-locked-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.secret_store = SecretStore::Unavailable;
    host.set_vault(vault).unwrap();
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({ "theme": "midnight", "openAiApiKey": "sk-unavailable" })],
        )
        .unwrap();
    assert_eq!(saved["theme"], "midnight");
    assert_eq!(saved["openAiApiKey"], "");
    let settings = fs::read_to_string(app.join("settings.json")).unwrap();
    assert!(settings.contains("midnight"));
    assert!(!settings.contains("sk-unavailable"));
    assert!(!app.join("secrets.json").exists());
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[]).unwrap()["openAiApiKey"],
        ""
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn os_keyring_stores_an_api_key_when_the_session_bus_is_up() {
    let dir = std::env::temp_dir().join(format!("fanotes-settings-os-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("vault")).unwrap();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.set_vault(dir.join("vault")).unwrap();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "openAiApiKey": "sk-os-keyring" })],
    )
    .unwrap();
    let settings = fs::read_to_string(app.join("settings.json")).unwrap();
    assert!(!settings.contains("sk-os-keyring"));
    assert!(!app.join("secrets.json").exists());
    let loaded = host.dispatch("fanotes:load-secure-settings", &[]).unwrap();
    let required = std::env::var_os("FANOTES_REQUIRE_KEYRING").is_some();
    if loaded["openAiApiKey"] == "" {
        assert!(!required, "the session keyring did not keep the API key");
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    assert_eq!(loaded["openAiApiKey"], "sk-os-keyring");
    let mut reopened = Host::open(app.clone());
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        "sk-os-keyring"
    );
    reopened
        .dispatch("fanotes:save-settings", &[json!({ "openAiApiKey": "" })])
        .unwrap();
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        ""
    );
    let _ = fs::remove_dir_all(&dir);
}
