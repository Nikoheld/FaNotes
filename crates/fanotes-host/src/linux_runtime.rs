//! Linux startup facts Electron reports in `linuxRuntime`.
//!
//! Hyprland `force_zero_scaling` is read from the compositor config, including
//! `source =` files. The focused monitor scale comes from `hyprctl` when a
//! Hyprland session is running.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

const MAX_FILES: usize = 24;
const MAX_BYTES: u64 = 256 * 1024;
const SCALE_MIN: f64 = 0.5;
const SCALE_MAX: f64 = 4.0;
const SCALE_FALLBACK: f64 = 2.0;

pub fn bootstrap_linux() -> Value {
    let env = std::env::vars().collect();
    report(std::env::consts::OS, &env, run_hyprctl)
}

pub fn report(
    platform: &str,
    env: &BTreeMap<String, String>,
    mut hyprctl: impl FnMut() -> Option<String>,
) -> Value {
    let desktop = env
        .get("XDG_CURRENT_DESKTOP")
        .map(String::as_str)
        .unwrap_or("");
    let session = env
        .get("XDG_SESSION_TYPE")
        .map(String::as_str)
        .unwrap_or("");
    let signature = env
        .get("HYPRLAND_INSTANCE_SIGNATURE")
        .map(String::as_str)
        .unwrap_or("");
    let instance = !signature.is_empty();
    let hyprland = instance || desktop.to_ascii_lowercase().contains("hyprland");
    let input = linux_input(platform, env, &mut hyprctl);
    json!({
        "platform": platform,
        "ozone": if platform == "linux" { "x11" } else { "" },
        "sessionType": session,
        "desktop": desktop,
        "hyprland": hyprland,
        "hyprlandInstance": instance,
        "display": env.get("DISPLAY").map(String::as_str).unwrap_or(""),
        "waylandDisplay": env.get("WAYLAND_DISPLAY").map(String::as_str).unwrap_or(""),
        "hyprlandZeroScaling": input.zero_scaling,
        "deviceScaleFactor": number(input.scale_factor),
        "deviceScaleSource": input.scale_source,
        "monitorScale": number(input.monitor_scale),
    })
}

struct LinuxInput {
    zero_scaling: bool,
    scale_factor: Option<f64>,
    scale_source: Option<&'static str>,
    monitor_scale: Option<f64>,
}

fn linux_input(
    platform: &str,
    env: &BTreeMap<String, String>,
    hyprctl: &mut impl FnMut() -> Option<String>,
) -> LinuxInput {
    if platform != "linux" {
        return LinuxInput {
            zero_scaling: false,
            scale_factor: None,
            scale_source: None,
            monitor_scale: None,
        };
    }
    let zero_scaling = force_zero_scaling(env);
    if zero_scaling {
        let resolved = resolve_device_scale(env, hyprctl);
        let monitor_scale = if resolved.source == "hyprctl" {
            Some(resolved.scale)
        } else {
            monitor_scale(env, hyprctl)
        };
        LinuxInput {
            zero_scaling: true,
            scale_factor: Some(resolved.scale),
            scale_source: Some(resolved.source),
            monitor_scale,
        }
    } else {
        LinuxInput {
            zero_scaling: false,
            scale_factor: None,
            scale_source: None,
            monitor_scale: monitor_scale(env, hyprctl),
        }
    }
}

struct ResolvedScale {
    scale: f64,
    source: &'static str,
}

fn resolve_device_scale(
    env: &BTreeMap<String, String>,
    hyprctl: &mut impl FnMut() -> Option<String>,
) -> ResolvedScale {
    if let Some(scale) = normalize_scale(env.get("FANOTES_DEVICE_SCALE").map(String::as_str)) {
        return ResolvedScale {
            scale,
            source: "FANOTES_DEVICE_SCALE",
        };
    }
    if let Some(scale) = monitor_scale(env, hyprctl) {
        return ResolvedScale {
            scale,
            source: "hyprctl",
        };
    }
    if let Some(scale) = gdk_scale(env) {
        return ResolvedScale {
            scale,
            source: "GDK_SCALE",
        };
    }
    ResolvedScale {
        scale: SCALE_FALLBACK,
        source: "fallback",
    }
}

