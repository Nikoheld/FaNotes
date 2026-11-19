//! Behaviour of the update flow over an injected network: channel policy,
//! rollback guard, redirects and host allow-list, size caps, resumable
//! downloads, delta with fallback, staged adoption and persisted state.
//! These scenarios port the runtime parts of `scripts/check-updater.cjs`.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use fanotes_updater::client::{CheckOutcome, UpdateClient, UpdaterConfig};
use fanotes_updater::download::{download_transfer, TransferInfo, TransferOptions};
use fanotes_updater::fetch::{fetch_github, fetch_manifest, ManifestRequest};
use fanotes_updater::hosts::github_release_asset_url;
use fanotes_updater::state::UpdaterState;
use fanotes_updater::util::sha256_hex;
use fanotes_updater::{Channel, ErrorKind, Platform, Response};
use serde_json::{json, Value};
use support::*;

struct World {
    mock: Arc<Mock>,
    build: Arc<Build>,
    key: ed25519_dalek::SigningKey,
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        Self {
            mock: Mock::new(),
            build: Arc::new(build_delta()),
            key: signing_key(7),
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn root(&self) -> std::path::PathBuf {
        self.dir.path().join("updates")
    }

    fn installed(&self) -> std::path::PathBuf {
        let path = self.dir.path().join("FaNotes.AppImage");
        std::fs::write(&path, &self.build.source).unwrap();
        path
    }

    fn config(
        &self,
        current: &str,
        channel: Channel,
        source: Option<std::path::PathBuf>,
    ) -> UpdaterConfig {
        UpdaterConfig {
            platform: Platform::Linux,
            current_version: current.into(),
            channel,
            public_key_pem: public_pem(&self.key),
            expected_key_id: KEY_ID.into(),
            updater_root: self.root(),
            delta_source_path: source,
        }
    }

    fn client(
        &self,
        current: &str,
        channel: Channel,
        source: Option<std::path::PathBuf>,
    ) -> UpdateClient<Net> {
        UpdateClient::new(
            self.config(current, channel, source),
            Net(self.mock.clone()),
        )
    }

    /// Publish a release: list rows plus its signed manifest.
    fn serve_manifest(&self, version: &str, kind: &str, payload: &Value) {
        self.mock.json(
            &github_release_asset_url(version, &manifest_asset_name(kind)),
            &sign(payload, &self.key),
        );
    }

    fn serve_stable_latest(&self, version: &str) {
        self.mock
            .json(&format!("{API}/latest"), &release_row(version, "stable"));
    }

    fn serve_packages(&self, latest: &str) {
        let (build, latest) = (self.build.clone(), latest.to_owned());
        let full = github_release_asset_url(&latest, &format!("FaNotes-{latest}-x86_64.AppImage"));
        let target = build.clone();
        self.mock
            .route(&full, move |r| ranged(&target.target, r, None));
        let delta = github_release_asset_url(
            &latest,
            &format!("FaNotes-Delta-linux-x64-2026.11.2-to-{latest}.fndelta"),
        );
        let patch = build.clone();
        self.mock
            .route(&delta, move |r| ranged(&patch.patch, r, None));
    }
}

fn expect_available(outcome: CheckOutcome) -> fanotes_updater::VerifiedManifest {
    match outcome {
        CheckOutcome::Available(m) => m,
        other => panic!("expected Available, got {other:?}"),
    }
}

// ---------------------------------------------------------------- channels

#[test]
fn stable_checks_latest_and_offers_update() {
    let w = World::new();
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, true),
    );
    let mut client = w.client("2026.11.2", Channel::Stable, None);
    let manifest = expect_available(client.check().unwrap());
    assert_eq!(manifest.latest_version, "2026.11.3");
    assert!(manifest.update_available && manifest.delta.is_some());
    // Stable asks only /releases/latest, with the documented headers, and only allow-listed hosts.
    let list = w.mock.requests(&format!("{API}/latest"));
    assert_eq!(list.len(), 1);
    assert_eq!(
        header(&list[0], "accept"),
        Some("application/vnd.github+json")
    );
    assert_eq!(
        header(&list[0], "user-agent"),
        Some("FaNotes/2026.11.2 Linux updater")
    );
    assert_eq!(header(&list[0], "x-github-api-version"), Some("2022-11-28"));
    assert_eq!(w.mock.count(&format!("{API}?per_page=100")), 0);
    for request in w.mock.log.lock().unwrap().iter() {
        assert!(
            request.url.starts_with("https://api.github.com/")
                || request.url.starts_with("https://github.com/")
        );
    }
}

