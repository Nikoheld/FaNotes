//! JSON exactly as the TypeScript engine sees it.
//!
//! The story files are written by `JSON.stringify` and read by `JSON.parse`.
//! To give the same results on the same bytes, this module mirrors the parts
//! of JavaScript that leak into the outputs:
//!
//! - numbers are `f64` and print like `Number.prototype.toString` (`12`, not `12.0`);
//! - objects keep JavaScript's property order (array-index keys first, in
//!   ascending order, then the other keys in insertion order), which decides
//!   the byte order of `JSON.stringify` and the iteration order of
//!   `Object.keys` / `Object.entries`;
//! - strings are escaped like `JSON.stringify` (lower-case `\u00xx`).
//!
//! Known difference: Rust strings cannot hold a lone UTF-16 surrogate. A
//! `\udXXX` escape without its partner (which `JSON.stringify` writes for a
//! string cut in the middle of an emoji) is read as U+FFFD instead of failing.

use std::collections::HashMap;
use std::fmt::Write as _;

/// A JavaScript-like ordered record (`Record<string, V>`).
#[derive(Clone, Debug)]
pub struct JsMap<V> {
    entries: Vec<(String, V)>,
    index: HashMap<String, usize>,
    /// Number of array-index keys at the front.
    integers: usize,
}

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
            integers: 0,
        }
    }
}

impl<V: PartialEq> PartialEq for JsMap<V> {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}

/// `key` is a canonical array index ("0" … "4294967294"): JavaScript lists such keys first.
pub fn is_array_index(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return false;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return false;
    }
    key.parse::<u64>()
        .map(|value| value < 4_294_967_295)
        .unwrap_or(false)
}

impl<V> JsMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.index
            .get(key)
            .map(|&position| &self.entries[position].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        match self.index.get(key) {
            Some(&position) => Some(&mut self.entries[position].1),
            None => None,
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// `object[key] = value`: an existing key keeps its place.
    pub fn insert(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        if let Some(&position) = self.index.get(&key) {
            self.entries[position].1 = value;
            return;
        }
        if is_array_index(&key) {
            let number: u64 = key.parse().unwrap_or(0);
            let position = self.entries[..self.integers]
                .iter()
                .position(|(existing, _)| existing.parse::<u64>().unwrap_or(0) > number)
                .unwrap_or(self.integers);
            self.entries.insert(position, (key, value));
            self.integers += 1;
            self.reindex(position);
        } else {
            self.index.insert(key.clone(), self.entries.len());
            self.entries.push((key, value));
        }
    }

    /// `delete object[key]`.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let position = self.index.remove(key)?;
        let (_, value) = self.entries.remove(position);
        if position < self.integers {
            self.integers -= 1;
        }
        self.reindex(position);
        Some(value)
    }

    fn reindex(&mut self, from: usize) {
        for (position, (key, _)) in self.entries.iter().enumerate().skip(from) {
            self.index.insert(key.clone(), position);
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, value)| value)
    }

    pub fn map_values<W>(&self, mut f: impl FnMut(&V) -> W) -> JsMap<W> {
        JsMap {
            entries: self
                .entries
                .iter()
                .map(|(key, value)| (key.clone(), f(value)))
                .collect(),
            index: self.index.clone(),
            integers: self.integers,
        }
    }
}

impl<V> FromIterator<(String, V)> for JsMap<V> {
    fn from_iter<T: IntoIterator<Item = (String, V)>>(iter: T) -> Self {
        let mut map = JsMap::new();
        for (key, value) in iter {
            map.insert(key, value);
        }
        map
    }
}

/// A parsed JSON value with JavaScript semantics.
#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    Object(JsMap<JsValue>),
}