fn monitor_scale(
    env: &BTreeMap<String, String>,
    hyprctl: &mut impl FnMut() -> Option<String>,
) -> Option<f64> {
    if env
        .get("HYPRLAND_INSTANCE_SIGNATURE")
        .is_none_or(String::is_empty)
    {
        return None;
    }
    focused_monitor_scale(&hyprctl()?)
}

fn gdk_scale(env: &BTreeMap<String, String>) -> Option<f64> {
    let gdk = parse_float(env.get("GDK_SCALE")?)?;
    if !gdk.is_finite() || gdk <= 0.0 {
        return None;
    }
    let dpi = env
        .get("GDK_DPI_SCALE")
        .and_then(|value| parse_float(value))
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    normalize_scale_number(gdk * dpi)
}

pub fn focused_monitor_scale(output: &str) -> Option<f64> {
    let parsed = serde_json::from_str::<Value>(output).ok()?;
    let monitors = parsed.as_array()?;
    let focused = monitors
        .iter()
        .find(|monitor| monitor.get("focused").and_then(Value::as_bool) == Some(true));
    let candidates: Vec<&Value> = if let Some(focused) = focused {
        std::iter::once(focused).chain(monitors.iter()).collect()
    } else {
        monitors.iter().collect()
    };
    candidates.iter().find_map(|monitor| {
        normalize_scale_number(monitor.get("scale").and_then(Value::as_f64).or_else(|| {
            monitor
                .get("scale")
                .and_then(Value::as_str)
                .and_then(parse_float)
        })?)
    })
}

fn normalize_scale(value: Option<&str>) -> Option<f64> {
    normalize_scale_number(parse_float(value?)?)
}

/// `Number.parseFloat` after JavaScript whitespace, including a byte-order mark.
///
/// `1.2.3` is 1.2. An unfinished exponent such as `1e` keeps the number before it.
fn parse_float(value: &str) -> Option<f64> {
    let trimmed = crate::vault::js_trim(value);
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    if bytes
        .get(index)
        .is_some_and(|byte| matches!(byte, b'+' | b'-'))
    {
        index += 1;
    }
    if trimmed[index..].starts_with("Infinity") {
        return trimmed[..index + "Infinity".len()].parse().ok();
    }
    let mut saw_digit = false;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        saw_digit = true;
        index += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            saw_digit = true;
            index += 1;
        }
    }
    if !saw_digit {
        return None;
    }
    if bytes
        .get(index)
        .is_some_and(|byte| matches!(byte, b'e' | b'E'))
    {
        let exponent = index;
        index += 1;
        if bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            index += 1;
        }
        let digits = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == digits {
            index = exponent;
        }
    }
    trimmed[..index].parse().ok()
}

fn normalize_scale_number(scale: f64) -> Option<f64> {
    if !scale.is_finite() || !(SCALE_MIN..=SCALE_MAX).contains(&scale) {
        return None;
    }
    Some((scale * 1000.0).round() / 1000.0)
}

fn force_zero_scaling(env: &BTreeMap<String, String>) -> bool {
    let configured = env
        .get("FANOTES_HYPRLAND_CONFIG")
        .map(|value| crate::vault::js_trim(value))
        .filter(|value| !value.is_empty());
    let roots = if let Some(path) = configured {
        vec![PathBuf::from(path)]
    } else if let Some(home) = env.get("HOME").filter(|home| !home.is_empty()) {
        vec![PathBuf::from(home).join(".config/hypr/hyprland.conf")]
    } else {
        Vec::new()
    };
    roots
        .iter()
        .any(|path| scan_force_zero_scaling(path, env, &mut BTreeSet::new()) == Some(true))
}

