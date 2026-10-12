//! Add-on registry downloads and profile storage.
//!
//! Installed add-ons live in `<app data>/addons`, never in the vault.
//! Registry downloads stay on the GitHub hosts Electron allows. Add-on
//! network calls stay on public HTTPS and refuse private addresses.

use std::fs;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Map, Value};
use ureq::Agent;

use crate::policy::addon_request_allowed;
use crate::Host;

const ALLOWED_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
];
const MAX_FETCH_BYTES: usize = 2_000_000;
const MAX_REDIRECTS: u8 = 3;
const MAX_FILE_BYTES: usize = 2_000_000;
const MAX_DATA_BYTES: usize = 1_100_000;
const MAX_RECORDS: usize = 500;
const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_RECORDS_FILE_BYTES: usize = 2 * 1024 * 1024;
const NET_MAX_BYTES: usize = 5_000_000;
const NET_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const NET_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "last-modified",
    "x-ratelimit-remaining",
    "retry-after",
    "location",
];

pub fn list(host: &Host) -> Result<Value, String> {
    let _guard = lock();
    Ok(Value::Array(read_records(&store_root(host)?)?))
}

pub fn save(host: &Host, record: &Value) -> Result<Value, String> {
    let _guard = lock();
    let stored = bounded_record(record)?;
    let id = safe_id(stored.get("id").and_then(Value::as_str).unwrap_or(""))?;
    let root = store_root(host)?;
    let mut records = read_records(&root)?;
    records.retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    records.push(stored);
    write_records(&root, &records)?;
    Ok(Value::Null)
}

pub fn remove(host: &Host, id: &str) -> Result<Value, String> {
    let _guard = lock();
    let id = safe_id(id)?;
    let root = store_root(host)?;
    let mut records = read_records(&root)?;
    records.retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    write_records(&root, &records)?;
    let dir = root.join(&id);
    if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Der Add-on-Ordner ist unsicher.".to_owned());
    }
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_file(root.join(format!("{id}.data.json")));
    Ok(Value::Null)
}

pub fn read_file(host: &Host, id: &Value, name: &Value) -> Result<Value, String> {
    let _guard = lock();
    let id = safe_id(id.as_str().unwrap_or(""))?;
    let name = name
        .as_str()
        .ok_or_else(|| "Ungültiger Dateiname.".to_owned())?;
    let target = addon_file(host, &id, name)?;
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err("Die Add-on-Datei ist unsicher.".to_owned())
        }
        Ok(meta) if meta.len() as usize > MAX_FILE_BYTES => {
            Err("Die Add-on-Datei ist zu groß.".to_owned())
        }
        Ok(_) => fs::read(&target)
            .map(|bytes| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            .map_err(|_| "Die Add-on-Datei konnte nicht gelesen werden.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(_) => Err("Die Add-on-Datei konnte nicht gelesen werden.".to_owned()),
    }
}

pub fn write_files(host: &Host, id: &Value, files: &Value) -> Result<Value, String> {
    let _guard = lock();
    let id = safe_id(id.as_str().unwrap_or(""))?;
    let object = files
        .as_object()
        .ok_or_else(|| "Keine Dateien übergeben.".to_owned())?;
    let dir = addon_dir(host, &id)?;
    fs::create_dir_all(&dir)
        .map_err(|_| "Der Add-on-Ordner konnte nicht angelegt werden.".to_owned())?;
    for (name, content) in object {
        let Some(content) = content.as_str() else {
            continue;
        };
        if content.len() > MAX_FILE_BYTES {
            return Err(format!("{name} ist größer als 2 MB."));
        }
        let target = dir.join(safe_file(name)?);
        atomic_write(&target, content.as_bytes())?;
    }
    Ok(Value::Null)
}

pub fn read_data(host: &Host, id: &str) -> Result<Value, String> {
    let _guard = lock();
    let path = store_root(host)?.join(format!("{}.data.json", safe_id(id)?));
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err("Die Add-on-Daten sind unsicher.".to_owned())
        }
        Ok(_) => fs::read(&path)
            .map(|bytes| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            .map_err(|_| "Die Add-on-Daten konnten nicht gelesen werden.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(_) => Err("Die Add-on-Daten konnten nicht gelesen werden.".to_owned()),
    }
}