impl JsValue {
    /// The value as a plain object (`record()` in sanitize.ts: not null, not an array).
    pub fn as_object(&self) -> Option<&JsMap<JsValue>> {
        match self {
            JsValue::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<JsValue>> {
        match self {
            JsValue::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsValue::Number(value) => Some(*value),
            _ => None,
        }
    }

    /// `value === true`.
    pub fn is_true(&self) -> bool {
        matches!(self, JsValue::Bool(true))
    }

    /// Property lookup; missing keys and non-objects give `None` (`undefined`).
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.as_object().and_then(|map| map.get(key))
    }

    pub fn str(value: impl Into<String>) -> JsValue {
        JsValue::String(value.into())
    }

    pub fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
        let mut map = JsMap::new();
        for (key, value) in entries {
            map.insert(key, value);
        }
        JsValue::Object(map)
    }
}

/// `x === undefined ? undefined : x` for optional lookups: helper for `obj?.key`.
pub fn get<'a>(value: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    value.and_then(|value| value.get(key))
}

// ── Parsing ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonError {
    pub message: String,
    pub offset: usize,
}

impl std::fmt::Display for JsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for JsonError {}

/// Containers nested deeper than this are validated but read as `null`. The
/// sanitizers never look deeper than ~16 levels, so their results do not
/// change, and a hostile file cannot overflow the stack.
pub const DEFAULT_MAX_DEPTH: usize = 128;

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<JsValue, JsonError> {
    parse_with_depth(text, DEFAULT_MAX_DEPTH)
}

pub fn parse_with_depth(text: &str, max_depth: usize) -> Result<JsValue, JsonError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        text,
        position: 0,
        max_depth,
    };
    parser.whitespace();
    let value = parser.value(0)?;
    parser.whitespace();
    if parser.position != parser.bytes.len() {
        return Err(parser.error("unexpected content after the value"));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    position: usize,
    max_depth: usize,
}

