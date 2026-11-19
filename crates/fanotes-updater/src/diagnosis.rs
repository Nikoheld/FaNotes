//! Port of `diagnoseUpdateFailure`, `isPrivateAddress` and the HTML sniffing
//! helpers. The diagnosis turns a failed transfer into a German message that
//! tells the user whether a school network, captive portal or filter is the
//! likely cause. No DNS lookup happens here; callers pass `resolved_address`.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::error::UpdateError;
use crate::hosts::{url_host, GITHUB_API_RELEASES};
use crate::util::{is_js_whitespace, js_number, js_slice, js_trim};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Check,
    Download,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Check => "check",
            Phase::Download => "download",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnosis {
    /// `redirect`, `http-filter`, `captive-portal`, `http`, `tls-intercept`,
    /// `dns-hijack`, `dns`, `connection`, `timeout` or `unknown`.
    pub kind: &'static str,
    pub summary: String,
    pub message: String,
    pub phase: Phase,
    pub host: String,
    pub url: String,
    pub status: Option<u16>,
    pub location_host: Option<String>,
    pub page_title: Option<String>,
    pub content_type: String,
    pub code: Option<String>,
    pub resolved_address: Option<String>,
}

/// What the diagnosis needs to know about an HTTP response.
#[derive(Debug, Clone, Default)]
pub struct ResponseMeta {
    pub status: u16,
    pub location: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DiagnoseInput<'a> {
    pub phase: Phase,
    pub url: &'a str,
    pub error: Option<&'a UpdateError>,
    pub response: Option<&'a ResponseMeta>,
    pub body_text: &'a str,
    pub resolved_address: Option<&'a str>,
}

static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<title[^>]*>([^<]{1,180})</title>").unwrap());
static CERT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)CERT|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|ERR_CERT|UNABLE_TO_GET_ISSUER")
        .unwrap()
});
static DNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)ENOTFOUND|EAI_AGAIN|ENODATA|ERR_NAME_NOT_RESOLVED").unwrap());
static CONNECTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)ECONNREFUSED|ECONNRESET|EPIPE|ERR_CONNECTION|EHOSTUNREACH|ENETUNREACH")
        .unwrap()
});
static TIMEOUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TIMEOUT").unwrap());
static DOTTED_MAPPED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$").unwrap());
static HEX_MAPPED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$").unwrap());

/// `hostOf`: `URL.host` of an absolute URL, or `None`.
pub fn host_of(value: &str) -> Option<String> {
    let host = url_host(&Url::parse(value).ok()?);
    (!host.is_empty()).then_some(host)
}

pub fn extract_html_title(text: &str) -> Option<String> {
    let caps = TITLE.captures(text)?;
    let mut collapsed = String::new();
    let mut in_space = false;
    for ch in caps[1].chars() {
        if is_js_whitespace(ch) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(ch);
            in_space = false;
        }
    }
    let title = js_trim(&collapsed);
    (!title.is_empty()).then(|| js_slice(title, 120))
}

pub fn looks_like_html(content_type: Option<&str>, body_text: &str) -> bool {
    if content_type.is_some_and(|t| t.to_lowercase().contains("text/html")) {
        return true;
    }
    body_text
        .trim_start_matches(is_js_whitespace)
        .starts_with('<')
}

fn is_private_ipv4(address: &str) -> bool {
    let parts: Vec<f64> = address.split('.').map(js_number).collect();
    if parts.len() != 4
        || parts
            .iter()
            .any(|p| p.fract() != 0.0 || !p.is_finite() || *p < 0.0 || *p > 255.0)
    {
        return false;
    }
    let (first, second) = (parts[0] as u32, parts[1] as u32);
    first == 10
        || first == 127
        || first == 0
        || first >= 224
        || (first == 192 && second == 168)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 169 && second == 254)
        || (first == 100 && (64..=127).contains(&second))
}

/// `parseInt(text, 16)`: leading hex digits, `None` for NaN.
fn parse_int_hex(text: &str) -> Option<u64> {
    let trimmed = js_trim(text);
    let digits: String = trimmed
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .collect();
    if digits.is_empty() {
        None
    } else {
        u64::from_str_radix(&digits, 16).ok()
    }
}

