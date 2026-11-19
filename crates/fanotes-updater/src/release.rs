//! Channel policy: which GitHub release a channel installs from.
//!
//! Stable sees only stable releases. Beta sees beta and stable, so a beta user
//! moves to a newer stable. Nightly sees nightly and stable. The GitHub list is
//! ordered by publication time, so the pick is the highest visible version
//! that ships this platform's manifest, not the first matching row.

use serde_json::Value;

use crate::error::Result;
use crate::platform::{update_manifest_name, Platform};
use crate::version::{
    compare_versions, is_valid_version, release_visible_on_channel, version_channel, Channel,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickedRelease {
    pub tag_version: String,
    pub asset_name: String,
    pub asset_url: String,
    /// Channel of the release itself. The manifest must declare this channel.
    pub kind: Channel,
}

/// `pickUpdateRelease`. `releases` is the parsed GitHub release list (or `[latest]`).
pub fn pick_update_release(
    releases: &Value,
    channel: Channel,
    platform: Platform,
) -> Result<Option<PickedRelease>> {
    let Some(items) = releases.as_array() else {
        return Ok(None);
    };
    let mut best: Option<PickedRelease> = None;
    for item in items {
        let Some(row) = item.as_object() else {
            continue;
        };
        if row.get("draft") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(assets) = row.get("assets").and_then(Value::as_array) else {
            continue;
        };
        let tag_version = row
            .get("tag_name")
            .and_then(Value::as_str)
            .and_then(|tag| tag.strip_prefix('v'))
            .unwrap_or("");
        if !is_valid_version(tag_version) || !release_visible_on_channel(tag_version, channel)? {
            continue;
        }
        let kind = version_channel(tag_version)?;
        let asset_name = update_manifest_name(platform, kind);
        let asset_url = assets.iter().find_map(|entry| {
            let entry = entry.as_object()?;
            if entry.get("name").and_then(Value::as_str) != Some(asset_name.as_str()) {
                return None;
            }
            entry.get("browser_download_url").and_then(Value::as_str)
        });
        let Some(asset_url) = asset_url else { continue };
        if best
            .as_ref()
            .is_none_or(|b| compare_versions(tag_version, &b.tag_version).is_ok_and(|o| o.is_gt()))
        {
            best = Some(PickedRelease {
                tag_version: tag_version.to_owned(),
                asset_name,
                asset_url: asset_url.to_owned(),
                kind,
            });
        }
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosts::github_release_asset_url;
    use serde_json::json;

    fn row(version: &str, kind: Channel) -> Value {
        let name = update_manifest_name(Platform::Linux, kind);
        json!({"tag_name": format!("v{version}"), "draft": false, "assets": [{"name": name, "browser_download_url": github_release_asset_url(version, &name)}]})
    }

    #[test]
    fn beta_prefers_highest_visible() {
        let stable = row("2026.11.2", Channel::Stable);
        let older_beta = row("2026.11.2-beta.2", Channel::Beta);
        let newer_beta = row("2026.11.3-beta.1", Channel::Beta);
        let pick = |rows: Vec<Value>, ch| {
            pick_update_release(&Value::Array(rows), ch, Platform::Linux).unwrap()
        };
        assert_eq!(
            pick(vec![older_beta.clone(), stable.clone()], Channel::Beta)
                .unwrap()
                .tag_version,
            "2026.11.2"
        );
        assert_eq!(
            pick(vec![stable.clone(), newer_beta.clone()], Channel::Beta)
                .unwrap()
                .tag_version,
            "2026.11.3-beta.1"
        );
        assert_eq!(
            pick(vec![newer_beta.clone(), stable.clone()], Channel::Stable)
                .unwrap()
                .tag_version,
            "2026.11.2"
        );
        assert!(pick(vec![newer_beta], Channel::Stable).is_none());
        let mut draft = stable;
        draft["draft"] = json!(true);
        assert_eq!(
            pick(vec![draft, older_beta], Channel::Beta)
                .unwrap()
                .tag_version,
            "2026.11.2-beta.2"
        );
    }
}