#[test]
fn beta_moves_to_a_newer_stable_over_an_older_beta() {
    let w = World::new();
    w.mock.json(
        &format!("{API}?per_page=100"),
        &json!([release_row("2026.11.3-beta.2", "beta")]),
    );
    w.mock.json(
        &format!("{API}/latest"),
        &release_row("2026.11.4", "stable"),
    );
    w.serve_manifest(
        "2026.11.4",
        "stable",
        &linux_payload("2026.11.3-beta.1", "2026.11.4", "stable", &w.build, true),
    );
    let mut client = w.client("2026.11.3-beta.1", Channel::Beta, None);
    let manifest = expect_available(client.check().unwrap());
    assert_eq!(manifest.latest_version, "2026.11.4");
    assert_eq!(manifest.channel, Channel::Stable);
}

#[test]
fn beta_takes_a_newer_beta_and_ignores_a_failing_latest_lookup() {
    let w = World::new();
    w.mock.json(
        &format!("{API}?per_page=100"),
        &json!([
            release_row("2026.11.4-beta.1", "beta"),
            release_row("2026.11.3", "stable")
        ]),
    );
    // /releases/latest is a 404 here; the index alone decides.
    w.serve_manifest(
        "2026.11.4-beta.1",
        "beta",
        &linux_payload("2026.11.3", "2026.11.4-beta.1", "beta", &w.build, false),
    );
    let mut client = w.client("2026.11.3", Channel::Beta, None);
    let manifest = expect_available(client.check().unwrap());
    assert_eq!(manifest.latest_version, "2026.11.4-beta.1");
    assert_eq!(manifest.channel, Channel::Beta);
}

#[test]
fn stable_never_receives_a_prerelease() {
    let w = World::new();
    // Even if /latest wrongly returns a prerelease, stable must not pick it.
    w.mock.json(
        &format!("{API}/latest"),
        &release_row("2026.11.4-beta.1", "beta"),
    );
    w.serve_manifest(
        "2026.11.4-beta.1",
        "beta",
        &linux_payload("2026.11.2", "2026.11.4-beta.1", "beta", &w.build, false),
    );
    let mut client = w.client("2026.11.2", Channel::Stable, None);
    let error = client.check().unwrap_err();
    assert!(error.message.contains("kein FaNotes-Release"), "{error}");
    assert_eq!(
        w.mock.count(&github_release_asset_url(
            "2026.11.4-beta.1",
            &manifest_asset_name("beta")
        )),
        0
    );
}

#[test]
fn a_beta_manifest_is_refused_when_the_picked_release_is_stable() {
    // A stable release whose signed manifest claims channel beta: refused by the edition binding.
    let w = World::new();
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "beta", &w.build, false),
    );
    let error = w
        .client("2026.11.2", Channel::Stable, None)
        .check()
        .unwrap_err();
    assert!(error.message.contains("FaNotes-Ausgabe"), "{error}");
}

#[test]
fn switching_beta_to_stable_never_downgrades() {
    let w = World::new();
    w.serve_stable_latest("2026.11.2");
    w.serve_manifest(
        "2026.11.2",
        "stable",
        &linux_payload("2026.11.3-beta.5", "2026.11.2", "stable", &w.build, false),
    );
    let mut client = w.client("2026.11.3-beta.5", Channel::Stable, None);
    match client.check().unwrap() {
        CheckOutcome::UpToDate(m) => {
            assert!(!m.update_available && m.latest_version == "2026.11.2")
        }
        other => panic!("beta user on an older stable must stay put: {other:?}"),
    }
}

// ---------------------------------------------------------------- rollback guard

#[test]
fn rollback_below_the_highest_seen_version_is_blocked_and_state_survives_restart() {
    let w = World::new();
    w.serve_stable_latest("2026.11.4");
    w.serve_manifest(
        "2026.11.4",
        "stable",
        &linux_payload("2026.11.2", "2026.11.4", "stable", &w.build, false),
    );
    let mut client = w.client("2026.11.2", Channel::Stable, None);
    assert!(matches!(
        client.check().unwrap(),
        CheckOutcome::Available(_)
    ));
    assert_eq!(client.state().highest(Channel::Stable), Some("2026.11.4"));

    // A signed but older manifest (2026.11.3 is still newer than the installed 2026.11.2) is a replay.
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, false),
    );
    let mut restarted = w.client("2026.11.2", Channel::Stable, None);
    assert_eq!(
        restarted.state().highest(Channel::Stable),
        Some("2026.11.4")
    );
    let error = restarted.check().unwrap_err();
    assert_eq!(error.kind, ErrorKind::Rollback);
    assert!(error.message.contains("Rollback"));
    // The highest version stays and the same version again is allowed.
    w.serve_stable_latest("2026.11.4");
    assert!(w.client("2026.11.2", Channel::Stable, None).check().is_ok());
}

#[test]
fn highest_seen_is_tracked_per_channel() {
    let w = World::new();
    let mut state = UpdaterState::default();
    assert!(state
        .remember_highest(Channel::Beta, "2026.11.9-beta.1")
        .unwrap());
    assert!(!state
        .remember_highest(Channel::Beta, "2026.11.9-beta.1")
        .unwrap());
    assert!(!state.remember_highest(Channel::Beta, "2026.11.8").unwrap());
    state.check_rollback(Channel::Stable, "2026.11.1").unwrap();
    assert_eq!(
        state
            .check_rollback(Channel::Beta, "2026.11.8")
            .unwrap_err()
            .kind,
        ErrorKind::Rollback
    );
    let _ = w;
}

