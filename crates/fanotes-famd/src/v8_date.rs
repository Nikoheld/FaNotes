//! Node 22 `Date.parse`, from V8 12.4 `DateParser`.
//!
//! The legacy and ES5 paths share one scanner. A successful parse is
//! `MakeDay` + `MakeTime`, then either a fixed offset or the local zone.
//! `toISOString` is the canonical text. Instants outside ±8.64e15 ms are empty.

const SMI_MAX: u32 = 1_073_741_823;
const TIME_CLIP: i64 = 8_640_000_000_000_000;
const NONE: i32 = i32::MAX;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Invalid,
    Month,
    Zone,
    TimeSep,
    AmPm,
}

#[derive(Clone, Copy)]
enum Token {
    End,
    Invalid,
    Number { value: i32, length: i32 },
    Symbol(u8),
    White,
    Keyword { kind: Keyword, value: i32, length: i32 },
    Unknown,
}

impl Token {
    fn is_end(self) -> bool {
        matches!(self, Token::End)
    }

    fn is_invalid(self) -> bool {
        matches!(self, Token::Invalid)
    }

    fn is_number(self) -> bool {
        matches!(self, Token::Number { .. })
    }

    fn number(self) -> i32 {
        match self {
            Token::Number { value, .. } => value,
            _ => 0,
        }
    }

    fn length(self) -> i32 {
        match self {
            Token::Number { length, .. } | Token::Keyword { length, .. } => length,
            _ => 0,
        }
    }

    fn is_keyword(self) -> bool {
        matches!(self, Token::Keyword { .. })
    }

    fn keyword(self) -> (Keyword, i32, i32) {
        match self {
            Token::Keyword { kind, value, length } => (kind, value, length),
            _ => (Keyword::Invalid, 0, 0),
        }
    }

    fn is_symbol(self, symbol: u8) -> bool {
        matches!(self, Token::Symbol(found) if found == symbol)
    }

    fn is_white(self) -> bool {
        matches!(self, Token::White)
    }

    fn is_ascii_sign(self) -> bool {
        matches!(self, Token::Symbol(b'+' | b'-'))
    }

    fn ascii_sign(self) -> i32 {
        match self {
            Token::Symbol(b'+') => 1,
            Token::Symbol(b'-') => -1,
            _ => 0,
        }
    }

    fn is_keyword_z(self) -> bool {
        matches!(
            self,
            Token::Keyword {
                kind: Keyword::Zone,
                value: 0,
                length: 1
            }
        )
    }

    fn is_fixed_len(self, length: i32) -> bool {
        matches!(self, Token::Number { length: found, .. } if found == length)
    }

    fn is_time_sep(self) -> bool {
        matches!(self, Token::Keyword { kind: Keyword::TimeSep, .. })
    }
}

struct Input {
    units: Vec<u16>,
    index: usize,
    ch: u32,
}

impl Input {
    fn new(value: &str) -> Self {
        let units: Vec<u16> = value.encode_utf16().collect();
        let mut input = Self { units, index: 0, ch: 0 };
        input.next();
        input
    }

    fn next(&mut self) {
        self.ch = if self.index < self.units.len() {
            u32::from(self.units[self.index])
        } else {
            0
        };
        self.index += 1;
    }

    fn is_end(&self) -> bool {
        self.ch == 0
    }

    fn is_digit(&self) -> bool {
        (b'0' as u32..=b'9' as u32).contains(&self.ch)
    }

    fn read_unsigned(&mut self) -> (i32, i32) {
        let start = self.index - 1;
        while self.ch == u32::from(b'0') {
            self.next();
        }
        let mut number: i32 = 0;
        let mut significant = 0;
        while (b'0' as u32..=b'9' as u32).contains(&self.ch) {
            if significant < 9 {
                number = number * 10 + (self.ch as i32 - i32::from(b'0'));
            }
            significant += 1;
            self.next();
        }
        let length = (self.index - 1 - start) as i32;
        (number, length)
    }

    fn read_word(&mut self) -> ([u32; 3], i32) {
        let mut prefix = [0; 3];
        let mut length = 0;
        while self.ch >= u32::from(b'A') && !is_white_space(self.ch) {
            if length < 3 {
                prefix[length as usize] = self.ch | 0x20;
            }
            length += 1;
            self.next();
        }
        (prefix, length)
    }

