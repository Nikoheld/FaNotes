//! Extra directories that appear inside one FaNotes folder.
//!
//! The folder itself stays in the vault so it can be renamed and coloured.
//! Its files are read from the listed directories, first path first. New notes
//! are created in that first path.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::vault;

pub const MAX_PATHS: usize = 8;
pub const MAX_FOLDERS: usize = 200;

#[derive(Clone, Debug, Default)]
pub struct FolderLocations {
    folders: BTreeMap<String, Vec<PathBuf>>,
}

impl FolderLocations {
    pub fn load(app_data: &Path, vault: &Path) -> Self {
        let mut loaded = Self::default();
        let path = app_data.join("folder-locations.json");
        let Ok(text) = fs::read_to_string(&path) else {
            return loaded;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            return loaded;
        };
        let Some(vaults) = parsed.get("vaults").and_then(Value::as_object) else {
            return loaded;
        };
        let key = vault.to_string_lossy();
        let Some(map) = vaults.get(key.as_ref()).and_then(Value::as_object) else {
            return loaded;
        };
        for (folder, paths) in map {
            let Ok(normalized) = vault::normalize_relative_path(folder, false, false) else {
                continue;
            };
            let Some(list) = paths.as_array() else {
                continue;
            };
            let roots: Vec<PathBuf> = list
                .iter()
                .filter_map(Value::as_str)
                .take(MAX_PATHS)
                .map(PathBuf::from)
                .collect();
            if !roots.is_empty() {
                loaded.folders.insert(normalized, roots);
            }
        }
        loaded
    }

    pub fn save(&self, app_data: &Path, vault: &Path) -> Result<(), String> {
        let path = app_data.join("folder-locations.json");
        let mut vaults = BTreeMap::new();
        if path.is_file() {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    if let Some(existing) = parsed.get("vaults").and_then(Value::as_object) {
                        for (key, value) in existing {
                            vaults.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
        }
        let key = vault.to_string_lossy().into_owned();
        if self.folders.is_empty() {
            vaults.remove(&key);
        } else {
            let mut map = serde_json::Map::new();
            for (folder, paths) in &self.folders {
                map.insert(
                    folder.clone(),
                    Value::Array(
                        paths
                            .iter()
                            .map(|path| Value::String(path.to_string_lossy().into_owned()))
                            .collect(),
                    ),
                );
            }
            vaults.insert(key, Value::Object(map));
        }
        let snapshot = json!({ "version": 1, "vaults": vaults });
        let text = format!("{snapshot:#}\n");
        if text.len() > 512 * 1024 {
            return Err("Zu viele Ordnerpfade.".to_owned());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temporary, text.as_bytes()).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &path).map_err(|error| vault::node_rename_error(&temporary, &path, &error))?;
        Ok(())
    }

    pub fn paths(&self, logical: &str) -> Option<&[PathBuf]> {
        self.folders.get(logical).map(Vec::as_slice)
    }

    pub fn len(&self) -> usize {
        self.folders.len()
    }

    fn longest<'a>(&'a self, logical: &str) -> Option<(&'a str, &'a [PathBuf])> {
        let mut best: Option<(&str, &[PathBuf])> = None;
        for (folder, paths) in &self.folders {
            if logical == folder || logical.starts_with(&format!("{folder}/")) {
                if best.map(|(current, _)| folder.len() > current.len()).unwrap_or(true) {
                    best = Some((folder.as_str(), paths.as_slice()));
                }
            }
        }
        best
    }

    /// Directories whose entries belong in `logical_folder`.
    pub fn content_roots(&self, vault: &Path, logical_folder: &str) -> (bool, Vec<PathBuf>) {
        let Some((folder, paths)) = self.longest(logical_folder) else {
            let mut primary = vault.to_path_buf();
            for segment in logical_folder.split('/').filter(|segment| !segment.is_empty()) {
                primary.push(segment);
            }
            return (false, vec![primary]);
        };
        let remainder = if logical_folder == folder {
            ""
        } else {
            &logical_folder[folder.len() + 1..]
        };
        let roots = paths
            .iter()
            .map(|root| {
                let mut path = root.clone();
                for segment in remainder.split('/').filter(|segment| !segment.is_empty()) {
                    path.push(segment);
                }
                path
            })
            .collect();
        (true, roots)
    }

    pub fn resolve_note(
        &self,
        vault: &Path,
        relative: &str,
        allow_missing: bool,
    ) -> Result<PathBuf, String> {
        if self.longest(relative).is_none() {
            return if allow_missing {
                vault::resolve_note_file(vault, relative)
            } else {
                vault::resolve_present_note_file(vault, relative)
            };
        }
        self.resolve_child(vault, relative, allow_missing, Some(true))
    }

    pub fn resolve_existing(&self, vault: &Path, relative: &str) -> Result<PathBuf, String> {
        if self.paths(relative).is_some() || self.longest(relative).is_none() {
            return vault::resolve_existing_entry(vault, relative);
        }
        self.resolve_child(vault, relative, false, None)
    }

