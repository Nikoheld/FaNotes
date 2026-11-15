//! Order keys ("fractional indexing", `model/keys.ts`): strings that sort in
//! document order and always leave room for another key between two
//! neighbours. A key is a variable-length integer part (`a0` … `az`, `b00` …;
//! `Z…` below `a0`) followed by an optional fraction. Same output as the
//! TypeScript functions for every input; where they throw, these return `Err`.

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: &str = "a0";

fn smallest_integer() -> String {
    format!("A{}", "0".repeat(26))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyError(pub String);

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

fn digit_index(byte: u8) -> Option<usize> {
    DIGITS.iter().position(|&digit| digit == byte)
}

fn integer_length(head: u8) -> Result<usize, KeyError> {
    match head {
        b'a'..=b'z' => Ok((head - b'a') as usize + 2),
        b'A'..=b'Z' => Ok((b'Z' - head) as usize + 2),
        _ => Err(KeyError(format!(
            "invalid order key head: {}",
            head as char
        ))),
    }
}

fn integer_part(key: &str) -> Result<&str, KeyError> {
    let head = *key
        .as_bytes()
        .first()
        .ok_or_else(|| KeyError("invalid order key head: undefined".into()))?;
    let length = integer_length(head)?;
    if length > key.len() {
        return Err(KeyError(format!("invalid order key: {key}")));
    }
    Ok(&key[..length])
}

/// `isValidKey`: an integer part and a fraction without a trailing zero.
pub fn is_valid_key(key: &str) -> bool {
    if key.is_empty() || crate::js::len16(key) > 512 || key == smallest_integer() {
        return false;
    }
    if !key.bytes().all(|byte| byte.is_ascii_alphanumeric()) || !key.is_ascii() {
        return false;
    }
    match integer_part(key) {
        Ok(head) => !key[head.len()..].ends_with('0'),
        Err(_) => false,
    }
}

fn midpoint(a: &str, b: Option<&str>) -> Result<String, KeyError> {
    if let Some(b) = b {
        if a >= b {
            return Err(KeyError(format!("{a} >= {b}")));
        }
    }
    if a.ends_with('0') || b.is_some_and(|b| b.ends_with('0')) {
        return Err(KeyError("trailing zero".into()));
    }
    let a_bytes = a.as_bytes();
    if let Some(b) = b.filter(|b| !b.is_empty()) {
        let b_bytes = b.as_bytes();
        let mut shared = 0;
        while shared < b_bytes.len()
            && a_bytes.get(shared).copied().unwrap_or(b'0') == b_bytes[shared]
        {
            shared += 1;
        }
        if shared > 0 {
            return Ok(format!(
                "{}{}",
                &b[..shared],
                midpoint(a.get(shared..).unwrap_or(""), Some(&b[shared..]))?
            ));
        }
    }
    let digit = |byte: u8| {
        digit_index(byte)
            .ok_or_else(|| KeyError(format!("invalid order key digit: {}", byte as char)))
    };
    let digit_a = if a.is_empty() { 0 } else { digit(a_bytes[0])? };
    let digit_b = match b {
        Some(b) => match b.as_bytes().first() {
            Some(&byte) => digit(byte)?,
            None => return Err(KeyError("invalid order key digit: undefined".into())),
        },
        None => DIGITS.len(),
    };
    if digit_b as i64 - digit_a as i64 > 1 {
        let middle = crate::js::round((digit_a + digit_b) as f64 / 2.0) as usize;
        return Ok((DIGITS[middle] as char).to_string());
    }
    if let Some(b) = b.filter(|b| b.len() > 1) {
        return Ok(b[..1].to_string());
    }
    let rest = if a.is_empty() { "" } else { &a[1..] };
    Ok(format!(
        "{}{}",
        DIGITS[digit_a] as char,
        midpoint(rest, None)?
    ))
}

fn increment_integer(value: &str) -> Result<Option<String>, KeyError> {
    let bytes = value.as_bytes();
    let head = bytes[0];
    let mut digits: Vec<u8> = bytes[1..].to_vec();
    let mut carry = true;
    let mut index = digits.len();
    while carry && index > 0 {
        index -= 1;
        let next = digit_index(digits[index])
            .ok_or_else(|| KeyError("invalid order key digit".into()))?
            + 1;
        if next == DIGITS.len() {
            digits[index] = b'0';
        } else {
            digits[index] = DIGITS[next];
            carry = false;
        }
    }
    if !carry {
        return Ok(Some(format!(
            "{}{}",
            head as char,
            String::from_utf8_lossy(&digits)
        )));
    }
    if head == b'Z' {
        return Ok(Some("a0".into()));
    }
    if head == b'z' {
        return Ok(None);
    }
    let next_head = head + 1;
    if next_head > b'a' {
        digits.push(b'0');
    } else {
        digits.pop();
    }
    Ok(Some(format!(
        "{}{}",
        next_head as char,
        String::from_utf8_lossy(&digits)
    )))
}

fn decrement_integer(value: &str) -> Result<Option<String>, KeyError> {
    let bytes = value.as_bytes();
    let head = bytes[0];
    let mut digits: Vec<u8> = bytes[1..].to_vec();
    let mut borrow = true;
    let mut index = digits.len();
    while borrow && index > 0 {
        index -= 1;
        let current =
            digit_index(digits[index]).ok_or_else(|| KeyError("invalid order key digit".into()))?;
        if current == 0 {
            digits[index] = DIGITS[DIGITS.len() - 1];
        } else {
            digits[index] = DIGITS[current - 1];
            borrow = false;
        }
    }
    if !borrow {
        return Ok(Some(format!(
            "{}{}",
            head as char,
            String::from_utf8_lossy(&digits)
        )));
    }
    if head == b'a' {
        return Ok(Some(format!("Z{}", DIGITS[DIGITS.len() - 1] as char)));
    }
    if head == b'A' {
        return Ok(None);
    }
    let next_head = head - 1;
    if next_head < b'Z' {
        digits.push(DIGITS[DIGITS.len() - 1]);
    } else {
        digits.pop();
    }
    Ok(Some(format!(
        "{}{}",
        next_head as char,
        String::from_utf8_lossy(&digits)
    )))
}

/// `keyBetween(a, b)`: a key strictly between `a` and `b` (`None` = open end).
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String, KeyError> {
    if a.is_some_and(|a| !a.is_ascii()) || b.is_some_and(|b| !b.is_ascii()) {
        return Err(KeyError("invalid order key".into()));
    }
    if let (Some(a), Some(b)) = (a, b) {
        if a >= b {
            return Err(KeyError(format!("order keys out of order: {a} >= {b}")));
        }
    }
    match (a, b) {
        (None, None) => Ok(ZERO.to_string()),
        (None, Some(b)) => {
            let head = integer_part(b)?;
            let fraction = &b[head.len()..];
            if head == smallest_integer() {
                return Ok(format!("{head}{}", midpoint("", Some(fraction))?));
            }
            if head < b {
                return Ok(head.to_string());
            }
            decrement_integer(head)?
                .ok_or_else(|| KeyError("cannot go below the smallest order key".into()))
        }
        (Some(a), None) => {
            let head = integer_part(a)?;
            let fraction = &a[head.len()..];
            match increment_integer(head)? {
                Some(higher) => Ok(higher),
                None => Ok(format!("{head}{}", midpoint(fraction, None)?)),
            }
        }
        (Some(a), Some(b)) => {
            let head_a = integer_part(a)?;
            let fraction_a = &a[head_a.len()..];
            let head_b = integer_part(b)?;
            let fraction_b = &b[head_b.len()..];
            if head_a == head_b {
                return Ok(format!(
                    "{head_a}{}",
                    midpoint(fraction_a, Some(fraction_b))?
                ));
            }
            let higher = increment_integer(head_a)?
                .ok_or_else(|| KeyError("cannot go above the largest order key".into()))?;
            if higher.as_str() < b {
                Ok(higher)
            } else {
                Ok(format!("{head_a}{}", midpoint(fraction_a, None)?))
            }
        }
    }
}

/// `keysBetween(a, b, count)`: `count` keys in order, strictly between `a` and `b`.
pub fn keys_between(
    a: Option<&str>,
    b: Option<&str>,
    count: usize,
) -> Result<Vec<String>, KeyError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if count == 1 {
        return Ok(vec![key_between(a, b)?]);
    }
    match (a, b) {
        (_, None) => {
            let mut out = Vec::with_capacity(count);
            let mut previous = a.map(str::to_string);
            for _ in 0..count {
                let next = key_between(previous.as_deref(), None)?;
                out.push(next.clone());
                previous = Some(next);
            }
            Ok(out)
        }
        (None, Some(b)) => {
            let mut out = Vec::with_capacity(count);
            let mut next = b.to_string();
            for _ in 0..count {
                next = key_between(None, Some(&next))?;
                out.push(next.clone());
            }
            out.reverse();
            Ok(out)
        }
        (Some(a), Some(b)) => {
            let half = count / 2;
            let middle = key_between(Some(a), Some(b))?;
            let mut out = keys_between(Some(a), Some(&middle), half)?;
            out.push(middle.clone());
            out.extend(keys_between(Some(&middle), Some(b), count - half - 1)?);
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_sort_and_stay_short() {
        let mut previous: Option<String> = None;
        let mut appended = Vec::new();
        for _ in 0..10_000 {
            let next = key_between(previous.as_deref(), None).unwrap();
            appended.push(next.clone());
            previous = Some(next);
        }
        let mut sorted = appended.clone();
        sorted.sort();
        assert_eq!(sorted, appended);
        assert!(appended.last().unwrap().len() <= 4);
        assert!(!is_valid_key("a10"));
        assert!(is_valid_key("a1V"));
        let before = key_between(None, Some("a0")).unwrap();
        assert!(before.as_str() < "a0" && is_valid_key(&before));
    }
}
