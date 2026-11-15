//! Local note history, as `electron/note-history.cjs` and `noteHistoryPolicy.mjs`.
//!
//! Snapshots live under `.fanotes/history/<sha1(path)>/` with an `index.json`
//! (`fanotes-history-v1`). A weekly snapshot stays. A 12-hour snapshot stays
//! for two days. A markdown note also stores its `.famd` companion as
//! `<id>.famd` beside `<id>.md`; a `.famd` note stores `<id>.famd` only.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::locations::FolderLocations;
use crate::notes::{
    ensure_private_history_dir, history_dir, history_index_bytes, is_snapshot_id,
    iso_from_unix_millis, js_regexp_string, markdown_path, node_open_error, random_suffix,
    read_history_index, read_optional_text, snapshot_same, vault_root, write_history_index,
    write_history_snapshot, MAX_COMPANION_BYTES, MAX_SNAPSHOT_BYTES,
};
use crate::{vault, Host};

pub(crate) const SHORT_INTERVAL_MS: i64 = 12 * 60 * 60 * 1000;
pub(crate) const SHORT_RETENTION_MS: i64 = 2 * 24 * 60 * 60 * 1000;
pub(crate) const WEEK_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    Week,
    Short,
}

impl Tier {
    fn label(self) -> &'static str {
        match self {
            Tier::Week => "week",
            Tier::Short => "short",
        }
    }
}

/// `Date.now()`.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `snapshotExtension`: `.famd` for a handwriting note, `.md` for everything else.
pub(crate) fn snapshot_extension(relative: &str) -> &'static str {
    let normalized = relative.replace('\\', "/");
    let slash = normalized.rfind('/');
    let dot = normalized.rfind('.');
    let extension = match (dot, slash) {
        (Some(dot), Some(slash)) if dot > slash => normalized[dot..].to_lowercase(),
        (Some(dot), None) => normalized[dot..].to_lowercase(),
        _ => String::new(),
    };
    if extension == ".famd" {
        ".famd"
    } else {
        ".md"
    }
}

/// `Date.parse(snapshot?.createdAt)` when it is finite.
fn time_of(snapshot: &Value) -> Option<i64> {
    let created = snapshot.get("createdAt")?;
    let text = match created {
        Value::String(text) => text.clone(),
        other => js_regexp_string(other),
    };
    fanotes_famd::canonical_unix_millis(&text)
}

fn stored_extension(snapshot: &Value) -> &'static str {
    if snapshot.get("ext").and_then(Value::as_str) == Some(".famd") {
        ".famd"
    } else {
        ".md"
    }
}

