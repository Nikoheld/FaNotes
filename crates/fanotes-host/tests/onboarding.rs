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