/// True when `address` is not a public unicast address (loopback, private,
/// link-local, multicast, ULA, IPv4-mapped private, ...).
pub fn is_private_address(address: &str) -> bool {
    if address.is_empty() {
        return false;
    }
    let lowered = js_trim(address).to_lowercase();
    let unbracketed = lowered.strip_prefix('[').unwrap_or(&lowered);
    let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
    let value = unbracketed.split('%').next().unwrap_or("");
    if let Some(caps) = DOTTED_MAPPED.captures(value) {
        return is_private_ipv4(&caps[1]);
    }
    if let Some(caps) = HEX_MAPPED.captures(value) {
        let high = u32::from_str_radix(&caps[1], 16).unwrap_or(0);
        let low = u32::from_str_radix(&caps[2], 16).unwrap_or(0);
        return is_private_ipv4(&format!(
            "{}.{}.{}.{}",
            high >> 8,
            high & 255,
            low >> 8,
            low & 255
        ));
    }
    if value.contains(':') {
        if value == "::" || value == "::1" {
            return true;
        }
        let head = value.split(':').next().unwrap_or("");
        let first = parse_int_hex(if head.is_empty() { "0" } else { head });
        // 2000::/3 is global unicast. Loopback, ULA, link-local and multicast are not the update host.
        return match first {
            None => true,
            Some(first) => !(0x2000..=0x3fff).contains(&first),
        };
    }
    is_private_ipv4(value)
}

/// `safeErrorMessage`.
pub fn safe_error_message(error: Option<&UpdateError>) -> String {
    if let Some(diagnosis) = error.and_then(|e| e.diagnosis.as_ref()) {
        return js_slice(&diagnosis.message, 900);
    }
    if error.is_some_and(UpdateError::is_abort) {
        return "Die Update-Verbindung hat zu lange nicht geantwortet.".to_owned();
    }
    let message = error.map_or("Unbekannter Updatefehler.", |e| e.message.as_str());
    js_slice(&message.replace(GITHUB_API_RELEASES, "Update-Server"), 900)
}

