//! `packages/ai-provider/src/free-ai.ts`: what an error's text says about the
//! free tier of a provider (`isFreeTierModelRefusal`, `freeLimitOf`). The
//! screens' helpers of the same file (the connection card, the quota
//! readers) are not ported.

use super::jsval::{thrown_cause, thrown_message};
use jscompat::{JsonValue, js_regex, to_number};

/// Midnight in Pacific time after `now`, when the Gemini API's per-day quotas
/// reset. The offset of `America/Los_Angeles` is computed from the US rules
/// of 1967 on (a period no `now` of this product precedes); an earlier
/// instant is read as standard time.
pub fn next_pacific_midnight(now: f64) -> f64 {
    let seconds = (now / 1000.0).floor();
    let offset = los_angeles_offset_seconds(seconds);
    // the formatted clock: whole seconds of the Pacific day
    let local = seconds + offset;
    let elapsed_seconds = local.rem_euclid(86_400.0);
    let elapsed = elapsed_seconds * 1000.0;
    let day = 24.0 * 60.0 * 60.0 * 1000.0;
    // whole seconds: the formatted clock has no milliseconds
    seconds * 1000.0 - elapsed + day
}

/// Days from 1970-01-01 of a civil date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil year of a day count.
fn year_of_days(days: i64) -> i64 {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    if mp >= 10 { y + 1 } else { y }
}

/// 0 = Sunday
fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

/// The `n`th (1-based) Sunday of a month.
fn nth_sunday(year: i64, month: i64, n: i64) -> i64 {
    let first = days_from_civil(year, month, 1);
    first + (7 - weekday(first)) % 7 + (n - 1) * 7
}

/// The last Sunday of a month.
fn last_sunday(year: i64, month: i64) -> i64 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let last = days_from_civil(ny, nm, 1) - 1;
    last - weekday(last)
}

/// The UTC offset of `America/Los_Angeles` at `seconds` since the epoch.
fn los_angeles_offset_seconds(seconds: f64) -> f64 {
    const PST: f64 = -8.0 * 3600.0;
    const PDT: f64 = -7.0 * 3600.0;
    if !seconds.is_finite() {
        return PST;
    }
    let days = (seconds / 86_400.0).floor() as i64;
    let year = year_of_days(days);
    if year < 1967 {
        return PST;
    }
    // transitions at 02:00 local: 10:00 UTC into DST, 09:00 UTC out of it
    let (start, end) = match year {
        1974 => (days_from_civil(1974, 1, 6), last_sunday(1974, 10)),
        1975 => (days_from_civil(1975, 2, 23), last_sunday(1975, 10)),
        1967..=1986 => (last_sunday(year, 4), last_sunday(year, 10)),
        1987..=2006 => (nth_sunday(year, 4, 1), last_sunday(year, 10)),
        _ => (nth_sunday(year, 3, 2), nth_sunday(year, 11, 1)),
    };
    let start_utc = (start * 86_400 + 10 * 3600) as f64;
    let end_utc = (end * 86_400 + 9 * 3600) as f64;
    if seconds >= start_utc && seconds < end_utc {
        PDT
    } else {
        PST
    }
}

fn error_texts(err: &JsonValue) -> Vec<String> {
    let mut texts = Vec::new();
    let mut current: Option<&JsonValue> = Some(err);
    let mut depth = 0;
    while let Some(value) = current.filter(|c| c.truthy()) {
        if depth >= 5 {
            break;
        }
        if let JsonValue::String(text) = value {
            texts.push(text.clone());
            break;
        }
        if let Some(JsonValue::String(message)) = thrown_message(value) {
            texts.push(message);
        }
        current = thrown_cause(value);
        depth += 1;
    }
    texts
}

/// `isFreeTierModelRefusal(err)`: a run refused because the key is on a free
/// tier that has no allowance for the chosen model at all: Gemini answers a
/// Pro model on a free key with a free-tier quota of 0.
pub fn is_free_tier_model_refusal(err: &JsonValue) -> bool {
    // Gemini: the same free-tier quota, but with no allowance at all for this model
    let free_tier = js_regex!(r"FreeTier|free_tier", "i");
    let zero_quota = js_regex!(r#"\blimit:\s*0\b|"quotaValue":\s*"0""#, "i");
    error_texts(err)
        .iter()
        .any(|text| free_tier.test(text) && zero_quota.test(text))
}

/// What `freeLimitOf` answers when the failure is a used-up free allowance:
/// `{}` or `{ resetsAt }`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FreeLimit {
    pub resets_at: Option<f64>,
}

/// `freeLimitOf(err, now)`: a run that failed because today's free allowance
/// is used up, with the time it resets when that can be known; `None` for any
/// other failure.
pub fn free_limit_of(err: &JsonValue, now: f64) -> Option<FreeLimit> {
    // OpenRouter: "Rate limit exceeded: free-models-per-day. ..."
    let openrouter_daily = js_regex!(r"free-models-per-day", "i");
    // Gemini: RESOURCE_EXHAUSTED naming a per-day quota of the free tier
    let gemini_daily = js_regex!(r"PerDay[\w-]*FreeTier|FreeTier[\w-]*PerDay", "i");
    // OpenRouter repeats its rate-limit headers in the error body's metadata
    let openrouter_reset = js_regex!(r#"X-RateLimit-Reset\\?"?\s*:\s*\\?"?(\d{10,13})"#, "i");
    // a model the free tier does not serve: waiting for the reset would not help
    if is_free_tier_model_refusal(err) {
        return None;
    }
    for text in error_texts(err) {
        if openrouter_daily.test(&text) {
            let Some(reset) = openrouter_reset.exec(&text).and_then(|m| m.get(1)) else {
                return Some(FreeLimit { resets_at: None });
            };
            let at = to_number(reset) * if reset.len() == 10 { 1000.0 } else { 1.0 };
            return Some(FreeLimit {
                resets_at: (at.is_finite() && at > now).then_some(at),
            });
        }
        if gemini_daily.test(&text) {
            return Some(FreeLimit {
                resets_at: Some(next_pacific_midnight(now)),
            });
        }
    }
    None
}
