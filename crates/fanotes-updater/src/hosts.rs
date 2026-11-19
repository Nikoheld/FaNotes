//! Host allow-lists: the update hosts from `updater.cjs` and the model
//! download rule from `electron/download-hosts.cjs`.

use serde_json::Value;
use url::Url;

use crate::error::{err, ErrorKind, Result};

pub const PRODUCT_ORIGIN: &str = "https://fanotes.fasrv.ch";
pub const GITHUB_REPOSITORY: &str = "Nikoheld/FaNotes";
pub const GITHUB_API_RELEASES: &str = "https://api.github.com/repos/Nikoheld/FaNotes/releases";

/// Hosts the updater may talk to (value of `URL.host`, so a port would not match).
pub const ALLOWED_UPDATE_HOSTS: [&str; 4] = [
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// `URL.host`: hostname plus a non-default port.
pub fn url_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

pub fn is_allowed_update_host(url: &Url) -> bool {
    url.scheme() == "https" && ALLOWED_UPDATE_HOSTS.contains(&url_host(url).as_str())
}

pub fn github_release_asset_url(version: &str, file_name: &str) -> String {
    format!("https://github.com/{GITHUB_REPOSITORY}/releases/download/v{version}/{file_name}")
}

/// `assertGithubReleaseUrl`: the URL must be exactly the GitHub release asset
/// for `version` and `file_name`. No credentials, query or fragment, no other
/// host, no other path. Returns the normalized href.
///
/// Unlike JavaScript's `new URL(value)`, a non-string JSON value is rejected
/// instead of being coerced to a string.
pub fn assert_github_release_url(
    value: Option<&Value>,
    version: &str,
    file_name: &str,
    label: &str,
) -> Result<String> {
    let Some(parsed) = value
        .and_then(Value::as_str)
        .and_then(|text| Url::parse(text).ok())
    else {
        return err(ErrorKind::Untrusted, format!("{label} ist ungültig."));
    };
    let Ok(expected) = Url::parse(&github_release_asset_url(version, file_name)) else {
        return err(ErrorKind::Untrusted, format!("{label} ist ungültig."));
    };
    let has_credentials =
        !parsed.username().is_empty() || parsed.password().is_some_and(|p| !p.is_empty());
    // An empty `?` or `#` is falsy for `URL.search` / `URL.hash`, and so it is here.
    let has_query = parsed.query().is_some_and(|q| !q.is_empty());
    let has_fragment = parsed.fragment().is_some_and(|f| !f.is_empty());
    if parsed.scheme() != "https"
        || url_host(&parsed) != url_host(&expected)
        || parsed.path() != expected.path()
        || has_credentials
        || has_query
        || has_fragment
    {
        return err(
            ErrorKind::Untrusted,
            format!("{label} ist nicht vertrauenswürdig."),
        );
    }
    Ok(parsed.into())
}

/// `isHuggingFaceHost`.
pub fn is_hugging_face_host(hostname: &str) -> bool {
    let lower = hostname.to_lowercase();
    let host = lower.strip_suffix('.').unwrap_or(&lower);
    host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "hf.co"
        || host.ends_with(".hf.co")
}

fn normalized_host(url: &Url) -> String {
    let lower = url.host_str().unwrap_or("").to_lowercase();
    lower.strip_suffix('.').unwrap_or(&lower).to_owned()
}

/// `assertModelDownloadUrl`: a model download may follow redirects only when
/// the final host is the requested host, or another Hugging Face host when the
/// request started on one. Everything else is rejected before a byte is written.
pub fn assert_model_download_url(original_url: &str, final_url: Option<&str>) -> Result<Url> {
    let parse = |text: &str| {
        Url::parse(text)
            .map_err(|_| crate::error::UpdateError::new(ErrorKind::Untrusted, "Invalid URL"))
    };
    let original = parse(original_url)?;
    let final_url = parse(match final_url {
        Some(text) if !text.is_empty() => text,
        _ => original_url,
    })?;
    const UNSAFE: &str = "Unsicheres Downloadziel abgelehnt.";
    if final_url.scheme() != "https"
        || !final_url.username().is_empty()
        || final_url.password().is_some_and(|p| !p.is_empty())
        || original.scheme() != "https"
    {
        return err(ErrorKind::Untrusted, UNSAFE);
    }
    let original_host = normalized_host(&original);
    let final_host = normalized_host(&final_url);
    if final_host == original_host
        || (is_hugging_face_host(&original_host) && is_hugging_face_host(&final_host))
    {
        return Ok(final_url);
    }
    err(ErrorKind::Untrusted, UNSAFE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_hosts() {
        assert!(assert_model_download_url(
            "https://huggingface.co/a/b",
            Some("https://cdn-lfs.huggingface.co/x")
        )
        .is_ok());
        assert!(assert_model_download_url(
            "https://huggingface.co/a/b",
            Some("https://evil.example/x")
        )
        .is_err());
        assert!(assert_model_download_url(
            "https://example.org/a",
            Some("https://huggingface.co/x")
        )
        .is_err());
        assert!(
            assert_model_download_url("https://example.org/a", Some("http://example.org/x"))
                .is_err()
        );
        assert!(assert_model_download_url(
            "https://example.org/a",
            Some("https://u:p@example.org/x")
        )
        .is_err());
        assert!(assert_model_download_url(
            "https://huggingface.co/a",
            Some("https://nothuggingface.co/x")
        )
        .is_err());
        assert!(assert_model_download_url("https://hf.co/a", None).is_ok());
    }

    #[test]
    fn release_urls() {
        let good = github_release_asset_url("2026.11.3", "f.bin");
        assert_eq!(
            assert_github_release_url(Some(&json!(good)), "2026.11.3", "f.bin", "X").unwrap(),
            good
        );
        for bad in [
            "https://github.com/Nikoheld/FaNotes/releases/download/v2026.11.3/f.bin?x=1",
            "https://github.com/Nikoheld/FaNotes/releases/download/v2026.11.3/f.bin#frag",
            "http://github.com/Nikoheld/FaNotes/releases/download/v2026.11.3/f.bin",
            "https://user@github.com/Nikoheld/FaNotes/releases/download/v2026.11.3/f.bin",
            "https://github.com:8443/Nikoheld/FaNotes/releases/download/v2026.11.3/f.bin",
            "https://github.com/Evil/FaNotes/releases/download/v2026.11.3/f.bin",
            "https://github.com/Nikoheld/FaNotes/releases/download/v2026.11.3/../v9/f.bin",
        ] {
            let e = assert_github_release_url(Some(&json!(bad)), "2026.11.3", "f.bin", "X")
                .unwrap_err();
            assert!(e.message.contains("vertrauenswürdig"), "{bad}: {e}");
        }
        assert!(
            assert_github_release_url(Some(&json!(5)), "1.0.0", "f", "X")
                .unwrap_err()
                .message
                .contains("ungültig")
        );
        // empty query/fragment markers are accepted, as in the JS check
        assert!(assert_github_release_url(
            Some(&json!(format!("{good}?"))),
            "2026.11.3",
            "f.bin",
            "X"
        )
        .is_ok());
    }
}
