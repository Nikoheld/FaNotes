//! `fanotes-famd:v2` codec.
//!
//! Byte-compatible with `fanotes/electron/famdV2.mjs`: the markdown stays in
//! front of a `<!-- fanotes-famd:v2 chars=N crc=XXXXXXXX -->` header, and the
//! JSON after it stores every stroke's points as 36-byte records in a
//! JSON-safe base-85 string. `N` is the JavaScript length of the JSON and the
//! CRC-32 covers its UTF-8 bytes, so a short or damaged file is reported as
//! corrupt instead of reading as an empty note.

use std::fmt;

use serde_json::{Map, Value};

use crate::{is_js_whitespace, js_json_number, js_number, slice_js};

pub const FAMD_V2_SCHEMA: &str = "fanotes-famd-v2";
pub const FAMD_V2_TOKEN: &str = "fanotes-famd:v2";
pub(crate) const FAMD_V1_TOKEN: &str = "fanotes-famd:v1";
pub const POINT_STRIDE: usize = 36;
const MAX_PAYLOAD_CHARS: u64 = 32 * 1024 * 1024;
const PACKED_POINT_KEYS: &[&str] = &["x", "y", "t", "pressure", "tiltX", "tiltY", "pointerType"];
const PACKED_STROKE_KEYS: &[&str] = &[
    "points",
    "famdPts",
    "famdPtExtra",
    "famdPtr",
    "famdPtrList",
    "famdPtrIdx",
];
const UNPACKED_STROKE_KEYS: &[&str] = &[
    "famdPts",
    "famdPtExtra",
    "famdPtr",
    "famdPtrList",
    "famdPtrIdx",
];

// 85 printable ASCII characters that JSON.stringify leaves unescaped.
const FAMD85: &[u8; 85] =
    b"!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw";

const fn famd85_index() -> [u8; 128] {
    let mut table = [255u8; 128];
    let mut index = 0;
    while index < FAMD85.len() {
        table[FAMD85[index] as usize] = index as u8;
        index += 1;
    }
    table
}

static FAMD85_INDEX: [u8; 128] = famd85_index();

/// The JavaScript `FamdCorruptError`. The text is the JavaScript message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FamdCorruptError(pub &'static str);

impl fmt::Display for FamdCorruptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for FamdCorruptError {}

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut entry = 0;
    while entry < 256 {
        let mut value = entry as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 != 0 {
                (value >> 1) ^ 0xedb8_8320
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[entry] = value;
        entry += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = crc_table();

/// IEEE CRC-32 of `bytes`.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc = CRC_TABLE[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

/// `crcHex`: eight lowercase hex digits of the CRC-32 of the UTF-8 text.
pub fn crc_hex(text: &str) -> String {
    format!("{:08x}", crc32(text.as_bytes()))
}

fn encode85(bytes: &[u8]) -> String {
    debug_assert!(bytes.len() % 4 == 0);
    let mut out = Vec::with_capacity(bytes.len() / 4 * 5);
    for group in bytes.chunks_exact(4) {
        let mut value = u32::from_be_bytes([group[0], group[1], group[2], group[3]]);
        let mut digits = [0u8; 5];
        for slot in digits.iter_mut().rev() {
            *slot = FAMD85[(value % 85) as usize];
            value /= 85;
        }
        out.extend_from_slice(&digits);
    }
    // Every byte comes from the ASCII alphabet.
    String::from_utf8(out).unwrap_or_default()
}

/// `decode85`. Any character outside the alphabet, a length that is not a
/// multiple of five, or a group above `u32::MAX` is a corrupt point block.
pub fn decode85(value: &str) -> Result<Vec<u8>, FamdCorruptError> {
    let bytes = value.as_bytes();
    if bytes.len() % 5 != 0 {
        return Err(FamdCorruptError("famd v2 point block"));
    }
    let mut out = Vec::with_capacity(bytes.len() / 5 * 4);
    for group in bytes.chunks_exact(5) {
        let mut value = 0u64;
        for &code in group {
            let digit = if code < 128 {
                FAMD85_INDEX[code as usize]
            } else {
                255
            };
            if digit == 255 {
                return Err(FamdCorruptError("famd v2 point block"));
            }
            value = value * 85 + u64::from(digit);
        }
        if value > 0xffff_ffff {
            return Err(FamdCorruptError("famd v2 point block"));
        }
        out.extend_from_slice(&(value as u32).to_be_bytes());
    }
    Ok(out)
}

/// `quantizeUnit`: `Number(value)` clamped to 0..1 in 1/65535 steps.
fn quantize_unit(value: Option<&Value>) -> u16 {
    let number = js_number(value);
    if !number.is_finite() {
        return 0;
    }
    let clamped = number.clamp(0.0, 1.0);
    // `Math.round` of a non-negative number rounds half up, as `f64::round` does.
    (clamped * 65535.0).round() as u16
}

fn finite_or_nan(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// A canonical quiet NaN marks a missing sample.
fn float_bytes(value: f64) -> [u8; 8] {
    if value.is_finite() {
        value.to_le_bytes()
    } else {
        [0, 0, 0, 0, 0, 0, 0xf8, 0x7f]
    }
}

/// `point.key` for an object or an array index.
pub(crate) fn js_get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        Value::Array(items) => array_index(key).and_then(|index| items.get(index as usize)),
        _ => None,
    }
}

/// `Object.keys` of an object or an array. Other values have no keys here.
pub(crate) fn js_keys(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => ordered_keys(map).into_iter().map(str::to_owned).collect(),
        Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// A canonical array index (`0` to `2^32 - 2`). JavaScript lists those keys
/// first, in numeric order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    (value < u64::from(u32::MAX)).then_some(value as u32)
}

fn ordered_keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut indices: Vec<(u32, &str)> = map
        .keys()
        .filter_map(|key| array_index(key).map(|index| (index, key.as_str())))
        .collect();
    indices.sort_by_key(|(index, _)| *index);
    let mut keys: Vec<&str> = indices.into_iter().map(|(_, key)| key).collect();
    keys.extend(
        map.keys()
            .filter(|key| array_index(key).is_none())
            .map(String::as_str),
    );
    keys
}

