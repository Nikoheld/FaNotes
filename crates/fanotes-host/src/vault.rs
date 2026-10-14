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
    if !allow_internal && is_protected_internal(segments[0]) {
        return Err("Interne FaNotes-Dateien sind geschützt.".to_owned());
    }
    Ok(segments.join("/"))
}

/// `toLocaleLowerCase('en-US')` for a name compared with an ASCII constant.
///
/// The Kelvin sign U+212A becomes `k`. The long s stays a long s.
pub(crate) fn locale_lower_en_us(value: &str) -> String {
    let mut lowered = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\u{212A}' => lowered.push('k'),
            'A'..='Z' => lowered.push(character.to_ascii_lowercase()),
            other => lowered.push(other),
        }
    }
    lowered
}

fn is_protected_internal(segment: &str) -> bool {
    let lowered = locale_lower_en_us(segment);
    INTERNAL.iter().any(|name| lowered == *name)
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
///
/// A missing final file is allowed. A `.famd` save uses that to create the
/// companion after `realpath` of its parent.
pub fn resolve_note_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_note_path(root, relative, true)
}

/// `resolveVaultPath` with `allowMissing: false`. The first missing segment
/// is Node's `lstat` error, not a walk that continues to the final name.
pub fn resolve_present_note_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_note_path(root, relative, false)
}

fn resolve_note_path(root: &Path, relative: &str, allow_missing: bool) -> Result<PathBuf, String> {
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
                // Desktop `resolveVaultPath` with `expected: 'file'` reports this
                // before the later write check can run.
                return Err("Die gewählte Datei ist keine reguläre Datei.".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                missing = true;
            }
            Err(error) => return Err(node_lstat_error(&cursor, &error)),
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
    resolve_existing(root, relative, false)
}

/// Asset preview may open files under `.fanotes`, including worksheet pages.
pub fn resolve_asset_entry(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_existing(root, relative, true)
}

fn resolve_existing(root: &Path, relative: &str, allow_internal: bool) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(relative, false, allow_internal)?;
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
            // Desktop `resolveVaultPath` throws the `lstat` error. A missing
            // path is ENOENT, and a name past the filesystem limit is
            // ENAMETOOLONG.
            Err(error) => return Err(node_lstat_error(&cursor, &error)),
            Ok(_) => {}
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

/// `path.relative(root, path).split(path.sep).join('/')`.
///
/// On Linux a backslash is part of the file name, so `My\Notes.md` stays one
/// segment. On Windows the separator is the component boundary.
pub(crate) fn relative_posix(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let mut parts = Vec::new();
    for component in relative.components() {
        if let Component::Normal(part) = component {
            parts.push(part.to_string_lossy().into_owned());
        }
    }
    parts.join("/")
}

/// `path.posix.extname`.
///
/// Trailing slashes are ignored. `.md` and `..` have no extension. `.hidden.md` is `.md`.
pub(crate) fn posix_extname(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return "";
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    if base == "." || base == ".." {
        return "";
    }
    match base.rfind('.') {
        Some(index) if index > 0 => &base[index..],
        _ => "",
    }
}

/// `path.extname(path).toLocaleLowerCase('en-US')`, including the leading dot.
///
/// The Kelvin sign in `.markdown` becomes `k`. The long s stays a long s.
pub(crate) fn posix_extname_en_us(path: &str) -> String {
    locale_lower_en_us(posix_extname(path))
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
    let nfc: String = name.nfc().collect();
    // Desktop sibling names use `normalize('NFC').toLocaleLowerCase('de-DE')`.
    // V8 leaves these newer case pairs unchanged, and they break a Greek word
    // the way an uncased character does, so a following sigma is not final.
    if !nfc.chars().any(js_keeps_case) {
        return nfc.to_lowercase();
    }
    let mut out = String::with_capacity(nfc.len());
    let mut segment = String::new();
    for character in nfc.chars() {
        if js_keeps_case(character) {
            if !segment.is_empty() {
                out.push_str(&segment.to_lowercase());
                segment.clear();
            }
            out.push(character);
        } else {
            segment.push(character);
        }
    }
    if !segment.is_empty() {
        out.push_str(&segment.to_lowercase());
    }
    out
}

/// Case pairs in Unicode 16 that Node 22's `toLocaleLowerCase('de-DE')` does not fold.
fn js_keeps_case(character: char) -> bool {
    matches!(
        character,
        '\u{A7CE}' | '\u{A7D2}' | '\u{A7D4}' | '\u{16EA0}'..='\u{16EB8}'
    )
}

