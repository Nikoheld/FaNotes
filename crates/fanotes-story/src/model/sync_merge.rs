//! Story scenes in sync: the scene part of `src/writing/syncMerge.ts`.
//!
//! When this device and another one both changed `X.story/scenes/<id>.json`,
//! the sync engine merges the two versions paragraph by paragraph instead of
//! keeping a whole-file conflict copy ([`merge_story_scene`]). Before a much
//! smaller scene is uploaded it is checked against the server's version
//! ([`judge_story_shrink`]). Both read the files as the TypeScript engine does
//! (`TextDecoder` + `JSON.parse` + `mergeableScene`); a file that is not a
//! mergeable scene is never merged. Shared fixtures:
//! `fanotes/scripts/fixtures/writing-sync/cases.json`.
//!
//! Manifest (`story.json`) and bible files are not merged here: the engine
//! keeps both versions as files for them (no data is lost). A much smaller
//! manifest is only uploaded when it is provably the editor's own newer save.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::OnceLock;

use crate::js::cmp16;
use crate::json::{self, JsMap, JsValue, ToJs};

use super::ids::IdSource;
use super::merge::merge_scenes;
use super::sanitize::sanitize_scene;
use super::types::{Scene, SCENE_FORMAT, STORY_FORMAT};

/// `StoryRole` of `syncMerge.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoryRole {
    Manifest,
    Scene,
    Entity,
    Note,
    Progress,
    Snapshot,
    Other,
}

fn story_root() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    // `/^(.+?\.story)\/(.+)$/iu`
    PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^(.+?\.story)/(.+)$").expect("story root"))
}

fn id_file(relative: &str, prefix: &str, suffix: &str) -> bool {
    relative
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(suffix))
        .is_some_and(|id| {
            (6..=40).contains(&id.len())
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        })
}

/// `storyRoleOf(path)`: `None` outside a `.story` folder.
pub fn story_role(path: &str) -> Option<StoryRole> {
    let captures = story_root().captures(path)?;
    let relative = captures.get(2)?.as_str();
    Some(if relative == "story.json" {
        StoryRole::Manifest
    } else if id_file(relative, "scenes/", ".json") {
        StoryRole::Scene
    } else if ["characters", "places", "events"]
        .iter()
        .any(|kind| id_file(relative, &format!("bible/{kind}/"), ".json"))
    {
        StoryRole::Entity
    } else if id_file(relative, "bible/notes/", ".md") {
        StoryRole::Note
    } else if relative.starts_with("progress/") {
        StoryRole::Progress
    } else if relative.starts_with("snapshots/") {
        StoryRole::Snapshot
    } else {
        StoryRole::Other
    })
}

