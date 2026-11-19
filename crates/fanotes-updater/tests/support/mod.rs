//! Shared helpers: a signing key, manifest builders, and a scripted network.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use base64::Engine;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use fanotes_updater::error::{Result, UpdateError};
use fanotes_updater::hosts::github_release_asset_url;
use fanotes_updater::json::stable_stringify;
use fanotes_updater::util::sha256_hex;
use fanotes_updater::{Fetcher, Request, Response};
use serde_json::{json, Value};

pub const KEY_ID: &str = "00112233aabbccdd";
pub const API: &str = "https://api.github.com/repos/Nikoheld/FaNotes/releases";

pub fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

pub fn public_pem(key: &SigningKey) -> String {
    key.verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap()
}

pub fn sign(payload: &Value, key: &SigningKey) -> Value {
    let signature = key.sign(stable_stringify(payload).as_bytes());
    let mut out = payload.clone();
    out["signature"] = json!({
        "algorithm": "ed25519",
        "keyId": KEY_ID,
        "value": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
    });
    out
}

pub struct Build {
    pub source: Vec<u8>,
    pub target: Vec<u8>,
    pub patch: Vec<u8>,
}

/// 12 MiB source, a target that differs in two regions, and a delta between them.
pub fn build_delta() -> Build {
    let size = 12 * 1024 * 1024usize;
    let source: Vec<u8> = (0..size)
        .map(|i| ((i * 31 + (i >> 9)) & 255) as u8)
        .collect();
    let head = vec![0xAAu8; 128];
    let mid = vec![0x5Cu8; 96 * 1024];
    let a = 5 * 1024 * 1024;
    let mut target = Vec::with_capacity(size);
    target.extend_from_slice(&head);
    target.extend_from_slice(&source[128..a]);
    target.extend_from_slice(&mid);
    target.extend_from_slice(&source[a + mid.len()..]);
    assert_eq!(target.len(), size);
    let header = json!({
        "format": "fanotes-delta-v1", "platform": "linux", "baseVersion": "2026.11.2", "targetVersion": "2026.11.3",
        "source": { "kind": "appimage", "sizeBytes": size, "sha256": sha256_hex(&source) },
        "target": { "kind": "appimage", "fileName": "FaNotes-2026.11.3-x86_64.AppImage", "sizeBytes": size, "sha256": sha256_hex(&target) },
        "operations": [
            { "kind": "data", "dataOffset": 0, "sizeBytes": head.len() },
            { "kind": "copy", "sourceOffset": 128, "sizeBytes": a - 128 },
            { "kind": "data", "dataOffset": head.len(), "sizeBytes": mid.len() },
            { "kind": "copy", "sourceOffset": a + mid.len(), "sizeBytes": size - a - mid.len() },
        ],
    });
    let encoded = serde_json::to_vec(&header).unwrap();
    let mut patch = b"FANOTESDELTA1\0\0\0".to_vec();
    patch.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
    patch.extend_from_slice(&encoded);
    patch.extend_from_slice(&head);
    patch.extend_from_slice(&mid);
    Build {
        source,
        target,
        patch,
    }
}

pub fn linux_payload(
    current: &str,
    latest: &str,
    channel: &str,
    build: &Build,
    with_delta: bool,
) -> Value {
    let appimage = format!("FaNotes-{latest}-x86_64.AppImage");
    let portable = format!("FaNotes-{latest}-x86_64.tar.gz");
    let delta = format!("FaNotes-Delta-linux-x64-{current}-to-{latest}.fndelta");
    let mut payload = json!({
        "schemaVersion": 1, "product": "FaNotes", "channel": channel, "platform": "linux", "arch": "x64",
        "currentVersion": current, "latestVersion": latest,
        "updateAvailable": fanotes_updater::compare_versions(latest, current).unwrap().is_gt(),
        "mandatory": false, "publishedAt": "2026-11-14T22:30:00.000Z", "releaseNotes": ["Delta updates"],
        "packages": {
            "appimage": { "fileName": appimage, "url": github_release_asset_url(latest, &appimage), "sizeBytes": build.target.len(), "sha256": sha256_hex(&build.target) },
            "portable": { "fileName": portable, "url": github_release_asset_url(latest, &portable), "sizeBytes": 11 * 1024 * 1024, "sha256": "b".repeat(64) },
        },
        "websiteUrl": "https://fanotes.fasrv.ch/",
    });
    payload["delta"] = if with_delta {
        json!({
            "format": "fanotes-delta-v1", "fileName": delta, "url": github_release_asset_url(latest, &delta),
            "sizeBytes": build.patch.len(), "sha256": sha256_hex(&build.patch),
            "source": { "kind": "appimage", "sizeBytes": build.source.len(), "sha256": sha256_hex(&build.source) },
            "target": { "kind": "appimage", "fileName": appimage, "sizeBytes": build.target.len(), "sha256": sha256_hex(&build.target) },
        })
    } else {
        Value::Null
    };
    payload
}