#[test]
fn state_file_parsing_is_defensive() {
    let sha = "a".repeat(64);
    let good = json!({
        "schemaVersion": 3,
        "highestSeenVersions": { "stable": "2026.11.2", "beta": "bogus", "nightly": 7 },
        "pendingInstall": { "channel": "beta", "version": "2026.11.3-beta.1", "fileName": "f.AppImage", "sha256": sha, "sizeBytes": 12582912, "usedDelta": true, "preparedAt": "x" },
    });
    let state = UpdaterState::parse(&good.to_string());
    assert_eq!(state.highest_stable.as_deref(), Some("2026.11.2"));
    assert_eq!((state.highest_beta, state.highest_nightly), (None, None));
    assert!(state
        .pending_install
        .as_ref()
        .is_some_and(|p| p.used_delta && p.channel == Channel::Beta));
    // v2 migration
    assert_eq!(
        UpdaterState::parse(r#"{"highestSeenVersion":"2.16.0"}"#)
            .highest_stable
            .as_deref(),
        Some("2.16.0")
    );
    // each rejected pending field
    for (key, value) in [
        ("fileName", json!("../x")),
        ("fileName", json!("a\\b")),
        ("fileName", json!("")),
        ("sha256", json!("ABC")),
        ("sizeBytes", json!(5)),
        ("sizeBytes", json!(1024u64 * 1024 * 1024 + 1)),
        ("channel", json!("alpha")),
        ("version", json!("v1")),
    ] {
        let mut candidate = good.clone();
        candidate["pendingInstall"][key] = value.clone();
        assert!(
            UpdaterState::parse(&candidate.to_string())
                .pending_install
                .is_none(),
            "{key}={value}"
        );
    }
    assert_eq!(UpdaterState::parse("not json"), UpdaterState::default());
    let big = format!(
        "{{\"highestSeenVersion\":\"1.0.0\",\"pad\":\"{}\"}}",
        "x".repeat(70_000)
    );
    assert_eq!(UpdaterState::parse(&big), UpdaterState::default());
}

#[test]
fn state_is_saved_atomically_with_private_permissions() {
    let w = World::new();
    let path = w.root().join("state.json");
    let mut state = UpdaterState::default();
    state
        .remember_highest(Channel::Stable, "2026.11.3")
        .unwrap();
    state.save(&path).unwrap();
    assert_eq!(
        UpdaterState::load(&path).highest_stable.as_deref(),
        Some("2026.11.3")
    );
    let leftovers: Vec<_> = std::fs::read_dir(w.root())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "no temp files: {leftovers:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

// ---------------------------------------------------------------- hosts, redirects, caps

fn request_for(platform: Platform, channel: Channel) -> ManifestRequest<'static> {
    ManifestRequest {
        platform,
        current_version: "2026.11.2",
        channel,
        public_key_pem: "",
        expected_key_id: KEY_ID,
    }
}

#[test]
fn hosts_outside_the_allow_list_are_never_contacted() {
    let mock = Mock::new();
    let net = Net(mock.clone());
    for url in [
        "https://evil.example/FaNotes.AppImage",
        "http://github.com/x",
        "https://github.com:8443/x",
        "https://api.github.com.evil.example/x",
        "https://fanotes.fasrv.ch/download/appimage",
        "ftp://github.com/x",
        "file:///etc/passwd",
        "not a url",
        "https://GITHUB.com.evil.example/",
    ] {
        let error = fetch_github(&net, url, &[], None).map(|_| ()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Untrusted, "{url}");
        assert!(error.message.contains("nicht vertrauenswürdig"));
    }
    assert!(mock.log.lock().unwrap().is_empty());
    // allow-listed hosts pass through
    // Parity with JS: `fetchGithub` checks scheme and host only, so userinfo on an allow-listed host passes
    // (manifest and package URLs never reach it: they go through `assert_github_release_url`).
    for url in [
        "https://user@github.com/a",
        "https://github.com/a",
        "https://api.github.com/a",
        "https://objects.githubusercontent.com/a",
        "https://release-assets.githubusercontent.com/a",
    ] {
        assert!(fetch_github(&net, url, &[], None).is_ok(), "{url}");
    }
    let _ = request_for(Platform::Linux, Channel::Stable);
}

#[test]
fn redirects_follow_allow_listed_hosts_only_and_at_most_four_hops() {
    let mock = Mock::new();
    let net = Net(mock.clone());
    mock.route("https://github.com/a", |_| {
        Ok(Response::new(
            302,
            &[("location", "https://objects.githubusercontent.com/b")],
            vec![],
        ))
    });
    mock.route("https://objects.githubusercontent.com/b", |_| {
        Ok(Response::new(
            200,
            &[("content-length", "2")],
            b"ok".to_vec(),
        ))
    });
    assert_eq!(
        fetch_github(&net, "https://github.com/a", &[], None)
            .unwrap()
            .status,
        200
    );
    // relative redirect resolves against the current URL
    mock.route("https://github.com/rel", |_| {
        Ok(Response::new(301, &[("location", "/a")], vec![]))
    });
    assert_eq!(
        fetch_github(&net, "https://github.com/rel", &[], None)
            .unwrap()
            .status,
        200
    );
    // redirect to a foreign host is not followed: the 3xx comes back and the foreign host is never asked
    mock.route("https://github.com/evil", |_| {
        Ok(Response::new(
            302,
            &[("location", "https://evil.example/x")],
            vec![],
        ))
    });
    assert_eq!(
        fetch_github(&net, "https://github.com/evil", &[], None)
            .unwrap()
            .status,
        302
    );
    assert_eq!(mock.count("https://evil.example/x"), 0);
    // http downgrade is not followed
    mock.route("https://github.com/http", |_| {
        Ok(Response::new(
            302,
            &[("location", "http://github.com/x")],
            vec![],
        ))
    });
    assert_eq!(
        fetch_github(&net, "https://github.com/http", &[], None)
            .unwrap()
            .status,
        302
    );
    // endless loop: 1 request + 4 redirects, then the redirect is returned
    mock.route("https://github.com/loop", |_| {
        Ok(Response::new(
            302,
            &[("location", "https://github.com/loop")],
            vec![],
        ))
    });
    assert_eq!(
        fetch_github(&net, "https://github.com/loop", &[], None)
            .unwrap()
            .status,
        302
    );
    assert_eq!(mock.count("https://github.com/loop"), 5);
}

#[test]
fn oversize_manifest_is_refused_by_header_and_by_body() {
    let w = World::new();
    w.serve_stable_latest("2026.11.3");
    let url = github_release_asset_url("2026.11.3", &manifest_asset_name("stable"));
    let big = vec![b' '; 600 * 1024];
    let by_header = big.clone();
    w.mock.route(&url, move |_| {
        Ok(Response::new(
            200,
            &[
                ("content-type", "application/json"),
                ("content-length", &by_header.len().to_string()),
            ],
            by_header.clone(),
        ))
    });
    let error = w
        .client("2026.11.2", Channel::Stable, None)
        .check()
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Size);
    assert!(error.message.contains("unerwartet groß"));
    // no content-length header: the body itself is measured
    w.mock.route(&url, move |_| {
        Ok(Response::new(
            200,
            &[("content-type", "application/json")],
            big.clone(),
        ))
    });
    assert!(w
        .client("2026.11.2", Channel::Stable, None)
        .check()
        .unwrap_err()
        .message
        .contains("unerwartet groß"));
}