fn point_extras(point: &Value, keep_pointer: bool) -> Option<Map<String, Value>> {
    let mut extra: Option<Map<String, Value>> = None;
    for key in js_keys(point) {
        if PACKED_POINT_KEYS.contains(&key.as_str()) && (key != "pointerType" || !keep_pointer) {
            continue;
        }
        let Some(value) = js_get(point, &key) else {
            continue;
        };
        extra
            .get_or_insert_with(Map::new)
            .insert(key.clone(), value.clone());
    }
    extra
}

enum PointerPack {
    None { overflow: bool },
    Single(String),
    List(Vec<String>, String),
}

fn pack_pointer(points: &[Value]) -> PointerPack {
    let types: Vec<Option<&str>> = points
        .iter()
        .map(|point| match point {
            Value::Object(map) => map.get("pointerType").and_then(Value::as_str),
            _ => None,
        })
        .collect();
    if types.iter().all(Option::is_none) {
        return PointerPack::None { overflow: false };
    }
    let first = types[0];
    if types.iter().all(|kind| *kind == first) {
        if let Some(first) = first {
            return PointerPack::Single(first.to_owned());
        }
    }
    let mut dict: Vec<String> = Vec::new();
    for kind in types.iter().flatten() {
        if !dict.iter().any(|known| known == kind) {
            if dict.len() == 255 {
                return PointerPack::None { overflow: true };
            }
            dict.push((*kind).to_owned());
        }
    }
    let mut raw: Vec<u8> = types
        .iter()
        .map(|kind| match kind {
            None => 255,
            Some(kind) => dict.iter().position(|known| known == kind).unwrap_or(255) as u8,
        })
        .collect();
    let padding = (4 - raw.len() % 4) % 4;
    raw.extend(std::iter::repeat_n(0u8, padding));
    PointerPack::List(dict, encode85(&raw))
}

fn pack_points(points: &[Value], keep_pointer: bool) -> (String, Option<Vec<Value>>) {
    let mut bytes = Vec::with_capacity(points.len() * POINT_STRIDE);
    let mut extras = Vec::with_capacity(points.len());
    let mut any_extra = false;
    let empty = Value::Object(Map::new());
    for point in points {
        let point = match point {
            Value::Object(_) | Value::Array(_) => point,
            _ => &empty,
        };
        bytes.extend_from_slice(&quantize_unit(js_get(point, "x")).to_le_bytes());
        bytes.extend_from_slice(&quantize_unit(js_get(point, "y")).to_le_bytes());
        for key in ["pressure", "t", "tiltX", "tiltY"] {
            bytes.extend_from_slice(&float_bytes(finite_or_nan(js_get(point, key))));
        }
        match point_extras(point, keep_pointer) {
            Some(extra) => {
                any_extra = true;
                extras.push(Value::Object(extra));
            }
            None => extras.push(Value::Null),
        }
    }
    (encode85(&bytes), any_extra.then_some(extras))
}

