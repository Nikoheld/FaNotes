use std::fs;

use base64::Engine;
use fanotes_host::{addon_request_allowed, local_ai_origin, Host, CHANNELS};
use serde_json::json;

fn host() -> (TempDir, Host) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-host-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let vault = dir.join("vault");
    let app_data = dir.join("app");
    fs::create_dir_all(&vault).unwrap();
    let mut host = Host::open(app_data);
    host.set_vault(vault).unwrap();
    (TempDir(dir), host)
}

struct TempDir(std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn every_preload_channel_dispatches() {
    let (_dir, mut host) = host();
    host.file_dialogs = false;
    assert!(CHANNELS.len() > 90);
    for channel in CHANNELS {
        let result = host.dispatch(channel.name, &[]);
        if let Err(error) = &result {
            assert!(!error.starts_with("Unbekannter Kanal"), "{error}");
        }
    }
}

#[test]
fn vault_paths_reject_traversal_and_internal_files() {
    let (dir, mut host) = host();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("../secret.md")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:render-pdf-page",
            &[json!({
                "path": "../secret.pdf",
                "pageIndex": 0,
                "pixelWidth": 16,
                "pixelHeight": 16,
                "pagePixelWidth": 16,
                "pagePixelHeight": 16,
                "originX": 0,
                "originY": 0
            })]
        )
        .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!(".fanotes/settings.json")])
            .unwrap_err(),
        "Interne FaNotes-Dateien sind geschützt."
    );
    host.dispatch("fanotes:write-file", &[json!("Notiz.md"), json!("Hallo")])
        .unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!("Notiz.md")])
            .unwrap(),
        json!("Hallo")
    );
    fs::write(dir.0.join("vault").join("seite.pdf"), b"%PDF-1.4 test").unwrap();
    let encoded_value = host
        .dispatch("fanotes:read-asset-bytes", &[json!("seite.pdf")])
        .unwrap();
    let encoded = encoded_value.as_str().unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
        b"%PDF-1.4 test"
    );
    let data_url = host
        .dispatch("fanotes:read-asset-data-url", &[json!("seite.pdf")])
        .unwrap();
    assert!(data_url
        .as_str()
        .unwrap()
        .starts_with("data:application/pdf;base64,"));
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("Notiz.md")])
            .unwrap_err(),
        "Dieser Dateityp ist für die Vorschau nicht erlaubt."
    );
    let link = dir.0.join("vault").join("link.pdf");
    std::os::unix::fs::symlink(dir.0.join("vault").join("seite.pdf"), &link).unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("link.pdf")])
            .unwrap_err(),
        "Symbolische Links sind innerhalb des Vaults nicht erlaubt."
    );
    let synced = host
        .dispatch("fanotes:sync-read", &[json!("seite.pdf")])
        .unwrap();
    assert_eq!(synced.as_str(), Some(encoded));
    let written = host
        .dispatch(
            "fanotes:sync-write",
            &[
                json!("kopie.pdf"),
                json!(encoded),
                json!(1_700_000_000_000i64),
            ],
        )
        .unwrap();
    assert_eq!(written["path"], "kopie.pdf");
    assert_eq!(written["size"], 13);
    assert_eq!(
        fs::read(dir.0.join("vault").join("kopie.pdf")).unwrap(),
        b"%PDF-1.4 test"
    );
    host.dispatch("fanotes:sync-remove", &[json!("fehlt.pdf")])
        .unwrap();
}

#[test]
fn addon_ssrf_blocks_private_and_non_https() {
    assert!(addon_request_allowed("http://example.com").is_err());
    assert!(addon_request_allowed("https://127.0.0.1/hook").is_err());
    assert!(addon_request_allowed("https://localhost/hook").is_err());
    assert!(addon_request_allowed("https://192.168.1.20/hook").is_err());
    assert!(addon_request_allowed("https://user:pass@example.com").is_err());
    assert!(addon_request_allowed("https://example.com/hook").is_ok());
    let (_dir, mut host) = host();
    assert!(host
        .dispatch("fanotes:addons-net-fetch", &[json!("https://10.0.0.4/")])
        .is_err());
}

#[test]
fn local_ai_urls_stay_on_the_lan() {
    assert!(local_ai_origin("http://127.0.0.1:1234", "lmstudio").is_ok());
    assert!(local_ai_origin("https://api.openai.com", "lmstudio").is_err());
    assert!(local_ai_origin("http://127.0.0.1:1234/v1", "ollama").is_err());
}

#[test]
fn secrets_do_not_land_in_settings() {
    let (dir, mut host) = host();
    host.dispatch(
        "fanotes:save-settings",
        &[json!({ "theme": "dark", "openAiApiKey": "sk-live-secret" })],
    )
    .unwrap();
    let settings = fs::read_to_string(dir.0.join("app/settings.json")).unwrap();
    assert!(!settings.contains("sk-live-secret"));
    assert!(settings.contains("dark"));
    let secrets = host.dispatch("fanotes:load-secure-settings", &[]).unwrap();
    assert_eq!(secrets["openAiApiKey"], "sk-live-secret");
}

#[test]
fn close_waits_until_the_page_confirms() {
    let (_dir, mut host) = host();
    host.dispatch("fanotes:request-close", &[]).unwrap();
    assert!(host.close_requested);
    assert!(!host.allow_close);
    host.dispatch("fanotes:cancel-close", &[]).unwrap();
    assert!(!host.close_requested);
    assert!(!host.allow_close);
    host.dispatch("fanotes:confirm-close", &[]).unwrap();
    assert!(host.allow_close);
}

#[test]
fn updater_does_not_replace_the_electron_release() {
    let (_dir, mut host) = host();
    let state = host.dispatch("fanotes:update-install", &[]).unwrap();
    assert_eq!(state["supported"], false);
    assert_eq!(state["releaseHost"], "electron");
    assert_eq!(state["status"], "idle");
}

#[test]
fn famd_ink_round_trips_through_the_shared_codec() {
    let (_dir, mut host) = host();
    let source = fanotes_famd::serialize_famd("Hallo", &{
        let mut payload = fanotes_famd::empty_famd_payload("2026-10-11T00:00:00.000Z");
        payload.ink = Some(
            json!({ "schemaVersion": 1, "title": "Seite", "strokes": [], "updatedAt": "2026-10-11T00:00:00.000Z" }),
        );
        payload
    });
    let root = host.vault.clone().unwrap();
    fs::write(root.join("Seite.famd"), source).unwrap();
    let ink = host
        .dispatch("fanotes:read-famd-ink", &[json!("Seite.md")])
        .unwrap();
    assert!(ink["drawingJson"].as_str().unwrap().contains("Seite"));
}
