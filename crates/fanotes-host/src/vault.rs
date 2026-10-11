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
