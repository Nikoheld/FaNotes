//! `fanotes-famd:v2`, bit for bit as `fanotes/electron/famdV2.mjs`.
//!
//! Points are 36 bytes (uint16 x, uint16 y, float64 pressure, time, tiltX,
//! tiltY, little endian), base-85 encoded with the JSON-safe alphabet, and a
//! CRC-32 covers the JSON. Unknown point keys travel in `famdPtExtra`.

use crate::jsjson::{self, to_number, Js, JsObject, JsString};

pub const FAMD_V2_SCHEMA: &str = "fanotes-famd-v2";
pub const FAMD_V2_TOKEN: &str = "fanotes-famd:v2";
const POINT_STRIDE: usize = 36;
const MAX_PAYLOAD_CHARS: f64 = 32.0 * 1024.0 * 1024.0;
const FAMD85: &[u8; 85] =
    b"!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw";
const PACKED_POINT_KEYS: &[&str] = &["x", "y", "t", "pressure", "tiltX", "tiltY", "pointerType"];
const PACKED_STROKE_KEYS: &[&str] = &[
    "points",
    "famdPts",
    "famdPtExtra",
    "famdPtr",
    "famdPtrList",
    "famdPtrIdx",
];

/// `FamdCorruptError` with its message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamdError(pub String);

impl FamdError {
    fn new(message: &str) -> Self {
        Self(message.to_owned())
    }
}

fn famd85_index(code: u16) -> u8 {
    if code >= 128 {
        return 255;
    }
    FAMD85
        .iter()
        .position(|&byte| u16::from(byte) == code)
        .map_or(255, |index| index as u8)
}

static CRC_TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();

fn crc_table() -> &'static [u32; 256] {
    CRC_TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (entry, slot) in table.iter_mut().enumerate() {
            let mut value = entry as u32;
            for _ in 0..8 {
                let mask = (value & 1).wrapping_neg();
                value = (value >> 1) ^ (0xedb8_8320 & mask);
            }
            *slot = value;
        }
        table
    })
}

