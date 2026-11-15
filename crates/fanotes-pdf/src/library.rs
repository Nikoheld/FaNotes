//! Where the pinned PDFium library is loaded from.
//!
//! The build is pinned twice, with the same digests: `pdfium-bundled`'s
//! platform table (checked before every `dlopen`) and `pdfium-pin.json`, which
//! `fetch-pdfium.mjs` reads to put the library in a bundle or a dev checkout.
//! A library that is shipped with the app is preferred, so a desktop bundle
//! never downloads native code. Only when none is found does `pdfium-bundled`
//! fall back to its verified cache, downloading the pinned archive once
//! (`PDFIUM_NO_AUTO_DOWNLOAD` turns that off).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use pdfium_bundled::pdfium_render::prelude::Pdfium;
use serde::Deserialize;

use crate::Error;

const PIN_JSON: &str = include_str!("../pdfium-pin.json");

/// Overrides every other location. The file is still checked against the pin.
pub const LIBRARY_ENV: &str = "FANOTES_PDFIUM_LIB";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPlatform {
    pub archive: String,
    pub archive_sha256: String,
    pub library: String,
    pub library_name: String,
    pub library_sha256: String,
}

#[derive(Debug, Deserialize)]
struct Pin {
    tag: String,
    build: String,
    platforms: HashMap<String, PinnedPlatform>,
}

fn pin() -> &'static Pin {
    static PIN: OnceLock<Pin> = OnceLock::new();
    PIN.get_or_init(|| serde_json::from_str(PIN_JSON).expect("pdfium-pin.json is valid"))
}

/// `linux-x64` or `win-x64`: the platforms FaNotes ships PDFium for.
pub fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "x86_64") => Some("win-x64"),
        _ => None,
    }
}

/// The pinned build for `platform` (`linux-x64`, `win-x64`).
pub fn pinned_platform(platform: &str) -> Option<&'static PinnedPlatform> {
    pin().platforms.get(platform)
}

/// `chromium/8066`.
pub fn pinned_tag() -> &'static str {
    &pin().tag
}

/// `8066`.
pub fn pinned_build() -> &'static str {
    &pin().build
}

static EXTRA_DIRS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// A folder the host ships the library in (the Tauri resource `pdfium/`).
/// Must be called before the first render to take effect.
pub fn add_library_dir(dir: PathBuf) {
    let mut dirs = EXTRA_DIRS.lock().unwrap_or_else(|error| error.into_inner());
    if !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

fn library_name() -> &'static str {
    if cfg!(windows) {
        "pdfium.dll"
    } else if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else {
        "libpdfium.so"
    }
}

/// Places a shipped library is looked for, in order.
pub fn library_candidates() -> Vec<PathBuf> {
    let name = library_name();
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os(LIBRARY_ENV).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    for dir in EXTRA_DIRS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
    {
        candidates.push(dir.join(name));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        candidates.push(dir.join(name));
        candidates.push(dir.join("pdfium").join(name));
    }
    if let Some(platform) = platform_key() {
        // `node crates/fanotes-pdf/fetch-pdfium.mjs` puts it here in a checkout.
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("pdfium")
                .join(platform)
                .join(name),
        );
    }
    candidates
}

/// Bind the first shipped library that matches the pin, else the verified cache.
pub(crate) fn bind() -> Result<Pdfium, Error> {
    let mut refused = Vec::new();
    for candidate in library_candidates() {
        if !candidate.is_file() {
            continue;
        }
        match pdfium_bundled::bind_pdfium_from_path(&candidate) {
            Ok(pdfium) => return Ok(pdfium),
            Err(error) => refused.push(format!("{}: {error}", candidate.display())),
        }
    }
    pdfium_bundled::bind_pdfium_silent().map_err(|error| {
        refused.push(error.to_string());
        Error::Bind(refused.join("; "))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pin_file_matches_the_digest_checked_before_dlopen() {
        assert_eq!(pinned_build(), pdfium_bundled::PDFIUM_VERSION);
        assert_eq!(
            pinned_tag(),
            format!("chromium/{}", pdfium_bundled::PDFIUM_VERSION)
        );
        let platform = platform_key().expect("tests run on linux-x64 or win-x64");
        assert_eq!(
            pinned_platform(platform).unwrap().library_sha256,
            pdfium_bundled::pinned_library_sha256().unwrap()
        );
        assert_eq!(
            pinned_platform(platform).unwrap().library_name,
            library_name()
        );
        for key in ["linux-x64", "win-x64"] {
            let entry = pinned_platform(key).unwrap();
            assert_eq!(entry.archive_sha256.len(), 64);
            assert_eq!(entry.library_sha256.len(), 64);
        }
    }

    #[test]
    fn a_host_folder_is_searched_before_the_checkout() {
        add_library_dir(PathBuf::from("/opt/fanotes/pdfium"));
        let candidates = library_candidates();
        let host = candidates
            .iter()
            .position(|path| path.starts_with("/opt/fanotes/pdfium"))
            .unwrap();
        let checkout = candidates
            .iter()
            .position(|path| path.starts_with(env!("CARGO_MANIFEST_DIR")))
            .unwrap();
        assert!(host < checkout);
    }
}
