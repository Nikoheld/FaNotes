//! Blink `SerializedScriptValue` / V8 `ValueSerializer` wire format → tagged JSON.
//!
//! The tagged JSON is plain JSON wherever JSON can say it: objects, dense
//! arrays, finite numbers, well-formed strings, booleans and null. Everything
//! else is a one-key object `{"\u0000": [tag, ...]}`; a real property name that
//! starts with U+0000 gets one more U+0000 in front. The renderer step
//! (`fanotes/src/lib/desktopMigration.ts`) and the fixture generator use the
//! same rules in JavaScript, so a record can be compared exactly after it went
//! through Rust, JSON and the webview's IndexedDB.
//!
//! Host objects (Blob, File, ImageData, …) and errors are not part of any
//! FaNotes store. They are reported as unsupported, never dropped silently.

use std::rc::Rc;

use base64::Engine;
use serde_json::{json, Map, Value};

use super::leveldb::Reader;

pub const SPECIAL: &str = "\u{0}";

/// Unwrapped Blink SSV bytes → tagged JSON.
pub fn decode_ssv(bytes: &[u8]) -> Result<Value, String> {
    let mut input = Reader::new(bytes);
    skip_padding(&mut input);
    if input.peek() != Some(0xff) {
        return Err("value has no version tag".to_owned());
    }
    input.byte()?;
    let blink_version = input.varint32()?;
    if blink_version >= 21 && input.peek() == Some(0xfe) {
        // Trailer offset tag: u64 offset + u32 size (interfaces the value needs).
        input.byte()?;
        input.take(12)?;
    }
    skip_padding(&mut input);
    if input.peek() != Some(0xff) {
        return Err(format!(
            "Blink version {blink_version} value has no V8 header"
        ));
    }
    input.byte()?;
    let v8_version = input.varint32()?;
    if v8_version < 13 {
        return Err(format!("V8 serialization version {v8_version} is too old"));
    }
    let mut decoder = Decoder {
        input,
        objects: Vec::new(),
        version: v8_version,
    };
    let value = decoder.read()?;
    to_json(&value)
}

#[derive(Clone)]
enum V {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    BigInt(String),
    String(Rc<Vec<u16>>),
    Hole,
    Object(Rc<Obj>),
}

enum Obj {
    Plain(Vec<(V, V)>),
    Array {
        length: u32,
        properties: Vec<(V, V)>,
    },
    Date(f64),
    RegExp(Rc<Vec<u16>>, u32),
    BoxedNumber(f64),
    BoxedBigInt(String),
    BoxedString(Rc<Vec<u16>>),
    BoxedBool(bool),
    Map(Vec<(V, V)>),
    Set(Vec<V>),
    ArrayBuffer(Rc<Vec<u8>>),
    View {
        kind: &'static str,
        buffer: Rc<Vec<u8>>,
        offset: u64,
        length: u64,
    },
}

struct Decoder<'a> {
    input: Reader<'a>,
    /// Object id → finished object. `None` while it is still being read (a cycle).
    objects: Vec<Option<Rc<Obj>>>,
    version: u32,
}

fn skip_padding(input: &mut Reader<'_>) {
    while input.peek() == Some(0) {
        let _ = input.byte();
    }
}

