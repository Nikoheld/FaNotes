use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::{json, Value};

fn host() -> (Host, std::path::PathBuf) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-folder-locations-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("amat")).unwrap();
    fs::write(vault.join("amat/Alt.md"), "alt\n").unwrap();
    fs::write(vault.join("amat/Gleich.md"), "im vault\n").unwrap();
    let mut host = Host::open(dir.join("app"));
    host.file_dialogs = false;
    host.set_vault(vault.clone()).unwrap();
    (host, vault)
}

fn child<'a>(tree: &'a Value, name: &str) -> &'a Value {
    tree.as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("missing {name}"))
}

#[test]
fn several_directories_appear_in_one_folder_and_can_move() {
    let (mut host, vault) = host();
    let outside = vault.parent().unwrap().join("extern");
    let extra = vault.parent().unwrap().join("extra");
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(extra.join("Unter")).unwrap();
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::write(outside.join("Gleich.md"), "erste\n").unwrap();
    fs::write(outside.join("Nur.md"), "nur\n").unwrap();
    fs::write(extra.join("Gleich.md"), "zweite\n").unwrap();
    fs::write(extra.join("Unter/Tief.md"), "tief\n").unwrap();

    let assigned = host
        .dispatch(
            "fanotes:set-folder-locations",
            &[json!("amat"), json!([outside, extra]), json!(true)],
        )
        .unwrap();
    assert!(assigned["moved"].as_u64().unwrap() >= 1);
    assert!(!vault.join("amat/Alt.md").exists());
    assert_eq!(fs::read_to_string(outside.join("Alt.md")).unwrap(), "alt\n");
    assert!(assigned["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item == "Gleich.md"));
    assert_eq!(fs::read_to_string(vault.join("amat/Gleich.md")).unwrap(), "im vault\n");

    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    let amat = child(&tree, "amat");
    assert_eq!(amat["locations"][0], outside.to_string_lossy().as_ref());
    let names = amat["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(names.contains(&"Nur.md".to_owned()));
    assert!(names.contains(&"Gleich.md".to_owned()));
    assert!(names.contains(&"Alt.md".to_owned()));
    assert_eq!(names.iter().filter(|name| *name == "Gleich.md").count(), 1);
    let unter = amat["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Unter")
        .unwrap();
    assert_eq!(unter["children"][0]["relativePath"], "amat/Unter/Tief.md");
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("amat/Gleich.md")]).unwrap(),
        "erste"
    );

    let created = host
        .dispatch("fanotes:create-note", &[json!("amat"), json!("Neu")])
        .unwrap();
    assert_eq!(created["relativePath"], "amat/Neu.md");
    assert!(outside.join("Neu.md").exists());

    let inside = host.dispatch(
        "fanotes:set-folder-locations",
        &[json!("amat"), json!([vault.join("Mathe")]), json!(false)],
    );
    assert!(inside.unwrap_err().contains("Vault"));

    host.dispatch("fanotes:rename-entry", &[json!("amat"), json!("Schule")])
        .unwrap();
    let renamed = host
        .dispatch("fanotes:get-folder-locations", &[json!("Schule")])
        .unwrap();
    assert_eq!(renamed["paths"][0], outside.to_string_lossy().as_ref());

    let cleared = host
        .dispatch(
            "fanotes:set-folder-locations",
            &[json!("Schule"), json!([]), json!(true)],
        )
        .unwrap();
    assert!(cleared["moved"].as_u64().unwrap() >= 1);
    assert!(vault.join("Schule/Neu.md").exists());
    assert!(host
        .dispatch("fanotes:get-folder-locations", &[json!("Schule")])
        .unwrap()["paths"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(host
        .dispatch("fanotes:pick-folder-location", &[])
        .unwrap()
        .is_null());
}
