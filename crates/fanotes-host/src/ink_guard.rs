//! Which handwriting page a save may replace, and which one a note opens.
//!
//! Port of `electron/ink-save-guard.cjs`. A board whose stored page never
//! loaded (still restoring, or unreadable) holds an empty stroke list under
//! the note's real ink id. A deliberate empty page always leaves an undo or
//! redo step behind (`inkHistory`). An empty page without that step, over a
//! stored page that still has strokes, is refused.

use serde_json::Value;

/// Collapsed sections park their strokes in `hidden`, and a collapsed section
/// can hold collapsed subsections. famd.cjs `inkHasMarks` stops at the same depth.
const MAX_WALK_DEPTH: usize = 24;

/// Stored text of a file the guard looks at.
///
/// `Missing` is Node's `null` (ENOENT). `Unreadable` is `undefined`: the file
/// could not be read (or was not read), and the guard keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StoredText {
    Missing,
    Unreadable,
    Text(String),
}

/// Strokes anywhere on the page: live, in collapsed (sub)sections, packed (`famdPts`) or not.
pub(crate) fn page_has_strokes(value: &Value) -> bool {
    page_has_strokes_at(value, 0)
}

fn page_has_strokes_at(value: &Value, depth: usize) -> bool {
    if depth > MAX_WALK_DEPTH {
        return false;
    }
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| page_has_strokes_at(item, depth + 1)),
        Value::Object(object) => {
            if object
                .get("famdPts")
                .and_then(Value::as_str)
                .is_some_and(|points| !points.is_empty())
            {
                return true;
            }
            if non_empty_array(object.get("points")) || non_empty_array(object.get("figurePaths")) {
                return true;
            }
            ["strokes", "sections", "hidden", "ink"].iter().any(|key| {
                object
                    .get(*key)
                    .is_some_and(|child| page_has_strokes_at(child, depth + 1))
            })
        }
        _ => false,
    }
}

/// famd.cjs `inkHasMarks` (the same walk, stopped at depth 24).
///
/// The write-file guard asks this of a whole `.famd` payload (its `ink`).
#[allow(dead_code)]
pub(crate) fn ink_has_marks(value: &Value) -> bool {
    fanotes_famd::ink_has_marks(value)
}

fn non_empty_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

/// The page saved at least one undo or redo step.
pub(crate) fn ink_history_has_steps(document: &Value) -> bool {
    let Some(history) = document
        .get("inkHistory")
        .filter(|history| history.is_object())
    else {
        return false;
    };
    non_empty_array(history.get("undo")) || non_empty_array(history.get("redo"))
}

/// No strokes anywhere, and nothing that says they were removed on purpose.
pub(crate) fn is_unexplained_empty_page(document: &Value) -> bool {
    document.is_object() && !page_has_strokes(document) && !ink_history_has_steps(document)
}

/// The drawing record's text holds strokes. A record that cannot be parsed counts as holding them.
pub(crate) fn record_text_has_ink(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(document) => page_has_strokes(&document),
        Err(_) => true,
    }
}

/// The `.famd` companion's text holds strokes. A companion that cannot be parsed counts as holding them.
pub(crate) fn companion_text_has_ink(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let parsed = fanotes_famd::parse_famd(text);
    match parsed.payload {
        // `parseFamd` without a payload: a stored note that did not parse is kept.
        None => text.contains("fanotes-famd:v1") || text.contains("fanotes-famd:v2"),
        Some(payload) => payload.ink.as_ref().is_some_and(page_has_strokes),
    }
}

/// True when this save must not be written.
///
/// A large drawing is never a skeleton; the desktop parses only its top-level
/// fields and never refuses it.
pub(crate) fn refuses_empty_ink_save(
    document: &Value,
    large: bool,
    record: &StoredText,
    companion: &StoredText,
) -> bool {
    if large || !is_unexplained_empty_page(document) {
        return false;
    }
    if matches!(record, StoredText::Unreadable) || matches!(companion, StoredText::Unreadable) {
        return true;
    }
    let record_ink = match record {
        StoredText::Text(text) => record_text_has_ink(text),
        _ => false,
    };
    let companion_ink = match companion {
        StoredText::Text(text) => companion_text_has_ink(text),
        _ => false,
    };
    record_ink || companion_ink
}

/// A note opens its `.famd` ink, unless that ink is an unexplained empty page.
///
/// The Rust host opens companions unpacked, so the desktop's packed-columns
/// exception never applies: a packed heavy page has strokes here too.
pub(crate) fn companion_ink_needs_record(ink: Option<&Value>) -> bool {
    ink.is_some_and(|ink| ink.is_object() && is_unexplained_empty_page(ink))
}