#[test]
fn a_long_release_index_is_accepted_up_to_four_mib() {
    let w = World::new();
    let mut row = release_row("2026.11.4-beta.1", "beta");
    row["body"] = json!("x".repeat(600 * 1024));
    w.mock.json(&format!("{API}?per_page=100"), &json!([row]));
    w.serve_manifest(
        "2026.11.4-beta.1",
        "beta",
        &linux_payload("2026.11.3", "2026.11.4-beta.1", "beta", &w.build, false),
    );
    assert!(w.client("2026.11.3", Channel::Beta, None).check().is_ok());
}

#[test]
fn captive_portal_and_http_errors_get_a_diagnosis() {
    let w = World::new();
    w.mock.route(&format!("{API}/latest"), |_| {
        Ok(Response::new(
            200,
            &[("content-type", "text/html")],
            b"<html><title>Schulfilter</title></html>".to_vec(),
        ))
    });
    let error = w
        .client("2026.11.2", Channel::Stable, None)
        .check()
        .unwrap_err();
    let diagnosis = error.diagnosis.expect("diagnosis");
    assert_eq!(
        (diagnosis.kind, diagnosis.page_title.as_deref()),
        ("captive-portal", Some("Schulfilter"))
    );
    w.mock.route(&format!("{API}/latest"), |_| {
        Ok(Response::new(
            302,
            &[("location", "http://captive.schule.local/login")],
            vec![],
        ))
    });
    let error = w
        .client("2026.11.2", Channel::Stable, None)
        .check()
        .unwrap_err();
    assert_eq!(
        error.diagnosis.unwrap().location_host.as_deref(),
        Some("captive.schule.local")
    );
    w.mock.route(&format!("{API}/latest"), |_| {
        Ok(Response::new(
            503,
            &[("content-type", "application/json")],
            b"{}".to_vec(),
        ))
    });
    assert_eq!(
        w.client("2026.11.2", Channel::Stable, None)
            .check()
            .unwrap_err()
            .diagnosis
            .unwrap()
            .kind,
        "http"
    );
    w.mock.route(&format!("{API}/latest"), |_| {
        Ok(Response::new(
            200,
            &[("content-type", "application/json")],
            b"{nope".to_vec(),
        ))
    });
    assert!(w
        .client("2026.11.2", Channel::Stable, None)
        .check()
        .unwrap_err()
        .message
        .contains("keine gültige Release-Liste"));
    w.mock.route(&format!("{API}/latest"), |_| {
        Err(network_error("ECONNRESET"))
    });
    assert_eq!(
        w.client("2026.11.2", Channel::Stable, None)
            .check()
            .unwrap_err()
            .diagnosis
            .unwrap()
            .kind,
        "connection"
    );
}

