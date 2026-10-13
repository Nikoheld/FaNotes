use std::fs;

use base64::Engine;
use fanotes_host::{addon_request_allowed, local_ai_origin, Host, SecretStore, CHANNELS};
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
                "pageIndex": 0.0,
                "pixelWidth": 16.0,
                "pixelHeight": 16,
                "pagePixelWidth": 16,
                "pagePixelHeight": 16,
                "originX": 0,
                "originY": 0,
                "rotation": 0.0
            })]
        )
        .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-file", &[json!(".fanotes/settings.json")])
            .unwrap_err(),
        "Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
    fs::write(dir.0.join("vault").join("Notiz.md"), b"\n").unwrap();
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
    fs::write(
        dir.0.join("vault").join("skizze.svg"),
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    let svg_url = host
        .dispatch("fanotes:read-asset-data-url", &[json!("skizze.svg")])
        .unwrap();
    assert!(svg_url
        .as_str()
        .unwrap()
        .starts_with("data:image/svg+xml;base64,"));
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("Notiz.md")])
            .unwrap_err(),
        "Dieser Dateityp ist für die Vorschau nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-data-url", &[json!("Notiz.md")])
            .unwrap_err(),
        "Dieser Bildtyp ist für die Vorschau nicht erlaubt."
    );
    fs::write(dir.0.join("vault").join("seite.htm"), b"<p>alt</p>").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("seite.htm")])
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
fn an_internal_worksheet_can_be_previewed() {
    let (dir, mut host) = host();
    let worksheets = dir.0.join("vault/.fanotes/worksheets");
    fs::create_dir_all(&worksheets).unwrap();
    fs::write(worksheets.join("blatt-1.pdf"), b"%PDF-1.4 intern").unwrap();
    let encoded = host
        .dispatch(
            "fanotes:read-asset-bytes",
            &[json!(".fanotes/worksheets/blatt-1.pdf")],
        )
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.as_str().unwrap())
            .unwrap(),
        b"%PDF-1.4 intern"
    );
    fs::create_dir_all(dir.0.join("vault/.lernwerk/worksheets")).unwrap();
    fs::write(
        dir.0.join("vault/.lernwerk/worksheets/blatt-1.pdf"),
        b"%PDF-1.4 alt",
    )
    .unwrap();
    let legacy = host
        .dispatch(
            "fanotes:read-asset-data-url",
            &[json!(".lernwerk/worksheets/blatt-1.pdf")],
        )
        .unwrap();
    assert!(legacy
        .as_str()
        .unwrap()
        .starts_with("data:application/pdf;base64,"));
    fs::create_dir(worksheets.join("ordner.pdf")).unwrap();
    assert_eq!(
        host.dispatch(
            "fanotes:read-asset-bytes",
            &[json!(".fanotes/worksheets/ordner.pdf")]
        )
        .unwrap_err(),
        "Die gewählte Datei ist keine reguläre Datei."
    );
    assert_eq!(
        host.dispatch(
            "fanotes:read-file",
            &[json!(".fanotes/worksheets/blatt-1.pdf")]
        )
        .unwrap_err(),
        "Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden."
    );
}

