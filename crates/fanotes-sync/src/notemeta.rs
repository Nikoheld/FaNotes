//! The renderer's sanitizers for what a `.famd` payload carries besides ink:
//! `noteLink.ts`, `noteBackup.ts`, `noteTextField.ts` and
//! `pageStats.parsePageStats`. Field order follows the TypeScript literals.

use crate::jsjson::{self, is_safe_integer, to_number, Js, JsObject, JsString};

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

/// `Date.parse(value)` for a string, `None` for NaN.
pub fn date_parse(value: &JsString) -> Option<f64> {
    let text = value.to_str()?;
    fanotes_famd::canonical_unix_millis(&text).map(|millis| millis as f64)
}

fn days_to_civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `new Date(ms).toISOString()` (extended years outside 0..=9999).
pub fn iso_from_millis(ms: f64) -> String {
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = days_to_civil(days);
    let hour = rest / 3_600_000;
    let minute = rest / 60_000 % 60;
    let second = rest / 1000 % 60;
    let millis = rest % 1000;
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!("{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

pub fn now_iso() -> String {
    iso_from_millis(now_ms())
}

fn is_id(value: &JsString) -> bool {
    // /^[a-zA-Z0-9._-]{1,96}$/u
    !value.is_empty()
        && value.len() <= 96
        && value.0.iter().all(|&unit| {
            unit < 128 && (unit as u8).is_ascii_alphanumeric()
                || unit == u16::from(b'.')
                || unit == u16::from(b'_')
                || unit == u16::from(b'-')
        })
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii")
}

/// `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
pub fn random_id(prefix: &str) -> JsString {
    let mut bytes = [0u8; 8];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    let random = u64::from_le_bytes(bytes) % 2_176_782_336; // 36^6
    let mut tail = base36(random);
    while tail.len() < 6 {
        tail.insert(0, '0');
    }
    JsString::from_str(&format!("{prefix}-{}-{tail}", base36(now_ms() as u64)))
}

fn sanitize_path(value: Option<&Js>) -> JsString {
    let Some(Js::Str(raw)) = value else {
        return JsString::new();
    };
    let path = raw
        .replace_unit(u16::from(b'\\'), u16::from(b'/'))
        .trim_start_unit(u16::from(b'/'))
        .trim();
    if path.is_empty() || path.len() > 500 || path.contains_str("..") || path.contains_str("\0") {
        return JsString::new();
    }
    path
}

fn ends_with_md_iu(value: &JsString) -> bool {
    let units = &value.0;
    units.len() >= 3 && {
        let tail = &units[units.len() - 3..];
        tail[0] == u16::from(b'.')
            && (tail[1] | 0x20) == u16::from(b'm')
            && (tail[2] | 0x20) == u16::from(b'd')
    }
}

/// `noteStemName(targetPath)`.
fn note_stem_name(path: &JsString) -> JsString {
    let normalized = path.replace_unit(u16::from(b'\\'), u16::from(b'/'));
    let base = normalized
        .0
        .rsplit(|&unit| unit == u16::from(b'/'))
        .next()
        .map(|part| JsString(part.to_vec()))
        .unwrap_or_default();
    let base = if base.is_empty() {
        JsString::from_str("Notiz")
    } else {
        base
    };
    let stem = crate::paths::strip_note_extension(&base).unwrap_or(base);
    if stem.is_empty() {
        JsString::from_str("Notiz")
    } else {
        stem
    }
}

fn sanitize_coord(value: Option<&Js>) -> f64 {
    match value {
        Some(Js::Num(number)) if number.is_finite() => number.clamp(0.0, 1.0),
        _ => 0.5,
    }
}

fn number_or_convert(value: Option<&Js>) -> f64 {
    match value {
        Some(Js::Num(number)) => *number,
        other => to_number(other),
    }
}

fn sanitize_page(value: Option<&Js>) -> f64 {
    let page = number_or_convert(value);
    if !is_safe_integer(page) || !(1.0..=10_000.0).contains(&page) {
        1.0
    } else {
        page
    }
}

fn is_link_style(value: Option<&Js>) -> Option<&'static str> {
    let Some(Js::Str(style)) = value else {
        return None;
    };
    ["symbol", "text", "symbol-text"]
        .into_iter()
        .find(|candidate| style.eq_str(candidate))
}

struct NoteLink {
    id: JsString,
    source_path: JsString,
    target_path: JsString,
    page: f64,
    x: f64,
    y: f64,
    style: &'static str,
    label: JsString,
}

fn sanitize_note_link(value: &Js) -> Option<NoteLink> {
    let Js::Obj(raw) = value else { return None };
    let source_path = sanitize_path(raw.get("sourcePath"));
    let target_path = sanitize_path(raw.get("targetPath"));
    if source_path.is_empty() || target_path.is_empty() || source_path == target_path {
        return None;
    }
    if !ends_with_md_iu(&target_path) {
        return None;
    }
    let id = match raw.get("id") {
        Some(Js::Str(id)) if is_id(id) => id.clone(),
        _ => random_id("nl"),
    };
    let style = is_link_style(raw.get("style")).unwrap_or("symbol");
    let label = match raw.get("label") {
        Some(Js::Str(label)) => label.collapse_space().trim(),
        _ => JsString::new(),
    };
    let label = if label.is_empty() {
        note_stem_name(&target_path).slice(0, 80)
    } else {
        label.slice(0, 80)
    };
    Some(NoteLink {
        id,
        source_path,
        target_path,
        page: sanitize_page(raw.get("page")),
        x: sanitize_coord(raw.get("x")),
        y: sanitize_coord(raw.get("y")),
        style,
        label,
    })
}

fn parse_note_links(value: Option<&Js>) -> Vec<NoteLink> {
    let Some(Js::Arr(items)) = value else {
        return Vec::new();
    };
    let mut seen: Vec<JsString> = Vec::new();
    let mut links = Vec::new();
    for item in items {
        let Some(link) = sanitize_note_link(item) else {
            continue;
        };
        if seen.contains(&link.id) {
            continue;
        }
        seen.push(link.id.clone());
        links.push(link);
    }
    links
}

fn note_link_record(link: NoteLink, appearance: bool) -> Js {
    let mut object = JsObject::new();
    object.define_str("id", Js::Str(link.id));
    object.define_str("sourcePath", Js::Str(link.source_path));
    object.define_str("targetPath", Js::Str(link.target_path));
    object.define_str("page", Js::Num(link.page));
    object.define_str("x", Js::Num(link.x));
    object.define_str("y", Js::Num(link.y));
    object.define_str("style", Js::str(link.style));
    object.define_str("label", Js::Str(link.label));
    if appearance {
        object.define_str("appearance", Js::str(link.style));
    }
    Js::Obj(object)
}

/// `parseNoteLinks(value)` as records.
pub fn note_links_parsed(value: Option<&Js>) -> Vec<Js> {
    parse_note_links(value)
        .into_iter()
        .map(|link| note_link_record(link, false))
        .collect()
}

/// `serializeNoteLinks(links)`.
pub fn note_links_serialized(value: Option<&Js>) -> Vec<Js> {
    parse_note_links(value)
        .into_iter()
        .map(|link| note_link_record(link, true))
        .collect()
}

/// `parseNoteBackups` (also `serializeNoteBackups`: same fields, same order).
pub fn note_backups_parsed(value: Option<&Js>) -> Vec<Js> {
    let Some(Js::Arr(items)) = value else {
        return Vec::new();
    };
    let mut seen: Vec<JsString> = Vec::new();
    let mut out: Vec<Js> = Vec::new();
    for item in items {
        let Js::Obj(raw) = item else { continue };
        let note_path = sanitize_path(raw.get("notePath"));
        if note_path.is_empty() {
            continue;
        }
        let id = match raw.get("id") {
            Some(Js::Str(id)) if is_id(id) => id.clone(),
            _ => random_id("nb"),
        };
        let created_at = match raw.get("createdAt") {
            Some(Js::Str(text)) => match text
                .to_str()
                .and_then(|text| fanotes_famd::canonical_iso(&text))
            {
                Some(iso) => iso,
                None => now_iso(),
            },
            _ => now_iso(),
        };
        let content = match raw.get("content") {
            Some(Js::Str(text)) => text.slice(0, 2 * 1024 * 1024),
            _ => JsString::new(),
        };
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let mut object = JsObject::new();
        object.define_str("id", Js::Str(id));
        object.define_str("notePath", Js::Str(note_path));
        object.define_str("createdAt", Js::str(&created_at));
        object.define_str("content", Js::Str(content));
        out.push(Js::Obj(object));
    }
    let skip = out.len().saturating_sub(40);
    out.split_off(skip)
}

fn clamp_unit(value: Option<&Js>, fallback: f64) -> f64 {
    let number = number_or_convert(value);
    if !number.is_finite() {
        return fallback;
    }
    number.clamp(0.0, 1.0)
}

fn clamp_width(value: Option<&Js>) -> f64 {
    let number = number_or_convert(value);
    if !number.is_finite() {
        return 0.32;
    }
    number.clamp(0.12, 0.92)
}

fn clamp_font_size(value: Option<&Js>) -> f64 {
    let size = number_or_convert(value);
    if !is_safe_integer(size) || !(10.0..=48.0).contains(&size) {
        16.0
    } else {
        size
    }
}

/// `parseNoteTextFields(value)`.
pub fn note_text_fields_parsed(value: Option<&Js>) -> Vec<Js> {
    let Some(Js::Arr(items)) = value else {
        return Vec::new();
    };
    let mut seen: Vec<JsString> = Vec::new();
    let mut out = Vec::new();
    for item in items {
        let Js::Obj(raw) = item else { continue };
        let id = match raw.get("id") {
            Some(Js::Str(id)) if is_id(id) => id.clone(),
            _ => random_id("tf"),
        };
        let text = match raw.get("text") {
            Some(Js::Str(text)) => text.slice(0, 8000),
            _ => JsString::new(),
        };
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let mut object = JsObject::new();
        object.define_str("id", Js::Str(id));
        object.define_str("page", Js::Num(sanitize_page(raw.get("page"))));
        object.define_str("x", Js::Num(clamp_unit(raw.get("x"), 0.5)));
        object.define_str("y", Js::Num(clamp_unit(raw.get("y"), 0.5)));
        object.define_str("width", Js::Num(clamp_width(raw.get("width"))));
        object.define_str("fontSize", Js::Num(clamp_font_size(raw.get("fontSize"))));
        object.define_str("text", Js::Str(text));
        if let Some(Js::Str(color)) = raw.get("color") {
            if is_hex_color(color) {
                let lower: Vec<u16> = color
                    .0
                    .iter()
                    .map(|&unit| {
                        if (u16::from(b'A')..=u16::from(b'F')).contains(&unit) {
                            unit + 32
                        } else {
                            unit
                        }
                    })
                    .collect();
                object.define_str("color", Js::Str(JsString(lower)));
            }
        }
        if matches!(raw.get("bold"), Some(Js::Bool(true))) {
            object.define_str("bold", Js::Bool(true));
        }
        if let Some(updated_at) = text_field_stamp(raw.get("updatedAt")) {
            object.define_str("updatedAt", Js::Num(updated_at));
        }
        out.push(Js::Obj(object));
        if out.len() >= 200 {
            break;
        }
    }
    out
}

/// `/^#[0-9a-f]{6}$/iu`.
fn is_hex_color(value: &JsString) -> bool {
    value.len() == 7
        && value.0[0] == u16::from(b'#')
        && value.0[1..]
            .iter()
            .all(|&unit| unit < 128 && (unit as u8).is_ascii_hexdigit())
}

/// `sanitizeStamp`: epoch milliseconds of an edit or delete, or unknown.
fn text_field_stamp(value: Option<&Js>) -> Option<f64> {
    match value {
        Some(Js::Num(number)) if number.is_finite() && *number > 0.0 && *number <= 8.64e15 => {
            Some(number.floor())
        }
        _ => None,
    }
}

/// `parseNoteTextFieldTombstones(value)`: deleted boxes, newest first, one per id.
pub fn note_text_field_tombstones_parsed(value: Option<&Js>) -> Vec<Js> {
    let Some(Js::Arr(items)) = value else {
        return Vec::new();
    };
    let mut latest: Vec<(JsString, f64)> = Vec::new();
    for item in items {
        let Js::Obj(raw) = item else { continue };
        let Some(Js::Str(id)) = raw.get("id") else {
            continue;
        };
        if !is_id(id) {
            continue;
        }
        let Some(deleted_at) = text_field_stamp(raw.get("deletedAt")) else {
            continue;
        };
        match latest.iter_mut().find(|(known, _)| known == id) {
            Some((_, stamp)) => *stamp = stamp.max(deleted_at),
            None => latest.push((id.clone(), deleted_at)),
        }
    }
    latest.sort_by(|left, right| right.1.total_cmp(&left.1));
    latest
        .into_iter()
        .take(200)
        .map(|(id, deleted_at)| {
            let mut object = JsObject::new();
            object.define_str("id", Js::Str(id));
            object.define_str("deletedAt", Js::Num(deleted_at));
            Js::Obj(object)
        })
        .collect()
}

fn js_to_value(value: &Js) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Js::Null => Value::Null,
        Js::Bool(value) => Value::Bool(*value),
        Js::Num(number) => serde_json::Number::from_f64(*number)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        // A lone surrogate cannot live in a Rust string; it becomes U+FFFD here.
        Js::Str(text) => Value::String(text.to_string_lossy()),
        Js::Arr(items) => Value::Array(items.iter().map(js_to_value).collect()),
        Js::Obj(object) => Value::Object(
            object
                .entries()
                .iter()
                .map(|(key, value)| (key.to_string_lossy(), js_to_value(value)))
                .collect(),
        ),
    }
}