#[test]
fn manifest_signed_by_another_key_is_refused() {
    let w = World::new();
    w.serve_stable_latest("2026.11.3");
    let payload = linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, false);
    w.mock.json(
        &github_release_asset_url("2026.11.3", &manifest_asset_name("stable")),
        &sign(&payload, &signing_key(9)),
    );
    let error = fetch_manifest(
        &Net(w.mock.clone()),
        &ManifestRequest {
            platform: Platform::Linux,
            current_version: "2026.11.2",
            channel: Channel::Stable,
            public_key_pem: &public_pem(&w.key),
            expected_key_id: KEY_ID,
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Signature);
}

#[test]
fn the_production_key_is_pinned_and_parses() {
    // The embedded production key must be a valid Ed25519 SPKI; a synthetic manifest cannot verify against it.
    let w = World::new();
    let payload = linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, false);
    let manifest = sign(&payload, &w.key);
    let error = fanotes_updater::verify_manifest(
        &manifest,
        "2026.11.2",
        fanotes_updater::PRODUCT_PUBLIC_KEY_PEM,
        Platform::Linux,
        fanotes_updater::EXPECTED_KEY_ID,
        Channel::Stable,
    )
    .unwrap_err();
    assert!(error.message.contains("unbekannten Schlüssel"), "{error}");
    let mut manifest = manifest;
    manifest["signature"]["keyId"] = json!(fanotes_updater::EXPECTED_KEY_ID);
    let error = fanotes_updater::verify_manifest(
        &manifest,
        "2026.11.2",
        fanotes_updater::PRODUCT_PUBLIC_KEY_PEM,
        Platform::Linux,
        fanotes_updater::EXPECTED_KEY_ID,
        Channel::Stable,
    )
    .unwrap_err();
    assert!(
        error.message.contains("kryptografische Signatur"),
        "{error}"
    );
}

// ---------------------------------------------------------------- download

fn transfer(name: &str, data: &[u8], url: &str) -> TransferInfo {
    TransferInfo {
        file_name: name.into(),
        size_bytes: data.len() as u64,
        sha256: sha256_hex(data),
        url: url.into(),
    }
}

fn options<'a>(cancel: &'a AtomicBool) -> TransferOptions<'a> {
    let mut options = TransferOptions::new(
        Platform::Linux,
        "2026.11.2",
        "application/octet-stream",
        cancel,
    );
    options.retry_delay = std::time::Duration::from_millis(1);
    options
}

const FILE_URL: &str = "https://github.com/Nikoheld/FaNotes/releases/download/v2026.11.3/file.bin";

#[test]
fn download_verifies_size_and_hash_then_renames() {
    let dir = tempfile::tempdir().unwrap();
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let mock = Mock::new();
    let served = data.clone();
    mock.route(FILE_URL, move |r| ranged(&served, r, None));
    let cancel = AtomicBool::new(false);
    let mut seen = Vec::new();
    let mut progress = |done: u64, total: u64| seen.push((done, total));
    let mut opts = options(&cancel);
    opts.progress = Some(&mut progress);
    let path = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        opts,
    )
    .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), data);
    assert!(!dir.path().join("file.bin.part").exists());
    assert_eq!(seen.last(), Some(&(data.len() as u64, data.len() as u64)));
    // an intact final file is reused without a request
    let again = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap();
    assert_eq!(again, path);
    assert_eq!(mock.count(FILE_URL), 1);
}

#[test]
fn wrong_hash_is_discarded_and_never_installed() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![1u8; 100_000];
    let mut tampered = data.clone();
    tampered[500] ^= 0xFF;
    let mock = Mock::new();
    mock.route(FILE_URL, move |r| ranged(&tampered, r, None));
    let cancel = AtomicBool::new(false);
    let error = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Hash);
    assert!(error.message.contains("SHA-256-Prüfung des Downloads"));
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        0,
        "neither .part nor final file remains"
    );
    assert_eq!(mock.count(FILE_URL), 1, "a hash failure is not retried");
}