impl Decoder<'_> {
    fn tag(&mut self) -> Result<u8, String> {
        loop {
            let tag = self.input.byte()?;
            if tag != 0 {
                return Ok(tag);
            }
        }
    }

    fn peek_tag(&mut self) -> Option<u8> {
        skip_padding(&mut self.input);
        self.input.peek()
    }

    fn double(&mut self) -> Result<f64, String> {
        let bytes = self.input.take(8)?;
        Ok(f64::from_le_bytes(
            bytes.try_into().map_err(|_| "short double".to_owned())?,
        ))
    }

    fn reserve(&mut self) -> usize {
        self.objects.push(None);
        self.objects.len() - 1
    }

    fn finish(&mut self, id: usize, object: Obj) -> V {
        let object = Rc::new(object);
        self.objects[id] = Some(object.clone());
        V::Object(object)
    }

    fn read(&mut self) -> Result<V, String> {
        let value = self.read_inner()?;
        // An ArrayBuffer directly followed by a view tag is the view's backing store.
        if let V::Object(object) = &value {
            if let Obj::ArrayBuffer(buffer) = object.as_ref() {
                if self.peek_tag() == Some(b'V') {
                    self.input.byte()?;
                    return self.read_view(buffer.clone());
                }
            }
        }
        Ok(value)
    }

    fn read_string_body(&mut self, tag: u8) -> Result<Rc<Vec<u16>>, String> {
        match tag {
            b'"' => {
                let length = self.input.varint32()? as usize;
                Ok(Rc::new(
                    self.input
                        .take(length)?
                        .iter()
                        .map(|byte| u16::from(*byte))
                        .collect(),
                ))
            }
            b'c' => {
                let length = self.input.varint32()? as usize;
                if length % 2 != 0 {
                    return Err("two-byte string has an odd length".to_owned());
                }
                let bytes = self.input.take(length)?;
                Ok(Rc::new(
                    bytes
                        .chunks_exact(2)
                        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                        .collect(),
                ))
            }
            b'S' => {
                let length = self.input.varint32()? as usize;
                let text = String::from_utf8_lossy(self.input.take(length)?).into_owned();
                Ok(Rc::new(text.encode_utf16().collect()))
            }
            other => Err(format!("expected a string, found tag {other:#04x}")),
        }
    }

    fn read_bigint_body(&mut self) -> Result<String, String> {
        let bitfield = self.input.varint64()?;
        let negative = bitfield & 1 == 1;
        let length = usize::try_from(bitfield >> 1).map_err(|_| "BigInt is too long".to_owned())?;
        let digits = self.input.take(length)?;
        let mut text = bigint_decimal(digits);
        if negative && text != "0" {
            text.insert(0, '-');
        }
        Ok(text)
    }

    fn read_properties(&mut self, end: u8) -> Result<Vec<(V, V)>, String> {
        let mut properties = Vec::new();
        loop {
            if self.peek_tag() == Some(end) {
                self.input.byte()?;
                return Ok(properties);
            }
            let key = self.read()?;
            if !matches!(key, V::String(_) | V::Number(_)) {
                return Err("property key is not a string or number".to_owned());
            }
            let value = self.read()?;
            properties.push((key, value));
        }
    }

    fn read_inner(&mut self) -> Result<V, String> {
        let tag = self.tag()?;
        Ok(match tag {
            b'?' => {
                self.input.varint32()?;
                return self.read_inner();
            }
            b'_' => V::Undefined,
            b'0' => V::Null,
            b'T' => V::Bool(true),
            b'F' => V::Bool(false),
            b'-' => V::Hole,
            b'I' => {
                let raw = self.input.varint32()?;
                V::Number(f64::from(((raw >> 1) as i32) ^ -((raw & 1) as i32)))
            }
            b'U' => V::Number(f64::from(self.input.varint32()?)),
            b'N' => V::Number(self.double()?),
            b'Z' => V::BigInt(self.read_bigint_body()?),
            b'"' | b'c' | b'S' => V::String(self.read_string_body(tag)?),
            b'^' => {
                let id = self.input.varint32()? as usize;
                match self.objects.get(id) {
                    Some(Some(object)) => V::Object(object.clone()),
                    Some(None) => return Err("cyclic values are not supported".to_owned()),
                    None => return Err(format!("reference to unknown object {id}")),
                }
            }
            b'o' => {
                let id = self.reserve();
                let properties = self.read_properties(b'{')?;
                let count = self.input.varint32()? as usize;
                if count != properties.len() {
                    return Err("object property count does not match".to_owned());
                }
                self.finish(id, Obj::Plain(properties))
            }
            b'A' => {
                let length = self.input.varint32()?;
                let id = self.reserve();
                let mut properties = Vec::new();
                for index in 0..length {
                    let value = self.read()?;
                    if !matches!(value, V::Hole) {
                        properties.push((V::Number(f64::from(index)), value));
                    }
                }
                properties.extend(self.read_properties(b'$')?);
                self.input.varint32()?;
                let declared = self.input.varint32()?;
                if declared != length {
                    return Err("dense array length does not match".to_owned());
                }
                self.finish(id, Obj::Array { length, properties })
            }
            b'a' => {
                let length = self.input.varint32()?;
                let id = self.reserve();
                let properties = self.read_properties(b'@')?;
                self.input.varint32()?;
                let declared = self.input.varint32()?;
                if declared != length {
                    return Err("sparse array length does not match".to_owned());
                }
                self.finish(id, Obj::Array { length, properties })
            }
            b'D' => {
                let id = self.reserve();
                let time = self.double()?;
                self.finish(id, Obj::Date(time))
            }
            b'y' | b'x' => {
                let id = self.reserve();
                self.finish(id, Obj::BoxedBool(tag == b'y'))
            }
            b'n' => {
                let id = self.reserve();
                let number = self.double()?;
                self.finish(id, Obj::BoxedNumber(number))
            }
            b'z' => {
                let id = self.reserve();
                let bigint = self.read_bigint_body()?;
                self.finish(id, Obj::BoxedBigInt(bigint))
            }
            b's' => {
                let id = self.reserve();
                let inner = self.tag()?;
                let text = self.read_string_body(inner)?;
                self.finish(id, Obj::BoxedString(text))
            }
            b'R' => {
                let id = self.reserve();
                let inner = self.tag()?;
                let source = self.read_string_body(inner)?;
                let flags = self.input.varint32()?;
                self.finish(id, Obj::RegExp(source, flags))
            }
            b';' => {
                let id = self.reserve();
                let mut entries = Vec::new();
                loop {
                    if self.peek_tag() == Some(b':') {
                        self.input.byte()?;
                        break;
                    }
                    let key = self.read()?;
                    let value = self.read()?;
                    entries.push((key, value));
                }
                let count = self.input.varint32()? as usize;
                if count != entries.len() * 2 {
                    return Err("map entry count does not match".to_owned());
                }
                self.finish(id, Obj::Map(entries))
            }
            b'\'' => {
                let id = self.reserve();
                let mut values = Vec::new();
                loop {
                    if self.peek_tag() == Some(b',') {
                        self.input.byte()?;
                        break;
                    }
                    values.push(self.read()?);
                }
                let count = self.input.varint32()? as usize;
                if count != values.len() {
                    return Err("set entry count does not match".to_owned());
                }
                self.finish(id, Obj::Set(values))
            }
            b'B' => {
                let length = self.input.varint32()? as usize;
                let id = self.reserve();
                let bytes = self.input.take(length)?.to_vec();
                self.finish(id, Obj::ArrayBuffer(Rc::new(bytes)))
            }
            b'~' => {
                let length = self.input.varint32()? as usize;
                let _max = self.input.varint32()?;
                let id = self.reserve();
                let bytes = self.input.take(length)?.to_vec();
                self.finish(id, Obj::ArrayBuffer(Rc::new(bytes)))
            }
            b'\\' => {
                return Err("host objects (Blob, File, ImageData) are not supported".to_owned())
            }
            b'r' => return Err("Error objects are not supported".to_owned()),
            b'm' | b'w' | b'p' | b'u' | b't' => {
                return Err(format!(
                    "transferred or shared value tag {:?} is not supported",
                    tag as char
                ))
            }
            other => return Err(format!("unknown V8 tag {other:#04x}")),
        })
    }

    fn read_view(&mut self, buffer: Rc<Vec<u8>>) -> Result<V, String> {
        let subtag = self.input.byte()?;
        let offset = self.input.varint64()?;
        let length = self.input.varint64()?;
        if self.version >= 14 {
            self.input.varint32()?;
        }
        let kind = match subtag {
            b'b' => "Int8Array",
            b'B' => "Uint8Array",
            b'C' => "Uint8ClampedArray",
            b'w' => "Int16Array",
            b'W' => "Uint16Array",
            b'd' => "Int32Array",
            b'D' => "Uint32Array",
            b'h' => "Float16Array",
            b'f' => "Float32Array",
            b'F' => "Float64Array",
            b'q' => "BigInt64Array",
            b'Q' => "BigUint64Array",
            b'?' => "DataView",
            other => return Err(format!("unknown typed array tag {other:#04x}")),
        };
        if offset
            .checked_add(length)
            .is_none_or(|end| end > buffer.len() as u64)
        {
            return Err("typed array lies outside its buffer".to_owned());
        }
        let id = self.reserve();
        Ok(self.finish(
            id,
            Obj::View {
                kind,
                buffer,
                offset,
                length,
            },
        ))
    }
}

