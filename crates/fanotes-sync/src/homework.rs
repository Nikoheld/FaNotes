//! `Hausaufgaben.md` merge (`mergeHomeworkMarkdownBytes` in `homeworkStore.ts`).

use crate::jsjson::{self, Js, JsObject, JsString};
use crate::notemeta::{date_parse, now_iso};

pub const HOMEWORK_NOTE_PATH: &str = "Hausaufgaben.md";
const MARKER_START: &str = "<!-- fanotes-homework-v1";

/// `locateEmbeddedJsonComment(source, marker)`: byte range of the JSON.
fn locate_json(source: &str, marker: &str) -> Option<(usize, usize)> {
    let start = source.find(marker)?;
    let mut index = start + marker.len();
    let rest = &source[index..];
    index += rest.len() - rest.trim_start_matches(jsjson::is_js_space).len();
    if source.as_bytes().get(index) != Some(&b'{') {
        return None;
    }
    let json_start = index;
    let (mut depth, mut in_string, mut escape) = (0i64, false, false);
    for (offset, byte) in source.as_bytes()[json_start..].iter().enumerate() {
        let at = json_start + offset;
        if in_string {
            if escape {
                escape = false;
            } else if *byte == b'\\' {
                escape = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let json_end = at + 1;
                    let after = &source[json_end..];
                    let closer = json_end + after.len()
                        - after.trim_start_matches(jsjson::is_js_space).len();
                    return source[closer..]
                        .starts_with("-->")
                        .then_some((json_start, json_end));
                }
            }
            _ => {}
        }
    }
    None
}

fn is_iso_date(value: Option<&Js>) -> bool {
    let Some(Js::Str(text)) = value else {
        return false;
    };
    let Some(text) = text.to_str() else {
        return false;
    };
    let bytes = text.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year: i32 = text[..4].parse().unwrap_or(0);
    let month: u32 = text[5..7].parse().unwrap_or(0);
    let day: u32 = text[8..].parse().unwrap_or(0);
    chrono::NaiveDate::from_ymd_opt(year, month, day).is_some()
}

fn is_iso_time(value: Option<&Js>) -> bool {
    let Some(Js::Str(text)) = value else {
        return false;
    };
    let Some(text) = text.to_str() else {
        return false;
    };
    let bytes = text.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
        && text[..2].parse::<u32>().unwrap_or(99) <= 23
        && text[3..].parse::<u32>().unwrap_or(99) <= 59
}

fn trimmed(value: Option<&Js>) -> JsString {
    match value {
        Some(Js::Str(text)) => text.trim(),
        _ => JsString::new(),
    }
}