#[test]
fn announced_size_mismatch_and_oversize_bodies_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![3u8; 50_000];
    let cancel = AtomicBool::new(false);
    // content-length announces another size
    let mock = Mock::new();
    mock.route(FILE_URL, |_| {
        Ok(Response::new(
            200,
            &[("content-length", "49999")],
            vec![3u8; 49_999],
        ))
    });
    let error = download_transfer(
        &Net(mock),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert!(error.message.contains("unerwartete Downloadgröße"));
    // body longer than announced, with a matching header
    let mock = Mock::new();
    mock.route(FILE_URL, |_| {
        Ok(Response::new(
            200,
            &[("content-length", "50000")],
            vec![3u8; 60_000],
        ))
    });
    let error = download_transfer(
        &Net(mock),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Size);
    assert!(error.message.contains("größer als angekündigt"));
    // body shorter than announced: premature close, retried, then stalls out
    let mock = Mock::new();
    mock.route(FILE_URL, |_| {
        Ok(Response::new(
            200,
            &[("content-length", "50000")],
            vec![3u8; 10],
        ))
    });
    let error = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert!(error.message.contains("nicht vollständig"), "{error}");
    // quirk preserved from JS: a response without Content-Length is refused
    let mock = Mock::new();
    mock.route(FILE_URL, |_| Ok(Response::new(200, &[], vec![3u8; 50_000])));
    let error = download_transfer(
        &Net(mock),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert!(error.message.contains("unerwartete Downloadgröße"));
}

#[test]
fn dropped_connection_resumes_with_a_range_request() {
    let dir = tempfile::tempdir().unwrap();
    let data: Vec<u8> = (0..400_000u32).map(|i| (i % 253) as u8).collect();
    let mock = Mock::new();
    let served = data.clone();
    let first = Arc::new(AtomicBool::new(true));
    mock.route(FILE_URL, move |r| {
        let drop = first.swap(false, Ordering::SeqCst).then_some(100_000);
        ranged(&served, r, drop)
    });
    let cancel = AtomicBool::new(false);
    let path = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap();
    assert_eq!(std::fs::read(path).unwrap(), data);
    let requests = mock.requests(FILE_URL);
    assert_eq!(requests.len(), 2);
    assert_eq!(header(&requests[0], "range"), None);
    assert_eq!(header(&requests[1], "range"), Some("bytes=100000-"));
}

#[test]
fn an_existing_part_file_is_resumed() {
    let dir = tempfile::tempdir().unwrap();
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 249) as u8).collect();
    std::fs::write(dir.path().join("file.bin.part"), &data[..data.len() / 3]).unwrap();
    let mock = Mock::new();
    let served = data.clone();
    mock.route(FILE_URL, move |r| ranged(&served, r, None));
    let cancel = AtomicBool::new(false);
    download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap();
    assert_eq!(
        header(&mock.requests(FILE_URL)[0], "range"),
        Some("bytes=100000-")
    );
}

#[test]
fn bad_content_range_and_ignored_range_headers() {
    let dir = tempfile::tempdir().unwrap();
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 247) as u8).collect();
    let cancel = AtomicBool::new(false);
    std::fs::write(dir.path().join("file.bin.part"), &data[..50_000]).unwrap();
    // 206 with a wrong start offset
    let mock = Mock::new();
    let served = data.clone();
    mock.route(FILE_URL, move |_| {
        Ok(Response::new(
            206,
            &[
                ("content-length", "150000"),
                (
                    "content-range",
                    &format!("bytes 1-{}/{}", served.len() - 1, served.len()),
                ),
            ],
            served[50_000..].to_vec(),
        ))
    });
    let error = download_transfer(
        &Net(mock),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert!(error.message.contains("Fortsetzungsbereich"));
    // a server that ignores Range and answers 200: restart from zero
    std::fs::write(dir.path().join("file.bin.part"), &data[..50_000]).unwrap();
    let mock = Mock::new();
    let served = data.clone();
    mock.route(FILE_URL, move |_| {
        Ok(Response::new(
            200,
            &[("content-length", &served.len().to_string())],
            served.clone(),
        ))
    });
    let path = download_transfer(
        &Net(mock),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap();
    assert_eq!(std::fs::read(path).unwrap(), data);
}

#[test]
fn a_captive_portal_answer_is_diagnosed_and_not_retried() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![2u8; 70_000];
    let mock = Mock::new();
    mock.route(FILE_URL, |_| {
        Ok(Response::new(
            302,
            &[
                ("location", "http://captive.schule.local/login"),
                ("content-type", "text/html"),
            ],
            b"<title>Login</title>".to_vec(),
        ))
    });
    let cancel = AtomicBool::new(false);
    let error = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    let diagnosis = error.diagnosis.as_ref().expect("diagnosis");
    assert_eq!(
        (diagnosis.kind, diagnosis.location_host.as_deref()),
        ("redirect", Some("captive.schule.local"))
    );
    assert!(error.message.contains("umgeleitet"));
    assert_eq!(mock.count(FILE_URL), 1);
    // HTML with a 200 status is refused too
    let mock = Mock::new();
    mock.route(FILE_URL, |_| {
        Ok(Response::new(
            200,
            &[("content-type", "text/html"), ("content-length", "70000")],
            vec![b'<'; 70_000],
        ))
    });
    assert_eq!(
        download_transfer(
            &Net(mock),
            &transfer("file.bin", &data, FILE_URL),
            dir.path(),
            options(&cancel)
        )
        .unwrap_err()
        .diagnosis
        .unwrap()
        .kind,
        "captive-portal"
    );
}

