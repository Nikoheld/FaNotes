//! Study annotations on a note page (callout labels, stamps, legends, reference
//! images, freehand highlights, measurements and a word bank), stored in the
//! `.famd` payload as `annotations`. A port of `parseAnnotations` and
//! `annotationsHaveContent` in `fanotes/electron/noteAnnotation.mjs`.

use serde_json::{Map, Value};

use crate::{js_json_number, js_number, trim_js, truncate_js};

pub const ANNOTATION_LIMIT: usize = 600;
pub const ANNOTATION_IMAGE_LIMIT: usize = 12;
pub const ANNOTATION_IMAGE_MAX_CHARS: usize = 1_600_000;
pub const ANNOTATION_TEXT_MAX: usize = 400;
pub const ANNOTATION_TERMS_MAX: usize = 80;
pub const ANNOTATION_STROKE_POINTS_MAX: usize = 600;

const STAMP_IDS: &[&str] = &[
    "gain",
    "loss",
    "event",
    "dot-red",
    "dot-green",
    "dot-yellow",
    "letter-h",
    "letter-v",
    "letter-a",
    "check",
];
const KINDS: &[&str] = &[
    "callout", "stamp", "legend", "image", "stroke", "measure", "terms",
];

fn is_id(value: &str) -> bool {
    (1..=96).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `num(value, fallback)`: `Number(value)`, or the fallback when that is not finite.
fn num(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js_number(value);
    if number.is_finite() {
        number
    } else {
        fallback
    }
}

fn unit(value: Option<&Value>, fallback: f64) -> f64 {
    num(value, fallback).clamp(0.0, 1.0)
}

fn unit_number(value: f64) -> f64 {
    // `Math.min(1, Math.max(0, value))`; NaN never reaches here.
    value.clamp(0.0, 1.0)
}

fn clamp(value: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    num(value, fallback).max(min).min(max)
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn page(value: Option<&Value>) -> f64 {
    let number = num(value, 1.0);
    if is_safe_integer(number) && (1.0..=10_000.0).contains(&number) {
        number
    } else {
        1.0
    }
}

fn color(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if is_color(text) => text.to_lowercase(),
        _ => fallback.to_owned(),
    }
}

fn text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| truncate_js(text, max))
        .unwrap_or_default()
}

/// `Math.round(value)` for the non-negative values used here.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `stableAnnotationId`: `"an-"` + FNV-1a 32 bit (base 36) of
/// `kind|index|page|round(x*10000)|round(y*10000)|text`.
pub fn stable_annotation_id(
    kind: &str,
    index: usize,
    page: f64,
    x: Option<&Value>,
    y: Option<&Value>,
    label: &str,
) -> String {
    let canonical = format!(
        "{kind}|{index}|{}|{}|{}|{label}",
        page as i64,
        js_round(unit(x, 0.0) * 10_000.0) as i64,
        js_round(unit(y, 0.0) * 10_000.0) as i64,
    );
    let mut hash: u32 = 0x811c_9dc5;
    for byte in canonical.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("an-{}", base36(u64::from(hash)))
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii digits")
}

fn points(value: Option<&Value>, min: usize, max: usize) -> Vec<Value> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(pair) = entry.as_array().filter(|pair| pair.len() >= 2) else {
            continue;
        };
        let x = js_number(pair.first());
        let y = js_number(pair.get(1));
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        let round = |value: f64| js_round(unit_number(value) * 10_000.0) / 10_000.0;
        out.push(Value::Array(vec![
            js_json_number(round(x)),
            js_json_number(round(y)),
        ]));
        if out.len() >= max {
            break;
        }
    }
    if out.len() >= min {
        out
    } else {
        Vec::new()
    }
}