pub fn crc32(bytes: &[u8]) -> u32 {
    let table = crc_table();
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc = table[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

/// `crcHex(text)`: CRC-32 of the UTF-8 bytes, 8 lowercase hex digits.
pub fn crc_hex(text: &str) -> String {
    format!("{:08x}", crc32(text.as_bytes()))
}

pub fn encode85(bytes: &[u8]) -> Result<String, FamdError> {
    if !bytes.len().is_multiple_of(4) {
        return Err(FamdError::new("famd v2 point block length"));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 5);
    for chunk in bytes.as_chunks::<4>().0 {
        let mut value = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let mut digits = [0u8; 5];
        for slot in digits.iter_mut().rev() {
            *slot = FAMD85[(value % 85) as usize];
            value /= 85;
        }
        out.extend_from_slice(&digits);
    }
    Ok(String::from_utf8(out).expect("ascii alphabet"))
}

pub fn decode85(value: &JsString) -> Result<Vec<u8>, FamdError> {
    let units = &value.0;
    if !units.len().is_multiple_of(5) {
        return Err(FamdError::new("famd v2 point block"));
    }
    let mut bytes = Vec::with_capacity(units.len() / 5 * 4);
    for group in units.as_chunks::<5>().0 {
        let mut value: u64 = 0;
        for &unit in group {
            let digit = famd85_index(unit);
            if digit == 255 {
                return Err(FamdError::new("famd v2 point block"));
            }
            value = value * 85 + u64::from(digit);
        }
        if value > 0xffff_ffff {
            return Err(FamdError::new("famd v2 point block"));
        }
        bytes.extend_from_slice(&(value as u32).to_be_bytes());
    }
    Ok(bytes)
}

fn quantize_unit(value: Option<&Js>) -> u16 {
    let number = to_number(value);
    if !number.is_finite() {
        return 0;
    }
    let clamped = if number < 0.0 {
        0.0
    } else if number > 1.0 {
        1.0
    } else {
        number
    };
    jsjson::js_round(clamped * 65535.0) as u16
}

fn finite_or_nan(value: Option<&Js>) -> f64 {
    match value {
        Some(Js::Num(number)) if number.is_finite() => *number,
        _ => f64::NAN,
    }
}

fn write_float64(out: &mut [u8], value: f64) {
    if value.is_finite() {
        out.copy_from_slice(&value.to_le_bytes());
    } else {
        // Canonical quiet NaN: low word 0, high word 0x7ff80000.
        out.copy_from_slice(&0x7ff8_0000_0000_0000u64.to_le_bytes());
    }
}

/// `for (const key in value)` on an object or array: own enumerable keys in order.
fn own_entries(value: &Js) -> Vec<(JsString, Js)> {
    match value {
        Js::Obj(object) => object.entries().to_vec(),
        Js::Arr(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (JsString::from_str(&index.to_string()), item.clone()))
            .collect(),
        _ => Vec::new(),
    }
}

fn point_extras(point: &Js, keep_pointer: bool) -> Option<JsObject> {
    if !point.is_object_like() {
        return None;
    }
    let mut extra: Option<JsObject> = None;
    for (key, value) in own_entries(point) {
        let packed = PACKED_POINT_KEYS.iter().any(|name| key.eq_str(name));
        if packed && (!key.eq_str("pointerType") || !keep_pointer) {
            continue;
        }
        extra.get_or_insert_with(JsObject::new).assign(key, value);
    }
    extra
}

enum Pointer {
    None,
    Overflow,
    Shared(JsString),
    Indexed(Vec<JsString>, String),
}

fn pack_pointer(points: &[Js]) -> Result<Pointer, FamdError> {
    let types: Vec<Option<JsString>> = points
        .iter()
        .map(|point| {
            if point.truthy() && point.is_object_like() {
                match point.get("pointerType") {
                    Some(Js::Str(kind)) => Some(kind.clone()),
                    _ => None,
                }
            } else {
                None
            }
        })
        .collect();
    if types.iter().all(Option::is_none) {
        return Ok(Pointer::None);
    }
    let first = types[0].clone();
    if types.iter().all(|kind| *kind == first) {
        return Ok(Pointer::Shared(first.expect("not all none")));
    }
    let mut dict: Vec<JsString> = Vec::new();
    for kind in types.iter().flatten() {
        if !dict.contains(kind) {
            if dict.len() == 255 {
                return Ok(Pointer::Overflow);
            }
            dict.push(kind.clone());
        }
    }
    let mut raw: Vec<u8> = types
        .iter()
        .map(|kind| match kind {
            None => 255,
            Some(kind) => dict
                .iter()
                .position(|candidate| candidate == kind)
                .unwrap_or(255) as u8,
        })
        .collect();
    while !raw.len().is_multiple_of(4) {
        raw.push(0);
    }
    Ok(Pointer::Indexed(dict, encode85(&raw)?))
}

fn pack_points(points: &[Js], keep_pointer: bool) -> Result<(String, Option<Vec<Js>>), FamdError> {
    let mut bytes = vec![0u8; points.len() * POINT_STRIDE];
    let mut extras: Vec<Js> = Vec::with_capacity(points.len());
    let mut any_extra = false;
    let empty = Js::Obj(JsObject::new());
    for (index, raw) in points.iter().enumerate() {
        let point = if raw.truthy() && raw.is_object_like() {
            raw
        } else {
            &empty
        };
        let offset = index * POINT_STRIDE;
        bytes[offset..offset + 2].copy_from_slice(&quantize_unit(point.get("x")).to_le_bytes());
        bytes[offset + 2..offset + 4].copy_from_slice(&quantize_unit(point.get("y")).to_le_bytes());
        write_float64(
            &mut bytes[offset + 4..offset + 12],
            finite_or_nan(point.get("pressure")),
        );
        write_float64(
            &mut bytes[offset + 12..offset + 20],
            finite_or_nan(point.get("t")),
        );
        write_float64(
            &mut bytes[offset + 20..offset + 28],
            finite_or_nan(point.get("tiltX")),
        );
        write_float64(
            &mut bytes[offset + 28..offset + 36],
            finite_or_nan(point.get("tiltY")),
        );
        match point_extras(point, keep_pointer) {
            Some(extra) => {
                any_extra = true;
                extras.push(Js::Obj(extra));
            }
            None => extras.push(Js::Null),
        }
    }
    Ok((encode85(&bytes)?, any_extra.then_some(extras)))
}

fn pack_stroke(stroke: &Js) -> Result<Js, FamdError> {
    let Js::Obj(object) = stroke else {
        return Ok(stroke.clone());
    };
    let Some(Js::Arr(points)) = object.get("points") else {
        return Ok(stroke.clone());
    };
    let mut next = JsObject::new();
    for (key, value) in object.entries() {
        if PACKED_STROKE_KEYS.iter().any(|name| key.eq_str(name)) {
            continue;
        }
        next.assign(key.clone(), value.clone());
    }
    let pointer = pack_pointer(points)?;
    let (packed, extras) = pack_points(points, matches!(pointer, Pointer::Overflow))?;
    next.assign_str("famdPts", Js::str(&packed));
    if let Some(extras) = extras {
        next.assign_str("famdPtExtra", Js::Arr(extras));
    }
    match pointer {
        Pointer::Shared(kind) => next.assign_str("famdPtr", Js::Str(kind)),
        Pointer::Indexed(dict, index) => {
            next.assign_str(
                "famdPtrList",
                Js::Arr(dict.into_iter().map(Js::Str).collect()),
            );
            next.assign_str("famdPtrIdx", Js::str(&index));
        }
        Pointer::None | Pointer::Overflow => {}
    }
    Ok(Js::Obj(next))
}

/// `packInk(ink)`; `None` is `undefined`.
pub fn pack_ink(ink: Option<&Js>) -> Result<Js, FamdError> {
    let Some(ink) = ink else { return Ok(Js::Null) };
    let Js::Obj(object) = ink else {
        // `!ink || typeof ink !== 'object' || Array.isArray(ink)` → `ink ?? null`
        return Ok(ink.clone());
    };
    let Some(Js::Arr(strokes)) = object.get("strokes") else {
        return Ok(ink.clone());
    };
    let mut next = JsObject::new();
    for (key, value) in object.entries() {
        if key.eq_str("strokes") {
            continue;
        }
        next.assign(key.clone(), value.clone());
    }
    let packed: Result<Vec<Js>, FamdError> = strokes.iter().map(pack_stroke).collect();
    next.assign_str("strokes", Js::Arr(packed?));
    Ok(Js::Obj(next))
}

fn unpack_stroke(stroke: &Js) -> Result<Js, FamdError> {
    let Js::Obj(object) = stroke else {
        return Ok(stroke.clone());
    };
    let Some(Js::Str(packed)) = object.get("famdPts") else {
        return Ok(stroke.clone());
    };
    let bytes = decode85(packed)?;
    if bytes.len() % POINT_STRIDE != 0 {
        return Err(FamdError::new("famd v2 point block length"));
    }
    let extras = match object.get("famdPtExtra") {
        Some(Js::Arr(items)) => Some(items),
        _ => None,
    };
    let count = bytes.len() / POINT_STRIDE;
    let float =
        |offset: usize| f64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("8 bytes"));
    let mut points: Vec<JsObject> = Vec::with_capacity(count);
    for index in 0..count {
        let offset = index * POINT_STRIDE;
        let mut point = JsObject::new();
        let x = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
        let y = u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]);
        point.define_str("x", Js::Num(f64::from(x) / 65535.0));
        point.define_str("y", Js::Num(f64::from(y) / 65535.0));
        let pressure = float(offset + 4);
        let time = float(offset + 12);
        let tilt_x = float(offset + 20);
        let tilt_y = float(offset + 28);
        if !time.is_nan() {
            point.assign_str("t", Js::Num(time));
        }
        if !pressure.is_nan() {
            point.assign_str("pressure", Js::Num(pressure));
        }
        if !tilt_x.is_nan() {
            point.assign_str("tiltX", Js::Num(tilt_x));
        }
        if !tilt_y.is_nan() {
            point.assign_str("tiltY", Js::Num(tilt_y));
        }
        if let Some(Some(Js::Obj(extra))) = extras.map(|items| items.get(index)) {
            for (key, value) in extra.entries() {
                point.assign(key.clone(), value.clone());
            }
        }
        if let Some(Js::Str(kind)) = object.get("famdPtr") {
            point.assign_str("pointerType", Js::Str(kind.clone()));
        }
        points.push(point);
    }
    if let (Some(Js::Arr(list)), Some(Js::Str(index))) =
        (object.get("famdPtrList"), object.get("famdPtrIdx"))
    {
        let raw = decode85(index)?;
        if raw.len() < count {
            return Err(FamdError::new("famd v2 pointer index"));
        }
        for (slot, point) in points.iter_mut().enumerate() {
            let code = raw[slot];
            if code == 255 {
                continue;
            }
            match list.get(usize::from(code)) {
                Some(Js::Str(name)) => point.assign_str("pointerType", Js::Str(name.clone())),
                _ => return Err(FamdError::new("famd v2 pointer index")),
            }
        }
    }
    let mut next = JsObject::new();
    for (key, value) in object.entries() {
        if [
            "famdPts",
            "famdPtExtra",
            "famdPtr",
            "famdPtrList",
            "famdPtrIdx",
        ]
        .iter()
        .any(|name| key.eq_str(name))
        {
            continue;
        }
        next.assign(key.clone(), value.clone());
    }
    next.assign_str("points", Js::Arr(points.into_iter().map(Js::Obj).collect()));
    Ok(Js::Obj(next))
}

