//! Vault path rules from `normalizeRelativePath` and `isInsideRoot` in `electron/main.cjs`.

use std::fs;
use std::path::{Component, Path, PathBuf};

const INTERNAL: &[&str] = &[".fanotes", ".lernwerk"];

pub fn normalize_relative_path(
    value: &str,
    allow_root: bool,
    allow_internal: bool,
) -> Result<String, String> {
    if utf16_len(value) > 4096 || value.contains('\0') {
        return Err("Ungültiger Vault-Pfad.".to_owned());
    }
    if value.contains('\\')
        || Path::new(value).is_absolute()
        || value.starts_with('/')
        || is_windows_drive_path(value)
    {
        return Err("Nur relative Vault-Pfade sind erlaubt.".to_owned());
    }
    let without_prefix = value.strip_prefix("./").unwrap_or(value);
    let trimmed = without_prefix.strip_suffix('/').unwrap_or(without_prefix);
    if trimmed.is_empty() {
        if allow_root {
            return Ok(String::new());
        }
        return Err("Der Vault selbst ist für diese Aktion nicht erlaubt.".to_owned());
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("Pfad-Traversal ist nicht erlaubt.".to_owned());
    }
    if !allow_internal
        && INTERNAL
            .iter()
            .any(|name| segments[0].eq_ignore_ascii_case(name))
    {
        return Err("Interne FaNotes-Dateien sind geschützt.".to_owned());
    }
    Ok(segments.join("/"))
}

/// `path.win32.isAbsolute`: a drive letter, a colon, then a slash.
fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// A note path may not follow a symlink, including a symlink directory.
pub fn resolve_note_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(relative, false, false)?;
    let segments: Vec<&str> = normalized.split('/').collect();
    let mut cursor = root.to_path_buf();
    let mut missing = false;
    for (index, segment) in segments.iter().enumerate() {
        cursor.push(segment);
        if !is_inside_root(root, &cursor) {
            return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
        }
        if missing {
            continue;
        }
        let last = index + 1 == segments.len();
        match fs::symlink_metadata(&cursor) {
            Ok(info) if info.file_type().is_symlink() => {
                return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
            }
            Ok(info) if !last && !info.is_dir() => {
                return Err("Ein Pfadbestandteil ist kein Ordner.".to_owned());
            }
            Ok(info) if last && !info.is_file() => {
                return Err("Die Notiz ist keine sichere reguläre Datei.".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing = true,
            Err(_) => return Err("Die Datei konnte nicht gelesen werden.".to_owned()),
        }
    }
    if let Some(parent) = cursor.parent() {
        if let (Ok(root_real), Ok(parent_real)) = (fs::canonicalize(root), fs::canonicalize(parent))
        {
            if parent_real != root_real && !is_inside_root(&root_real, &parent_real) {
                return Err("Der Pfad verlässt den Vault über einen Link.".to_owned());
            }
        }
    }
    Ok(cursor)
}

/// An existing file or folder. A symlink anywhere in the path is rejected.
pub fn resolve_existing_entry(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(relative, false, false)?;
    let segments: Vec<&str> = normalized.split('/').collect();
    let mut cursor = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        cursor.push(segment);
        if !is_inside_root(root, &cursor) {
            return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
        }
        let last = index + 1 == segments.len();
        match fs::symlink_metadata(&cursor) {
            Ok(info) if info.file_type().is_symlink() => {
                return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
            }
            Ok(info) if !last && !info.is_dir() => {
                return Err("Ein Pfadbestandteil ist kein Ordner.".to_owned());
            }
            Ok(info) if last && !info.is_file() && !info.is_dir() => {
                return Err("Der Eintrag wurde nicht gefunden.".to_owned());
            }
            Ok(_) => {}
            Err(_) => return Err("Der Eintrag wurde nicht gefunden.".to_owned()),
        }
    }
    Ok(cursor)
}

