//! Port of `PLATFORM_RELEASES` and the platform asset selection.
//!
//! Linux ships an AppImage (primary) and a portable tar.gz. Windows ships a
//! Setup installer (primary) and a Portable executable.

use crate::error::{err, ErrorKind, Result};
use crate::hosts::GITHUB_API_RELEASES;
use crate::version::{delta_pathname, package_pathname, Channel};

pub const MIN_PACKAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
pub const WINDOWS_INSTALLER_ARGS: [&str; 3] = ["/S", "--updated", "--force-run"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Platform {
    Linux,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PackageKind {
    AppImage,
    Installer,
    Portable,
}

impl PackageKind {
    /// Key used inside the manifest's `packages` object.
    pub fn key(self) -> &'static str {
        match self {
            PackageKind::AppImage => "appimage",
            PackageKind::Installer => "installer",
            PackageKind::Portable => "portable",
        }
    }
}

impl Platform {
    /// Maps a Node `process.platform` value (`linux`, `win32`).
    pub fn from_node_platform(name: &str) -> Result<Platform> {
        match name {
            "linux" => Ok(Platform::Linux),
            "win32" => Ok(Platform::Windows),
            _ => err(
                ErrorKind::Unsupported,
                "Automatische Updates werden auf dieser Plattform nicht unterstützt.",
            ),
        }
    }

    /// The current build target, when it is one the updater supports.
    pub fn current() -> Option<Platform> {
        if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else if cfg!(windows) {
            Some(Platform::Windows)
        } else {
            None
        }
    }

    pub fn api(self) -> &'static str {
        GITHUB_API_RELEASES
    }

    /// `manifestPlatform`: the value of `platform` inside a manifest and its file name.
    pub fn manifest_platform(self) -> &'static str {
        match self {
            Platform::Linux => "linux",
            Platform::Windows => "windows",
        }
    }

    pub fn user_agent_platform(self) -> &'static str {
        match self {
            Platform::Linux => "Linux",
            Platform::Windows => "Windows",
        }
    }

    pub fn primary_package(self) -> PackageKind {
        match self {
            Platform::Linux => PackageKind::AppImage,
            Platform::Windows => PackageKind::Installer,
        }
    }

    /// Package kinds in validation order.
    pub fn package_kinds(self) -> [PackageKind; 2] {
        match self {
            Platform::Linux => [PackageKind::AppImage, PackageKind::Portable],
            Platform::Windows => [PackageKind::Installer, PackageKind::Portable],
        }
    }

    pub fn has_package(self, kind: PackageKind) -> bool {
        self.package_kinds().contains(&kind)
    }

    pub fn package_label(self, kind: PackageKind) -> &'static str {
        match (self, kind) {
            (Platform::Linux, PackageKind::AppImage) => "AppImage",
            (Platform::Linux, _) => "Portable",
            (Platform::Windows, PackageKind::Installer) => "Windows-Installer",
            (Platform::Windows, _) => "Windows Portable",
        }
    }

    /// Exact file name a package must have for `version`.
    pub fn package_file_name(self, kind: PackageKind, version: &str) -> String {
        match (self, kind) {
            (Platform::Linux, PackageKind::AppImage) => {
                format!("FaNotes-{version}-x86_64.AppImage")
            }
            (Platform::Linux, _) => format!("FaNotes-{version}-x86_64.tar.gz"),
            (Platform::Windows, PackageKind::Installer) => {
                format!("FaNotes-Setup-{version}-x64.exe")
            }
            (Platform::Windows, _) => format!("FaNotes-Portable-{version}-x64.exe"),
        }
    }

    /// Site download route (`/download/...`) for a package on `channel`.
    pub fn package_pathname(self, kind: PackageKind, channel: Channel) -> String {
        let leaf = match (self, kind) {
            (Platform::Linux, PackageKind::AppImage) => "appimage",
            (Platform::Linux, _) => "portable",
            (Platform::Windows, PackageKind::Installer) => "windows-installer",
            (Platform::Windows, _) => "windows-portable",
        };
        package_pathname(channel, leaf)
    }

    pub fn delta_path(self, version: &str, channel: Channel) -> String {
        delta_pathname(self.manifest_platform(), version, channel)
    }

    pub fn accept(self) -> &'static str {
        match self {
            Platform::Linux => "application/vnd.appimage, application/octet-stream;q=0.9",
            Platform::Windows => {
                "application/vnd.microsoft.portable-executable, application/octet-stream;q=0.9"
            }
        }
    }

    /// File kind a delta for this platform reconstructs.
    pub fn delta_kind(self) -> &'static str {
        match self {
            Platform::Linux => "appimage",
            Platform::Windows => "app-asar",
        }
    }
}

/// `updateManifestName`: `FaNotes-update-linux-x64.json` for stable, `...-x64-beta.json` otherwise.
pub fn update_manifest_name(platform: Platform, channel: Channel) -> String {
    match channel {
        Channel::Stable => format!("FaNotes-update-{}-x64.json", platform.manifest_platform()),
        other => format!(
            "FaNotes-update-{}-x64-{}.json",
            platform.manifest_platform(),
            other.as_str()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names() {
        assert_eq!(
            Platform::Linux.package_file_name(PackageKind::AppImage, "2026.11.3"),
            "FaNotes-2026.11.3-x86_64.AppImage"
        );
        assert_eq!(
            Platform::Linux.package_file_name(PackageKind::Portable, "2026.11.3"),
            "FaNotes-2026.11.3-x86_64.tar.gz"
        );
        assert_eq!(
            Platform::Windows.package_file_name(PackageKind::Installer, "2026.11.3-beta.5"),
            "FaNotes-Setup-2026.11.3-beta.5-x64.exe"
        );
        assert_eq!(
            Platform::Windows.package_file_name(PackageKind::Portable, "2026.11.3"),
            "FaNotes-Portable-2026.11.3-x64.exe"
        );
        assert_eq!(
            update_manifest_name(Platform::Windows, Channel::Beta),
            "FaNotes-update-windows-x64-beta.json"
        );
        assert_eq!(
            update_manifest_name(Platform::Linux, Channel::Stable),
            "FaNotes-update-linux-x64.json"
        );
        assert_eq!(
            Platform::Linux.delta_path("2026.11.3", Channel::Nightly),
            "/download/delta/linux-x64/nightly/2026.11.3"
        );
        assert!(Platform::from_node_platform("darwin").is_err());
    }
}
