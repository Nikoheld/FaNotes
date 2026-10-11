//! Add-on SSRF policy and local AI URL policy, matching `addons.cjs` and `ai-provider.cjs`.

const ADDON_PRIVATE: &str = "Add-ons dürfen keine privaten oder lokalen Adressen aufrufen.";
const ADDON_HTTPS: &str = "Add-ons dürfen nur öffentliche https-Adressen aufrufen.";

pub fn addon_request_allowed(raw_url: &str) -> Result<(), String> {
    let url = url::Url::parse(raw_url).map_err(|_| "Ungültige URL.".to_owned())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
    {
        return Err(ADDON_HTTPS.to_owned());
    }
    if is_private_host(url.host_str().unwrap_or("")) {
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
    let private_ipv4 = parse_ipv4(&hostname).is_some_and(is_lan_ipv4);
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

/// The LM Studio panel accepts the server root and the `/v1` or `/api/v1`
/// suffixes LM Studio shows, then keeps only the origin.
pub fn lm_studio_origin(raw_url: &str) -> Result<String, String> {
    if crate::vault::utf16_len(raw_url) > 2048 {
        return Err("Die LM-Studio-Adresse ist ungültig.".to_owned());
    }
    let url = url::Url::parse(raw_url.trim()).map_err(|_| {
        "Gib eine vollständige LM-Studio-Adresse wie http://127.0.0.1:1234 ein.".to_owned()
    })?;
    if (url.scheme() != "http" && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return Err("Die LM-Studio-Adresse darf nur eine lokale HTTP(S)-Adresse ohne Zugangsdaten enthalten.".to_owned());
    }
    let hostname = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_lowercase();
    let private_ipv4 = parse_ipv4(&hostname).is_some_and(is_lan_ipv4);
    let private_ipv6 = hostname == "::1"
        || hostname.starts_with("fc")
        || hostname.starts_with("fd")
        || hostname.starts_with("fe80:");
    if hostname != "localhost" && !private_ipv4 && !private_ipv6 {
        return Err("Aus Datenschutzgründen sind für LM Studio nur localhost und private LAN-Adressen erlaubt.".to_owned());
    }
    let path = url.path().trim_end_matches('/');
    if !path.is_empty() && path != "/v1" && path != "/api/v1" {
        return Err("Die LM-Studio-Adresse darf keinen zusätzlichen Pfad enthalten.".to_owned());
    }
    Ok(url.origin().ascii_serialization())
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

/// Local model servers use the desktop LAN list. Carrier-grade `100.64/10`
/// and multicast addresses stay off that list.
fn is_lan_ipv4(address: [u8; 4]) -> bool {
    let [a, b, _, _] = address;
    a == 0
        || a == 10
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
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

#[cfg(test)]
mod tests {
    use super::{lm_studio_origin, local_ai_origin};

    #[test]
    fn lm_studio_keeps_the_api_suffix_the_desktop_panel_accepts() {
        assert_eq!(
            lm_studio_origin("http://127.0.0.1:1234/v1").unwrap(),
            "http://127.0.0.1:1234"
        );
        assert_eq!(
            lm_studio_origin("http://127.0.0.1:1234/api/v1/").unwrap(),
            "http://127.0.0.1:1234"
        );
        assert_eq!(
            lm_studio_origin("http://localhost:1234").unwrap(),
            "http://localhost:1234"
        );
        assert!(lm_studio_origin("http://127.0.0.1:1234/v1/models").is_err());
        assert!(lm_studio_origin("https://api.openai.com/v1").is_err());
        assert!(local_ai_origin("http://127.0.0.1:1234/v1", "ollama").is_err());
        assert!(local_ai_origin("http://127.0.0.1:1234/v1", "lmstudio").is_err());
    }
}