fn tier_of(snapshot: &Value) -> Option<&str> {
    snapshot.get("tier").and_then(Value::as_str)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `{ ...snapshot, tier, ext }`: existing keys keep their place.
fn with_tier(snapshot: &Value, tier: &str, ext: &str) -> Value {
    let mut object = snapshot.as_object().cloned().unwrap_or_else(Map::new);
    object.insert("tier".to_owned(), Value::String(tier.to_owned()));
    object.insert("ext".to_owned(), Value::String(ext.to_owned()));
    Value::Object(object)
}

/// `retainSnapshots`: weekly snapshots stay, 12-hour snapshots stay for two days.
/// An entry without a tier is folded into the same rule.
pub(crate) fn retain_snapshots(snapshots: &[Value], now: i64) -> Vec<Value> {
    let mut sorted: Vec<&Value> = snapshots
        .iter()
        .filter(|snapshot| snapshot.get("id").is_some_and(Value::is_string))
        .collect();
    // `Array.prototype.sort` is stable; a missing time sorts as 0.
    sorted.sort_by_key(|snapshot| time_of(snapshot).unwrap_or(0));
    let mut kept = Vec::new();
    let mut last_week: Option<i64> = None;
    let mut last_any: Option<i64> = None;
    for snapshot in sorted {
        let ext = stored_extension(snapshot);
        let tier = tier_of(snapshot);
        let Some(at) = time_of(snapshot) else {
            let tier = if tier == Some("short") {
                "short"
            } else {
                "week"
            };
            kept.push(with_tier(snapshot, tier, ext));
            continue;
        };
        if tier == Some("week") {
            kept.push(with_tier(snapshot, "week", ext));
            last_week = Some(at);
            last_any = Some(at);
            continue;
        }
        if tier == Some("short") {
            if now - at < SHORT_RETENTION_MS {
                kept.push(with_tier(snapshot, "short", ext));
                last_any = Some(at);
            }
            continue;
        }
        if last_week.is_none_or(|week| at - week >= WEEK_INTERVAL_MS) {
            kept.push(with_tier(snapshot, "week", ext));
            last_week = Some(at);
            last_any = Some(at);
            continue;
        }
        if now - at < SHORT_RETENTION_MS && last_any.is_none_or(|any| at - any >= SHORT_INTERVAL_MS)
        {
            kept.push(with_tier(snapshot, "short", ext));
            last_any = Some(at);
        }
    }
    kept
}

/// `nextSnapshotTier`: `week` wins when both are due.
pub(crate) fn next_snapshot_tier(snapshots: &[Value], now: i64) -> Option<Tier> {
    let mut last_week: Option<i64> = None;
    let mut last_any: Option<i64> = None;
    for snapshot in snapshots {
        let Some(at) = time_of(snapshot) else {
            continue;
        };
        let tier = tier_of(snapshot);
        if tier == Some("week") {
            last_week = Some(last_week.map_or(at, |week| week.max(at)));
        }
        if matches!(tier, Some("week" | "short")) {
            last_any = Some(last_any.map_or(at, |any| any.max(at)));
        }
    }
    if last_week.is_none_or(|week| now - week >= WEEK_INTERVAL_MS) {
        return Some(Tier::Week);
    }
    if last_any.is_none_or(|any| now - any >= SHORT_INTERVAL_MS) {
        return Some(Tier::Short);
    }
    None
}

struct Retention {
    kept: Vec<Value>,
    removed: Vec<Value>,
}

fn index_snapshots(index: &Value) -> Vec<Value> {
    index
        .get("snapshots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `applyRetention`. A `null` entry is a TypeError in the desktop `filter`
/// once something is kept.
fn apply_retention(index: &Value, now: i64) -> Result<Retention, String> {
    let snapshots = index_snapshots(index);
    let kept = retain_snapshots(&snapshots, now);
    let mut removed = Vec::new();
    for snapshot in &snapshots {
        if snapshot.is_null() && !kept.is_empty() {
            return Err("Cannot read properties of null (reading 'id')".to_owned());
        }
        let id = snapshot.get("id");
        let still_kept = kept.iter().any(|item| match (item.get("id"), id) {
            (Some(left), Some(right)) => snapshot_same(left, right),
            _ => false,
        });
        if !still_kept {
            removed.push(snapshot.clone());
        }
    }
    Ok(Retention { kept, removed })
}

fn same_json(left: &[Value], right: &[Value]) -> bool {
    serde_json::to_string(left).ok() == serde_json::to_string(right).ok()
}

/// `deleteSnapshotFiles`: `<id>.md` and `<id>.famd`. Only a plain snapshot id
/// names a file, so a crafted index cannot delete outside the folder.
fn delete_snapshot_files(directory: &Path, entry: &Value) {
    let Some(id) = entry.get("id").and_then(Value::as_str) else {
        return;
    };
    if !is_snapshot_id(id) {
        return;
    }
    let _ = fs::remove_file(directory.join(format!("{id}.md")));
    let _ = fs::remove_file(directory.join(format!("{id}.famd")));
}

/// `commitIndex`: writes only when the list changed, then drops removed files.
fn commit_index(
    directory: &Path,
    index: &mut Value,
    snapshots: Vec<Value>,
    removed: &[Value],
) -> Result<(), String> {
    if same_json(&index_snapshots(index), &snapshots) && removed.is_empty() {
        return Ok(());
    }
    let previous = index.get("snapshots").cloned();
    set_field(index, "snapshots", Value::Array(snapshots))?;
    let written = history_index_bytes(index).and_then(|bytes| {
        ensure_private_history_dir(directory)?;
        write_history_index(directory, &bytes)
    });
    if let Err(error) = written {
        if let Some(previous) = previous {
            let _ = set_field(index, "snapshots", previous);
        }
        return Err(error);
    }
    for entry in removed {
        delete_snapshot_files(directory, entry);
    }
    Ok(())
}

fn set_field(index: &mut Value, key: &str, value: Value) -> Result<(), String> {
    index
        .as_object_mut()
        .ok_or_else(|| "Der Verlauf konnte nicht gespeichert werden.".to_owned())?
        .insert(key.to_owned(), value);
    Ok(())
}

fn snapshot_file_name(entry: &Value) -> Option<String> {
    let id = entry.get("id").and_then(Value::as_str)?;
    if !is_snapshot_id(id) {
        return None;
    }
    Some(format!("{id}{}", stored_extension(entry)))
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|error| node_open_error(path, &error))
}

fn directory_exists(directory: &Path) -> bool {
    fs::metadata(directory).is_ok_and(|meta| meta.is_dir())
}

/// `recordNoteHistorySnapshot(vault, relativePath, content, { companion, now })`.
pub(crate) fn record(
    vault_root: &Path,
    relative: &str,
    content: &str,
    companion: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let text = content;
    let companion = companion
        .filter(|companion| !vault::js_trim(companion).is_empty())
        .unwrap_or("");
    let directory = history_dir(vault_root, relative)?;
    let exists = directory_exists(&directory);
    if vault::js_trim(text).is_empty() && companion.is_empty() {
        if !exists {
            return Ok(());
        }
        let mut index = read_history_index(&directory)?;
        let retention = apply_retention(&index, now)?;
        return commit_index(&directory, &mut index, retention.kept, &retention.removed);
    }
    let bytes = text.len();
    let companion_bytes = companion.len();
    if bytes > MAX_SNAPSHOT_BYTES {
        return Ok(());
    }
    if !exists && bytes == 0 && companion_bytes == 0 {
        return Ok(());
    }
    ensure_private_history_dir(&directory)?;
    let mut index = read_history_index(&directory)?;
    let retention = apply_retention(&index, now)?;
    let ext = snapshot_extension(relative);
    let changed = match retention.kept.last() {
        None => true,
        Some(last) => {
            let previous = snapshot_file_name(last)
                .ok_or(())
                .and_then(|name| read_text(&directory.join(name)).map_err(|_| ()));
            let previous_companion = if truthy(last.get("companion"))
                && stored_extension(last) != ".famd"
            {
                last.get("id")
                    .and_then(Value::as_str)
                    .filter(|id| is_snapshot_id(id))
                    .ok_or(())
                    .and_then(|id| read_text(&directory.join(format!("{id}.famd"))).map_err(|_| ()))
            } else {
                Ok(String::new())
            };
            match (previous, previous_companion) {
                (Ok(previous), Ok(previous_companion)) => {
                    previous != text || previous_companion != companion
                }
                _ => true,
            }
        }
    };
    let tier = if changed {
        next_snapshot_tier(&retention.kept, now)
    } else {
        None
    };
    let can_store_companion = ext != ".famd"
        && !companion.is_empty()
        && companion_bytes > 0
        && companion_bytes <= MAX_SNAPSHOT_BYTES;
    let Some(tier) = tier.filter(|_| changed && (bytes > 0 || can_store_companion)) else {
        if !truthy(index.get("path")) {
            set_field(&mut index, "path", Value::String(relative.to_owned()))?;
        }
        return commit_index(&directory, &mut index, retention.kept, &retention.removed);
    };
    let created_at = iso_from_unix_millis(now);
    let id = format!(
        "{}-{}",
        created_at.replace([':', '.'], "-"),
        random_suffix()?
    );
    let mut entry = json!({
        "id": id,
        "createdAt": created_at,
        "bytes": bytes,
        "tier": tier.label(),
        "ext": ext,
    });
    if can_store_companion {
        set_field(&mut entry, "companion", Value::Bool(true))?;
    }
    let primary = directory.join(format!("{id}{ext}"));
    let companion_path = can_store_companion.then(|| directory.join(format!("{id}.famd")));
    // Desktop `writeFile` uses the final snapshot name and rethrows that error.
    write_history_snapshot(&primary, text)?;
    if let Some(path) = &companion_path {
        if let Err(error) = write_history_snapshot(path, companion) {
            let _ = fs::remove_file(&primary);
            return Err(error);
        }
    }
    let mut next = retention.kept;
    next.push(entry);
    set_field(&mut index, "path", Value::String(relative.to_owned()))?;
    if let Err(error) = commit_index(&directory, &mut index, next, &retention.removed) {
        let _ = fs::remove_file(&primary);
        if let Some(path) = &companion_path {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(())
}

/// `listNoteHistory`: newest first, `{ id, createdAt, bytes }`. Expired
/// snapshots are dropped from the index and the folder on the way.
pub(crate) fn list_at(vault_root: &Path, note: &str, now: i64) -> Result<Value, String> {
    let directory = history_dir(vault_root, note)?;
    let mut index = read_history_index(&directory)?;
    let retention = apply_retention(&index, now)?;
    let kept = retention.kept.clone();
    if !retention.removed.is_empty() || !same_json(&index_snapshots(&index), &kept) {
        commit_index(&directory, &mut index, retention.kept, &retention.removed)?;
    }
    let listed = kept
        .iter()
        .rev()
        .map(|entry| {
            let mut item = Map::new();
            for key in ["id", "createdAt", "bytes"] {
                if let Some(value) = entry.get(key) {
                    item.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(item)
        })
        .collect();
    Ok(Value::Array(listed))
}

pub(crate) fn list(host: &Host, relative: &str) -> Result<Value, String> {
    let note = markdown_path(relative)?;
    list_at(vault_root(host)?, &note, now_ms())
}

/// `readNoteHistory`: the snapshot text, plus `companion` for a markdown note
/// that stored its `.famd` beside it.
pub(crate) fn read(host: &Host, relative: &str, snapshot: Option<&Value>) -> Result<Value, String> {
    let note = markdown_path(relative)?;
    let pattern = match snapshot {
        Some(value) => js_regexp_string(value),
        None => "undefined".to_owned(),
    };
    if !is_snapshot_id(&pattern) {
        return Err("Ungültiger Verlaufseintrag.".to_owned());
    }
    let directory = history_dir(vault_root(host)?, &note)?;
    let index = read_history_index(&directory)?;
    let entry = index_snapshots(&index)
        .into_iter()
        .find(|item| {
            snapshot.is_some_and(|query| item.get("id").is_some_and(|id| snapshot_same(id, query)))
        })
        .ok_or_else(|| "Dieser Verlaufseintrag existiert nicht mehr.".to_owned())?;
    let snapshot_id = entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_snapshot_id(id))
        .ok_or_else(|| "Dieser Verlaufseintrag existiert nicht mehr.".to_owned())?
        .to_owned();
    // Desktop `readFile` throws. A missing or unreadable snapshot is that
    // open error, not the message used when the id is absent from the index.
    let famd_snapshot = entry.get("ext").and_then(Value::as_str) == Some(".famd");
    let file = directory.join(format!(
        "{snapshot_id}{}",
        if famd_snapshot { ".famd" } else { ".md" }
    ));
    let content = read_text(&file)?;
    let mut result = Map::new();
    result.insert("id".to_owned(), Value::String(snapshot_id.clone()));
    if let Some(created) = entry.get("createdAt") {
        result.insert("createdAt".to_owned(), created.clone());
    }
    result.insert("content".to_owned(), Value::String(content));
    if truthy(entry.get("companion")) && !famd_snapshot {
        let companion = read_text(&directory.join(format!("{snapshot_id}.famd")))?;
        result.insert("companion".to_owned(), Value::String(companion));
    }
    Ok(Value::Object(result))
}

/// `pruneVaultHistory`: applies the retention rule to every history folder.
/// A folder that fails is left as it is.
pub(crate) fn prune_vault_history(vault_root: &Path, now: i64) -> Result<(), String> {
    let root = vault_root.join(".fanotes").join("history");
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(node_open_error(&root, &error)),
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let directory = entry.path();
        let _ = (|| -> Result<(), String> {
            let mut index = read_history_index(&directory)?;
            let retention = apply_retention(&index, now)?;
            if retention.removed.is_empty() && same_json(&index_snapshots(&index), &retention.kept)
            {
                return Ok(());
            }
            commit_index(&directory, &mut index, retention.kept, &retention.removed)
        })();
    }
    Ok(())
}

/// `snapshotNoteHistory(relativePath)`: the note as it is on disk now, with its
/// `.famd` companion for a markdown note. Called before a companion write.
/// Every failure only skips the snapshot.
pub(crate) fn snapshot_note(vault_root: &Path, locations: &FolderLocations, relative: &str) {
    if relative.is_empty() {
        return;
    }
    let read = |path: &str| -> Result<Option<String>, String> {
        let target = locations.resolve_note(vault_root, path, true)?;
        read_optional_text(&target, MAX_COMPANION_BYTES)
    };
    let now = now_ms();
    if vault::posix_extname_en_us(relative) == ".famd" {
        if let Ok(Some(previous)) = read(relative) {
            let _ = record(vault_root, relative, &previous, None, now);
        }
        return;
    }
    let Ok(previous) = read(relative) else {
        return;
    };
    let companion_relative = fanotes_famd::companion_note_path(relative, ".famd");
    let Ok(companion) = read(&companion_relative) else {
        return;
    };
    if previous.is_none() && companion.is_none() {
        return;
    }
    let _ = record(
        vault_root,
        relative,
        previous.as_deref().unwrap_or(""),
        companion.as_deref(),
        now,
    );
}

/// The `write-file` snapshot: the file before the save (`readRegularFileNoFollow`
/// with the note limit) and, for a markdown note, its `.famd` companion. A read
/// failure only skips the snapshot; the save goes on.
pub(crate) fn record_before_write(
    vault_root: &Path,
    locations: &FolderLocations,
    relative: &str,
    target: &Path,
    limit: u64,
) {
    let Ok(bytes) = crate::notes::read_nofollow_limited(target, limit) else {
        return;
    };
    let previous = String::from_utf8_lossy(&bytes);
    let companion = if vault::posix_extname_en_us(relative) == ".famd" {
        None
    } else {
        let companion_relative = fanotes_famd::companion_note_path(relative, ".famd");
        let read = locations
            .resolve_note(vault_root, &companion_relative, true)
            .and_then(|path| read_optional_text(&path, MAX_COMPANION_BYTES));
        match read {
            Ok(companion) => companion,
            Err(_) => return,
        }
    };
    let _ = record(
        vault_root,
        relative,
        &previous,
        companion.as_deref(),
        now_ms(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED: i64 = 1_772_323_200_000; // 2026-03-01T00:00:00.000Z

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "fanotes-history-{label}-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn listed(root: &Path, note: &str, now: i64) -> Vec<Value> {
        list_at(root, note, now)
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }

    fn content(root: &Path, note: &str, id: &str) -> Value {
        let directory = history_dir(root, note).unwrap();
        let index = read_history_index(&directory).unwrap();
        let entry = index_snapshots(&index)
            .into_iter()
            .find(|item| item["id"] == id)
            .unwrap();
        let ext = if entry["ext"] == ".famd" {
            ".famd"
        } else {
            ".md"
        };
        let mut result = json!({
            "content": read_text(&directory.join(format!("{id}{ext}"))).unwrap(),
        });
        if entry["companion"] == true {
            result["companion"] = json!(read_text(&directory.join(format!("{id}.famd"))).unwrap());
        }
        result
    }

    fn snapshot_files(directory: &Path) -> usize {
        fs::read_dir(directory)
            .unwrap()
            .filter(|entry| {
                let name = entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .into_owned();
                name != "index.json" && (name.ends_with(".md") || name.ends_with(".famd"))
            })
            .count()
    }

    #[test]
    fn the_start_date_is_the_desktop_fixture_epoch() {
        assert_eq!(iso_from_unix_millis(STARTED), "2026-03-01T00:00:00.000Z");
    }

    // check-famd.cjs `assertUnreadableRecordsStayPut`: the cadence cases.
    #[test]
    fn a_week_and_a_half_day_snapshot_follow_the_desktop_cadence() {
        let root = temp_root("cadence");
        record(&root, "Long.md", "week\n", None, STARTED).unwrap();
        record(&root, "Long.md", "too soon\n", None, STARTED + 60_000).unwrap();
        record(
            &root,
            "Long.md",
            "half day\n",
            None,
            STARTED + SHORT_INTERVAL_MS,
        )
        .unwrap();
        let history = listed(&root, "Long.md", STARTED + SHORT_INTERVAL_MS);
        assert_eq!(history.len(), 2);
        assert_eq!(
            content(&root, "Long.md", history[0]["id"].as_str().unwrap())["content"],
            "half day\n"
        );
        assert_eq!(
            content(&root, "Long.md", history[1]["id"].as_str().unwrap())["content"],
            "week\n"
        );
        assert_eq!(
            history[0].as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "createdAt", "bytes"]
        );

        let history = listed(
            &root,
            "Long.md",
            STARTED + SHORT_INTERVAL_MS + SHORT_RETENTION_MS,
        );
        assert_eq!(history.len(), 1);
        assert_eq!(
            content(&root, "Long.md", history[0]["id"].as_str().unwrap())["content"],
            "week\n"
        );
        let directory = history_dir(&root, "Long.md").unwrap();
        assert_eq!(
            snapshot_files(&directory),
            1,
            "an expired snapshot file stayed"
        );

        record(
            &root,
            "Long.md",
            "next week\n",
            None,
            STARTED + WEEK_INTERVAL_MS,
        )
        .unwrap();
        let history = listed(&root, "Long.md", STARTED + WEEK_INTERVAL_MS);
        assert_eq!(history.len(), 2);
        let index: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("index.json")).unwrap())
                .unwrap();
        let tiers: Vec<_> = index["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["tier"].clone())
            .collect();
        assert_eq!(tiers, [json!("week"), json!("week")]);
        assert_eq!(index["path"], "Long.md");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_handwriting_note_keeps_only_its_famd_snapshot() {
        let root = temp_root("famd");
        record(&root, "Ink.famd", "handwriting-bytes", None, STARTED).unwrap();
        let directory = history_dir(&root, "Ink.famd").unwrap();
        let names: Vec<String> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names.iter().filter(|name| name.ends_with(".famd")).count(),
            1
        );
        assert_eq!(names.iter().filter(|name| name.ends_with(".md")).count(), 0);
        let history = listed(&root, "Ink.famd", STARTED);
        assert_eq!(
            content(&root, "Ink.famd", history[0]["id"].as_str().unwrap())["content"],
            "handwriting-bytes"
        );
        let index: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("index.json")).unwrap())
                .unwrap();
        assert_eq!(index["snapshots"][0]["ext"], ".famd");
        assert!(index["snapshots"][0].get("companion").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_markdown_note_stores_its_companion_beside_the_text() {
        let root = temp_root("both");
        record(
            &root,
            "Both.md",
            "# Text\n",
            Some("companion-famd"),
            STARTED,
        )
        .unwrap();
        let history = listed(&root, "Both.md", STARTED);
        let both = content(&root, "Both.md", history[0]["id"].as_str().unwrap());
        assert_eq!(both["content"], "# Text\n");
        assert_eq!(both["companion"], "companion-famd");
        let directory = history_dir(&root, "Both.md").unwrap();
        let names: Vec<String> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.iter().filter(|name| name.ends_with(".md")).count(), 1);
        assert_eq!(
            names.iter().filter(|name| name.ends_with(".famd")).count(),
            1
        );
        let index = fs::read_to_string(directory.join("index.json")).unwrap();
        let id = history[0]["id"].as_str().unwrap();
        assert_eq!(
            index,
            format!(
                "{{\n  \"format\": \"fanotes-history-v1\",\n  \"snapshots\": [\n    {{\n      \"id\": \"{id}\",\n      \"createdAt\": \"2026-03-01T00:00:00.000Z\",\n      \"bytes\": 7,\n      \"tier\": \"week\",\n      \"ext\": \".md\",\n      \"companion\": true\n    }}\n  ],\n  \"path\": \"Both.md\"\n}}\n"
            )
        );
        assert!(id.starts_with("2026-03-01T00-00-00-000Z-"));

        // The same text with a changed companion is a new revision once a tier is due.
        record(
            &root,
            "Both.md",
            "# Text\n",
            Some("second"),
            STARTED + 60_000,
        )
        .unwrap();
        assert_eq!(listed(&root, "Both.md", STARTED + 60_000).len(), 1);
        record(
            &root,
            "Both.md",
            "# Text\n",
            Some("second"),
            STARTED + SHORT_INTERVAL_MS,
        )
        .unwrap();
        let history = listed(&root, "Both.md", STARTED + SHORT_INTERVAL_MS);
        assert_eq!(history.len(), 2);
        assert_eq!(
            content(&root, "Both.md", history[0]["id"].as_str().unwrap())["companion"],
            "second"
        );
        // Unchanged text and companion do not add a snapshot even when one is due.
        let day = STARTED + 2 * SHORT_INTERVAL_MS;
        record(&root, "Both.md", "# Text\n", Some("second"), day).unwrap();
        assert_eq!(listed(&root, "Both.md", day).len(), 2);
        // A week on, the half-day copy has expired; the weekly one differs, so it is kept again.
        let week = STARTED + WEEK_INTERVAL_MS;
        record(&root, "Both.md", "# Text\n", Some("second"), week).unwrap();
        let history = listed(&root, "Both.md", week);
        assert_eq!(history.len(), 2);
        assert_eq!(
            content(&root, "Both.md", history[0]["id"].as_str().unwrap())["companion"],
            "second"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_blank_note_with_a_companion_is_kept_and_a_blank_one_without_is_not() {
        let root = temp_root("blank");
        record(&root, "Leer.md", " \n", None, STARTED).unwrap();
        assert!(!history_dir(&root, "Leer.md").unwrap().exists());
        record(&root, "Leer.md", "", Some("companion-famd"), STARTED).unwrap();
        let history = listed(&root, "Leer.md", STARTED);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["bytes"], 0);
        let both = content(&root, "Leer.md", history[0]["id"].as_str().unwrap());
        assert_eq!(both["content"], "");
        assert_eq!(both["companion"], "companion-famd");
        // A `.famd` note never stores a text-less snapshot; like the desktop it
        // still creates the empty folder.
        record(&root, "Ink.famd", "", Some("x"), STARTED).unwrap();
        let directory = history_dir(&root, "Ink.famd").unwrap();
        assert_eq!(snapshot_files(&directory), 0);
        assert!(listed(&root, "Ink.famd", STARTED).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_snapshots_fold_into_one_weekly_snapshot() {
        let root = temp_root("legacy");
        let directory = history_dir(&root, "Old.md").unwrap();
        fs::create_dir_all(&directory).unwrap();
        let base = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z
        let mut snapshots = Vec::new();
        for revision in 0..6 {
            let created = iso_from_unix_millis(base + revision * 60_000);
            let id = format!("{}-aa000{revision}", created.replace([':', '.'], "-"));
            fs::write(
                directory.join(format!("{id}.md")),
                format!("revision {revision}\n"),
            )
            .unwrap();
            snapshots.push(json!({ "id": id, "createdAt": created, "bytes": 12 }));
        }
        let index =
            json!({ "format": "fanotes-history-v1", "snapshots": snapshots, "path": "Old.md" });
        fs::write(
            directory.join("index.json"),
            format!("{}\n", serde_json::to_string_pretty(&index).unwrap()),
        )
        .unwrap();
        let august = 1_785_542_400_000; // 2026-08-01T00:00:00.000Z
        let legacy = listed(&root, "Old.md", august);
        assert_eq!(legacy.len(), 1);
        assert_eq!(
            content(&root, "Old.md", legacy[0]["id"].as_str().unwrap())["content"],
            "revision 0\n"
        );
        assert_eq!(snapshot_files(&directory), 1);
        prune_vault_history(&root, august).unwrap();
        assert_eq!(listed(&root, "Old.md", august).len(), 1);
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("index.json")).unwrap())
                .unwrap();
        assert_eq!(
            stored["snapshots"][0]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["id", "createdAt", "bytes", "tier", "ext"]
        );
        assert_eq!(stored["snapshots"][0]["tier"], "week");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pruning_drops_expired_half_day_snapshots_in_every_folder() {
        let root = temp_root("prune");
        record(&root, "A.md", "week\n", None, STARTED).unwrap();
        record(&root, "A.md", "half\n", None, STARTED + SHORT_INTERVAL_MS).unwrap();
        record(&root, "B.famd", "week\n", None, STARTED).unwrap();
        record(&root, "B.famd", "half\n", None, STARTED + SHORT_INTERVAL_MS).unwrap();
        let later = STARTED + SHORT_INTERVAL_MS + SHORT_RETENTION_MS;
        prune_vault_history(&root, later).unwrap();
        for note in ["A.md", "B.famd"] {
            let directory = history_dir(&root, note).unwrap();
            assert_eq!(snapshot_files(&directory), 1, "{note}");
            let index: Value =
                serde_json::from_str(&fs::read_to_string(directory.join("index.json")).unwrap())
                    .unwrap();
            assert_eq!(index["snapshots"].as_array().unwrap().len(), 1, "{note}");
        }
        assert!(prune_vault_history(&root.join("missing"), later).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_crafted_index_id_never_deletes_outside_the_history_folder() {
        let root = temp_root("crafted");
        let directory = history_dir(&root, "Note.md").unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(root.join("victim.md"), b"keep").unwrap();
        let index = json!({
            "format": "fanotes-history-v1",
            "snapshots": [{
                "id": "../../../victim",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "tier": "short",
                "bytes": 4,
            }],
        });
        fs::write(directory.join("index.json"), index.to_string()).unwrap();
        assert_eq!(listed(&root, "Note.md", STARTED), Vec::<Value>::new());
        assert_eq!(fs::read(root.join("victim.md")).unwrap(), b"keep");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_index_rejects_the_snapshot_and_leaves_no_orphan() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("unreadable");
        record(&root, "Note.md", "first revision\n", None, STARTED).unwrap();
        record(
            &root,
            "Note.md",
            "second revision\n",
            None,
            STARTED + SHORT_INTERVAL_MS,
        )
        .unwrap();
        assert_eq!(
            listed(&root, "Note.md", STARTED + SHORT_INTERVAL_MS).len(),
            2
        );
        let directory = history_dir(&root, "Note.md").unwrap();
        let index = directory.join("index.json");
        fs::set_permissions(&index, fs::Permissions::from_mode(0o000)).unwrap();
        let readable = fs::read(&index).is_ok();
        let error = record(
            &root,
            "Note.md",
            "third revision\n",
            None,
            STARTED + SHORT_INTERVAL_MS * 2,
        );
        fs::set_permissions(&index, fs::Permissions::from_mode(0o600)).unwrap();
        if !readable {
            assert!(error.unwrap_err().starts_with("EACCES:"));
            assert_eq!(
                listed(&root, "Note.md", STARTED + SHORT_INTERVAL_MS).len(),
                2
            );
            assert_eq!(snapshot_files(&directory), 2);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_policy_matches_the_desktop_rules() {
        let at = |offset: i64, tier: Option<&str>| {
            let mut item = json!({ "id": format!("s{offset}"), "createdAt": iso_from_unix_millis(STARTED + offset) });
            if let Some(tier) = tier {
                item["tier"] = json!(tier);
            }
            item
        };
        assert_eq!(next_snapshot_tier(&[], STARTED), Some(Tier::Week));
        let week = [at(0, Some("week"))];
        assert_eq!(next_snapshot_tier(&week, STARTED + 60_000), None);
        assert_eq!(
            next_snapshot_tier(&week, STARTED + SHORT_INTERVAL_MS),
            Some(Tier::Short)
        );
        assert_eq!(
            next_snapshot_tier(&week, STARTED + WEEK_INTERVAL_MS),
            Some(Tier::Week)
        );
        // An untiered entry counts for neither tier.
        assert_eq!(
            next_snapshot_tier(&[at(0, None)], STARTED),
            Some(Tier::Week)
        );
        // An entry without a date keeps its tier and comes first.
        let undated = json!({ "id": "x", "tier": "short" });
        let kept = retain_snapshots(
            &[at(0, Some("week")), undated],
            STARTED + WEEK_INTERVAL_MS * 9,
        );
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0]["id"], "x");
        assert_eq!(kept[0]["tier"], "short");
        assert_eq!(kept[0]["ext"], ".md");
        // A non-string id is dropped.
        assert!(retain_snapshots(
            &[json!({ "id": 5, "createdAt": "2026-03-01T00:00:00.000Z" })],
            STARTED
        )
        .is_empty());
        assert_eq!(snapshot_extension("Mathe/Seite.FAMD"), ".famd");
        assert_eq!(snapshot_extension("Mathe.famd/Seite"), ".md");
        assert_eq!(snapshot_extension("Mathe\\Seite.famd"), ".famd");
    }
}
