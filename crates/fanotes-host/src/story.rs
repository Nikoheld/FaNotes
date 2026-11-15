//! Writing-mode projects: `Name.story/` folders with JSON and markdown files
//! inside (`fanotes-story-v1`, `fanotes-story-scene-v1`).
//!
//! Mirrors the `story-read`, `story-write`, `story-list` and `story-create`
//! handlers and the `.story` tree entries of `electron/main.cjs` on
//! `feature/writing-mode`. Those channels are not in `preload.cjs` on this
//! branch, so nothing here is registered yet: [`dispatch`] is the one call the
//! channel switch needs once the writing mode merges, and [`is_story_folder`] /
//! [`tree_entry`] are what the tree readers need.
//!
//! Path arguments are taken as raw IPC values so the vault check runs before
//! the argument checks, as `ensureBootstrap` does in the desktop handlers.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::{notes, vault, Host};

/// `MAX_STORY_FILE_BYTES`.
pub(crate) const MAX_STORY_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// `storyList` stops below four folder levels and once 20000 names are out.
const MAX_LIST_DEPTH: usize = 4;
const MAX_LIST_ENTRIES: usize = 20_000;
const DEFAULT_STORY_NAME: &str = "Geschichte.story";

const NOT_A_STORY_FILE: &str =
    "Nur Dateien in einem .story-Ordner können so gelesen oder geschrieben werden.";
const INVALID_CONTENT: &str = "Der Inhalt ist ungültig oder zu gross.";
const NOT_A_STORY_FOLDER: &str = "Kein .story-Ordner.";
const NAME_NOT_A_STORY: &str = "Ein Geschichten-Ordner endet auf .story.";
const SYMLINK: &str = "Symbolische Links sind innerhalb des Vaults nicht erlaubt.";

/// `/\.story$/iu`.
fn story_folder_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)\.story$").expect("story folder pattern"))
}

/// `STORY_FILE`. JavaScript `.` with the `u` flag stops at line terminators.
fn story_file_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)^([^\n\r\u{2028}\u{2029}]+\.story)/((?:[A-Za-z0-9_-]{1,64}/){0,3}[A-Za-z0-9_.-]{1,96}\.(?:json|md))$",
        )
        .expect("story file pattern")
    })
}

/// The files `storyList` reports: `/\.(?:json|md)$/iu`.
fn story_list_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)\.(?:json|md)$").expect("story list pattern"))
}

/// A folder the tree shows as one writing-mode document.
pub(crate) fn is_story_folder(name: &str) -> bool {
    story_folder_pattern().is_match(name)
}

/// The tree entry for a `Name.story/` folder.
///
/// The full tree (`stats`) adds `modifiedAt` from the folder's `lstat`; the
/// fast tree has only the four fields. A story folder never has `size`,
/// `children` or `color`.
pub(crate) fn tree_entry(name: &str, relative: &str, meta: &fs::Metadata, stats: bool) -> Value {
    let mut entry = json!({
        "name": name,
        "relativePath": relative,
        "kind": "file",
        "extension": "story",
    });
    if stats {
        if let Ok(modified) = meta.modified() {
            entry["modifiedAt"] = Value::String(notes::iso_from_system_time(modified));
        }
    }
    entry
}

/// `fanotes:story-read/-write/-list/-create`. `None` for any other channel.
pub(crate) fn dispatch(host: &mut Host, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |index: usize| args.get(index).unwrap_or(&Value::Null);
    let host: &Host = host;
    Some(match channel {
        "fanotes:story-read" => read(host, arg(0)),
        "fanotes:story-write" => write(host, arg(0), arg(1)),
        "fanotes:story-list" => list(host, arg(0)),
        "fanotes:story-create" => create(host, arg(0), arg(1)),
        _ => return None,
    })
}

