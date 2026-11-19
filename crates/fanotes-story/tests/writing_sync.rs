//! The scene merge of sync against the shared fixtures of the TypeScript and
//! Android engines: `fanotes/scripts/fixtures/writing-sync/cases.json`
//! (written by `node scripts/check-writing-sync.mjs --write`).

use fanotes_story::json::{self, JsValue};
use fanotes_story::model::ids::SeededIds;
use fanotes_story::{
    judge_story_shrink, merge_story_scene, story_role, SceneSyncOutcome, ShrinkVerdict, StoryRole,
};

fn cases() -> Vec<JsValue> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fanotes/scripts/fixtures/writing-sync/cases.json"
    );
    let text = std::fs::read_to_string(path).expect("writing-sync fixtures");
    match json::parse(&text).expect("cases.json") {
        JsValue::Array(cases) => cases,
        _ => panic!("cases.json is not a list"),
    }
}

fn file(value: &JsValue) -> Vec<u8> {
    format!("{}\n", json::stringify(value, None)).into_bytes()
}

fn merged(path: &str, local: &[u8], remote: &[u8]) -> (String, bool, bool) {
    match merge_story_scene(path, local, remote, &mut SeededIds::new(1)) {
        Some(SceneSyncOutcome::Merged {
            bytes,
            same_as_remote,
            same_as_local,
            ..
        }) => {
            let value = json::parse(std::str::from_utf8(&bytes).unwrap()).unwrap();
            (json::stringify(&value, None), same_as_remote, same_as_local)
        }
        other => panic!("{path}: {other:?}"),
    }
}

#[test]
fn scene_cases_merge_like_typescript_from_either_side() {
    let mut scenes = 0;
    for case in cases() {
        let name = case.get("name").and_then(JsValue::as_str).unwrap();
        let path = case.get("path").and_then(JsValue::as_str).unwrap();
        let (left, right) = (
            file(case.get("left").unwrap()),
            file(case.get("right").unwrap()),
        );
        if story_role(path) != Some(StoryRole::Scene) {
            // Manifests are not merged by the Rust engine: both versions stay as files.
            assert_eq!(story_role(path), Some(StoryRole::Manifest), "{name}");
            assert!(
                merge_story_scene(path, &left, &right, &mut SeededIds::new(1)).is_none(),
                "{name}"
            );
            continue;
        }
        scenes += 1;
        let expected = json::stringify(case.get("expected").unwrap(), None);
        let (forward, ..) = merged(path, &left, &right);
        assert_eq!(forward, expected, "{name}");
        let (backward, ..) = merged(path, &right, &left);
        assert_eq!(backward, expected, "{name}: same bytes from either side");
        // Merging the result with either input changes nothing more.
        let (again, same_as_remote, _) = merged(path, &left, expected.as_bytes());
        assert_eq!(again, expected, "{name}: idempotent");
        assert!(
            same_as_remote,
            "{name}: the merge already holds the local side"
        );
    }
    assert_eq!(scenes, 5);
}

