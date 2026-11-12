//! `Date.parse`, as V8 12.4 answers it (moved from `docx-engine/src/revision_xml.rs`).

use crate::is_js_space;

/// `Date.parse(text)` as V8 12.4 answers it: `ParseDateTimeString` of
/// src/builtins/builtins-date.cc over the parser of src/date/dateparser*.
/// A date and time without a zone is local time there; here it is read as UTC.
pub fn date_parse(text: &str) -> f64 {
    const MAX_TIME_IN_MS: f64 = 8.64e15;
    const MAX_TIME_BEFORE_UTC_IN_MS: f64 = MAX_TIME_IN_MS + 86_400_000.0 * 30.0;
    let Some(fields) = parse_date_fields(text) else {
        return f64::NAN;
    };
    let day = make_day(fields.year, fields.month, fields.day);
    let time = f64::from(fields.hour) * 3_600_000.0
        + f64::from(fields.minute) * 60_000.0
        + f64::from(fields.second) * 1000.0
        + f64::from(fields.millisecond);
    let mut date = if day.is_finite() {
        time + day * 86_400_000.0
    } else {
        f64::NAN
    };
    match fields.utc_offset {
        // DateCache::ToUTC with a zero offset
        None => {
            if !(-MAX_TIME_BEFORE_UTC_IN_MS..=MAX_TIME_BEFORE_UTC_IN_MS).contains(&date) {
                return f64::NAN;
            }
        }
        Some(offset) => date -= f64::from(offset) * 1000.0,
    }
    // TimeClip
    if (-MAX_TIME_IN_MS..=MAX_TIME_IN_MS).contains(&date) {
        date.trunc()
    } else {
        f64::NAN
    }
}

/// MakeDay of src/date/date.cc, the month 0-based.
fn make_day(year: i32, month: i32, day: i32) -> f64 {
    const YEAR_DELTA: i64 = 399_999;
    if !(-1_000_000..=1_000_000).contains(&year) || !(-10_000_000..=10_000_000).contains(&month) {
        return f64::NAN;
    }
    let mut y = i64::from(year);
    let mut m = i64::from(month);
    y += m / 12;
    m %= 12;
    if m < 0 {
        m += 12;
        y -= 1;
    }
    let days_before = |y: i64| {
        365 * (y + YEAR_DELTA) + (y + YEAR_DELTA) / 4 - (y + YEAR_DELTA) / 100
            + (y + YEAR_DELTA) / 400
    };
    let mut day_from_year = days_before(y) - days_before(1970);
    const COMMON: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const LEAP: [i64; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    let table = if y % 4 != 0 || (y % 100 == 0 && y % 400 != 0) {
        &COMMON
    } else {
        &LEAP
    };
    day_from_year += table[usize::try_from(m).unwrap_or(0)];
    (day_from_year - 1) as f64 + f64::from(day)
}

struct DateFields {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millisecond: i32,
    utc_offset: Option<i32>,
}

/// kNone
const NONE: i32 = i32::MAX;
/// kMaxSignificantDigits
const MAX_SIGNIFICANT_DIGITS: usize = 9;

fn between(x: i32, lo: i32, hi: i32) -> bool {
    (x.wrapping_sub(lo) as u32) <= (hi.wrapping_sub(lo) as u32)
}

fn is_minute(x: i32) -> bool {
    between(x, 0, 59)
}

fn is_hour(x: i32) -> bool {
    between(x, 0, 23)
}

fn is_month(x: i32) -> bool {
    between(x, 1, 12)
}

fn is_day(x: i32) -> bool {
    between(x, 1, 31)
}

/// IsWhiteSpace of V8: Zs, TAB, VT, FF, U+FEFF; no line terminator.
fn is_white_space(unit: u32) -> bool {
    !matches!(unit, 0x0A | 0x0D | 0x2028 | 0x2029) && char::from_u32(unit).is_some_and(is_js_space)
}

/// IsWhiteSpaceOrLineTerminator of V8
fn is_white_space_or_line_terminator(unit: u32) -> bool {
    char::from_u32(unit).is_some_and(is_js_space)
}

/// InputReader: the text as UTF-16 code units; a NUL ends it.
struct InputReader<'t> {
    units: std::str::EncodeUtf16<'t>,
    index: usize,
    ch: u32,
}

