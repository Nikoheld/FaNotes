//! Parity with the TypeScript engine: every output in `tests/fixtures/`
//! (written by `fanotes/scripts/gen-story-fixtures.mjs`) is reproduced exactly.

use std::collections::HashMap;
use std::sync::Arc;

use fanotes_story::js::{cmp16, len16, slice16};
use fanotes_story::json::{self, JsMap, JsValue, ToJs};
use fanotes_story::layout::hyphen::{Hyphenate, Hyphenator};
use fanotes_story::layout::linebreak::{
    caret_x, layout_paragraph, line_at, offset_at_x, LayoutInput, ResolvedStyle,
};
use fanotes_story::layout::paginate::{
    layout_manuscript, Hyphenators, LayoutCache, LayoutOptions, ManuscriptLayout,
};
use fanotes_story::model::defaults::{new_story, NewStoryOptions};
use fanotes_story::model::flow::build_flow;
use fanotes_story::model::ids::SeededIds;
use fanotes_story::model::keys::{is_valid_key, key_between, keys_between};
use fanotes_story::model::merge::{merge_scenes, stamp_edits};
use fanotes_story::model::runs::{delete_range, insert_text, runs_text};
use fanotes_story::model::sanitize::{sanitize_manifest, sanitize_runs, sanitize_scene};
use fanotes_story::model::types::*;
use fanotes_story::FixedMeasurer;

fn fixture(name: &str) -> JsValue {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    json::parse_with_depth(
        &std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{path}")),
        10_000,
    )
    .expect(name)
}

fn s(value: &JsValue) -> &str {
    value.as_str().expect("string")
}

/// Deep equality, object key order ignored, numbers compared as f64.
fn same(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Number(x), JsValue::Number(y)) => x == y || (x.is_nan() && y.is_nan()),
        (JsValue::Array(x), JsValue::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (JsValue::Object(x), JsValue::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

fn assert_same(rust: &JsValue, ts: &JsValue, what: &str) {
    if !same(rust, ts) {
        let (r, t) = (json::stringify(rust, None), json::stringify(ts, None));
        let at = r
            .bytes()
            .zip(t.bytes())
            .position(|(x, y)| x != y)
            .unwrap_or(r.len().min(t.len()));
        let from = at.saturating_sub(120);
        panic!(
            "{what} differs at byte {at}:\n rust: {}\n   ts: {}",
            r.get(from..(at + 120).min(r.len())).unwrap_or(&r),
            t.get(from..(at + 120).min(t.len())).unwrap_or(&t)
        );
    }
}

/// `canonical()` in the generator: sorted keys.
fn canonical(value: &JsValue) -> JsValue {
    match value {
        JsValue::Array(items) => JsValue::Array(items.iter().map(canonical).collect()),
        JsValue::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| cmp16(a, b));
            let mut out = JsMap::new();
            for key in keys {
                out.insert(key.clone(), canonical(map.get(key).unwrap()));
            }
            JsValue::Object(out)
        }
        other => other.clone(),
    }
}