/// Missing folders may be created later. An existing symlink may not.
pub fn reject_symlinks(root: &Path, relative: &str) -> Result<(), String> {
    if relative.is_empty() {
        return Ok(());
    }
    let normalized = normalize_relative_path(relative, true, false)?;
    let mut cursor = root.to_path_buf();
    for segment in normalized.split('/').filter(|segment| !segment.is_empty()) {
        cursor.push(segment);
        match fs::symlink_metadata(&cursor) {
            Ok(info) if info.file_type().is_symlink() => {
                return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("Der Zielordner wurde nicht gefunden.".to_owned()),
        }
    }
    Ok(())
}

pub fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(relative, false, false)?;
    let mut target = root.to_path_buf();
    for segment in normalized.split('/') {
        if matches!(
            Path::new(segment).components().next(),
            Some(Component::ParentDir | Component::RootDir | Component::Prefix(_))
        ) {
            return Err("Pfad-Traversal ist nicht erlaubt.".to_owned());
        }
        target.push(segment);
    }
    if !is_inside_root(root, &target) {
        return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
    }
    Ok(target)
}

/// NFC plus lowercase, matching Electron's `normalize('NFC').toLocaleLowerCase('de-DE')`.
///
/// A macOS file `Mühe.md` and a Linux file `Mühe.md` are the same note name.
/// JavaScript `string.length`: one unit for each basic character, two for the rest.
pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// C0 controls and DEL, matching `/[\0-\x1f\x7f]/`.
pub(crate) fn is_c0_or_del(character: char) -> bool {
    let code = u32::from(character);
    code <= 0x1F || code == 0x7F
}

pub(crate) fn has_c0_or_del(value: &str) -> bool {
    value.chars().any(is_c0_or_del)
}

/// `path.posix.extname`.
///
/// `.md` and `..` have no extension. `.hidden.md` is `.md`.
pub(crate) fn posix_extname(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    if base == "." || base == ".." {
        return "";
    }
    match base.rfind('.') {
        Some(index) if index > 0 => &base[index..],
        _ => "",
    }
}

/// JavaScript `String.prototype.trim`.
///
/// U+FEFF is removed. U+0085 is kept. Rust `str::trim` does the reverse.
pub(crate) fn js_trim(value: &str) -> &str {
    fanotes_famd::trim_js(value)
}

pub(crate) fn truncate_utf16(value: &str, max: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    value[..end].to_owned()
}

pub(crate) fn entry_name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect::<String>().to_lowercase()
}

pub fn is_inside_root(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    !relative
        .components()
        .any(|component| matches!(component, Component::ParentDir))
}

/// Sync paths may enter `.fanotes`. Each existing component is checked so a
/// symlink cannot point the write outside the vault.
pub fn resolve_sync_path(
    root: &Path,
    raw: &str,
    allow_missing: bool,
) -> Result<(PathBuf, String), String> {
    let segments = sync_segments(raw)?;
    let mut cursor = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        cursor.push(segment);
        if !is_inside_root(root, &cursor) {
            return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
        }
        match fs::symlink_metadata(&cursor) {
            Ok(info) if info.file_type().is_symlink() => {
                return Err("Symbolische Links sind im Vault nicht erlaubt.".to_owned());
            }
            Ok(info) if index + 1 < segments.len() && !info.is_dir() => {
                return Err("Ein Pfadbestandteil ist kein Ordner.".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                for rest in &segments[index + 1..] {
                    cursor.push(rest);
                }
                if !is_inside_root(root, &cursor) {
                    return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
                }
                return Ok((cursor, segments.join("/")));
            }
            Err(_) => return Err("Die Datei konnte nicht gelesen werden.".to_owned()),
        }
    }
    Ok((cursor, segments.join("/")))
}

fn sync_segments(raw: &str) -> Result<Vec<String>, String> {
    if raw.is_empty() || utf16_len(raw) > 1024 || raw.contains('\0') {
        return Err("Ungültiger Sync-Pfad.".to_owned());
    }
    let normalized = raw.replace('\\', "/");
    let normalized = normalized.trim_matches('/').to_owned();
    if normalized.is_empty() {
        return Err("Ungültiger Sync-Pfad.".to_owned());
    }
    let segments: Vec<String> = normalized.split('/').map(str::to_owned).collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("Ungültiger Sync-Pfad.".to_owned());
    }
    Ok(segments)
}

