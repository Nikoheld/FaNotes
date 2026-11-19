//! Network boundary and the manifest check.
//!
//! All I/O goes through the [`Fetcher`] trait so tests inject canned
//! responses. A fetcher must NOT follow redirects: [`fetch_github`] follows
//! them itself and only to allow-listed hosts (at most 4 hops).

use std::io::Read;
use std::time::Duration;

use serde_json::Value;
use url::Url;

use crate::diagnosis::{
    diagnose_update_failure, looks_like_html, DiagnoseInput, Phase, ResponseMeta,
};
use crate::error::{err, ErrorKind, Result, UpdateError};
use crate::hosts::{assert_github_release_url, is_allowed_update_host};
use crate::manifest::{verify_manifest, VerifiedManifest};
use crate::platform::Platform;
use crate::release::pick_update_release;
use crate::util::js_number;
use crate::version::Channel;

pub const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
/// The release index is not the manifest: thirty releases already exceed 512 KiB.
pub const MAX_RELEASE_LIST_BYTES: u64 = 4 * 1024 * 1024;
pub const MANIFEST_TIMEOUT: Duration = Duration::from_secs(25);
pub const MAX_REDIRECTS: u32 = 4;

#[derive(Debug, Clone)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Overall deadline for the request, when the caller wants one.
    pub timeout: Option<Duration>,
}

pub struct Response {
    pub status: u16,
    /// Header names are lowercase.
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn Read + Send>,
}

impl Response {
    pub fn new(status: u16, headers: &[(&str, &str)], body: Vec<u8>) -> Self {
        Self {
            status,
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_lowercase(), (*v).to_owned()))
                .collect(),
            body: Box::new(std::io::Cursor::new(body)),
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn meta(&self) -> ResponseMeta {
        ResponseMeta {
            status: self.status,
            location: self.header("location").map(str::to_owned),
            content_type: self.header("content-type").map(str::to_owned),
        }
    }
}

pub trait Fetcher: Send + Sync {
    /// Perform one HTTP GET. Must not follow redirects.
    fn fetch(&self, request: &Request) -> Result<Response>;
}

impl<F> Fetcher for F
where
    F: Fn(&Request) -> Result<Response> + Send + Sync,
{
    fn fetch(&self, request: &Request) -> Result<Response> {
        self(request)
    }
}

/// `fetchGithub`: https and allow-listed hosts only, redirects followed by hand.
pub fn fetch_github(
    fetcher: &dyn Fetcher,
    url: &str,
    headers: &[(String, String)],
    timeout: Option<Duration>,
) -> Result<Response> {
    let mut current = url.to_owned();
    let mut redirects_left = MAX_REDIRECTS;
    loop {
        let parsed = Url::parse(&current).ok().filter(is_allowed_update_host);
        let Some(parsed) = parsed else {
            return err(
                ErrorKind::Untrusted,
                "Die Downloadadresse ist nicht vertrauenswürdig.",
            );
        };
        let response = fetcher.fetch(&Request {
            url: current.clone(),
            headers: headers.to_vec(),
            timeout,
        })?;
        if !(300..400).contains(&response.status) || redirects_left == 0 {
            return Ok(response);
        }
        let next = response
            .header("location")
            .and_then(|location| parsed.join(location).ok());
        let Some(next) = next.filter(is_allowed_update_host) else {
            return Ok(response);
        };
        drop(response);
        current = next.into();
        redirects_left -= 1;
    }
}

/// `readFailureBody`: up to `limit` bytes of the body as text, empty on error.
pub fn read_failure_body(response: &mut Response, limit: usize) -> String {
    let mut buffer = Vec::new();
    let _ = (&mut response.body)
        .take(limit as u64)
        .read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).into_owned()
}

fn diagnosed(phase: Phase, url: &str, response: &Response, body_text: &str) -> UpdateError {
    let meta = response.meta();
    let diagnosis = diagnose_update_failure(&DiagnoseInput {
        phase,
        url,
        error: None,
        response: Some(&meta),
        body_text,
        resolved_address: None,
    });
    UpdateError::new(ErrorKind::Network, diagnosis.message.clone()).with_diagnosis(diagnosis)
}

/// `readJsonResponse`: size-capped JSON body, with failure diagnosis for
/// redirects, HTTP errors and HTML (captive portal) answers.
pub fn read_json_response(
    mut response: Response,
    url: &str,
    empty_message: &str,
    max_bytes: u64,
) -> Result<Value> {
    if (300..400).contains(&response.status) {
        let body = read_failure_body(&mut response, 8192);
        return Err(diagnosed(Phase::Check, url, &response, &body));
    }
    // `Number(headers.get('content-length'))`: a missing header reads as 0.
    let advertised = js_number(response.header("content-length").unwrap_or(""));
    let too_large =
        || UpdateError::new(ErrorKind::Size, "Das Update-Manifest ist unerwartet groß.");
    if advertised.is_finite() && advertised > max_bytes as f64 {
        return Err(too_large());
    }
    // Invalid UTF-8 becomes U+FFFD (up to 3 bytes each), so bound the raw read generously.
    let mut raw = Vec::new();
    (&mut response.body)
        .take(max_bytes.saturating_mul(3) + 4)
        .read_to_end(&mut raw)
        .map_err(|e| UpdateError::from_io(&e))?;
    let decoded = String::from_utf8_lossy(&raw);
    // `Response.text()` strips a UTF-8 byte order mark.
    let text = decoded
        .strip_prefix('\u{feff}')
        .unwrap_or(&decoded)
        .to_owned();
    if text.len() as u64 > max_bytes {
        return Err(too_large());
    }
    if !response.ok() {
        return Err(diagnosed(Phase::Check, url, &response, &text));
    }
    if looks_like_html(response.header("content-type"), &text) {
        return Err(diagnosed(Phase::Check, url, &response, &text));
    }
    serde_json::from_str(&text).or_else(|_| err(ErrorKind::Manifest, empty_message))
}

