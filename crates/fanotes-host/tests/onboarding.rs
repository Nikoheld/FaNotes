use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::json;

fn host() -> (std::path::PathBuf, Host) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-onboarding-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join(".fanotes")).unwrap();
    fs::write(
        vault.join(".fanotes/onboarding.json"),
        "{\"version\":1,\"status\":\"pending\"}\n",
    )
    .unwrap();
    let mut host = Host::open(dir.join("app"));
    host.settings.insert("uiLanguage".to_owned(), json!("de"));
    host.set_vault(vault.clone()).unwrap();
    (vault, host)
}

#[test]
fn an_english_setup_leaves_a_german_subject_name_uncreated() {
    let (vault, mut english) = host();
    english
        .settings
        .insert("uiLanguage".to_owned(), json!("en"));
    let done = english
        .dispatch(
            "fanotes:complete-onboarding",
            &[json!(["Mathematik", "Physics", "AMAT"])],
        )
        .unwrap();
    assert_eq!(done["settings"]["defaultFolder"], "Inbox");
    assert_eq!(done["settings"]["dailyNotesFolder"], "Daily Notes");
    assert_eq!(done["settings"]["recognitionLanguage"], "en");
    assert!(vault.join("Inbox").is_dir());
    assert!(vault.join("Physics").is_dir());
    assert!(vault.join("AMAT").is_dir());
    assert!(!vault.join("Mathematik").exists());
    assert!(!vault.join("Eingang").exists());
    let tree = english.dispatch("fanotes:get-tree", &[]).unwrap();
    let physics = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Physics")
        .unwrap();
    assert_eq!(physics["color"], "#7c6a9a");
    let amat = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "AMAT")
        .unwrap();
    assert_eq!(amat["color"], "#9065b0");

    let (german_vault, mut german) = host();
    german
        .dispatch("fanotes:complete-onboarding", &[json!(["Physics"])])
        .unwrap();
    assert!(german_vault.join("Eingang").is_dir());
    assert!(!german_vault.join("Physics").exists());
    assert!(!german_vault.join("Inbox").exists());
}

#[test]
fn setup_still_answers_the_channels_the_desktop_leaves_open() {
    let (_vault, mut host) = host();
    assert_eq!(
        host.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        "Bitte schließe zuerst die FaNotes-Ersteinrichtung ab."
    );
    assert_eq!(
        host.dispatch("fanotes:write-file", &[json!(1), json!("Text")])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:write-file",
            &[json!("Willkommen.md"), json!("Neu\n")],
        )
        .unwrap_err(),
        "Bitte schließe zuerst die FaNotes-Ersteinrichtung ab."
    );
    assert_eq!(
        host.dispatch("fanotes:open-external", &[json!(1)])
            .unwrap_err(),
        "Ungültiger externer Link."
    );
    assert_eq!(
        host.dispatch("fanotes:capture-window", &[]).unwrap_err(),
        "Das Fensterbild ist ungültig."
    );
    assert!(host
        .dispatch("fanotes:enhanced-math-get-state", &[])
        .unwrap()
        .is_object());
    assert!(host
        .dispatch("fanotes:qwen-vision-get-state", &[])
        .unwrap()
        .is_object());
    assert!(host
        .dispatch("fanotes:load-secure-settings", &[])
        .unwrap()
        .is_object());
    assert!(host
        .dispatch("fanotes:addons-list", &[])
        .unwrap()
        .is_array());
    assert!(host
        .dispatch("fanotes:sync-vault-id", &[])
        .unwrap()
        .as_str()
        .unwrap()
        .len()
        >= 16);
    assert_eq!(
        host.dispatch("fanotes:close-subject-book-popout", &[])
            .unwrap()["open"],
        false
    );
}

#[test]
fn a_finished_setup_still_checks_the_subject_selection() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!(["Mathematik"])])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:complete-onboarding", &[json!(1)])
            .unwrap_err(),
        "Die Ordnerauswahl ist ungültig."
    );
    assert_eq!(
        host.dispatch("fanotes:complete-onboarding", &[json!(["Kein Fach"])])
            .unwrap_err(),
        "Die Ordnerauswahl enthält einen ungültigen oder doppelten Eintrag."
    );
    let again = host
        .dispatch("fanotes:complete-onboarding", &[json!([])])
        .unwrap();
    assert_eq!(again["onboardingRequired"], false);
    assert!(vault.join("Mathematik").is_dir());
    assert!(!vault.join("Physik").exists());
}

