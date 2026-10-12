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
    fs::write(&cache_path, text.replacen("\"version\":1", "\"version\":1.0", 1)).unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_array());
    let text = fs::read_to_string(&cache_path).unwrap();
    fs::write(&cache_path, text.replacen("\"version\":1.0", "\"version\":2", 1)).unwrap();
    assert!(host
        .dispatch("fanotes:get-cached-tree", &[])
        .unwrap()
        .is_null());
    assert!(!cache_path.is_file());
    let _ = fs::remove_dir_all(&dir);
}
