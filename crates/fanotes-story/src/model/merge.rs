//! Paragraph-level merge of two versions of one scene, for sync (`model/merge.ts`).
//!
//! For each paragraph id: a dominating version vector wins; concurrent edits
//! keep both versions (the other one as a new paragraph marked `conflictOf`);
//! an edit concurrent with a delete keeps the edit; a paragraph present on one
//! side only is kept. The result does not depend on which side is "local", so
//! two devices that merge each other's versions converge, and no text is lost.

use std::collections::{HashMap, HashSet};

use super::ids::IdSource;
use super::sanitize::{sanitize_scene, sort_paragraphs};
use super::types::{Paragraph, Scene, Vector};
use crate::js::cmp16;
use crate::json::{self, JsMap, JsValue, ToJs};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorOrder {
    Equal,
    /// The left vector dominates.
    Left,
    Right,
    Concurrent,
}

/// `compareVectors`.
pub fn compare_vectors(left: &Vector, right: &Vector) -> VectorOrder {
    let mut left_ahead = false;
    let mut right_ahead = false;
    for device in left.keys().chain(right.keys()) {
        let a = left.get(device).copied().unwrap_or(0.0);
        let b = right.get(device).copied().unwrap_or(0.0);
        if a > b {
            left_ahead = true;
        }
        if b > a {
            right_ahead = true;
        }
    }
    match (left_ahead, right_ahead) {
        (true, true) => VectorOrder::Concurrent,
        (true, false) => VectorOrder::Left,
        (false, true) => VectorOrder::Right,
        (false, false) => VectorOrder::Equal,
    }
}

/// `mergeVectors`: the element-wise maximum, left's keys first.
pub fn merge_vectors(left: &Vector, right: &Vector) -> Vector {
    let mut out = left.clone();
    for (device, count) in right.iter() {
        let current = out.get(device).copied().unwrap_or(0.0);
        out.insert(device.clone(), crate::js::max(current, *count));
    }
    out
}

/// `content(paragraph)`: what a merge compares (not the id, key or vector).
pub fn paragraph_content(paragraph: &Paragraph) -> String {
    let value = JsValue::Array(vec![
        JsValue::Number(if paragraph.deleted { 1.0 } else { 0.0 }),
        JsValue::from(paragraph.style.as_str()),
        JsValue::from(paragraph.align.map(|align| align.as_str()).unwrap_or("")),
        JsValue::from(paragraph.lang.map(|lang| lang.as_str()).unwrap_or("")),
        JsValue::from(if paragraph.break_before { "page" } else { "" }),
        paragraph.runs.to_js(),
    ]);
    json::stringify(&value, None)
}

fn vector_sum(vector: &Vector) -> f64 {
    vector.values().fold(0.0, |sum, count| sum + count)
}

/// `shortHash`: FNV-1a over UTF-16 units, base 36, at least 7 characters.
pub fn short_hash(value: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in value.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let mut digits = Vec::new();
    let mut rest = hash;
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(rest % 36) as usize]);
        rest /= 36;
        if rest == 0 {
            break;
        }
    }
    while digits.len() < 7 {
        digits.push(b'0');
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii")
}

/// `new Map(paragraphs.map((p) => [p.id, p]))`: the last duplicate wins, the first position stays.
struct ById<'a> {
    order: Vec<&'a str>,
    map: HashMap<&'a str, &'a Paragraph>,
}

