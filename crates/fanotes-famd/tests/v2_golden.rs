//! `fanotes-famd:v2` against fixtures written by the Electron codec.
//!
//! Regenerate with `node crates/fanotes-famd/tests/fixtures/make-v2-fixtures.cjs`.

use fanotes_famd::{
    compose_famd_companion, convert_famd_source, create_note_companion, famd_encoding_for_save,
    famd_looks_stored, ink_has_marks, is_active_v2, js_stringify, pack_v2_ink, parse_famd,
    rewrite_famd_text, serialize_famd_with, strip_famd_payload, try_parse_famd,
    try_parse_famd_packed, FamdConversion, FamdEncoding, FamdWriteError, ParsedFamd,
};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/v2-golden.json")).expect("fixture json")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not a string"))
}

fn encoding_name(encoding: FamdEncoding) -> &'static str {
    match encoding {
        FamdEncoding::V1 => "v1",
        FamdEncoding::V2 => "v2",
    }
}

/// Compare a parse with `{ markdown, payload }` or `{ error }` from JavaScript.
fn assert_parsed(
    label: &str,
    actual: Result<ParsedFamd, fanotes_famd::FamdCorruptError>,
    expected: &Value,
) {
    match (actual, expected.get("error")) {
        (Err(error), Some(message)) => assert_eq!(error.0, message.as_str().unwrap(), "{label}"),
        (Ok(parsed), None) => {
            assert_eq!(
                parsed.markdown,
                text(expected, "markdown"),
                "{label} markdown"
            );
            let payload = parsed
                .payload
                .map(|payload| payload.to_json())
                .unwrap_or(Value::Null);
            assert_eq!(
                js_stringify(&payload),
                js_stringify(&expected["payload"]),
                "{label} payload"
            );
        }
        (Ok(_), Some(message)) => {
            panic!("{label}: Rust parsed what JavaScript rejects ({message})")
        }
        (Err(error), None) => panic!("{label}: Rust rejects ({error}) what JavaScript parsed"),
    }
}

fn assert_attempt(label: &str, actual: Result<String, FamdWriteError>, expected: &Value) {
    match (actual, expected.get("error")) {
        (Ok(actual), None) => assert_eq!(actual, text(expected, "text"), "{label}"),
        (Err(error), Some(message)) => {
            assert_eq!(error.to_string(), message.as_str().unwrap(), "{label}")
        }
        (Ok(actual), Some(message)) => {
            panic!("{label}: Rust wrote {actual:?}, JavaScript threw {message}")
        }
        (Err(error), None) => panic!("{label}: Rust refused ({error}), JavaScript wrote"),
    }
}

fn assert_conversion(label: &str, actual: FamdConversion, expected: &Value) {
    assert_eq!(
        actual.status.as_str(),
        text(expected, "status"),
        "{label} status"
    );
    assert_eq!(actual.source, text(expected, "source"), "{label} source");
}

