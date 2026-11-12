//! `new Date(ms).toISOString()`.

use crate::utc_date_parts;

const MS_PER_DAY: i64 = 86_400_000;

/// `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`, the year as
/// `+YYYYYY` or `-YYYYYY` outside 0..=9999. `None` where JavaScript throws
/// `RangeError: Invalid time value` (NaN, an infinity, or beyond 8.64e15).
pub fn to_iso_string(ms: f64) -> Option<String> {
    let (year, month, day) = utc_date_parts(ms)?;
    // utc_date_parts accepted ms, so it is finite and within a Date's range
    let time = ms.trunc() as i64;
    let in_day = time.rem_euclid(MS_PER_DAY);
    let (hour, minute, second, milli) = (
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000,
    );
    let year = year as i64;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    Some(format!(
        "{year}-{:02}-{:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z",
        month as i64 + 1,
        day as i64
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each expected value is what Node 22 answers for the same `new Date(ms)`.
    #[test]
    fn writes_iso_strings() {
        assert_eq!(
            to_iso_string(-1.0).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            to_iso_string(-62_198_755_200_000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(253_402_300_800_000.0).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(to_iso_string(f64::NAN), None);
    }
}