fn value_to_js(value: &serde_json::Value) -> Js {
    use serde_json::Value;
    match value {
        Value::Null => Js::Null,
        Value::Bool(value) => Js::Bool(*value),
        Value::Number(number) => Js::Num(number.as_f64().unwrap_or(0.0)),
        Value::String(text) => Js::str(text),
        Value::Array(items) => Js::Arr(items.iter().map(value_to_js).collect()),
        Value::Object(map) => {
            let mut object = JsObject::new();
            for (key, value) in map {
                object.define_str(key, value_to_js(value));
            }
            Js::Obj(object)
        }
    }
}

/// `parseAnnotations(value)` (`electron/noteAnnotation.mjs`), through the famd crate's port.
pub fn annotations_parsed(value: Option<&Js>) -> Vec<Js> {
    let Some(value @ Js::Arr(_)) = value else {
        return Vec::new();
    };
    fanotes_famd::parse_annotations(Some(&js_to_value(value)))
        .iter()
        .map(value_to_js)
        .collect()
}

/// `annotationsHaveContent(list)`: anything but an empty word bank.
pub fn annotations_have_content(value: Option<&Js>) -> bool {
    let Some(Js::Arr(items)) = value else {
        return false;
    };
    items.iter().any(|item| {
        !matches!(item.get("kind"), Some(Js::Str(kind)) if kind.eq_str("terms"))
            || matches!(item.get("list"), Some(Js::Arr(list)) if !list.is_empty())
    })
}