impl<'t> InputReader<'t> {
    fn new(text: &'t str) -> Self {
        let mut reader = Self {
            units: text.encode_utf16(),
            index: 0,
            ch: 0,
        };
        reader.next();
        reader
    }

    fn next(&mut self) {
        self.ch = self.units.next().map_or(0, u32::from);
        self.index += 1;
    }

    fn is_digit(&self) -> bool {
        (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch)
    }

    fn read_unsigned_numeral(&mut self) -> i32 {
        let mut n: i32 = 0;
        let mut i = 0;
        while self.ch == u32::from(b'0') {
            self.next();
        }
        while self.is_digit() {
            if i < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + (self.ch - u32::from(b'0')) as i32;
            }
            i += 1;
            self.next();
        }
        n
    }

    fn read_word(&mut self, prefix: &mut [u32; 3]) -> usize {
        let mut length = 0;
        while self.ch >= u32::from(b'A') && !is_white_space(self.ch) {
            if let Some(slot) = prefix.get_mut(length) {
                *slot = self.ch | 0x20;
            }
            self.next();
            length += 1;
        }
        length
    }

    fn skip(&mut self, c: u8) -> bool {
        if self.ch == u32::from(c) {
            self.next();
            return true;
        }
        false
    }

    fn skip_white_space(&mut self) -> bool {
        if is_white_space_or_line_terminator(self.ch) {
            self.next();
            return true;
        }
        false
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.ch != u32::from(b'(') {
            return false;
        }
        let mut balance: i64 = 0;
        loop {
            if self.ch == u32::from(b')') {
                balance -= 1;
            } else if self.ch == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if !(balance > 0 && self.ch != 0) {
                break;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeywordType {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

/// KeywordTable
const KEYWORDS: [([u8; 3], KeywordType, i32); 27] = [
    (*b"jan", KeywordType::MonthName, 1),
    (*b"feb", KeywordType::MonthName, 2),
    (*b"mar", KeywordType::MonthName, 3),
    (*b"apr", KeywordType::MonthName, 4),
    (*b"may", KeywordType::MonthName, 5),
    (*b"jun", KeywordType::MonthName, 6),
    (*b"jul", KeywordType::MonthName, 7),
    (*b"aug", KeywordType::MonthName, 8),
    (*b"sep", KeywordType::MonthName, 9),
    (*b"oct", KeywordType::MonthName, 10),
    (*b"nov", KeywordType::MonthName, 11),
    (*b"dec", KeywordType::MonthName, 12),
    (*b"am\0", KeywordType::AmPm, 0),
    (*b"pm\0", KeywordType::AmPm, 12),
    (*b"ut\0", KeywordType::TimeZoneName, 0),
    (*b"utc", KeywordType::TimeZoneName, 0),
    (*b"z\0\0", KeywordType::TimeZoneName, 0),
    (*b"gmt", KeywordType::TimeZoneName, 0),
    (*b"cdt", KeywordType::TimeZoneName, -5),
    (*b"cst", KeywordType::TimeZoneName, -6),
    (*b"edt", KeywordType::TimeZoneName, -4),
    (*b"est", KeywordType::TimeZoneName, -5),
    (*b"mdt", KeywordType::TimeZoneName, -6),
    (*b"mst", KeywordType::TimeZoneName, -7),
    (*b"pdt", KeywordType::TimeZoneName, -7),
    (*b"pst", KeywordType::TimeZoneName, -8),
    (*b"t\0\0", KeywordType::TimeSeparator, 0),
];

/// KeywordTable::Lookup: a word longer than a keyword names only a month.
fn lookup_keyword(prefix: &[u32; 3], length: usize) -> (KeywordType, i32) {
    KEYWORDS
        .iter()
        .find(|(word, kind, _)| {
            word.iter().zip(prefix).all(|(&w, &p)| u32::from(w) == p)
                && (length <= 3 || *kind == KeywordType::MonthName)
        })
        .map_or((KeywordType::Invalid, 0), |&(_, kind, value)| (kind, value))
}

/// DateToken
#[derive(Debug, Clone, Copy)]
enum DateToken {
    Invalid,
    Unknown,
    WhiteSpace,
    Number {
        value: i32,
        length: usize,
    },
    Symbol(u8),
    EndOfInput,
    Keyword {
        kind: KeywordType,
        value: i32,
        length: usize,
    },
}

impl DateToken {
    fn is_number(self) -> bool {
        matches!(self, Self::Number { .. })
    }

    fn number(self) -> i32 {
        match self {
            Self::Number { value, .. } => value,
            _ => 0,
        }
    }

    fn is_symbol(self, symbol: u8) -> bool {
        matches!(self, Self::Symbol(s) if s == symbol)
    }

    fn is_fixed_length_number(self, wanted: usize) -> bool {
        matches!(self, Self::Number { length, .. } if length == wanted)
    }

    fn is_ascii_sign(self) -> bool {
        self.is_symbol(b'+') || self.is_symbol(b'-')
    }

    /// 1 for '+', -1 for '-'
    fn ascii_sign(self) -> i32 {
        if self.is_symbol(b'-') { -1 } else { 1 }
    }

    fn is_keyword_type(self, wanted: KeywordType) -> bool {
        matches!(self, Self::Keyword { kind, .. } if kind == wanted)
    }

    fn is_keyword_z(self) -> bool {
        matches!(
            self,
            Self::Keyword {
                kind: KeywordType::TimeZoneName,
                value: 0,
                length: 1
            }
        )
    }

    fn is_end_of_input(self) -> bool {
        matches!(self, Self::EndOfInput)
    }
}

/// DateStringTokenizer
struct DateStringTokenizer<'t> {
    input: InputReader<'t>,
    next: DateToken,
}

impl<'t> DateStringTokenizer<'t> {
    fn new(text: &'t str) -> Self {
        let mut input = InputReader::new(text);
        let next = Self::scan(&mut input);
        Self { input, next }
    }

    fn next(&mut self) -> DateToken {
        let result = self.next;
        self.next = Self::scan(&mut self.input);
        result
    }

    fn peek(&self) -> DateToken {
        self.next
    }

    fn skip_symbol(&mut self, symbol: u8) -> bool {
        if self.next.is_symbol(symbol) {
            self.next = Self::scan(&mut self.input);
            return true;
        }
        false
    }

    fn scan(input: &mut InputReader<'_>) -> DateToken {
        let pre_pos = input.index;
        if input.ch == 0 {
            return DateToken::EndOfInput;
        }
        if input.is_digit() {
            let value = input.read_unsigned_numeral();
            return DateToken::Number {
                value,
                length: input.index - pre_pos,
            };
        }
        for &symbol in b":-+.)" {
            if input.skip(symbol) {
                return DateToken::Symbol(symbol);
            }
        }
        if input.ch >= u32::from(b'A') && !is_white_space(input.ch) {
            let mut prefix = [0u32; 3];
            let length = input.read_word(&mut prefix);
            let (kind, value) = lookup_keyword(&prefix, length);
            return DateToken::Keyword {
                kind,
                value,
                length,
            };
        }
        if input.skip_white_space() {
            return DateToken::WhiteSpace;
        }
        if input.skip_parentheses() {
            return DateToken::Unknown;
        }
        input.next();
        DateToken::Unknown
    }
}

/// ReadMilliseconds: the first three significant digits of the numeral.
fn read_milliseconds(token: DateToken) -> i32 {
    let DateToken::Number { value, length } = token else {
        return 0;
    };
    let mut number = value;
    if length < 3 {
        if length == 1 {
            number *= 100;
        } else if length == 2 {
            number *= 10;
        }
    } else if length > 3 {
        let mut length = length.min(MAX_SIGNIFICANT_DIGITS);
        let mut factor = 1;
        loop {
            factor *= 10;
            length -= 1;
            if length <= 3 {
                break;
            }
        }
        number /= factor;
    }
    number
}

/// TimeZoneComposer
struct TimeZoneComposer {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }

    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }

    fn is_expecting(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(n)
    }

    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }

    fn is_empty(&self) -> bool {
        self.hour == NONE
    }

    /// The offset in seconds, `Some(None)` without a zone, `None` where it fails.
    fn write(&self) -> Option<Option<i32>> {
        if self.sign == NONE {
            return Some(None);
        }
        let hour = if self.hour == NONE { 0 } else { self.hour };
        let minute = if self.minute == NONE { 0 } else { self.minute };
        let total = (hour as u32)
            .wrapping_mul(3600)
            .wrapping_add((minute as u32).wrapping_mul(60));
        // Smi::kMaxValue of a 64-bit build without pointer compression
        let total = i32::try_from(total).ok()?;
        Some(Some(if self.sign < 0 { -total } else { total }))
    }
}