    fn skip(&mut self, ch: u8) -> bool {
        if self.ch == u32::from(ch) {
            self.next();
            true
        } else {
            false
        }
    }

    fn skip_white(&mut self) -> bool {
        if is_date_space(self.ch) {
            self.next();
            true
        } else {
            false
        }
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.ch != u32::from(b'(') {
            return false;
        }
        let mut balance = 0i32;
        loop {
            if self.ch == u32::from(b')') {
                balance -= 1;
            } else if self.ch == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if balance <= 0 || self.ch == 0 {
                break;
            }
        }
        true
    }
}

struct Scanner {
    input: Input,
    next: Token,
}

impl Scanner {
    fn new(value: &str) -> Self {
        let input = Input::new(value);
        let mut scanner = Self { input, next: Token::End };
        scanner.next = scanner.scan();
        scanner
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn next(&mut self) -> Token {
        let current = self.next;
        self.next = self.scan();
        current
    }

    fn skip_symbol(&mut self, symbol: u8) -> bool {
        if self.next.is_symbol(symbol) {
            self.next = self.scan();
            true
        } else {
            false
        }
    }

    fn scan(&mut self) -> Token {
        if self.input.is_end() {
            return Token::End;
        }
        if self.input.is_digit() {
            let (value, length) = self.input.read_unsigned();
            return Token::Number { value, length };
        }
        if self.input.skip(b':') {
            return Token::Symbol(b':');
        }
        if self.input.skip(b'-') {
            return Token::Symbol(b'-');
        }
        if self.input.skip(b'+') {
            return Token::Symbol(b'+');
        }
        if self.input.skip(b'.') {
            return Token::Symbol(b'.');
        }
        // Node rejects an unmatched `)` once a number has been read. `(` still
        // opens a comment.
        if self.input.skip(b')') {
            return Token::Symbol(b')');
        }
        if self.input.ch >= u32::from(b'A') && !is_white_space(self.input.ch) {
            let (prefix, length) = self.input.read_word();
            let (kind, value) = lookup_keyword(prefix, length);
            return Token::Keyword { kind, value, length };
        }
        if self.input.skip_white() {
            return Token::White;
        }
        if self.input.skip_parentheses() {
            return Token::Unknown;
        }
        self.input.next();
        Token::Unknown
    }
}

struct TimeZone {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZone {
    fn new() -> Self {
        Self { sign: NONE, hour: NONE, minute: NONE }
    }

    fn set(&mut self, offset_hours: i32) {
        self.sign = if offset_hours < 0 { -1 } else { 1 };
        self.hour = offset_hours * self.sign;
        self.minute = 0;
    }

    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }

    fn is_expecting(&self, number: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(number)
    }

    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }

    fn write(&self) -> Option<Option<i32>> {
        if self.sign == NONE {
            return Some(None);
        }
        let hour = if self.hour == NONE { 0 } else { self.hour };
        let minute = if self.minute == NONE { 0 } else { self.minute };
        let total = (hour as u32).wrapping_mul(3600).wrapping_add((minute as u32).wrapping_mul(60));
        if total > SMI_MAX {
            return None;
        }
        let mut seconds = total as i32;
        if self.sign < 0 {
            seconds = seconds.wrapping_neg();
        }
        Some(Some(seconds))
    }
}