fn scan_force_zero_scaling(
    path: &Path,
    env: &BTreeMap<String, String>,
    visited: &mut BTreeSet<PathBuf>,
) -> Option<bool> {
    let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    if visited.contains(&resolved) || visited.len() >= MAX_FILES {
        return None;
    }
    visited.insert(resolved.clone());
    let meta = std::fs::metadata(&resolved).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(&resolved).ok()?;
    let mut last = None;
    let from_dir = resolved.parent().unwrap_or(Path::new("."));
    for raw_line in text.split('\n') {
        let line = crate::vault::js_trim(strip_comment(raw_line));
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = crate::vault::js_trim(key);
        let value = crate::vault::js_trim(value);
        if key.eq_ignore_ascii_case("source") {
            for target in source_targets(value, env, from_dir) {
                if let Some(nested) = scan_force_zero_scaling(&target, env, visited) {
                    last = Some(nested);
                }
            }
        } else if key.eq_ignore_ascii_case("force_zero_scaling") {
            if let Some(enabled) = bool_word(value) {
                last = Some(enabled);
            }
        }
    }
    last
}

fn source_targets(pattern: &str, env: &BTreeMap<String, String>, from_dir: &Path) -> Vec<PathBuf> {
    let Some(expanded) = expand_path(pattern, env, from_dir) else {
        return Vec::new();
    };
    let text = expanded.to_string_lossy();
    if !text.contains(['*', '?', '[']) {
        return vec![expanded];
    }
    glob_paths(&text)
}

fn expand_path(raw: &str, env: &BTreeMap<String, String>, from_dir: &Path) -> Option<PathBuf> {
    let mut value = unquote(crate::vault::js_trim(raw)).to_string();
    if value.is_empty() {
        return None;
    }
    let home = env.get("HOME").map(String::as_str).unwrap_or("");
    let xdg = env
        .get("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .unwrap_or("");
    let xdg_default;
    let xdg = if xdg.is_empty() && !home.is_empty() {
        xdg_default = format!("{home}/.config");
        xdg_default.as_str()
    } else {
        xdg
    };
    if value == "~" {
        value = home.to_owned();
    } else if let Some(rest) = value.strip_prefix("~/") {
        if home.is_empty() {
            return None;
        }
        value = format!("{home}/{rest}");
    }
    value = expand_env_vars(&value, env, home, xdg);
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(&value);
    let path = if path.is_absolute() {
        path
    } else {
        from_dir.join(path)
    };
    Some(std::path::absolute(path).unwrap_or(PathBuf::from(value)))
}

fn expand_env_vars(value: &str, env: &BTreeMap<String, String>, home: &str, xdg: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            out.push(bytes[index] as char);
            index += 1;
            continue;
        }
        if bytes.get(index + 1) == Some(&b'{') {
            if let Some(end) = value[index + 2..].find('}') {
                let name = &value[index + 2..index + 2 + end];
                out.push_str(&env_value(name, env, home, xdg));
                index += 2 + end + 1;
                continue;
            }
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        if end > start && (bytes[start].is_ascii_alphabetic() || bytes[start] == b'_') {
            out.push_str(&env_value(&value[start..end], env, home, xdg));
            index = end;
        } else {
            out.push('$');
            index += 1;
        }
    }
    out
}

fn env_value(name: &str, env: &BTreeMap<String, String>, home: &str, xdg: &str) -> String {
    if name == "HOME" {
        return home.to_owned();
    }
    if name == "XDG_CONFIG_HOME" {
        return xdg.to_owned();
    }
    env.get(name).cloned().unwrap_or_default()
}

fn unquote(value: &str) -> &str {
    let mut value = value;
    if value.starts_with(['\'', '"']) {
        value = &value[1..];
    }
    if value.ends_with(['\'', '"']) && !value.is_empty() {
        value = &value[..value.len() - 1];
    }
    value
}

fn glob_paths(pattern: &str) -> Vec<PathBuf> {
    let absolute = pattern.starts_with('/');
    let parts: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    let mut current = vec![if absolute {
        PathBuf::from("/")
    } else {
        PathBuf::new()
    }];
    for part in parts {
        let mut next = Vec::new();
        for base in &current {
            let base_path = if base.as_os_str().is_empty() {
                Path::new(".")
            } else {
                base.as_path()
            };
            if part.contains(['*', '?', '[']) {
                let Ok(entries) = std::fs::read_dir(base_path) else {
                    continue;
                };
                let mut matches = Vec::new();
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if glob_component(part, &name) {
                        matches.push(if base.as_os_str().is_empty() {
                            PathBuf::from(name.as_ref())
                        } else {
                            base.join(name.as_ref())
                        });
                    }
                }
                matches.sort();
                next.extend(matches);
            } else if base.as_os_str().is_empty() {
                next.push(PathBuf::from(part));
            } else {
                next.push(base.join(part));
            }
        }
        current = next;
    }
    current
}