#[test]
fn v2_matches_the_electron_codec_byte_for_byte() {
    let golden = golden();
    let now = text(&golden, "now");
    let new_ink = &golden["newInk"];
    let trailer = text(&golden, "trailerMarkdown");
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let name = text(case, "name");
        let v1 = text(case, "v1");
        let v2 = text(case, "v2");
        let from_v1 = parse_famd(v1);
        if !case["parsedV1"].is_null() {
            assert_parsed(&format!("{name} v1"), try_parse_famd(v1), &case["parsedV1"]);
        }
        let payload = from_v1.payload.as_ref().expect("v1 payload");
        assert_eq!(
            serialize_famd_with(&from_v1.markdown, payload, FamdEncoding::V2),
            v2,
            "{name} v2 encoding"
        );
        assert_eq!(
            strip_famd_payload(v2),
            text(case, "strippedV2"),
            "{name} strip"
        );
        assert_parsed(&format!("{name} v2"), try_parse_famd(v2), &case["parsedV2"]);
        assert_eq!(
            is_active_v2(v2),
            case["activeV2"].as_bool().unwrap(),
            "{name}"
        );
        assert_eq!(
            encoding_name(famd_encoding_for_save(Some(v2))),
            text(case, "encoding")
        );
        assert_eq!(
            encoding_name(famd_encoding_for_save(Some(v1))),
            text(case, "encodingV1")
        );
        assert_conversion(
            &format!("{name} convert v1"),
            convert_famd_source(v1),
            &case["convert"],
        );
        assert_eq!(
            ink_has_marks(payload.ink.as_ref().unwrap_or(&Value::Null)),
            case["inkHasMarks"].as_bool().unwrap(),
            "{name} inkHasMarks"
        );
        if case["parsedV2Packed"].is_null() {
            continue;
        }
        assert_parsed(
            &format!("{name} v2 packed"),
            try_parse_famd_packed(v2),
            &case["parsedV2Packed"],
        );
        let packed = try_parse_famd_packed(v2).unwrap();
        assert_eq!(
            serialize_famd_with(
                &packed.markdown,
                packed.payload.as_ref().unwrap(),
                FamdEncoding::V2
            ),
            text(case, "repacked"),
            "{name} repack"
        );
        assert_eq!(
            js_stringify(&pack_v2_ink(payload.ink.as_ref().unwrap_or(&Value::Null))),
            js_stringify(&case["packedInk"]),
            "{name} packV2Ink"
        );
        assert_conversion(
            &format!("{name} convert v2"),
            convert_famd_source(v2),
            &case["convertV2"],
        );
        let markdown = from_v1.markdown.as_str();
        assert_attempt(
            &format!("{name} rewrite same"),
            rewrite_famd_text(Some(v2), markdown, now),
            &case["rewriteSame"],
        );
        let changed = format!("{markdown}\n\nNeu <!-- fanotes-worksheet:ws-2 -->");
        assert_attempt(
            &format!("{name} rewrite changed"),
            rewrite_famd_text(Some(v2), &changed, now),
            &case["rewriteChanged"],
        );
        assert_attempt(
            &format!("{name} rewrite v1"),
            rewrite_famd_text(Some(v1), "Anders", now),
            &case["rewriteV1"],
        );
        assert_attempt(
            &format!("{name} compose keep"),
            compose_famd_companion(Some(v2), markdown, None, Some("squares"), now),
            &case["composeKeep"],
        );
        assert_attempt(
            &format!("{name} compose ink"),
            compose_famd_companion(Some(v2), "Neuer Text", Some(new_ink), Some("squares"), now),
            &case["composeInk"],
        );
        assert_attempt(
            &format!("{name} compose null"),
            compose_famd_companion(Some(v2), markdown, Some(&Value::Null), None, now),
            &case["composeNull"],
        );
        assert_attempt(
            &format!("{name} compose v1 ink"),
            compose_famd_companion(Some(v1), markdown, Some(new_ink), Some("grid"), now),
            &case["composeV1Ink"],
        );
        assert_attempt(
            &format!("{name} compose trailer"),
            compose_famd_companion(Some(v2), trailer, None, Some("grid"), now),
            &case["composeTrailer"],
        );
    }
}

#[test]
fn damaged_v2_notes_are_reported_and_never_rewritten() {
    let golden = golden();
    let now = text(&golden, "now");
    for case in golden["corrupt"].as_array().unwrap() {
        let name = text(case, "name");
        let source = text(case, "source");
        assert_parsed(name, try_parse_famd(source), &case["parsed"]);
        if case["parsed"].get("error").is_some() {
            // The infallible parse keeps the text and has no payload.
            let parsed = parse_famd(source);
            assert!(parsed.payload.is_none(), "{name}");
            assert_eq!(parsed.markdown, text(case, "stripped"), "{name}");
        }
        assert_eq!(
            strip_famd_payload(source),
            text(case, "stripped"),
            "{name} strip"
        );
        assert_eq!(
            is_active_v2(source),
            case["activeV2"].as_bool().unwrap(),
            "{name}"
        );
        assert_eq!(
            famd_looks_stored(source),
            case["looksStored"].as_bool().unwrap(),
            "{name}"
        );
        assert_conversion(name, convert_famd_source(source), &case["convert"]);
        assert_attempt(
            &format!("{name} rewrite"),
            rewrite_famd_text(Some(source), "Text", now),
            &case["rewrite"],
        );
        assert_attempt(
            &format!("{name} compose"),
            compose_famd_companion(Some(source), "Text", None, None, now),
            &case["compose"],
        );
    }
}

#[test]
fn new_notes_encoding_choice_and_ink_marks_follow_the_electron_codec() {
    let golden = golden();
    let updated = text(&golden, "updated");
    for case in golden["created"].as_array().unwrap() {
        assert_eq!(
            create_note_companion(text(case, "markdown"), updated),
            text(case, "text")
        );
    }
    for case in golden["encodings"].as_array().unwrap() {
        let source = text(case, "source");
        assert_eq!(
            encoding_name(famd_encoding_for_save(Some(source))),
            text(case, "encoding"),
            "{source:.40}"
        );
        assert_eq!(is_active_v2(source), case["activeV2"].as_bool().unwrap());
        assert_eq!(
            famd_looks_stored(source),
            case["looksStored"].as_bool().unwrap()
        );
    }
    assert_eq!(famd_encoding_for_save(None), FamdEncoding::V2);
    for case in golden["marks"].as_array().unwrap() {
        assert_eq!(
            ink_has_marks(&case["value"]),
            case["marks"].as_bool().unwrap(),
            "{}",
            case["value"]
        );
    }
}