pub fn write_data(host: &Host, id: &Value, value: &Value) -> Result<Value, String> {
    let _guard = lock();
    let text = value
        .as_str()
        .ok_or_else(|| "Add-on-Daten müssen ein String sein.".to_owned())?;
    if text.len() > MAX_DATA_BYTES {
        return Err("Der Add-on-Speicher ist auf 1 MB begrenzt.".to_owned());
    }
    let id = safe_id(id.as_str().unwrap_or(""))?;
    let root = store_root(host)?;
    let path = root.join(format!("{id}.data.json"));
    if fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_file())
    {
        return Err("Die Add-on-Daten sind unsicher.".to_owned());
    }
    atomic_write(&path, text.as_bytes())?;
    Ok(Value::Null)
}

pub fn fetch_text(raw_url: &str) -> Result<Value, String> {
    let text = request_text(
        raw_url,
        true,
        "GET",
        &[],
        None,
        MAX_FETCH_BYTES,
        "FaNotes-AddonStore",
    )?;
    Ok(Value::String(text.body))
}

pub fn net_fetch(raw_url: &str, init: &Value) -> Result<Value, String> {
    addon_request_allowed(raw_url)?;
    assert_public_resolution(&hostname_of(raw_url)?)?;
    let method = init
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let method = if NET_METHODS.contains(&method.as_str()) {
        method
    } else {
        "GET".to_owned()
    };
    let mut headers = Vec::new();
    if let Some(object) = init.get("headers").and_then(Value::as_object) {
        for (key, value) in object.iter().take(20) {
            let Some(value) = value.as_str() else {
                continue;
            };
            if !is_header_name(key) || is_blocked_header(key) {
                continue;
            }
            headers.push((key.clone(), crate::vault::truncate_utf16(value, 2000)));
        }
    }
    let body = if method != "GET" && method != "HEAD" {
        init.get("body")
            .and_then(Value::as_str)
            .map(|body| crate::vault::truncate_utf16(body, 2_000_000))
    } else {
        None
    };
    let response = request_text(
        raw_url,
        false,
        &method,
        &headers,
        body.as_deref(),
        NET_MAX_BYTES,
        "FaNotes-Addon",
    )?;
    Ok(json!({
        "status": response.status,
        "statusText": response.status_text,
        "headers": response.headers,
        "body": response.body,
        "url": response.url,
    }))
}

struct HttpText {
    status: u16,
    status_text: String,
    headers: Map<String, Value>,
    body: String,
    url: String,
}

