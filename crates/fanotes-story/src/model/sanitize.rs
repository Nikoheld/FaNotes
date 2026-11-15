//! Reading project files (`model/sanitize.ts`): anything malformed is repaired
//! or dropped field by field, never thrown away as a whole, so a damaged scene
//! keeps every paragraph that is still readable.
//!
//! Same results as TypeScript on the same JSON, with one class of exception:
//! TypeScript looks some names up through `Object.prototype` (a style named
//! `constructor`, a page size `toString`/`constructor`/`__proto__`, or an
//! array as page size) and then produces values with missing fields. Here
//! those names are treated like any other unknown name.

use std::collections::HashSet;
use std::sync::OnceLock;

use super::defaults::{default_page_setup, default_styles};
use super::ids::{is_id, new_id, IdSource};
use super::keys::{is_valid_key, keys_between};
use super::runs::normalize_runs;
use super::types::*;
use crate::js::{self, cmp16, len16, locale_compare_ids, truncate16};
use crate::json::{JsMap, JsValue};

const MAX_TEXT: usize = 200_000;

/// `/^#[0-9a-f]{6}$/iu`.
fn is_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// `/^[a-z0-9-]{1,40}$/u`.
fn is_id_text(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// `styleId`: the id pattern, minus names of `Object.prototype` members (style
/// ids are object keys in TypeScript). `constructor` is the only such member
/// the pattern lets through.
fn is_style_id(value: &str) -> bool {
    is_id_text(value) && value != "constructor"
}

/// `/^[0-9a-z-]{1,40}$/u` (device ids).
fn is_device_id(value: &str) -> bool {
    is_id_text(value)
}

fn link_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    // `/^(https?:|mailto:)/iu`: Unicode case folding, as in JavaScript (`ſ` matches `s`).
    PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^(?:https?:|mailto:)").expect("link pattern"))
}

fn record(value: Option<&JsValue>) -> Option<&JsMap<JsValue>> {
    value.and_then(JsValue::as_object)
}

/// `text(value, max)`: a string cut to `max` UTF-16 units, else `''`.
fn text(value: Option<&JsValue>, max: usize) -> String {
    match value {
        Some(JsValue::String(content)) => truncate16(content, max),
        _ => String::new(),
    }
}

/// `number(value, min, max, fallback)`.
fn number(value: Option<&JsValue>, min: f64, max: f64, fallback: f64) -> f64 {
    match value {
        Some(JsValue::Number(n)) if n.is_finite() => js::min(max, js::max(min, *n)),
        _ => fallback,
    }
}

fn language(value: Option<&JsValue>) -> Option<StoryLanguage> {
    StoryLanguage::from_js(value)
}

fn string_of(value: Option<&JsValue>) -> Option<&str> {
    value.and_then(JsValue::as_str)
}

fn bool_of(value: Option<&JsValue>) -> Option<bool> {
    match value {
        Some(JsValue::Bool(flag)) => Some(*flag),
        _ => None,
    }
}

/// `sanitizeMarks`.
pub fn sanitize_marks(value: Option<&JsValue>) -> Option<Marks> {
    let source = record(value)?;
    let flag = |key: &str| source.get(key).is_some_and(JsValue::is_true);
    let mut marks = Marks {
        b: flag("b"),
        i: flag("i"),
        u: flag("u"),
        s: flag("s"),
        sc: flag("sc"),
        sup: flag("sup"),
        sub: flag("sub"),
        ..Marks::default()
    };
    marks.font = FontFamily::from_js(source.get("font"));
    if let Some(JsValue::Number(size)) = source.get("size") {
        if *size >= 4.0 && *size <= 144.0 {
            marks.size = Some(js::round(size * 2.0) / 2.0);
        }
    }
    if let Some(color) = string_of(source.get("color")).filter(|value| is_color(value)) {
        marks.color = Some(color.to_ascii_lowercase());
    }
    if let Some(color) = string_of(source.get("hl")).filter(|value| is_color(value)) {
        marks.hl = Some(color.to_ascii_lowercase());
    }
    if let Some(link) = string_of(source.get("link")) {
        if link_pattern().is_match(link) && len16(link) < 2000 {
            marks.link = Some(link.to_string());
        }
    }
    marks.fn_ = string_of(source.get("fn"))
        .filter(|id| is_id(id))
        .map(str::to_string);
    marks.cm = string_of(source.get("cm"))
        .filter(|id| is_id(id))
        .map(str::to_string);
    marks.lang = language(source.get("lang"));
    if marks.is_empty() {
        None
    } else {
        Some(marks)
    }
}