/// `unpackInk(ink)`; `None` is `undefined`.
pub fn unpack_ink(ink: Option<&Js>) -> Result<Js, FamdError> {
    let Some(ink) = ink else { return Ok(Js::Null) };
    let Js::Obj(object) = ink else {
        return Ok(ink.clone());
    };
    let Some(Js::Arr(strokes)) = object.get("strokes") else {
        return Ok(ink.clone());
    };
    let unpacked: Result<Vec<Js>, FamdError> = strokes.iter().map(unpack_stroke).collect();
    let mut next = object.spread();
    next.define_str("strokes", Js::Arr(unpacked?));
    Ok(Js::Obj(next))
}

/// `isActiveV2`: the last v2 marker comes after the last v1 marker.
pub fn is_active_v2(source: &str) -> bool {
    if source.is_empty() {
        return false;
    }
    let v1 = source.rfind("fanotes-famd:v1");
    let v2 = source.rfind(FAMD_V2_TOKEN);
    match (v1, v2) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(v1), Some(v2)) => v2 > v1,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    V1,
    V2,
}

/// `famdEncodingForSave(existing)`.
pub fn encoding_for_save(existing: &str) -> Encoding {
    if existing.is_empty() || is_active_v2(existing) {
        return Encoding::V2;
    }
    if existing.contains("fanotes-famd:v1") {
        return Encoding::V1;
    }
    Encoding::V2
}