/// `.fanotes` is the internal vault directory. An older vault keeps the same
/// files under `.lernwerk`; that directory is renamed into place once.
pub(crate) fn ensure_internal_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(".fanotes");
    match fs::symlink_metadata(&directory) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err("Interne FaNotes-Dateien sind geschützt.".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !rename_legacy_internal(root, &directory)? {
                fs::create_dir(&directory)
                    .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
                }
            }
        }
        Err(_) => return Err("Der Ordner konnte nicht angelegt werden.".to_owned()),
    }
    let root_real = fs::canonicalize(root)
        .map_err(|_| "Der interne FaNotes-Ordner verlässt den Vault.".to_owned())?;
    let real = fs::canonicalize(&directory)
        .map_err(|_| "Der interne FaNotes-Ordner verlässt den Vault.".to_owned())?;
    if real == root_real || !is_inside_root(&root_real, &real) {
        return Err("Der interne FaNotes-Ordner verlässt den Vault.".to_owned());
    }
    Ok(directory)
}

fn rename_legacy_internal(root: &Path, directory: &Path) -> Result<bool, String> {
    let legacy = root.join(".lernwerk");
    match fs::symlink_metadata(&legacy) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err("Der bisherige interne FaNotes-Ordner ist unsicher.".to_owned());
        }
        Ok(_) => {}
        Err(_) => return Err("Der bisherige interne FaNotes-Ordner ist unsicher.".to_owned()),
    }
    let root_real = fs::canonicalize(root)
        .map_err(|_| "Der bisherige interne FaNotes-Ordner verlässt den Vault.".to_owned())?;
    let legacy_real = fs::canonicalize(&legacy)
        .map_err(|_| "Der bisherige interne FaNotes-Ordner verlässt den Vault.".to_owned())?;
    if !is_inside_root(&root_real, &legacy_real) {
        return Err("Der bisherige interne FaNotes-Ordner verlässt den Vault.".to_owned());
    }
    match fs::rename(&legacy, directory) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => Err("Der bisherige interne FaNotes-Ordner ist unsicher.".to_owned()),
    }
}

/// `Number(string)`: the whole string is one numeric literal after JavaScript trim.
///
/// A sign applies to decimals and `Infinity`. `0x` / `0b` / `0o` are unsigned.
/// `800px`, `1e`, and `+0x10` are not numbers.
pub(crate) fn js_tonumber(value: &str) -> Option<f64> {
    let text = js_trim(value);
    if text.is_empty() {
        return Some(0.0);
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'b' | b'B' => Some(2),
            b'o' | b'O' => Some(8),
            _ => None,
        };
        if let Some(radix) = radix {
            return integer_literal(&text[2..], radix);
        }
    }
    decimal_literal(text)
}

fn integer_literal(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let mut value = 0.0_f64;
    for byte in digits.bytes() {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return None,
        };
        if u32::from(digit) >= radix {
            return None;
        }
        value = value.mul_add(f64::from(radix), f64::from(digit));
        if !value.is_finite() {
            return Some(f64::INFINITY);
        }
    }
    Some(value)
}