fn pack_stroke(stroke: &Value) -> Value {
    let Value::Object(map) = stroke else {
        return stroke.clone();
    };
    let Some(Value::Array(points)) = map.get("points") else {
        return stroke.clone();
    };
    let mut next = Map::new();
    for key in ordered_keys(map) {
        if PACKED_STROKE_KEYS.contains(&key) {
            continue;
        }
        next.insert(key.to_owned(), map[key].clone());
    }
    let pointer = pack_pointer(points);
    let overflow = matches!(pointer, PointerPack::None { overflow: true });
    let (famd_pts, extras) = pack_points(points, overflow);
    next.insert("famdPts".into(), Value::String(famd_pts));
    if let Some(extras) = extras {
        next.insert("famdPtExtra".into(), Value::Array(extras));
    }
    match pointer {
        PointerPack::Single(kind) => {
            next.insert("famdPtr".into(), Value::String(kind));
        }
        PointerPack::List(dict, index) => {
            next.insert(
                "famdPtrList".into(),
                Value::Array(dict.into_iter().map(Value::String).collect()),
            );
            next.insert("famdPtrIdx".into(), Value::String(index));
        }
        PointerPack::None { .. } => {}
    }
    Value::Object(next)
}

/// `packV2Ink`: strokes with a `points` list become packed columns. A stroke
/// that is already packed, and every other key, passes through.
pub fn pack_v2_ink(ink: &Value) -> Value {
    let Value::Object(map) = ink else {
        return ink.clone();
    };
    let Some(Value::Array(strokes)) = map.get("strokes") else {
        return ink.clone();
    };
    let mut next = Map::new();
    for key in ordered_keys(map) {
        if key == "strokes" {
            continue;
        }
        next.insert(key.to_owned(), map[key].clone());
    }
    next.insert(
        "strokes".into(),
        Value::Array(strokes.iter().map(pack_stroke).collect()),
    );
    Value::Object(next)
}

/// A sample read from the file. JavaScript keeps an infinite value, which
/// `JSON.stringify` writes as `null`.
fn sample(value: f64) -> Value {
    if value.is_finite() {
        js_json_number(value)
    } else {
        Value::Null
    }
}

fn unpack_stroke(stroke: &Value) -> Result<Value, FamdCorruptError> {
    let Value::Object(map) = stroke else {
        return Ok(stroke.clone());
    };
    let Some(Value::String(famd_pts)) = map.get("famdPts") else {
        return Ok(stroke.clone());
    };
    let bytes = decode85(famd_pts)?;
    if bytes.len() % POINT_STRIDE != 0 {
        return Err(FamdCorruptError("famd v2 point block length"));
    }
    let extras = map.get("famdPtExtra").and_then(Value::as_array);
    let shared_pointer = map.get("famdPtr").and_then(Value::as_str);
    let count = bytes.len() / POINT_STRIDE;
    let mut points: Vec<Map<String, Value>> = Vec::with_capacity(count);
    for (index, record) in bytes.chunks_exact(POINT_STRIDE).enumerate() {
        let float = |offset: usize| {
            let mut raw = [0u8; 8];
            raw.copy_from_slice(&record[offset..offset + 8]);
            f64::from_le_bytes(raw)
        };
        let mut point = Map::new();
        let x = u16::from_le_bytes([record[0], record[1]]);
        let y = u16::from_le_bytes([record[2], record[3]]);
        point.insert("x".into(), js_json_number(f64::from(x) / 65535.0));
        point.insert("y".into(), js_json_number(f64::from(y) / 65535.0));
        let pressure = float(4);
        let time = float(12);
        let tilt_x = float(20);
        let tilt_y = float(28);
        if !time.is_nan() {
            point.insert("t".into(), sample(time));
        }
        if !pressure.is_nan() {
            point.insert("pressure".into(), sample(pressure));
        }
        if !tilt_x.is_nan() {
            point.insert("tiltX".into(), sample(tilt_x));
        }
        if !tilt_y.is_nan() {
            point.insert("tiltY".into(), sample(tilt_y));
        }
        if let Some(Value::Object(extra)) = extras.and_then(|extras| extras.get(index)) {
            for key in ordered_keys(extra) {
                point.insert(key.to_owned(), extra[key].clone());
            }
        }
        if let Some(kind) = shared_pointer {
            point.insert("pointerType".into(), Value::String(kind.to_owned()));
        }
        points.push(point);
    }
    if let (Some(Value::Array(list)), Some(Value::String(index_text))) =
        (map.get("famdPtrList"), map.get("famdPtrIdx"))
    {
        let raw = decode85(index_text)?;
        if raw.len() < count {
            return Err(FamdCorruptError("famd v2 pointer index"));
        }
        for (index, point) in points.iter_mut().enumerate() {
            let code = raw[index];
            if code == 255 {
                continue;
            }
            match list.get(code as usize) {
                Some(Value::String(name)) => {
                    point.insert("pointerType".into(), Value::String(name.clone()));
                }
                _ => return Err(FamdCorruptError("famd v2 pointer index")),
            }
        }
    }
    let mut next = Map::new();
    for key in ordered_keys(map) {
        if UNPACKED_STROKE_KEYS.contains(&key) {
            continue;
        }
        next.insert(key.to_owned(), map[key].clone());
    }
    next.insert(
        "points".into(),
        Value::Array(points.into_iter().map(Value::Object).collect()),
    );
    Ok(Value::Object(next))
}