fn request_text(
    raw_url: &str,
    registry: bool,
    method: &str,
    headers: &[(String, String)],
    body: Option<&str>,
    max_bytes: usize,
    user_agent: &str,
) -> Result<HttpText, String> {
    let mut url = raw_url.to_owned();
    let mut redirects_left = MAX_REDIRECTS;
    let agent: Agent = Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    loop {
        if registry {
            assert_registry_url(&url)?;
            assert_public_resolution(&hostname_of(&url)?)?;
        } else {
            addon_request_allowed(&url)?;
            assert_public_resolution(&hostname_of(&url)?)?;
        }
        let mut builder = ureq::http::Request::builder()
            .method(method)
            .uri(&url)
            .header("User-Agent", user_agent)
            .header(
                "Accept",
                if registry {
                    "application/vnd.github.raw+json, text/plain, application/json;q=0.9, */*;q=0.1"
                } else {
                    "*/*"
                },
            );
        for (key, value) in headers {
            builder = builder.header(key, value);
        }
        let request = if let Some(body) = body {
            builder
                .header("Content-Length", body.len().to_string())
                .body(body.to_owned())
        } else {
            builder.body(String::new())
        }
        .map_err(|_| "Ungültige URL.".to_owned())?;
        let mut response = agent.run(request).map_err(|error| {
            format!("Zeitüberschreitung beim Laden oder der Host ist nicht erreichbar: {error}")
        })?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        match redirect_step(registry, redirects_left, method, status, location.is_some()) {
            RedirectStep::Follow => {
                let location = location.ok_or_else(|| "Ungültige Weiterleitung.".to_owned())?;
                url = resolve_redirect(&url, &location)?;
                redirects_left = redirects_left.saturating_sub(1);
                continue;
            }
            RedirectStep::TooMany => return Err("Zu viele Weiterleitungen.".to_owned()),
            RedirectStep::Stop => {}
        }
        if registry && !(200..300).contains(&status) {
            let host = hostname_of(&url).unwrap_or_default();
            let path = path_of(&url);
            if status == 404 {
                return Err(format!("Nicht gefunden (404): {path}"));
            }
            return Err(format!("HTTP {status} beim Laden von {host}{path}"));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .with_config()
            .limit(max_bytes as u64 + 1)
            .reader()
            .read_to_end(&mut bytes)
            .map_err(|_| "Zeitüberschreitung beim Laden.".to_owned())?;
        if bytes.len() > max_bytes {
            return Err(if registry {
                "Die Datei ist größer als 2 MB.".to_owned()
            } else {
                "Die Antwort ist größer als 5 MB.".to_owned()
            });
        }
        let mut picked = Map::new();
        for name in NET_RESPONSE_HEADERS {
            if let Some(value) = response
                .headers()
                .get(*name)
                .and_then(|value| value.to_str().ok())
            {
                picked.insert(
                    (*name).to_owned(),
                    Value::String(crate::vault::truncate_utf16(value, 2000)),
                );
            }
        }
        return Ok(HttpText {
            status,
            status_text: response
                .status()
                .canonical_reason()
                .unwrap_or("")
                .to_owned(),
            headers: picked,
            body: String::from_utf8_lossy(&bytes).into_owned(),
            url,
        });
    }
}

fn assert_registry_url(raw_url: &str) -> Result<(), String> {
    let url = url::Url::parse(raw_url).map_err(|_| "Ungültige Add-on-Adresse.".to_owned())?;
    let hostname = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || !ALLOWED_HOSTS.contains(&hostname)
    {
        return Err(format!(
            "Diese Adresse ist für Add-ons nicht erlaubt: {}",
            if hostname.is_empty() {
                raw_url
            } else {
                hostname
            }
        ));
    }
    Ok(())
}

fn assert_public_resolution(hostname: &str) -> Result<(), String> {
    if hostname.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let addresses = (hostname, 443)
        .to_socket_addrs()
        .map_err(|_| "Der Add-on-Host konnte nicht aufgelöst werden.".to_owned())?;
    let mut seen = false;
    for address in addresses {
        seen = true;
        if ip_is_private(address.ip()) {
            return Err("Add-ons dürfen keine privaten oder lokalen Adressen aufrufen.".to_owned());
        }
    }
    if seen {
        Ok(())
    } else {
        Err("Der Add-on-Host konnte nicht aufgelöst werden.".to_owned())
    }
}

fn ip_is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => ipv4_is_private(address),
        IpAddr::V6(address) => ipv6_is_private(address),
    }
}

fn ipv4_is_private(address: Ipv4Addr) -> bool {
    let [a, b, _, _] = address.octets();
    a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
}

fn ipv6_is_private(address: Ipv6Addr) -> bool {
    let text = address.to_string();
    if let Some(mapped) = text.strip_prefix("::ffff:") {
        return mapped
            .parse::<Ipv4Addr>()
            .map(ipv4_is_private)
            .unwrap_or(true);
    }
    if address.is_unspecified() || address.is_loopback() {
        return true;
    }
    let first = u16::from_be_bytes([address.octets()[0], address.octets()[1]]);
    !(0x2000..=0x3fff).contains(&first)
}