impl<'a> ById<'a> {
    fn new(paragraphs: &'a [Paragraph]) -> ById<'a> {
        let mut order = Vec::new();
        let mut map = HashMap::new();
        for paragraph in paragraphs {
            if map.insert(paragraph.id.as_str(), paragraph).is_none() {
                order.push(paragraph.id.as_str());
            }
        }
        ById { order, map }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SceneMerge {
    pub scene: Scene,
    /// Paragraphs changed on both sides (both versions kept).
    pub conflicts: usize,
    /// The merged paragraphs differ from the left / right input.
    pub changed_from_left: bool,
    pub changed_from_right: bool,
}

fn paragraphs_json(scene: &Scene) -> String {
    json::stringify(&scene.paragraphs.to_js(), None)
}

/// `{ ...right, ...left }` for footnotes and comments.
fn merge_records<T: Clone>(left: &Option<JsMap<T>>, right: &Option<JsMap<T>>) -> Option<JsMap<T>> {
    let mut out = JsMap::new();
    for side in [right, left].into_iter().flatten() {
        for (key, value) in side.iter() {
            out.insert(key.clone(), value.clone());
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `mergeScenes(left, right)`.
pub fn merge_scenes(left: &Scene, right: &Scene) -> SceneMerge {
    let left_by_id = ById::new(&left.paragraphs);
    let right_by_id = ById::new(&right.paragraphs);
    let mut merged: Vec<Paragraph> = Vec::new();
    let mut conflicts = 0;
    let mut seen: HashSet<&str> = HashSet::new();
    for &id in left_by_id.order.iter().chain(right_by_id.order.iter()) {
        if !seen.insert(id) {
            continue;
        }
        let (a, b) = match (left_by_id.map.get(id), right_by_id.map.get(id)) {
            (Some(a), Some(b)) => (*a, *b),
            (Some(only), None) | (None, Some(only)) => {
                merged.push((*only).clone());
                continue;
            }
            (None, None) => continue,
        };
        let order = compare_vectors(&a.v, &b.v);
        let content_a = paragraph_content(a);
        let content_b = paragraph_content(b);
        if order == VectorOrder::Left || (order == VectorOrder::Equal && content_a == content_b) {
            merged.push(a.clone());
            continue;
        }
        if order == VectorOrder::Right {
            merged.push(b.clone());
            continue;
        }
        if content_a == content_b {
            merged.push(Paragraph {
                v: merge_vectors(&a.v, &b.v),
                ..a.clone()
            });
            continue;
        }
        // Both changed it. An edit wins over a delete; two edits are both kept.
        if a.deleted || b.deleted {
            let kept = if a.deleted { b } else { a };
            merged.push(Paragraph {
                v: merge_vectors(&a.v, &b.v),
                ..kept.clone()
            });
            continue;
        }
        let sums = vector_sum(&a.v) - vector_sum(&b.v);
        let left_wins = if sums != 0.0 {
            sums > 0.0
        } else {
            cmp16(&content_a, &content_b).is_ge()
        };
        let (winner, other, other_content) = if left_wins {
            (a, b, &content_b)
        } else {
            (b, a, &content_a)
        };
        conflicts += 1;
        merged.push(Paragraph {
            v: merge_vectors(&a.v, &b.v),
            ..winner.clone()
        });
        let copy_id = format!(
            "{}x{}",
            crate::js::slice16(id, 0, 24),
            short_hash(other_content)
        );
        if !left_by_id.map.contains_key(copy_id.as_str())
            && !right_by_id.map.contains_key(copy_id.as_str())
        {
            let suffix = short_hash(&copy_id).trim_end_matches('0').to_string();
            let suffix = if suffix.is_empty() {
                "V".to_string()
            } else {
                suffix
            };
            merged.push(Paragraph {
                id: copy_id,
                key: format!("{}V{}", winner.key, suffix),
                conflict_of: Some(id.to_string()),
                ..other.clone()
            });
        }
    }
    sort_paragraphs(&mut merged);
    let scene = Scene {
        id: left.id.clone(),
        paragraphs: merged,
        footnotes: merge_records(&left.footnotes, &right.footnotes),
        comments: merge_records(&left.comments, &right.comments),
    };
    let merged_json = paragraphs_json(&scene);
    let changed_from_left = merged_json != paragraphs_json(left);
    let changed_from_right = merged_json != paragraphs_json(right);
    SceneMerge {
        scene,
        conflicts,
        changed_from_left,
        changed_from_right,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stamped {
    pub scene: Scene,
    /// `false`: nothing differed, `scene` equals the input (TypeScript returns the same object).
    pub changed: bool,
}

/// `stampEdits(current, saved, writer)`: bumps this writer's counter on every
/// paragraph that differs from the last saved version, and records deletes as tombstones.
pub fn stamp_edits(current: &Scene, saved: Option<&Scene>, writer: &str) -> Stamped {
    let saved_paragraphs: &[Paragraph] = saved
        .map(|scene| scene.paragraphs.as_slice())
        .unwrap_or(&[]);
    let before = ById::new(saved_paragraphs);
    let bump = |vector: &Vector| {
        let mut out = vector.clone();
        let count = out.get(writer).copied().unwrap_or(0.0) + 1.0;
        out.insert(writer, count);
        out
    };
    let mut changed = false;
    let mut paragraphs: Vec<Paragraph> = current
        .paragraphs
        .iter()
        .map(|paragraph| {
            let previous = before.map.get(paragraph.id.as_str()).copied();
            if let Some(previous) = previous {
                if previous.key == paragraph.key
                    && paragraph_content(previous) == paragraph_content(paragraph)
                {
                    if compare_vectors(&previous.v, &paragraph.v) == VectorOrder::Equal {
                        return paragraph.clone();
                    }
                    changed = true;
                    return Paragraph {
                        v: merge_vectors(&previous.v, &paragraph.v),
                        ..paragraph.clone()
                    };
                }
            }
            changed = true;
            let base = match previous {
                Some(previous) => merge_vectors(&previous.v, &paragraph.v),
                None => paragraph.v.clone(),
            };
            Paragraph {
                v: bump(&base),
                ..paragraph.clone()
            }
        })
        .collect();
    let present: HashSet<&str> = current
        .paragraphs
        .iter()
        .map(|paragraph| paragraph.id.as_str())
        .collect();
    for previous in saved_paragraphs {
        if present.contains(previous.id.as_str()) {
            continue;
        }
        changed = true;
        paragraphs.push(Paragraph {
            id: previous.id.clone(),
            key: previous.key.clone(),
            style: previous.style.clone(),
            runs: Vec::new(),
            deleted: true,
            v: bump(&previous.v),
            ..Paragraph::default()
        });
    }
    if !changed {
        return Stamped {
            scene: current.clone(),
            changed: false,
        };
    }
    sort_paragraphs(&mut paragraphs);
    Stamped {
        scene: Scene {
            paragraphs,
            ..current.clone()
        },
        changed: true,
    }
}

// ── JSON API for the sync engine ───────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeError {
    /// The named side is not JSON or not a `fanotes-story-scene-v1` scene.
    NotAScene(&'static str),
    /// The two sides (or the base) are different scenes.
    DifferentScenes { local: String, remote: String },
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::NotAScene(side) => {
                write!(f, "the {side} file is not a readable story scene")
            }
            MergeError::DifferentScenes { local, remote } => {
                write!(f, "scene ids differ: {local} / {remote}")
            }
        }
    }
}

impl std::error::Error for MergeError {}

/// The result of [`merge_scene_json`].
#[derive(Clone, Debug, PartialEq)]
pub struct MergedSceneJson {
    /// File content to write (`${JSON.stringify(scene)}\n`, as the TypeScript storage writes it).
    pub json: String,
    pub scene: Scene,
    pub conflicts: usize,
    /// Writing `json` locally changes the local paragraphs.
    pub changed_from_local: bool,
    /// Uploading `json` changes the remote paragraphs.
    pub changed_from_remote: bool,
}

fn read_side(
    text: &str,
    side: &'static str,
    expected_id: Option<&str>,
    ids: &mut dyn IdSource,
) -> Result<Scene, MergeError> {
    let value = json::parse(text).map_err(|_| MergeError::NotAScene(side))?;
    sanitize_scene(&value, expected_id, ids).ok_or(MergeError::NotAScene(side))
}

/// Merges two versions of `scenes/<id>.json` for sync: both files are read
/// like the app reads them (`JSON.parse` + `sanitizeScene`), then merged with
/// [`merge_scenes`] (local = left), so the result equals the TypeScript
/// `mergeScenes`.
///
/// `base` (the last version both sides had) is optional and does not change
/// the result: the paragraph version vectors already tell which side changed
/// what. When given, it must be the same scene; it guards against merging two
/// different files. Ids for unreadable paragraph ids come from `ids`.
pub fn merge_scene_json_with(
    local: &str,
    remote: &str,
    base: Option<&str>,
    expected_id: Option<&str>,
    ids: &mut dyn IdSource,
) -> Result<MergedSceneJson, MergeError> {
    let local_scene = read_side(local, "local", expected_id, ids)?;
    let remote_scene = read_side(remote, "remote", expected_id, ids)?;
    if local_scene.id != remote_scene.id {
        return Err(MergeError::DifferentScenes {
            local: local_scene.id,
            remote: remote_scene.id,
        });
    }
    if let Some(base) = base {
        if let Ok(value) = json::parse(base) {
            if let Some(base_id) = value.get("id").and_then(JsValue::as_str) {
                if base_id != local_scene.id {
                    return Err(MergeError::DifferentScenes {
                        local: local_scene.id,
                        remote: base_id.to_string(),
                    });
                }
            }
        }
    }
    let merge = merge_scenes(&local_scene, &remote_scene);
    Ok(MergedSceneJson {
        json: merge.scene.to_file(),
        scene: merge.scene,
        conflicts: merge.conflicts,
        changed_from_local: merge.changed_from_left,
        changed_from_remote: merge.changed_from_right,
    })
}

/// [`merge_scene_json_with`] with operating-system random ids.
#[cfg(feature = "os-random")]
pub fn merge_scene_json(
    local: &str,
    remote: &str,
    base: Option<&str>,
) -> Result<MergedSceneJson, MergeError> {
    merge_scene_json_with(local, remote, base, None, &mut super::ids::OsIds)
}