// ── pageStats.parsePageStats ───────────────────────────────────────────────

fn parse_iso_ms(value: Option<&Js>) -> Option<f64> {
    match value {
        Some(Js::Str(text)) if !text.is_empty() => date_parse(text),
        _ => None,
    }
}

fn iso_or_null(value: Option<&Js>) -> Js {
    match parse_iso_ms(value) {
        Some(ms) => Js::str(&iso_from_millis(ms)),
        None => Js::Null,
    }
}

fn count(value: Option<&Js>) -> f64 {
    let number = to_number(value);
    if number.is_finite() && number > 0.0 {
        number.floor()
    } else {
        0.0
    }
}

fn millimetres(value: Option<&Js>) -> f64 {
    let number = to_number(value);
    if number.is_finite() && number > 0.0 {
        jsjson::js_round(number * 10.0) / 10.0
    } else {
        0.0
    }
}

fn count_array(value: Option<&Js>, length: usize) -> Js {
    let source = match value {
        Some(Js::Arr(items)) => items.as_slice(),
        _ => &[],
    };
    Js::Arr(
        (0..length)
            .map(|index| Js::Num(count(source.get(index))))
            .collect(),
    )
}

fn record(value: Option<&Js>) -> JsObject {
    match value {
        Some(Js::Obj(object)) => object.clone(),
        _ => JsObject::new(),
    }
}