/// `parse(bytes)`: strict UTF-8 (a leading BOM is dropped, as `TextDecoder`
/// does), then `JSON.parse`; `None` when either fails.
fn parse(bytes: &[u8]) -> Option<JsValue> {
    let text = std::str::from_utf8(bytes).ok()?;
    json::parse(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()
}

fn is_vector(value: Option<&JsValue>) -> bool {
    value.and_then(JsValue::as_object).is_some_and(|vector| {
        vector
            .iter()
            .all(|(_, count)| matches!(count, JsValue::Number(n) if n.is_finite()))
    })
}

/// `mergeableScene(value, expectedId)`: every paragraph has a unique id, a
/// key, a style, a version vector and runs.
pub fn mergeable_scene(value: &JsValue, expected_id: Option<&str>) -> bool {
    let Some(scene) = value.as_object() else {
        return false;
    };
    let Some(id) = scene.get("id").and_then(JsValue::as_str) else {
        return false;
    };
    if scene.get("format").and_then(JsValue::as_str) != Some(SCENE_FORMAT) {
        return false;
    }
    let Some(paragraphs) = scene.get("paragraphs").and_then(JsValue::as_array) else {
        return false;
    };
    if expected_id.is_some_and(|expected| !expected.is_empty() && expected != id) {
        return false;
    }
    let mut seen = HashSet::new();
    for paragraph in paragraphs {
        let Some(paragraph) = paragraph.as_object() else {
            return false;
        };
        let text = |key: &str| paragraph.get(key).and_then(JsValue::as_str);
        let Some(id) = text("id") else {
            return false;
        };
        if text("key").is_none() || text("style").is_none() {
            return false;
        }
        if !is_vector(paragraph.get("v"))
            || paragraph.get("runs").and_then(JsValue::as_array).is_none()
            || !seen.insert(id)
        {
            return false;
        }
    }
    let record_or_missing = |key: &str| {
        scene
            .get(key)
            .is_none_or(|value| value.as_object().is_some())
    };
    record_or_missing("footnotes") && record_or_missing("comments")
}

/// A mergeable scene as the app reads it.
fn read_scene(bytes: &[u8], id: &str, ids: &mut dyn IdSource) -> Option<Scene> {
    let value = parse(bytes)?;
    if !mergeable_scene(&value, Some(id)) {
        return None;
    }
    sanitize_scene(&value, Some(id), ids)
}

/// `mergeById`: footnotes and comments by id; when both sides have one id, the
/// larger JSON wins on every device alike. Sorted by id.
fn merge_by_id<T: Clone + ToJs>(
    left: &Option<JsMap<T>>,
    right: &Option<JsMap<T>>,
) -> Option<JsMap<T>> {
    let mut out: Vec<(String, T, String)> = Vec::new();
    for side in [right, left].into_iter().flatten() {
        for (id, value) in side.iter() {
            let text = json::stringify(&value.to_js(), None);
            match out.iter_mut().find(|(known, _, _)| known == id) {
                Some(current) => {
                    if cmp16(&text, &current.2) == Ordering::Greater {
                        current.1 = value.clone();
                        current.2 = text;
                    }
                }
                None => out.push((id.clone(), value.clone(), text)),
            }
        }
    }
    out.sort_by(|(a, _, _), (b, _, _)| cmp16(a, b));
    let mut map = JsMap::new();
    for (id, value, _) in out {
        map.insert(id, value);
    }
    (!map.is_empty()).then_some(map)
}

/// `mergeSceneVersions(left, right)`: the paragraph merge plus deterministic
/// footnotes and comments. Returns the scene and the number of paragraphs
/// changed on both sides.
pub fn merge_scene_versions(left: &Scene, right: &Scene) -> (Scene, usize) {
    let result = merge_scenes(left, right);
    let scene = Scene {
        id: result.scene.id,
        paragraphs: result.scene.paragraphs,
        footnotes: merge_by_id(&left.footnotes, &right.footnotes),
        comments: merge_by_id(&left.comments, &right.comments),
    };
    (scene, result.conflicts)
}

/// What [`merge_story_scene`] decided.
#[derive(Clone, Debug, PartialEq)]
pub enum SceneSyncOutcome {
    /// Both versions merged into one file (`serializeScene`).
    Merged {
        bytes: Vec<u8>,
        /// The remote version already holds everything.
        same_as_remote: bool,
        same_as_local: bool,
        conflicts: usize,
    },
    /// The remote file is not a mergeable scene; the local one keeps the path.
    KeepLocal,
}

fn scene_id_of(path: &str) -> &str {
    let name = &path[path.rfind('/').map_or(0, |at| at + 1)..];
    name.strip_suffix(".json").unwrap_or(name)
}

/// The scene branch of `mergeStoryFile`. `None`: not a scene path, or the local
/// file is not a mergeable scene (the engine keeps a conflict copy).
pub fn merge_story_scene(
    path: &str,
    local: &[u8],
    remote: &[u8],
    ids: &mut dyn IdSource,
) -> Option<SceneSyncOutcome> {
    if story_role(path) != Some(StoryRole::Scene) {
        return None;
    }
    let id = scene_id_of(path);
    let mine = read_scene(local, id, ids)?;
    let Some(theirs) = read_scene(remote, id, ids) else {
        return Some(SceneSyncOutcome::KeepLocal);
    };
    let (scene, conflicts) = merge_scene_versions(&mine, &theirs);
    let text = scene.to_file();
    Some(SceneSyncOutcome::Merged {
        same_as_remote: text == theirs.to_file(),
        same_as_local: text == mine.to_file(),
        bytes: text.into_bytes(),
        conflicts,
    })
}

/// `ShrinkVerdict` of `judgeStoryShrink`.
#[derive(Clone, Debug, PartialEq)]
pub enum ShrinkVerdict {
    /// Every paragraph the server has is still here (live or as a tombstone).
    Cut,
    /// The local file lost paragraphs without a trace; upload this merge instead.
    Merge(Vec<u8>),
    /// Not provable: keep the guard.
    Guard,
}

/// `mergeableManifest(value)`: the story id, `updatedAt` and a binder of nodes
/// with ids (at most 12 levels). Returns the id and `updatedAt`.
fn mergeable_manifest(value: &JsValue) -> Option<(&str, &str)> {
    fn nodes_ok(nodes: &[JsValue], depth: usize) -> bool {
        depth < 12
            && nodes.iter().all(|node| {
                node.as_object().is_some_and(|node| {
                    node.get("id").and_then(JsValue::as_str).is_some()
                        && node.get("children").is_none_or(|children| {
                            children
                                .as_array()
                                .is_some_and(|children| nodes_ok(children, depth + 1))
                        })
                })
            })
    }
    let manifest = value.as_object()?;
    if manifest.get("format").and_then(JsValue::as_str) != Some(STORY_FORMAT) {
        return None;
    }
    let id = manifest.get("id").and_then(JsValue::as_str)?;
    let updated_at = manifest.get("updatedAt").and_then(JsValue::as_str)?;
    let binder = manifest.get("binder").and_then(JsValue::as_array)?;
    nodes_ok(binder, 0).then_some((id, updated_at))
}

/// `judgeStoryShrink(path, local, server)`. A scene that keeps every paragraph
/// of the server's version (deleted ones as tombstones) is a cut; one that lost
/// paragraphs is merged with the server's version. A manifest with the same
/// story id that is at least as new is a cut. Anything else (including an older
/// manifest, which the TypeScript engine merges) keeps the guard.
pub fn judge_story_shrink(
    path: &str,
    local: &[u8],
    server: &[u8],
    ids: &mut dyn IdSource,
) -> ShrinkVerdict {
    match story_role(path) {
        Some(StoryRole::Scene) => {}
        Some(StoryRole::Manifest) => {
            let (Some(mine), Some(theirs)) = (parse(local), parse(server)) else {
                return ShrinkVerdict::Guard;
            };
            return match (mergeable_manifest(&mine), mergeable_manifest(&theirs)) {
                (Some((mine_id, mine_at)), Some((their_id, their_at)))
                    if mine_id == their_id && cmp16(mine_at, their_at) != Ordering::Less =>
                {
                    ShrinkVerdict::Cut
                }
                _ => ShrinkVerdict::Guard,
            };
        }
        _ => return ShrinkVerdict::Guard,
    }
    let id = scene_id_of(path);
    let (Some(mine), Some(theirs)) = (read_scene(local, id, ids), read_scene(server, id, ids))
    else {
        return ShrinkVerdict::Guard;
    };
    let present: HashSet<&str> = mine
        .paragraphs
        .iter()
        .map(|paragraph| paragraph.id.as_str())
        .collect();
    if theirs
        .paragraphs
        .iter()
        .all(|paragraph| present.contains(paragraph.id.as_str()))
    {
        return ShrinkVerdict::Cut;
    }
    ShrinkVerdict::Merge(
        merge_scene_versions(&mine, &theirs)
            .0
            .to_file()
            .into_bytes(),
    )
}