/// `storyRead(relativePath)`: the file text, or `null` when it is missing.
pub(crate) fn read(host: &Host, relative: &Value) -> Result<Value, String> {
    let root = host.require_vault()?.to_path_buf();
    let (logical, _) = story_file(relative)?;
    let target = match resolve(host, &root, &logical, false, Expected::File, false) {
        Ok(target) => target,
        Err(Unresolved::Missing(_)) => return Ok(Value::Null),
        Err(Unresolved::Failed(message)) => return Err(message),
    };
    let bytes = notes::read_nofollow_limited(&target, MAX_STORY_FILE_BYTES)?;
    Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `storyWrite(relativePath, content)`: creates missing folders inside the
/// story and replaces the file atomically. Returns `null`.
pub(crate) fn write(host: &Host, relative: &Value, content: &Value) -> Result<Value, String> {
    let root = host.require_vault()?.to_path_buf();
    let (logical, story_root) = story_file(relative)?;
    let content = content
        .as_str()
        .filter(|text| text.len() as u64 <= MAX_STORY_FILE_BYTES)
        .ok_or_else(|| INVALID_CONTENT.to_owned())?;
    if logical.to_lowercase().ends_with(".json") {
        check_json(content)?;
    }
    resolve(host, &root, &story_root, false, Expected::Directory, false).map_err(Unresolved::message)?;
    let target = resolve(host, &root, &logical, true, Expected::Any, false).map_err(Unresolved::message)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| vault::node_mkdir_error(parent, &error))?;
    }
    // The folders just created are checked again: no link may lead out of the vault.
    resolve(host, &root, &logical, true, Expected::Any, false).map_err(Unresolved::message)?;
    notes::atomic_write(&target, content.as_bytes(), 0o600)?;
    Ok(Value::Null)
}

/// `storyList(storyPath)`: `.json` and `.md` files below the story, relative
/// to it, in `readdir` order. Dot files and symlinks are left out.
pub(crate) fn list(host: &Host, story_path: &Value) -> Result<Value, String> {
    let root = host.require_vault()?.to_path_buf();
    let logical = normalize(story_path, false)?;
    if !is_story_folder(&logical) {
        return Err(NOT_A_STORY_FOLDER.to_owned());
    }
    let target = resolve(host, &root, &logical, false, Expected::Directory, false).map_err(Unresolved::message)?;
    let mut out = Vec::new();
    walk(&target, "", 0, &mut out)?;
    Ok(json!(out))
}

/// `storyCreate(parentPath, name)`: a new empty `Name.story/` folder. Returns
/// its logical path.
pub(crate) fn create(host: &Host, parent: &Value, name: &Value) -> Result<Value, String> {
    let root = host.require_vault()?.to_path_buf();
    let parent = match parent.as_str() {
        Some(text) if !text.is_empty() => vault::normalize_relative_path(text, true, false)?,
        _ => String::new(),
    };
    let name = crate::safe_entry_name_or(name.as_str().unwrap_or(""), DEFAULT_STORY_NAME)?;
    if !is_story_folder(&name) {
        return Err(NAME_NOT_A_STORY.to_owned());
    }
    let parent_target =
        resolve(host, &root, &parent, false, Expected::Directory, true).map_err(Unresolved::message)?;
    let candidate = crate::unique_sibling_name(&parent_target, &name, None, None)?;
    let path = parent_target.join(&candidate);
    fs::create_dir(&path).map_err(|error| vault::node_mkdir_error(&path, &error))?;
    Ok(Value::String(if parent.is_empty() {
        candidate
    } else {
        format!("{parent}/{candidate}")
    }))
}

fn normalize(value: &Value, allow_root: bool) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or_else(|| "Ungültiger Vault-Pfad.".to_owned())?;
    vault::normalize_relative_path(text, allow_root, false)
}

/// `storyFile`: the normalized path and the `.story` folder it belongs to.
fn story_file(relative: &Value) -> Result<(String, String), String> {
    let logical = normalize(relative, false)?;
    let story_root = story_file_pattern()
        .captures(&logical)
        .and_then(|captures| captures.get(1))
        .map(|story| story.as_str().to_owned())
        .ok_or_else(|| NOT_A_STORY_FILE.to_owned())?;
    Ok((logical, story_root))
}

/// `JSON.parse(content)` as a check only. The grammar is the same; the error
/// text follows the older V8 wording rather than the exact Electron string.
fn check_json(content: &str) -> Result<(), String> {
    let Err(error) = serde_json::from_str::<serde::de::IgnoredAny>(content) else {
        return Ok(());
    };
    if error.classify() == serde_json::error::Category::Eof {
        return Err("Unexpected end of JSON input".to_owned());
    }
    let mut offset = 0;
    for (index, line) in content.split_inclusive('\n').enumerate() {
        if index + 1 == error.line() {
            offset += error.column().saturating_sub(1).min(line.len());
            break;
        }
        offset += line.len();
    }
    while offset > 0 && !content.is_char_boundary(offset) {
        offset -= 1;
    }
    let position = vault::utf16_len(&content[..offset]);
    Err(match content[offset..].chars().next() {
        Some(character) => format!("Unexpected token {character} in JSON at position {position}"),
        None => "Unexpected end of JSON input".to_owned(),
    })
}