#[test]
fn an_asset_preview_uses_the_desktop_extension_before_the_path_shape() {
    let (dir, mut host) = host();
    fs::write(dir.0.join("vault").join("seite.pdf"), b"%PDF-1.4 test").unwrap();
    fs::write(dir.0.join("vault").join("Bild.PDF"), b"%PDF-1.4 gross").unwrap();
    let encoded = host
        .dispatch("fanotes:read-asset-bytes", &[json!("seite.pdf/")])
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.as_str().unwrap())
            .unwrap(),
        b"%PDF-1.4 test"
    );
    let data_url = host
        .dispatch("fanotes:read-asset-data-url", &[json!("Bild.PDF/")])
        .unwrap();
    assert!(data_url
        .as_str()
        .unwrap()
        .starts_with("data:application/pdf;base64,"));
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("seite.pdf//")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-data-url", &[json!("../seite.pdf/")])
            .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("../seite.txt/")])
            .unwrap_err(),
        "Dieser Dateityp ist für die Vorschau nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-data-url", &[json!("../seite.txt")])
            .unwrap_err(),
        "Dieser Bildtyp ist für die Vorschau nicht erlaubt."
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("notes\\seite.pdf")])
            .unwrap_err(),
        "Nur relative Vault-Pfade sind erlaubt."
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_preview_uses_the_desktop_open_error() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut host) = host();
    let file = dir.0.join("vault").join("seite.pdf");
    fs::write(&file, b"%PDF-1.4\n").unwrap();
    let canonical = fs::canonicalize(&file).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = Restore(file);
    let expected = format!(
        "EACCES: permission denied, open '{}'",
        canonical.display()
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("seite.pdf")])
            .unwrap_err(),
        expected
    );
    assert_eq!(
        host.dispatch("fanotes:sync-read", &[json!("seite.pdf")])
            .unwrap_err(),
        expected
    );
}

#[test]
fn an_empty_asset_preview_returns_an_empty_payload() {
    let (dir, mut host) = host();
    fs::write(dir.0.join("vault").join("leer.pdf"), b"").unwrap();
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("leer.pdf")])
            .unwrap(),
        json!("")
    );
    assert_eq!(
        host.dispatch("fanotes:read-asset-data-url", &[json!("leer.pdf")])
            .unwrap(),
        json!("data:application/pdf;base64,")
    );
    let missing = fs::canonicalize(dir.0.join("vault")).unwrap().join("fehlt.pdf");
    assert_eq!(
        host.dispatch("fanotes:read-asset-bytes", &[json!("fehlt.pdf")])
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, lstat '{}'",
            missing.display()
        )
    );
}

#[test]
fn addon_ssrf_blocks_private_and_non_https() {
    assert!(addon_request_allowed("http://example.com").is_err());
    assert_eq!(
        addon_request_allowed("https://127.0.0.1/hook").unwrap_err(),
        "Add-ons dürfen nur öffentliche https-Adressen aufrufen."
    );
    assert!(addon_request_allowed("https://127.1/hook").is_err());
    assert!(addon_request_allowed("https://0x7f.0.0.1/hook").is_err());
    assert!(addon_request_allowed("https://0177.0.0.1/hook").is_err());
    assert!(addon_request_allowed("https://0x7f000001/hook").is_err());
    assert!(addon_request_allowed("https://[::1]/hook").is_err());
    assert!(addon_request_allowed("https://[2001:db8::1]/hook").is_err());
    assert!(addon_request_allowed("https://localhost/hook").is_err());
    assert!(addon_request_allowed("https://192.168.1.20/hook").is_err());
    assert!(addon_request_allowed("https://10.0.0.1e1/hook").is_ok());
    assert!(addon_request_allowed("https://10.0.0.0b1/hook").is_ok());
    assert!(addon_request_allowed("https://100.64.0.1/hook").is_err());
    assert!(addon_request_allowed("https://224.0.0.1/hook").is_err());
    assert!(addon_request_allowed("https://user:pass@example.com").is_err());
    assert!(addon_request_allowed("https://example.com/hook").is_ok());
    assert!(addon_request_allowed("HTTPS://example.com/hook").is_ok());
    let (_dir, mut host) = host();
    assert!(host
        .dispatch("fanotes:addons-net-fetch", &[json!("https://10.0.0.4/")])
        .is_err());
}

