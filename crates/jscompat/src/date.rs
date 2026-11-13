//! `Date`: a time value read back with `getUTCFullYear`, `getUTCMonth` and
//! `getUTCDate`.

const MS_PER_DAY: i64 = 86_400_000;
/// The largest time value a `Date` holds, in either direction.
const MAX_TIME: f64 = 8.64e15;

/// `TimeClip(ms)`: `None` for an invalid date (NaN, an infinity, or beyond
/// 8.64e15 either way), else the time truncated toward zero.
fn time_clip(ms: f64) -> Option<i64> {
    if !ms.is_finite() || ms.abs() > MAX_TIME {
        return None;
    }
    // |ms| <= 8.64e15 < 2^63: the truncated value fits
    Some(ms.trunc() as i64)
}

/// `[d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]` of `new
/// Date(ms)`; `None` where the date is invalid and each of them is NaN.
/// The month counts from 0.
pub fn utc_date_parts(ms: f64) -> Option<(f64, f64, f64)> {
    let time = time_clip(ms)?;
    let days = time.div_euclid(MS_PER_DAY);
    // civil_from_days (H. Hinnant), exact over the whole range of a Date
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    Some((year as f64, (m - 1) as f64, d as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each expected value is what Node 22 answers for the same `new Date(ms)`.

    #[test]
    fn reads_as_the_utc_getters_do() {
        assert_eq!(utc_date_parts(0.0), Some((1970.0, 0.0, 1.0)));
        assert_eq!(utc_date_parts(-1.0), Some((1969.0, 11.0, 31.0)));
        // truncated toward zero first: -0.5 is the epoch
        assert_eq!(utc_date_parts(-0.5), Some((1970.0, 0.0, 1.0)));
        assert_eq!(utc_date_parts(951_782_400_000.0), Some((2000.0, 1.0, 29.0)));
        assert_eq!(utc_date_parts(8.64e15), Some((275_760.0, 8.0, 13.0)));
        assert_eq!(utc_date_parts(-8.64e15), Some((-271_821.0, 3.0, 20.0)));
        assert_eq!(utc_date_parts(8.64e15 + 1.0), None);
        assert_eq!(utc_date_parts(f64::NAN), None);
    }
}
