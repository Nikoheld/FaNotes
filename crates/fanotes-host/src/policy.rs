//! Add-on SSRF policy and local AI URL policy, matching `addons.cjs` and `ai-provider.cjs`.

const ADDON_PRIVATE: &str = "Add-ons dürfen keine privaten oder lokalen Adressen aufrufen.";
const ADDON_HTTPS: &str = "Add-ons dürfen nur öffentliche https-Adressen aufrufen.";

pub fn addon_request_allowed(raw_url: &str) -> Result<(), String> {
    let url = raw_url
        .parse::<UrlLite>()
        .map_err(|_| "Ungültige URL.".to_owned())?;
    if url.protocol != "https" || url.has_credentials {
        return Err(ADDON_HTTPS.to_owned());
    }
    if is_private_host(&url.hostname) {
        return Err(ADDON_PRIVATE.to_owned());
    }
    Ok(())
}

pub fn local_ai_origin(raw_url: &str, provider: &str) -> Result<String, String> {
    let label = match provider {
        "lmstudio" => "LM-Studio",
        "ollama" => "Ollama",
        _ => "OpenCode",
    };
    if crate::vault::utf16_len(raw_url) > 2048 {
        return Err(format!("Die {label}-Adresse ist ungültig."));
    }
    let url = url::Url::parse(raw_url.trim())
        .map_err(|_| format!("Gib eine vollständige {label}-Adresse ein."))?;
    if (url.scheme() != "http" && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return Err(format!("Die {label}-Adresse darf nur eine lokale HTTP(S)-Adresse ohne eingebettete Zugangsdaten enthalten."));
    }
    let hostname = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_lowercase();
    if hostname.is_empty() {
        return Err(format!("Gib eine vollständige {label}-Adresse ein."));
    }
    let private_ipv4 = parse_ipv4(&hostname).is_some_and(is_private_ipv4);
    let private_ipv6 = hostname == "::1"
        || hostname.starts_with("fc")
        || hostname.starts_with("fd")
        || hostname.starts_with("fe80:");
    if hostname != "localhost" && !private_ipv4 && !private_ipv6 {
        return Err(format!(
            "{label} darf aus Datenschutzgründen nur auf localhost oder im privaten LAN liegen."
        ));
    }
    if !url.path().trim_end_matches('/').is_empty() {
        return Err(format!(
            "Die {label}-Adresse darf keinen zusätzlichen Pfad enthalten."
        ));
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) struct UrlLite {
    pub(crate) protocol: String,
    pub(crate) hostname: String,
    pub(crate) path: String,
    pub(crate) has_credentials: bool,
}

impl std::str::FromStr for UrlLite {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, ()> {
        let (protocol, rest) = value.split_once("://").ok_or(())?;
        if protocol.is_empty() || rest.is_empty() {
            return Err(());
        }
        let before_query = rest.split_once('?').map(|(head, _)| head).unwrap_or(rest);
        let before_fragment = before_query
            .split_once('#')
            .map(|(head, _)| head)
            .unwrap_or(before_query);
        let (authority, path) = before_fragment
            .split_once('/')
            .map(|(authority, rest)| (authority, format!("/{rest}")))
            .unwrap_or((before_fragment, String::new()));
        if authority.is_empty() {
            return Err(());
        }
        let has_credentials = authority.contains('@');
        let host = authority
            .rsplit_once('@')
            .map(|(_, host)| host)
            .unwrap_or(authority);
        let hostname = if let Some(inner) = host.strip_prefix('[') {
            inner.split_once(']').map(|(name, _)| name).unwrap_or(host)
        } else {
            host.split_once(':').map(|(name, _)| name).unwrap_or(host)
        };
        Ok(Self {
            protocol: protocol.to_owned(),
            hostname: hostname.to_owned(),
            path,
            has_credentials,
        })
    }
}

fn is_private_host(hostname: &str) -> bool {
    let host = hostname.trim_end_matches('.').to_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.chars().all(|character| character.is_ascii_digit())
    {
        return true;
    }
    if let Some(address) = parse_ipv4(&host) {
        return is_private_ipv4(address);
    }
    if host.contains(':') {
        return is_private_ipv6(&host);
    }
    false
}

fn parse_ipv4(value: &str) -> Option<[u8; 4]> {
    let mut parts = [0u8; 4];
    let mut count = 0;
    for part in value.split('.') {
        if count == 4 {
            return None;
        }
        let number: u16 = part.parse().ok()?;
        if number > 255 || (part.len() > 1 && part.starts_with('0')) {
            return None;
        }
        parts[count] = number as u8;
        count += 1;
    }
    (count == 4).then_some(parts)
}

fn is_private_ipv4(address: [u8; 4]) -> bool {
    let [a, b, _, _] = address;
    a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
}

fn is_private_ipv6(value: &str) -> bool {
    let value = value.split('%').next().unwrap_or(value);
    if let Some(mapped) = value.strip_prefix("::ffff:") {
        return parse_ipv4(mapped).is_none_or(is_private_ipv4);
    }
    if value == "::" || value == "::1" {
        return true;
    }
    let first = u32::from_str_radix(value.split(':').next().unwrap_or("0"), 16).unwrap_or(0);
    !(0x2000..=0x3fff).contains(&first)
}
