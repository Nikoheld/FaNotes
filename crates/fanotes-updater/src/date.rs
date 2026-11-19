//! Minimal ISO-8601 date handling, enough for `Date.parse(...)` finiteness
//! checks and `toISOString()` in the JS updater.

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
    }
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn digits(bytes: &[u8], pos: &mut usize, count: usize) -> Option<i64> {
    let slice = bytes.get(*pos..*pos + count)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *pos += count;
    Some(
        slice
            .iter()
            .fold(0i64, |acc, b| acc * 10 + i64::from(b - b'0')),
    )
}

/// Parse an ISO-8601 date or date-time into milliseconds since the Unix epoch.
///
/// Accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, optionally followed by `T`/space
/// and `HH:mm[:ss[.fff...]]` and an optional `Z` or `+-HH:mm`. A date-time
/// without an offset is read as UTC (JS would use local time). Legacy formats
/// that V8's fallback parser accepts, such as `Jul 14 2026`, are rejected.
pub fn parse_date_ms(input: &str) -> Option<i64> {
    let bytes = input.trim().as_bytes();
    let mut pos = 0;
    let year = digits(bytes, &mut pos, 4)?;
    let mut month = 1;
    let mut day = 1;
    if bytes.get(pos) == Some(&b'-') {
        pos += 1;
        month = digits(bytes, &mut pos, 2)?;
        if bytes.get(pos) == Some(&b'-') {
            pos += 1;
            day = digits(bytes, &mut pos, 2)?;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
    let mut offset_minutes = 0;
    if matches!(bytes.get(pos), Some(b'T') | Some(b't') | Some(b' ')) {
        pos += 1;
        hour = digits(bytes, &mut pos, 2)?;
        if bytes.get(pos) != Some(&b':') {
            return None;
        }
        pos += 1;
        minute = digits(bytes, &mut pos, 2)?;
        if bytes.get(pos) == Some(&b':') {
            pos += 1;
            second = digits(bytes, &mut pos, 2)?;
            if bytes.get(pos) == Some(&b'.') {
                pos += 1;
                let start = pos;
                while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
                    pos += 1;
                }
                if pos == start {
                    return None;
                }
                let mut frac = String::from_utf8_lossy(&bytes[start..pos]).into_owned();
                frac.truncate(3);
                while frac.len() < 3 {
                    frac.push('0');
                }
                millis = frac.parse().ok()?;
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute, second, millis) != (0, 0, 0))
        {
            return None;
        }
        match bytes.get(pos) {
            Some(b'Z') | Some(b'z') => pos += 1,
            Some(&sign @ (b'+' | b'-')) => {
                pos += 1;
                let oh = digits(bytes, &mut pos, 2)?;
                if bytes.get(pos) == Some(&b':') {
                    pos += 1;
                }
                let om = digits(bytes, &mut pos, 2)?;
                if oh > 23 || om > 59 {
                    return None;
                }
                offset_minutes = (oh * 60 + om) * if sign == b'-' { -1 } else { 1 };
            }
            _ => {}
        }
    }
    if pos != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some((((days * 24 + hour) * 60 + minute - offset_minutes) * 60 + second) * 1000 + millis)
}

/// `Date.prototype.toISOString()` for years 0000..=9999, otherwise `None`.
pub fn iso_from_ms(ms: i64) -> Option<String> {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    if !(0..=9999).contains(&y) {
        return None;
    }
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    ))
}

pub fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    iso_from_ms(ms).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects() {
        let ms = parse_date_ms("2026-10-11T12:00:00.000Z").unwrap();
        assert_eq!(iso_from_ms(ms).unwrap(), "2026-10-11T12:00:00.000Z");
        assert_eq!(
            parse_date_ms("2026-07-14T22:30:00.000+02:00"),
            parse_date_ms("2026-07-14T20:30:00Z")
        );
        assert!(parse_date_ms("2026-02-30").is_none());
        assert!(parse_date_ms("not a date").is_none());
        assert!(parse_date_ms("2026-07-14T25:00").is_none());
        assert_eq!(parse_date_ms("1970-01-01T00:00:00Z"), Some(0));
    }
}