fn fnv(value: &JsValue) -> String {
    let text = json::stringify(&canonical(value), None);
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn parse_scene(text: &str) -> Scene {
    sanitize_scene(&json::parse(text).unwrap(), None, &mut SeededIds::new(1)).expect("scene")
}

#[test]
fn keys_match() {
    let data = fixture("keys.json");
    let opt = |value: &JsValue| value.as_str().map(str::to_string);
    for case in data.get("cases").unwrap().as_array().unwrap() {
        let args = case.get("args").unwrap().as_array().unwrap();
        let (a, b) = (opt(&args[0]), opt(&args[1]));
        let rust = match s(case.get("fn").unwrap()) {
            "keyBetween" => key_between(a.as_deref(), b.as_deref()).map(JsValue::from),
            _ => keys_between(
                a.as_deref(),
                b.as_deref(),
                args[2].as_f64().unwrap() as usize,
            )
            .map(|list| JsValue::Array(list.into_iter().map(JsValue::from).collect())),
        };
        match (rust, case.get("out")) {
            (Ok(value), Some(expected)) => assert_same(&value, expected, &format!("{args:?}")),
            (Err(_), None) => {}
            (rust, expected) => panic!("{args:?}: rust {rust:?}, ts {expected:?}"),
        }
    }
    for pair in data.get("valid").unwrap().as_array().unwrap() {
        let pair = pair.as_array().unwrap();
        assert_eq!(
            JsValue::Bool(is_valid_key(s(&pair[0]))),
            pair[1],
            "{:?}",
            pair[0]
        );
    }
}

#[test]
fn sanitize_matches_byte_for_byte() {
    let data = fixture("sanitize.json");
    let mut count = 0;
    for case in data.get("cases").unwrap().as_array().unwrap() {
        let input = json::parse(s(case.get("input").unwrap())).unwrap();
        let rust = if s(case.get("kind").unwrap()) == "scene" {
            let mut ids = SeededIds::new(case.get("seed").unwrap().as_f64().unwrap() as u32);
            sanitize_scene(&input, case.get("expectedId").unwrap().as_str(), &mut ids)
                .map(|scene| scene.to_json())
        } else {
            sanitize_manifest(&input).map(|manifest| manifest.to_file())
        };
        assert_eq!(
            rust.as_deref(),
            case.get("output").unwrap().as_str(),
            "input {}",
            &s(case.get("input").unwrap())[..s(case.get("input").unwrap()).len().min(300)]
        );
        count += 1;
    }
    assert!(count > 20);
    // New projects, with the same seeded ids.
    let specs: [(&str, StoryLanguage, Option<PageSize>, Option<&str>); 6] = [
        ("Die Brücke", StoryLanguage::DeCh, None, None),
        (
            "  ",
            StoryLanguage::EnUs,
            Some(PageSize::Manuscript),
            Some("Jane Roe"),
        ),
        ("Letters", StoryLanguage::EnGb, Some(PageSize::Letter), None),
        ("Pocket", StoryLanguage::De, Some(PageSize::Pocket), None),
        ("Trade", StoryLanguage::EnUs, Some(PageSize::Trade), None),
        ("A4", StoryLanguage::De, Some(PageSize::A4), Some("")),
    ];
    for (entry, (title, language, size, author)) in data
        .get("newStories")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .zip(specs)
    {
        let mut ids = SeededIds::new(entry.get("seed").unwrap().as_f64().unwrap() as u32);
        let (manifest, scenes) = new_story(
            &NewStoryOptions {
                title,
                author,
                language,
                size,
                device_id: "dev1",
                now: "2026-11-15T12:00:00.000Z",
            },
            &mut ids,
        );
        assert_eq!(manifest.to_file(), s(entry.get("manifest").unwrap()));
        let files: Vec<String> = scenes.iter().map(Scene::to_file).collect();
        let expected: Vec<String> = entry
            .get("scenes")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| s(v).to_string())
            .collect();
        assert_eq!(files, expected);
    }
}