fn define_counts(out: &mut JsObject, raw: &JsObject, keys: &[&str]) {
    for key in keys {
        out.define_str(key, Js::Num(count(raw.get(key))));
    }
}

fn parse_typing(value: Option<&Js>) -> Js {
    let raw = record(value);
    let mut out = JsObject::new();
    define_counts(
        &mut out,
        &raw,
        &[
            "ms",
            "bursts",
            "longestBurstMs",
            "keystrokes",
            "charsTyped",
            "charsDeleted",
            "wordsTyped",
            "linesTyped",
            "pastes",
            "charsPasted",
            "autocorrects",
            "suggestionsApplied",
            "undos",
            "redos",
        ],
    );
    out.define_str("lastTypedAt", iso_or_null(raw.get("lastTypedAt")));
    Js::Obj(out)
}

fn parse_ink_snapshot(value: Option<&Js>) -> Js {
    let raw = record(value);
    let mut out = JsObject::new();
    define_counts(&mut out, &raw, &["strokes", "points"]);
    out.define_str("lengthMm", Js::Num(millimetres(raw.get("lengthMm"))));
    out.define_str("penDownMs", Js::Num(count(raw.get("penDownMs"))));
    out.define_str("savedAt", iso_or_null(raw.get("savedAt")));
    Js::Obj(out)
}

