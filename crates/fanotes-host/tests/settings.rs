use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> (std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-settings-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(dir.join("app"));
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
}