/// TimeComposer
struct TimeComposer {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn is_expecting(&self, n: i32) -> bool {
        (self.index == 1 && is_minute(n))
            || (self.index == 2 && between(n, 0, 59))
            || (self.index == 3 && between(n, 0, 999))
    }

    fn add(&mut self, n: i32) -> bool {
        let Some(slot) = self.comp.get_mut(self.index) else {
            return false;
        };
        *slot = n;
        self.index += 1;
        true
    }

    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        true
    }

    fn write(&mut self) -> Option<[i32; 4]> {
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, millisecond] = self.comp;
        if self.hour_offset != NONE {
            if !between(hour, 0, 12) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        if !is_hour(hour)
            || !is_minute(minute)
            || !between(second, 0, 59)
            || !between(millisecond, 0, 999)
        {
            // A 24th hour is allowed if minutes, seconds, and milliseconds are 0
            if hour != 24 || minute != 0 || second != 0 || millisecond != 0 {
                return None;
            }
        }
        Some([hour, minute, second, millisecond])
    }
}

/// DayComposer
struct DayComposer {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    is_iso_date: bool,
}

impl DayComposer {
    fn is_empty(&self) -> bool {
        self.index == 0
    }

    fn add(&mut self, n: i32) -> bool {
        let Some(slot) = self.comp.get_mut(self.index) else {
            return false;
        };
        *slot = n;
        self.index += 1;
        true
    }

