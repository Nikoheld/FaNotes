//! JSON with JavaScript semantics, for the bytes the sync engine hashes.
//!
//! `identitySyncBytes` and `canonicalSyncBytes` re-serialise a note with
//! `JSON.parse` / `JSON.stringify`. A device switching engines must get the
//! same bytes, so this module reproduces what V8 does:
//!
//! - every number is a double and prints like `Number#toString`;
//! - object keys keep insertion order, except array-index keys (`"0"`, `"17"`),
//!   which come first in ascending order;
//! - strings are UTF-16 and may hold lone surrogates (`"\ud83d"` survives a
//!   round trip, and `slice` can cut a pair);
//! - a duplicate key keeps its first position and takes the last value;
//! - assignment (`obj[key] = v`) ignores `__proto__`, a literal or
//!   `JSON.parse` defines it as an own property.

use std::collections::HashMap;

/// A JavaScript string: UTF-16 code units.
#[derive(Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JsString(pub Vec<u16>);

impl std::fmt::Debug for JsString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.to_string_lossy())
    }
}

impl JsString {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn from_str(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `TextEncoder` and `String.fromCharCode` view: a lone surrogate becomes U+FFFD.
    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }

    /// The text when it holds no lone surrogate.
    pub fn to_str(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }

    pub fn eq_str(&self, other: &str) -> bool {
        self.0.iter().copied().eq(other.encode_utf16())
    }

    /// `String#slice(start, end)` on code units, both clamped.
    pub fn slice(&self, start: usize, end: usize) -> JsString {
        let end = end.min(self.0.len());
        let start = start.min(end);
        JsString(self.0[start..end].to_vec())
    }

    /// `String#slice(-count)`.
    pub fn slice_from(&self, start: usize) -> JsString {
        let start = start.min(self.0.len());
        JsString(self.0[start..].to_vec())
    }

    /// `String#trim()`: JavaScript white space and line terminators.
    pub fn trim(&self) -> JsString {
        let units = &self.0;
        let mut start = 0;
        let mut end = units.len();
        while start < end && is_js_space_unit(units[start]) {
            start += 1;
        }
        while end > start && is_js_space_unit(units[end - 1]) {
            end -= 1;
        }
        JsString(units[start..end].to_vec())
    }

    pub fn contains_str(&self, needle: &str) -> bool {
        let needle: Vec<u16> = needle.encode_utf16().collect();
        if needle.is_empty() {
            return true;
        }
        self.0
            .windows(needle.len())
            .any(|window| window == needle.as_slice())
    }

    pub fn starts_with_str(&self, prefix: &str) -> bool {
        let prefix: Vec<u16> = prefix.encode_utf16().collect();
        self.0.starts_with(&prefix)
    }

    /// `String#replace(/\s+/gu, ' ')`.
    pub fn collapse_space(&self) -> JsString {
        let mut out = Vec::with_capacity(self.0.len());
        let mut in_space = false;
        for &unit in &self.0 {
            if is_js_space_unit(unit) {
                if !in_space {
                    out.push(0x20);
                }
                in_space = true;
            } else {
                out.push(unit);
                in_space = false;
            }
        }
        JsString(out)
    }

    /// Code units replaced one for one (`replace(/\\/gu, '/')`).
    pub fn replace_unit(&self, from: u16, to: u16) -> JsString {
        JsString(
            self.0
                .iter()
                .map(|&unit| if unit == from { to } else { unit })
                .collect(),
        )
    }

    /// Leading run of one code unit removed (`replace(/^\/+/u, '')`).
    pub fn trim_start_unit(&self, unit: u16) -> JsString {
        let start = self.0.iter().take_while(|&&value| value == unit).count();
        JsString(self.0[start..].to_vec())
    }

    pub fn push_str(&mut self, value: &str) {
        self.0.extend(value.encode_utf16());
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        JsString::from_str(value)
    }
}

/// `\s` and `String#trim` on one UTF-16 unit.
pub fn is_js_space_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

pub fn is_js_space(character: char) -> bool {
    let code = character as u32;
    code <= 0xFFFF && is_js_space_unit(code as u16)
}

/// `String#trim()` on a Rust string.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

pub fn js_trim_end(value: &str) -> &str {
    value.trim_end_matches(is_js_space)
}

/// Length in UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// Byte offset of the code unit `units` into `value`, or `None` when it falls
/// inside a surrogate pair or past the end.
pub fn byte_offset_of_unit(value: &str, units: usize) -> Option<usize> {
    let mut count = 0;
    for (index, character) in value.char_indices() {
        if count == units {
            return Some(index);
        }
        count += character.len_utf16();
        if count > units {
            return None;
        }
    }
    (count == units).then_some(value.len())
}