fn uuid() -> String {
    let mut bytes = crate::crypto::random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = crate::crypto::to_hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn stamp(value: Option<&Js>, now: &str) -> Js {
    match value {
        Some(Js::Str(text)) if date_parse(text).is_some_and(|ms| ms != 0.0) => {
            Js::Str(text.clone())
        }
        _ => Js::str(now),
    }
}

/// `sanitizeTask(raw)`.
fn sanitize_task(raw: &Js) -> Option<Js> {
    if !raw.truthy() || !raw.is_object_like() {
        return None;
    }
    let title = trimmed(raw.get("title"));
    if title.is_empty() || title.len() > 240 {
        return None;
    }
    let id = trimmed(raw.get("id"));
    let id = if id.is_empty() {
        JsString::from_str(&uuid())
    } else {
        id.slice(0, 80)
    };
    let now = now_iso();
    let mut task = JsObject::new();
    task.define_str("id", Js::Str(id));
    task.define_str("title", Js::Str(title.slice(0, 240)));
    task.define_str(
        "notes",
        Js::Str(match raw.get("notes") {
            Some(Js::Str(text)) => text.slice(0, 4000),
            _ => JsString::new(),
        }),
    );
    task.define_str("subject", Js::Str(trimmed(raw.get("subject")).slice(0, 80)));
    task.define_str(
        "dueDate",
        if is_iso_date(raw.get("dueDate")) {
            raw.get("dueDate").cloned().unwrap()
        } else {
            Js::Null
        },
    );
    task.define_str(
        "dueTime",
        if is_iso_time(raw.get("dueTime")) {
            raw.get("dueTime").cloned().unwrap()
        } else {
            Js::Null
        },
    );
    task.define_str("done", Js::Bool(raw.get("done").is_some_and(Js::truthy)));
    task.define_str(
        "kind",
        Js::str(
            if matches!(raw.get("kind"), Some(Js::Str(k)) if k.eq_str("appointment")) {
                "appointment"
            } else {
                "homework"
            },
        ),
    );
    task.define_str(
        "priority",
        Js::str(
            if matches!(raw.get("priority"), Some(Js::Str(p)) if p.eq_str("high")) {
                "high"
            } else {
                "normal"
            },
        ),
    );
    task.define_str("createdAt", stamp(raw.get("createdAt"), &now));
    task.define_str("updatedAt", stamp(raw.get("updatedAt"), &now));
    Some(Js::Obj(task))
}

fn sanitize_published(value: Option<&Js>) -> Option<Vec<Js>> {
    let Some(Js::Arr(items)) = value else {
        return None;
    };
    let ids: Vec<Js> = items
        .iter()
        .filter_map(|item| match item {
            Js::Str(text) if !text.trim().is_empty() => Some(Js::Str(text.trim().slice(0, 80))),
            _ => None,
        })
        .take(2000)
        .collect();
    (!ids.is_empty()).then_some(ids)
}

struct Doc {
    tasks: Vec<Js>,
    published: Option<Vec<Js>>,
}

fn load(markdown: &str) -> Option<Doc> {
    if !markdown.contains(MARKER_START) {
        return Some(Doc {
            tasks: Vec::new(),
            published: None,
        });
    }
    let (start, end) = locate_json(markdown, MARKER_START)?;
    let parsed = jsjson::parse(jsjson::js_trim(&markdown[start..end])).ok()?;
    if matches!(parsed, Js::Null) {
        return None;
    }
    let tasks = match parsed.get("tasks") {
        Some(Js::Arr(items)) => items.iter().filter_map(sanitize_task).collect(),
        _ => Vec::new(),
    };
    Some(Doc {
        tasks,
        published: sanitize_published(parsed.get("publishedIds")),
    })
}

fn id_of(task: &Js) -> JsString {
    task.get("id")
        .and_then(Js::as_jsstr)
        .cloned()
        .unwrap_or_default()
}

fn instant(task: &Js) -> Option<f64> {
    task.get("updatedAt")
        .and_then(Js::as_jsstr)
        .and_then(date_parse)
}

fn merge(local: Doc, remote: Doc) -> Doc {
    let mut seen: Vec<JsString> = Vec::new();
    let mut tasks = Vec::new();
    for theirs in &remote.tasks {
        let id = id_of(theirs);
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let Some(ours) = local.tasks.iter().find(|task| id_of(task) == id) else {
            tasks.push(theirs.clone());
            continue;
        };
        let pick_local = match (instant(ours), instant(theirs)) {
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (Some(a), Some(b)) if a != b => a > b,
            _ => {
                ours.get("done").is_some_and(Js::truthy)
                    && !theirs.get("done").is_some_and(Js::truthy)
            }
        };
        tasks.push(if pick_local {
            ours.clone()
        } else {
            theirs.clone()
        });
    }
    for ours in &local.tasks {
        let id = id_of(ours);
        if !seen.contains(&id) {
            seen.push(id);
            tasks.push(ours.clone());
        }
    }
    let joined: Vec<Js> = remote
        .published
        .unwrap_or_default()
        .into_iter()
        .chain(local.published.unwrap_or_default())
        .collect();
    let published = sanitize_published(Some(&Js::Arr(joined))).map(|ids| {
        let mut unique: Vec<Js> = Vec::new();
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        unique
    });
    Doc { tasks, published }
}

fn serialize(doc: Doc) -> String {
    let mut payload = JsObject::new();
    payload.define_str("version", Js::Num(1.0));
    payload.define_str(
        "tasks",
        Js::Arr(doc.tasks.iter().filter_map(sanitize_task).collect()),
    );
    if let Some(ids) = sanitize_published(doc.published.map(Js::Arr).as_ref()) {
        payload.define_str("publishedIds", Js::Arr(ids));
    }
    let json = jsjson::stringify_pretty(&Js::Obj(payload), "  ");
    [
        "# Hausaufgaben",
        "",
        "Diese Notiz wird von der **Hausaufgaben-Ansicht** in FaNotes verwaltet.",
        "Trage Aufgaben und Termine dort ein – sie bleiben in deinem lokalen Vault.",
        "",
        MARKER_START,
        &json,
        "-->",
        "",
    ]
    .join("\n")
}

/// `mergeHomeworkMarkdownBytes(local, remote)`.
pub fn merge_homework_markdown_bytes(local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
    let ours = load(&jsjson::text_decode(local))?;
    let theirs = load(&jsjson::text_decode(remote))?;
    Some(serialize(merge(ours, theirs)).into_bytes())
}
