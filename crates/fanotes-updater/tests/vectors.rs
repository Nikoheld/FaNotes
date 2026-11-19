//! Runs every case of `fanotes/scripts/fixtures/updater/vectors.json` through
//! the Rust port. The same file is checked against the JavaScript updater by
//! `node fanotes/scripts/check-updater-vectors.mjs` (JS is the oracle that
//! wrote the expectations), so both implementations agree on every case,
//! including the exact German error text.
//!
//! Known, deliberate differences from JavaScript are NOT in this file; they
//! are covered in `tests/behaviour.rs` (see "divergence" tests).

use std::path::PathBuf;

use base64::Engine;
use fanotes_updater::delta::{apply_delta_patch, ApplyOptions, ExpectedFile, ExpectedHeader};
use fanotes_updater::diagnosis::{
    diagnose_update_failure, is_private_address, DiagnoseInput, Phase, ResponseMeta,
};
use fanotes_updater::error::UpdateError;
use fanotes_updater::hosts::assert_model_download_url;
use fanotes_updater::json::stable_stringify;
use fanotes_updater::release::pick_update_release;
use fanotes_updater::release_policy::{check_release_policy, ReleaseKind};
use fanotes_updater::util::sha256_file;
use fanotes_updater::version::{
    channel_for_packaged_version, compare_versions, is_delta_route, is_download_route,
    is_linux_package_name, is_windows_package_name, nightly_version, release_visible_on_channel,
    version_channel, Channel,
};
use fanotes_updater::{verify_manifest, PackageKind, Platform, VerifiedManifest};
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fanotes/scripts/fixtures/updater/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("vectors.json"))
        .expect("valid json")
}

fn error_value(error: &UpdateError) -> Value {
    json!({ "error": error.message })
}

fn eval_version_compare(input: &Value) -> Value {
    let (a, b) = (input[0].as_str().unwrap(), input[1].as_str().unwrap());
    match compare_versions(a, b) {
        Ok(ordering) => json!({ "sign": ordering as i8 }),
        Err(error) => error_value(&error),
    }
}

fn eval_version_visible(input: &Value) -> Value {
    let (version, channel) = (input[0].as_str().unwrap(), input[1].as_str().unwrap());
    // JS validates the version first, then maps an unknown channel to "not visible".
    if let Err(error) = version_channel(version) {
        return error_value(&error);
    }
    match Channel::parse(channel) {
        Some(channel) => {
            json!({ "visible": release_visible_on_channel(version, channel).unwrap() })
        }
        None => json!({ "visible": false }),
    }
}

fn eval_nightly(input: &Value) -> Value {
    match nightly_version(
        input["base"].as_str().unwrap(),
        input["committedAt"].as_str().unwrap(),
        input["sha"].as_str().unwrap(),
    ) {
        Ok(version) => json!({ "version": version }),
        Err(error) => error_value(&error),
    }
}

fn eval_names(input: &Value) -> Value {
    let name = input[1].as_str().unwrap();
    let matched = match input[0].as_str().unwrap() {
        "linux" => is_linux_package_name(name),
        "windows" => is_windows_package_name(name),
        "delta" => is_delta_route(name),
        "download" => is_download_route(name),
        other => panic!("unknown name kind {other}"),
    };
    json!({ "match": matched })
}

fn eval_model_host(input: &Value) -> Value {
    match assert_model_download_url(input[0].as_str().unwrap(), input[1].as_str()) {
        Ok(url) => json!({ "href": url.as_str() }),
        Err(error) => error_value(&error),
    }
}