#[test]
fn merge_and_stamp_match() {
    let data = fixture("merge.json");
    for (index, case) in data
        .get("cases")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let left = parse_scene(s(case.get("left").unwrap()));
        let right = parse_scene(s(case.get("right").unwrap()));
        for (name, (a, b)) in [
            ("leftRight", (&left, &right)),
            ("rightLeft", (&right, &left)),
        ] {
            let merged = merge_scenes(a, b);
            let expected = case.get(name).unwrap();
            assert_eq!(
                merged.scene.to_file(),
                s(expected.get("json").unwrap()),
                "case {index} {name}"
            );
            assert_eq!(
                merged.conflicts as f64,
                expected.get("conflicts").unwrap().as_f64().unwrap(),
                "case {index} {name}"
            );
            assert_eq!(
                JsValue::Bool(merged.changed_from_left),
                *expected.get("changedFromLeft").unwrap(),
                "case {index} {name}"
            );
            assert_eq!(
                JsValue::Bool(merged.changed_from_right),
                *expected.get("changedFromRight").unwrap(),
                "case {index} {name}"
            );
        }
        let once = merge_scenes(&left, &right).scene;
        let again = merge_scenes(&parse_scene(&once.to_file()), &right);
        assert_eq!(
            again.scene.to_file(),
            s(case.get("againRight").unwrap()),
            "case {index} again"
        );
    }
    for (index, case) in data
        .get("stamps")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        // The inputs are sanitized scenes already (field order of the TS output kept as the reference).
        let current = parse_scene(s(case.get("current").unwrap()));
        let saved = case.get("saved").unwrap().as_str().map(parse_scene);
        let stamped = stamp_edits(&current, saved.as_ref(), s(case.get("writer").unwrap()));
        assert_same(
            &stamped.scene.to_js(),
            &json::parse(s(case.get("output").unwrap())).unwrap(),
            &format!("stamp {index}"),
        );
        assert_eq!(
            JsValue::Bool(stamped.changed),
            *case.get("changed").unwrap(),
            "stamp {index}"
        );
    }
}

#[test]
fn merge_scene_json_reads_files_and_guards_ids() {
    let data = fixture("merge.json");
    let case = &data.get("cases").unwrap().as_array().unwrap()[1];
    let (left, right) = (s(case.get("left").unwrap()), s(case.get("right").unwrap()));
    let merged = fanotes_story::merge_scene_json(left, right, Some(left)).unwrap();
    assert_eq!(
        merged.json,
        s(case.get("leftRight").unwrap().get("json").unwrap())
    );
    assert_eq!(merged.conflicts, 1);
    let other = left.replace("scene000001", "scene000002");
    assert!(fanotes_story::merge_scene_json(left, &other, None).is_err());
    assert!(fanotes_story::merge_scene_json(left, "{not json", None).is_err());
}

#[test]
fn flow_matches() {
    let data = fixture("flow.json");
    for case in data.get("cases").unwrap().as_array().unwrap() {
        let manifest =
            sanitize_manifest(&json::parse(s(case.get("manifest").unwrap())).unwrap()).unwrap();
        let scenes: HashMap<String, Scene> = json::parse(s(case.get("scenes").unwrap()))
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| {
                let scene = sanitize_scene(value, None, &mut SeededIds::new(1)).unwrap();
                (scene.id.clone(), scene)
            })
            .collect();
        let blocks = build_flow(&manifest, &scenes);
        assert_same(
            &blocks.to_js(),
            &json::parse(s(case.get("blocks").unwrap())).unwrap(),
            "flow",
        );
    }
}

#[test]
fn hyphenation_matches_the_npm_package() {
    let data = fixture("hyphen.json");
    let mut words = 0;
    for (language, list) in data.as_object().unwrap().iter() {
        let hyphenator = Hyphenator::for_language(match language.as_str() {
            "de" => StoryLanguage::De,
            "en-us" => StoryLanguage::EnUs,
            _ => StoryLanguage::EnGb,
        });
        for pair in list.as_array().unwrap() {
            let pair = pair.as_array().unwrap();
            let points = JsValue::Array(
                hyphenator
                    .points(s(&pair[0]))
                    .into_iter()
                    .map(JsValue::from)
                    .collect(),
            );
            assert_same(&points, &pair[1], &format!("{language} {:?}", pair[0]));
            words += 1;
        }
    }
    assert!(words > 5000, "{words}");
}