struct Time {
    fields: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl Time {
    fn new() -> Self {
        Self { fields: [0; 4], index: 0, hour_offset: NONE }
    }

    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn is_expecting(&self, number: i32) -> bool {
        (self.index == 1 && is_minute(number))
            || (self.index == 2 && is_second(number))
            || (self.index == 3 && (0..=999).contains(&number))
    }

    fn add(&mut self, number: i32) -> bool {
        if self.index < 4 {
            self.fields[self.index] = number;
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn add_final(&mut self, number: i32) -> bool {
        if !self.add(number) {
            return false;
        }
        while self.index < 4 {
            self.fields[self.index] = 0;
            self.index += 1;
        }
        true
    }

    fn write(&mut self) -> Option<(i32, i32, i32, i32)> {
        while self.index < 4 {
            self.fields[self.index] = 0;
            self.index += 1;
        }
        if self.hour_offset != NONE {
            if !(0..=12).contains(&self.fields[0]) {
                return None;
            }
            self.fields[0] %= 12;
            self.fields[0] += self.hour_offset;
        }
        let (hour, minute, second, millis) = (self.fields[0], self.fields[1], self.fields[2], self.fields[3]);
        if !(0..=23).contains(&hour) || !is_minute(minute) || !is_second(second) || !(0..=999).contains(&millis)
        {
            if hour != 24 || minute != 0 || second != 0 || millis != 0 {
                return None;
            }
        }
        Some((hour, minute, second, millis))
    }
}

struct Day {
    fields: [i32; 3],
    index: usize,
    named_month: i32,
    iso: bool,
}

impl Day {
    fn new() -> Self {
        Self { fields: [0; 3], index: 0, named_month: NONE, iso: false }
    }

    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn add(&mut self, number: i32) -> bool {
        if self.index < 3 {
            self.fields[self.index] = number;
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn write(&mut self) -> Option<(i32, i32, i32)> {
        if self.index < 1 {
            return None;
        }
        while self.index < 3 {
            self.fields[self.index] = 1;
            self.index += 1;
        }
        let (year, month, day) = if self.named_month == NONE {
            if self.iso || !is_day(self.fields[0]) {
                (self.fields[0], self.fields[1], self.fields[2])
            } else {
                (self.fields[2], self.fields[0], self.fields[1])
            }
        } else if !is_day(self.fields[0]) {
            (self.fields[0], self.named_month, self.fields[1])
        } else {
            (self.fields[1], self.named_month, self.fields[0])
        };
        let mut year = year;
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        if !(-1_073_741_824..=1_073_741_823).contains(&year) || !is_month(month) || !is_day(day) {
            return None;
        }
        Some((year, month - 1, day))
    }
}

fn parse_es5(scanner: &mut Scanner, day: &mut Day, time: &mut Time, zone: &mut TimeZone) -> Token {
    if scanner.peek().is_ascii_sign() {
        let sign = scanner.next();
        if !scanner.peek().is_fixed_len(6) {
            return sign;
        }
        let year = scanner.next().number();
        if sign.ascii_sign() < 0 && year == 0 {
            return sign;
        }
        day.add(sign.ascii_sign() * year);
    } else if scanner.peek().is_fixed_len(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        let month = scanner.peek();
        if !month.is_fixed_len(2) || !is_month(month.number()) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol(b'-') {
            let day_token = scanner.peek();
            if !day_token.is_fixed_len(2) || !is_day(day_token.number()) {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    if !scanner.peek().is_time_sep() {
        if !scanner.peek().is_end() {
            return scanner.next();
        }
    } else {
        scanner.next();
        let hour = scanner.peek();
        if !hour.is_fixed_len(2) || !(0..=24).contains(&hour.number()) {
            return Token::Invalid;
        }
        let hour_is_24 = hour.number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(b':') {
            return Token::Invalid;
        }
        let minute = scanner.peek();
        if !minute.is_fixed_len(2) || !is_minute(minute.number()) || (hour_is_24 && minute.number() > 0) {
            return Token::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(b':') {
            let second = scanner.peek();
            if !second.is_fixed_len(2) || !is_second(second.number()) || (hour_is_24 && second.number() > 0) {
                return Token::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b'.') {
                let fraction = scanner.peek();
                if !fraction.is_number() || (hour_is_24 && fraction.number() > 0) {
                    return Token::Invalid;
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            zone.set(0);
        } else if scanner.peek().is_symbol(b'+') || scanner.peek().is_symbol(b'-') {
            let sign = scanner.next();
            zone.set_sign(sign.ascii_sign());
            if scanner.peek().is_fixed_len(4) {
                let hour_min = scanner.next().number();
                let hour = hour_min / 100;
                let minute = hour_min % 100;
                if !(0..=23).contains(&hour) || !is_minute(minute) {
                    return Token::Invalid;
                }
                zone.hour = hour;
                zone.minute = minute;
            } else {
                let hour = scanner.peek();
                if !hour.is_fixed_len(2) || !(0..=23).contains(&hour.number()) {
                    return Token::Invalid;
                }
                zone.hour = scanner.next().number();
                if !scanner.skip_symbol(b':') {
                    return Token::Invalid;
                }
                let minute = scanner.peek();
                if !minute.is_fixed_len(2) || !is_minute(minute.number()) {
                    return Token::Invalid;
                }
                zone.minute = scanner.next().number();
            }
        }
        if !scanner.peek().is_end() {
            return Token::Invalid;
        }
    }
    if zone.hour == NONE && time.is_empty() {
        zone.set(0);
    }
    day.iso = true;
    Token::End
}

fn parse_legacy(scanner: &mut Scanner, mut token: Token, day: &mut Day, time: &mut Time, zone: &mut TimeZone) -> bool {
    let mut has_number = !day.is_empty();
    while !token.is_end() {
        if token.is_number() {
            has_number = true;
            let number = token.number();
            if scanner.skip_symbol(b':') {
                if scanner.skip_symbol(b':') {
                    if !time.is_empty() {
                        return false;
                    }
                    time.add(number);
                    time.add(0);
                } else if !time.add(number) {
                    return false;
                } else if scanner.peek().is_symbol(b'.') {
                    scanner.next();
                }
            } else if scanner.skip_symbol(b'.') && time.is_expecting(number) {
                time.add(number);
                if !scanner.peek().is_number() {
                    return false;
                }
                let millis = read_milliseconds(scanner.next());
                time.add_final(millis);
            } else if zone.is_expecting(number) {
                zone.minute = number;
            } else if time.is_expecting(number) {
                time.add_final(number);
                let peek = scanner.peek();
                if !peek.is_end() && !peek.is_white() && !peek.is_keyword_z() && !peek.is_ascii_sign() {
                    return false;
                }
            } else if !day.add(number) {
                return false;
            } else {
                scanner.skip_symbol(b'-');
            }
        } else if token.is_keyword() {
            let (kind, value, _) = token.keyword();
            if kind == Keyword::AmPm && !time.is_empty() {
                time.hour_offset = value;
            } else if kind == Keyword::Month {
                day.named_month = value;
                scanner.skip_symbol(b'-');
            } else if kind == Keyword::Zone && has_number {
                zone.set(value);
            } else if has_number || scanner.peek().is_number() {
                return false;
            }
        } else if token.is_ascii_sign() && (zone.is_utc() || !time.is_empty()) {
            zone.set_sign(token.ascii_sign());
            let mut number = 0;
            let mut length = 0;
            if scanner.peek().is_number() {
                let next = scanner.next();
                length = next.length();
                number = next.number();
            }
            has_number = true;
            if scanner.peek().is_symbol(b':') {
                zone.hour = number;
                zone.minute = NONE;
            } else if length == 1 || length == 2 {
                zone.hour = number;
                zone.minute = 0;
            } else if length == 3 || length == 4 {
                zone.hour = number / 100;
                zone.minute = number % 100;
            } else {
                return false;
            }
        } else if (token.is_ascii_sign() || token.is_symbol(b')')) && has_number {
            return false;
        }
        token = scanner.next();
    }
    true
}

/// Milliseconds since the Unix epoch, or `None` when `Date.parse` is `NaN`
/// or the instant is outside the JavaScript time limit.
pub fn unix_millis(value: &str) -> Option<i64> {
    let mut scanner = Scanner::new(value);
    let mut day = Day::new();
    let mut time = Time::new();
    let mut zone = TimeZone::new();
    let token = parse_es5(&mut scanner, &mut day, &mut time, &mut zone);
    if token.is_invalid() {
        return None;
    }
    if !parse_legacy(&mut scanner, token, &mut day, &mut time, &mut zone) {
        return None;
    }
    let (year, month, day_of_month) = day.write()?;
    let (hour, minute, second, millis) = time.write()?;
    let offset = zone.write()?;
    compose(year, month, day_of_month, hour, minute, second, millis, offset)
}

pub fn canonical_iso(value: &str) -> Option<String> {
    format_iso(unix_millis(value)?)
}

fn compose(
    year: i32,
    month0: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millis: i32,
    offset: Option<i32>,
) -> Option<i64> {
    let day_number = make_day(year, month0, day)?;
    let time_ms = ((i64::from(hour) * 60 + i64::from(minute)) * 60 + i64::from(second)) * 1000 + i64::from(millis);
    let stamped = day_number.checked_mul(86_400_000)?.checked_add(time_ms)?;
    let utc = if let Some(seconds) = offset {
        stamped.checked_sub(i64::from(seconds).checked_mul(1000)?)?
    } else {
        let (y, m, d, h, mi, s, ms) = civil_from_millis(stamped)?;
        local_millis(y, m, d, h, mi, s, ms)?
    };
    if utc.abs() > TIME_CLIP { None } else { Some(utc) }
}

fn format_iso(millis: i64) -> Option<String> {
    if millis.abs() > TIME_CLIP {
        return None;
    }
    let (year, month, day, hour, minute, second, fraction) = civil_from_millis(millis)?;
    let year_text = if (0..10_000).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z"
    ))
}

fn read_milliseconds(token: Token) -> i32 {
    let mut number = token.number();
    let mut length = token.length();
    if length < 3 {
        if length == 1 {
            number *= 100;
        } else if length == 2 {
            number *= 10;
        }
    } else if length > 3 {
        if length > 9 {
            length = 9;
        }
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        number /= factor;
    }
    number
}

fn lookup_keyword(prefix: [u32; 3], length: i32) -> (Keyword, i32) {
    const TABLE: &[( [u32; 3], Keyword, i32 )] = &[
        ([b'j' as u32, b'a' as u32, b'n' as u32], Keyword::Month, 1),
        ([b'f' as u32, b'e' as u32, b'b' as u32], Keyword::Month, 2),
        ([b'm' as u32, b'a' as u32, b'r' as u32], Keyword::Month, 3),
        ([b'a' as u32, b'p' as u32, b'r' as u32], Keyword::Month, 4),
        ([b'm' as u32, b'a' as u32, b'y' as u32], Keyword::Month, 5),
        ([b'j' as u32, b'u' as u32, b'n' as u32], Keyword::Month, 6),
        ([b'j' as u32, b'u' as u32, b'l' as u32], Keyword::Month, 7),
        ([b'a' as u32, b'u' as u32, b'g' as u32], Keyword::Month, 8),
        ([b's' as u32, b'e' as u32, b'p' as u32], Keyword::Month, 9),
        ([b'o' as u32, b'c' as u32, b't' as u32], Keyword::Month, 10),
        ([b'n' as u32, b'o' as u32, b'v' as u32], Keyword::Month, 11),
        ([b'd' as u32, b'e' as u32, b'c' as u32], Keyword::Month, 12),
        ([b'a' as u32, b'm' as u32, 0], Keyword::AmPm, 0),
        ([b'p' as u32, b'm' as u32, 0], Keyword::AmPm, 12),
        ([b'u' as u32, b't' as u32, 0], Keyword::Zone, 0),
        ([b'u' as u32, b't' as u32, b'c' as u32], Keyword::Zone, 0),
        ([b'z' as u32, 0, 0], Keyword::Zone, 0),
        ([b'g' as u32, b'm' as u32, b't' as u32], Keyword::Zone, 0),
        ([b'c' as u32, b'd' as u32, b't' as u32], Keyword::Zone, -5),
        ([b'c' as u32, b's' as u32, b't' as u32], Keyword::Zone, -6),
        ([b'e' as u32, b'd' as u32, b't' as u32], Keyword::Zone, -4),
        ([b'e' as u32, b's' as u32, b't' as u32], Keyword::Zone, -5),
        ([b'm' as u32, b'd' as u32, b't' as u32], Keyword::Zone, -6),
        ([b'm' as u32, b's' as u32, b't' as u32], Keyword::Zone, -7),
        ([b'p' as u32, b'd' as u32, b't' as u32], Keyword::Zone, -7),
        ([b'p' as u32, b's' as u32, b't' as u32], Keyword::Zone, -8),
        ([b't' as u32, 0, 0], Keyword::TimeSep, 0),
    ];
    for (entry, kind, value) in TABLE {
        if prefix == *entry && (length <= 3 || *kind == Keyword::Month) {
            return (*kind, *value);
        }
    }
    (Keyword::Invalid, 0)
}

fn is_minute(value: i32) -> bool {
    (0..=59).contains(&value)
}

fn is_second(value: i32) -> bool {
    (0..=59).contains(&value)
}

fn is_month(value: i32) -> bool {
    (1..=12).contains(&value)
}

fn is_day(value: i32) -> bool {
    (1..=31).contains(&value)
}

/// `Date.parse` whitespace: ECMAScript white space, plus line feed and carriage
/// return. U+2028 and U+2029 stay words, so they reject a date.
fn is_date_space(ch: u32) -> bool {
    is_white_space(ch) || ch == u32::from(b'\n') || ch == u32::from(b'\r')
}

fn is_white_space(ch: u32) -> bool {
    matches!(ch, 0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0x1680 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
        || (0x2000..=0x200A).contains(&ch)
}

fn make_day(year: i32, month0: i32, date: i32) -> Option<i64> {
    let year = i64::from(year).checked_add(i64::from(month0).div_euclid(12))?;
    let month = month0.rem_euclid(12);
    let year = i32::try_from(year).ok()?;
    days_from_civil(year, (month as u32) + 1, 1)?.checked_add(i64::from(date) - 1)
}

fn days_from_civil(mut year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || day == 0 {
        return None;
    }
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u32;
    let day_of_year = (153 * (month as i32 + if month > 2 { -3 } else { 9 }) as u32 + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(i64::from(era) * 146_097 + i64::from(day_of_era) - 719_468)
}

fn civil_from_millis(millis: i64) -> Option<(i32, i32, i32, i32, i32, i32, i32)> {
    let seconds = millis.div_euclid(1000);
    let fraction = millis.rem_euclid(1000) as i32;
    let (year, month, day, hour, minute, second) = civil_from_unix(seconds)?;
    Some((year, month, day, hour, minute, second, fraction))
}

fn civil_from_unix(seconds: i64) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400) as i32;
    let (year, month, day) = civil_from_days(days)?;
    Some((year, month, day, day_seconds / 3600, (day_seconds % 3600) / 60, day_seconds % 60))
}

fn civil_from_days(days: i64) -> Option<(i32, i32, i32)> {
    let shifted = days.checked_add(719_468)?;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u32;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era as i32 + era as i32 * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 { month_part + 3 } else { month_part - 9 };
    Some((year + i32::from(month <= 2), month as i32, day as i32))
}

fn unix_from_utc(year: i32, month: i32, day: i32, hour: i32, minute: i32, second: i32) -> Option<i64> {
    let days = days_from_civil(year, month as u32, day as u32)?;
    days.checked_mul(86_400)?.checked_add(i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second))
}

fn local_millis(year: i32, month: i32, day: i32, hour: i32, minute: i32, second: i32, millis: i32) -> Option<i64> {
    let (year, month, day, hour, minute, second) = local_civil_to_utc(year, month, day, hour, minute, second)?;
    unix_from_utc(year, month, day, hour, minute, second)?.checked_mul(1000)?.checked_add(i64::from(millis))
}

fn local_civil_to_utc(year: i32, month: i32, day: i32, hour: i32, minute: i32, second: i32) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let mut earliest = None;
    for isdst in [0, 1] {
        let Some(utc) = mktime_local(year, month, day, hour, minute, second, isdst) else {
            continue;
        };
        if local_civil_is(utc, year, month, day, hour, minute, second) {
            earliest = Some(earliest.map_or(utc, |current: i64| current.min(utc)));
        }
    }
    let utc = if let Some(utc) = earliest {
        utc
    } else {
        mktime_local(year, month, day, hour, minute, second, -1)?
    };
    civil_from_unix(utc)
}

fn mktime_local(year: i32, month: i32, day: i32, hour: i32, minute: i32, second: i32, isdst: i32) -> Option<i64> {
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    tm.tm_year = year - 1900;
    tm.tm_mon = month - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = minute;
    tm.tm_sec = second;
    tm.tm_isdst = isdst;
    let previous = std::io::Error::last_os_error();
    unsafe { *libc::__errno_location() = 0 };
    let result = unsafe { libc::mktime(&mut tm) };
    let failed = result == -1 && std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0;
    unsafe { *libc::__errno_location() = previous.raw_os_error().unwrap_or(0) };
    if failed { None } else { Some(result as i64) }
}

fn local_civil_is(utc: i64, year: i32, month: i32, day: i32, hour: i32, minute: i32, second: i32) -> bool {
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    let seconds = utc as libc::time_t;
    unsafe {
        if libc::localtime_r(&seconds, &mut tm).is_null() {
            return false;
        }
    }
    tm.tm_year == year - 1900
        && tm.tm_mon == month - 1
        && tm.tm_mday == day
        && tm.tm_hour == hour
        && tm.tm_min == minute
        && tm.tm_sec == second
}