fn eval_policy(input: &Value) -> Value {
    let tags: Vec<&str> = input["tags"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let year = input["zurich"]["year"].as_u64().unwrap() as u32;
    let month = input["zurich"]["month"].as_u64().unwrap() as u32;
    match check_release_policy(input["version"].as_str().unwrap(), year, month, &tags) {
        Ok(ReleaseKind::Stable) => json!({ "kind": "stable" }),
        Ok(ReleaseKind::Beta) => json!({ "kind": "beta" }),
        Err(error) => error_value(&error),
    }
}

fn platform_of(name: &str) -> Result<Platform, UpdateError> {
    Platform::from_node_platform(name)
}

fn eval_pick(input: &Value) -> Value {
    let platform = match input["platform"].as_str().unwrap() {
        "windows" => Platform::Windows,
        _ => Platform::Linux,
    };
    // JS returns null for a channel it does not know; Channel has no such value.
    let Some(channel) = Channel::parse(input["channel"].as_str().unwrap()) else {
        return json!({ "picked": null });
    };
    match pick_update_release(&input["releases"], channel, platform).unwrap() {
        Some(p) => {
            json!({ "picked": { "tagVersion": p.tag_version, "assetName": p.asset_name, "kind": p.kind.as_str(), "assetUrl": p.asset_url } })
        }
        None => json!({ "picked": null }),
    }
}

fn eval_diagnose(input: &Value) -> Value {
    let error = input.get("error").map(|e| {
        let abort = e.get("name").and_then(Value::as_str) == Some("AbortError");
        let mut error = if abort {
            UpdateError::cancelled(e["message"].as_str().unwrap())
        } else {
            UpdateError::new(
                fanotes_updater::ErrorKind::Network,
                e["message"].as_str().unwrap(),
            )
        };
        if let Some(code) = e.get("code").and_then(Value::as_str) {
            error.code = Some(code.to_owned());
        }
        error
    });
    let response = input.get("response").map(|r| ResponseMeta {
        status: r["status"].as_u64().unwrap() as u16,
        location: r["headers"]
            .get("location")
            .and_then(Value::as_str)
            .map(str::to_owned),
        content_type: r["headers"]
            .get("content-type")
            .and_then(Value::as_str)
            .map(str::to_owned),
    });
    let diagnosis = diagnose_update_failure(&DiagnoseInput {
        phase: if input["phase"] == "check" {
            Phase::Check
        } else {
            Phase::Download
        },
        url: input["url"].as_str().unwrap(),
        error: error.as_ref(),
        response: response.as_ref(),
        body_text: input.get("bodyText").and_then(Value::as_str).unwrap_or(""),
        resolved_address: input.get("resolvedAddress").and_then(Value::as_str),
    });
    json!({ "diagnosis": {
        "kind": diagnosis.kind, "summary": diagnosis.summary, "message": diagnosis.message,
        "phase": diagnosis.phase.as_str(), "host": diagnosis.host, "url": diagnosis.url,
        "status": diagnosis.status, "locationHost": diagnosis.location_host, "pageTitle": diagnosis.page_title,
        "contentType": diagnosis.content_type, "code": diagnosis.code, "resolvedAddress": diagnosis.resolved_address,
    } })
}

fn summarize(verified: &VerifiedManifest) -> Value {
    let mut packages = serde_json::Map::new();
    for (kind, package) in &verified.packages {
        packages.insert(
            kind.key().to_owned(),
            json!({ "fileName": package.file_name, "url": package.url, "sizeBytes": package.size_bytes, "sha256": package.sha256 }),
        );
    }
    let delta = verified.delta.as_ref().map_or(Value::Null, |d| {
        json!({
            "format": "fanotes-delta-v1", "fileName": d.file_name, "sizeBytes": d.size_bytes, "sha256": d.sha256, "url": d.url,
            "source": { "kind": d.source.kind, "sizeBytes": d.source.size_bytes, "sha256": d.source.sha256 },
            "target": { "kind": d.target.kind, "fileName": d.target.file_name, "sizeBytes": d.target.size_bytes, "sha256": d.target.sha256 },
        })
    });
    json!({
        "schemaVersion": 1, "channel": verified.channel.as_str(), "currentVersion": verified.current_version,
        "latestVersion": verified.latest_version, "updateAvailable": verified.update_available, "mandatory": verified.mandatory,
        "publishedAt": verified.published_at, "releaseNotes": verified.release_notes, "packages": packages,
        "delta": delta, "websiteUrl": verified.website_url,
    })
}

fn eval_manifest(input: &Value, keys: &Value) -> Value {
    let platform = match platform_of(input["platform"].as_str().unwrap()) {
        Ok(platform) => platform,
        Err(error) => return error_value(&error),
    };
    let pem = input
        .get("publicKeyPem")
        .and_then(Value::as_str)
        .unwrap_or_else(|| keys["publicPem"].as_str().unwrap());
    let key_id = input
        .get("keyId")
        .and_then(Value::as_str)
        .unwrap_or_else(|| keys["keyId"].as_str().unwrap());
    let channel = Channel::parse(input["channel"].as_str().unwrap()).unwrap();
    match verify_manifest(
        &input["manifest"],
        input["currentVersion"].as_str().unwrap(),
        pem,
        platform,
        key_id,
        channel,
    ) {
        Ok(verified) => json!({ "ok": summarize(&verified) }),
        Err(error) => error_value(&error),
    }
}

fn expected_file(value: &Value) -> Option<ExpectedFile> {
    let object = value.as_object()?;
    Some(ExpectedFile {
        kind: object
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned),
        file_name: object
            .get("fileName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        size_bytes: object.get("sizeBytes").and_then(Value::as_u64),
        sha256: object
            .get("sha256")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn eval_delta(input: &Value) -> Value {
    let b64 = base64::engine::general_purpose::STANDARD;
    let directory = tempfile::tempdir().unwrap();
    let (source, patch, output) = (
        directory.path().join("source.bin"),
        directory.path().join("patch.fndelta"),
        directory.path().join("output.bin"),
    );
    std::fs::write(
        &source,
        b64.decode(input["sourceB64"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    std::fs::write(
        &patch,
        b64.decode(input["patchB64"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let expected = input.get("expected").map(|e| ExpectedHeader {
        platform: e["platform"].as_str().map(str::to_owned),
        base_version: e["baseVersion"].as_str().map(str::to_owned),
        target_version: e["targetVersion"].as_str().map(str::to_owned),
        source: expected_file(&e["source"]),
        target: expected_file(&e["target"]),
    });
    match apply_delta_patch(
        &patch,
        &source,
        &output,
        ApplyOptions {
            expected: expected.as_ref(),
            cancel: None,
            progress: None,
        },
    ) {
        Ok(header) => json!({ "ok": {
            "platform": header.platform, "baseVersion": header.base_version, "targetVersion": header.target_version,
            "targetFileName": header.target.file_name, "targetSizeBytes": header.target.size_bytes,
            "targetSha256": sha256_file(&output).unwrap(),
        } }),
        Err(error) => json!({ "error": error.message, "outputRemoved": !output.exists() }),
    }
}

fn evaluate(section: &str, input: &Value, keys: &Value) -> Value {
    match section {
        "versionCompare" => eval_version_compare(input),
        "versionVisible" => eval_version_visible(input),
        "versionPackaged" => {
            json!({ "channel": channel_for_packaged_version(input.as_str().unwrap()).as_str() })
        }
        "versionNightly" => eval_nightly(input),
        "names" => eval_names(input),
        "stringify" => {
            json!({ "text": stable_stringify(&serde_json::from_str::<Value>(input.as_str().unwrap()).unwrap()) })
        }
        "privateAddress" => json!({ "private": is_private_address(input.as_str().unwrap()) }),
        "modelHost" => eval_model_host(input),
        "policy" => eval_policy(input),
        "pick" => eval_pick(input),
        "diagnose" => eval_diagnose(input),
        "manifest" => eval_manifest(input, keys),
        "delta" => eval_delta(input),
        other => panic!("unknown section {other}"),
    }
}

#[test]
fn every_shared_vector_matches_the_javascript_oracle() {
    let document = vectors();
    let keys = &document["keys"];
    let mut failures = Vec::new();
    let mut counts = Vec::new();
    for (section, cases) in document["sections"].as_object().unwrap() {
        let cases = cases.as_array().unwrap();
        counts.push(format!("{section}={}", cases.len()));
        for case in cases {
            let actual = evaluate(section, &case["input"], keys);
            if actual != case["expect"] {
                let label = case
                    .get("name")
                    .and_then(Value::as_str)
                    .map_or_else(|| case["input"].to_string(), str::to_owned);
                failures.push(format!(
                    "[{section}] {}\n  expected {}\n  actual   {}",
                    &label[..label.len().min(120)],
                    &case["expect"].to_string()[..case["expect"].to_string().len().min(400)],
                    &actual.to_string()[..actual.to_string().len().min(400)],
                ));
            }
        }
    }
    println!("vector sections: {}", counts.join(" "));
    assert!(
        failures.is_empty(),
        "{} vectors disagree with JS:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

// One test per section as well, so a failure names the area in CI output.
macro_rules! section_test {
    ($name:ident, $section:literal) => {
        #[test]
        fn $name() {
            let document = vectors();
            let cases = document["sections"][$section].as_array().expect($section);
            assert!(!cases.is_empty());
            for case in cases {
                let actual = evaluate($section, &case["input"], &document["keys"]);
                assert_eq!(
                    actual,
                    case["expect"],
                    "{} {}",
                    $section,
                    case.get("name").unwrap_or(&case["input"])
                );
            }
        }
    };
}
section_test!(vectors_version_compare, "versionCompare");
section_test!(vectors_version_visible, "versionVisible");
section_test!(vectors_version_packaged, "versionPackaged");
section_test!(vectors_version_nightly, "versionNightly");
section_test!(vectors_package_and_route_names, "names");
section_test!(vectors_stable_stringify, "stringify");
section_test!(vectors_private_addresses, "privateAddress");
section_test!(vectors_model_hosts, "modelHost");
section_test!(vectors_release_policy, "policy");
section_test!(vectors_channel_pick, "pick");
section_test!(vectors_diagnosis, "diagnose");
section_test!(vectors_manifest, "manifest");
section_test!(vectors_delta, "delta");

#[test]
fn vectors_cover_the_required_negative_cases() {
    let document = vectors();
    let names: Vec<String> = ["manifest", "delta"]
        .iter()
        .flat_map(|s| document["sections"][s].as_array().unwrap())
        .filter_map(|c| c["name"].as_str().map(str::to_lowercase))
        .collect();
    for needle in [
        "tampered",
        "flipped bit",
        "wrong hash",
        "package url: other host",
        "downgrade",
        "oversize",
        "path traversal",
    ] {
        assert!(
            names.iter().any(|n| n.contains(needle)),
            "no vector mentions {needle}"
        );
    }
    let _ = PackageKind::AppImage;
}