fn resolved_from(value: &JsValue) -> ResolvedStyle {
    let n = |key: &str| value.get(key).and_then(JsValue::as_f64).unwrap();
    let b = |key: &str| value.get(key).is_some_and(JsValue::is_true);
    ResolvedStyle {
        font: FontFamily::from_js(value.get("font")).unwrap(),
        size: n("size"),
        line_height: n("lineHeight"),
        space_before: n("spaceBefore"),
        space_after: n("spaceAfter"),
        indent_first: n("indentFirst"),
        indent_left: n("indentLeft"),
        indent_right: n("indentRight"),
        align: Align::from_js(value.get("align")).unwrap(),
        bold: b("bold"),
        italic: b("italic"),
        small_caps: b("smallCaps"),
        uppercase: b("uppercase"),
        color: value
            .get("color")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        keep_with_next: b("keepWithNext"),
        page_break_before: b("pageBreakBefore"),
        drop_cap: n("dropCap"),
        list_marker: value
            .get("listMarker")
            .and_then(JsValue::as_str)
            .map(str::to_string),
    }
}

fn hyphen_for(code: &str) -> Arc<Hyphenator> {
    Hyphenator::for_language(StoryLanguage::from_str(code).unwrap())
}

#[test]
fn line_breaking_matches() {
    let data = fixture("linebreak.json");
    let measurer = FixedMeasurer;
    for case in data.get("cases").unwrap().as_array().unwrap() {
        let name = s(case.get("name").unwrap());
        let input = case.get("input").unwrap();
        let runs = sanitize_runs(input.get("runs"));
        let style = resolved_from(case.get("style").unwrap());
        let hyphenator = input
            .get("hyphenate")
            .and_then(JsValue::as_str)
            .map(hyphen_for);
        let numbers = input
            .get("footnoteNumbers")
            .and_then(JsValue::as_object)
            .cloned();
        let number = move |id: &str| {
            numbers
                .as_ref()
                .and_then(|map| map.get(id))
                .and_then(JsValue::as_str)
                .unwrap_or("?")
                .to_string()
        };
        let has_numbers = input.get("footnoteNumbers").is_some();
        let layout = layout_paragraph(&LayoutInput {
            runs: &runs,
            style: &style,
            width: input.get("width").unwrap().as_f64().unwrap(),
            measurer: &measurer,
            hyphenator: hyphenator.as_deref().map(|h| h as &dyn Hyphenate),
            hyphenate: hyphenator.is_some(),
            footnote_number: if has_numbers { Some(&number) } else { None },
        });
        assert_same(&layout.to_js(), case.get("layout").unwrap(), name);
        for caret in case.get("carets").unwrap().as_array().unwrap() {
            let c: Vec<f64> = caret
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            let offset = c[0] as usize;
            let line = line_at(&layout, offset, false);
            let x = caret_x(&layout, line, offset, &measurer);
            let back = offset_at_x(&layout, line, x + 0.7, &measurer);
            assert_eq!(
                [
                    line as f64,
                    line_at(&layout, offset, true) as f64,
                    x,
                    back as f64
                ],
                [c[1], c[2], c[3], c[4]],
                "{name} caret {offset}"
            );
        }
    }
}

// ── Pagination ─────────────────────────────────────────────────────────────

const LOREM: &str = "Der alte Leuchtturmwärter stieg jeden Abend die hundertzwölf Stufen hinauf, zündete das Licht an und sah hinaus auf das dunkle Wasser, über dem der Wind die Wolken jagte.";

fn marks(f: impl FnOnce(&mut Marks)) -> Marks {
    let mut m = Marks::default();
    f(&mut m);
    m
}