struct Located {
    cut: usize,
    json_start: usize,
    length: usize,
    crc: String,
}

fn skip_space(text: &str, at: usize) -> usize {
    let rest = &text[at..];
    at + (rest.len() - rest.trim_start_matches(jsjson::is_js_space).len())
}

/// `^<!--\s*fanotes-famd:v2\s+chars=(\d+)\s+crc=([0-9a-fA-F]{8})\s*-->\n` at `start`.
fn match_v2_header(text: &str, start: usize) -> Option<(usize, String, String)> {
    let mut at = start;
    if !text[at..].starts_with("<!--") {
        return None;
    }
    at = skip_space(text, at + 4);
    if !text[at..].starts_with(FAMD_V2_TOKEN) {
        return None;
    }
    at += FAMD_V2_TOKEN.len();
    let spaced = skip_space(text, at);
    if spaced == at {
        return None;
    }
    at = spaced;
    if !text[at..].starts_with("chars=") {
        return None;
    }
    at += 6;
    let digits_start = at;
    while text.as_bytes().get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    if at == digits_start {
        return None;
    }
    let digits = text[digits_start..at].to_owned();
    let spaced = skip_space(text, at);
    if spaced == at {
        return None;
    }
    at = spaced;
    if !text[at..].starts_with("crc=") {
        return None;
    }
    at += 4;
    let crc = text.get(at..at + 8)?;
    if !crc.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let crc = crc.to_ascii_lowercase();
    at += 8;
    at = skip_space(text, at);
    if !text[at..].starts_with("-->\n") {
        return None;
    }
    Some((at + 4, digits, crc))
}

fn locate_v2(source: &str) -> Result<Option<Located>, FamdError> {
    let Some(token_at) = source.rfind(FAMD_V2_TOKEN) else {
        return Ok(None);
    };
    let start = source[..token_at]
        .rfind("<!--")
        .ok_or_else(|| FamdError::new("truncated famd v2 header"))?;
    let (end, digits, crc) =
        match_v2_header(source, start).ok_or_else(|| FamdError::new("truncated famd v2 header"))?;
    let length: f64 = digits.parse().unwrap_or(f64::INFINITY);
    if !jsjson::is_safe_integer(length) || length < 2.0 || length > MAX_PAYLOAD_CHARS {
        return Err(FamdError::new("famd v2 length"));
    }
    let cut = if start > 0 && source.as_bytes()[start - 1] == b'\n' {
        start - 1
    } else {
        start
    };
    Ok(Some(Located {
        cut,
        json_start: end,
        length: length as usize,
        crc,
    }))
}