pub fn diagnose_update_failure(input: &DiagnoseInput<'_>) -> Diagnosis {
    let host = host_of(input.url).unwrap_or_else(|| "fanotes.fasrv.ch".to_owned());
    let status = input.response.map(|r| r.status).filter(|s| *s > 0);
    let location_host = input
        .response
        .and_then(|r| r.location.as_deref())
        .and_then(host_of);
    let content_type_raw = input
        .response
        .and_then(|r| r.content_type.as_deref())
        .unwrap_or("");
    let content_type = js_trim(content_type_raw.split(';').next().unwrap_or("")).to_owned();
    let page_title = extract_html_title(input.body_text);
    let code = input
        .error
        .and_then(|e| e.code.clone())
        .filter(|c| !c.is_empty());
    let combined = format!(
        "{} {}",
        code.as_deref().unwrap_or(""),
        input.error.map_or("", |e| e.message.as_str())
    );
    let phase_label = if input.phase == Phase::Check {
        "Die Updateprüfung"
    } else {
        "Der Update-Download"
    };
    let title_part = |prefix: &str| {
        page_title
            .as_ref()
            .map_or(String::new(), |t| format!("{prefix}{t}“)"))
    };
    let quoted_title = |open: &str| {
        page_title
            .as_ref()
            .map_or(String::new(), |t| format!("{open}{t}“"))
    };
    let html = looks_like_html(Some(&content_type), input.body_text);

    let mut kind = "unknown";
    let mut summary = "Update fehlgeschlagen".to_owned();
    let mut message = safe_error_message(input.error);

    match status {
        Some(s @ 300..=399) => {
            kind = "redirect";
            summary = "Umleitung (Anmeldeseite / Filter)".to_owned();
            message = format!(
                "{phase_label} von {host} wurde mit HTTP {s} umgeleitet{}{}. So blockiert oft ein Schul-WLAN oder eine Anmeldeseite den Update-Server.",
                location_host.as_ref().map_or(String::new(), |l| format!(" nach {l}")),
                title_part(" („"),
            );
        }
        Some(s @ (401 | 407)) => {
            kind = "http-filter";
            summary = format!("HTTP {s} (Proxy-Anmeldung)");
            message = format!(
                "{phase_label} von {host} verlangt eine Proxy-Anmeldung (HTTP {s}). Das Schulnetz lässt den Download erst nach der Anmeldung am Proxy durch."
            );
        }
        Some(s @ (403 | 451 | 406)) => {
            kind = "http-filter";
            summary = format!("HTTP {s} (Inhaltsfilter)");
            message = format!(
                "{phase_label} von {host} wurde mit HTTP {s} abgewiesen{}. Ein Schul- oder Netzfilter blockiert fanotes.fasrv.ch.",
                title_part(" („"),
            );
        }
        Some(s) if s != 200 && s != 206 => {
            if html {
                kind = "captive-portal";
                summary = page_title
                    .as_ref()
                    .map_or("Filter- oder Anmeldeseite".to_owned(), |t| {
                        format!("Filterseite „{t}“")
                    });
                message = format!(
                    "{phase_label} von {host} lieferte HTTP {s} als HTML-Seite{}. Das Schul-WLAN hat die Updatedatei durch eine Sperr- oder Anmeldeseite ersetzt.",
                    quoted_title(" „"),
                );
            } else {
                kind = "http";
                summary = format!("HTTP {s}");
                message = format!("{phase_label} von {host} endete mit HTTP {s}.");
            }
        }
        _ => {
            if html && !input.body_text.is_empty() {
                kind = "captive-portal";
                summary = page_title
                    .as_ref()
                    .map_or("Filter- oder Anmeldeseite".to_owned(), |t| {
                        format!("Filterseite „{t}“")
                    });
                message = format!(
                    "Statt der Update-Datei von {host} kam eine HTML-Seite{}. Ein Schul-WLAN oder Filter hat die Antwort ersetzt.",
                    quoted_title(" „"),
                );
            } else if CERT.is_match(&combined) {
                kind = "tls-intercept";
                summary = "HTTPS-Proxy / TLS-Prüfung".to_owned();
                message = format!(
                    "Die HTTPS-Verbindung zu {host} scheiterte ({}). Ein Schul-Proxy prüft den Datenverkehr und tauscht das Zertifikat — FaNotes bricht das zum Schutz ab.",
                    code.as_deref().unwrap_or("Zertifikatfehler"),
                );
            } else if input
                .resolved_address
                .is_some_and(|a| !a.is_empty() && is_private_address(a))
            {
                let address = input.resolved_address.unwrap_or("");
                kind = "dns-hijack";
                summary = "DNS zeigt ins Schulnetz".to_owned();
                message = format!("{host} zeigt auf {address} (lokales Netz) statt auf den FaNotes-Server. Das Schul-WLAN fängt den Namen ab.");
            } else if code.as_deref().is_some_and(|c| DNS.is_match(c)) {
                kind = "dns";
                summary = "DNS blockiert".to_owned();
                message = format!(
                    "Der Name {host} ließ sich nicht auflösen ({}). Das Schul-WLAN filtert oder unterdrückt die Namensauflösung für den Update-Server.",
                    code.as_deref().unwrap_or("DNS"),
                );
            } else if code.as_deref().is_some_and(|c| CONNECTION.is_match(c)) {
                kind = "connection";
                summary = "Verbindung unterbrochen".to_owned();
                message = format!(
                    "Die Verbindung zu {host} wurde abgebrochen ({}). Eine Firewall oder ein Filter des Schulnetzes lässt den Update-Server nicht durch.",
                    code.as_deref().unwrap_or(""),
                );
            } else if input.error.is_some_and(UpdateError::is_abort)
                || code.as_deref().is_some_and(|c| TIMEOUT.is_match(c))
            {
                kind = "timeout";
                summary = "Zeitüberschreitung".to_owned();
                message = format!(
                    "{phase_label} von {host} hat nicht geantwortet. Das Schulnetz kann große Downloads oder unbekannte Ziele still verwerfen."
                );
            }
        }
    }

    Diagnosis {
        kind,
        summary,
        message: js_slice(&message, 900),
        phase: input.phase,
        host,
        url: js_slice(input.url, 240),
        status,
        location_host,
        page_title,
        content_type: js_slice(&content_type, 80),
        code: code.map(|c| js_slice(&c, 80)),
        resolved_address: input.resolved_address.map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses() {
        for (address, expected) in [
            ("10.0.0.1", true),
            ("192.168.0.1", true),
            ("8.8.8.8", false),
            ("::ffff:10.8.0.1", true),
            ("::ffff:8.8.8.8", false),
            ("::ffff:7f00:1", true),
            ("::1", true),
            ("[fe80::1]", true),
            ("2001:4860:4860::8888", false),
            ("169.254.169.254", true),
            ("100.64.0.1", true),
            ("172.32.0.1", false),
            ("224.0.0.1", true),
            ("fd00::1", true),
            ("", false),
            ("not-an-ip", false),
        ] {
            assert_eq!(is_private_address(address), expected, "{address}");
        }
    }

    #[test]
    fn redirect_and_filter() {
        let meta = ResponseMeta {
            status: 302,
            location: Some("http://login.schule.local/start".into()),
            content_type: Some("text/html".into()),
        };
        let body = "<html><title>WLAN-Anmeldung</title></html>";
        let d = diagnose_update_failure(&DiagnoseInput {
            phase: Phase::Download,
            url: "https://fanotes.fasrv.ch/download/appimage",
            error: None,
            response: Some(&meta),
            body_text: body,
            resolved_address: None,
        });
        assert_eq!(
            (d.kind, d.location_host.as_deref(), d.page_title.as_deref()),
            (
                "redirect",
                Some("login.schule.local"),
                Some("WLAN-Anmeldung")
            )
        );
        assert!(d.message.contains("umgeleitet"));
    }
}
