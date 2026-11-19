//! `stableStringify` from `updater.cjs`, byte for byte.
//!
//! The manifest signature covers `stableStringify(payload)`: keys sorted by
//! UTF-16 code unit, no whitespace, `JSON.stringify` string escaping and
//! JavaScript number formatting (every number is an IEEE double).

use serde_json::Value;

/// `Number.prototype.toString()` for finite doubles, as `JSON.stringify` uses.
pub fn js_number_to_string(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // `{:e}` yields the shortest round-trip digits: "d.ddde-7" or "de21".
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let exp = format!("e{}{}", if e < 0 { "-" } else { "+" }, e.abs());
        if k == 1 {
            format!("{digits}{exp}")
        } else {
            format!("{}.{}{exp}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `JSON.stringify(string)`.
pub fn js_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => js_quote(s),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(stable_stringify).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", js_quote(key), stable_stringify(&map[key])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_match_javascript() {
        for (value, expected) in [
            (1.0, "1"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.1, "0.1"),
            (-2.5e-10, "-2.5e-10"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(js_number_to_string(value), expected, "{value}");
        }
    }

    #[test]
    fn keys_sort_by_utf16_units() {
        // U+FF5E (BMP) sorts after U+1F600 (surrogate pair D83D...) in UTF-16, before it in UTF-8.
        let value: Value = serde_json::from_str(
            "{\"\u{ff5e}\":1,\"\u{1f600}\":2,\"b\":3,\"a\":{\"z\":1,\"y\":[1.0,null]}}",
        )
        .unwrap();
        assert_eq!(
            stable_stringify(&value),
            "{\"a\":{\"y\":[1,null],\"z\":1},\"b\":3,\"\u{1f600}\":2,\"\u{ff5e}\":1}"
        );
        assert_eq!(
            stable_stringify(&json!("a\u{1}\"\\\n")),
            "\"a\\u0001\\\"\\\\\\n\""
        );
    }
}