#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(f64),
    Str(JsString),
    Arr(Vec<Js>),
    Obj(JsObject),
}

impl Js {
    pub fn str(value: &str) -> Js {
        Js::Str(JsString::from_str(value))
    }

    pub fn as_obj(&self) -> Option<&JsObject> {
        match self {
            Js::Obj(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&Vec<Js>> {
        match self {
            Js::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_jsstr(&self) -> Option<&JsString> {
        match self {
            Js::Str(value) => Some(value),
            _ => None,
        }
    }

    /// `typeof value === 'object' && value !== null` (arrays included).
    pub fn is_object_like(&self) -> bool {
        matches!(self, Js::Obj(_) | Js::Arr(_))
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Js::Null => false,
            Js::Bool(value) => *value,
            Js::Num(value) => *value != 0.0 && !value.is_nan(),
            Js::Str(value) => !value.is_empty(),
            Js::Arr(_) | Js::Obj(_) => true,
        }
    }

    /// Property read: objects by key, arrays by index or `length`; `None` is `undefined`.
    pub fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Obj(object) => object.get(key),
            Js::Arr(items) => array_index_of_str(key).and_then(|index| items.get(index as usize)),
            _ => None,
        }
    }
}

/// `Number(value)` (ToNumber). `None` is `undefined` and gives NaN.
pub fn to_number(value: Option<&Js>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Js::Null) => 0.0,
        Some(Js::Bool(value)) => f64::from(u8::from(*value)),
        Some(Js::Num(value)) => *value,
        Some(Js::Str(text)) => string_to_number(text),
        Some(Js::Arr(_)) => string_to_number(&to_js_string(value.unwrap())),
        Some(Js::Obj(_)) => f64::NAN,
    }
}

pub fn string_to_number(text: &JsString) -> f64 {
    match text.to_str() {
        Some(text) => fanotes_famd::js_tonumber(&text).unwrap_or(f64::NAN),
        None => f64::NAN,
    }
}

/// `String(value)`; inside `Array#join`, null becomes the empty string.
pub fn to_js_string(value: &Js) -> JsString {
    match value {
        Js::Null => JsString::from_str("null"),
        Js::Bool(true) => JsString::from_str("true"),
        Js::Bool(false) => JsString::from_str("false"),
        Js::Num(number) => JsString::from_str(&number_to_string(*number)),
        Js::Str(text) => text.clone(),
        Js::Obj(_) => JsString::from_str("[object Object]"),
        Js::Arr(items) => {
            let mut out = JsString::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.0.push(u16::from(b','));
                }
                if !matches!(item, Js::Null) {
                    out.0.extend(to_js_string(item).0);
                }
            }
            out
        }
    }
}

/// `Number.isSafeInteger`.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// `Math.round`.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    if rounded == 0.0 && value.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `Number#toString()` for a double.
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        };
    }
    let negative = value < 0.0;
    // `{:e}` gives the shortest round-trip length; JavaScript then takes the
    // closest decimal of that length, which is the correctly rounded one.
    let shortest = format!("{:e}", value.abs());
    let length = shortest.split_once('e').map_or(1, |(mantissa, _)| {
        mantissa.chars().filter(char::is_ascii_digit).count()
    });
    let formatted = format!("{:.*e}", length.saturating_sub(1), value.abs());
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exponent + 1;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e >= 0 { '+' } else { '-' });
        out.push_str(&e.abs().to_string());
    }
    out
}

/// A JavaScript plain object: own data properties in `[[OwnPropertyKeys]]` order.
#[derive(Clone, Debug, Default)]
pub struct JsObject {
    entries: Vec<(JsString, Js)>,
    /// How many leading entries are array-index keys.
    index_keys: usize,
    lookup: Option<HashMap<JsString, usize>>,
}

impl PartialEq for JsObject {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}

const LOOKUP_FROM: usize = 24;

fn array_index_of(key: &JsString) -> Option<u32> {
    let units = &key.0;
    if units.is_empty() || units.len() > 10 {
        return None;
    }
    if units[0] == u16::from(b'0') {
        return (units.len() == 1).then_some(0);
    }
    let mut value: u64 = 0;
    for &unit in units {
        if !(u16::from(b'0')..=u16::from(b'9')).contains(&unit) {
            return None;
        }
        value = value * 10 + u64::from(unit - u16::from(b'0'));
    }
    // An array index is below 2^32 - 1.
    (value < 4_294_967_295).then_some(value as u32)
}

fn array_index_of_str(key: &str) -> Option<u32> {
    array_index_of(&JsString::from_str(key))
}

impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[(JsString, Js)] {
        &self.entries
    }

    pub fn keys(&self) -> impl Iterator<Item = &JsString> {
        self.entries.iter().map(|(key, _)| key)
    }

    fn position(&self, key: &JsString) -> Option<usize> {
        if let Some(lookup) = &self.lookup {
            return lookup.get(key).copied();
        }
        self.entries
            .iter()
            .position(|(candidate, _)| candidate == key)
    }

    fn rebuild_lookup(&mut self) {
        if self.entries.len() >= LOOKUP_FROM {
            self.lookup = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(index, (key, _))| (key.clone(), index))
                    .collect(),
            );
        } else {
            self.lookup = None;
        }
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.get_js(&JsString::from_str(key))
    }

    pub fn get_js(&self, key: &JsString) -> Option<&Js> {
        self.position(key).map(|index| &self.entries[index].1)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// `CreateDataProperty`: object literals, spread and `JSON.parse`.
    pub fn define(&mut self, key: JsString, value: Js) {
        if let Some(index) = self.position(&key) {
            self.entries[index].1 = value;
            return;
        }
        if let Some(number) = array_index_of(&key) {
            let at = self.entries[..self.index_keys]
                .iter()
                .position(|(candidate, _)| {
                    array_index_of(candidate).is_some_and(|other| other > number)
                })
                .unwrap_or(self.index_keys);
            self.entries.insert(at, (key, value));
            self.index_keys += 1;
            self.rebuild_lookup();
            return;
        }
        self.entries.push((key.clone(), value));
        if let Some(lookup) = &mut self.lookup {
            lookup.insert(key, self.entries.len() - 1);
        } else if self.entries.len() >= LOOKUP_FROM {
            self.rebuild_lookup();
        }
    }

    pub fn define_str(&mut self, key: &str, value: Js) {
        self.define(JsString::from_str(key), value);
    }

    /// `obj[key] = value` on a plain object: `__proto__` hits the prototype setter, not a property.
    pub fn assign(&mut self, key: JsString, value: Js) {
        if key.eq_str("__proto__") {
            return;
        }
        self.define(key, value);
    }

    pub fn assign_str(&mut self, key: &str, value: Js) {
        self.assign(JsString::from_str(key), value);
    }

    pub fn remove(&mut self, key: &str) -> Option<Js> {
        let key = JsString::from_str(key);
        let index = self.position(&key)?;
        let (_, value) = self.entries.remove(index);
        if index < self.index_keys {
            self.index_keys -= 1;
        }
        self.rebuild_lookup();
        Some(value)
    }

    /// `{ ...this }` keeping every own property.
    pub fn spread(&self) -> JsObject {
        self.clone()
    }
}

// ── Parse ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError;

/// V8 parses any depth; its `JSON.stringify` overflows the stack long before
/// this. Deeper input is treated as unparseable (the engine then keeps the
/// file and does not upload it) instead of overflowing a Rust thread.
pub const MAX_DEPTH: usize = 4096;

