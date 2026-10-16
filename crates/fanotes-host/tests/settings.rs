use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::{Host, SecretStore};
use serde_json::json;

fn fresh_local_date() -> (i32, u32, u32) {
    // Date-only reset markers are local midnight. A fixed October day ages out
    // of the 24 hour window and stops proving that the form is accepted.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as libc::time_t;
    let mut time = unsafe { std::mem::zeroed::<libc::tm>() };
    unsafe {
        libc::localtime_r(&seconds, &mut time);
    }
    (
        (time.tm_year + 1900) as i32,
        (time.tm_mon + 1) as u32,
        time.tm_mday as u32,
    )
}

/// The first day of next month stays inside `Date.parse`'s future, so a
/// year-month marker does not age out of the 24 hour window.
fn fresh_future_year_month() -> (i32, u32) {
    let (year, month, _) = fresh_local_date();
    if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    }
}

fn month_abbrev(month: u32) -> &'static str {
    [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][(month as usize) - 1]
}

fn fresh_reset_time() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let days = (ms / 86_400_000) as i64;
    let tod = ms % 86_400_000;
    let hour = tod / 3_600_000;
    let minute = (tod % 3_600_000) / 60_000;
    let second = (tod % 60_000) / 1_000;
    let millis = tod % 1_000;
    let (year, month, day) = civil_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`, with day 0 at 1970-01-01.
fn civil_date(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (year as i32, month as u32, day as u32)
}

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
fn a_whole_setting_is_stored_like_javascript() {
    let (app, mut host) = host();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "editorFontSize": 18, "smoothing": 0 })],
    )
    .unwrap();
    let settings = fs::read_to_string(app.join("settings.json")).unwrap();
    assert!(
        settings.contains("\"editorFontSize\": 18\n") || settings.contains("\"editorFontSize\": 18,"),
        "{settings}"
    );
    assert!(
        settings.contains("\"smoothing\": 0\n") || settings.contains("\"smoothing\": 0,"),
        "{settings}"
    );
    assert!(!settings.contains("18.0"), "{settings}");
    assert!(!settings.contains("\"smoothing\": 0.0"), "{settings}");
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
fn an_api_key_follows_the_resolved_profile_path() {
    let (app, mut host) = host();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "openAiApiKey": "sk-same-profile" })],
    )
    .unwrap();
    let parent = app.parent().unwrap();
    let spelled = std::path::PathBuf::from(format!(
        "{}/",
        parent.join("other").join("..").join("app").display()
    ));
    let mut reopened = Host::open(spelled);
    reopened.secret_store = SecretStore::Memory;
    assert_eq!(
        reopened
            .dispatch("fanotes:load-secure-settings", &[])
            .unwrap()["openAiApiKey"],
        "sk-same-profile"
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
            r#"{{"version":1,"userDataPath":"{}/","createdAt":"{}"}}"#,
            via_parent.display(),
            fresh_reset_time()
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
            r#"{{"version":1.0,"userDataPath":"{}","createdAt":"{}"}}"#,
            user_data.display(),
            fresh_reset_time()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_date_only_reset_marker_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = &fresh_reset_time()[..10];
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_numeric_offset_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().replace('Z', "+00:00");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_without_seconds_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let full = fresh_reset_time();
    let (date, rest) = full.split_once('T').unwrap();
    let mut parts = rest.split(':');
    let hour = parts.next().unwrap();
    let minute = parts.next().unwrap();
    let created = format!("{date}T{hour}:{minute}Z");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_extra_fraction_digits_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().replace('Z', "9Z");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_space_instead_of_t_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().replacen('T', " ", 1);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists());
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_tab_instead_of_t_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().replacen('T', "\\t", 1);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_date_only_reset_marker_with_trailing_space_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = format!("{} ", &fresh_reset_time()[..10]);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_trailing_space_after_t_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = format!("{} ", fresh_reset_time());
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_without_a_zone_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().trim_end_matches('Z').to_string();
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_year_and_month_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let (year, month) = fresh_future_year_month();
    let created = format!("{year:04}-{month:02}");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_year_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let (year, _, _) = fresh_local_date();
    let created = format!("{}", year + 1);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_year_and_month_before_the_clock_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let (year, month) = fresh_future_year_month();
    let created = format!("{year:04}-{month:02}T00:00:00Z");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_one_digit_month_before_the_clock_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = "2026-1T00:00:00Z";
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_slashes_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let (year, month, day) = fresh_local_date();
    let created = format!("{year}/{month:02}/{day:02}");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_month_name_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let (year, month, day) = fresh_local_date();
    let created = format!("{} {day}, {year}", month_abbrev(month));
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_at_four_pm_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let (year, month, day) = fresh_local_date();
    let created = format!("{} {day}, {year} 4:00 PM", month_abbrev(month));
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_named_zone_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = "2027-01-01 16:00 EST";
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_second_sixty_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let full = fresh_reset_time();
    let (date_clock, fraction) = full.split_once('.').unwrap();
    let (prefix, _second) = date_clock.rsplit_once(':').unwrap();
    let created = format!("{prefix}:60.{fraction}");
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_day_thirty_two_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = "2099-10-32";
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_at_hour_twenty_four_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = format!("{}T24:00:00.000Z", &fresh_reset_time()[..10]);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_at_hour_twenty_four_with_a_later_fraction_digit_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = format!("{}T24:00:00.0001Z", &fresh_reset_time()[..10]);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_three_digit_hour_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().replacen('T', "T0", 1);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_three_digit_month_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = fresh_reset_time().replacen('-', "-0", 1);
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_a_five_digit_year_keeps_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = format!("0{}", fresh_reset_time());
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(app.join("settings.json").is_file(), "{created}");
    assert!(!marker.exists());
}

#[test]
fn a_reset_marker_with_an_expanded_year_wipes_the_profile() {
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let user_data = std::path::absolute(&app).unwrap();
    let marker = app.parent().unwrap().join(".fanotes-reset-pending.json");
    let created = format!("+00{}", fresh_reset_time());
    fs::write(
        &marker,
        format!(
            r#"{{"version":1,"userDataPath":"{}","createdAt":"{created}"}}"#,
            user_data.display()
        ),
    )
    .unwrap();
    let _ = Host::open(app.clone());
    assert!(!app.join("settings.json").exists(), "{created}");
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
        r#"{{"version":1,"userDataPath":"{}","createdAt":"{}","note":"NOTEMARK"}}"#,
        user_data.display(),
        fresh_reset_time()
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

#[cfg(unix)]
#[test]
fn an_unwritable_profile_keeps_the_saved_theme_and_reports_the_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (app, mut host) = host();
    host.dispatch("fanotes:save-settings", &[json!({ "theme": "midnight" })])
        .unwrap();
    let saved = fs::read_to_string(app.join("settings.json")).unwrap();
    fs::set_permissions(&app, fs::Permissions::from_mode(0o555)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(self.0.parent().unwrap_or(&self.0));
        }
    }
    let _restore = Restore(app.clone());
    let error = host
        .dispatch("fanotes:save-settings", &[json!({ "theme": "light" })])
        .unwrap_err();
    let app = fs::canonicalize(&app).unwrap();
    let prefix = format!(
        "EACCES: permission denied, open '{}/.settings.json.{}.",
        app.display(),
        std::process::id()
    );
    assert!(error.starts_with(&prefix), "{error}");
    let hex = error[prefix.len()..].trim_end_matches(".tmp'");
    assert_eq!(hex.len(), 20, "{error}");
    assert!(
        hex.chars().all(|character| character.is_ascii_hexdigit()),
        "{error}"
    );
    assert!(error.ends_with(".tmp'"), "{error}");
    assert_eq!(
        host.dispatch("fanotes:bootstrap", &[]).unwrap()["settings"]["theme"],
        "midnight"
    );
    assert_eq!(fs::read_to_string(app.join("settings.json")).unwrap(), saved);
}
