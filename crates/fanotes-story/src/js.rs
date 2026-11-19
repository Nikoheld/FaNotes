//! JavaScript semantics the TypeScript engine relies on: UTF-16 string
//! lengths and slices, `<` on strings, `Math.round`/`max`/`min`, and the
//! `toLocaleUpperCase` the layout uses for small caps.

use std::cmp::Ordering;

/// `text.length` (UTF-16 code units).
pub fn len16(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Byte index of a UTF-16 offset. An offset inside a surrogate pair rounds
/// down (start of the character) when `down`, else up.
pub fn byte_at16(text: &str, offset: usize, down: bool) -> usize {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units >= offset {
            return byte;
        }
        let next = units + c.len_utf16();
        if next > offset {
            return if down { byte } else { byte + c.len_utf8() };
        }
        units = next;
    }
    text.len()
}

/// `text.slice(from, to)` with JavaScript clamping. A cut through a surrogate
/// pair drops the half character (JavaScript would keep a lone surrogate).
pub fn slice16(text: &str, from: usize, to: usize) -> String {
    if from >= to {
        return String::new();
    }
    let start = byte_at16(text, from, false);
    let end = byte_at16(text, to, true);
    if start >= end {
        String::new()
    } else {
        text[start..end].to_string()
    }
}

/// `text.slice(0, max)`.
pub fn truncate16(text: &str, max: usize) -> String {
    slice16(text, 0, max)
}

/// `a < b` on JavaScript strings: UTF-16 code unit order.
pub fn cmp16(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `a.localeCompare(b)` for the ids the engine sorts by. Sanitized ids are
/// `[0-9a-z]`, where ICU's root collation equals code unit order.
pub fn locale_compare_ids(a: &str, b: &str) -> Ordering {
    cmp16(a, b)
}

/// `Math.round`.
pub fn round(value: f64) -> f64 {
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

/// `Math.max(a, b)`.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() || b.is_sign_positive() {
            0.0
        } else {
            -0.0
        }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Number.isSafeInteger(value)`.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value && value.abs() <= 9_007_199_254_740_991.0
}

/// `upperChar` in linebreak.ts: `ß` → `ẞ`, else the upper case when it has
/// the same UTF-16 length, else the character itself.
pub fn upper_char(c: char) -> String {
    if c == 'ß' {
        return "ẞ".into();
    }
    let upper: String = c.to_uppercase().collect();
    if len16(&upper) == c.len_utf16() {
        upper
    } else {
        c.to_string()
    }
}

/// `upper` in linebreak.ts.
pub fn upper(text: &str) -> String {
    text.chars().map(upper_char).collect()
}

/// `text[index] !== upperChar(text[index])` for a single UTF-16 unit.
pub fn unit_is_lower(unit: u16) -> bool {
    match char::from_u32(unit as u32) {
        // A lone surrogate half upper-cases to itself.
        None => false,
        Some(c) => {
            let up = upper_char(c);
            let mut chars = up.chars();
            !(chars.next() == Some(c) && chars.next().is_none())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_slicing() {
        assert_eq!(len16("a😀b"), 4);
        assert_eq!(slice16("a😀b", 0, 3), "a😀");
        assert_eq!(slice16("a😀b", 0, 2), "a");
        assert_eq!(slice16("a😀b", 2, 4), "b");
        assert_eq!(slice16("abc", 2, 99), "c");
        assert_eq!(cmp16("\u{FF5E}", "😀"), Ordering::Greater);
    }

    #[test]
    fn math_round_like_javascript() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert!(round(-0.4).is_sign_negative());
    }

    #[test]
    fn upper_case_like_the_layout() {
        assert_eq!(upper("straße"), "STRAẞE");
        assert_eq!(upper("ŉx"), "ŉX");
        assert!(unit_is_lower('a' as u16));
        assert!(!unit_is_lower('A' as u16));
        assert!(!unit_is_lower('1' as u16));
    }
}