fn decimal_literal(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut index = 0;
    if bytes
        .first()
        .is_some_and(|byte| matches!(byte, b'+' | b'-'))
    {
        index = 1;
    }
    if text[index..].eq("Infinity") {
        return text.parse().ok();
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
        index += 1;
        if bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            index += 1;
        }
        let exponent = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent {
            return None;
        }
    }
    if index != bytes.len() {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{js_tonumber, normalize_relative_path, posix_extname, sync_segments};

    #[test]
    fn path_limits_count_characters() {
        let sync_path = "Ä".repeat(600);
        assert_eq!(sync_path.len(), 1200);
        assert!(sync_segments(&sync_path).is_ok());
        assert!(sync_segments(&"Ä".repeat(1025)).is_err());

        let note_path = "Ä".repeat(3000);
        assert!(note_path.len() > 4096);
        assert!(normalize_relative_path(&note_path, false, false).is_ok());
        assert!(normalize_relative_path(&"Ä".repeat(4097), false, false).is_err());
    }

    #[test]
    fn a_repeated_dot_slash_is_rejected() {
        assert_eq!(
            normalize_relative_path("./Seite.md", false, false).unwrap(),
            "Seite.md"
        );
        assert_eq!(
            normalize_relative_path("./Seite.md/", false, false).unwrap(),
            "Seite.md"
        );
        assert!(normalize_relative_path("././Seite.md", false, false).is_err());
        assert!(normalize_relative_path("Seite.md//", false, false).is_err());
        assert_eq!(normalize_relative_path("./", true, false).unwrap(), "");
        assert!(normalize_relative_path("././", true, false).is_err());
        assert!(normalize_relative_path("C:/Notiz.md", false, false).is_err());
        assert!(normalize_relative_path("c:/Notiz.md", false, false).is_err());
        assert!(normalize_relative_path("C:/", false, false).is_err());
        assert!(normalize_relative_path("C:Notiz.md", false, false).is_ok());
        assert!(normalize_relative_path("Mathe/C:/Notiz.md", false, false).is_ok());
    }

    #[test]
    fn a_dotfile_with_one_dot_has_no_extension() {
        assert_eq!(posix_extname(".md"), "");
        assert_eq!(posix_extname("foo/.md"), "");
        assert_eq!(posix_extname(".."), "");
        assert_eq!(posix_extname(".hidden.md"), ".md");
        assert_eq!(posix_extname("Note.MD"), ".MD");
        assert_eq!(posix_extname("a."), ".");
        assert_eq!(posix_extname("..."), ".");
    }

    #[test]
    fn a_page_size_string_uses_javascript_number() {
        assert_eq!(js_tonumber("800"), Some(800.0));
        assert_eq!(js_tonumber("800.4"), Some(800.4));
        assert_eq!(js_tonumber("800.5"), Some(800.5));
        assert_eq!(js_tonumber(" 800 "), Some(800.0));
        assert_eq!(js_tonumber("\u{FEFF}800"), Some(800.0));
        assert_eq!(js_tonumber("8e2"), Some(800.0));
        assert_eq!(js_tonumber("8E+2"), Some(800.0));
        assert_eq!(js_tonumber("+800"), Some(800.0));
        assert_eq!(js_tonumber("0x320"), Some(800.0));
        assert_eq!(js_tonumber("0X10"), Some(16.0));
        assert_eq!(js_tonumber("0b1010"), Some(10.0));
        assert_eq!(js_tonumber("0o10"), Some(8.0));
        assert_eq!(js_tonumber("0800"), Some(800.0));
        assert_eq!(js_tonumber("1."), Some(1.0));
        assert_eq!(js_tonumber(" .5"), Some(0.5));
        assert_eq!(js_tonumber(""), Some(0.0));
        assert_eq!(js_tonumber("  0x320  "), Some(800.0));
        assert!(js_tonumber("800px").is_none());
        assert!(js_tonumber("1.2.3").is_none());
        assert!(js_tonumber("1e").is_none());
        assert!(js_tonumber(".").is_none());
        assert!(js_tonumber("+0x10").is_none());
        assert!(js_tonumber("0x").is_none());
        assert!(js_tonumber("0b").is_none());
        assert!(js_tonumber("1_000").is_none());
        assert!(js_tonumber("true").is_none());
        assert!(js_tonumber("\u{0085}800").is_none());
        assert!(js_tonumber("800\u{0085}").is_none());
        assert_eq!(js_tonumber("Infinity"), Some(f64::INFINITY));
        assert_eq!(js_tonumber("+Infinity"), Some(f64::INFINITY));
        assert_eq!(js_tonumber("-Infinity"), Some(f64::NEG_INFINITY));
    }
}