fn hostname_of(raw_url: &str) -> Result<String, String> {
    url::Url::parse(raw_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .ok_or_else(|| "Ungültige URL.".to_owned())
}

fn path_of(raw_url: &str) -> String {
    url::Url::parse(raw_url)
        .map(|url| url.path().to_owned())
        .unwrap_or_default()
}

enum RedirectStep {
    Follow,
    Stop,
    TooMany,
}

fn redirect_step(
    registry: bool,
    redirects_left: u8,
    method: &str,
    status: u16,
    has_location: bool,
) -> RedirectStep {
    let can_follow =
        (300..400).contains(&status) && has_location && (method == "GET" || method == "HEAD");
    if !can_follow {
        return RedirectStep::Stop;
    }
    if redirects_left == 0 {
        if registry {
            RedirectStep::TooMany
        } else {
            RedirectStep::Stop
        }
    } else {
        RedirectStep::Follow
    }
}

fn resolve_redirect(current: &str, location: &str) -> Result<String, String> {
    let base = url::Url::parse(current).map_err(|_| "Ungültige Weiterleitung.".to_owned())?;
    base.join(location)
        .map(|next| next.to_string())
        .map_err(|_| "Ungültige Weiterleitung.".to_owned())
}

fn read_records(root: &Path) -> Result<Vec<Value>, String> {
    let path = root.join("addons.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("addons.json ist ungültig.".to_owned()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("addons.json ist ungültig.".to_owned());
    }
    if meta.len() as usize > MAX_RECORDS_FILE_BYTES {
        return Err("Die Add-on-Liste ist zu groß.".to_owned());
    }
    let raw = fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|_| "addons.json ist ungültig.".to_owned())?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(_) => Ok(Vec::new()),
        Err(_) => Ok(Vec::new()),
    }
}

fn write_records(root: &Path, records: &[Value]) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|_| "Der Add-on-Ordner konnte nicht angelegt werden.".to_owned())?;
    let snapshot =
        serde_json::to_string_pretty(&records.iter().take(MAX_RECORDS).collect::<Vec<_>>())
            .map_err(|_| "Die Add-on-Liste ist zu groß.".to_owned())?;
    if snapshot.len() > MAX_RECORDS_FILE_BYTES {
        return Err("Die Add-on-Liste ist zu groß.".to_owned());
    }
    atomic_write(&root.join("addons.json"), snapshot.as_bytes())
}

fn bounded_record(record: &Value) -> Result<Value, String> {
    let object = record
        .as_object()
        .ok_or_else(|| "Ungültiger Add-on-Eintrag.".to_owned())?;
    if !object.get("id").is_some_and(Value::is_string) {
        return Err("Ungültiger Add-on-Eintrag.".to_owned());
    }
    let mut bytes = 0usize;
    visit_record(record, 0, &mut bytes)?;
    serde_json::to_value(record).map_err(|_| "Ungültiger Add-on-Eintrag.".to_owned())
}

fn visit_record(value: &Value, depth: usize, bytes: &mut usize) -> Result<(), String> {
    if *bytes > MAX_RECORD_BYTES {
        return Err("Der Add-on-Eintrag ist zu groß.".to_owned());
    }
    if depth > 8 {
        return Err("Ungültiger Add-on-Eintrag.".to_owned());
    }
    match value {
        Value::Null | Value::Bool(_) => *bytes += 8,
        Value::Number(number) => {
            if !number.as_f64().is_some_and(f64::is_finite) {
                return Err("Ungültiger Add-on-Eintrag.".to_owned());
            }
            *bytes += 24;
        }
        Value::String(text) => {
            *bytes += text.len();
            if *bytes > MAX_RECORD_BYTES {
                return Err("Der Add-on-Eintrag ist zu groß.".to_owned());
            }
        }
        Value::Array(items) => {
            if items.len() > 400 {
                return Err("Ungültiger Add-on-Eintrag.".to_owned());
            }
            for item in items {
                visit_record(item, depth + 1, bytes)?;
            }
        }
        Value::Object(object) => {
            if object.len() > 80 {
                return Err("Ungültiger Add-on-Eintrag.".to_owned());
            }
            for (key, item) in object {
                *bytes += key.len();
                visit_record(item, depth + 1, bytes)?;
            }
        }
    }
    Ok(())
}

fn addon_file(host: &Host, id: &str, name: &str) -> Result<PathBuf, String> {
    Ok(addon_dir(host, id)?.join(safe_file(name)?))
}