enum Frame {
    Arr(Vec<Js>),
    Obj(JsObject, Option<JsString>),
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.at < self.bytes.len()
            && matches!(self.bytes[self.at], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn expect_literal(&mut self, literal: &str) -> Result<(), ParseError> {
        if self.text[self.at..].starts_with(literal) {
            self.at += literal.len();
            Ok(())
        } else {
            Err(ParseError)
        }
    }

    fn number(&mut self) -> Result<f64, ParseError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.at += 1;
                }
            }
            _ => return Err(ParseError),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(ParseError);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.at += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(ParseError);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.at += 1;
            }
        }
        self.text[start..self.at]
            .parse::<f64>()
            .map_err(|_| ParseError)
    }

    fn string(&mut self) -> Result<JsString, ParseError> {
        // Opening quote already checked.
        self.at += 1;
        let mut out: Vec<u16> = Vec::new();
        loop {
            let run_start = self.at;
            while self.at < self.bytes.len() {
                let byte = self.bytes[self.at];
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.at += 1;
            }
            if self.at > run_start {
                out.extend(self.text[run_start..self.at].encode_utf16());
            }
            match self.peek() {
                None => return Err(ParseError),
                Some(b'"') => {
                    self.at += 1;
                    return Ok(JsString(out));
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = self.peek().ok_or(ParseError)?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push(0x22),
                        b'\\' => out.push(0x5C),
                        b'/' => out.push(0x2F),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0C),
                        b'n' => out.push(0x0A),
                        b'r' => out.push(0x0D),
                        b't' => out.push(0x09),
                        b'u' => {
                            if self.at + 4 > self.bytes.len() {
                                return Err(ParseError);
                            }
                            let hex = &self.text.get(self.at..self.at + 4).ok_or(ParseError)?;
                            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                                return Err(ParseError);
                            }
                            out.push(u16::from_str_radix(hex, 16).map_err(|_| ParseError)?);
                            self.at += 4;
                        }
                        _ => return Err(ParseError),
                    }
                }
                Some(_) => return Err(ParseError),
            }
        }
    }
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Js, ParseError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        text,
        at: 0,
    };
    let mut stack: Vec<Frame> = Vec::new();
    let mut value: Js;
    'outer: loop {
        // Parse one value (or open a container).
        parser.skip_ws();
        match parser.peek() {
            Some(b'{') => {
                parser.at += 1;
                parser.skip_ws();
                if parser.peek() == Some(b'}') {
                    parser.at += 1;
                    value = Js::Obj(JsObject::new());
                } else {
                    if parser.peek() != Some(b'"') || stack.len() >= MAX_DEPTH {
                        return Err(ParseError);
                    }
                    let key = parser.string()?;
                    parser.skip_ws();
                    if parser.peek() != Some(b':') {
                        return Err(ParseError);
                    }
                    parser.at += 1;
                    stack.push(Frame::Obj(JsObject::new(), Some(key)));
                    continue 'outer;
                }
            }
            Some(b'[') => {
                parser.at += 1;
                parser.skip_ws();
                if parser.peek() == Some(b']') {
                    parser.at += 1;
                    value = Js::Arr(Vec::new());
                } else {
                    if stack.len() >= MAX_DEPTH {
                        return Err(ParseError);
                    }
                    stack.push(Frame::Arr(Vec::new()));
                    continue 'outer;
                }
            }
            Some(b'"') => value = Js::Str(parser.string()?),
            Some(b't') => {
                parser.expect_literal("true")?;
                value = Js::Bool(true);
            }
            Some(b'f') => {
                parser.expect_literal("false")?;
                value = Js::Bool(false);
            }
            Some(b'n') => {
                parser.expect_literal("null")?;
                value = Js::Null;
            }
            Some(b'-' | b'0'..=b'9') => value = Js::Num(parser.number()?),
            _ => return Err(ParseError),
        }
        // Attach the finished value and close containers.
        loop {
            match stack.last_mut() {
                None => {
                    parser.skip_ws();
                    if parser.at != parser.bytes.len() {
                        return Err(ParseError);
                    }
                    return Ok(value);
                }
                Some(Frame::Arr(items)) => {
                    items.push(value);
                    parser.skip_ws();
                    match parser.peek() {
                        Some(b',') => {
                            parser.at += 1;
                            continue 'outer;
                        }
                        Some(b']') => {
                            parser.at += 1;
                            let Some(Frame::Arr(items)) = stack.pop() else {
                                unreachable!()
                            };
                            value = Js::Arr(items);
                        }
                        _ => return Err(ParseError),
                    }
                }
                Some(Frame::Obj(object, key)) => {
                    let key = key.take().ok_or(ParseError)?;
                    object.define(key, value);
                    parser.skip_ws();
                    match parser.peek() {
                        Some(b',') => {
                            parser.at += 1;
                            parser.skip_ws();
                            if parser.peek() != Some(b'"') {
                                return Err(ParseError);
                            }
                            let next = parser.string()?;
                            parser.skip_ws();
                            if parser.peek() != Some(b':') {
                                return Err(ParseError);
                            }
                            parser.at += 1;
                            if let Some(Frame::Obj(_, slot)) = stack.last_mut() {
                                *slot = Some(next);
                            }
                            continue 'outer;
                        }
                        Some(b'}') => {
                            parser.at += 1;
                            let Some(Frame::Obj(object, _)) = stack.pop() else {
                                unreachable!()
                            };
                            value = Js::Obj(object);
                        }
                        _ => return Err(ParseError),
                    }
                }
            }
        }
    }
}

// ── Stringify ───────────────────────────────────────────────────────────────

fn push_quoted(out: &mut String, value: &JsString) {
    out.push('"');
    let units = &value.0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0C => out.push_str("\\f"),
            0x0A => out.push_str("\\n"),
            0x0D => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x00..=0x1F => out.push_str(&format!("\\u{unit:04x}")),
            0xD800..=0xDBFF => {
                if let Some(&low) = units.get(index + 1) {
                    if (0xDC00..=0xDFFF).contains(&low) {
                        let code = 0x10000
                            + ((u32::from(unit) - 0xD800) << 10)
                            + (u32::from(low) - 0xDC00);
                        out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        index += 2;
                        continue;
                    }
                }
                out.push_str(&format!("\\u{unit:04x}"));
            }
            0xDC00..=0xDFFF => out.push_str(&format!("\\u{unit:04x}")),
            _ => out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{FFFD}')),
        }
        index += 1;
    }
    out.push('"');
}