/// `v2CutIndex(source)` as a byte offset, or `None` for `-1`.
pub fn v2_cut_index(source: &str) -> Option<usize> {
    let token_at = source.rfind(FAMD_V2_TOKEN)?;
    match locate_v2(source) {
        Ok(located) => located.map(|located| located.cut),
        Err(_) => match source[..token_at].rfind("<!--") {
            None => Some(token_at),
            Some(start) => Some(if start > 0 && source.as_bytes()[start - 1] == b'\n' {
                start - 1
            } else {
                start
            }),
        },
    }
}

/// `readV2Payload(source)`: the stored object with the ink unpacked.
pub fn read_v2_payload(source: &str) -> Result<JsObject, FamdError> {
    let located = locate_v2(source)?.ok_or_else(|| FamdError::new("missing famd v2 header"))?;
    let rest = &source[located.json_start..];
    // The JSON is `length` UTF-16 units after the header.
    let end = match jsjson::byte_offset_of_unit(rest, located.length) {
        Some(end) => end,
        None => {
            if jsjson::utf16_len(rest) < located.length {
                return Err(FamdError::new("truncated famd v2 payload"));
            }
            // The cut falls inside a surrogate pair: the JSON cannot end there.
            return Err(FamdError::new("famd v2 checksum"));
        }
    };
    let json = &rest[..end];
    if crc_hex(json) != located.crc {
        return Err(FamdError::new("famd v2 checksum"));
    }
    let parsed = jsjson::parse(json).map_err(|_| FamdError::new("famd v2 json"))?;
    let Js::Obj(object) = parsed else {
        return Err(FamdError::new("famd v2 schema"));
    };
    if !matches!(object.get("schema"), Some(Js::Str(schema)) if schema.eq_str(FAMD_V2_SCHEMA)) {
        return Err(FamdError::new("famd v2 schema"));
    }
    let ink = unpack_ink(object.get("ink"))?;
    let mut next = object.spread();
    next.define_str("ink", ink);
    Ok(next)
}

/// `encodeV2Document(body, payload)`.
pub fn encode_v2_document(body: &str, payload: &JsObject) -> Result<String, FamdError> {
    let mut stored = JsObject::new();
    stored.assign_str("schema", Js::str(FAMD_V2_SCHEMA));
    stored.assign_str(
        "updatedAt",
        payload.get("updatedAt").cloned().unwrap_or(Js::Null),
    );
    stored.assign_str("ink", pack_ink(payload.get("ink"))?);
    stored.assign_str(
        "worksheets",
        match payload.get("worksheets") {
            Some(Js::Arr(items)) => Js::Arr(items.clone()),
            _ => Js::Arr(Vec::new()),
        },
    );
    if let Some(style) = payload.get("paperStyle").filter(|value| value.truthy()) {
        stored.assign_str("paperStyle", style.clone());
    }
    for key in ["noteLinks", "noteBackups"] {
        if let Some(Js::Arr(items)) = payload.get(key) {
            if !items.is_empty() {
                stored.assign_str(key, Js::Arr(items.clone()));
            }
        }
    }
    if let Some(stats) = payload.get("pageStats").filter(|value| value.truthy()) {
        stored.assign_str("pageStats", stats.clone());
    }
    if let Some(Js::Arr(items)) = payload.get("textFields") {
        if !items.is_empty() {
            stored.assign_str("textFields", Js::Arr(items.clone()));
        }
    }
    let json = jsjson::stringify(&Js::Obj(stored));
    let header = format!(
        "<!-- fanotes-famd:v2 chars={} crc={} -->\n",
        jsjson::utf16_len(&json),
        crc_hex(&json)
    );
    let prefix = if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n\n")
    };
    Ok(format!("{prefix}{header}{json}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base85_round_trips() {
        let bytes: Vec<u8> = (0..=255u8).chain([0, 0, 0]).collect();
        let padded: Vec<u8> = bytes
            .iter()
            .copied()
            .chain(std::iter::repeat(0).take((4 - bytes.len() % 4) % 4))
            .collect();
        let encoded = encode85(&padded).unwrap();
        assert_eq!(decode85(&JsString::from_str(&encoded)).unwrap(), padded);
    }

    #[test]
    fn crc_matches_ieee() {
        assert_eq!(crc_hex("123456789"), "cbf43926");
    }
}