/// `.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')`.
fn clean_text(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => {}
            c => out.push(c),
        }
    }
    out
}

/// `sanitizeRuns`.
pub fn sanitize_runs(value: Option<&JsValue>) -> Vec<Run> {
    let Some(entries) = value.and_then(JsValue::as_array) else {
        return Vec::new();
    };
    let mut runs = Vec::new();
    let mut total = 0usize;
    for entry in entries.iter().take(20_000) {
        let Some(source) = entry.as_object() else {
            continue;
        };
        let content = clean_text(&text(source.get("text"), MAX_TEXT));
        total += len16(&content);
        if total > MAX_TEXT {
            break;
        }
        runs.push(Run {
            text: content,
            m: sanitize_marks(source.get("m")),
        });
    }
    normalize_runs(runs)
}

fn sanitize_vector(value: Option<&JsValue>) -> Vector {
    let mut out = Vector::new();
    let Some(source) = record(value) else {
        return out;
    };
    for (device, count) in source.iter().take(200) {
        if let JsValue::Number(count) = count {
            if is_device_id(device) && js::is_safe_integer(*count) && *count > 0.0 {
                out.insert(device.clone(), *count);
            }
        }
    }
    out
}

/// Sort by order key, then id (`sanitizeScene`, `mergeScenes`, `stampEdits`).
pub(crate) fn sort_paragraphs(paragraphs: &mut [Paragraph]) {
    paragraphs.sort_by(|left, right| {
        cmp16(&left.key, &right.key).then_with(|| locale_compare_ids(&left.id, &right.id))
    });
}