/// The parsed drawing record a note opens instead of its companion ink, or
/// `None` to open the companion as before.
pub(crate) fn record_document_for_empty_companion(
    ink: Option<&Value>,
    record_text: Option<&str>,
) -> Option<Value> {
    if !companion_ink_needs_record(ink) {
        return None;
    }
    let text = record_text.filter(|text| !text.is_empty())?;
    let document: Value = serde_json::from_str(text).ok()?;
    if !document.is_object() {
        return None;
    }
    page_has_strokes(&document).then_some(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stroke(x: f64) -> Value {
        json!({ "id": "s", "points": [{ "x": x, "y": 0.2 }, { "x": x + 0.01, "y": 0.2 }] })
    }

    fn skeleton() -> Value {
        json!({ "schemaVersion": 1, "title": "Handschrift", "strokes": [] })
    }

    #[test]
    fn strokes_in_a_collapsed_subsection_count_for_both_walks() {
        let nested = json!({
            "schemaVersion": 1,
            "strokes": [],
            "sections": [{
                "id": "a", "collapsed": true,
                "hidden": {
                    "strokes": [],
                    "sections": [{ "id": "b", "collapsed": true, "hidden": { "strokes": [stroke(0.5)], "sections": [] } }],
                },
            }],
        });
        assert!(page_has_strokes(&nested));
        assert!(ink_has_marks(&nested));
        assert!(!is_unexplained_empty_page(&nested));
        assert!(page_has_strokes(
            &json!({ "strokes": [{ "famdPts": "abcde" }] })
        ));
        assert!(!page_has_strokes(
            &json!({ "strokes": [{ "famdPts": "" }] })
        ));
        assert!(page_has_strokes(
            &json!({ "strokes": [{ "figurePaths": [[0, 1]] }] })
        ));
        assert!(ink_has_marks(
            &json!({ "ink": { "strokes": [stroke(0.1)] } })
        ));
    }

    #[test]
    fn an_undo_or_redo_step_explains_an_empty_page() {
        let mut cleared = skeleton();
        cleared["inkHistory"] =
            json!({ "extras": [stroke(0.1)], "undo": [[{ "extra": 0 }]], "redo": [] });
        assert!(!is_unexplained_empty_page(&cleared));
        let mut undone = skeleton();
        undone["inkHistory"] = json!({ "undo": [], "redo": [[{ "extra": 0 }]] });
        assert!(!is_unexplained_empty_page(&undone));
        let mut no_steps = skeleton();
        no_steps["inkHistory"] = json!({ "undo": [], "redo": [] });
        assert!(is_unexplained_empty_page(&no_steps));
        assert!(!is_unexplained_empty_page(&json!([])));
    }

    #[test]
    fn the_guard_keeps_unreadable_and_inked_files() {
        let inked = json!({ "schemaVersion": 1, "strokes": [stroke(0.1)] }).to_string();
        let empty = skeleton().to_string();
        let page = skeleton();
        assert!(refuses_empty_ink_save(
            &page,
            false,
            &StoredText::Unreadable,
            &StoredText::Missing
        ));
        assert!(refuses_empty_ink_save(
            &page,
            false,
            &StoredText::Missing,
            &StoredText::Unreadable
        ));
        assert!(refuses_empty_ink_save(
            &page,
            false,
            &StoredText::Text(inked.clone()),
            &StoredText::Missing
        ));
        assert!(refuses_empty_ink_save(
            &page,
            false,
            &StoredText::Text("{\"strokes\":[".to_owned()),
            &StoredText::Missing
        ));
        assert!(!refuses_empty_ink_save(
            &page,
            false,
            &StoredText::Text(empty.clone()),
            &StoredText::Missing
        ));
        assert!(!refuses_empty_ink_save(
            &page,
            false,
            &StoredText::Missing,
            &StoredText::Missing
        ));
        assert!(!refuses_empty_ink_save(
            &page,
            true,
            &StoredText::Text(inked.clone()),
            &StoredText::Unreadable
        ));
        let pen = json!({ "schemaVersion": 1, "strokes": [stroke(0.3)] });
        assert!(!refuses_empty_ink_save(
            &pen,
            false,
            &StoredText::Text(inked),
            &StoredText::Unreadable
        ));
        assert!(companion_text_has_ink(
            "# Kaputt\n\n<!-- fanotes-famd:v1 chars=999 -->\n{\"schema\""
        ));
        assert!(companion_text_has_ink(
            "# Neu\n\n<!-- fanotes-famd:v2 x -->\n"
        ));
        assert!(!companion_text_has_ink("# Nur Text\n"));
        assert!(!companion_text_has_ink(""));
    }

    #[test]
    fn only_an_empty_companion_with_an_inked_record_opens_the_record() {
        let empty = skeleton();
        let inked =
            json!({ "schemaVersion": 1, "title": "H", "strokes": [stroke(0.1), stroke(0.3)] });
        let opened = record_document_for_empty_companion(Some(&empty), Some(&inked.to_string()));
        assert_eq!(opened.unwrap()["strokes"].as_array().unwrap().len(), 2);
        assert!(
            record_document_for_empty_companion(Some(&empty), Some(&skeleton().to_string()))
                .is_none()
        );
        assert!(record_document_for_empty_companion(Some(&empty), None).is_none());
        assert!(record_document_for_empty_companion(
            Some(&empty),
            Some("{\"strokes\":[{\"points\":[{\"x\":0.1")
        )
        .is_none());
        assert!(
            record_document_for_empty_companion(Some(&inked), Some(&inked.to_string())).is_none()
        );
        assert!(record_document_for_empty_companion(None, Some(&inked.to_string())).is_none());
        let mut cleared = skeleton();
        cleared["inkHistory"] = json!({ "undo": [[{ "extra": 0 }]] });
        assert!(
            record_document_for_empty_companion(Some(&cleared), Some(&inked.to_string())).is_none()
        );
    }
}