impl Parser<'_> {
    fn error(&self, message: &str) -> JsonError {
        JsonError {
            message: message.to_string(),
            offset: self.position,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn whitespace(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.position += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), JsonError> {
        if self.peek() == Some(byte) {
            self.position += 1;
            Ok(())
        } else {
            Err(self.error(&format!("expected '{}'", byte as char)))
        }
    }

    fn value(&mut self, depth: usize) -> Result<JsValue, JsonError> {
        match self.peek() {
            Some(b'[') | Some(b'{') if depth >= self.max_depth => {
                self.skip_value()?;
                Ok(JsValue::Null)
            }
            Some(b'[') => {
                self.position += 1;
                let mut items = Vec::new();
                self.whitespace();
                if self.peek() == Some(b']') {
                    self.position += 1;
                    return Ok(JsValue::Array(items));
                }
                loop {
                    self.whitespace();
                    items.push(self.value(depth + 1)?);
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => self.position += 1,
                        Some(b']') => {
                            self.position += 1;
                            return Ok(JsValue::Array(items));
                        }
                        _ => return Err(self.error("expected ',' or ']'")),
                    }
                }
            }
            Some(b'{') => {
                self.position += 1;
                let mut map = JsMap::new();
                self.whitespace();
                if self.peek() == Some(b'}') {
                    self.position += 1;
                    return Ok(JsValue::Object(map));
                }
                loop {
                    self.whitespace();
                    let key = self.string()?;
                    self.whitespace();
                    self.expect(b':')?;
                    self.whitespace();
                    let value = self.value(depth + 1)?;
                    // Duplicate keys: the last value wins, the first position stays (JSON.parse).
                    map.insert(key, value);
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => self.position += 1,
                        Some(b'}') => {
                            self.position += 1;
                            return Ok(JsValue::Object(map));
                        }
                        _ => return Err(self.error("expected ',' or '}'")),
                    }
                }
            }
            Some(b'"') => Ok(JsValue::String(self.string()?)),
            Some(b't') => self.literal("true", JsValue::Bool(true)),
            Some(b'f') => self.literal("false", JsValue::Bool(false)),
            Some(b'n') => self.literal("null", JsValue::Null),
            Some(b'-' | b'0'..=b'9') => Ok(JsValue::Number(self.number()?)),
            _ => Err(self.error("unexpected character")),
        }
    }

    fn literal(&mut self, word: &str, value: JsValue) -> Result<JsValue, JsonError> {
        if self.bytes[self.position..].starts_with(word.as_bytes()) {
            self.position += word.len();
            Ok(value)
        } else {
            Err(self.error("invalid literal"))
        }
    }

    fn number(&mut self) -> Result<f64, JsonError> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                while let Some(b'0'..=b'9') = self.peek() {
                    self.position += 1;
                }
            }
            _ => return Err(self.error("invalid number")),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while let Some(b'0'..=b'9') = self.peek() {
                self.position += 1;
            }
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.position += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while let Some(b'0'..=b'9') = self.peek() {
                self.position += 1;
            }
        }
        self.text[start..self.position]
            .parse::<f64>()
            .map_err(|_| self.error("invalid number"))
    }

    fn hex4(&mut self) -> Result<u16, JsonError> {
        let digits = self
            .bytes
            .get(self.position..self.position + 4)
            .ok_or_else(|| self.error("bad escape"))?;
        let mut value = 0u16;
        for &digit in digits {
            let nibble = (digit as char)
                .to_digit(16)
                .ok_or_else(|| self.error("bad escape"))?;
            value = value * 16 + nibble as u16;
        }
        self.position += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.position;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.position += 1;
            }
            out.push_str(&self.text[start..self.position]);
            match self.peek() {
                Some(b'"') => {
                    self.position += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.position += 1;
                    let escape = self.peek().ok_or_else(|| self.error("bad escape"))?;
                    self.position += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            if (0xD800..0xDC00).contains(&unit) {
                                // A high surrogate: combine with a following low one.
                                if self.bytes[self.position..].starts_with(b"\\u") {
                                    let saved = self.position;
                                    self.position += 2;
                                    let low = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&low) {
                                        let code = 0x10000
                                            + (((unit as u32) - 0xD800) << 10)
                                            + ((low as u32) - 0xDC00);
                                        out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                                        continue;
                                    }
                                    self.position = saved;
                                }
                                out.push('\u{FFFD}');
                            } else if (0xDC00..0xE000).contains(&unit) {
                                out.push('\u{FFFD}');
                            } else {
                                out.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
                            }
                        }
                        _ => return Err(self.error("bad escape")),
                    }
                }
                _ => return Err(self.error("unterminated string")),
            }
        }
    }

    /// Validates one value without building it (no recursion).
    fn skip_value(&mut self) -> Result<(), JsonError> {
        let mut stack: Vec<u8> = Vec::new();
        loop {
            self.whitespace();
            match self.peek() {
                Some(b'[') => {
                    self.position += 1;
                    self.whitespace();
                    if self.peek() == Some(b']') {
                        self.position += 1;
                    } else {
                        stack.push(b'[');
                        continue;
                    }
                }
                Some(b'{') => {
                    self.position += 1;
                    self.whitespace();
                    if self.peek() == Some(b'}') {
                        self.position += 1;
                    } else {
                        self.string()?;
                        self.whitespace();
                        self.expect(b':')?;
                        stack.push(b'{');
                        continue;
                    }
                }
                Some(b'"') => {
                    self.string()?;
                }
                Some(b't') => {
                    self.literal("true", JsValue::Null)?;
                }
                Some(b'f') => {
                    self.literal("false", JsValue::Null)?;
                }
                Some(b'n') => {
                    self.literal("null", JsValue::Null)?;
                }
                Some(b'-' | b'0'..=b'9') => {
                    self.number()?;
                }
                _ => return Err(self.error("unexpected character")),
            }
            loop {
                let Some(&open) = stack.last() else {
                    return Ok(());
                };
                self.whitespace();
                let close = if open == b'[' { b']' } else { b'}' };
                match self.peek() {
                    Some(b',') => {
                        self.position += 1;
                        if open == b'{' {
                            self.whitespace();
                            self.string()?;
                            self.whitespace();
                            self.expect(b':')?;
                        }
                        break;
                    }
                    Some(byte) if byte == close => {
                        self.position += 1;
                        stack.pop();
                    }
                    _ => return Err(self.error("expected ',' or a closing bracket")),
                }
            }
        }
    }
}