#[test]
fn first_run_creates_the_chosen_subjects_and_stamps_the_tree() {
    let (vault, mut host) = host();
    let bootstrap = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(bootstrap["onboardingRequired"], true);
    assert!(bootstrap["starterSubjects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|subject| subject["name"] == "Mathematik"));
    assert!(host
        .dispatch(
            "fanotes:complete-onboarding",
            &[json!(["Mathematik", "Mathematik"])],
        )
        .is_err());
    assert!(host
        .dispatch("fanotes:complete-onboarding", &[json!(["Kein Fach"])])
        .is_err());
    assert_eq!(
        host.dispatch("fanotes:get-tree", &[]).unwrap_err(),
        "Bitte schließe zuerst die FaNotes-Ersteinrichtung ab."
    );

    let done = host
        .dispatch(
            "fanotes:complete-onboarding",
            &[json!(["Mathematik", "Physik"])],
        )
        .unwrap();
    assert_eq!(done["onboardingRequired"], false);
    assert_eq!(done["settings"]["recognitionLanguage"], "de");
    assert!(vault.join("Eingang").is_dir());
    assert!(vault.join("Mathematik").is_dir());
    assert!(vault.join("Physik").is_dir());
    assert!(!vault.join("Deutsch").exists());
    fs::write(vault.join("Eingang/Hallo.md"), b"Hi\n").unwrap();

    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let math = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Mathematik")
        .unwrap();
    assert_eq!(math["color"], "#2a6f97");
    assert!(math["modifiedAt"].as_str().unwrap().contains('T'));
    let inbox = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Eingang")
        .unwrap();
    let note = inbox["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Hallo.md")
        .unwrap();
    assert_eq!(note["size"], 3);
    assert!(note["modifiedAt"].as_str().unwrap().contains('T'));

    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert_eq!(cached[0]["kind"], tree[0]["kind"]);
    assert!(cached
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "Physik"));

    let fast = host.dispatch("fanotes:get-fast-tree", &[]).unwrap();
    let fast_note = fast
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Eingang")
        .unwrap()["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Hallo.md")
        .unwrap();
    assert!(fast_note.get("modifiedAt").is_none());
    assert!(fast_note.get("size").is_none());

    let again = host
        .dispatch("fanotes:complete-onboarding", &[json!(["Deutsch"])])
        .unwrap();
    assert_eq!(again["onboardingRequired"], false);
    assert!(!vault.join("Deutsch").exists());
}

#[cfg(unix)]
#[test]
fn an_unreadable_tree_cache_is_removed() {
    use std::os::unix::fs::PermissionsExt;
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!(["Mathematik"])])
        .unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::set_permissions(&cache_path, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(cache_path.clone());
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(!cache_path.exists(), "{}", cache_path.display());
}

#[test]
fn a_cached_tree_keeps_a_long_unicode_name() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!(["Mathematik"])])
        .unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let name = format!("{}.md", "Ä".repeat(200));
    assert!(name.len() > 255);
    assert!(name.encode_utf16().count() <= 255);
    let cache = json!({
        "version": 1,
        "vaultIdentity": fs::read_to_string(&cache_path)
            .unwrap()
            .split("\"vaultIdentity\":\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap(),
        "entries": [{
            "name": name,
            "relativePath": name,
            "kind": "file",
            "extension": "md"
        }]
    });
    fs::write(&cache_path, format!("{cache}\n")).unwrap();
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert_eq!(cached[0]["name"], name);

    let identity = cache["vaultIdentity"].clone();
    fs::write(
        &cache_path,
        format!(
            "{}\n",
            json!({
                "version": 1,
                "vaultIdentity": identity,
                "entries": [{
                    "name": "Ordner",
                    "relativePath": "Ordner",
                    "kind": "folder",
                    "children": null
                }]
            })
        ),
    )
    .unwrap();
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert_eq!(cached[0]["name"], "Ordner");
    assert!(cached[0]["children"].as_array().unwrap().is_empty());

    fs::write(
        &cache_path,
        format!(
            "{}\n",
            json!({
                "version": 1,
                "vaultIdentity": identity,
                "entries": [{
                    "name": "Zeit.md",
                    "relativePath": "Zeit.md",
                    "kind": "file",
                    "extension": "md",
                    "modifiedAt": "2026-10-11T00:00:00.000Z"
                }]
            })
        ),
    )
    .unwrap();
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert_eq!(cached[0]["modifiedAt"], "2026-10-11T00:00:00.000Z");

    fs::write(
        &cache_path,
        format!(
            "{}\n",
            json!({
                "version": 1,
                "vaultIdentity": identity,
                "entries": [{
                    "name": "Zeit.md",
                    "relativePath": "Zeit.md",
                    "kind": "file",
                    "extension": "md",
                    "modifiedAt": "not-a-dateT"
                }]
            })
        ),
    )
    .unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());

    let too_long = "a".repeat(256);
    let identity = cache["vaultIdentity"].clone();
    fs::write(
        &cache_path,
        format!(
            "{}\n",
            json!({
                "version": 1,
                "vaultIdentity": identity,
                "entries": [{
                    "name": too_long,
                    "relativePath": too_long,
                    "kind": "folder",
                    "children": []
                }]
            })
        ),
    )
    .unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
}

