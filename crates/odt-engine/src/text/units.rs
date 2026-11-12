//! `text/units.ts`: ODF length strings to OOXML twips and half-points, and back.

use jscompat::{js_regex, math_round, number_to_string, parse_float};

/// `TWIPS_PER_UNIT[unit]`; the pattern of `length_to_twips` names only these units.
fn twips_per_unit(unit: &str) -> f64 {
    match unit {
        "cm" => 1440.0 / 2.54,
        "mm" => 1440.0 / 25.4,
        "in" | "inch" => 1440.0,
        "pt" => 20.0,
        "pc" => 240.0,
        // "px"
        _ => 15.0,
    }
}

/// `lengthToTwips`: an ODF length (`0.529cm`, `12pt`) in twips (unrounded);
/// `None` when not a length.
pub fn length_to_twips(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let m = js_regex!(r"^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(cm|mm|inch|in|pt|pc|px)\s*$")
        .exec(value)?;
    let n = parse_float(m.get(1)?);
    if n.is_finite() {
        Some(n * twips_per_unit(m.get(2)?))
    } else {
        None
    }
}

/// `twips`: rounded twips of an ODF length.
pub fn twips(value: Option<&str>) -> Option<f64> {
    length_to_twips(value).map(math_round)
}

/// `percent`: a percentage (`160%`) as a fraction (1.6); `None` otherwise.
pub fn percent(value: Option<&str>) -> Option<f64> {
    let value = value.filter(|v| !v.is_empty())?;
    let m = js_regex!(r"^\s*([-+]?\d*\.?\d+)\s*%\s*$").exec(value)?;
    Some(parse_float(m.get(1)?) / 100.0)
}

/// `Number.prototype.toFixed(digits)` for `digits` of 0..=100. Rust rounds an
/// exact tie to even where JavaScript takes the larger magnitude, so a tie
/// (`0.125.toFixed(2)`) is nudged one step up before it is printed.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let magnitude = x.abs();
    let mut out = format!("{magnitude:.digits$}");
    if format!("{magnitude:.*}", digits + 1).ends_with('5') {
        // an exact decimal expansion of a double has at most 1074 fractional digits
        let exact = format!("{magnitude:.1100}");
        let at = exact.find('.').map_or(exact.len(), |dot| dot + 1 + digits);
        if exact.as_bytes().get(at) == Some(&b'5')
            && exact.as_bytes()[at + 1..].iter().all(|&b| b == b'0')
        {
            out = format!("{:.digits$}", f64::from_bits(magnitude.to_bits() + 1));
        }
    }
    if x < 0.0 {
        out.insert(0, '-');
    }
    out
}

/// `trim` (module-private in the TypeScript): `toFixed` without a negative zero.
fn trim_fixed(n: f64, digits: usize) -> String {
    let s = to_fixed(n, digits);
    if s == format!("-{}", to_fixed(0.0, digits)) {
        to_fixed(0.0, digits)
    } else {
        s
    }
}

/// `twipsToCm`: twips as an ODF length in centimetres with three decimals
/// (`0.529cm`), as Hancom writes.
pub fn twips_to_cm(value: f64) -> String {
    format!("{}cm", trim_fixed((value * 2.54) / 1440.0, 3))
}

/// `twipsToPt`: twips as points with two decimals (`-0.60pt`).
pub fn twips_to_pt(value: f64) -> String {
    format!("{}pt", trim_fixed(value / 20.0, 2))
}

/// `halfPointsToPt`: half-points as points with two decimals (`10.50pt`).
pub fn half_points_to_pt(value: f64) -> String {
    format!("{}pt", trim_fixed(value / 2.0, 2))
}