/// `novel()` in the generator: the scenes (the manifest comes from the fixture).
pub fn novel_scenes(
    chapters: usize,
    paragraphs: usize,
    extras: bool,
) -> (Vec<String>, HashMap<String, Scene>) {
    let mut order = Vec::new();
    let mut scenes = HashMap::new();
    let mut counter = 0usize;
    let sentence_length = len16(LOREM);
    for chapter in 0..chapters {
        let parts = if extras && chapter % 3 == 1 { 2 } else { 1 };
        for part in 0..parts {
            let id = format!("scene{chapter:05}{part}");
            let count = if parts == 2 {
                paragraphs.div_ceil(2)
            } else {
                paragraphs
            };
            let keys = keys_between(None, None, count).unwrap();
            let mut scene = Scene {
                id: id.clone(),
                ..Scene::default()
            };
            for (index, key) in keys.into_iter().enumerate() {
                counter += 1;
                let text = format!(
                    "{LOREM} {}",
                    slice16(LOREM, 0, (counter * 37) % sentence_length)
                );
                let mut style = if index == 0 { "first" } else { "body" };
                let mut runs = vec![Run::new(text.clone())];
                let mut paragraph = Paragraph {
                    id: format!("para{counter:08}"),
                    key,
                    style: String::new(),
                    ..Paragraph::default()
                };
                paragraph.v.insert("A", 1.0);
                if extras {
                    if counter.is_multiple_of(41) {
                        let note = format!("note{counter:06}");
                        runs = vec![
                            Run::new(slice16(&text, 0, 40)),
                            Run::with_marks("", marks(|m| m.fn_ = Some(note.clone()))),
                            Run::new(slice16(&text, 40, usize::MAX)),
                        ];
                        let body = Footnote {
                            id: note.clone(),
                            runs: vec![Run::new(format!(
                                "Anmerkung {counter}: {}",
                                slice16(LOREM, 0, counter % 120)
                            ))],
                        };
                        scene
                            .footnotes
                            .get_or_insert_with(JsMap::new)
                            .insert(note, body);
                    }
                    if counter.is_multiple_of(29) {
                        runs = vec![
                            Run::new("Kapitälchen und "),
                            Run::with_marks("Hochgestellt", marks(|m| m.sup = true)),
                            Run::with_marks(" fett", marks(|m| m.b = true)),
                            Run::with_marks(format!(" {text}"), marks(|m| m.sc = true)),
                        ];
                    }
                    for (every, name) in [
                        (23, "dialogue"),
                        (31, "heading"),
                        (37, "list"),
                        (43, "quote"),
                    ] {
                        if counter.is_multiple_of(every) {
                            style = name;
                        }
                    }
                    if counter.is_multiple_of(47) {
                        runs = vec![Run::new(format!("Zeile eins\nZeile zwei {text}"))];
                    }
                    if counter.is_multiple_of(53) {
                        runs = vec![Run::new(format!(
                            "{} {text}",
                            "Donaudampfschifffahrtsgesellschaftskapitän".repeat(3)
                        ))];
                    }
                    if counter.is_multiple_of(59) {
                        runs = vec![Run::with_marks(
                            format!("Größer {}", slice16(&text, 0, 60)),
                            marks(|m| m.size = Some(16.0)),
                        )];
                    }
                    paragraph.break_before = counter.is_multiple_of(67);
                    if counter.is_multiple_of(71) {
                        paragraph.align = Some(Align::Center);
                    }
                    if counter.is_multiple_of(73) {
                        paragraph.lang = Some(StoryLanguage::EnUs);
                    }
                }
                paragraph.style = style.into();
                paragraph.runs = runs;
                scene.paragraphs.push(paragraph);
            }
            order.push(id.clone());
            scenes.insert(id, scene);
        }
    }
    (order, scenes)
}

fn footnote_lookup(scenes: &HashMap<String, Scene>) -> HashMap<String, Vec<Run>> {
    scenes
        .values()
        .flat_map(|scene| {
            scene.footnotes.iter().flat_map(|notes| {
                notes
                    .iter()
                    .map(|(id, note)| (id.clone(), note.runs.clone()))
            })
        })
        .collect()
}

fn layout_story(
    manifest: &StoryManifest,
    scenes: &HashMap<String, Scene>,
    cache: &mut LayoutCache,
    previous: Option<&ManuscriptLayout>,
    hyphenators: &Hyphenators,
) -> ManuscriptLayout {
    let notes = footnote_lookup(scenes);
    let lookup = |id: &str| notes.get(id).cloned();
    let blocks = Arc::new(build_flow(manifest, scenes));
    layout_manuscript(
        manifest,
        blocks,
        cache,
        &LayoutOptions {
            measurer: &FixedMeasurer,
            hyphenators: Some(hyphenators),
            footnote_runs: Some(&lookup),
        },
        previous,
    )
}