#[test]
fn repeated_failures_without_progress_give_up_after_four_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![2u8; 70_000];
    let mock = Mock::new();
    mock.route(FILE_URL, |_| Err(network_error("ECONNRESET")));
    let cancel = AtomicBool::new(false);
    let error = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("ECONNRESET"));
    assert_eq!(mock.count(FILE_URL), 4);
    // a non-retryable error is raised at once
    let mock = Mock::new();
    mock.route(FILE_URL, |_| {
        Err(fanotes_updater::UpdateError::new(
            ErrorKind::Network,
            "certificate has expired",
        ))
    });
    assert!(download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel)
    )
    .is_err());
    assert_eq!(mock.count(FILE_URL), 1);
}

#[test]
fn cancelling_stops_the_download() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![2u8; 70_000];
    let mock = Mock::new();
    let served = data.clone();
    mock.route(FILE_URL, move |r| ranged(&served, r, None));
    let cancel = AtomicBool::new(true);
    let error = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, FILE_URL),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Cancelled);
    assert_eq!(mock.count(FILE_URL), 0);
}

#[test]
fn download_refuses_untrusted_urls_before_any_request() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![2u8; 70_000];
    let mock = Mock::new();
    let cancel = AtomicBool::new(false);
    let error = download_transfer(
        &Net(mock.clone()),
        &transfer("file.bin", &data, "https://evil.example/file.bin"),
        dir.path(),
        options(&cancel),
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Untrusted);
    assert!(mock.log.lock().unwrap().is_empty());
}

// ---------------------------------------------------------------- full client flow

#[test]
fn delta_update_is_reconstructed_and_survives_a_restart() {
    let w = World::new();
    let installed = w.installed();
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, true),
    );
    w.serve_packages("2026.11.3");
    let mut client = w.client("2026.11.2", Channel::Stable, Some(installed.clone()));
    let manifest = expect_available(client.check().unwrap());
    let cancel = AtomicBool::new(false);
    let staged = client.download(&manifest, &cancel, None).unwrap();
    assert!(staged.used_delta, "fallback: {:?}", staged.fallback_reason);
    assert_eq!(std::fs::read(&staged.target_path).unwrap(), w.build.target);
    assert_eq!(staged.transfer_bytes, w.build.patch.len() as u64);
    assert!(staged.transfer_bytes < staged.size_bytes / 10);
    let patch_path = w
        .root()
        .join("2026.11.3")
        .join(&manifest.delta.as_ref().unwrap().file_name);
    assert!(!patch_path.exists(), "the patch is removed once applied");
    client.verify_staged(&manifest, &staged).unwrap();
    assert_eq!(
        w.mock.count(&github_release_asset_url(
            "2026.11.3",
            "FaNotes-2026.11.3-x86_64.AppImage"
        )),
        0,
        "full package untouched"
    );

    // restart: the finished download comes back as Staged without any transfer
    let mut relaunched = w.client("2026.11.2", Channel::Stable, Some(installed));
    match relaunched.check().unwrap() {
        CheckOutcome::Staged(m, s) => assert!(s.used_delta && m.latest_version == "2026.11.3"),
        other => panic!("expected Staged, got {other:?}"),
    }
    let pending = relaunched
        .state()
        .pending_install
        .as_ref()
        .expect("pending install persisted");
    assert_eq!(
        (pending.version.as_str(), pending.used_delta),
        ("2026.11.3", true)
    );

    // tampering with the staged file is caught before install
    std::fs::write(&staged.target_path, b"swapped").unwrap();
    assert_eq!(
        client.verify_staged(&manifest, &staged).unwrap_err().kind,
        ErrorKind::Hash
    );
}

#[test]
fn modified_installation_falls_back_to_the_signed_full_package() {
    let w = World::new();
    let installed = w.installed();
    // flip one byte in the installed file: the delta base no longer matches
    let mut changed = w.build.source.clone();
    changed[1000] ^= 1;
    std::fs::write(&installed, changed).unwrap();
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, true),
    );
    w.serve_packages("2026.11.3");
    let mut client = w.client("2026.11.2", Channel::Stable, Some(installed));
    let manifest = expect_available(client.check().unwrap());
    let staged = client
        .download(&manifest, &AtomicBool::new(false), None)
        .unwrap();
    assert!(!staged.used_delta);
    assert!(
        staged
            .fallback_reason
            .as_deref()
            .is_some_and(|r| r.contains("verändert")),
        "{:?}",
        staged.fallback_reason
    );
    assert_eq!(std::fs::read(&staged.target_path).unwrap(), w.build.target);
    assert_eq!(
        w.mock.count(&github_release_asset_url(
            "2026.11.3",
            "FaNotes-Delta-linux-x64-2026.11.2-to-2026.11.3.fndelta"
        )),
        0,
        "no patch is downloaded for a changed base"
    );
}