fn walk(directory: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) -> Result<(), String> {
    if depth > MAX_LIST_DEPTH || out.len() > MAX_LIST_ENTRIES {
        return Ok(());
    }
    let mut entries = Vec::new();
    for entry in crate::read_sibling_dir(directory)? {
        // Node reads the whole directory before the loop; a failed read fails the list.
        entries.push(entry.map_err(|error| crate::scandir_error(directory, &error))?);
    }
    // libuv `scandir` sorts names with `strcmp`.
    entries.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_symlink() || name.starts_with('.') {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if file_type.is_dir() {
            walk(&entry.path(), &relative, depth + 1, out)?;
        } else if file_type.is_file() && story_list_pattern().is_match(&name) {
            out.push(relative);
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Expected {
    Any,
    File,
    Directory,
}

/// A failed `resolveVaultPath`. `Missing` carries the `ENOENT` text, which
/// `storyRead` turns into `null`.
enum Unresolved {
    Missing(String),
    Failed(String),
}

impl Unresolved {
    fn message(self) -> String {
        match self {
            Unresolved::Missing(message) | Unresolved::Failed(message) => message,
        }
    }
}

fn enoent() -> std::io::Error {
    #[cfg(unix)]
    {
        std::io::Error::from_raw_os_error(libc::ENOENT)
    }
    #[cfg(not(unix))]
    {
        std::io::Error::from(std::io::ErrorKind::NotFound)
    }
}

/// `resolveVaultPath(logical, { allowMissing, expected, asContent })` for a
/// normalized logical path, including folders that show other paths.
fn resolve(
    host: &Host,
    root: &Path,
    logical: &str,
    allow_missing: bool,
    expected: Expected,
    as_content: bool,
) -> Result<PathBuf, Unresolved> {
    if !logical.is_empty() {
        // `resolveLocated` leaves an exactly linked folder to the vault walk
        // unless the caller wants its content or a file.
        let exact = host.folder_locations.paths(logical).is_some();
        if !(exact && !as_content && expected != Expected::File) {
            if let Some((base, bases)) = host.folder_locations.longest(logical) {
                return resolve_located(logical, base, bases, allow_missing, expected);
            }
        }
    }
    resolve_in_vault(root, logical, allow_missing, expected)
}

fn resolve_in_vault(
    root: &Path,
    logical: &str,
    allow_missing: bool,
    expected: Expected,
) -> Result<PathBuf, Unresolved> {
    let segments: Vec<&str> = if logical.is_empty() {
        Vec::new()
    } else {
        logical.split('/').collect()
    };
    let mut target = root.to_path_buf();
    for segment in &segments {
        target.push(segment);
    }
    if !vault::is_inside_root(root, &target) {
        return Err(Unresolved::Failed("Der Pfad liegt außerhalb des Vaults.".to_owned()));
    }
    let mut cursor = root.to_path_buf();
    let mut missing = false;
    for (index, segment) in segments.iter().enumerate() {
        cursor.push(segment);
        if missing {
            continue;
        }
        let last = index + 1 == segments.len();
        match fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(Unresolved::Failed(SYMLINK.to_owned()));
                }
                if !last && !meta.is_dir() {
                    return Err(Unresolved::Failed("Ein Pfadbestandteil ist kein Ordner.".to_owned()));
                }
                if last && expected == Expected::File && !meta.is_file() {
                    return Err(Unresolved::Failed(
                        "Die gewählte Datei ist keine reguläre Datei.".to_owned(),
                    ));
                }
                if last && expected == Expected::Directory && !meta.is_dir() {
                    return Err(Unresolved::Failed("Der gewählte Pfad ist kein Ordner.".to_owned()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                missing = true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(Unresolved::Missing(vault::node_lstat_error(&cursor, &error)));
            }
            Err(error) => return Err(Unresolved::Failed(vault::node_lstat_error(&cursor, &error))),
        }
    }
    let existing = if missing {
        cursor.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf())
    } else {
        target.clone()
    };
    match fs::canonicalize(&existing) {
        Ok(real) => {
            let real_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            if !vault::is_inside_root(&real_root, &real) {
                return Err(Unresolved::Failed("Der Pfad verlässt den Vault über einen Link.".to_owned()));
            }
        }
        Err(error) if missing && error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(Unresolved::Failed(vault::node_realpath_error(&existing, &error))),
    }
    Ok(target)
}

/// `folderLocations.resolveLocated` for a path below a linked folder.
fn resolve_located(
    logical: &str,
    base: &str,
    bases: &[PathBuf],
    allow_missing: bool,
    expected: Expected,
) -> Result<PathBuf, Unresolved> {
    let unlinked = || Unresolved::Failed("Der verknüpfte Ordner wurde nicht gefunden.".to_owned());
    let primary = bases.first().ok_or_else(unlinked)?;
    let remainder = if logical == base {
        ""
    } else {
        &logical[base.len() + 1..]
    };
    if remainder.is_empty() {
        return match fs::symlink_metadata(primary) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                fs::canonicalize(primary).map_err(|_| unlinked())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                Ok(primary.clone())
            }
            _ => Err(unlinked()),
        };
    }
    let segments: Vec<&str> = remainder.split('/').collect();
    let below = |base: &Path| {
        let mut path = base.to_path_buf();
        for segment in &segments {
            path.push(segment);
        }
        path
    };
    let mut rejected = None;
    for base in bases {
        let candidate = below(base);
        let meta = match fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                rejected = Some(vault::node_lstat_error(&candidate, &error));
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            rejected = Some(SYMLINK.to_owned());
            continue;
        }
        if (expected == Expected::File && !meta.is_file())
            || (expected == Expected::Directory && !meta.is_dir())
        {
            continue;
        }
        let anchor = match fs::canonicalize(base) {
            Ok(anchor) => anchor,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(Unresolved::Failed(vault::node_realpath_error(base, &error))),
        };
        let real = match fs::canonicalize(&candidate) {
            Ok(real) => real,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(Unresolved::Failed(vault::node_realpath_error(&candidate, &error)))
            }
        };
        if !vault::is_inside_root(&anchor, &real) {
            return Err(Unresolved::Failed(
                "Der Pfad verlässt den verknüpften Ordner über einen Link.".to_owned(),
            ));
        }
        return Ok(candidate);
    }
    if !allow_missing {
        if let Some(message) = rejected {
            return Err(Unresolved::Failed(message));
        }
        return Err(Unresolved::Missing(vault::node_lstat_error(&below(primary), &enoent())));
    }
    let anchor = fs::canonicalize(primary)
        .map_err(|error| Unresolved::Failed(vault::node_realpath_error(primary, &error)))?;
    let target = below(primary);
    let parent = target.parent().unwrap_or(&target);
    if !vault::is_inside_root(&anchor, &target)
        && parent != anchor.as_path()
        && !vault::is_inside_root(&anchor, parent)
    {
        return Err(Unresolved::Failed(
            "Der Pfad liegt außerhalb des verknüpften Ordners.".to_owned(),
        ));
    }
    // Stricter than the desktop: `lstat` of a missing target follows a linked
    // folder on the way, so an existing symlink below the linked folder is
    // refused before anything is created through it.
    let mut cursor = primary.clone();
    for segment in &segments {
        cursor.push(segment);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(Unresolved::Failed(SYMLINK.to_owned()));
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        vault: PathBuf,
        host: Host,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn fixture(name: &str) -> Fixture {
        let base = std::env::temp_dir().join(format!(
            "fanotes-story-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("vault")).unwrap();
        let vault = fs::canonicalize(base.join("vault")).unwrap();
        let mut host = Host::open(base.join("app"));
        host.vault = Some(vault.clone());
        Fixture { base, vault, host }
    }

    fn s(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    fn call(fixture: &mut Fixture, channel: &str, args: &[Value]) -> Result<Value, String> {
        dispatch(&mut fixture.host, channel, args).expect("story channel")
    }

    #[test]
    fn a_story_round_trips_through_create_write_list_and_read() {
        let mut f = fixture("round-trip");
        fs::create_dir(f.vault.join("Deutsch")).unwrap();
        let story = call(&mut f, "fanotes:story-create", &[s("Deutsch"), s("Roman.story")]).unwrap();
        assert_eq!(story, s("Deutsch/Roman.story"));
        assert!(f.vault.join("Deutsch/Roman.story").is_dir());

        let manifest = r#"{"format":"fanotes-story-v1","title":"Roman"}"#;
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("Deutsch/Roman.story/story.json"), s(manifest)]).unwrap(),
            Value::Null
        );
        call(
            &mut f,
            "fanotes:story-write",
            &[s("Deutsch/Roman.story/scenes/kapitel-1/szene-1.json"), s("{\"text\":\"Ä\"}")],
        )
        .unwrap();
        call(&mut f, "fanotes:story-write", &[s("Deutsch/Roman.story/notes.md"), s("# Notizen\n")]).unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-read", &[s("Deutsch/Roman.story/story.json")]).unwrap(),
            s(manifest)
        );
        assert_eq!(
            call(&mut f, "fanotes:story-read", &[s("Deutsch/Roman.story/scenes/kapitel-1/szene-1.json")]).unwrap(),
            s("{\"text\":\"Ä\"}")
        );
        // Created folders keep the default mode; the file is private and no temp file is left.
        let scene_dir = f.vault.join("Deutsch/Roman.story/scenes/kapitel-1");
        let names: Vec<String> = fs::read_dir(&scene_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["szene-1.json".to_owned()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(scene_dir.join("szene-1.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        fs::write(f.vault.join("Deutsch/Roman.story/.hidden.json"), "{}").unwrap();
        fs::write(f.vault.join("Deutsch/Roman.story/cover.png"), "x").unwrap();
        fs::write(f.vault.join("Deutsch/Roman.story/UPPER.JSON"), "{}").unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-list", &[s("Deutsch/Roman.story")]).unwrap(),
            json!(["UPPER.JSON", "notes.md", "scenes/kapitel-1/szene-1.json", "story.json"])
        );

        // An overwrite replaces the file.
        call(&mut f, "fanotes:story-write", &[s("Deutsch/Roman.story/story.json"), s("{}")]).unwrap();
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("Deutsch/Roman.story/story.json")]).unwrap(), s("{}"));
    }

    #[test]
    fn a_missing_story_file_reads_as_null() {
        let mut f = fixture("missing");
        fs::create_dir(f.vault.join("A.story")).unwrap();
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("A.story/none.json")]).unwrap(), Value::Null);
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("B.story/none.json")]).unwrap(), Value::Null);
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("A.story/sub/none.md")]).unwrap(), Value::Null);
        // A folder where the file should be is not missing.
        fs::create_dir(f.vault.join("A.story/dir.json")).unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-read", &[s("A.story/dir.json")]).unwrap_err(),
            "Die gewählte Datei ist keine reguläre Datei."
        );
    }

    #[test]
    fn only_files_inside_a_story_folder_are_accepted() {
        let mut f = fixture("pattern");
        fs::create_dir(f.vault.join("A.story")).unwrap();
        for path in [
            "A.story",
            "A.story/",
            "notes/plain.json",
            "A.story/file.txt",
            "A.story/a/b/c/d/deep.json",
            "A.story/bad name.json",
            "A.story/sub dir/x.json",
            "A.storyx/x.json",
        ] {
            assert_eq!(
                call(&mut f, "fanotes:story-read", &[s(path)]).unwrap_err(),
                NOT_A_STORY_FILE,
                "{path}"
            );
            assert_eq!(
                call(&mut f, "fanotes:story-write", &[s(path), s("{}")]).unwrap_err(),
                NOT_A_STORY_FILE,
                "{path}"
            );
        }
        let long_folder = format!("A.story/{}/x.json", "a".repeat(65));
        assert_eq!(call(&mut f, "fanotes:story-read", &[s(&long_folder)]).unwrap_err(), NOT_A_STORY_FILE);
        let long_file = format!("A.story/{}.json", "a".repeat(97));
        assert_eq!(call(&mut f, "fanotes:story-read", &[s(&long_file)]).unwrap_err(), NOT_A_STORY_FILE);
        // Three folder levels, case-insensitive suffixes and nested `.story` names are fine.
        call(&mut f, "fanotes:story-write", &[s("A.story/a/b/c/ok.JSON"), s("[1]")]).unwrap();
        fs::create_dir(f.vault.join("B.STORY")).unwrap();
        call(&mut f, "fanotes:story-write", &[s("B.STORY/x.Md"), s("text")]).unwrap();
        assert!(story_file(&s("A.story/b.story/c.json")).unwrap().1 == "A.story/b.story");
        // The Kelvin sign folds to `k` under the `iu` flags.
        assert!(story_file_pattern().is_match("A.story/\u{212A}.json"));
        assert!(!story_file_pattern().is_match("A\n.story/x.json"));
        assert_eq!(
            call(&mut f, "fanotes:story-list", &[s("A")]).unwrap_err(),
            NOT_A_STORY_FOLDER
        );
    }

    #[test]
    fn traversal_absolute_backslash_and_internal_paths_are_refused() {
        let mut f = fixture("traversal");
        fs::create_dir(f.vault.join("A.story")).unwrap();
        let cases = [
            ("../A.story/x.json", "Pfad-Traversal ist nicht erlaubt."),
            ("A.story/../../x.json", "Pfad-Traversal ist nicht erlaubt."),
            ("/etc/A.story/x.json", "Nur relative Vault-Pfade sind erlaubt."),
            ("A.story\\x.json", "Nur relative Vault-Pfade sind erlaubt."),
            (".fanotes/A.story/x.json", "Interne FaNotes-Dateien sind geschützt."),
            ("", "Der Vault selbst ist für diese Aktion nicht erlaubt."),
        ];
        for (path, message) in cases {
            for channel in ["fanotes:story-read", "fanotes:story-write", "fanotes:story-list"] {
                assert_eq!(call(&mut f, channel, &[s(path), s("{}")]).unwrap_err(), message, "{channel} {path}");
            }
        }
        for channel in ["fanotes:story-read", "fanotes:story-write", "fanotes:story-list"] {
            assert_eq!(call(&mut f, channel, &[json!(7)]).unwrap_err(), "Ungültiger Vault-Pfad.");
            assert_eq!(call(&mut f, channel, &[]).unwrap_err(), "Ungültiger Vault-Pfad.");
        }
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s("../x"), s("A.story")]).unwrap_err(),
            "Pfad-Traversal ist nicht erlaubt."
        );
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s(".fanotes"), s("A.story")]).unwrap_err(),
            "Interne FaNotes-Dateien sind geschützt."
        );
        assert!(!f.base.join("x.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_lead_a_story_out_of_the_vault() {
        use std::os::unix::fs::symlink;
        let mut f = fixture("symlink");
        let outside = f.base.join("outside");
        fs::create_dir_all(outside.join("Out.story")).unwrap();
        fs::write(outside.join("Out.story/secret.json"), "{\"secret\":1}").unwrap();
        symlink(outside.join("Out.story"), f.vault.join("Linked.story")).unwrap();
        fs::create_dir(f.vault.join("A.story")).unwrap();
        symlink(&outside, f.vault.join("A.story/sub")).unwrap();
        symlink(outside.join("Out.story/secret.json"), f.vault.join("A.story/file.json")).unwrap();

        for path in ["Linked.story/secret.json", "A.story/sub/Out.story/x.json", "A.story/file.json"] {
            assert_eq!(call(&mut f, "fanotes:story-read", &[s(path)]).unwrap_err(), SYMLINK, "{path}");
        }
        for path in ["Linked.story/new.json", "A.story/sub/new.json", "A.story/file.json"] {
            assert_eq!(call(&mut f, "fanotes:story-write", &[s(path), s("{}")]).unwrap_err(), SYMLINK, "{path}");
        }
        assert_eq!(call(&mut f, "fanotes:story-list", &[s("Linked.story")]).unwrap_err(), SYMLINK);
        assert_eq!(call(&mut f, "fanotes:story-create", &[s("A.story/sub"), s("B.story")]).unwrap_err(), SYMLINK);
        assert!(!outside.join("Out.story/new.json").exists());
        assert!(!outside.join("new.json").exists());
        assert!(!outside.join("B.story").exists());
        assert_eq!(fs::read_to_string(outside.join("Out.story/secret.json")).unwrap(), "{\"secret\":1}");
        // A symlink inside a listed story is skipped, not followed.
        fs::write(f.vault.join("A.story/real.json"), "{}").unwrap();
        assert_eq!(call(&mut f, "fanotes:story-list", &[s("A.story")]).unwrap(), json!(["real.json"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_story_below_a_linked_folder_stays_inside_that_folder() {
        use std::os::unix::fs::symlink;
        let mut f = fixture("linked");
        let linked = f.base.join("linked");
        fs::create_dir_all(linked.join("Roman.story")).unwrap();
        let outside = f.base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, linked.join("Roman.story/escape")).unwrap();
        fs::create_dir(f.vault.join("Fach")).unwrap();
        f.host
            .folder_locations
            .replace("Fach", vec![fs::canonicalize(&linked).unwrap()]);

        call(&mut f, "fanotes:story-write", &[s("Fach/Roman.story/story.json"), s("{}")]).unwrap();
        assert_eq!(fs::read_to_string(linked.join("Roman.story/story.json")).unwrap(), "{}");
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("Fach/Roman.story/story.json")]).unwrap(), s("{}"));
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("Fach/Roman.story/none.json")]).unwrap(), Value::Null);
        assert_eq!(call(&mut f, "fanotes:story-list", &[s("Fach/Roman.story")]).unwrap(), json!(["story.json"]));
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("Fach/Roman.story/escape/x.json"), s("{}")]).unwrap_err(),
            SYMLINK
        );
        assert!(!outside.join("x.json").exists());
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s("Fach"), s("Neu.story")]).unwrap(),
            s("Fach/Neu.story")
        );
        assert!(linked.join("Neu.story").is_dir());
    }

    #[test]
    fn oversize_and_non_text_content_is_refused() {
        let mut f = fixture("size");
        fs::create_dir(f.vault.join("A.story")).unwrap();
        let big = "a".repeat(MAX_STORY_FILE_BYTES as usize + 1);
        assert_eq!(call(&mut f, "fanotes:story-write", &[s("A.story/x.md"), s(&big)]).unwrap_err(), INVALID_CONTENT);
        assert_eq!(call(&mut f, "fanotes:story-write", &[s("A.story/x.md"), json!({"a": 1})]).unwrap_err(), INVALID_CONTENT);
        assert_eq!(call(&mut f, "fanotes:story-write", &[s("A.story/x.md")]).unwrap_err(), INVALID_CONTENT);
        let exact = "a".repeat(MAX_STORY_FILE_BYTES as usize);
        call(&mut f, "fanotes:story-write", &[s("A.story/x.md"), s(&exact)]).unwrap();
        fs::write(f.vault.join("A.story/huge.md"), &big).unwrap();
        assert_eq!(call(&mut f, "fanotes:story-read", &[s("A.story/huge.md")]).unwrap_err(), "Die Datei ist zu groß.");
        assert!(!f.vault.join("A.story/x.json").exists());
    }

    #[test]
    fn json_files_must_parse_and_markdown_is_free_text() {
        let mut f = fixture("json");
        fs::create_dir(f.vault.join("A.story")).unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("A.story/x.json"), s("")]).unwrap_err(),
            "Unexpected end of JSON input"
        );
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("A.story/x.json"), s("{\"a\":1,}")]).unwrap_err(),
            "Unexpected token } in JSON at position 7"
        );
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("A.story/x.JSON"), s("nope")]).unwrap_err(),
            "Unexpected token o in JSON at position 1"
        );
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("A.story/x.json"), s("{} x")]).unwrap_err(),
            "Unexpected token x in JSON at position 3"
        );
        assert!(!f.vault.join("A.story/x.json").exists());
        // JSON.parse grammar: deep nesting and huge numbers are accepted.
        let deep = format!("{}{}", "[".repeat(600), "]".repeat(600));
        call(&mut f, "fanotes:story-write", &[s("A.story/deep.json"), s(&deep)]).unwrap();
        call(&mut f, "fanotes:story-write", &[s("A.story/num.json"), s(" 1e400 ")]).unwrap();
        call(&mut f, "fanotes:story-write", &[s("A.story/x.md"), s("{not json")]).unwrap();
    }

    #[test]
    fn writing_needs_the_story_folder_to_exist() {
        let mut f = fixture("no-folder");
        let error = call(&mut f, "fanotes:story-write", &[s("A.story/x.json"), s("{}")]).unwrap_err();
        assert_eq!(
            error,
            format!("ENOENT: no such file or directory, lstat '{}'", f.vault.join("A.story").display())
        );
        fs::write(f.vault.join("F.story"), "file").unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-write", &[s("F.story/x.json"), s("{}")]).unwrap_err(),
            "Der gewählte Pfad ist kein Ordner."
        );
        assert_eq!(
            call(&mut f, "fanotes:story-list", &[s("F.story")]).unwrap_err(),
            "Der gewählte Pfad ist kein Ordner."
        );
        assert!(!f.vault.join("A.story").exists());
    }

    #[test]
    fn creating_a_story_picks_a_free_name() {
        let mut f = fixture("create");
        assert_eq!(call(&mut f, "fanotes:story-create", &[]).unwrap(), s("Geschichte.story"));
        assert_eq!(call(&mut f, "fanotes:story-create", &[s(""), s("  ")]).unwrap(), s("Geschichte 2.story"));
        fs::write(f.vault.join("geschichte 3.STORY"), "").unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[Value::Null, s("Geschichte.story")]).unwrap(),
            s("Geschichte 4.story")
        );
        assert_eq!(call(&mut f, "fanotes:story-create", &[s("./"), s("Roman.story. ")]).unwrap(), s("Roman.story"));
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s(""), s("Roman")]).unwrap_err(),
            NAME_NOT_A_STORY
        );
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s(""), s("a/b.story")]).unwrap_err(),
            "Dieser Name ist nicht erlaubt."
        );
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s("Fehlt"), s("A.story")]).unwrap_err(),
            format!("ENOENT: no such file or directory, lstat '{}'", f.vault.join("Fehlt").display())
        );
        fs::write(f.vault.join("note.md"), "").unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-create", &[s("note.md"), s("A.story")]).unwrap_err(),
            "Der gewählte Pfad ist kein Ordner."
        );
        for name in ["Geschichte.story", "Geschichte 2.story", "Geschichte 4.story", "Roman.story"] {
            assert!(f.vault.join(name).is_dir(), "{name}");
        }
    }

    #[test]
    fn the_list_stops_below_four_folder_levels() {
        let mut f = fixture("depth");
        let deep = f.vault.join("A.story/1/2/3/4/5");
        fs::create_dir_all(&deep).unwrap();
        fs::write(f.vault.join("A.story/1/2/3/4/four.json"), "{}").unwrap();
        fs::write(deep.join("five.json"), "{}").unwrap();
        assert_eq!(
            call(&mut f, "fanotes:story-list", &[s("A.story")]).unwrap(),
            json!(["1/2/3/4/four.json"])
        );
    }

    #[test]
    fn a_vault_is_required_first() {
        let base = std::env::temp_dir().join(format!("fanotes-story-novault-{}", std::process::id()));
        let mut host = Host::open(base.join("app"));
        host.vault = None;
        host.configured_vault = None;
        for channel in ["fanotes:story-read", "fanotes:story-write", "fanotes:story-list", "fanotes:story-create"] {
            assert_eq!(
                dispatch(&mut host, channel, &[json!(1)]).unwrap().unwrap_err(),
                "Der Vault ist noch nicht initialisiert.",
                "{channel}"
            );
        }
        assert!(dispatch(&mut host, "fanotes:read-file", &[]).is_none());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_story_folder_is_one_document_in_the_tree() {
        let f = fixture("tree");
        fs::create_dir(f.vault.join("Roman.STORY")).unwrap();
        let meta = fs::symlink_metadata(f.vault.join("Roman.STORY")).unwrap();
        assert!(is_story_folder("Roman.STORY"));
        assert!(is_story_folder(".story"));
        assert!(!is_story_folder("Roman.story.md"));
        assert!(!is_story_folder("Roman"));
        assert_eq!(
            tree_entry("Roman.STORY", "Deutsch/Roman.STORY", &meta, false),
            json!({"name": "Roman.STORY", "relativePath": "Deutsch/Roman.STORY", "kind": "file", "extension": "story"})
        );
        let full = tree_entry("Roman.STORY", "Roman.STORY", &meta, true);
        let keys: Vec<&str> = full.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["name", "relativePath", "kind", "extension", "modifiedAt"]);
        assert_eq!(
            full["modifiedAt"],
            json!(notes::iso_from_system_time(meta.modified().unwrap()))
        );
    }
}