    pub fn resolve_directory(
        &self,
        vault: &Path,
        relative: &str,
        as_content: bool,
    ) -> Result<PathBuf, String> {
        if relative.is_empty() {
            return Ok(vault.to_path_buf());
        }
        if as_content {
            if let Some(paths) = self.paths(relative) {
                return require_directory(&paths[0]);
            }
        }
        if self.longest(relative).is_some() && self.paths(relative).is_none() {
            return self.resolve_child(vault, relative, false, Some(false));
        }
        vault::resolve_existing_entry(vault, relative)
    }

    fn resolve_child(
        &self,
        vault: &Path,
        relative: &str,
        allow_missing: bool,
        file: Option<bool>,
    ) -> Result<PathBuf, String> {
        let Some((folder, paths)) = self.longest(relative) else {
            return Err("Der verknüpfte Ordner wurde nicht gefunden.".to_owned());
        };
        let remainder = if relative == folder {
            String::new()
        } else {
            relative[folder.len() + 1..].to_owned()
        };
        if remainder.is_empty() {
            return require_directory(&paths[0]);
        }
        for root in paths {
            let mut candidate = root.clone();
            for segment in remainder.split('/') {
                candidate.push(segment);
            }
            match fs::symlink_metadata(&candidate) {
                Ok(info) if info.file_type().is_symlink() => {
                    return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
                }
                Ok(info) if file == Some(true) && !info.is_file() => continue,
                Ok(info) if file == Some(false) && !info.is_dir() => continue,
                Ok(info) if file.is_none() && !info.is_file() && !info.is_dir() => continue,
                Ok(_) => {
                    if let (Ok(anchor), Ok(real)) = (fs::canonicalize(root), fs::canonicalize(&candidate)) {
                        if !vault::is_inside_root(&anchor, &real) {
                            return Err("Der Pfad verlässt den verknüpften Ordner über einen Link.".to_owned());
                        }
                    }
                    return Ok(candidate);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(vault::node_lstat_error(&candidate, &error)),
            }
        }
        let mut missing = paths[0].clone();
        for segment in remainder.split('/') {
            missing.push(segment);
        }
        if allow_missing {
            if let Ok(anchor) = fs::canonicalize(&paths[0]) {
                let parent_inside = missing
                .parent()
                .is_some_and(|parent| vault::is_inside_root(&anchor, parent));
            if !vault::is_inside_root(&anchor, &missing) && !parent_inside {
                return Err("Der Pfad liegt außerhalb des verknüpften Ordners.".to_owned());
            }
            }
            let _ = vault;
            return Ok(missing);
        }
        Err(vault::node_lstat_error(
            &missing,
            &std::io::Error::new(std::io::ErrorKind::NotFound, "no such file or directory"),
        ))
    }

    pub fn allows(&self, vault: &Path, path: &Path) -> bool {
        if vault::is_inside_root(vault, path) {
            return true;
        }
        for roots in self.folders.values() {
            for root in roots {
                if vault::is_inside_root(root, path) {
                    return true;
                }
            }
        }
        false
    }

    pub fn identity(&self, vault: &Path, path: &Path) -> Option<String> {
        if vault::is_inside_root(vault, path) {
            return Some(vault::relative_posix(vault, path));
        }
        for (folder, roots) in &self.folders {
            for root in roots {
                if path == root {
                    return Some(folder.clone());
                }
                if vault::is_inside_root(root, path) {
                    let rest = vault::relative_posix(root, path);
                    return Some(if rest.is_empty() {
                        folder.clone()
                    } else {
                        format!("{folder}/{rest}")
                    });
                }
            }
        }
        None
    }

    pub fn retarget(&mut self, old: &str, new: &str) {
        let keys: Vec<String> = self.folders.keys().cloned().collect();
        for key in keys {
            if key != old && !key.starts_with(&format!("{old}/")) {
                continue;
            }
            let Some(paths) = self.folders.remove(&key) else {
                continue;
            };
            let renamed = if key == old {
                new.to_owned()
            } else {
                format!("{new}{}", &key[old.len()..])
            };
            self.folders.insert(renamed, paths);
        }
    }

    pub fn forget(&mut self, relative: &str) {
        self.folders
            .retain(|key, _| key != relative && !key.starts_with(&format!("{relative}/")));
    }

    pub fn replace(&mut self, logical: &str, paths: Vec<PathBuf>) {
        if paths.is_empty() {
            self.folders.remove(logical);
        } else {
            self.folders.insert(logical.to_owned(), paths);
        }
    }
}

fn require_directory(path: &Path) -> Result<PathBuf, String> {
    let info = fs::symlink_metadata(path).map_err(|_| "Der verknüpfte Ordner wurde nicht gefunden.".to_owned())?;
    if info.file_type().is_symlink() || !info.is_dir() {
        return Err("Der verknüpfte Ordner wurde nicht gefunden.".to_owned());
    }
    Ok(path.to_path_buf())
}

pub fn validate_location(
    vault: &Path,
    candidate: &str,
    accepted: &[PathBuf],
    existing: &FolderLocations,
    logical: &str,
) -> Result<PathBuf, String> {
    if candidate.contains('\0') || candidate.len() > 4096 || candidate.trim().is_empty() {
        return Err("Die Ordnerpfade sind ungültig.".to_owned());
    }
    let path = Path::new(candidate);
    if !path.is_absolute() {
        return Err("Ein Ordnerpfad muss ein absoluter Ordner sein.".to_owned());
    }
    let info = fs::symlink_metadata(path).map_err(|_| "Der Ordnerpfad wurde nicht gefunden.".to_owned())?;
    if info.file_type().is_symlink() {
        return Err("Symbolische Links sind als Ordnerpfad nicht erlaubt.".to_owned());
    }
    if !info.is_dir() {
        return Err("Der Ordnerpfad ist kein Ordner.".to_owned());
    }
    let real = fs::canonicalize(path).map_err(|_| "Der Ordnerpfad wurde nicht gefunden.".to_owned())?;
    let vault_real = fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    if real == vault_real || vault::is_inside_root(&vault_real, &real) {
        return Err("Der Ordnerpfad darf nicht im Vault liegen.".to_owned());
    }
    if vault::is_inside_root(&real, &vault_real) {
        return Err("Der Ordnerpfad darf den Vault nicht enthalten.".to_owned());
    }
    for previous in accepted {
        if previous == &real
            || vault::is_inside_root(previous, &real)
            || vault::is_inside_root(&real, previous)
        {
            return Err("Die Ordnerpfade dürfen sich nicht überlappen.".to_owned());
        }
    }
    for (folder, paths) in &existing.folders {
        if folder == logical {
            continue;
        }
        for other in paths {
            let other_real = fs::canonicalize(other).unwrap_or_else(|_| other.clone());
            if other_real == real
                || vault::is_inside_root(&other_real, &real)
                || vault::is_inside_root(&real, &other_real)
            {
                return Err(
                    "Dieser Ordner ist bereits einem anderen FaNotes-Ordner zugeordnet.".to_owned(),
                );
            }
        }
    }
    Ok(real)
}

pub fn move_contents(from: &Path, to: &Path) -> Result<(u64, Vec<String>), String> {
    let from_info = match fs::symlink_metadata(from) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, Vec::new())),
        Err(error) => return Err(error.to_string()),
    };
    if from_info.file_type().is_symlink() || !from_info.is_dir() {
        return Ok((0, Vec::new()));
    }
    fs::create_dir_all(to).map_err(|error| vault::node_mkdir_error(to, &error))?;
    let from_real = fs::canonicalize(from).map_err(|error| error.to_string())?;
    let to_real = fs::canonicalize(to).map_err(|error| error.to_string())?;
    if from_real == to_real {
        return Ok((0, Vec::new()));
    }
    if vault::is_inside_root(&from_real, &to_real) {
        return Err("Der neue Ordner liegt im bisherigen Ordner.".to_owned());
    }
    let mut moved = 0_u64;
    let mut conflicts = Vec::new();
    walk_move(&from_real, &from_real, &to_real, 0, &mut moved, &mut conflicts)?;
    Ok((moved, conflicts))
}

