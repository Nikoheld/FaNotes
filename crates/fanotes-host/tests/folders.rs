use fanotes_host::Host;
use serde_json::json;

fn host() -> (Host, std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("fanotes-folders-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let app = dir.join("app");
    let mut host = Host::open(app.clone());
    host.set_vault(vault.clone()).unwrap();
    (host, vault, app)
}

#[test]
fn folder_color_survives_a_rename_and_the_vault_is_remembered() {
    let (mut host, vault, app) = host();
    let painted = host
        .dispatch(
            "fanotes:set-folder-color",
            &[json!("Mathe"), json!("#A1B2C3")],
        )
        .unwrap();
    assert_eq!(painted["color"], "#a1b2c3");
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(tree[0]["name"], "Mathe");
    assert_eq!(tree[0]["color"], "#a1b2c3");

    host.dispatch("fanotes:rename-entry", &[json!("Mathe"), json!("Physik")])
        .unwrap();
    let tree = host.dispatch("fanotes:get-tree", &[]).unwrap();
    assert_eq!(tree[0]["relativePath"], "Physik");
    assert_eq!(tree[0]["color"], "#a1b2c3");

    let cleared = host
        .dispatch("fanotes:set-folder-color", &[json!("Physik"), json!(null)])
        .unwrap();
    assert!(cleared["color"].is_null());
    assert!(host
        .dispatch(
            "fanotes:set-folder-color",
            &[json!("Physik"), json!("blue")],
        )
        .is_err());

    let other = vault.parent().unwrap().join("other-vault");
    std::fs::create_dir_all(&other).unwrap();
    let switched = host
        .dispatch("fanotes:select-vault", &[json!(other.to_string_lossy())])
        .unwrap();
    assert_eq!(switched["vaultPath"], other.to_string_lossy().as_ref());

    let mut restored = Host::open(app);
    assert_eq!(
        restored.dispatch("fanotes:bootstrap", &[]).unwrap()["vaultPath"],
        other.to_string_lossy().as_ref()
    );
}