/// Node `fs.lstat` failure text, including the path that could not be stated.
pub(crate) fn node_lstat_error(path: &Path, error: &std::io::Error) -> String {
    node_fs_error(path, error, "lstat")
}

/// Node `fs.realpath` failure text. A missing parent uses this syscall.
pub(crate) fn node_realpath_error(path: &Path, error: &std::io::Error) -> String {
    node_fs_error(path, error, "realpath")
}

pub(crate) fn node_unlink_error(path: &Path, error: &std::io::Error) -> String {
    node_fs_error(path, error, "unlink")
}

fn node_fs_error(path: &Path, error: &std::io::Error, syscall: &str) -> String {
    #[cfg(unix)]
    let (name, detail) = match error.raw_os_error() {
        Some(libc::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(libc::EACCES) => ("EACCES", "permission denied"),
        Some(libc::EPERM) => ("EPERM", "operation not permitted"),
        Some(libc::EIO) => ("EIO", "i/o error"),
        Some(libc::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(libc::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(libc::ENAMETOOLONG) => ("ENAMETOOLONG", "name too long"),
        _ => ("EACCES", "permission denied"),
    };
    #[cfg(not(unix))]
    let (name, detail) = {
        let _ = error;
        ("ENOENT", "no such file or directory")
    };
    format!("{name}: {detail}, {syscall} '{}'", path.display())
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
            // Desktop `resolveInside` rethrows the `lstat` error. A missing
            // read is ENOENT, and a name past the filesystem limit is
            // ENAMETOOLONG.
            Err(error) => return Err(node_lstat_error(&cursor, &error)),
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
            return Err("Der interne FaNotes-Ordner ist unsicher.".to_owned());
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

/// `Number(string)`, shared with note links in `fanotes-famd`.
pub(crate) fn js_tonumber(value: &str) -> Option<f64> {
    fanotes_famd::js_tonumber(value)
}

#[cfg(test)]
mod tests {
    use super::{
        js_tonumber, normalize_relative_path, posix_extname, relative_posix, sync_segments,
    };
    use std::path::Path;

    #[test]
    fn a_name_key_keeps_the_case_pairs_javascript_does_not_fold() {
        assert_ne!(
            super::entry_name_key("\u{A7CE}.md"),
            super::entry_name_key("\u{A7CF}.md")
        );
        assert_ne!(
            super::entry_name_key("\u{16EA0}.md"),
            super::entry_name_key("\u{16EBB}.md")
        );
        assert_eq!(super::entry_name_key("ΑΣ"), "ας");
        assert_eq!(super::entry_name_key("Α\u{A7CE}Σ"), "α\u{A7CE}σ");
        assert_eq!(super::entry_name_key("Α\u{A7CE}.Σ"), "α\u{A7CE}.σ");
        assert_eq!(super::entry_name_key("Mu\u{0308}he"), super::entry_name_key("Mühe"));
    }

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
    fn a_kelvin_sign_is_the_protected_lernwerk_name() {
        let kelvin = format!(".lernwer\u{212A}/Notiz.md");
        assert_eq!(
            normalize_relative_path(&kelvin, false, false).unwrap_err(),
            "Interne FaNotes-Dateien sind geschützt."
        );
        assert_eq!(
            normalize_relative_path(".LERNWERK/Notiz.md", false, false).unwrap_err(),
            "Interne FaNotes-Dateien sind geschützt."
        );
        assert_eq!(
            normalize_relative_path(".fanote\u{017F}/Notiz.md", false, false).unwrap(),
            ".fanote\u{017F}/Notiz.md"
        );
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
        assert_eq!(posix_extname("foo.md/"), ".md");
        assert_eq!(posix_extname("foo.md//"), ".md");
        assert_eq!(posix_extname("foo.md/."), "");
        assert_eq!(posix_extname(".md/"), "");
        #[cfg(unix)]
        {
            let root = Path::new("/vault");
            assert_eq!(
                relative_posix(root, &root.join("My\\Notes.md")),
                "My\\Notes.md"
            );
            assert_eq!(
                relative_posix(root, &root.join("Ordner").join("My\\Notes.md")),
                "Ordner/My\\Notes.md"
            );
            assert_eq!(relative_posix(root, &root.join("Notiz.md")), "Notiz.md");
        }
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