fn parse_ink(value: Option<&Js>) -> Js {
    let raw = record(value);
    let colors: Vec<Js> = match raw.get("colors") {
        Some(Js::Arr(items)) => {
            let kept: Vec<Js> = items
                .iter()
                .filter(
                    |item| matches!(item, Js::Str(text) if !text.is_empty() && text.len() <= 32),
                )
                .cloned()
                .collect();
            let skip = kept.len().saturating_sub(32);
            kept[skip..].to_vec()
        }
        _ => Vec::new(),
    };
    let mut brushes = JsObject::new();
    for (name, uses) in record(raw.get("brushes")).entries().iter().take(24) {
        let number = count(Some(uses));
        if number > 0.0 {
            brushes.assign(name.clone(), Js::Num(number));
        }
    }
    let mut out = JsObject::new();
    define_counts(
        &mut out,
        &raw,
        &[
            "penDownMs",
            "ms",
            "bursts",
            "longestBurstMs",
            "strokes",
            "points",
        ],
    );
    out.define_str("lengthMm", Js::Num(millimetres(raw.get("lengthMm"))));
    out.define_str(
        "longestStrokeMm",
        Js::Num(millimetres(raw.get("longestStrokeMm"))),
    );
    define_counts(
        &mut out,
        &raw,
        &["handwritingStrokes", "artStrokes", "strokesErased"],
    );
    out.define_str("colors", Js::Arr(colors));
    out.define_str("brushes", Js::Obj(brushes));
    out.define_str("lastStrokeAt", iso_or_null(raw.get("lastStrokeAt")));
    out.define_str("current", parse_ink_snapshot(raw.get("current")));
    Js::Obj(out)
}