/// `unpackInk`: packed strokes get their `points` list back.
pub fn unpack_v2_ink(ink: &Value) -> Result<Value, FamdCorruptError> {
    let Value::Object(map) = ink else {
        return Ok(ink.clone());
    };
    let Some(Value::Array(strokes)) = map.get("strokes") else {
        return Ok(ink.clone());
    };
    let mut next = map.clone();
    let unpacked = strokes
        .iter()
        .map(unpack_stroke)
        .collect::<Result<Vec<_>, _>>()?;
    next.insert("strokes".into(), Value::Array(unpacked));
    Ok(Value::Object(next))
}

/// `isActiveV2`: the last v2 marker comes after the last v1 marker.
pub fn is_active_v2(source: &str) -> bool {
    match source.rfind(FAMD_V2_TOKEN) {
        Some(v2) => source.rfind(FAMD_V1_TOKEN).is_none_or(|v1| v2 > v1),
        None => false,
    }
}

struct Located {
    json_start: usize,
    length: usize,
    crc: String,
}

fn header_start(source: &str, token_at: usize) -> Option<usize> {
    source[..token_at].rfind("<!--")
}

fn skip_ws(source: &str, mut index: usize) -> usize {
    while let Some(character) = source[index..].chars().next() {
        if !is_js_whitespace(character) {
            break;
        }
        index += character.len_utf8();
    }
    index
}

/// `locateV2`, with the header read as the JavaScript pattern
/// `^<!--\s*fanotes-famd:v2\s+chars=(\d+)\s+crc=([0-9a-fA-F]{8})\s*-->\n`.
fn locate_v2(source: &str) -> Result<Option<Located>, FamdCorruptError> {
    const HEADER: FamdCorruptError = FamdCorruptError("truncated famd v2 header");
    let Some(token_at) = source.rfind(FAMD_V2_TOKEN) else {
        return Ok(None);
    };
    let start = header_start(source, token_at).ok_or(HEADER)?;
    let slice = &source[start..];
    let mut index = skip_ws(slice, 4);
    if !slice[index..].starts_with(FAMD_V2_TOKEN) {
        return Err(HEADER);
    }
    index += FAMD_V2_TOKEN.len();
    let after = skip_ws(slice, index);
    if after == index || !slice[after..].starts_with("chars=") {
        return Err(HEADER);
    }
    index = after + "chars=".len();
    let digits_start = index;
    while slice.as_bytes().get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == digits_start {
        return Err(HEADER);
    }
    let digits = &slice[digits_start..index];
    let after = skip_ws(slice, index);
    if after == index || !slice[after..].starts_with("crc=") {
        return Err(HEADER);
    }
    index = after + "crc=".len();
    let crc = slice.get(index..index + 8).ok_or(HEADER)?;
    if !crc.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HEADER);
    }
    index = skip_ws(slice, index + 8);
    if !slice[index..].starts_with("-->\n") {
        return Err(HEADER);
    }
    index += 4;
    let length = digits
        .parse::<u64>()
        .ok()
        .filter(|length| (2..=MAX_PAYLOAD_CHARS).contains(length))
        .ok_or(FamdCorruptError("famd v2 length"))?;
    Ok(Some(Located {
        json_start: start + index,
        length: length as usize,
        crc: crc.to_ascii_lowercase(),
    }))
}

/// `v2CutIndex`: where the markdown in front of the v2 header ends.
pub(crate) fn v2_cut_index(source: &str) -> Option<usize> {
    let token_at = source.rfind(FAMD_V2_TOKEN)?;
    let Some(start) = header_start(source, token_at) else {
        return Some(token_at);
    };
    Some(if start > 0 && source.as_bytes()[start - 1] == b'\n' {
        start - 1
    } else {
        start
    })
}