fn addon_dir(host: &Host, id: &str) -> Result<PathBuf, String> {
    let id = safe_id(id)?;
    let dir = store_root(host)?.join(id);
    if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Der Add-on-Ordner ist unsicher.".to_owned());
    }
    Ok(dir)
}

fn store_root(host: &Host) -> Result<PathBuf, String> {
    let root = host.app_data.join("addons");
    match fs::symlink_metadata(&root) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            Err("Der Add-on-Ordner ist unsicher.".to_owned())
        }
        Ok(_) => Ok(root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&root)
                .map_err(|_| "Der Add-on-Ordner konnte nicht angelegt werden.".to_owned())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&root, fs::Permissions::from_mode(0o700));
            }
            let meta = fs::symlink_metadata(&root)
                .map_err(|_| "Der Add-on-Ordner konnte nicht angelegt werden.".to_owned())?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err("Der Add-on-Ordner ist unsicher.".to_owned());
            }
            Ok(root)
        }
        Err(_) => Err("Der Add-on-Ordner konnte nicht angelegt werden.".to_owned()),
    }
}

fn safe_id(id: &str) -> Result<String, String> {
    let bytes = id.as_bytes();
    let ok = (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
    if ok {
        Ok(id.to_owned())
    } else {
        Err("Ungültige Add-on-ID.".to_owned())
    }
}

fn safe_file(name: &str) -> Result<String, String> {
    let ok = (1..=80).contains(&name.len())
        && !name.contains("..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
    if ok {
        Ok(name.to_owned())
    } else {
        Err("Ungültiger Dateiname.".to_owned())
    }
}

fn is_header_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn is_blocked_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "cookie"
            | "host"
            | "origin"
            | "referer"
            | "content-length"
            | "transfer-encoding"
            | "connection"
    )
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if fs::symlink_metadata(parent).is_err() {
            fs::create_dir_all(parent)
                .map_err(|_| "Der Add-on-Ordner konnte nicht angelegt werden.".to_owned())?;
        }
    }
    crate::notes::atomic_write(path, bytes, 0o600)
        .map_err(|_| "Die Add-on-Datei konnte nicht geschrieben werden.".to_owned())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{redirect_step, resolve_redirect, RedirectStep};

    #[test]
    fn redirects_resolve_like_the_desktop_url_parser() {
        let base = "https://example.com/a/b?q=1#old";
        assert_eq!(
            resolve_redirect(base, "https://cdn.example/file").unwrap(),
            "https://cdn.example/file"
        );
        assert_eq!(
            resolve_redirect(base, "HTTP://cdn.example/file").unwrap(),
            "http://cdn.example/file"
        );
        assert_eq!(
            resolve_redirect(base, "//cdn.example/file").unwrap(),
            "https://cdn.example/file"
        );
        assert_eq!(
            resolve_redirect(base, "/root").unwrap(),
            "https://example.com/root"
        );
        assert_eq!(
            resolve_redirect(base, "other").unwrap(),
            "https://example.com/a/other"
        );
        assert_eq!(
            resolve_redirect(base, "../other").unwrap(),
            "https://example.com/other"
        );
        assert_eq!(
            resolve_redirect(base, "?x=1").unwrap(),
            "https://example.com/a/b?x=1"
        );
        assert_eq!(
            resolve_redirect(base, "#section").unwrap(),
            "https://example.com/a/b?q=1#section"
        );
    }

    #[test]
    fn redirects_follow_get_and_head_until_the_budget_is_spent() {
        assert!(matches!(
            redirect_step(false, 3, "GET", 302, true),
            RedirectStep::Follow
        ));
        assert!(matches!(
            redirect_step(false, 0, "GET", 302, true),
            RedirectStep::Stop
        ));
        assert!(matches!(
            redirect_step(true, 0, "GET", 302, true),
            RedirectStep::TooMany
        ));
        assert!(matches!(
            redirect_step(false, 3, "POST", 302, true),
            RedirectStep::Stop
        ));
        assert!(matches!(
            redirect_step(false, 3, "GET", 302, false),
            RedirectStep::Stop
        ));
        assert!(matches!(
            redirect_step(false, 3, "HEAD", 200, true),
            RedirectStep::Stop
        ));
    }
}