/// `Object.keys` order: array-index keys first, ascending, then the rest in insertion order.
fn js_key_order(map: &Map<String, Value>) -> Vec<&String> {
    let index_of = |key: &str| -> Option<u32> {
        if key == "0" || (!key.starts_with('0') && !key.is_empty()) {
            key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
        } else {
            None
        }
    };
    let mut indexed: Vec<(u32, &String)> = map
        .keys()
        .filter_map(|key| index_of(key).map(|index| (index, key)))
        .collect();
    indexed.sort_by_key(|(index, _)| *index);
    let mut keys: Vec<&String> = indexed.into_iter().map(|(_, key)| key).collect();
    keys.extend(map.keys().filter(|key| index_of(key).is_none()));
    keys
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

fn number(value: f64) -> Value {
    js_json_number(value)
}

/// `sanitizeAnnotation(value, index)`.
pub fn sanitize_annotation(value: &Value, index: usize) -> Option<Value> {
    let raw = value.as_object()?;
    let kind = raw.get("kind").and_then(Value::as_str)?;
    if !KINDS.contains(&kind) {
        return None;
    }
    let first_point = raw
        .get("pts")
        .and_then(Value::as_array)
        .and_then(|points| points.first())
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let page_number = page(raw.get("page"));
    let id = match raw.get("id").and_then(Value::as_str) {
        Some(id) if is_id(id) => id.to_owned(),
        _ => {
            let (x, y) = if kind == "callout" {
                (raw.get("ax"), raw.get("ay"))
            } else if !first_point.is_empty() {
                (first_point.first(), first_point.get(1))
            } else {
                (raw.get("x"), raw.get("y"))
            };
            let label = raw
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| raw.get("stamp").and_then(Value::as_str))
                .unwrap_or("");
            stable_annotation_id(kind, index, page_number, x, y, label)
        }
    };
    let id = Value::String(id);
    let page_value = number(page_number);
    match kind {
        "callout" => {
            let ax = unit(raw.get("ax"), 0.5);
            let ay = unit(raw.get("ay"), 0.5);
            let numbered = raw
                .get("num")
                .filter(|value| value.is_number())
                .and_then(Value::as_f64)
                .filter(|value| is_safe_integer(*value) && (1.0..=999.0).contains(value));
            let mut entries = vec![
                ("kind", Value::from("callout")),
                ("id", id),
                ("page", page_value),
                ("ax", number(ax)),
                ("ay", number(ay)),
                ("lx", number(unit(raw.get("lx"), ax))),
                ("ly", number(unit(raw.get("ly"), ay))),
                ("text", Value::String(text(raw.get("text"), 120))),
                ("color", Value::String(color(raw.get("color"), "#1d4ed8"))),
            ];
            if let Some(numbered) = numbered {
                entries.push(("num", number(numbered)));
            }
            Some(object(entries))
        }
        "stamp" => {
            let stamp = raw
                .get("stamp")
                .and_then(Value::as_str)
                .filter(|stamp| STAMP_IDS.contains(stamp))
                .unwrap_or("event");
            Some(object(vec![
                ("kind", Value::from("stamp")),
                ("id", id),
                ("page", page_value),
                ("x", number(unit(raw.get("x"), 0.5))),
                ("y", number(unit(raw.get("y"), 0.5))),
                ("stamp", Value::from(stamp)),
                ("size", number(clamp(raw.get("size"), 12.0, 64.0, 24.0))),
            ]))
        }
        "legend" => {
            let mut names = Map::new();
            if let Some(source) = raw.get("names").and_then(Value::as_object) {
                for key in js_key_order(source).into_iter().take(40) {
                    if let (true, Some(_)) = (
                        STAMP_IDS.contains(&key.as_str()),
                        source.get(key).and_then(Value::as_str),
                    ) {
                        names.insert(key.clone(), Value::String(text(source.get(key), 60)));
                    }
                }
            }
            Some(object(vec![
                ("kind", Value::from("legend")),
                ("id", id),
                ("page", page_value),
                ("x", number(unit(raw.get("x"), 0.6))),
                ("y", number(unit(raw.get("y"), 0.05))),
                ("names", Value::Object(names)),
            ]))
        }
        "image" => {
            let src = raw
                .get("src")
                .and_then(Value::as_str)
                .filter(|src| is_image_data_url(src) && src.len() <= ANNOTATION_IMAGE_MAX_CHARS)?;
            Some(object(vec![
                ("kind", Value::from("image")),
                ("id", id),
                ("page", page_value),
                ("x", number(unit(raw.get("x"), 0.1))),
                ("y", number(unit(raw.get("y"), 0.1))),
                ("w", number(clamp(raw.get("w"), 0.05, 1.0, 0.4))),
                ("aspect", number(clamp(raw.get("aspect"), 0.05, 20.0, 1.0))),
                ("opacity", number(clamp(raw.get("opacity"), 0.1, 1.0, 1.0))),
                (
                    "locked",
                    Value::Bool(raw.get("locked") == Some(&Value::Bool(true))),
                ),
                ("src", Value::from(src)),
                ("title", Value::String(text(raw.get("title"), 80))),
            ]))
        }
        "stroke" => {
            let pts = points(raw.get("pts"), 2, ANNOTATION_STROKE_POINTS_MAX);
            if pts.is_empty() {
                return None;
            }
            Some(object(vec![
                ("kind", Value::from("stroke")),
                ("id", id),
                ("page", page_value),
                ("pts", Value::Array(pts)),
                ("color", Value::String(color(raw.get("color"), "#facc15"))),
                ("width", number(clamp(raw.get("width"), 2.0, 60.0, 18.0))),
                ("opacity", number(clamp(raw.get("opacity"), 0.1, 1.0, 0.4))),
            ]))
        }
        "measure" => {
            let distance = raw.get("mode").and_then(Value::as_str) == Some("distance");
            let pts = if distance {
                points(raw.get("pts"), 2, 2)
            } else {
                points(raw.get("pts"), 3, 4)
            };
            if pts.is_empty() {
                return None;
            }
            Some(object(vec![
                ("kind", Value::from("measure")),
                ("id", id),
                ("page", page_value),
                (
                    "mode",
                    Value::from(if distance { "distance" } else { "angle" }),
                ),
                ("pts", Value::Array(pts)),
                ("color", Value::String(color(raw.get("color"), "#dc2626"))),
            ]))
        }
        "terms" => {
            let mut list: Vec<String> = Vec::new();
            if let Some(entries) = raw.get("list").and_then(Value::as_array) {
                for entry in entries {
                    let term = trim_js(&text(Some(entry), 60)).to_owned();
                    if !term.is_empty() && !list.contains(&term) {
                        list.push(term);
                    }
                    if list.len() >= ANNOTATION_TERMS_MAX {
                        break;
                    }
                }
            }
            Some(object(vec![
                ("kind", Value::from("terms")),
                ("id", Value::from("terms")),
                (
                    "list",
                    Value::Array(list.into_iter().map(Value::String).collect()),
                ),
            ]))
        }
        _ => None,
    }
}