/// `readV2Payload`: the stored object with `ink` unpacked, or kept packed
/// when `unpack` is false.
pub(crate) fn read_v2_payload(
    source: &str,
    unpack: bool,
) -> Result<Map<String, Value>, FamdCorruptError> {
    let located = locate_v2(source)?.ok_or(FamdCorruptError("missing famd v2 header"))?;
    let json = slice_js(source, located.json_start, located.length)
        .ok_or(FamdCorruptError("truncated famd v2 payload"))?;
    if crc_hex(json) != located.crc {
        return Err(FamdCorruptError("famd v2 checksum"));
    }
    let parsed: Value = serde_json::from_str(json).map_err(|_| FamdCorruptError("famd v2 json"))?;
    let Value::Object(mut object) = parsed else {
        return Err(FamdCorruptError("famd v2 schema"));
    };
    if object.get("schema").and_then(Value::as_str) != Some(FAMD_V2_SCHEMA) {
        return Err(FamdCorruptError("famd v2 schema"));
    }
    let ink = object.get("ink").cloned().unwrap_or(Value::Null);
    let ink = if unpack { unpack_v2_ink(&ink)? } else { ink };
    object.insert("ink".into(), ink);
    Ok(object)
}

/// `encodeV2Document` for the sanitized object `serializeFamd` builds.
pub(crate) fn encode_v2_document(body: &str, mut stored: Map<String, Value>) -> String {
    stored.insert("schema".into(), Value::String(FAMD_V2_SCHEMA.into()));
    let ink = stored.get("ink").cloned().unwrap_or(Value::Null);
    stored.insert("ink".into(), pack_v2_ink(&ink));
    let json = js_stringify(&Value::Object(stored));
    let header = format!(
        "<!-- fanotes-famd:v2 chars={} crc={} -->\n",
        json.encode_utf16().count(),
        crc_hex(&json)
    );
    if body.is_empty() {
        format!("{header}{json}\n")
    } else {
        format!("{body}\n\n{header}{json}\n")
    }
}

/// `JSON.stringify(value)`: array-index keys first, JavaScript number text.
pub fn js_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_js(value, &mut out);
    out
}

fn write_js(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&js_number_text(number)),
        Value::String(text) => write_js_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_js(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, key) in ordered_keys(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_js_string(key, out);
                out.push(':');
                write_js(&map[key], out);
            }
            out.push('}');
        }
    }
}

fn write_js_string(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

const MAX_SAFE: u64 = (1 << 53) - 1;

fn js_number_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_u64() {
        if value <= MAX_SAFE {
            return value.to_string();
        }
    }
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() <= MAX_SAFE {
            return value.to_string();
        }
    }
    js_float_text(number.as_f64().unwrap_or(f64::NAN))
}

/// `Number.prototype.toString` for `JSON.stringify`: decimal notation from
/// 1e-7 up to 1e21, exponent notation outside it.
pub fn js_float_text(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let text = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let power = n - 1;
        let power_sign = if power < 0 { '-' } else { '+' };
        let lead = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{lead}e{power_sign}{}", power.unsigned_abs())
    };
    format!("{sign}{text}")
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn js_falsy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Number(number) => number.as_f64().is_none_or(|value| value == 0.0),
        Value::String(text) => text.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_ieee_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc_hex(""), "00000000");
    }

    #[test]
    fn base85_round_trips_and_rejects_bad_groups() {
        let bytes = [0u8, 1, 2, 3, 255, 255, 255, 255, 9, 8, 7, 6];
        let text = encode85(&bytes);
        assert_eq!(text.len(), 15);
        assert_eq!(decode85(&text).unwrap(), bytes);
        assert!(decode85("!!!!").is_err());
        assert!(decode85("!!!!\"").is_err());
        assert!(decode85("wwwww").is_err());
    }

    #[test]
    fn numbers_use_the_javascript_text() {
        for (value, text) in [
            (0.1, "0.1"),
            (1.5259021896696422e-5, "0.000015259021896696422"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1.2345e22, "1.2345e+22"),
            (123456789012345680000.0, "123456789012345680000"),
            (-0.0000005, "-5e-7"),
            (-2.5, "-2.5"),
            (1730000000000.125, "1730000000000.125"),
            (-0.0, "0"),
        ] {
            assert_eq!(js_float_text(value), text, "{value}");
        }
        assert_eq!(
            js_stringify(
                &serde_json::json!({"b": 1, "2": 2, "a": [1.0, "x\u{1}"], "10": null, "01": 3})
            ),
            "{\"2\":2,\"10\":null,\"b\":1,\"a\":[1,\"x\\u0001\"],\"01\":3}"
        );
    }
}