/// Little-endian magnitude bytes → decimal digits.
fn bigint_decimal(digits: &[u8]) -> String {
    let mut limbs: Vec<u32> = digits
        .chunks(4)
        .map(|chunk| {
            let mut word = [0u8; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            u32::from_le_bytes(word)
        })
        .collect();
    while limbs.last() == Some(&0) {
        limbs.pop();
    }
    if limbs.is_empty() {
        return "0".to_owned();
    }
    let mut parts = Vec::new();
    while !limbs.is_empty() {
        let mut remainder = 0u64;
        for limb in limbs.iter_mut().rev() {
            let current = (remainder << 32) | u64::from(*limb);
            *limb = (current / 1_000_000_000) as u32;
            remainder = current % 1_000_000_000;
        }
        parts.push(remainder as u32);
        while limbs.last() == Some(&0) {
            limbs.pop();
        }
    }
    let mut text = parts.pop().map(|part| part.to_string()).unwrap_or_default();
    for part in parts.iter().rev() {
        text.push_str(&format!("{part:09}"));
    }
    text
}

pub fn special(items: Vec<Value>) -> Value {
    let mut object = Map::new();
    object.insert(SPECIAL.to_owned(), Value::Array(items));
    Value::Object(object)
}

pub fn number(value: f64) -> Value {
    if value.is_nan() {
        special(vec![json!("number"), json!("NaN")])
    } else if value == f64::INFINITY {
        special(vec![json!("number"), json!("Infinity")])
    } else if value == f64::NEG_INFINITY {
        special(vec![json!("number"), json!("-Infinity")])
    } else if value == 0.0 && value.is_sign_negative() {
        special(vec![json!("number"), json!("-0")])
    } else if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

pub fn string(units: &[u16]) -> Value {
    match String::from_utf16(units) {
        Ok(text) => Value::String(text),
        Err(_) => {
            let bytes: Vec<u8> = units.iter().flat_map(|unit| unit.to_le_bytes()).collect();
            special(vec![
                json!("utf16"),
                json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
            ])
        }
    }
}

/// JavaScript `ToString(number)` for property keys.
fn number_key(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        if value == 0.0 {
            return "0".to_owned();
        }
        return format!("{value:.0}");
    }
    format!("{value}")
}

fn key_text(key: &V) -> Result<String, String> {
    match key {
        V::String(units) => String::from_utf16(units)
            .map_err(|_| "property name has an unpaired surrogate".to_owned()),
        V::Number(value) => Ok(number_key(*value)),
        _ => Err("property key is not a string or number".to_owned()),
    }
}

fn array_index(name: &str) -> Option<u32> {
    let index: u32 = name.parse().ok()?;
    (index != u32::MAX && index.to_string() == name).then_some(index)
}

fn escaped_key(name: &str) -> String {
    if name.starts_with(SPECIAL) {
        format!("{SPECIAL}{name}")
    } else {
        name.to_owned()
    }
}

fn properties(entries: &[(String, &V)]) -> Result<Value, String> {
    let mut out = Map::new();
    for (name, value) in entries {
        out.insert(escaped_key(name), to_json(value)?);
    }
    Ok(Value::Object(out))
}

/// Object.keys order: array indices ascending, then the rest in insertion order.
fn ordered(entries: &[(V, V)]) -> Result<Vec<(String, &V)>, String> {
    let mut indices = Vec::new();
    let mut names = Vec::new();
    for (key, value) in entries {
        let name = key_text(key)?;
        match array_index(&name) {
            Some(index) => indices.push((index, name, value)),
            None => names.push((name, value)),
        }
    }
    indices.sort_by_key(|(index, _, _)| *index);
    let mut out: Vec<(String, &V)> = indices
        .into_iter()
        .map(|(_, name, value)| (name, value))
        .collect();
    // A later duplicate overrides an earlier one, like property assignment.
    for (name, value) in names {
        if let Some(slot) = out.iter_mut().find(|(existing, _)| *existing == name) {
            slot.1 = value;
        } else {
            out.push((name, value));
        }
    }
    Ok(out)
}

fn to_json(value: &V) -> Result<Value, String> {
    Ok(match value {
        V::Undefined => special(vec![json!("undefined")]),
        V::Null => Value::Null,
        V::Bool(flag) => Value::Bool(*flag),
        V::Number(number_value) => number(*number_value),
        V::BigInt(text) => special(vec![json!("bigint"), json!(text)]),
        V::String(units) => string(units),
        V::Hole => return Err("an array hole outside an array".to_owned()),
        V::Object(object) => match object.as_ref() {
            Obj::Plain(entries) => properties(&ordered(entries)?)?,
            Obj::Array {
                length,
                properties: entries,
            } => array_json(*length, entries)?,
            Obj::Date(time) => special(vec![json!("date"), number(*time)]),
            Obj::RegExp(source, flags) => special(vec![
                json!("regexp"),
                string(source),
                json!(regexp_flags(*flags)),
            ]),
            Obj::BoxedNumber(value) => special(vec![json!("Number"), number(*value)]),
            Obj::BoxedBigInt(text) => special(vec![json!("BigInt"), json!(text)]),
            Obj::BoxedString(units) => special(vec![json!("String"), string(units)]),
            Obj::BoxedBool(flag) => special(vec![json!("Boolean"), json!(flag)]),
            Obj::Map(entries) => {
                let mut items = Vec::new();
                for (key, value) in entries {
                    items.push(Value::Array(vec![to_json(key)?, to_json(value)?]));
                }
                special(vec![json!("map"), Value::Array(items)])
            }
            Obj::Set(values) => special(vec![
                json!("set"),
                Value::Array(values.iter().map(to_json).collect::<Result<_, _>>()?),
            ]),
            Obj::ArrayBuffer(bytes) => special(vec![
                json!("ArrayBuffer"),
                json!(base64::engine::general_purpose::STANDARD.encode(bytes.as_slice())),
            ]),
            Obj::View {
                kind,
                buffer,
                offset,
                length,
            } => special(vec![
                json!(kind),
                json!(base64::engine::general_purpose::STANDARD.encode(buffer.as_slice())),
                json!(offset),
                json!(length),
            ]),
        },
    })
}

fn regexp_flags(flags: u32) -> String {
    // `RegExp.prototype.flags` order.
    [
        (7, 'd'),
        (0, 'g'),
        (1, 'i'),
        (2, 'm'),
        (5, 's'),
        (4, 'u'),
        (8, 'v'),
        (3, 'y'),
    ]
    .iter()
    .filter(|(bit, _)| flags & (1 << bit) != 0)
    .map(|(_, flag)| *flag)
    .collect()
}

fn array_json(length: u32, entries: &[(V, V)]) -> Result<Value, String> {
    let keyed = ordered(entries)?;
    let mut elements: Vec<Option<&V>> = vec![None; length as usize];
    let mut extra = Vec::new();
    for (name, value) in &keyed {
        match array_index(name) {
            Some(index) if index < length => elements[index as usize] = Some(*value),
            _ => extra.push((name.clone(), *value)),
        }
    }
    let present = elements.iter().filter(|slot| slot.is_some()).count();
    if present == length as usize && extra.is_empty() {
        return Ok(Value::Array(
            elements
                .iter()
                .flatten()
                .map(|value| to_json(value))
                .collect::<Result<_, _>>()?,
        ));
    }
    let holes = length as usize - present;
    if holes * 2 > length as usize {
        let mut items = Vec::new();
        for (index, slot) in elements.iter().enumerate() {
            if let Some(value) = slot {
                items.push(Value::Array(vec![json!(index), to_json(value)?]));
            }
        }
        return Ok(special(vec![
            json!("sparse"),
            json!(length),
            Value::Array(items),
            properties(&extra)?,
        ]));
    }
    let mut items = Vec::new();
    for slot in &elements {
        items.push(match slot {
            Some(value) => to_json(value)?,
            None => special(vec![json!("hole")]),
        });
    }
    Ok(special(vec![
        json!("array"),
        Value::Array(items),
        properties(&extra)?,
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssv(payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0xff, 0x15, 0xfe];
        out.extend_from_slice(&[0; 12]);
        out.extend_from_slice(&[0xff, 0x0f]);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn objects_numbers_and_strings() {
        // {a: 1, "\0x": -0, b: "Ω"}
        let mut payload = vec![b'o', b'"', 1, b'a', b'I', 2, b'"', 2, 0, b'x', b'N'];
        payload.extend_from_slice(&(-0.0f64).to_le_bytes());
        payload.extend_from_slice(&[b'"', 1, b'b', b'c', 2, 0xa9, 0x03, b'{', 3]);
        let value = decode_ssv(&ssv(&payload)).unwrap();
        assert_eq!(value["a"], json!(1));
        assert_eq!(
            value["\u{0}\u{0}x"],
            special(vec![json!("number"), json!("-0")])
        );
        assert_eq!(value["b"], json!("Ω"));
    }

    #[test]
    fn shared_references_are_copied_and_bigints_are_decimal() {
        // [o1, ^1, 2^64+1n]
        let payload = [
            b'A', 3, b'o', b'"', 1, b'k', b'T', b'{', 1, b'^', 1, b'Z', 0x18, 1, 0, 0, 0, 0, 0, 0,
            0, 1, 0, 0, 0, b'$', 0, 3,
        ];
        let value = decode_ssv(&ssv(&payload)).unwrap();
        assert_eq!(value[0], json!({"k": true}));
        assert_eq!(value[1], json!({"k": true}));
        assert_eq!(
            value[2],
            special(vec![json!("bigint"), json!("18446744073709551617")])
        );
    }

    #[test]
    fn host_objects_are_reported() {
        let error = decode_ssv(&ssv(&[b'\\', b'b'])).unwrap_err();
        assert!(error.contains("host objects"));
    }
}
