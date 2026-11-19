//! Port of `electron/releaseVersion.cjs`: one version order for the updater.
//!
//! Same `major.minor.patch` ranks `beta < stable < nightly`. A later patch
//! beats every nightly of the previous triple. Versions look like
//! `2026.11.3`, `2026.11.3-beta.5` or `2026.10.2-nightly.20261011120000.abcdef0`.

use std::cmp::Ordering;
use std::sync::LazyLock;

use regex::Regex;

use crate::date;
use crate::error::{err, ErrorKind, Result};
use crate::json::js_number_to_string;
use crate::util::js_trim;

const SOURCE: &str =
    r"[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+|-nightly\.[0-9]{14}\.[a-f0-9]{7,40})?";

static VERSION_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{SOURCE}$")).unwrap());
static VERSION_CAPTURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-beta\.([0-9]+)|-nightly\.([0-9]{14})\.([a-f0-9]{7,40}))?$").unwrap()
});
static LINUX_PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^FaNotes-({SOURCE})-x86_64\.(AppImage|tar\.gz)$")).unwrap()
});
static WINDOWS_PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^FaNotes-(Setup|Portable)-({SOURCE})-x64\.exe$")).unwrap()
});
static DELTA_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^/download/delta/(linux|windows)-x64/(?:(beta|nightly)/)?({SOURCE})$"
    ))
    .unwrap()
});
static DOWNLOAD_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/download/(?:(beta|nightly)/)?(appimage|portable|windows-installer|windows-portable|checksums|install-guide|windows-guide)$").unwrap()
});
static NIGHTLY_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-(?:beta\.[0-9]+|nightly\.[0-9]{14}\.[a-f0-9]{7,40})$").unwrap());
static SHA_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{7,40}$").unwrap());

pub const EMPTY_NIGHTLY_CHANGELOG: &str =
    "Dieser Nightly-Stand ist ein Commit von main und kein Stable- oder Beta-Release.";
pub const INVALID_VERSION: &str = "Ungültige Versionsnummer.";

/// Release channel. `Stable < Beta`-style ordering is not meaningful; use [`compare_versions`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Channel {
    Stable,
    Beta,
    Nightly,
}

impl Channel {
    pub const ALL: [Channel; 3] = [Channel::Stable, Channel::Beta, Channel::Nightly];

    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
            Channel::Nightly => "nightly",
        }
    }

    pub fn parse(text: &str) -> Option<Channel> {
        match text {
            "stable" => Some(Channel::Stable),
            "beta" => Some(Channel::Beta),
            "nightly" => Some(Channel::Nightly),
            _ => None,
        }
    }

    /// Rank used for equal `major.minor.patch`: beta < stable < nightly.
    fn rank(self) -> u8 {
        match self {
            Channel::Beta => 0,
            Channel::Stable => 1,
            Channel::Nightly => 2,
        }
    }
}