/// `briefPages()` in the generator.
fn brief_pages(result: &ManuscriptLayout) -> JsValue {
    let n = |x: f64| JsValue::Number(x);
    JsValue::Array(
        result
            .pages
            .iter()
            .map(|page| {
                let full = page.to_js();
                JsValue::Array(vec![
                    JsValue::from(page.number.as_str()),
                    JsValue::from(page.side.as_str()),
                    n(if page.blank { 1.0 } else { 0.0 }),
                    JsValue::from(page.chapter_title.as_str()),
                    full.get("header").unwrap().clone(),
                    full.get("footer").unwrap().clone(),
                    full.get("content").unwrap().clone(),
                    JsValue::Array(
                        page.lines
                            .iter()
                            .map(|line| {
                                JsValue::Array(vec![
                                    n(line.block_index as f64),
                                    n(line.line_index as f64),
                                    n(line.x),
                                    n(line.y),
                                ])
                            })
                            .collect(),
                    ),
                    JsValue::Array(
                        page.drop_caps
                            .iter()
                            .map(|cap| {
                                JsValue::Array(vec![n(cap.block_index as f64), n(cap.x), n(cap.y)])
                            })
                            .collect(),
                    ),
                    JsValue::Array(
                        page.footnotes
                            .iter()
                            .map(|note| {
                                JsValue::Array(vec![
                                    JsValue::from(note.id.as_str()),
                                    JsValue::from(note.number.as_str()),
                                    n(note.x),
                                    n(note.y),
                                    JsValue::from(fnv(&note.layout.to_js())),
                                ])
                            })
                            .collect(),
                    ),
                ])
            })
            .collect(),
    )
}

fn block_pages(result: &ManuscriptLayout) -> JsValue {
    JsValue::Array(
        result
            .block_pages
            .iter()
            .map(|&page| JsValue::from(page))
            .collect(),
    )
}

fn check_story(case: &JsValue, name: &str, hyphenators: &Hyphenators) {
    let spec = case.get("spec").unwrap();
    let manifest =
        sanitize_manifest(&json::parse(s(case.get("manifest").unwrap())).unwrap()).unwrap();
    let (_, scenes) = novel_scenes(
        spec.get("chapters").unwrap().as_f64().unwrap() as usize,
        spec.get("paragraphs").unwrap().as_f64().unwrap() as usize,
        spec.get("extras").is_some_and(JsValue::is_true),
    );
    let result = layout_story(
        &manifest,
        &scenes,
        &mut LayoutCache::new(),
        None,
        hyphenators,
    );
    let hashes: Vec<String> = result
        .layouts
        .iter()
        .map(|layout| fnv(&layout.to_js()))
        .collect();
    let expected: Vec<&str> = case
        .get("layoutHashes")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(s)
        .collect();
    assert_eq!(hashes.len(), expected.len(), "{name}: blocks");
    if let Some(first) = hashes.iter().zip(&expected).position(|(a, b)| a != b) {
        let firsts = case.get("firstLayouts").and_then(JsValue::as_array);
        if let Some(ts) = firsts.and_then(|list| list.get(first)) {
            assert_same(
                &result.layouts[first].to_js(),
                ts,
                &format!("{name} layout {first}"),
            );
        }
        panic!("{name}: layout of block {first} differs");
    }
    if let Some(firsts) = case.get("firstLayouts").and_then(JsValue::as_array) {
        for (index, ts) in firsts.iter().enumerate() {
            assert_same(
                &result.layouts[index].to_js(),
                ts,
                &format!("{name} layout {index}"),
            );
        }
    }
    let brief = brief_pages(&result);
    let ts_pages = case.get("briefPages").unwrap().as_array().unwrap();
    for (index, (rust, ts)) in brief.as_array().unwrap().iter().zip(ts_pages).enumerate() {
        assert_same(rust, ts, &format!("{name} page {index}"));
    }
    assert_eq!(result.pages.len(), ts_pages.len(), "{name}: pages");
    assert_same(
        &block_pages(&result),
        case.get("blockPages").unwrap(),
        &format!("{name} blockPages"),
    );
    assert_eq!(result.header_key, s(case.get("headerKey").unwrap()));
    if let Some(numbers) = case.get("footnoteNumbers") {
        let rust = JsValue::Array(
            result
                .footnote_numbers
                .iter()
                .map(|(id, number)| {
                    JsValue::Array(vec![
                        JsValue::from(id.as_str()),
                        JsValue::from(number.as_str()),
                    ])
                })
                .collect(),
        );
        assert_same(&rust, numbers, &format!("{name} footnote numbers"));
        let geometry = JsValue::Array(vec![
            JsValue::Number(result.page_width),
            JsValue::Number(result.page_height),
            JsValue::Number(result.content_width),
        ]);
        assert_same(
            &geometry,
            case.get("geometry").unwrap(),
            &format!("{name} geometry"),
        );
    }
}

