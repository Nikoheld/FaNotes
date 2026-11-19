//! Small JavaScript-compatibility helpers shared by the modules.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::Result;

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

/// `Number.isSafeInteger(value)` on a parsed JSON value (all numbers are doubles in JS).
pub fn safe_integer(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        // Negative values are safe integers too, but every caller range-checks >= 0.
        return if number < 0.0 {
            None
        } else {
            Some(number as u64)
        };
    }
    None
}

pub fn plain_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// Strict equality against a JSON string (`value === "text"`).
pub fn str_eq(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// JS `\s` (ECMAScript WhiteSpace + LineTerminator).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String(value).slice(0, limit)` counted in UTF-16 units (never splits a pair).
pub fn js_slice(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > limit {
            break;
        }
        out.push(ch);
    }
    out
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Number(text)` for the header values the updater reads (`content-length`).
pub fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return u128::from_str_radix(rest, radix).map_or(f64::NAN, |v| v as f64);
        }
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
    {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

#[cfg(unix)]
pub fn read_exact_at(file: &File, mut buffer: &mut [u8], mut position: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    while !buffer.is_empty() {
        let read = file.read_at(buffer, position)?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        position += read as u64;
        buffer = &mut buffer[read..];
    }
    Ok(())
}

#[cfg(windows)]
pub fn read_exact_at(file: &File, mut buffer: &mut [u8], mut position: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buffer.is_empty() {
        let read = file.seek_read(buffer, position)?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        position += read as u64;
        buffer = &mut buffer[read..];
    }
    Ok(())
}

#[cfg(unix)]
pub fn write_all_at(file: &File, mut buffer: &[u8], mut position: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    while !buffer.is_empty() {
        let written = file.write_at(buffer, position)?;
        if written == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        position += written as u64;
        buffer = &buffer[written..];
    }
    Ok(())
}

#[cfg(windows)]
pub fn write_all_at(file: &File, mut buffer: &[u8], mut position: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buffer.is_empty() {
        let written = file.seek_write(buffer, position)?;
        if written == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        position += written as u64;
        buffer = &buffer[written..];
    }
    Ok(())
}

/// `lstat` that treats "missing" as `None` (the JS `.catch(() => null)` idiom).
pub fn lstat_opt(path: &Path) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(path).ok()
}

/// A regular file that is not a symbolic link.
pub fn is_plain_file(meta: &std::fs::Metadata) -> bool {
    meta.is_file() && !meta.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_parsing_matches_js() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert!(js_number("abc").is_nan());
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert!(js_number("inf").is_nan());
    }

    #[test]
    fn slice_counts_utf16() {
        assert_eq!(js_slice("a\u{1f600}b", 2), "a");
        assert_eq!(js_slice("abc", 2), "ab");
    }
}