    /// Year, 0-based month, day.
    fn write(&mut self) -> Option<[i32; 3]> {
        if self.index < 1 {
            return None;
        }
        // Day and month default to 1.
        while self.index < 3 {
            self.comp[self.index] = 1;
            self.index += 1;
        }
        let mut year = 0;
        let month;
        let day;
        if self.named_month == NONE {
            if self.is_iso_date || (self.index == 3 && !is_day(self.comp[0])) {
                year = self.comp[0];
                month = self.comp[1];
                day = self.comp[2];
            } else {
                month = self.comp[0];
                day = self.comp[1];
                if self.index == 3 {
                    year = self.comp[2];
                }
            }
        } else {
            month = self.named_month;
            if self.index == 1 {
                day = self.comp[0];
            } else if !is_day(self.comp[0]) {
                year = self.comp[0];
                day = self.comp[1];
            } else {
                day = self.comp[0];
                year = self.comp[1];
            }
        }
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        // a year of at most nine digits is always a Smi
        if !is_month(month) || !is_day(day) {
            return None;
        }
        Some([year, month - 1, day])
    }
}

/// DateParser::Parse
fn parse_date_fields(text: &str) -> Option<DateFields> {
    let mut scanner = DateStringTokenizer::new(text);
    let mut tz = TimeZoneComposer {
        sign: NONE,
        hour: NONE,
        minute: NONE,
    };
    let mut time = TimeComposer {
        comp: [0; 4],
        index: 0,
        hour_offset: NONE,
    };
    let mut day = DayComposer {
        comp: [0; 3],
        index: 0,
        named_month: NONE,
        is_iso_date: false,
    };
    let next_unhandled_token = parse_es5_date_time(&mut scanner, &mut day, &mut time, &mut tz);
    if matches!(next_unhandled_token, DateToken::Invalid) {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    let mut token = next_unhandled_token;
    while !token.is_end_of_input() {
        match token {
            DateToken::Number { value: n, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        if !time.add(n) {
                            return None;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    time.add(n);
                    if !scanner.peek().is_number() {
                        return None;
                    }
                    let ms = read_milliseconds(scanner.next());
                    if ms < 0 {
                        return None;
                    }
                    time.add_final(ms);
                } else if tz.is_expecting(n) {
                    tz.minute = n;
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    let peek = scanner.peek();
                    if !peek.is_end_of_input()
                        && !matches!(peek, DateToken::WhiteSpace)
                        && !peek.is_keyword_z()
                        && !peek.is_ascii_sign()
                    {
                        return None;
                    }
                } else {
                    if !day.add(n) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            DateToken::Keyword { kind, value, .. } => {
                if kind == KeywordType::AmPm && !time.is_empty() {
                    time.hour_offset = value;
                } else if kind == KeywordType::MonthName {
                    day.named_month = value;
                    scanner.skip_symbol(b'-');
                } else if kind == KeywordType::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    // Garbage words are illegal if a number has been read.
                    if has_read_number {
                        return None;
                    }
                    // The first number has to be separated from garbage words.
                    if scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            _ if token.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) => {
                tz.set_sign(token.ascii_sign());
                let mut n = 0;
                let mut length = 0;
                if scanner.peek().is_number()
                    && let DateToken::Number { value, length: l } = scanner.next()
                {
                    n = value;
                    length = l;
                }
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = n;
                    tz.minute = NONE;
                } else if length == 2 || length == 1 {
                    tz.hour = n;
                    tz.minute = 0;
                } else if length == 4 || length == 3 {
                    tz.hour = n / 100;
                    tz.minute = n % 100;
                } else {
                    return None;
                }
            }
            _ if (token.is_ascii_sign() || token.is_symbol(b')')) && has_read_number => {
                return None;
            }
            _ => {}
        }
        token = scanner.next();
    }
    let [year, month, day] = day.write()?;
    let [hour, minute, second, millisecond] = time.write()?;
    let utc_offset = tz.write()?;
    Some(DateFields {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
        utc_offset,
    })
}

/// ParseES5DateTime: the token the legacy parser goes on with,
/// `EndOfInput` when done, `Invalid` when the text cannot be a date.
fn parse_es5_date_time(
    scanner: &mut DateStringTokenizer<'_>,
    day: &mut DayComposer,
    time: &mut TimeComposer,
    tz: &mut TimeZoneComposer,
) -> DateToken {
    if scanner.peek().is_ascii_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        day.add(scanner.next().number());
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol(b'-') {
        if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().number()) {
            return scanner.next();
        }
        day.add(scanner.next().number());
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().number()) {
                return scanner.next();
            }
            day.add(scanner.next().number());
        }
    }
    if !scanner.peek().is_keyword_type(KeywordType::TimeSeparator) {
        if !scanner.peek().is_end_of_input() {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
            return DateToken::Invalid;
        }
        // Allow 24:00[:00[.000]], but no other time starting with 24.
        let hour_is_24 = scanner.peek().number() == 24;
        time.add(scanner.next().number());
        if !scanner.skip_symbol(b':') {
            return DateToken::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !is_minute(scanner.peek().number())
            || (hour_is_24 && scanner.peek().number() > 0)
        {
            return DateToken::Invalid;
        }
        time.add(scanner.next().number());
        if scanner.skip_symbol(b':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !between(scanner.peek().number(), 0, 59)
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return DateToken::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b'.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                    return DateToken::Invalid;
                }
                // Allow more or less than the mandated three digits.
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if scanner.peek().is_symbol(b'+') || scanner.peek().is_symbol(b'-') {
            tz.set_sign(if scanner.next().is_symbol(b'+') {
                1
            } else {
                -1
            });
            if scanner.peek().is_fixed_length_number(4) {
                // hhmm extension syntax.
                let hourmin = scanner.next().number();
                let hour = hourmin / 100;
                let min = hourmin % 100;
                if !is_hour(hour) || !is_minute(min) {
                    return DateToken::Invalid;
                }
                tz.hour = hour;
                tz.minute = min;
            } else {
                // hh:mm standard syntax.
                if !scanner.peek().is_fixed_length_number(2) || !is_hour(scanner.peek().number()) {
                    return DateToken::Invalid;
                }
                tz.hour = scanner.next().number();
                if !scanner.skip_symbol(b':') {
                    return DateToken::Invalid;
                }
                if !scanner.peek().is_fixed_length_number(2) || !is_minute(scanner.peek().number())
                {
                    return DateToken::Invalid;
                }
                tz.minute = scanner.next().number();
            }
        }
        if !scanner.peek().is_end_of_input() {
            return DateToken::Invalid;
        }
    }
    // A date-only form without a zone is UTC, a date-time form local time.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    DateToken::EndOfInput
}