#[test]
fn files_that_are_not_mergeable_scenes_are_left_to_the_engine() {
    let path = "Roman.story/scenes/scene000001.json";
    let scene = br#"{"format":"fanotes-story-scene-v1","id":"scene000001","paragraphs":[{"id":"para000001","key":"a0","v":{"a":1},"style":"body","runs":[{"text":"x"}]}]}"#;
    let mut ids = SeededIds::new(1);
    // A damaged local file: no merge (conflict copy). A damaged remote one: the local one stays.
    assert_eq!(merge_story_scene(path, b"{", scene, &mut ids), None);
    assert_eq!(
        merge_story_scene(path, scene, b"", &mut ids),
        Some(SceneSyncOutcome::KeepLocal)
    );
    let duplicate = br#"{"format":"fanotes-story-scene-v1","id":"scene000001","paragraphs":[{"id":"p","key":"a0","v":{},"style":"body","runs":[]},{"id":"p","key":"a1","v":{},"style":"body","runs":[]}]}"#;
    assert_eq!(
        merge_story_scene(path, scene, duplicate, &mut ids),
        Some(SceneSyncOutcome::KeepLocal)
    );
    let other_id = br#"{"format":"fanotes-story-scene-v1","id":"scene000002","paragraphs":[]}"#;
    assert_eq!(merge_story_scene(path, other_id, scene, &mut ids), None);
    // Not a scene path.
    assert_eq!(merge_story_scene("Notiz.md", scene, scene, &mut ids), None);
    assert_eq!(
        merge_story_scene("Roman.story/bible/notes/abcdef.md", scene, scene, &mut ids),
        None
    );
    assert_eq!(
        story_role("Ordner/Roman.STORY/scenes/abcdef12.json"),
        Some(StoryRole::Scene)
    );
    assert_eq!(
        story_role("Roman.story/progress/dev1.json"),
        Some(StoryRole::Progress)
    );
    assert_eq!(
        story_role("Roman.story/scenes/ABC.json"),
        Some(StoryRole::Other)
    );
    assert_eq!(story_role(".story/story.json"), None);
}

#[test]
fn a_shrunken_scene_is_a_cut_only_when_every_server_paragraph_is_still_there() {
    let path = "Roman.story/scenes/scene000001.json";
    let server = br#"{"format":"fanotes-story-scene-v1","id":"scene000001","paragraphs":[{"id":"para000001","key":"a0","v":{"a":1},"style":"body","runs":[{"text":"Eins"}]},{"id":"para000002","key":"a1","v":{"a":1},"style":"body","runs":[{"text":"Zwei"}]}]}"#;
    let cut = br#"{"format":"fanotes-story-scene-v1","id":"scene000001","paragraphs":[{"id":"para000001","key":"a0","v":{"a":1},"style":"body","runs":[{"text":"Eins"}]},{"id":"para000002","key":"a1","v":{"a":2},"style":"body","deleted":true,"runs":[]}]}"#;
    let lost = br#"{"format":"fanotes-story-scene-v1","id":"scene000001","paragraphs":[{"id":"para000001","key":"a0","v":{"a":1},"style":"body","runs":[{"text":"Eins"}]}]}"#;
    let mut ids = SeededIds::new(1);
    assert_eq!(
        judge_story_shrink(path, cut, server, &mut ids),
        ShrinkVerdict::Cut
    );
    match judge_story_shrink(path, lost, server, &mut ids) {
        ShrinkVerdict::Merge(bytes) => assert!(String::from_utf8(bytes).unwrap().contains("Zwei")),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        judge_story_shrink(path, b"", server, &mut ids),
        ShrinkVerdict::Guard
    );
    assert_eq!(
        judge_story_shrink("Roman.story/story.json", lost, server, &mut ids),
        ShrinkVerdict::Guard
    );
    let manifest = |id: &str, at: &str| {
        format!(r#"{{"format":"fanotes-story-v1","id":"{id}","updatedAt":"{at}","binder":[{{"id":"scene000001","kind":"scene"}}]}}"#).into_bytes()
    };
    let story = "Roman.story/story.json";
    let newer = manifest("story00001", "2030-01-02T00:00:00.000Z");
    let older = manifest("story00001", "2030-01-01T00:00:00.000Z");
    assert_eq!(
        judge_story_shrink(story, &newer, &older, &mut ids),
        ShrinkVerdict::Cut
    );
    assert_eq!(
        judge_story_shrink(story, &older, &older, &mut ids),
        ShrinkVerdict::Cut
    );
    assert_eq!(
        judge_story_shrink(story, &older, &newer, &mut ids),
        ShrinkVerdict::Guard
    );
    assert_eq!(
        judge_story_shrink(story, &manifest("story00002", "2031"), &older, &mut ids),
        ShrinkVerdict::Guard
    );
}