fn glob_component(pattern: &str, name: &str) -> bool {
    fn rec(pattern: &[u8], name: &[u8]) -> bool {
        if pattern.is_empty() {
            return name.is_empty();
        }
        match pattern[0] {
            b'*' => rec(&pattern[1..], name) || (!name.is_empty() && rec(pattern, &name[1..])),
            b'?' => !name.is_empty() && rec(&pattern[1..], &name[1..]),
            b'[' => {
                let Some(end) = pattern.iter().position(|byte| *byte == b']') else {
                    return false;
                };
                if name.is_empty() || end < 2 {
                    return false;
                }
                let class = &pattern[1..end];
                let negated = class[0] == b'!' || class[0] == b'^';
                let class = if negated { &class[1..] } else { class };
                let hit = class.contains(&name[0]);
                (hit != negated) && rec(&pattern[end + 1..], &name[1..])
            }
            byte => !name.is_empty() && name[0] == byte && rec(&pattern[1..], &name[1..]),
        }
    }
    rec(pattern.as_bytes(), name.as_bytes())
}

fn bool_word(value: &str) -> Option<bool> {
    let word = value
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .next()
        .unwrap_or("");
    match word {
        "true" | "TRUE" | "True" => Some(true),
        "false" | "FALSE" | "False" => Some(false),
        _ => {
            let lower = word.to_ascii_lowercase();
            match lower.as_str() {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            }
        }
    }
}

fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(index) => &line[..index],
        None => line,
    }
}

fn number(value: Option<f64>) -> Value {
    match value {
        Some(value) => json!(value),
        None => Value::Null,
    }
}