#[test]
fn pagination_matches() {
    let data = fixture("paginate.json");
    let hyphenators = Hyphenators::bundled();
    for case in data.get("cases").unwrap().as_array().unwrap() {
        check_story(
            case,
            s(case.get("spec").unwrap().get("name").unwrap()),
            &hyphenators,
        );
    }
}

#[test]
fn pagination_of_a_300_page_story_matches() {
    let data = fixture("paginate.json");
    let big = data.get("big").unwrap();
    assert!(big.get("pages").unwrap().as_f64().unwrap() >= 300.0);
    check_story(big, "big", &Hyphenators::bundled());
}

#[test]
fn incremental_pagination_matches_step_by_step() {
    let data = fixture("paginate.json");
    let steps = data.get("incremental").unwrap().as_array().unwrap();
    let head = &steps[0];
    let manifest =
        sanitize_manifest(&json::parse(s(head.get("manifest").unwrap())).unwrap()).unwrap();
    let (_, mut scenes) = novel_scenes(6, 25, true);
    let hyphenators = Hyphenators::bundled();
    let mut cache = LayoutCache::new();
    let mut previous = layout_story(&manifest, &scenes, &mut cache, None, &hyphenators);
    for (step, edit) in steps[1..].iter().enumerate() {
        let scene_id = s(edit.get("scene").unwrap()).to_string();
        let index = edit.get("index").unwrap().as_f64().unwrap() as usize;
        let mut scene = scenes[&scene_id].clone();
        let num = |key: &str| edit.get(key).unwrap().as_f64().unwrap() as usize;
        match s(edit.get("op").unwrap()) {
            "insert" => {
                let target = &mut scene.paragraphs[index];
                target.runs =
                    insert_text(&target.runs, num("at"), s(edit.get("text").unwrap()), None);
            }
            "remove" => {
                scene.paragraphs.remove(index);
            }
            "add" => {
                let paragraph = Paragraph {
                    id: s(edit.get("id").unwrap()).into(),
                    key: s(edit.get("key").unwrap()).into(),
                    style: "body".into(),
                    runs: vec![Run::new("Ein eingefügter Absatz.")],
                    ..Paragraph::default()
                };
                scene.paragraphs.insert(index + 1, paragraph);
            }
            _ => {
                let target = &mut scene.paragraphs[index];
                assert!(num("to") <= len16(&runs_text(&target.runs)));
                target.runs = delete_range(&target.runs, 0, num("to"));
            }
        }
        scenes.insert(scene_id, scene);
        let next = layout_story(
            &manifest,
            &scenes,
            &mut cache,
            Some(&previous),
            &hyphenators,
        );
        let full = layout_story(
            &manifest,
            &scenes,
            &mut LayoutCache::new(),
            None,
            &hyphenators,
        );
        assert_eq!(
            next.pages.len() as f64,
            edit.get("pages").unwrap().as_f64().unwrap(),
            "step {step}: pages"
        );
        assert_eq!(
            fnv(&brief_pages(&next)),
            s(edit.get("hash").unwrap()),
            "step {step}: pages differ from TypeScript"
        );
        assert_eq!(
            fnv(&block_pages(&next)),
            s(edit.get("blockPages").unwrap()),
            "step {step}: blockPages"
        );
        assert_eq!(
            next.stats.repaginated_pages as f64,
            edit.get("repaginated").unwrap().as_f64().unwrap(),
            "step {step}: re-paginated pages"
        );
        assert!(
            same(&brief_pages(&next), &brief_pages(&full)),
            "step {step}: incremental differs from a full pass"
        );
        previous = next;
    }
}