/// `sanitizeScene(value, expectedId)`. `ids` replaces `crypto.getRandomValues`
/// for paragraphs whose id is missing or repeated.
pub fn sanitize_scene(
    value: &JsValue,
    expected_id: Option<&str>,
    ids: &mut dyn IdSource,
) -> Option<Scene> {
    let source = value.as_object()?;
    if string_of(source.get("format")) != Some(SCENE_FORMAT) {
        return None;
    }
    let id = match string_of(source.get("id")).filter(|id| is_id(id)) {
        Some(id) => id.to_string(),
        None => expected_id.filter(|id| is_id(id))?.to_string(),
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let empty = Vec::new();
    let raw = source
        .get("paragraphs")
        .and_then(JsValue::as_array)
        .unwrap_or(&empty);
    let mut rekey = false;
    for entry in raw.iter().take(50_000) {
        let Some(paragraph) = entry.as_object() else {
            continue;
        };
        let mut pid = match string_of(paragraph.get("id")).filter(|id| is_id(id)) {
            Some(id) => id.to_string(),
            None => new_id(ids, 14),
        };
        if seen.contains(&pid) {
            pid = new_id(ids, 14);
        }
        seen.insert(pid.clone());
        let key = string_of(paragraph.get("key"))
            .filter(|key| is_valid_key(key))
            .unwrap_or("")
            .to_string();
        if key.is_empty() {
            rekey = true;
        }
        let deleted = paragraph.get("deleted").is_some_and(JsValue::is_true);
        paragraphs.push(Paragraph {
            id: pid,
            key,
            v: sanitize_vector(paragraph.get("v")),
            style: string_of(paragraph.get("style"))
                .filter(|style| is_style_id(style))
                .unwrap_or("body")
                .to_string(),
            runs: if deleted {
                Vec::new()
            } else {
                sanitize_runs(paragraph.get("runs"))
            },
            lang: language(paragraph.get("lang")),
            align: Align::from_js(paragraph.get("align")),
            break_before: string_of(paragraph.get("breakBefore")) == Some("page"),
            deleted,
            conflict_of: string_of(paragraph.get("conflictOf"))
                .filter(|id| is_id(id))
                .map(str::to_string),
        });
    }
    if rekey {
        // Keep the stored order and give every paragraph a fresh, valid key.
        let keys = keys_between(None, None, paragraphs.len()).unwrap_or_default();
        for (paragraph, key) in paragraphs.iter_mut().zip(keys) {
            paragraph.key = key;
        }
    } else {
        sort_paragraphs(&mut paragraphs);
    }
    let mut footnotes: JsMap<Footnote> = JsMap::new();
    if let Some(raw) = record(source.get("footnotes")) {
        for (fid, entry) in raw.iter().take(5000) {
            if let Some(note) = entry.as_object() {
                if is_id(fid) {
                    footnotes.insert(
                        fid.clone(),
                        Footnote {
                            id: fid.clone(),
                            runs: sanitize_runs(note.get("runs")),
                        },
                    );
                }
            }
        }
    }
    let mut comments: JsMap<Comment> = JsMap::new();
    if let Some(raw) = record(source.get("comments")) {
        for (cid, entry) in raw.iter().take(5000) {
            let Some(note) = entry.as_object() else {
                continue;
            };
            if !is_id(cid) {
                continue;
            }
            comments.insert(
                cid.clone(),
                Comment {
                    id: cid.clone(),
                    author: text(note.get("author"), 80),
                    at: text(note.get("at"), 40),
                    text: text(note.get("text"), 20_000),
                    resolved: note.get("resolved").is_some_and(JsValue::is_true),
                },
            );
        }
    }
    if !paragraphs.iter().any(|paragraph| !paragraph.deleted) {
        let last = paragraphs.last().map(|paragraph| paragraph.key.clone());
        let key = keys_between(last.as_deref(), None, 1)
            .ok()
            .and_then(|keys| keys.into_iter().next())
            .unwrap_or_else(|| "a0".into());
        paragraphs.push(Paragraph {
            id: new_id(ids, 14),
            key,
            v: Vector::new(),
            style: "first".into(),
            ..Paragraph::default()
        });
    }
    Some(Scene {
        id,
        paragraphs,
        footnotes: (!footnotes.is_empty()).then_some(footnotes),
        comments: (!comments.is_empty()).then_some(comments),
    })
}

fn sanitize_style(
    id: &str,
    value: Option<&JsValue>,
    fallback: Option<&ParagraphStyle>,
) -> Option<ParagraphStyle> {
    let Some(source) = record(value) else {
        return fallback.cloned();
    };
    let body;
    let base = match fallback {
        Some(base) => base,
        None => {
            body = default_styles(false)
                .get("body")
                .cloned()
                .expect("body style");
            &body
        }
    };
    let name = record(source.get("name"));
    let name_text = |key: &str, fallback: &str| {
        let value = text(name.and_then(|name| name.get(key)), 80);
        if value.is_empty() {
            fallback.to_string()
        } else {
            value
        }
    };
    let mut style = ParagraphStyle {
        id: id.to_string(),
        name: LocalName {
            de: name_text("de", &base.name.de),
            en: name_text("en", &base.name.en),
        },
        font: FontFamily::from_js(source.get("font")).unwrap_or(base.font),
        size: number(source.get("size"), 5.0, 96.0, base.size),
        line_height: number(source.get("lineHeight"), 0.8, 4.0, base.line_height),
        space_before: number(source.get("spaceBefore"), 0.0, 400.0, base.space_before),
        space_after: number(source.get("spaceAfter"), 0.0, 400.0, base.space_after),
        indent_first: number(source.get("indentFirst"), -50.0, 100.0, base.indent_first),
        indent_left: number(source.get("indentLeft"), 0.0, 100.0, base.indent_left),
        indent_right: number(source.get("indentRight"), 0.0, 100.0, base.indent_right),
        align: Align::from_js(source.get("align")).unwrap_or(base.align),
        bold: None,
        italic: None,
        small_caps: None,
        uppercase: None,
        keep_with_next: None,
        page_break_before: None,
        no_indent_after_break: None,
        color: None,
        drop_cap: None,
        next: None,
        list_marker: None,
        outline_level: None,
    };
    let flag = |key: &str, base: Option<bool>| -> Option<bool> {
        bool_of(source.get(key)).or(base).filter(|on| *on)
    };
    style.bold = flag("bold", base.bold);
    style.italic = flag("italic", base.italic);
    style.small_caps = flag("smallCaps", base.small_caps);
    style.uppercase = flag("uppercase", base.uppercase);
    style.keep_with_next = flag("keepWithNext", base.keep_with_next);
    style.page_break_before = flag("pageBreakBefore", base.page_break_before);
    style.no_indent_after_break = flag("noIndentAfterBreak", base.no_indent_after_break);
    if let Some(color) = string_of(source.get("color")).filter(|value| is_color(value)) {
        style.color = Some(color.to_string());
    }
    let drop_cap = number(
        source.get("dropCap"),
        0.0,
        6.0,
        base.drop_cap.unwrap_or(0.0),
    );
    if drop_cap != 0.0 {
        style.drop_cap = Some(js::round(drop_cap));
    }
    match string_of(source.get("next")).filter(|next| is_style_id(next)) {
        Some(next) => style.next = Some(next.to_string()),
        None => style.next = base.next.clone().filter(|next| !next.is_empty()),
    }
    let marker = match source.get("listMarker") {
        Some(JsValue::String(marker)) => Some(truncate16(marker, 4)),
        _ => base.list_marker.clone(),
    };
    style.list_marker = marker.filter(|marker| !marker.is_empty());
    let outline = number(
        source.get("outlineLevel"),
        0.0,
        6.0,
        base.outline_level.unwrap_or(0.0),
    );
    if outline != 0.0 {
        style.outline_level = Some(js::round(outline));
    }
    Some(style)
}

fn sanitize_page(value: Option<&JsValue>, language_code: StoryLanguage) -> PageSetup {
    let source = record(value);
    let size = match source.and_then(|source| string_of(source.get("size"))) {
        Some("custom") => PageSize::Custom,
        Some(name) => PageSize::from_str(name).unwrap_or(PageSize::A5),
        None => PageSize::A5,
    };
    let mut base = default_page_setup(size, language_code);
    base.size = size;
    let Some(source) = source else { return base };
    let margins = record(source.get("margins"));
    let margin = |key: &str, fallback: f64| {
        number(
            margins.and_then(|margins| margins.get(key)),
            0.0,
            100.0,
            fallback,
        )
    };
    let hf = |input: Option<&JsValue>, fallback: &HeaderFooter| match record(input) {
        Some(part) => HeaderFooter {
            left: text(part.get("left"), 200),
            center: text(part.get("center"), 200),
            right: text(part.get("right"), 200),
        },
        None => fallback.clone(),
    };
    let boolean = |key: &str, fallback: bool| bool_of(source.get(key)).unwrap_or(fallback);
    let scene_break = text(source.get("sceneBreak"), 40);
    PageSetup {
        size,
        width: number(source.get("width"), 50.0, 600.0, base.width),
        height: number(source.get("height"), 50.0, 900.0, base.height),
        margins: Margins {
            top: margin("top", base.margins.top),
            bottom: margin("bottom", base.margins.bottom),
            inner: margin("inner", base.margins.inner),
            outer: margin("outer", base.margins.outer),
        },
        mirror: boolean("mirror", base.mirror),
        header: hf(source.get("header"), &base.header),
        footer: hf(source.get("footer"), &base.footer),
        hide_on_chapter_start: boolean("hideOnChapterStart", base.hide_on_chapter_start),
        chapter_starts_right: boolean("chapterStartsRight", base.chapter_starts_right),
        page_number_start: js::round(number(
            source.get("pageNumberStart"),
            0.0,
            9999.0,
            base.page_number_start,
        )),
        header_offset: number(source.get("headerOffset"), 0.0, 60.0, base.header_offset),
        footer_offset: number(source.get("footerOffset"), 0.0, 60.0, base.footer_offset),
        widows_orphans: boolean("widowsOrphans", base.widows_orphans),
        hyphenate: boolean("hyphenate", base.hyphenate),
        scene_break: if scene_break.is_empty() {
            base.scene_break.clone()
        } else {
            scene_break
        },
    }
}

fn sanitize_binder(
    value: Option<&JsValue>,
    depth: usize,
    seen: &mut HashSet<String>,
) -> Vec<BinderNode> {
    let Some(entries) = value.and_then(JsValue::as_array) else {
        return Vec::new();
    };
    if depth > 6 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in entries.iter().take(5000) {
        let Some(source) = entry.as_object() else {
            continue;
        };
        let Some(id) = string_of(source.get("id")).filter(|id| is_id(id)) else {
            continue;
        };
        let Some(kind) = BinderKind::from_js(source.get("kind")) else {
            continue;
        };
        if seen.contains(id) {
            continue;
        }
        seen.insert(id.to_string());
        let mut node = BinderNode::new(id, kind, text(source.get("title"), 300));
        if kind != BinderKind::Scene {
            node.children = Some(sanitize_binder(source.get("children"), depth + 1, seen));
        }
        let synopsis = text(source.get("synopsis"), 5000);
        if !synopsis.is_empty() {
            node.synopsis = Some(synopsis);
        }
        node.status = SceneStatus::from_js(source.get("status"));
        node.label = string_of(source.get("label"))
            .filter(|label| is_color(label))
            .map(str::to_string);
        node.pov = string_of(source.get("pov"))
            .filter(|pov| is_id(pov))
            .map(str::to_string);
        node.exclude = source.get("exclude").is_some_and(JsValue::is_true);
        if let Some(JsValue::Number(goal)) = source.get("goal") {
            if *goal > 0.0 && *goal < 10_000_000.0 {
                node.goal = Some(js::round(*goal));
            }
        }
        out.push(node);
    }
    out
}

/// `/^\d{4}-\d{2}-\d{2}$/u`.
fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

/// `[...new Set(list.filter(keep).slice(0, 20_000))]`.
fn unique_strings(value: &[JsValue], keep: impl Fn(&str) -> bool) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for word in value
        .iter()
        .filter_map(JsValue::as_str)
        .filter(|word| keep(word))
        .take(20_000)
    {
        if seen.insert(word) {
            out.push(word.to_string());
        }
    }
    out
}

