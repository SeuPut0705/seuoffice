//! packages/file-parse/src/xlsx-dates.ts.

use jscompat::{js_regex, math_round, number_to_string, pad_start};
use ooxml_pkg::write::UtcDate;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateFormatParts {
    pub date: bool,
    pub time: bool,
    pub seconds: bool,
    pub elapsed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_unit: Option<char>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_minutes: Option<bool>,
}

impl DateFormatParts {
    const fn plain(date: bool, time: bool, seconds: bool) -> Self {
        Self {
            date,
            time,
            seconds,
            elapsed: false,
            elapsed_unit: None,
            elapsed_minutes: None,
        }
    }
}

pub fn builtin_date_format(id: f64) -> Option<DateFormatParts> {
    let date = [
        14., 15., 16., 17., 27., 28., 29., 30., 31., 34., 35., 36., 50., 51., 52., 53., 54., 55.,
        56., 57., 58.,
    ];
    if date.contains(&id) {
        Some(DateFormatParts::plain(true, false, false))
    } else if [18., 20., 32.].contains(&id) {
        Some(DateFormatParts::plain(false, true, false))
    } else if [19., 21., 33., 45., 47.].contains(&id) {
        Some(DateFormatParts::plain(false, true, true))
    } else if id == 22. {
        Some(DateFormatParts::plain(true, true, false))
    } else if id == 46. {
        Some(DateFormatParts {
            elapsed: true,
            elapsed_unit: Some('h'),
            ..DateFormatParts::plain(false, true, true)
        })
    } else {
        None
    }
}

fn first_format_section_tokens(code: &str) -> String {
    let mut quoted = false;
    let mut tokens = String::new();
    let mut chars = code.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' || (!quoted && matches!(ch, '_' | '*')) {
            chars.next();
        } else if ch == '"' {
            quoted = !quoted;
        } else if ch == ';' && !quoted {
            return tokens;
        } else if !quoted {
            tokens.push(ch);
        }
    }
    tokens
}

pub fn classify_format_code(code: &str) -> Option<DateFormatParts> {
    let section = first_format_section_tokens(code);
    if js_regex!("general", "i").test(&section)
        && !js_regex!("[ydhs]", "i")
            .test(&js_regex!("general", "i").replace_all(&section, |_| String::new()))
    {
        return None;
    }
    let mut elapsed = false;
    let mut elapsed_minutes = false;
    let mut elapsed_unit = None;
    let stripped = js_regex!(r"\[(h+|m+|s+)\]", "i").replace_all(&section, |m| {
        let token = m.get(1).unwrap_or_default();
        elapsed = true;
        elapsed_unit =
            elapsed_unit.or_else(|| token.chars().next().map(|c| c.to_ascii_lowercase()));
        if js_regex!("^m", "i").test(token) {
            elapsed_minutes = true;
        }
        token.to_owned()
    });
    let stripped = js_regex!(r"\[[^\]]*\]")
        .replace_all(&stripped, |_| String::new())
        .to_lowercase();
    let has_am_pm = js_regex!("am/pm|a/p").test(&stripped);
    let body = js_regex!("am/pm|a/p").replace_all(&stripped, |_| String::new());
    let has_y = body.contains('y');
    let has_d = body.contains('d');
    let has_h = body.contains('h') || has_am_pm;
    let has_s = body.contains('s');
    let has_m = body.contains('m');
    if !(has_y || has_d || has_h || has_s || has_m) {
        return None;
    }
    let minute_m =
        has_m && (elapsed_minutes || js_regex!(r"h\s*[:.\-/]?\s*m|m\s*[:.\-/]?\s*s").test(&body));
    let date = has_y || has_d || (has_m && !minute_m);
    let time = has_h || has_s || minute_m || elapsed;
    if !date && !time {
        return None;
    }
    Some(DateFormatParts {
        date,
        time,
        seconds: has_s,
        elapsed: elapsed && !date,
        elapsed_unit: if elapsed && !date { elapsed_unit } else { None },
        elapsed_minutes: if elapsed && !date && elapsed_unit == Some('h') {
            Some(minute_m)
        } else {
            None
        },
    })
}

fn pad(n: f64, width: usize) -> String {
    pad_start(&number_to_string(n), width, '0')
}

pub fn format_serial(serial: f64, parts: &DateFormatParts, date_1904: bool) -> Option<String> {
    if !serial.is_finite() {
        return None;
    }
    if parts.elapsed {
        if serial < 0. {
            return None;
        }
        let total = math_round(serial * 86400.);
        if parts.elapsed_unit == Some('m') {
            let mm = (total / 60.).floor();
            return Some(if parts.seconds {
                format!("{}:{}", number_to_string(mm), pad(total % 60., 2))
            } else {
                number_to_string(mm)
            });
        }
        if parts.elapsed_unit == Some('s') {
            return Some(number_to_string(total));
        }
        let h = (total / 3600.).floor();
        if parts.elapsed_minutes == Some(false) {
            return Some(number_to_string(h));
        }
        let m = ((total % 3600.) / 60.).floor();
        if !parts.seconds {
            return Some(format!("{}:{}", number_to_string(h), pad(m, 2)));
        }
        return Some(format!(
            "{}:{}:{}",
            number_to_string(h),
            pad(m, 2),
            pad(total % 60., 2)
        ));
    }
    if serial < 0. {
        return None;
    }
    let mut days = serial.floor();
    let mut secs = if parts.time {
        math_round((serial - days) * 86400.)
    } else {
        0.
    };
    if secs >= 86400. {
        days += 1.;
        secs = 0.;
    }
    let time_text = if parts.time {
        let mut result = format!(
            "{}:{}",
            pad((secs / 3600.).floor(), 2),
            pad(((secs % 3600.) / 60.).floor(), 2)
        );
        if parts.seconds {
            result.push(':');
            result.push_str(&pad(secs % 60., 2));
        }
        result
    } else {
        String::new()
    };
    if !parts.date {
        return Some(time_text);
    }
    let date_text = if !date_1904 && days == 60. {
        "1900-02-29".to_owned()
    } else {
        if !date_1904 && days == 0. {
            return None;
        }
        // 9999-12-31 is the last day the calendar represents
        if days > 2958465. {
            return None;
        }
        let epoch = if date_1904 {
            -2082844800000.
        } else {
            -2209161600000.
        };
        let shift = if !date_1904 && days < 60. { 1. } else { 0. };
        let time = epoch + (days + shift) * 86400000.;
        // `Number.isNaN(d.getTime())`
        let utc = (time.abs() <= 8.64e15)
            .then(|| UtcDate::from_time_value(time))
            .flatten()?;
        format!(
            "{}-{}-{}",
            pad(utc.year as f64, 4),
            pad(utc.month as f64, 2),
            pad(utc.day as f64, 2)
        )
    };
    Some(if time_text.is_empty() {
        date_text
    } else {
        format!("{date_text} {time_text}")
    })
}