fn walk_move(
    origin: &Path,
    source: &Path,
    destination: &Path,
    depth: usize,
    moved: &mut u64,
    conflicts: &mut Vec<String>,
) -> Result<(), String> {
    if depth > 80 {
        return Ok(());
    }
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let src = entry.path();
        let info = match fs::symlink_metadata(&src) {
            Ok(info) => info,
            Err(_) => continue,
        };
        if info.file_type().is_symlink() {
            continue;
        }
        let dst = destination.join(name);
        let relative = vault::relative_posix(origin, &src);
        if info.is_dir() {
            if let Ok(existing) = fs::symlink_metadata(&dst) {
                if existing.file_type().is_symlink() || !existing.is_dir() {
                    conflicts.push(relative);
                    continue;
                }
            }
            fs::create_dir_all(&dst).map_err(|error| vault::node_mkdir_error(&dst, &error))?;
            walk_move(origin, &src, &dst, depth + 1, moved, conflicts)?;
            let _ = fs::remove_dir(&src);
            continue;
        }
        if !info.is_file() {
            continue;
        }
        if fs::symlink_metadata(&dst).is_ok() {
            conflicts.push(relative);
            continue;
        }
        relocate(&src, &dst)?;
        *moved += 1;
    }
    Ok(())
}

fn relocate(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(18) => copy_then_remove(source, destination),
        Err(error) => Err(vault::node_rename_error(source, destination, &error)),
    }
}

fn copy_then_remove(source: &Path, destination: &Path) -> Result<(), String> {
    let info = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if info.is_dir() {
        fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_then_remove(&entry.path(), &destination.join(entry.file_name()))?;
        }
        fs::remove_dir(source).map_err(|error| error.to_string())?;
        return Ok(());
    }
    fs::copy(source, destination).map_err(|error| error.to_string())?;
    fs::remove_file(source).map_err(|error| error.to_string())?;
    Ok(())
}