fn run_hyprctl() -> Option<String> {
    let mut child = std::process::Command::new("hyprctl")
        .args(["-j", "monitors"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        let _ = sender.send(text);
    });
    match receiver.recv_timeout(Duration::from_millis(1500)) {
        Ok(text) => {
            let _ = child.wait();
            Some(text)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn force_zero_scaling_follows_source_files_and_ignores_comments() {
        let dir = std::env::temp_dir().join(format!("fanotes-hypr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".config/hypr")).unwrap();
        fs::write(
            dir.join("hyprland.conf"),
            "source = ./looks.conf\nmonitor = ,preferred,auto,2\n",
        )
        .unwrap();
        fs::write(
            dir.join("looks.conf"),
            "xwayland {\n  force_zero_scaling = true\n}\n",
        )
        .unwrap();
        let runtime = report(
            "linux",
            &env(&[
                (
                    "FANOTES_HYPRLAND_CONFIG",
                    dir.join("hyprland.conf").to_str().unwrap(),
                ),
                ("HOME", ""),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(runtime["hyprlandZeroScaling"], true);
        assert_eq!(runtime["deviceScaleFactor"], 2.0);
        assert_eq!(runtime["deviceScaleSource"], "fallback");
        assert_eq!(runtime["ozone"], "x11");

        fs::write(
            dir.join(".config/hypr/hyprland.conf"),
            "source = ~/.config/hypr/monitors.conf\n",
        )
        .unwrap();
        fs::write(
            dir.join(".config/hypr/monitors.conf"),
            "force_zero_scaling = true\n",
        )
        .unwrap();
        let home = report("linux", &env(&[("HOME", dir.to_str().unwrap())]), || {
            panic!("hyprctl")
        });
        assert_eq!(home["hyprlandZeroScaling"], true);

        fs::write(
            dir.join("comment.conf"),
            "# force_zero_scaling = true\nsource = ./missing.conf\n",
        )
        .unwrap();
        let commented = report(
            "linux",
            &env(&[
                (
                    "FANOTES_HYPRLAND_CONFIG",
                    dir.join("comment.conf").to_str().unwrap(),
                ),
                ("HOME", ""),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(commented["hyprlandZeroScaling"], false);
        assert!(commented["deviceScaleFactor"].is_null());

        fs::write(
            dir.join("plain.conf"),
            "xwayland {\n  force_zero_scaling = false\n}\n",
        )
        .unwrap();
        let plain = report(
            "linux",
            &env(&[
                (
                    "FANOTES_HYPRLAND_CONFIG",
                    dir.join("plain.conf").to_str().unwrap(),
                ),
                ("HOME", ""),
            ]),
            || None,
        );
        assert_eq!(plain["hyprlandZeroScaling"], false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_focused_monitor_sets_the_scale_when_hyprland_is_unscaled() {
        let monitors = r#"[{"id":1,"name":"DP-2","scale":1,"focused":false},{"id":0,"name":"eDP-1","scale":1.5,"focused":true}]"#;
        assert_eq!(focused_monitor_scale(monitors), Some(1.5));
        assert_eq!(
            focused_monitor_scale(r#"[{"scale":1.25},{"scale":2}]"#),
            Some(1.25)
        );
        assert_eq!(
            focused_monitor_scale(r#"[{"scale":0},{"scale":1.666667}]"#),
            Some(1.667)
        );
        assert_eq!(focused_monitor_scale("not json"), None);
        assert_eq!(focused_monitor_scale(r#"{"scale":2}"#), None);
        assert_eq!(focused_monitor_scale("[]"), None);

        let dir = std::env::temp_dir().join(format!("fanotes-hypr-scale-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("hyprland.conf");
        fs::write(&config, "force_zero_scaling = true\n").unwrap();
        let config = config.to_str().unwrap().to_owned();
        let mut calls = 0;
        let scaled = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", &config),
                ("HOME", ""),
                ("HYPRLAND_INSTANCE_SIGNATURE", "sig"),
            ]),
            || {
                calls += 1;
                Some(monitors.to_owned())
            },
        );
        assert_eq!(calls, 1);
        assert_eq!(scaled["deviceScaleFactor"], 1.5);
        assert_eq!(scaled["deviceScaleSource"], "hyprctl");
        assert_eq!(scaled["monitorScale"], 1.5);
        assert_eq!(scaled["hyprland"], true);
        assert_eq!(scaled["hyprlandInstance"], true);

        let broken = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", &config),
                ("HOME", ""),
                ("HYPRLAND_INSTANCE_SIGNATURE", "sig"),
                ("GDK_SCALE", "2"),
                ("GDK_DPI_SCALE", "0.75"),
            ]),
            || None,
        );
        assert_eq!(broken["deviceScaleFactor"], 1.5);
        assert_eq!(broken["deviceScaleSource"], "GDK_SCALE");
        assert!(broken["monitorScale"].is_null());

        let explicit = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", &config),
                ("HOME", ""),
                ("HYPRLAND_INSTANCE_SIGNATURE", "sig"),
                ("FANOTES_DEVICE_SCALE", "1.25"),
            ]),
            || Some(monitors.to_owned()),
        );
        assert_eq!(explicit["deviceScaleFactor"], 1.25);
        assert_eq!(explicit["deviceScaleSource"], "FANOTES_DEVICE_SCALE");

        let absurd = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", &config),
                ("HOME", ""),
                ("HYPRLAND_INSTANCE_SIGNATURE", "sig"),
                ("FANOTES_DEVICE_SCALE", "40"),
            ]),
            || Some(monitors.to_owned()),
        );
        assert_eq!(absurd["deviceScaleFactor"], 1.5);
        assert_eq!(absurd["deviceScaleSource"], "hyprctl");

        let compositor = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", "/tmp/fanotes-no-such.conf"),
                ("HOME", ""),
                ("HYPRLAND_INSTANCE_SIGNATURE", "sig"),
                ("XDG_CURRENT_DESKTOP", "Hyprland"),
            ]),
            || Some(monitors.to_owned()),
        );
        assert_eq!(compositor["hyprlandZeroScaling"], false);
        assert!(compositor["deviceScaleFactor"].is_null());
        assert_eq!(compositor["monitorScale"], 1.5);
        assert_eq!(compositor["hyprland"], true);

        let desktop_only = report(
            "linux",
            &env(&[("XDG_CURRENT_DESKTOP", "Hyprland"), ("HOME", "")]),
            || panic!("hyprctl"),
        );
        assert_eq!(desktop_only["hyprland"], true);
        assert_eq!(desktop_only["hyprlandInstance"], false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_byte_order_mark_still_enables_zero_scaling() {
        let dir = std::env::temp_dir().join(format!("fanotes-hypr-ws-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".config/hypr")).unwrap();
        let bom = dir.join("bom.conf");
        fs::write(&bom, "\u{FEFF}force_zero_scaling = true\n").unwrap();
        let marked = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", bom.to_str().unwrap()),
                ("HOME", ""),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(marked["hyprlandZeroScaling"], true);

        let value = dir.join("value.conf");
        fs::write(&value, "force_zero_scaling =\u{FEFF}true\n").unwrap();
        let valued = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", value.to_str().unwrap()),
                ("HOME", ""),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(valued["hyprlandZeroScaling"], true);

        let next = dir.join("next.conf");
        fs::write(&next, "\u{0085}force_zero_scaling = true\n").unwrap();
        let skipped = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", next.to_str().unwrap()),
                ("HOME", ""),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(skipped["hyprlandZeroScaling"], false);

        let carriage = dir.join("carriage.conf");
        fs::write(
            &carriage,
            "force_zero_scaling = false\rforce_zero_scaling = true",
        )
        .unwrap();
        let first = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", carriage.to_str().unwrap()),
                ("HOME", ""),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(first["hyprlandZeroScaling"], false);

        fs::write(
            dir.join(".config/hypr/hyprland.conf"),
            "force_zero_scaling = true\n",
        )
        .unwrap();
        let blank = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", "\u{FEFF}"),
                ("HOME", dir.to_str().unwrap()),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(blank["hyprlandZeroScaling"], true);

        let scale = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", bom.to_str().unwrap()),
                ("HOME", ""),
                ("FANOTES_DEVICE_SCALE", "\u{FEFF}1.5"),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(scale["deviceScaleFactor"], 1.5);
        assert_eq!(scale["deviceScaleSource"], "FANOTES_DEVICE_SCALE");
        let ignored = report(
            "linux",
            &env(&[
                ("FANOTES_HYPRLAND_CONFIG", bom.to_str().unwrap()),
                ("HOME", ""),
                ("FANOTES_DEVICE_SCALE", "\u{0085}1.5"),
            ]),
            || panic!("hyprctl"),
        );
        assert_eq!(ignored["deviceScaleFactor"], 2.0);
        assert_eq!(ignored["deviceScaleSource"], "fallback");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_device_scale_uses_parse_float() {
        let dir = std::env::temp_dir().join(format!("fanotes-scale-parse-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("hyprland.conf");
        fs::write(&config, "force_zero_scaling = true\n").unwrap();
        let config = config.to_str().unwrap();
        let scaled = |value: &str| {
            report(
                "linux",
                &env(&[
                    ("FANOTES_HYPRLAND_CONFIG", config),
                    ("HOME", ""),
                    ("FANOTES_DEVICE_SCALE", value),
                ]),
                || panic!("hyprctl"),
            )
        };
        let dotted = scaled("1.2.3");
        assert_eq!(dotted["deviceScaleFactor"], 1.2);
        assert_eq!(dotted["deviceScaleSource"], "FANOTES_DEVICE_SCALE");
        assert_eq!(scaled("1e")["deviceScaleFactor"], 1.0);
        assert_eq!(scaled("1.25e0px")["deviceScaleFactor"], 1.25);
        assert_eq!(scaled("2E-1")["deviceScaleFactor"], 2.0);
        assert_eq!(scaled("2E-1")["deviceScaleSource"], "fallback");
        let _ = fs::remove_dir_all(&dir);
    }
}