fn push_number(out: &mut String, value: f64) {
    if value.is_finite() {
        out.push_str(&number_to_string(value));
    } else {
        out.push_str("null");
    }
}

fn write_value(out: &mut String, value: &Js, indent: &str, level: usize) {
    match value {
        Js::Null => out.push_str("null"),
        Js::Bool(true) => out.push_str("true"),
        Js::Bool(false) => out.push_str("false"),
        Js::Num(number) => push_number(out, *number),
        Js::Str(text) => push_quoted(out, text),
        Js::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if !indent.is_empty() {
                    out.push('\n');
                    for _ in 0..=level {
                        out.push_str(indent);
                    }
                }
                write_value(out, item, indent, level + 1);
            }
            if !indent.is_empty() {
                out.push('\n');
                for _ in 0..level {
                    out.push_str(indent);
                }
            }
            out.push(']');
        }
        Js::Obj(object) => {
            if object.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in object.entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if !indent.is_empty() {
                    out.push('\n');
                    for _ in 0..=level {
                        out.push_str(indent);
                    }
                }
                push_quoted(out, key);
                out.push(':');
                if !indent.is_empty() {
                    out.push(' ');
                }
                write_value(out, item, indent, level + 1);
            }
            if !indent.is_empty() {
                out.push('\n');
                for _ in 0..level {
                    out.push_str(indent);
                }
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Js) -> String {
    let mut out = String::new();
    write_value(&mut out, value, "", 0);
    out
}

/// `JSON.stringify(value, null, indent)`.
pub fn stringify_pretty(value: &Js, indent: &str) -> String {
    let mut out = String::new();
    write_value(&mut out, value, indent, 0);
    out
}

/// `new TextDecoder().decode(bytes)`: replacement characters, a leading BOM removed.
pub fn text_decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.00001234, "0.00001234"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (0.30000000000000004, "0.30000000000000004"),
            (1700000000000.0, "1700000000000"),
            (2.5e25, "2.5e+25"),
        ];
        for (value, expected) in cases {
            assert_eq!(number_to_string(*value), *expected, "{value:e}");
        }
    }

    #[test]
    fn integer_keys_come_first() {
        let parsed =
            parse(r#"{"b":1,"2":2,"a":3,"1":4,"01":5,"4294967295":6,"4294967294":7}"#).unwrap();
        assert_eq!(
            stringify(&parsed),
            r#"{"1":4,"2":2,"4294967294":7,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
    }

    #[test]
    fn duplicate_keys_keep_their_place() {
        let parsed = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify(&parsed), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn lone_surrogates_round_trip() {
        let parsed = parse(r#"["\ud83d","\ud83d\ude00","\u00e9\u0001"]"#).unwrap();
        assert_eq!(stringify(&parsed), "[\"\\ud83d\",\"😀\",\"é\\u0001\"]");
    }

    #[test]
    fn strict_grammar() {
        for bad in [
            "01",
            "1.",
            ".5",
            "+1",
            "[1,]",
            "{\"a\":1,}",
            "\"\t\"",
            "nul",
            "[1] x",
            "{'a':1}",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        assert_eq!(
            parse(" [1e400] ").map(|value| stringify(&value)),
            Ok("[null]".to_owned())
        );
    }

    #[test]
    fn deep_nesting_is_refused_without_overflow() {
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(&ok).is_ok());
        let depth = 200_000;
        let text = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert!(parse(&text).is_err());
    }

    #[test]
    fn pretty_matches_javascript() {
        let parsed = parse(r#"{"version":1,"tasks":[{"a":[],"b":{}}],"x":"y"}"#).unwrap();
        assert_eq!(
            stringify_pretty(&parsed, "  "),
            "{\n  \"version\": 1,\n  \"tasks\": [\n    {\n      \"a\": [],\n      \"b\": {}\n    }\n  ],\n  \"x\": \"y\"\n}"
        );
    }

    #[test]
    fn to_number_follows_javascript() {
        let array = parse("[5]").unwrap();
        assert_eq!(to_number(Some(&array)), 5.0);
        assert_eq!(to_number(Some(&parse("[]").unwrap())), 0.0);
        assert!(to_number(Some(&parse("[1,2]").unwrap())).is_nan());
        assert_eq!(to_number(Some(&Js::str(" 0x10 "))), 16.0);
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&Js::Null)), 0.0);
    }
}