#[test]
fn onboarding_stays_pending_when_its_file_contains_a_bad_byte() {
    let dir = std::env::temp_dir().join(format!(
        "fanotes-onboarding-byte-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join(".fanotes")).unwrap();
    let mut bytes = br#"{"version":1,"status":"pending","note":"X"}"#.to_vec();
    let index = bytes.iter().position(|byte| *byte == b'X').unwrap();
    bytes[index] = 0xff;
    fs::write(vault.join(".fanotes/onboarding.json"), &bytes).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    let bootstrap = host.dispatch("fanotes:bootstrap", &[]).unwrap();
    assert_eq!(bootstrap["onboardingRequired"], true);
}

#[test]
fn a_cached_tree_with_a_bad_byte_still_opens() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!(["Mathematik"])])
        .unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut bytes = fs::read(&cache_path).unwrap();
    let needle = b"Mathematik";
    let mut start = 0;
    let mut found = false;
    while let Some(index) = bytes[start..]
        .windows(needle.len())
        .position(|window| window == needle)
    {
        let at = start + index;
        bytes[at + 1] = 0xff;
        start = at + needle.len();
        found = true;
    }
    assert!(found);
    fs::write(&cache_path, &bytes).unwrap();

    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert!(cached
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "M\u{FFFD}thematik"));
    assert!(cache_path.is_file());

    fs::write(&cache_path, b"{\xff").unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(!cache_path.is_file());
}

#[test]
fn a_version_of_one_point_zero_still_counts_as_version_one() {
    let dir = std::env::temp_dir().join(format!(
        "fanotes-version-one-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join(".fanotes")).unwrap();
    fs::write(
        vault.join(".fanotes/onboarding.json"),
        "{\"version\":1.0,\"status\":\"pending\"}\n",
    )
    .unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    assert_eq!(
        host.dispatch("fanotes:bootstrap", &[]).unwrap()["onboardingRequired"],
        true
    );
    fs::write(
        vault.join(".fanotes/onboarding.json"),
        "{\"version\":1.5,\"status\":\"pending\"}\n",
    )
    .unwrap();
    host.set_vault(vault.clone()).unwrap();
    assert_eq!(
        host.dispatch("fanotes:bootstrap", &[]).unwrap()["onboardingRequired"],
        false
    );

    host.dispatch("fanotes:complete-onboarding", &[json!([])])
        .unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = dir.join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let text = fs::read_to_string(&cache_path).unwrap();
    fs::write(
        &cache_path,
        text.replacen("\"version\":1", "\"version\":1.0", 1),
    )
    .unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_array());
    let text = fs::read_to_string(&cache_path).unwrap();
    fs::write(
        &cache_path,
        text.replacen("\"version\":1.0", "\"version\":2", 1),
    )
    .unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(cache_path.is_file());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_cached_tree_without_entries_is_removed() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!([])])
        .unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut parsed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
    parsed.as_object_mut().unwrap().remove("entries");
    fs::write(&cache_path, serde_json::to_string(&parsed).unwrap()).unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(!cache_path.is_file());
}

