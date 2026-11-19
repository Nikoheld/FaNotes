//! Port of `verifyManifest` and its package/delta validators.
//!
//! A manifest is trusted only after (1) the key id matches, (2) the Ed25519
//! signature over `stableStringify(payload)` verifies against the pinned key,
//! and (3) every field passes the same checks as the Electron updater, in the
//! same order, with the same messages.

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

use crate::date;
use crate::error::{err, ErrorKind, Result};
use crate::hosts::{assert_github_release_url, PRODUCT_ORIGIN};
use crate::json::stable_stringify;
use crate::platform::{PackageKind, Platform, MAX_PACKAGE_BYTES, MIN_PACKAGE_BYTES};
use crate::util::{plain_object, safe_integer, str_eq, utf16_len};
use crate::version::{compare_versions, is_valid_version, Channel};

/// Key id of the production signing key (`update-public-key.pem`).
pub const EXPECTED_KEY_ID: &str = "33006e5c06939bc9";
/// The production public key, embedded at build time.
pub const PRODUCT_PUBLIC_KEY_PEM: &str =
    include_str!("../../../fanotes/electron/update-public-key.pem");
pub const DELTA_FORMAT: &str = "fanotes-delta-v1";

static SHA256_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-f0-9]{64}$").unwrap());
static BASE64_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/]+={0,2}$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageInfo {
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeltaFile {
    pub kind: String,
    pub size_bytes: u64,
    pub sha256: String,
    /// Only present on the target.
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeltaInfo {
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub url: String,
    pub source: DeltaFile,
    pub target: DeltaFile,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedManifest {
    pub channel: Channel,
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub mandatory: bool,
    pub published_at: String,
    pub release_notes: Vec<String>,
    pub packages: BTreeMap<PackageKind, PackageInfo>,
    pub delta: Option<DeltaInfo>,
    pub website_url: String,
}

impl VerifiedManifest {
    pub fn primary_package(&self, platform: Platform) -> &PackageInfo {
        &self.packages[&platform.primary_package()]
    }
}

/// `strictBase64`: canonical standard base64, 64..=256 characters.
fn strict_base64(value: Option<&Value>) -> Option<Vec<u8>> {
    let text = value?.as_str()?;
    if text.len() < 64 || text.len() > 256 || !BASE64_PATTERN.is_match(text) {
        return None;
    }
    let decoded = STANDARD.decode(text).ok()?;
    (STANDARD.encode(&decoded) == text).then_some(decoded)
}

fn verify_signature(payload_text: &str, signature: &[u8], public_key_pem: &str) -> bool {
    let Ok(key) = VerifyingKey::from_public_key_pem(public_key_pem) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(payload_text.as_bytes(), &signature)
        .is_ok()
}

fn validate_package(
    candidate: Option<&Value>,
    version: &str,
    kind: PackageKind,
    platform: Platform,
) -> Result<PackageInfo> {
    let label = platform.package_label(kind);
    let Some(object) = plain_object(candidate) else {
        return err(
            ErrorKind::Manifest,
            format!("Das {label}-Paket fehlt im Update-Manifest."),
        );
    };
    let expected_name = platform.package_file_name(kind, version);
    if !str_eq(object.get("fileName"), &expected_name) {
        return err(
            ErrorKind::Manifest,
            format!("Der {label}-Dateiname ist ungültig."),
        );
    }
    let size = match safe_integer(object.get("sizeBytes")) {
        Some(size) if (MIN_PACKAGE_BYTES..=MAX_PACKAGE_BYTES).contains(&size) => size,
        _ => {
            return err(
                ErrorKind::Size,
                format!("Die {label}-Dateigröße ist ungültig."),
            )
        }
    };
    let sha256 = match object.get("sha256").and_then(Value::as_str) {
        Some(hash) if SHA256_PATTERN.is_match(hash) => hash.to_owned(),
        _ => {
            return err(
                ErrorKind::Manifest,
                format!("Die {label}-Prüfsumme ist ungültig."),
            )
        }
    };
    let url = assert_github_release_url(
        object.get("url"),
        version,
        &expected_name,
        &format!("Die {label}-Downloadadresse"),
    )?;
    Ok(PackageInfo {
        file_name: expected_name,
        size_bytes: size,
        sha256,
        url,
    })
}

fn validate_delta_file(
    candidate: Option<&Value>,
    label: &str,
    expected_kind: &str,
) -> Result<DeltaFile> {
    let Some(object) = plain_object(candidate).filter(|o| str_eq(o.get("kind"), expected_kind))
    else {
        return err(
            ErrorKind::Delta,
            format!("Die {label}-Beschreibung des Delta-Updates ist ungültig."),
        );
    };
    let size = match safe_integer(object.get("sizeBytes")) {
        Some(size) if size > 0 && size <= MAX_PACKAGE_BYTES => size,
        _ => {
            return err(
                ErrorKind::Size,
                format!("Die {label}-Größe des Delta-Updates ist ungültig."),
            )
        }
    };
    let sha256 = match object.get("sha256").and_then(Value::as_str) {
        Some(hash) if SHA256_PATTERN.is_match(hash) => hash.to_owned(),
        _ => {
            return err(
                ErrorKind::Delta,
                format!("Die {label}-Prüfsumme des Delta-Updates ist ungültig."),
            )
        }
    };
    // JS copies `fileName` unchecked; the target name is compared right after.
    let file_name = (label == "Zieldatei")
        .then(|| {
            object
                .get("fileName")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten();
    Ok(DeltaFile {
        kind: expected_kind.to_owned(),
        size_bytes: size,
        sha256,
        file_name,
    })
}

/// How JS renders `payload.currentVersion` inside the delta file name template.
fn js_template_current_version(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::String(text)) => text.clone(),
        // Unreachable after the currentVersion equality check; kept total.
        Some(other) => other.to_string(),
    }
}

fn validate_delta(
    candidate: Option<&Value>,
    payload: &Map<String, Value>,
    platform: Platform,
    latest_version: &str,
    packages: &BTreeMap<PackageKind, PackageInfo>,
) -> Result<Option<DeltaInfo>> {
    let candidate = match candidate {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value,
    };
    let Some(object) = candidate
        .as_object()
        .filter(|o| str_eq(o.get("format"), DELTA_FORMAT))
    else {
        return err(
            ErrorKind::Delta,
            "Das Update-Manifest enthält ein unbekanntes Delta-Format.",
        );
    };
    // The name embeds `payload.currentVersion`; a manifest without it expects "undefined".
    let expected_file_name = format!(
        "FaNotes-Delta-{}-x64-{}-to-{latest_version}.fndelta",
        payload
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("undefined"),
        js_template_current_version(payload.get("currentVersion")),
    );
    if !str_eq(object.get("fileName"), &expected_file_name) {
        return err(
            ErrorKind::Delta,
            "Der Dateiname des Delta-Updates ist ungültig.",
        );
    }
    let size = match safe_integer(object.get("sizeBytes")) {
        Some(size) if (256..=MAX_PACKAGE_BYTES).contains(&size) => size,
        _ => return err(ErrorKind::Size, "Die Größe des Delta-Updates ist ungültig."),
    };
    let sha256 = match object.get("sha256").and_then(Value::as_str) {
        Some(hash) if SHA256_PATTERN.is_match(hash) => hash.to_owned(),
        _ => {
            return err(
                ErrorKind::Delta,
                "Die Prüfsumme des Delta-Updates ist ungültig.",
            )
        }
    };
    let url = assert_github_release_url(
        object.get("url"),
        latest_version,
        &expected_file_name,
        "Die Adresse des Delta-Updates",
    )?;
    let expected_kind = platform.delta_kind();
    let source = validate_delta_file(object.get("source"), "Quelldatei", expected_kind)?;
    let target = validate_delta_file(object.get("target"), "Zieldatei", expected_kind)?;
    let appimage = packages.get(&PackageKind::AppImage);
    let expected_target_name = match platform {
        Platform::Linux => appimage.map_or("", |p| p.file_name.as_str()),
        Platform::Windows => "app.asar",
    };
    if target.file_name.as_deref() != Some(expected_target_name) {
        return err(
            ErrorKind::Delta,
            "Die Zieldatei des Delta-Updates ist ungültig.",
        );
    }
    if let (Platform::Linux, Some(appimage)) = (platform, appimage) {
        if target.size_bytes != appimage.size_bytes || target.sha256 != appimage.sha256 {
            return err(
                ErrorKind::Delta,
                "Das Delta-Ziel stimmt nicht mit dem signierten AppImage überein.",
            );
        }
    }
    Ok(Some(DeltaInfo {
        file_name: expected_file_name,
        size_bytes: size,
        sha256,
        url,
        source,
        target,
    }))
}

/// Verify a signed update manifest.
///
/// `expected_channel` is the channel the manifest must declare. The updater
/// passes the channel of the release it picked (not the user's channel), so a
/// beta user reading a stable release verifies it as `Stable`.
pub fn verify_manifest(
    candidate: &Value,
    current_version: &str,
    public_key_pem: &str,
    platform: Platform,
    expected_key_id: &str,
    expected_channel: Channel,
) -> Result<VerifiedManifest> {
    let Some(candidate_object) = candidate.as_object() else {
        return err(ErrorKind::Manifest, "Das Update-Manifest ist ungültig.");
    };
    let Some(signature) = plain_object(candidate_object.get("signature")) else {
        return err(ErrorKind::Manifest, "Das Update-Manifest ist ungültig.");
    };
    if !str_eq(signature.get("algorithm"), "ed25519")
        || !str_eq(signature.get("keyId"), expected_key_id)
    {
        return err(
            ErrorKind::Signature,
            "Das Update-Manifest wurde mit einem unbekannten Schlüssel signiert.",
        );
    }
    let Some(signature_bytes) = strict_base64(signature.get("value")) else {
        return err(
            ErrorKind::Signature,
            "Die Signatur des Update-Manifests ist ungültig.",
        );
    };
    let mut payload = candidate_object.clone();
    payload.remove("signature");
    if !verify_signature(
        &stable_stringify(&Value::Object(payload.clone())),
        &signature_bytes,
        public_key_pem,
    ) {
        return err(
            ErrorKind::Signature,
            "Die kryptografische Signatur des Updates ist ungültig.",
        );
    }

    let wrong_edition = "Das Update-Manifest ist nicht für diese FaNotes-Ausgabe bestimmt.";
    let channel = payload
        .get("channel")
        .and_then(Value::as_str)
        .and_then(Channel::parse);
    if payload.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
        || !str_eq(payload.get("product"), "FaNotes")
        || channel != Some(expected_channel)
        || !str_eq(payload.get("platform"), platform.manifest_platform())
        || !str_eq(payload.get("arch"), "x64")
    {
        return err(ErrorKind::Manifest, wrong_edition);
    }
    let latest_version = match payload.get("latestVersion").and_then(Value::as_str) {
        Some(version) if is_valid_version(version) => version.to_owned(),
        _ => return err(ErrorKind::Manifest, "Die angebotene Version ist ungültig."),
    };
    let update_available = compare_versions(&latest_version, current_version)?.is_gt();
    let Some(mandatory) = payload.get("mandatory").and_then(Value::as_bool) else {
        return err(
            ErrorKind::Manifest,
            "Der Update-Status im Manifest ist widersprüchlich.",
        );
    };
    // A GitHub release manifest is one file for every install. It names the
    // release, and the client decides whether that release is newer. A manifest
    // that still names currentVersion is the older per-request shape and must
    // match this install.
    let present = |key: &str| !matches!(payload.get(key), None | Some(Value::Null));
    if present("currentVersion") || present("updateAvailable") {
        if !str_eq(payload.get("currentVersion"), current_version) {
            return err(
                ErrorKind::Manifest,
                "Das Update-Manifest gehört zu einer anderen installierten Version.",
            );
        }
        if payload.get("updateAvailable").and_then(Value::as_bool) != Some(update_available) {
            return err(
                ErrorKind::Manifest,
                "Der Update-Status im Manifest ist widersprüchlich.",
            );
        }
    }
    let published_at = match payload.get("publishedAt").and_then(Value::as_str) {
        Some(text) if date::parse_date_ms(text).is_some() => text.to_owned(),
        _ => {
            return err(
                ErrorKind::Manifest,
                "Das Veröffentlichungsdatum ist ungültig.",
            )
        }
    };
    let notes_error = || err(ErrorKind::Manifest, "Die Release Notes sind ungültig.");
    let Some(notes) = payload
        .get("releaseNotes")
        .and_then(Value::as_array)
        .filter(|n| n.len() <= 20)
    else {
        return notes_error();
    };
    let mut release_notes = Vec::with_capacity(notes.len());
    for note in notes {
        match note.as_str() {
            Some(text) if utf16_len(text) <= 4000 => release_notes.push(text.to_owned()),
            _ => return notes_error(),
        }
    }
    let Some(package_map) = plain_object(payload.get("packages")) else {
        return err(ErrorKind::Manifest, "Das Update enthält keine Pakete.");
    };
    let mut packages = BTreeMap::new();
    for kind in platform.package_kinds() {
        packages.insert(
            kind,
            validate_package(package_map.get(kind.key()), &latest_version, kind, platform)?,
        );
    }
    let delta = validate_delta(
        payload.get("delta"),
        &payload,
        platform,
        &latest_version,
        &packages,
    )?;
    let website_url = format!("{PRODUCT_ORIGIN}/");
    if !str_eq(payload.get("websiteUrl"), &website_url) {
        return err(
            ErrorKind::Manifest,
            "Die Website-Adresse im Update-Manifest ist ungültig.",
        );
    }
    Ok(VerifiedManifest {
        channel: expected_channel,
        current_version: current_version.to_owned(),
        latest_version,
        update_available,
        mandatory,
        published_at,
        release_notes,
        packages,
        delta,
        website_url,
    })
}
