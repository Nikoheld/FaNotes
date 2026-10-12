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
fn a_non_object_settings_save_keeps_the_current_settings() {
    let (_app, mut host) = host();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "theme": "midnight", "openAiApiKey": "sk-keep" })],
    )
    .unwrap();
    let kept = host
        .dispatch("fanotes:save-settings", &[json!(1)])
        .unwrap();
    assert_eq!(kept["theme"], "midnight");
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        "sk-keep"
    );
    let cleared = host
        .dispatch(
            "fanotes:save-settings",
            &[json!([]), json!({ "clearProtectedSecrets": true })],
        )
        .unwrap();
    assert_eq!(cleared["theme"], "midnight");
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        ""
    );
}

#[test]
fn a_long_umlaut_secret_is_kept() {
    let (_app, mut host) = host();
    let secret = "Ä".repeat(2100);
    assert!(secret.len() > 4096);
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "openAiApiKey": secret })],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[]).unwrap()["openAiApiKey"],
        secret
    );
    let homework = "Ä".repeat(200);
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "homeworkApiSecret": homework })],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[]).unwrap()["homeworkApiSecret"],
        homework
    );
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "homeworkApiSecret": "Ä".repeat(257) })],
    )
    .unwrap();
    assert_eq!(
        host.dispatch("fanotes:load-secure-settings", &[]).unwrap()["homeworkApiSecret"],
        homework
    );
}

#[test]
fn a_german_device_name_keeps_its_umlauts() {
    let (_app, mut host) = host();
    let name = "Ä".repeat(50);
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({ "syncDeviceName": name })],
        )
        .unwrap();
    assert_eq!(saved["syncDeviceName"], name);
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({ "syncDeviceName": "Ä".repeat(81) })],
        )
        .unwrap();
    assert_eq!(saved["syncDeviceName"], name);
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
fn resetting_app_data_waits_for_the_next_launch_and_keeps_the_vault() {
    let (app, mut host) = host();
    let vault = app.parent().unwrap().join("vault");
    fs::write(vault.join("Seite.md"), b"bleibt\n").unwrap();
    fs::write(app.join("sync-state-extra.txt"), b"weg").unwrap();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "theme": "midnight", "openAiApiKey": "sk-reset" })],
    )
    .unwrap();
    let result = host.dispatch("fanotes:reset-app-data", &[]).unwrap();
    assert_eq!(result["restarting"], true);
    assert!(app.join("settings.json").is_file());
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    assert!(marker.is_file());
    let marker_text = fs::read_to_string(&marker).unwrap();
    assert!(marker_text.ends_with('\n'), "{marker_text}");
    assert_eq!(marker_text.chars().filter(|character| *character == '\n').count(), 1);
    let parsed: serde_json::Value = serde_json::from_str(marker_text.trim_end()).unwrap();
    assert_eq!(parsed["version"], json!(1));
    assert!(parsed["userDataPath"].as_str().unwrap().ends_with("app"));
    assert!(parsed["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        host.dispatch("fanotes:reset-app-data", &[]).unwrap()["restarting"],
        true
    );

    let mut reopened = Host::open(app.clone());
    reopened.secret_store = SecretStore::Memory;
    assert!(!app.join("settings.json").exists());
    assert!(!app.join("sync-state-extra.txt").exists());
    assert!(!app.join(".fanotes-reset-complete").exists());
    assert!(app.join(".fanotes-legacy-migration-v1-complete").is_file());
    assert!(!marker.exists());
    assert_eq!(fs::read(vault.join("Seite.md")).unwrap(), b"bleibt\n");
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        ""
    );
    assert_ne!(
        reopened.dispatch("fanotes:bootstrap", &[]).unwrap()["settings"]["theme"],
        "midnight"
    );
}

#[test]
fn a_stale_reset_marker_does_not_wipe_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"2000-01-01T00:00:00.000Z"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let mut reopened = Host::open(app.clone());
    reopened.secret_store = SecretStore::Memory;
    assert!(app.join("settings.json").is_file());
    assert!(!marker.exists());
    assert_eq!(
        reopened.dispatch("fanotes:bootstrap", &[]).unwrap()["settings"]["theme"],
        "midnight"
    );
}

#[test]
fn a_reset_marker_resolves_parent_segments_and_a_trailing_slash() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let parent = app.parent().unwrap();
    let via_parent = parent.join("other").join("..").join("app");
    let marker = parent.join(".fanotes-reset-pending.json");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}/","createdAt":"2026-10-12T03:00:00.000Z"}}"#,
            via_parent.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
    assert!(app.join(".fanotes-legacy-migration-v1-complete").is_file());
}

#[test]
fn a_reset_marker_version_of_one_point_zero_still_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1.0,"userDataPath":"{}","createdAt":"2026-10-12T03:00:00.000Z"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_symlinked_reset_marker_is_discarded() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    std::os::unix::fs::symlink(app.parent().unwrap().join("missing-target"), &marker).unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file());
    assert!(fs::symlink_metadata(&marker).is_err());
}

