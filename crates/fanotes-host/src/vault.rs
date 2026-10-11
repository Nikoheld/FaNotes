//! Vault path rules from `normalizeRelativePath` and `isInsideRoot` in `electron/main.cjs`.

use std::fs;
use std::path::{Component, Path, PathBuf};

const INTERNAL: &[&str] = &[".fanotes", ".lernwerk"];

pub fn normalize_relative_path(
    value: &str,
    allow_root: bool,
    allow_internal: bool,
) -> Result<String, String> {
    if value.len() > 4096 || value.contains('\0') {
        return Err("Ungültiger Vault-Pfad.".to_owned());
    }
    if value.contains('\\') || Path::new(value).is_absolute() || value.starts_with('/') {
        return Err("Nur relative Vault-Pfade sind erlaubt.".to_owned());
    }
    let trimmed = value.trim_start_matches("./").trim_end_matches('/');
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
    if raw.is_empty() || raw.len() > 1024 || raw.contains('\0') {
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