#[test]
fn a_cached_file_size_of_twelve_point_zero_still_counts() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!(["Mathematik"])])
        .unwrap();
    fs::write(vault.join("Mathematik/Notiz.md"), b"Hallo").unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let text = fs::read_to_string(&cache_path).unwrap();
    fs::write(&cache_path, text.replacen("\"size\":5", "\"size\":12.0", 1)).unwrap();
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    let note = cached
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Mathematik")
        .unwrap()["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Notiz.md")
        .unwrap();
    assert_eq!(note["size"], 12);
    assert!(cache_path.is_file());

    let text = fs::read_to_string(&cache_path).unwrap();
    fs::write(
        &cache_path,
        text.replacen("\"size\":12.0", "\"size\":12.5", 1),
    )
    .unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(!cache_path.is_file());
    let _ = fs::remove_dir_all(vault.parent().unwrap());
}

#[test]
fn a_null_folder_color_discards_the_tree_cache() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!(["Mathematik"])])
        .unwrap();
    host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let identity = fs::read_to_string(&cache_path)
        .unwrap()
        .split("\"vaultIdentity\":\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_owned();
    fs::write(
        &cache_path,
        format!(
            "{}\n",
            json!({
                "version": 1,
                "vaultIdentity": identity,
                "entries": [{
                    "name": "Ordner",
                    "relativePath": "Ordner",
                    "kind": "folder",
                    "color": "#AABBCC",
                    "children": []
                }]
            })
        ),
    )
    .unwrap();
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    assert_eq!(cached[0]["color"], "#aabbcc");
    assert!(cache_path.is_file());

    fs::write(
        &cache_path,
        format!(
            "{}\n",
            json!({
                "version": 1,
                "vaultIdentity": identity,
                "entries": [{
                    "name": "Ordner",
                    "relativePath": "Ordner",
                    "kind": "folder",
                    "color": null,
                    "children": []
                }]
            })
        ),
    )
    .unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(!cache_path.is_file());
    let _ = fs::remove_dir_all(vault.parent().unwrap());
}

#[test]
fn a_cached_tree_sorts_each_level_like_the_desktop() {
    let (vault, mut host) = host();
    host.dispatch("fanotes:complete-onboarding", &[json!([])])
        .unwrap();
    fs::create_dir(vault.join("Zoo")).unwrap();
    fs::create_dir(vault.join("Apfel")).unwrap();
    fs::write(vault.join("Zoo/Zettel.md"), "# Zettel\n").unwrap();
    fs::write(vault.join("Zoo/Anfang.md"), "# Anfang\n").unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let cache_dir = vault.parent().unwrap().join("app/tree-cache-v1");
    let cache_path = fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut parsed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
    let entries = parsed["entries"].as_array_mut().unwrap();
    entries.reverse();
    let stored_root: Vec<_> = entries
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    let zoo = entries
        .iter_mut()
        .find(|entry| entry["name"] == "Zoo")
        .unwrap();
    zoo["children"].as_array_mut().unwrap().reverse();
    let stored_children: Vec<_> = zoo["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect();
    fs::write(&cache_path, serde_json::to_string(&parsed).unwrap()).unwrap();
    let cached = host.dispatch("fanotes:get-cached-tree", &[]).unwrap();
    let names = |value: &serde_json::Value| -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let tree_names = names(&tree);
    assert_eq!(names(&cached), tree_names);
    assert_ne!(tree_names, stored_root);
    let zoo_tree = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Zoo")
        .unwrap();
    let zoo_cached = cached
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Zoo")
        .unwrap();
    let child_names = names(&zoo_tree["children"]);
    assert_eq!(names(&zoo_cached["children"]), child_names);
    assert_ne!(child_names, stored_children);
    assert_eq!(child_names, vec!["Anfang.md".to_owned(), "Zettel.md".to_owned()]);
}

#[test]
fn an_oversized_onboarding_file_does_not_keep_setup_open() {
    let dir = std::env::temp_dir().join(format!(
        "fanotes-onboarding-size-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join(".fanotes")).unwrap();
    // Desktop `readOnboardingStatus` ignores a file larger than 4,096 bytes.
    // A pending status past that limit must not block the shell.
    let padding = " ".repeat(4096);
    fs::write(
        vault.join(".fanotes/onboarding.json"),
        format!("{{\"version\":1,\"status\":\"pending\",\"pad\":\"{padding}\"}}\n"),
    )
    .unwrap();
    assert!(fs::metadata(vault.join(".fanotes/onboarding.json")).unwrap().len() > 4096);
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    assert_eq!(
        host.dispatch("fanotes:bootstrap", &[]).unwrap()["onboardingRequired"],
        false
    );
}