#[test]
fn a_broken_reset_marker_stays_until_it_can_be_read() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    fs::write(&marker, b"{").unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file());
    assert_eq!(fs::read(&marker).unwrap(), b"{");
    let mut reopened = Host::open(app.clone());
    assert_eq!(
        reopened.dispatch("fanotes:bootstrap", &[]).unwrap()["settings"]["theme"],
        "midnight"
    );
}

#[test]
fn a_reset_marker_with_a_bad_byte_still_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let mut bytes = format!(
        r#"{{"version":1,"userDataPath":"{}","createdAt":"2026-10-12T03:00:00.000Z","note":"NOTEMARK"}}"#,
        user_data.display()
    )
    .into_bytes();
    let needle = b"NOTEMARK";
    let index = bytes
        .windows(needle.len())
        .position(|window| window == needle)
        .unwrap();
    bytes[index] = 0xff;
    fs::write(&marker, bytes).unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn an_upgrade_turns_experimental_handwriting_off_once() {
    let dir = std::env::temp_dir().join(format!("fanotes-settings-gate-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let app = dir.join("app");
    let vault = dir.join("vault");
    fs::create_dir_all(&app).unwrap();
    fs::create_dir_all(&vault).unwrap();
    fs::write(
        app.join("settings.json"),
        r#"{"theme":"midnight","experimentalHandwritingToText":true,"experimentalHandwritingToTextSeenVersion":"2020.1.0"}"#,
    )
    .unwrap();
    let mut host = Host::open(app.clone());
    host.secret_store = SecretStore::Memory;
    host.set_vault(vault).unwrap();
    let version = host.dispatch("fanotes:update-get-state", &[]).unwrap()["currentVersion"]
        .as_str()
        .unwrap()
        .to_owned();
    let settings = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(settings["settings"]["theme"], "midnight");
    assert_eq!(settings["settings"]["experimentalHandwritingToText"], false);
    assert_eq!(
        settings["settings"]["experimentalHandwritingToTextSeenVersion"],
        version
    );
    let disk = fs::read_to_string(app.join("settings.json")).unwrap();
    assert!(disk.contains(&version));
    assert!(!disk.contains("2020.1.0"));

    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({
                "theme": "midnight",
                "experimentalHandwritingToText": true,
                "experimentalHandwritingToTextSeenVersion": "2020.1.0"
            })],
        )
        .unwrap();
    assert_eq!(saved["experimentalHandwritingToText"], false);

    host.dispatch(
        "fanotes:save-settings",
        &[json!({
            "theme": "midnight",
            "experimentalHandwritingToText": true,
            "experimentalHandwritingToTextSeenVersion": version
        })],
    )
    .unwrap();
    let mut reopened = Host::open(app);
    reopened.secret_store = SecretStore::Memory;
    assert_eq!(
        reopened.dispatch("fanotes:bootstrap", &[]).unwrap()["settings"]
            ["experimentalHandwritingToText"],
        true
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

#[test]
fn a_folder_setting_trims_a_byte_order_mark_and_keeps_a_next_line() {
    let (_app, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({
                "defaultFolder": "\u{FEFF}Mathe",
                "customCss": "\u{FEFF}"
            })],
        )
        .unwrap();
    assert_eq!(saved["defaultFolder"], "Mathe");
    assert_eq!(saved["customCss"], "");

    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({
                "defaultFolder": "\u{0085}Mathe",
                "customCss": "\u{0085}"
            })],
        )
        .unwrap();
    assert_eq!(saved["defaultFolder"], "\u{0085}Mathe");
    assert_eq!(saved["customCss"], "\u{0085}");
}

#[test]
fn a_settings_file_with_a_bad_byte_still_loads() {
    let dir = std::env::temp_dir().join(format!(
        "fanotes-settings-byte-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    let mut bytes = br#"{"syncDeviceName":"LaXptop"}"#.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(app.join("settings.json"), &bytes).unwrap();
    let mut host = Host::open(app);
    host.secret_store = SecretStore::Memory;
    let boot = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(boot["settings"]["syncDeviceName"], "La\u{FFFD}ptop");
}

#[test]
fn custom_css_rejects_an_expression_after_a_byte_order_mark() {
    let (_app, mut host) = host();
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({ "customCss": "div{color:expression\u{FEFF}(alert(1))}" })],
        )
        .unwrap();
    assert_eq!(saved["customCss"], "");
    let saved = host
        .dispatch(
            "fanotes:save-settings",
            &[json!({ "customCss": "div{color:expression\u{0085}(alert(1))}" })],
        )
        .unwrap();
    assert!(saved["customCss"].as_str().unwrap().contains("expression"));
}
