//! Path rules (`isSyncablePath`, `folderSync.ts`) and conflict copy names
//! (`conflictCopyPath`), as in `engine.ts`.

use chrono::{Datelike, TimeZone, Timelike};

use crate::jsjson::{self, utf16_len, JsString};

pub const RECOGNITION_MODEL_SYNC_PATH: &str = ".fanotes/recognition-model.json";
const INTERNAL_DIRECTORY: &str = ".fanotes";
const SKIPPED_INTERNAL: &[&str] = &["history", "onboarding.json", "tree-cache", "trash"];
const SKIPPED_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

#[derive(Clone, Debug, Default)]
pub struct SyncPathOptions {
    pub excluded_prefixes: Vec<String>,
    pub include_recognition_model: bool,
    pub include_history: bool,
}

/// Case folding of a JavaScript `/iu` regular expression for the ASCII letters we match.
fn iu_fold(character: char) -> char {
    match character {
        '\u{017F}' => 's',
        '\u{212A}' => 'k',
        'A'..='Z' => character.to_ascii_lowercase(),
        other => other,
    }
}

/// The char index where `suffix` (lowercase ASCII) starts when `chars` ends with it under `/iu`.
fn iu_suffix_start(chars: &[char], suffix: &str) -> Option<usize> {
    let suffix: Vec<char> = suffix.chars().collect();
    if chars.len() < suffix.len() {
        return None;
    }
    let start = chars.len() - suffix.len();
    chars[start..]
        .iter()
        .zip(&suffix)
        .all(|(left, right)| iu_fold(*left) == *right)
        .then_some(start)
}

fn ends_with_iu(value: &str, suffixes: &[&str]) -> bool {
    let chars: Vec<char> = value.chars().collect();
    suffixes
        .iter()
        .any(|suffix| iu_suffix_start(&chars, suffix).is_some())
}

/// `/\.(?:md|markdown|famd)$/iu`
pub fn is_famd_sync_path(path: &str) -> bool {
    ends_with_iu(path, &[".md", ".markdown", ".famd"])
}

/// `value.replace(/\.(md|markdown|famd|pdf)$/iu, '')`, `None` when nothing matched.
pub fn strip_note_extension(value: &JsString) -> Option<JsString> {
    let chars: Vec<char> = char::decode_utf16(value.0.iter().copied())
        .map(|item| item.unwrap_or('\u{FFFD}'))
        .collect();
    // The alternation tries `md` before `markdown`; at a given start only one can end the string.
    for suffix in [".md", ".markdown", ".famd", ".pdf"] {
        if let Some(start) = iu_suffix_start(&chars, suffix) {
            let units: usize = chars[..start]
                .iter()
                .map(|character| character.len_utf16())
                .sum();
            return Some(value.slice(0, units));
        }
    }
    None
}

/// `pathIsSyncExcluded(path, prefixes)`.
pub fn path_is_sync_excluded(path: &str, prefixes: &[String]) -> bool {
    let normalized = path.replace('\\', "/");
    prefixes
        .iter()
        .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix}/")))
}

/// `isSyncablePath(path, options)`.
pub fn is_syncable_path(path: &str, options: &SyncPathOptions) -> bool {
    if path.is_empty()
        || utf16_len(path) > 1024
        || path.contains('\0')
        || path.starts_with('/')
        || path.contains("//")
    {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return false;
    }
    let name = segments[segments.len() - 1];
    if SKIPPED_NAMES.contains(&name)
        || ends_with_iu(name, &[".tmp"])
        || name.starts_with(".~lock.")
        || name.starts_with("~$")
    {
        return false;
    }
    if path == RECOGNITION_MODEL_SYNC_PATH && !options.include_recognition_model {
        return false;
    }
    if path_is_sync_excluded(path, &options.excluded_prefixes) {
        return false;
    }
    if segments[0] == INTERNAL_DIRECTORY {
        if segments.len() < 2 {
            return false;
        }
        if SKIPPED_INTERNAL.contains(&segments[1])
            && !(options.include_history && segments[1] == "history")
        {
            return false;
        }
        return !segments[1..].iter().any(|segment| segment.starts_with('.'));
    }
    !segments.iter().any(|segment| segment.starts_with('.'))
}

/// Local date and time of `ms`, like `Date#getFullYear()` … `getMinutes()`.
pub fn local_parts(ms: f64) -> (i32, u32, u32, u32, u32) {
    match chrono::Local.timestamp_millis_opt(ms as i64).earliest() {
        Some(at) => (at.year(), at.month(), at.day(), at.hour(), at.minute()),
        None => (1970, 1, 1, 0, 0),
    }
}