/// `/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u`.
fn is_image_data_url(src: &str) -> bool {
    let rest = ["png", "jpeg", "webp"].iter().find_map(|format| {
        src.strip_prefix("data:image/")
            .and_then(|rest| rest.strip_prefix(format))
            .and_then(|rest| rest.strip_prefix(";base64,"))
    });
    rest.is_some_and(|data| {
        !data.is_empty()
            && data
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    })
}

/// `parseAnnotations(value)`: sanitized annotations, one per id, at most 12
/// images and 600 entries.
pub fn parse_annotations(value: Option<&Value>) -> Vec<Value> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let mut images = 0;
    for (index, entry) in entries.iter().enumerate() {
        let Some(item) = sanitize_annotation(entry, index) else {
            continue;
        };
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if seen.contains(&id) {
            continue;
        }
        if item.get("kind").and_then(Value::as_str) == Some("image") {
            images += 1;
            if images > ANNOTATION_IMAGE_LIMIT {
                continue;
            }
        }
        seen.push(id);
        out.push(item);
        if out.len() >= ANNOTATION_LIMIT {
            break;
        }
    }
    out
}

/// `annotationsHaveContent(list)`: anything worth saving (an empty word bank is not).
pub fn annotations_have_content(list: &[Value]) -> bool {
    list.iter().any(|item| {
        item.get("kind").and_then(Value::as_str) != Some("terms")
            || item
                .get("list")
                .and_then(Value::as_array)
                .is_some_and(|list| !list.is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_callout_without_an_id_gets_the_shared_stable_id() {
        // FNV-1a of "callout|0|1|2500|7500|Zelle", as in noteAnnotation.mjs.
        let list = parse_annotations(Some(&json!([
            { "kind": "callout", "ax": 0.25, "ay": 0.75, "text": "Zelle" }
        ])));
        let id = list[0]["id"].as_str().unwrap();
        assert!(id.starts_with("an-"));
        assert_eq!(
            id,
            stable_annotation_id(
                "callout",
                0,
                1.0,
                Some(&json!(0.25)),
                Some(&json!(0.75)),
                "Zelle"
            )
        );
        assert_eq!(list[0]["lx"], json!(0.25));
        assert_eq!(list[0]["color"], json!("#1d4ed8"));
    }

    #[test]
    fn empty_word_banks_and_broken_entries_are_not_content() {
        let list = parse_annotations(Some(&json!([
            { "kind": "terms", "list": ["  ", ""] },
            { "kind": "stroke", "pts": [[0.1, 0.1]] },
            { "kind": "image", "src": "http://example.invalid/x.png" },
            { "kind": "nope" }
        ])));
        assert_eq!(list.len(), 1);
        assert!(!annotations_have_content(&list));
    }

    #[test]
    fn only_twelve_images_are_kept() {
        let images: Vec<Value> = (0..14)
            .map(|index| json!({ "kind": "image", "id": format!("img{index}"), "src": "data:image/png;base64,AAAA" }))
            .collect();
        let list = parse_annotations(Some(&Value::Array(images)));
        assert_eq!(list.len(), ANNOTATION_IMAGE_LIMIT);
        assert!(annotations_have_content(&list));
    }
}