#[test]
fn a_corrupt_patch_falls_back_and_a_missing_base_skips_the_delta() {
    let w = World::new();
    let installed = w.installed();
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, true),
    );
    w.serve_packages("2026.11.3");
    // the patch served over the network differs from the signed hash
    let patch_url = github_release_asset_url(
        "2026.11.3",
        "FaNotes-Delta-linux-x64-2026.11.2-to-2026.11.3.fndelta",
    );
    let mut corrupt = w.build.patch.clone();
    *corrupt.last_mut().unwrap() ^= 0xFF;
    w.mock.route(&patch_url, move |r| ranged(&corrupt, r, None));
    let mut client = w.client("2026.11.2", Channel::Stable, Some(installed));
    let manifest = expect_available(client.check().unwrap());
    let staged = client
        .download(&manifest, &AtomicBool::new(false), None)
        .unwrap();
    assert!(!staged.used_delta);
    assert!(staged.fallback_reason.unwrap().contains("SHA-256"));
    assert_eq!(std::fs::read(&staged.target_path).unwrap(), w.build.target);

    // no local base configured: straight to the full package
    let w2 = World::new();
    w2.serve_stable_latest("2026.11.3");
    w2.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w2.build, true),
    );
    w2.serve_packages("2026.11.3");
    let mut client = w2.client("2026.11.2", Channel::Stable, None);
    let manifest = expect_available(client.check().unwrap());
    let staged = client
        .download(&manifest, &AtomicBool::new(false), None)
        .unwrap();
    assert!(
        !staged.used_delta
            && staged
                .fallback_reason
                .unwrap()
                .contains("keine sichere lokale Basis")
    );
}

#[test]
fn a_tampered_full_package_fails_without_a_fallback() {
    let w = World::new();
    w.serve_stable_latest("2026.11.3");
    w.serve_manifest(
        "2026.11.3",
        "stable",
        &linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, false),
    );
    let mut bad = w.build.target.clone();
    bad[4242] ^= 0x10;
    let url = github_release_asset_url("2026.11.3", "FaNotes-2026.11.3-x86_64.AppImage");
    w.mock.route(&url, move |r| ranged(&bad, r, None));
    let mut client = w.client("2026.11.2", Channel::Stable, None);
    let manifest = expect_available(client.check().unwrap());
    let error = client
        .download(&manifest, &AtomicBool::new(false), None)
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Hash);
    assert!(client.state().pending_install.is_none());
    let version_dir = w.root().join("2026.11.3");
    assert!(
        std::fs::read_dir(version_dir).unwrap().next().is_none(),
        "nothing left behind"
    );
}

#[test]
fn download_requires_a_newer_verified_manifest() {
    let w = World::new();
    w.serve_stable_latest("2026.11.2");
    w.serve_manifest(
        "2026.11.2",
        "stable",
        &linux_payload("2026.11.2", "2026.11.2", "stable", &w.build, false),
    );
    let mut client = w.client("2026.11.2", Channel::Stable, None);
    let CheckOutcome::UpToDate(manifest) = client.check().unwrap() else {
        panic!("expected up to date")
    };
    assert!(client
        .download(&manifest, &AtomicBool::new(false), None)
        .is_err());
}

#[cfg(feature = "reqwest-fetcher")]
#[test]
fn the_real_fetcher_builds_without_touching_the_network() {
    let fetcher = fanotes_updater::reqwest_fetcher::ReqwestFetcher::default();
    let _: &dyn fanotes_updater::Fetcher = &fetcher;
}

// ---------------------------------------------------------------- divergences from JS (documented)

#[test]
fn divergence_non_string_urls_are_rejected_not_coerced() {
    // JS `new URL(["https://..."])` coerces a one-element array to a string and accepts it.
    // The Rust port requires a real JSON string.
    let w = World::new();
    let mut payload = linux_payload("2026.11.2", "2026.11.3", "stable", &w.build, false);
    let url = payload["packages"]["appimage"]["url"].clone();
    payload["packages"]["appimage"]["url"] = json!([url]);
    let manifest = sign(&payload, &w.key);
    let error = fanotes_updater::verify_manifest(
        &manifest,
        "2026.11.2",
        &public_pem(&w.key),
        Platform::Linux,
        KEY_ID,
        Channel::Stable,
    )
    .unwrap_err();
    assert!(error.message.contains("ungültig"), "{error}");
}