pub fn user_agent(platform: Platform, current_version: &str) -> String {
    format!(
        "FaNotes/{current_version} {} updater",
        platform.user_agent_platform()
    )
}

#[derive(Debug, Clone)]
pub struct ManifestRequest<'a> {
    pub platform: Platform,
    pub current_version: &'a str,
    pub channel: Channel,
    pub public_key_pem: &'a str,
    pub expected_key_id: &'a str,
}

fn fetch_manifest_inner(
    fetcher: &dyn Fetcher,
    request: &ManifestRequest<'_>,
    list_url: &str,
) -> Result<VerifiedManifest> {
    let agent = user_agent(request.platform, request.current_version);
    let headers = vec![
        (
            "Accept".to_owned(),
            "application/vnd.github+json".to_owned(),
        ),
        ("User-Agent".to_owned(), agent.clone()),
        ("X-GitHub-Api-Version".to_owned(), "2022-11-28".to_owned()),
    ];
    let listing = fetch_github(fetcher, list_url, &headers, Some(MANIFEST_TIMEOUT))?;
    let listed = read_json_response(
        listing,
        list_url,
        "GitHub hat keine gültige Release-Liste geliefert.",
        MAX_RELEASE_LIST_BYTES,
    )?;
    let mut releases = match listed {
        Value::Array(items) => items,
        other => vec![other],
    };
    // GitHub orders the index by publication time and /releases/latest is the
    // newest non-prerelease. Beta and Nightly need both, or a newer Stable
    // release stays hidden behind a long prerelease list.
    if request.channel != Channel::Stable {
        let latest_url = format!("{}/latest", request.platform.api());
        let latest = fetch_github(fetcher, &latest_url, &headers, Some(MANIFEST_TIMEOUT)).and_then(
            |response| {
                read_json_response(
                    response,
                    &latest_url,
                    "GitHub hat keine gültige Release-Liste geliefert.",
                    MAX_RELEASE_LIST_BYTES,
                )
            },
        );
        // The index still covers Stable when that release is on the first page.
        if let Ok(latest @ Value::Object(_)) = latest {
            releases.push(latest);
        }
    }
    let Some(picked) =
        pick_update_release(&Value::Array(releases), request.channel, request.platform)?
    else {
        return err(
            ErrorKind::Manifest,
            "GitHub bietet für diesen Update-Kanal kein FaNotes-Release an.",
        );
    };
    let manifest_url = assert_github_release_url(
        Some(&Value::String(picked.asset_url.clone())),
        &picked.tag_version,
        &picked.asset_name,
        "Die Manifest-Adresse",
    )?;
    let manifest_headers = vec![
        ("Accept".to_owned(), "application/json".to_owned()),
        ("User-Agent".to_owned(), agent),
    ];
    let response = fetch_github(
        fetcher,
        &manifest_url,
        &manifest_headers,
        Some(MANIFEST_TIMEOUT),
    )?;
    let candidate = read_json_response(
        response,
        &manifest_url,
        "GitHub hat kein gültiges JSON-Manifest geliefert.",
        MAX_MANIFEST_BYTES,
    )?;
    verify_manifest(
        &candidate,
        request.current_version,
        request.public_key_pem,
        request.platform,
        request.expected_key_id,
        picked.kind,
    )
}

/// `fetchManifest`: list releases, pick this channel's release, download its
/// manifest, verify it. Errors without a diagnosis get one attached.
pub fn fetch_manifest(
    fetcher: &dyn Fetcher,
    request: &ManifestRequest<'_>,
) -> Result<VerifiedManifest> {
    let list_url = match request.channel {
        Channel::Stable => format!("{}/latest", request.platform.api()),
        _ => format!("{}?per_page=100", request.platform.api()),
    };
    fetch_manifest_inner(fetcher, request, &list_url).map_err(|mut error| {
        if error.diagnosis.is_none() {
            let diagnosis = diagnose_update_failure(&DiagnoseInput {
                phase: Phase::Check,
                url: &list_url,
                error: Some(&error),
                response: None,
                body_text: "",
                resolved_address: None,
            });
            error.diagnosis = Some(Box::new(diagnosis));
        }
        error
    })
}