fn split_name(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(slash) => (&path[..slash + 1], &path[slash + 1..]),
        None => ("", path),
    }
}

/// `deviceName.replace(/[\\/:*?"<>|\0-\x1f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 40) || 'Gerät'`
pub fn sanitize_device_for_copy(device_name: &str) -> String {
    let replaced: String = device_name
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) || (character as u32) < 0x20
            {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cleaned = JsString::from_str(&replaced)
        .collapse_space()
        .trim()
        .slice(0, 40);
    if cleaned.is_empty() {
        "Gerät".to_owned()
    } else {
        cleaned.to_string_lossy()
    }
}

/// `conflictCopyPath(path, deviceName, at)`.
pub fn conflict_copy_path(path: &str, device_name: &str, at_ms: f64) -> String {
    let (directory, name) = split_name(path);
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let (year, month, day, hour, minute) = local_parts(at_ms);
    let device = sanitize_device_for_copy(device_name);
    format!("{directory}{stem} (Konflikt {device} {year:04}-{month:02}-{day:02} {hour:02}-{minute:02}){extension}")
}

/// `defaultDeviceName(platform)`.
pub fn default_device_name(platform: &str) -> &'static str {
    match platform {
        "web" | "browser-preview" => "Browser",
        "win32" => "Windows-Gerät",
        "darwin" => "Mac",
        "linux" => "Linux-Gerät",
        _ => "Gerät",
    }
}

/// `deviceInfo()`: the name and platform token the server registers.
pub fn device_info(device_name: &str, platform: &str) -> (String, String) {
    let trimmed = jsjson::js_trim(device_name);
    let name = if trimmed.is_empty() {
        default_device_name(platform).to_owned()
    } else {
        trimmed.to_owned()
    };
    let name = JsString::from_str(&name).slice(0, 80).to_string_lossy();
    let kept: String = platform
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || *character == '-'
                || *character == '\u{017F}'
                || *character == '\u{212A}'
        })
        .collect();
    let token: String = JsString::from_str(&kept.to_lowercase())
        .slice(0, 24)
        .to_string_lossy();
    let token = if token.is_empty() {
        "unknown".to_owned()
    } else {
        token
    };
    (name, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syncable_paths() {
        let options = SyncPathOptions::default();
        for path in [
            "Mathe/Algebra.md",
            "Mathe/Algebra.famd",
            "Physik/Skript.pdf",
            ".fanotes/folder-colors.json",
            ".fanotes/assets/abc.json",
        ] {
            assert!(is_syncable_path(path, &options), "{path}");
        }
        for path in [
            ".fanotes/history/abc/index.json",
            ".fanotes/trash/index.json",
            ".fanotes/onboarding.json",
            ".git/config",
            "Mathe/.Algebra.md.123.tmp",
            "../etc/passwd",
            "Mathe//x.md",
            ".DS_Store",
            "a/~$x.docx",
            ".fanotes/recognition-model.json",
        ] {
            assert!(!is_syncable_path(path, &options), "{path}");
        }
        let history = SyncPathOptions {
            include_history: true,
            ..Default::default()
        };
        assert!(is_syncable_path(
            ".fanotes/history/abc/index.json",
            &history
        ));
        assert!(is_famd_sync_path("a.MarKdown"));
        assert!(is_famd_sync_path("a.mar\u{212A}down"));
    }

    #[test]
    fn copy_names() {
        std::env::set_var("TZ", "UTC");
        let at = chrono::Local
            .with_ymd_and_hms(2026, 9, 8, 9, 5, 0)
            .unwrap()
            .timestamp_millis() as f64;
        assert_eq!(
            conflict_copy_path("Mathe/Algebra.md", "Laptop", at),
            "Mathe/Algebra (Konflikt Laptop 2026-09-08 09-05).md"
        );
        assert_eq!(
            conflict_copy_path("README", "A/B:C", at),
            "README (Konflikt A B C 2026-09-08 09-05)"
        );
        assert_eq!(
            conflict_copy_path(".hidden", " \t", at),
            ".hidden (Konflikt Gerät 2026-09-08 09-05)"
        );
        assert_eq!(
            device_info("", "Linux"),
            ("Gerät".to_owned(), "linux".to_owned())
        );
        assert_eq!(
            device_info("  Laptop ", "linux"),
            ("Laptop".to_owned(), "linux".to_owned())
        );
        assert_eq!(
            device_info("x", "a b_c"),
            ("x".to_owned(), "abc".to_owned())
        );
    }
}