pub fn manifest_asset_name(kind: &str) -> String {
    if kind == "stable" {
        "FaNotes-update-linux-x64.json".into()
    } else {
        format!("FaNotes-update-linux-x64-{kind}.json")
    }
}

pub fn release_row(version: &str, kind: &str) -> Value {
    let name = manifest_asset_name(kind);
    json!({ "tag_name": format!("v{version}"), "draft": false, "assets": [{ "name": name, "browser_download_url": github_release_asset_url(version, &name) }] })
}

type Handler = Arc<dyn Fn(&Request) -> Result<Response> + Send + Sync>;

#[derive(Default)]
pub struct Mock {
    routes: Mutex<HashMap<String, Handler>>,
    pub log: Mutex<Vec<Request>>,
}

impl Mock {
    pub fn new() -> Arc<Mock> {
        Arc::new(Mock::default())
    }

    pub fn route(
        &self,
        url: &str,
        handler: impl Fn(&Request) -> Result<Response> + Send + Sync + 'static,
    ) {
        self.routes
            .lock()
            .unwrap()
            .insert(url.to_owned(), Arc::new(handler));
    }

    pub fn json(&self, url: &str, body: &Value) {
        let text = serde_json::to_vec(body).unwrap();
        self.route(url, move |_| {
            Ok(Response::new(
                200,
                &[
                    ("content-type", "application/json"),
                    ("content-length", &text.len().to_string()),
                ],
                text.clone(),
            ))
        });
    }

    pub fn count(&self, url: &str) -> usize {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.url == url)
            .count()
    }

    pub fn requests(&self, url: &str) -> Vec<Request> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.url == url)
            .cloned()
            .collect()
    }
}

#[derive(Clone)]
pub struct Net(pub Arc<Mock>);

impl Fetcher for Net {
    fn fetch(&self, request: &Request) -> Result<Response> {
        self.0.log.lock().unwrap().push(request.clone());
        let handler = self.0.routes.lock().unwrap().get(&request.url).cloned();
        match handler {
            Some(handler) => handler(request),
            None => Ok(Response::new(
                404,
                &[("content-type", "text/plain")],
                b"not found".to_vec(),
            )),
        }
    }
}

pub fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// A body that yields `limit` bytes and then fails like a dropped connection.
pub struct DropAfter {
    pub data: Vec<u8>,
    pub position: usize,
    pub limit: usize,
}

impl Read for DropAfter {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "socket hang up",
            ));
        }
        let end = (self.position + out.len())
            .min(self.limit)
            .min(self.data.len());
        let count = end - self.position;
        out[..count].copy_from_slice(&self.data[self.position..end]);
        self.position = end;
        Ok(count)
    }
}

pub fn ranged(data: &[u8], request: &Request, drop_after: Option<usize>) -> Result<Response> {
    let offset = header(request, "range")
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| r.strip_suffix('-'))
        .and_then(|r| r.parse::<usize>().ok())
        .unwrap_or(0);
    let body = data[offset..].to_vec();
    let mut headers = vec![("content-length".to_owned(), body.len().to_string())];
    if offset > 0 {
        headers.push((
            "content-range".to_owned(),
            format!("bytes {offset}-{}/{}", data.len() - 1, data.len()),
        ));
    }
    let reader: Box<dyn Read + Send> = match drop_after {
        Some(limit) => Box::new(DropAfter {
            data: body,
            position: 0,
            limit,
        }),
        None => Box::new(std::io::Cursor::new(body)),
    };
    Ok(Response {
        status: if offset > 0 { 206 } else { 200 },
        headers,
        body: reader,
    })
}

pub fn network_error(code: &str) -> UpdateError {
    UpdateError::new(
        fanotes_updater::ErrorKind::Network,
        format!("connect {code}"),
    )
    .with_code(code)
}
