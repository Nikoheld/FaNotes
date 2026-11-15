//! The parts of `.famd` (`fanotes-famd:v1` and `:v2`) the index reads: the
//! markdown body (`stripFamdPayload` in `src/lib/famd.ts`) and the ink's
//! `searchTranscript`. Stroke data is skipped without being decoded.

use std::fmt;

use serde::de::{self, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::Deserialize;

const V1_TOKEN: &str = "fanotes-famd:v1";
const V2_TOKEN: &str = "fanotes-famd:v2";
const FAMD_SCHEMA: &str = "fanotes-famd-v1";
const FAMD_V2_SCHEMA: &str = "fanotes-famd-v2";
const MAX_PAYLOAD_CHARS: usize = 32 * 1024 * 1024;
pub const MAX_TRANSCRIPT_UNITS: usize = 500_000;

fn is_js_space(c: char) -> bool {
    (c as u32) < 0x10000 && crate::text::is_js_space(c as u32 as u16)
}

fn skip_spaces(s: &str, mut at: usize) -> usize {
    while let Some(c) = s[at..].chars().next() {
        if !is_js_space(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}

fn skip_digits(s: &str, at: usize) -> usize {
    at + s[at..].bytes().take_while(u8::is_ascii_digit).count()
}

fn eat(s: &str, at: usize, literal: &str) -> Option<usize> {
    s[at..].starts_with(literal).then(|| at + literal.len())
}

/// `<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n` at `at`: (end, chars digits).
fn v1_header_at(s: &str, at: usize) -> Option<(usize, &str)> {
    let at = eat(s, at, "<!--")?;
    let at = skip_spaces(s, at);
    let at = eat(s, at, V1_TOKEN)?;
    let spaced = skip_spaces(s, at);
    if spaced == at {
        return None;
    }
    let at = eat(s, spaced, "chars=")?;
    let digits_end = skip_digits(s, at);
    if digits_end == at {
        return None;
    }
    let digits = &s[at..digits_end];
    let at = skip_spaces(s, digits_end);
    let at = eat(s, at, "-->\n")?;
    Some((at, digits))
}

/// The last match of `/(?:^|\n)<!--…v1…-->\n/gu`: (match index, header end, chars).
fn last_v1_header(s: &str) -> Option<(usize, usize, &str)> {
    let mut last = None;
    let mut consumed = 0usize;
    let mut search = 0usize;
    while let Some(offset) = s[search..].find("<!--") {
        let at = search + offset;
        let index = if at == 0 && consumed == 0 {
            Some(0)
        } else if at > 0 && s.as_bytes()[at - 1] == b'\n' && at > consumed {
            Some(at - 1)
        } else {
            None
        };
        if let Some(index) = index {
            if let Some((end, digits)) = v1_header_at(s, at) {
                last = Some((index, end, digits));
                consumed = end;
                search = end;
                continue;
            }
        }
        search = at + 4;
    }
    last
}

/// `v2CutIndex(source)`.
fn v2_cut_index(s: &str) -> Option<usize> {
    let token_at = s.rfind(V2_TOKEN)?;
    match s[..token_at].rfind("<!--") {
        None => Some(token_at),
        Some(start) => Some(if start > 0 && s.as_bytes()[start - 1] == b'\n' {
            start - 1
        } else {
            start
        }),
    }
}

fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

fn is_sidecar_json(value: &str) -> bool {
    let trimmed = value.trim_matches(is_js_space);
    if !trimmed.starts_with('{') || !trimmed.contains(FAMD_SCHEMA) {
        return false;
    }
    #[derive(Deserialize)]
    struct Schema {
        schema: Option<serde_json::Value>,
    }
    matches!(serde_json::from_str::<Schema>(trimmed), Ok(Schema { schema: Some(serde_json::Value::String(schema)) }) if schema == FAMD_SCHEMA)
}

/// `stripFamdPayload(source)`: the markdown body.
pub fn strip_famd_payload(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    let v1 = last_v1_header(source).map(|(index, _, _)| index);
    let v2 = if source.contains(V2_TOKEN) {
        v2_cut_index(source)
    } else {
        None
    };
    let cut = match (v1, v2) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    let text = trim_end_js(match cut {
        Some(cut) => &source[..cut],
        None => source,
    });
    if is_sidecar_json(text) {
        return String::new();
    }
    // `/\n(\{[\s\S]*\})\s*$/u`: the first "\n{" when the text ends with "}".
    if text.ends_with('}') {
        if let Some(index) = text.find("\n{") {
            if is_sidecar_json(&text[index + 1..]) {
                return trim_end_js(&text[..index]).to_owned();
            }
        }
    }
    text.to_owned()
}

/// Byte offset after `units` UTF-16 units from `start`, if the text is that long.
fn advance_utf16(s: &str, start: usize, units: usize) -> Option<usize> {
    let mut count = 0usize;
    let mut at = start;
    for c in s[start..].chars() {
        if count >= units {
            break;
        }
        count += c.len_utf16();
        at += c.len_utf8();
    }
    (count == units).then_some(at)
}

/// Only `schema` and `ink.searchTranscript`; every other field is skipped unread.
#[derive(Default)]
struct PayloadProbe {
    schema: Option<String>,
    transcript: Option<Option<String>>,
}

struct InkProbe(Option<String>);

impl<'de> Deserialize<'de> for InkProbe {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InkVisitor;
        impl<'de> Visitor<'de> for InkVisitor {
            type Value = InkProbe;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<InkProbe, A::Error> {
                let mut transcript = None;
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    if key == "searchTranscript" {
                        transcript = match map.next_value::<serde_json::Value>()? {
                            serde_json::Value::String(text) => Some(text),
                            _ => None,
                        };
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(InkProbe(transcript))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<InkProbe, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(InkProbe(None))
            }
            fn visit_bool<E>(self, _: bool) -> Result<InkProbe, E> {
                Ok(InkProbe(None))
            }
            fn visit_i64<E>(self, _: i64) -> Result<InkProbe, E> {
                Ok(InkProbe(None))
            }
            fn visit_u64<E>(self, _: u64) -> Result<InkProbe, E> {
                Ok(InkProbe(None))
            }
            fn visit_f64<E>(self, _: f64) -> Result<InkProbe, E> {
                Ok(InkProbe(None))
            }
            fn visit_str<E>(self, _: &str) -> Result<InkProbe, E> {
                Ok(InkProbe(None))
            }
            fn visit_unit<E>(self) -> Result<InkProbe, E> {
                Ok(InkProbe(None))
            }
        }
        deserializer.deserialize_any(InkVisitor)
    }
}

impl<'de> Deserialize<'de> for PayloadProbe {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PayloadVisitor;
        impl<'de> Visitor<'de> for PayloadVisitor {
            type Value = PayloadProbe;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a famd payload object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<PayloadProbe, A::Error> {
                let mut probe = PayloadProbe::default();
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    match key.as_ref() {
                        "schema" => {
                            probe.schema = match map.next_value::<serde_json::Value>()? {
                                serde_json::Value::String(text) => Some(text),
                                _ => None,
                            }
                        }
                        "ink" => probe.transcript = Some(map.next_value::<InkProbe>()?.0),
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(probe)
            }
        }
        deserializer.deserialize_map(PayloadVisitor)
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (entry, slot) in table.iter_mut().enumerate() {
            let mut value = entry as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    (value >> 1) ^ 0xedb8_8320
                } else {
                    value >> 1
                };
            }
            *slot = value;
        }
        table
    });
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc = table[((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

fn transcript_from_json(json: &str, schemas: &[&str]) -> Option<String> {
    let probe: PayloadProbe = serde_json::from_str(json).ok()?;
    if !schemas.contains(&probe.schema.as_deref()?) {
        return None;
    }
    probe.transcript.flatten()
}

/// `ink.searchTranscript` of the active payload, cut to 500,000 UTF-16 units.
pub fn famd_transcript(source: &str) -> Option<String> {
    if source.is_empty() {
        return None;
    }
    let v1_at = source.rfind(V1_TOKEN);
    let v2_at = source.rfind(V2_TOKEN);
    let transcript = if v2_at.is_some() && v2_at > v1_at {
        // `readV2Payload`: exact header, length, CRC-32 of the UTF-8 JSON.
        let token_at = v2_at?;
        let start = source[..token_at].rfind("<!--")?;
        let at = eat(source, start, "<!--")?;
        let at = skip_spaces(source, at);
        let at = eat(source, at, V2_TOKEN)?;
        let spaced = skip_spaces(source, at);
        if spaced == at {
            return None;
        }
        let at = eat(source, spaced, "chars=")?;
        let digits_end = skip_digits(source, at);
        let length: usize = source[at..digits_end].parse().ok()?;
        let spaced = skip_spaces(source, digits_end);
        if spaced == digits_end {
            return None;
        }
        let at = eat(source, spaced, "crc=")?;
        let crc = source.get(at..at + 8)?;
        if !crc.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let at = skip_spaces(source, at + 8);
        let json_start = eat(source, at, "-->\n")?;
        if !(2..=MAX_PAYLOAD_CHARS).contains(&length) {
            return None;
        }
        let json_end = advance_utf16(source, json_start, length)?;
        let json = &source[json_start..json_end];
        if format!("{:08x}", crc32(json.as_bytes())) != crc.to_ascii_lowercase() {
            return None;
        }
        transcript_from_json(json, &[FAMD_V2_SCHEMA])?
    } else {
        let (_, end, digits) = last_v1_header(source)?;
        let length: usize = digits.parse().ok()?;
        if !(2..=MAX_PAYLOAD_CHARS).contains(&length) {
            return None;
        }
        let json_end = advance_utf16(source, end, length)?;
        transcript_from_json(&source[end..json_end], &[FAMD_SCHEMA, FAMD_V2_SCHEMA])?
    };
    Some(cut_utf16(&transcript, MAX_TRANSCRIPT_UNITS))
}

/// `text.slice(0, units)` (a split surrogate pair becomes U+FFFD).
pub fn cut_utf16(text: &str, units: usize) -> String {
    let mut count = 0usize;
    for (at, c) in text.char_indices() {
        if count + c.len_utf16() > units {
            if count < units {
                let mut out = text[..at].to_owned();
                out.push('\u{FFFD}');
                return out;
            }
            return text[..at].to_owned();
        }
        count += c.len_utf16();
    }
    text.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v1(markdown: &str, json: &str) -> String {
        format!(
            "{markdown}\n<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
            json.encode_utf16().count()
        )
    }

    #[test]
    fn strips_v1_and_reads_the_transcript() {
        let json = r#"{"schema":"fanotes-famd-v1","updatedAt":"2026-01-01T00:00:00.000Z","ink":{"strokes":[{"points":[1,2]}],"searchTranscript":"0.2\tGrüße"},"worksheets":[]}"#;
        let source = v1("# Titel\nText", json);
        assert_eq!(strip_famd_payload(&source), "# Titel\nText");
        assert_eq!(famd_transcript(&source).as_deref(), Some("0.2\tGrüße"));
        assert_eq!(famd_transcript("# nur Text"), None);
    }

    #[test]
    fn reads_v2_only_with_a_matching_checksum() {
        let json =
            r#"{"schema":"fanotes-famd-v2","ink":{"searchTranscript":"Zelle"},"worksheets":[]}"#;
        let crc = format!("{:08x}", crc32(json.as_bytes()));
        let source = format!(
            "Body\n\n<!-- fanotes-famd:v2 chars={} crc={crc} -->\n{json}\n",
            json.len()
        );
        assert_eq!(strip_famd_payload(&source), "Body");
        assert_eq!(famd_transcript(&source).as_deref(), Some("Zelle"));
        let broken = source.replace(&crc, "00000000");
        assert_eq!(famd_transcript(&broken), None);
    }

    #[test]
    fn a_trailing_sidecar_json_is_not_text() {
        assert_eq!(
            strip_famd_payload("Hallo\n{\"schema\":\"fanotes-famd-v1\"}\n"),
            "Hallo"
        );
        assert_eq!(strip_famd_payload("{\"schema\":\"fanotes-famd-v1\"}"), "");
        assert_eq!(strip_famd_payload("Code {\n}"), "Code {\n}");
    }
}