// ── Writing ──────────────────────────────────────────────────────────────

/// `String(number)` / `Number.prototype.toString()`.
pub fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if value == 0.0 {
        return "0".into();
    }
    // Shortest round-trip digits, as `d.ddddde±x`.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let mut out = String::new();
    if value < 0.0 {
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
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let e = n - 1;
        out.push(if e >= 0 { '+' } else { '-' });
        let _ = write!(out, "{}", e.abs());
    }
    out
}

/// A string literal as `JSON.stringify` writes it.
pub fn quote(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(value)` (indent `None`) or `JSON.stringify(value, null, indent)`.
pub fn stringify(value: &JsValue, indent: Option<usize>) -> String {
    let mut out = String::new();
    write_value(
        value,
        indent
            .filter(|&n| n > 0)
            .map(|n| " ".repeat(n.min(10)))
            .as_deref(),
        0,
        &mut out,
    );
    out
}

fn newline(out: &mut String, indent: &str, level: usize) {
    out.push('\n');
    for _ in 0..level {
        out.push_str(indent);
    }
}

fn write_value(value: &JsValue, indent: Option<&str>, level: usize, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(true) => out.push_str("true"),
        JsValue::Bool(false) => out.push_str("false"),
        JsValue::Number(number) => {
            if number.is_finite() {
                out.push_str(&js_number(*number));
            } else {
                out.push_str("null");
            }
        }
        JsValue::String(text) => quote(text, out),
        JsValue::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (position, item) in items.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                if let Some(indent) = indent {
                    newline(out, indent, level + 1);
                }
                write_value(item, indent, level + 1, out);
            }
            if let Some(indent) = indent {
                newline(out, indent, level);
            }
            out.push(']');
        }
        JsValue::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (position, (key, item)) in map.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                if let Some(indent) = indent {
                    newline(out, indent, level + 1);
                }
                quote(key, out);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(item, indent, level + 1, out);
            }
            if let Some(indent) = indent {
                newline(out, indent, level);
            }
            out.push('}');
        }
    }
}

/// Builds an object value from `(key, value)` pairs, leaving out `None` (JavaScript `undefined`).
#[derive(Default)]
pub struct ObjectBuilder {
    map: JsMap<JsValue>,
}

impl ObjectBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(mut self, key: &str, value: impl Into<JsValue>) -> Self {
        self.map.insert(key, value.into());
        self
    }

    pub fn opt(mut self, key: &str, value: Option<impl Into<JsValue>>) -> Self {
        if let Some(value) = value {
            self.map.insert(key, value.into());
        }
        self
    }

    /// `...(flag ? { key: true } : {})`.
    pub fn flag(mut self, key: &str, on: bool) -> Self {
        if on {
            self.map.insert(key, JsValue::Bool(true));
        }
        self
    }

    pub fn build(self) -> JsValue {
        JsValue::Object(self.map)
    }
}

impl From<bool> for JsValue {
    fn from(value: bool) -> Self {
        JsValue::Bool(value)
    }
}

impl From<f64> for JsValue {
    fn from(value: f64) -> Self {
        JsValue::Number(value)
    }
}

impl From<usize> for JsValue {
    fn from(value: usize) -> Self {
        JsValue::Number(value as f64)
    }
}

impl From<&str> for JsValue {
    fn from(value: &str) -> Self {
        JsValue::String(value.to_string())
    }
}

impl From<String> for JsValue {
    fn from(value: String) -> Self {
        JsValue::String(value)
    }
}

impl From<&String> for JsValue {
    fn from(value: &String) -> Self {
        JsValue::String(value.clone())
    }
}

impl From<Vec<JsValue>> for JsValue {
    fn from(value: Vec<JsValue>) -> Self {
        JsValue::Array(value)
    }
}

impl From<JsMap<JsValue>> for JsValue {
    fn from(value: JsMap<JsValue>) -> Self {
        JsValue::Object(value)
    }
}

/// Values that convert to their JSON form (the shape `JSON.stringify` writes).
pub trait ToJs {
    fn to_js(&self) -> JsValue;

    /// `JSON.stringify(value)`.
    fn to_json(&self) -> String {
        stringify(&self.to_js(), None)
    }
}

impl<T: ToJs> ToJs for Vec<T> {
    fn to_js(&self) -> JsValue {
        JsValue::Array(self.iter().map(ToJs::to_js).collect())
    }
}

impl<T: ToJs> ToJs for [T] {
    fn to_js(&self) -> JsValue {
        JsValue::Array(self.iter().map(ToJs::to_js).collect())
    }
}

impl<T: ToJs> ToJs for JsMap<T> {
    fn to_js(&self) -> JsValue {
        JsValue::Object(self.map_values(ToJs::to_js))
    }
}

impl ToJs for f64 {
    fn to_js(&self) -> JsValue {
        JsValue::Number(*self)
    }
}

impl ToJs for String {
    fn to_js(&self) -> JsValue {
        JsValue::String(self.clone())
    }
}

impl ToJs for JsValue {
    fn to_js(&self) -> JsValue {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (12.0, "12"),
            (10.5, "10.5"),
            (215.9, "215.9"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (-2.5, "-2.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (96.0 / 25.4, "3.7795275590551185"),
            (9007199254740993.0, "9007199254740992"),
        ];
        for (value, expected) in cases {
            assert_eq!(js_number(value), expected, "{value}");
        }
    }

    #[test]
    fn object_order_matches_javascript() {
        let value = parse(r#"{"b":1,"10":2,"a":3,"2":4,"02":5,"b":6}"#).unwrap();
        assert_eq!(
            stringify(&value, None),
            r#"{"2":4,"10":2,"b":6,"a":3,"02":5}"#
        );
        assert_eq!(
            stringify(&value, Some(1)),
            "{\n \"2\": 4,\n \"10\": 2,\n \"b\": 6,\n \"a\": 3,\n \"02\": 5\n}"
        );
        assert_eq!(
            stringify(&parse("[[],{}]").unwrap(), Some(2)),
            "[\n  [],\n  {}\n]"
        );
    }

    #[test]
    fn strings_escape_like_javascript() {
        let value = parse(r#""a\"b\\c\/d\u0001\u001f\n\té😀\ud83d x""#).unwrap();
        assert_eq!(
            value.as_str().unwrap(),
            "a\"b\\c/d\u{1}\u{1f}\n\té😀\u{FFFD} x"
        );
        assert_eq!(
            stringify(&value, None),
            "\"a\\\"b\\\\c/d\\u0001\\u001f\\n\\té😀\u{FFFD} x\""
        );
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        for bad in [
            "",
            "[1,]",
            "{\"a\":1,}",
            "01",
            "1.",
            ".5",
            "\"\t\"",
            "[1] 2",
            "nul",
            "{a:1}",
            "\u{feff}{}",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            parse(" [1e400, -0] ").unwrap(),
            JsValue::Array(vec![JsValue::Number(f64::INFINITY), JsValue::Number(-0.0)])
        );
    }

    #[test]
    fn deep_nesting_is_read_as_null_without_recursion() {
        let deep = format!("{{\"a\":{}1{}}}", "[".repeat(200_000), "]".repeat(200_000));
        let value = parse(&deep).unwrap();
        let mut depth = 0;
        let mut cursor = value.get("a").unwrap();
        while let JsValue::Array(items) = cursor {
            depth += 1;
            cursor = &items[0];
        }
        assert_eq!((depth, cursor), (DEFAULT_MAX_DEPTH - 1, &JsValue::Null));
        assert!(parse(&format!("{}1{}", "[".repeat(1000), "]".repeat(999))).is_err());
    }
}