fn is_day(text: &JsString) -> bool {
    // /^\d{4}-\d{2}-\d{2}$/u
    let units = &text.0;
    units.len() == 10
        && units.iter().enumerate().all(|(index, &unit)| {
            if index == 4 || index == 7 {
                unit == u16::from(b'-')
            } else {
                (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
            }
        })
}

/// `parsePageStats(input, now)`.
pub fn parse_page_stats(input: Option<&Js>, now: f64) -> Js {
    let raw = record(input);
    let created = parse_iso_ms(raw.get("createdAt")).unwrap_or(now);
    let modified = parse_iso_ms(raw.get("modifiedAt")).unwrap_or(created);
    let last_opened = parse_iso_ms(raw.get("lastOpenedAt")).unwrap_or(created);
    let first_opened = parse_iso_ms(raw.get("firstOpenedAt")).unwrap_or(created.min(last_opened));
    let dwell = count(raw.get("dwellMs"));
    let active_days: Vec<Js> = match raw.get("activeDays") {
        Some(Js::Arr(items)) => {
            let kept: Vec<Js> = items
                .iter()
                .filter(|item| matches!(item, Js::Str(text) if is_day(text)))
                .cloned()
                .collect();
            let skip = kept.len().saturating_sub(400);
            kept[skip..].to_vec()
        }
        _ => Vec::new(),
    };
    let document_raw = record(raw.get("document"));
    let mut document = JsObject::new();
    define_counts(
        &mut document,
        &document_raw,
        &[
            "words",
            "characters",
            "charactersWithoutSpaces",
            "lines",
            "paragraphs",
            "headings",
            "links",
            "images",
            "tasks",
            "tasksDone",
            "codeBlocks",
            "mathBlocks",
            "tables",
            "blockquotes",
            "listItems",
            "readingMinutes",
            "peakWords",
            "wordsAdded",
            "wordsRemoved",
        ],
    );
    let peak = count(document_raw.get("peakWords")).max(count(document_raw.get("words")));
    document.define_str("peakWords", Js::Num(peak));
    let mut out = JsObject::new();
    out.define_str("version", Js::Num(2.0));
    out.define_str("createdAt", Js::str(&iso_from_millis(created)));
    out.define_str("modifiedAt", Js::str(&iso_from_millis(modified)));
    out.define_str("firstOpenedAt", Js::str(&iso_from_millis(first_opened)));
    out.define_str("lastOpenedAt", Js::str(&iso_from_millis(last_opened)));
    out.define_str("lastClosedAt", iso_or_null(raw.get("lastClosedAt")));
    out.define_str("lastSavedAt", iso_or_null(raw.get("lastSavedAt")));
    out.define_str("openCount", Js::Num(count(raw.get("openCount"))));
    out.define_str("saveCount", Js::Num(count(raw.get("saveCount"))));
    out.define_str("dwellMs", Js::Num(dwell));
    out.define_str("focusMs", Js::Num(dwell.min(count(raw.get("focusMs")))));
    out.define_str(
        "longestSessionMs",
        Js::Num(count(raw.get("longestSessionMs"))),
    );
    out.define_str("lastSessionMs", Js::Num(count(raw.get("lastSessionMs"))));
    out.define_str("activeDays", Js::Arr(active_days));
    out.define_str("opensByHour", count_array(raw.get("opensByHour"), 24));
    out.define_str("dwellByHour", count_array(raw.get("dwellByHour"), 24));
    out.define_str("dwellByWeekday", count_array(raw.get("dwellByWeekday"), 7));
    out.define_str("typing", parse_typing(raw.get("typing")));
    out.define_str("ink", parse_ink(raw.get("ink")));
    out.define_str("document", Js::Obj(document));
    Js::Obj(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_millis(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_700_000_000_123.0),
            "2023-11-14T22:13:20.123Z"
        );
        assert_eq!(iso_from_millis(-1.0), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            iso_from_millis(253_402_300_800_000.0),
            "+010000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_from_millis(-62_198_755_200_000.0),
            "-000001-01-01T00:00:00.000Z"
        );
    }
}