/// Timing: `cargo test --release -p fanotes-story --test fixtures -- --ignored --nocapture timing`.
/// The same 599-page story as the TypeScript timing in `meta.json`.
#[test]
#[ignore]
fn timing_600_pages() {
    use std::time::Instant;
    let (mut manifest, _) = new_story(
        &NewStoryOptions {
            title: "Roman",
            author: Some("Autorin"),
            language: StoryLanguage::De,
            size: Some(PageSize::A5),
            device_id: "dev1",
            now: "2026-11-15T00:00:00.000Z",
        },
        &mut SeededIds::new(77),
    );
    manifest.page.chapter_starts_right = true;
    manifest.styles.get_mut("first").unwrap().drop_cap = Some(3.0);
    let (order, mut scenes) = novel_scenes(27, 120, true);
    manifest.binder = (0..27)
        .map(|chapter| {
            let mut node = BinderNode::new(
                format!("chapter{chapter:06}"),
                BinderKind::Chapter,
                format!("Kapitel {}", chapter + 1),
            );
            node.children = Some(
                order
                    .iter()
                    .filter(|id| id.starts_with(&format!("scene{chapter:05}")))
                    .map(|id| BinderNode::new(id.clone(), BinderKind::Scene, "Szene"))
                    .collect(),
            );
            node
        })
        .collect();
    let hyphenators = Hyphenators::bundled();
    let mut full = Vec::new();
    let mut pages = 0;
    for _ in 0..5 {
        let started = Instant::now();
        pages = layout_story(
            &manifest,
            &scenes,
            &mut LayoutCache::new(),
            None,
            &hyphenators,
        )
        .pages
        .len();
        full.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let mut cache = LayoutCache::new();
    let mut previous = layout_story(&manifest, &scenes, &mut cache, None, &hyphenators);
    let (mut keystroke, mut paginate_only, mut repaginated) = (Vec::new(), Vec::new(), 0);
    for _ in 0..20 {
        let scene = scenes.get_mut("scene000130").unwrap();
        let target = &mut scene.paragraphs[50];
        target.runs = insert_text(&target.runs, 10, "x", None);
        let started = Instant::now();
        let next = layout_story(
            &manifest,
            &scenes,
            &mut cache,
            Some(&previous),
            &hyphenators,
        );
        keystroke.push(started.elapsed().as_secs_f64() * 1000.0);
        paginate_only.push(next.stats.layout_ms + next.stats.paginate_ms);
        repaginated = next.stats.repaginated_pages;
        previous = next;
    }
    let median = |list: &mut Vec<f64>| {
        list.sort_by(|a, b| a.partial_cmp(b).unwrap());
        list[list.len() / 2]
    };
    println!("TIMING pages={pages} full_median_ms={:.1} full_runs={:?} keystroke_median_ms={:.2} (layout+paginate {:.2}) repaginated={repaginated}", median(&mut full), full.iter().map(|v| v.round()).collect::<Vec<_>>(), median(&mut keystroke), median(&mut paginate_only));
}