/// `sanitizeManifest`.
pub fn sanitize_manifest(value: &JsValue) -> Option<StoryManifest> {
    let source = value.as_object()?;
    if string_of(source.get("format")) != Some(STORY_FORMAT) {
        return None;
    }
    let id = string_of(source.get("id"))
        .filter(|id| is_id(id))?
        .to_string();
    let language_code = language(source.get("language")).unwrap_or(StoryLanguage::De);
    let page = sanitize_page(source.get("page"), language_code);
    let defaults = default_styles(page.size == PageSize::Manuscript);
    let mut styles: JsMap<ParagraphStyle> = JsMap::new();
    let empty = JsMap::new();
    let raw_styles = record(source.get("styles")).unwrap_or(&empty);
    let mut ids: Vec<&String> = Vec::new();
    let mut listed: HashSet<&String> = HashSet::new();
    for key in defaults.keys().chain(raw_styles.keys()) {
        if listed.insert(key) {
            ids.push(key);
        }
    }
    for id in ids {
        if !is_style_id(id) {
            continue;
        }
        if let Some(style) = sanitize_style(id, raw_styles.get(id), defaults.get(id)) {
            styles.insert(id.clone(), style);
        }
    }
    let goals = record(source.get("goals")).map(|goals| {
        let positive = |key: &str| match goals.get(key) {
            Some(JsValue::Number(n)) if *n > 0.0 => Some(js::round(*n)),
            _ => None,
        };
        StoryGoals {
            project: positive("project"),
            deadline: string_of(goals.get("deadline"))
                .filter(|date| is_date(date))
                .map(str::to_string),
            session: positive("session"),
            daily: positive("daily"),
        }
    });
    let dictionary = match source.get("dictionary") {
        Some(JsValue::Array(words)) => {
            unique_strings(words, |word| !word.is_empty() && len16(word) <= 80)
        }
        _ => Vec::new(),
    };
    let ignored = match source.get("ignored") {
        Some(JsValue::Array(words)) => Some(unique_strings(words, |word| len16(word) <= 200)),
        _ => None,
    };
    let or = |value: String, fallback: &str| {
        if value.is_empty() {
            fallback.to_string()
        } else {
            value
        }
    };
    let subtitle = text(source.get("subtitle"), 300);
    let author = text(source.get("author"), 200);
    let mut seen = HashSet::new();
    Some(StoryManifest {
        id,
        title: or(text(source.get("title"), 300), "Untitled"),
        subtitle: (!subtitle.is_empty()).then_some(subtitle),
        author: (!author.is_empty()).then_some(author),
        language: language_code,
        page,
        styles,
        binder: sanitize_binder(source.get("binder"), 0, &mut seen),
        goals: Some(goals.unwrap_or_default()),
        dictionary: Some(dictionary),
        ignored,
        created_at: or(
            text(source.get("createdAt"), 40),
            "1970-01-01T00:00:00.000Z",
        ),
        updated_at: or(
            text(source.get("updatedAt"), 40),
            "1970-01-01T00:00:00.000Z",
        ),
    })
}

/// `binderSceneIds`: every scene id the binder refers to, in manuscript order.
pub fn binder_scene_ids(nodes: &[BinderNode]) -> Vec<String> {
    let mut out = Vec::new();
    for node in nodes {
        if node.kind == BinderKind::Scene {
            out.push(node.id.clone());
        } else if let Some(children) = &node.children {
            out.extend(binder_scene_ids(children));
        }
    }
    out
}

/// Reads a scene file's text (`JSON.parse` + `sanitizeScene`). `None` when it
/// is not JSON or not a scene.
pub fn read_scene(text: &str, expected_id: Option<&str>, ids: &mut dyn IdSource) -> Option<Scene> {
    let value = crate::json::parse(text).ok()?;
    sanitize_scene(&value, expected_id, ids)
}

/// Reads `story.json` (`JSON.parse` + `sanitizeManifest`).
pub fn read_manifest(text: &str) -> Option<StoryManifest> {
    let value = crate::json::parse(text).ok()?;
    sanitize_manifest(&value)
}