#[test]
fn local_ai_urls_stay_on_the_lan() {
    assert_eq!(
        local_ai_origin("HTTP://LOCALHOST:1234/./", "lmstudio").unwrap(),
        "http://localhost:1234"
    );
    assert_eq!(
        local_ai_origin("http://127.1:1234?", "ollama").unwrap(),
        "http://127.0.0.1:1234"
    );
    assert_eq!(
        local_ai_origin("http://0x7f.0.0.1:01234", "opencode").unwrap(),
        "http://127.0.0.1:1234"
    );
    assert!(local_ai_origin("https://api.openai.com", "lmstudio").is_err());
    assert!(local_ai_origin("http://100.64.0.1:1234", "ollama").is_err());
    assert!(local_ai_origin("http://224.0.0.1:1234", "lmstudio").is_err());
    assert!(local_ai_origin("http://240.0.0.1:1234", "opencode").is_err());
    assert_eq!(
        local_ai_origin("http://192.168.1.20:11434", "ollama").unwrap(),
        "http://192.168.1.20:11434"
    );
    assert_eq!(
        local_ai_origin("http://10.1.2.3:1234", "lmstudio").unwrap(),
        "http://10.1.2.3:1234"
    );
    assert!(local_ai_origin("http://127.0.0.1:1234/v1", "ollama").is_err());
    assert!(local_ai_origin("http://user:pass@127.0.0.1:1234", "lmstudio").is_err());
    let too_long = "ä".repeat(2049);
    assert!(local_ai_origin(&too_long, "lmstudio")
        .unwrap_err()
        .contains("ungültig"));
    let within_characters = "ä".repeat(2048);
    assert!(local_ai_origin(&within_characters, "lmstudio")
        .unwrap_err()
        .contains("vollständige"));
}

#[test]
fn secrets_do_not_land_in_settings() {
    let (dir, mut host) = host();
    host.secret_store = SecretStore::Memory;
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
    assert_eq!(state["autoDownloadUpdates"], true);
    assert_eq!(state["installUpdatesOnQuit"], true);
    assert_eq!(state["updateChannel"], "stable");
    assert_eq!(state["installationKind"], "managed-appimage");
    host.dispatch(
        "fanotes:save-settings",
        &[json!({
            "autoCheckUpdates": false,
            "autoDownloadUpdates": false,
            "installUpdatesOnQuit": false,
            "updateChannel": "beta"
        })],
    )
    .unwrap();
    let state = host.dispatch("fanotes:update-get-state", &[]).unwrap();
    assert_eq!(state["autoCheckUpdates"], false);
    assert_eq!(state["autoDownloadUpdates"], false);
    assert_eq!(state["installUpdatesOnQuit"], false);
    assert_eq!(state["updateChannel"], "beta");
    assert_eq!(state["supported"], false);
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

#[test]
fn a_pdf_raster_path_uses_the_desktop_vault_rules() {
    let (_dir, mut host) = host();
    let mut request = json!({
        "path": "Seite.pdf",
        "pageIndex": 0,
        "pixelWidth": 16,
        "pixelHeight": 16,
        "pagePixelWidth": 16,
        "pagePixelHeight": 16,
        "originX": 0,
        "originY": 0,
        "rotation": 0
    });
    request.as_object_mut().unwrap().remove("rotation");
    assert_eq!(
        host.dispatch("fanotes:render-pdf-page", &[request.clone()])
            .unwrap_err(),
        "Die PDF-Rasteranfrage ist unvollständig."
    );
    request["rotation"] = json!(0);
    request["path"] = json!("");
    assert_eq!(
        host.dispatch("fanotes:render-pdf-page", &[request.clone()])
            .unwrap_err(),
        "Der Vault selbst ist für diese Aktion nicht erlaubt."
    );
    request["path"] = json!("a".repeat(4097));
    assert_eq!(
        host.dispatch("fanotes:render-pdf-page", &[request.clone()])
            .unwrap_err(),
        "Ungültiger Vault-Pfad."
    );
    let name = format!("{}.pdf", "ä".repeat(3000));
    request["path"] = json!(name.clone());
    let missing = fs::canonicalize(host.vault.as_ref().unwrap())
        .unwrap()
        .join(name);
    assert_eq!(
        host.dispatch("fanotes:render-pdf-page", &[request])
            .unwrap_err(),
        format!("ENAMETOOLONG: name too long, lstat '{}'", missing.display())
    );
}