/// `VERSION_PATTERN.test(text)`.
pub fn is_valid_version(text: &str) -> bool {
    VERSION_PATTERN.is_match(text)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedVersion {
    /// JavaScript numbers (doubles); a 400-digit component becomes infinity, as in JS.
    pub numbers: [f64; 3],
    pub channel: Channel,
    pub pre: f64,
    pub sha: String,
}

pub fn parse_release_version(text: &str) -> Result<ParsedVersion> {
    let Some(caps) = VERSION_CAPTURE.captures(text) else {
        return err(ErrorKind::Manifest, INVALID_VERSION);
    };
    let number = |index: usize| caps[index].parse::<f64>().unwrap_or(f64::NAN);
    let (channel, pre, sha) = if caps.get(4).is_some() {
        (Channel::Beta, number(4), String::new())
    } else if caps.get(5).is_some() {
        (Channel::Nightly, number(5), caps[6].to_owned())
    } else {
        (Channel::Stable, 0.0, String::new())
    };
    Ok(ParsedVersion {
        numbers: [number(1), number(2), number(3)],
        channel,
        pre,
        sha,
    })
}

/// `compareSemanticVersions`. Errors only when a side is not a valid version.
pub fn compare_semantic_versions(left: &str, right: &str) -> Result<Ordering> {
    let a = parse_release_version(left)?;
    let b = parse_release_version(right)?;
    for index in 0..3 {
        if a.numbers[index] != b.numbers[index] {
            return Ok(a.numbers[index]
                .partial_cmp(&b.numbers[index])
                .unwrap_or(Ordering::Equal));
        }
    }
    if a.channel != b.channel {
        return Ok(a.channel.rank().cmp(&b.channel.rank()));
    }
    if a.pre != b.pre {
        return Ok(a.pre.partial_cmp(&b.pre).unwrap_or(Ordering::Equal));
    }
    Ok(a.sha.encode_utf16().cmp(b.sha.encode_utf16()))
}

/// `compareVersions` from `updater.cjs`: validates both sides first.
pub fn compare_versions(left: &str, right: &str) -> Result<Ordering> {
    if !is_valid_version(left) || !is_valid_version(right) {
        return err(ErrorKind::Manifest, INVALID_VERSION);
    }
    compare_semantic_versions(left, right)
}

pub fn version_channel(version: &str) -> Result<Channel> {
    Ok(parse_release_version(version)?.channel)
}

/// Which releases a channel may see. Stable sees only stable; beta sees beta
/// and stable; nightly sees nightly and stable. Invalid versions are an error.
pub fn release_visible_on_channel(version: &str, channel: Channel) -> Result<bool> {
    let kind = version_channel(version)?;
    Ok(match channel {
        Channel::Stable => kind == Channel::Stable,
        Channel::Beta => matches!(kind, Channel::Beta | Channel::Stable),
        Channel::Nightly => matches!(kind, Channel::Nightly | Channel::Stable),
    })
}

/// `nightlyVersion(base, committedAt, sha)`. `committed_at` is an ISO-8601 string.
pub fn nightly_version(base: &str, committed_at: &str, sha: &str) -> Result<String> {
    let stripped = NIGHTLY_SUFFIX.replace(base, "");
    let parsed = parse_release_version(&stripped)?;
    if parsed.channel != Channel::Stable {
        return err(ErrorKind::Manifest, INVALID_VERSION);
    }
    let Some(iso) = date::parse_date_ms(committed_at).and_then(date::iso_from_ms) else {
        return err(ErrorKind::Manifest, "Ungültiges Commit-Datum.");
    };
    let stamp: String = iso.chars().filter(char::is_ascii_digit).take(14).collect();
    let normalized = js_trim(sha).to_lowercase();
    if !SHA_PATTERN.is_match(&normalized) {
        return err(ErrorKind::Manifest, "Ungültiger Commit.");
    }
    let numbers: Vec<String> = parsed
        .numbers
        .iter()
        .map(|n| js_number_to_string(*n))
        .collect();
    let version = format!("{}-nightly.{stamp}.{normalized}", numbers.join("."));
    if !is_valid_version(&version) {
        return err(ErrorKind::Manifest, INVALID_VERSION);
    }
    Ok(version)
}

/// `channelForPackagedVersion`: invalid input falls back to stable.
pub fn channel_for_packaged_version(version: &str) -> Channel {
    if !is_valid_version(version) {
        return Channel::Stable;
    }
    version_channel(version).unwrap_or(Channel::Stable)
}

pub fn package_pathname(channel: Channel, leaf: &str) -> String {
    match channel {
        Channel::Stable => format!("/download/{leaf}"),
        other => format!("/download/{}/{leaf}", other.as_str()),
    }
}

pub fn delta_pathname(platform: &str, version: &str, channel: Channel) -> String {
    match channel {
        Channel::Stable => format!("/download/delta/{platform}-x64/{version}"),
        other => format!(
            "/download/delta/{platform}-x64/{}/{version}",
            other.as_str()
        ),
    }
}

pub fn is_linux_package_name(name: &str) -> bool {
    LINUX_PACKAGE.is_match(name)
}

pub fn is_windows_package_name(name: &str) -> bool {
    WINDOWS_PACKAGE.is_match(name)
}

pub fn is_delta_route(path: &str) -> bool {
    DELTA_ROUTE.is_match(path)
}

pub fn is_download_route(path: &str) -> bool {
    DOWNLOAD_ROUTE.is_match(path)
}

/// Used by `delta` to validate header versions without recompiling the regex.
pub(crate) fn version_pattern_matches(text: &str) -> bool {
    VERSION_PATTERN.is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Ordering::*;

    #[test]
    fn orders_calendar_versions() {
        let cmp = |a, b| compare_versions(a, b).unwrap();
        assert_eq!(cmp("2026.11.3-beta.5", "2026.11.3-beta.4"), Greater);
        assert_eq!(cmp("2026.11.3", "2026.11.3-beta.99"), Greater);
        assert_eq!(cmp("2026.11.4-beta.1", "2026.11.3"), Greater);
        assert_eq!(cmp("2026.9.1", "2026.10.1"), Less);
        assert_eq!(cmp("2026.11.3", "2026.11.3"), Equal);
        assert!(compare_versions("2026.11", "2026.11.3").is_err());
        assert!(compare_versions("v2026.11.3", "2026.11.3").is_err());
    }

    #[test]
    fn nightly_helpers() {
        let sample = "2026.10.2-nightly.20261011120000.abcdef0";
        assert_eq!(
            nightly_version("2026.10.2-beta.3", "2026-10-11T12:00:00.000Z", "ABCDEF0").unwrap(),
            sample
        );
        assert_eq!(channel_for_packaged_version(sample), Channel::Nightly);
        assert_eq!(channel_for_packaged_version("nope"), Channel::Stable);
        assert!(nightly_version("2026.10.2", "garbage", "abcdef0").is_err());
        assert!(nightly_version("2026.10.2", "2026-10-11T12:00:00.000Z", "xyz").is_err());
    }
}
