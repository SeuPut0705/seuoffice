//! `parseInt`, `parseFloat`, `Number`, `Math.round` and number formatting.

use crate::space::{trim, trim_start};

/// The radixes the engines pass to `parseInt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Radix {
    Ten,
    Sixteen,
}

/// `parseInt(text, radix)`: leading whitespace, an optional sign, then the
/// longest run of digits. Anything after it is ignored; no digit at all is NaN.
pub fn parse_int(text: &str, radix: Radix) -> f64 {
    let text = trim_start(text);
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let magnitude = match radix {
        Radix::Ten => {
            let digits = leading(text, |byte| byte.is_ascii_digit());
            // correctly rounded, as V8 does for decimal digits
            digits.parse::<f64>().unwrap_or(f64::NAN)
        }
        Radix::Sixteen => {
            let text = text
                .strip_prefix("0x")
                .or_else(|| text.strip_prefix("0X"))
                .unwrap_or(text);
            power_of_two_radix(leading(text, |byte| byte.is_ascii_hexdigit()), 4)
        }
    };
    if negative { -magnitude } else { magnitude }
}

/// `parseFloat(text)`: leading whitespace, then the longest prefix that is a
/// decimal literal. No hexadecimal, no digit separators.
pub fn parse_float(text: &str) -> f64 {
    let text = trim_start(text);
    match decimal_literal_prefix(text) {
        Some(length) => decimal_value(&text[..length]),
        None => f64::NAN,
    }
}

/// `Number(text)`: the whole trimmed text must be one numeric literal. The empty
/// string is 0. `0x`, `0o` and `0b` literals are read, without a sign.
pub fn to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    if decimal_literal_prefix(text) == Some(text.len()) {
        return decimal_value(text);
    }
    type IsDigit = fn(u8) -> bool;
    let radixes: [(&str, &str, u32, IsDigit); 3] = [
        ("0x", "0X", 4, |byte| byte.is_ascii_hexdigit()),
        ("0o", "0O", 3, |byte| matches!(byte, b'0'..=b'7')),
        ("0b", "0B", 1, |byte| matches!(byte, b'0' | b'1')),
    ];
    for (lower, upper, bits, is_digit) in radixes {
        if let Some(digits) = text
            .strip_prefix(lower)
            .or_else(|| text.strip_prefix(upper))
        {
            return if leading(digits, is_digit).len() == digits.len() {
                power_of_two_radix(digits, bits)
            } else {
                f64::NAN
            };
        }
    }
    f64::NAN
}

fn leading(text: &str, is_digit: impl Fn(u8) -> bool) -> &str {
    let length = text.bytes().take_while(|byte| is_digit(*byte)).count();
    &text[..length]
}

/// Length of the longest prefix that is a `StrDecimalLiteral`: an optional sign,
/// then `Infinity`, or digits with an optional fraction and exponent.
fn decimal_literal_prefix(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let sign = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    if text[sign..].starts_with("Infinity") {
        return Some(sign + "Infinity".len());
    }
    let digits_from = |from: usize| leading(&text[from..], |byte| byte.is_ascii_digit()).len();
    let integer = digits_from(sign);
    let mut end = sign + integer;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits_from(end + 1);
        // "5." is a literal, "." alone is not
        if integer > 0 || fraction > 0 {
            end += 1 + fraction;
        }
    }
    if integer == 0 && fraction == 0 {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let exponent_sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits_from(end + 1 + exponent_sign);
        if exponent > 0 {
            end += 1 + exponent_sign + exponent;
        }
    }
    Some(end)
}

/// The value of a text `decimal_literal_prefix` accepted in full.
fn decimal_value(literal: &str) -> f64 {
    match literal.strip_prefix('-') {
        Some("Infinity") => f64::NEG_INFINITY,
        _ if literal.ends_with("Infinity") => f64::INFINITY,
        _ => literal.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// The exact value of the digits, rounded to the nearest double with ties to
/// even. NaN for no digits.
fn power_of_two_radix(digits: &str, bits_per_digit: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut bits = digits
        .bytes()
        .flat_map(|byte| {
            let value = (byte as char).to_digit(16).unwrap_or(0);
            (0..bits_per_digit)
                .rev()
                .map(move |bit| value >> bit & 1 == 1)
        })
        .skip_while(|bit| !bit);
    let mut mantissa = 0u64;
    let mut kept = 0;
    for bit in bits.by_ref().take(53) {
        mantissa = mantissa << 1 | u64::from(bit);
        kept += 1;
    }
    if kept < 53 {
        return mantissa as f64;
    }
    let Some(guard) = bits.next() else {
        return mantissa as f64;
    };
    let mut dropped = 1;
    let mut sticky = false;
    for bit in bits {
        sticky |= bit;
        dropped += 1;
    }
    if guard && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    mantissa as f64 * 2f64.powi(dropped)
}

/// `Math.round`: the nearest integer, a tie going towards positive infinity.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    // -0.2 rounds to -0, and -0 stays -0
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `ToInt32`, which the bitwise operators apply to their operands: the integer
/// part modulo 2^32, read as a signed 32-bit value. NaN and the infinities are 0.
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let modulo = x.trunc().rem_euclid(4_294_967_296.0);
    modulo as u32 as i32
}

/// `String(x)` and `x.toString()`: the shortest digits that read back as `x`,
/// in plain notation from 1e-6 up to 1e21 and in exponent notation outside.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    if x.is_infinite() {
        return format!("{sign}Infinity");
    }
    let (digits, point) = shortest_digits(x.abs());
    let count = digits.len() as i32;
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat(-point as usize))
    } else {
        let exponent = point - 1;
        let exponent_sign = if exponent < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let fraction = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{fraction}e{exponent_sign}{}", exponent.abs())
    };
    format!("{sign}{body}")
}

/// The shortest decimal digits that read back as `x` (finite, positive), and
/// the position of the decimal point: the value is `0.digits * 10^point`.
///
/// Where two shortest digit strings are equally close, JavaScript takes the
/// one that ends in an even digit. `ryu` does the same; the standard library's
/// formatter rounds such a tie up (2077740938402712.25 prints as ...712.3).
fn shortest_digits(x: f64) -> (String, i32) {
    let mut buffer = ryu::Buffer::new();
    let printed = buffer.format_finite(x);
    let (mantissa, exponent) = printed.split_once('e').unwrap_or((printed, "0"));
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let all = format!("{whole}{fraction}");
    let leading_zeros = all.len() - all.trim_start_matches('0').len();
    let digits = all.trim_matches('0').to_owned();
    let point = whole.len() as i32 - leading_zeros as i32 + exponent.parse::<i32>().unwrap_or(0);
    (digits, point)
}

/// `x.toString(16)` for a value with no fraction, which is what `Math.round`
/// returns.
pub fn to_string_radix16(x: f64) -> String {
    if !x.is_finite() || x == 0.0 {
        return number_to_string(x);
    }
    debug_assert!(x.fract() == 0.0);
    let sign = if x < 0.0 { "-" } else { "" };
    let magnitude = x.abs();
    if magnitude < 18_446_744_073_709_551_616.0 {
        return format!("{sign}{:x}", magnitude as u64);
    }
    // an integer of more than 64 bits: 53 significant bits and zeros
    let bits = magnitude.to_bits();
    let mantissa = bits & ((1 << 52) - 1) | 1 << 52;
    let shift = ((bits >> 52) as u32 & 0x7ff) - 1075;
    format!(
        "{sign}{:x}{}",
        mantissa << (shift % 4),
        "0".repeat((shift / 4) as usize)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A number as JavaScript prints it, with -0 told apart from 0.
    fn exact(x: f64) -> String {
        if x == 0.0 && x.is_sign_negative() {
            "-0".to_owned()
        } else {
            number_to_string(x)
        }
    }

    // Every expected value below is what Node 22 answers for the same input.

    /// text, parseInt(text, 10), parseInt(text, 16), parseFloat(text), Number(text)
    const TEXTS: &[(&str, &str, &str, &str, &str)] = &[
        ("", "NaN", "NaN", "NaN", "0"),
        ("0", "0", "0", "0", "0"),
        ("-0", "-0", "-0", "-0", "-0"),
        ("+5", "5", "5", "5", "5"),
        ("-5", "-5", "-5", "-5", "-5"),
        ("12.7", "12", "18", "12.7", "12.7"),
        (".5", "NaN", "NaN", "0.5", "0.5"),
        ("5.", "5", "5", "5", "5"),
        ("-.5", "NaN", "NaN", "-0.5", "-0.5"),
        ("1e3", "1", "483", "1000", "1000"),
        ("1E-2", "1", "30", "0.01", "0.01"),
        ("1e", "1", "30", "1", "NaN"),
        ("0x1F", "0", "31", "0", "31"),
        ("0X1f", "0", "31", "0", "31"),
        ("0x", "0", "NaN", "0", "NaN"),
        ("-0x10", "-0", "-16", "-0", "NaN"),
        ("ff", "NaN", "255", "NaN", "NaN"),
        ("12abc", "12", "76476", "12", "NaN"),
        ("abc", "NaN", "2748", "NaN", "NaN"),
        (" 42 ", "42", "66", "42", "42"),
        ("\t7", "7", "7", "7", "7"),
        ("\u{a0}12", "12", "18", "12", "12"),
        ("\u{feff}12", "12", "18", "12", "12"),
        ("\u{85}12", "NaN", "NaN", "NaN", "NaN"),
        ("00012", "12", "18", "12", "12"),
        (
            "9007199254740993",
            "9007199254740992",
            "10378291982571407000",
            "9007199254740992",
            "9007199254740992",
        ),
        (
            "99999999999999999999999",
            "1e+23",
            "2.9710560942849125e+27",
            "1e+23",
            "1e+23",
        ),
        ("1e400", "1", "123904", "Infinity", "Infinity"),
        ("-1e400", "-1", "-123904", "-Infinity", "-Infinity"),
        ("Infinity", "NaN", "NaN", "Infinity", "Infinity"),
        ("-Infinity", "NaN", "NaN", "-Infinity", "-Infinity"),
        ("+Infinity", "NaN", "NaN", "Infinity", "Infinity"),
        ("infinity", "NaN", "NaN", "NaN", "NaN"),
        ("NaN", "NaN", "NaN", "NaN", "NaN"),
        ("\u{ff11}\u{ff12}", "NaN", "NaN", "NaN", "NaN"),
        ("1_000", "1", "1", "1", "NaN"),
        ("1,000", "1", "1", "1", "NaN"),
        ("0b11", "0", "2833", "0", "3"),
        ("0o17", "0", "0", "0", "15"),
        ("0B2", "0", "178", "0", "NaN"),
        (
            "0.49999999999999994",
            "0",
            "0",
            "0.49999999999999994",
            "0.49999999999999994",
        ),
        ("1FFFFFFFFFFFFF", "1", "9007199254740991", "1", "NaN"),
        (
            "20000000000001",
            "20000000000001",
            "9007199254740992",
            "20000000000001",
            "20000000000001",
        ),
        (
            "20000000000003",
            "20000000000003",
            "9007199254740996",
            "20000000000003",
            "20000000000003",
        ),
        (
            "FFFFFFFFFFFFFFFFFFFF",
            "NaN",
            "1.2089258196146292e+24",
            "NaN",
            "NaN",
        ),
        ("- 5", "NaN", "NaN", "NaN", "NaN"),
        ("--5", "NaN", "NaN", "NaN", "NaN"),
        ("+-5", "NaN", "NaN", "NaN", "NaN"),
        ("1.5e+2", "1", "1", "150", "150"),
        ("1.e2", "1", "1", "100", "100"),
        (".e2", "NaN", "NaN", "NaN", "NaN"),
        ("e2", "NaN", "226", "NaN", "NaN"),
        ("0x1.8", "0", "1", "0", "NaN"),
        ("5 6", "5", "5", "5", "NaN"),
    ];

    /// bits of x, String(x), Math.round(x), x | 0, Math.round(x).toString(16)
    const DOUBLES: &[(u64, &str, &str, i32, &str)] = &[
        (0x0000_0000_0000_0000, "0", "0", 0, "0"),
        (0x8000_0000_0000_0000, "-0", "-0", 0, "0"),
        (0x3fe0_0000_0000_0000, "0.5", "1", 0, "1"),
        (0xbfe0_0000_0000_0000, "-0.5", "-0", 0, "0"),
        (0x3ff8_0000_0000_0000, "1.5", "2", 1, "2"),
        (0x4004_0000_0000_0000, "2.5", "3", 2, "3"),
        (0xbff8_0000_0000_0000, "-1.5", "-1", -1, "-1"),
        (0xc004_0000_0000_0000, "-2.5", "-2", -2, "-2"),
        (0x3fdf_ffff_ffff_ffff, "0.49999999999999994", "0", 0, "0"),
        (0xbfdf_ffff_ffff_ffff, "-0.49999999999999994", "-0", 0, "0"),
        (
            0x432f_ffff_ffff_ffff,
            "4503599627370495.5",
            "4503599627370496",
            -1,
            "10000000000000",
        ),
        (
            0x4330_0000_0000_0000,
            "4503599627370496",
            "4503599627370496",
            0,
            "10000000000000",
        ),
        (
            0x4340_0000_0000_0000,
            "9007199254740992",
            "9007199254740992",
            0,
            "20000000000000",
        ),
        (0xbfc9_9999_9999_999a, "-0.2", "-0", 0, "0"),
        (
            0x444b_1ae4_d6e2_ef50,
            "1e+21",
            "1e+21",
            -559939584,
            "3635c9adc5dea00000",
        ),
        (0x3e7a_d7f2_9abc_af48, "1e-7", "0", 0, "0"),
        (
            0x441a_c53a_7e04_bcda,
            "123456789012345680000",
            "123456789012345680000",
            792100864,
            "6b14e9f812f368000",
        ),
        (0x3e80_91b5_aeff_db8e, "1.2345e-7", "0", 0, "0"),
        (0x3eb0_c6f7_a0b5_ed8d, "0.000001", "0", 0, "0"),
        (0x3fb9_9999_9999_999a, "0.1", "0", 0, "0"),
        (0x4059_0000_0000_0000, "100", "100", 100, "64"),
        (
            0x7e37_e43c_8800_759c,
            "1e+300",
            "1e+300",
            0,
            "17e43c8800759c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        ),
        (0x0000_0000_0000_0001, "5e-324", "0", 0, "0"),
        (
            0x431d_86c7_0a46_6e61,
            "2077740938402712.2",
            "2077740938402712",
            -1030644840,
            "761b1c2919b98",
        ),
        (
            0xc2d0_d97d_04a8_32c8,
            "-74105165619403.12",
            "-74105165619403",
            200105781,
            "-4365f412a0cb",
        ),
        (0x406f_f000_0000_0000, "255.5", "256", 255, "100"),
        (
            0x41f0_0000_000b_3333,
            "4294967296.7",
            "4294967297",
            0,
            "100000001",
        ),
        (
            0xc1f0_0000_0013_3333,
            "-4294967297.2",
            "-4294967297",
            -1,
            "-100000001",
        ),
        (
            0x41e0_0000_0000_0000,
            "2147483648",
            "2147483648",
            -2147483648,
            "80000000",
        ),
        (
            0xc1e0_0000_0020_0000,
            "-2147483649",
            "-2147483649",
            2147483647,
            "-80000001",
        ),
        (
            0x43f0_0000_0000_0000,
            "18446744073709552000",
            "18446744073709552000",
            0,
            "10000000000000000",
        ),
        (
            0x4629_3e59_39a0_8cea,
            "1e+30",
            "1e+30",
            0,
            "c9f2c9cd04675000000000000",
        ),
        (0x7ff8_0000_0000_0000, "NaN", "NaN", 0, "NaN"),
        (0x7ff0_0000_0000_0000, "Infinity", "Infinity", 0, "Infinity"),
        (
            0xfff0_0000_0000_0000,
            "-Infinity",
            "-Infinity",
            0,
            "-Infinity",
        ),
    ];

    #[test]
    fn parse_int_reads_the_longest_prefix_in_its_radix() {
        for (text, ten, sixteen, _, _) in TEXTS {
            assert_eq!(
                exact(parse_int(text, Radix::Ten)),
                *ten,
                "parseInt({text:?}, 10)"
            );
            assert_eq!(
                exact(parse_int(text, Radix::Sixteen)),
                *sixteen,
                "parseInt({text:?}, 16)"
            );
        }
    }

    #[test]
    fn parse_float_reads_a_decimal_prefix() {
        for (text, _, _, float, _) in TEXTS {
            assert_eq!(exact(parse_float(text)), *float, "parseFloat({text:?})");
        }
    }

    #[test]
    fn to_number_takes_the_whole_text_or_nothing() {
        for (text, _, _, _, number) in TEXTS {
            assert_eq!(exact(to_number(text)), *number, "Number({text:?})");
        }
    }

    #[test]
    fn number_to_string_prints_the_shortest_digits_that_read_back() {
        for (bits, printed, ..) in DOUBLES {
            assert_eq!(exact(f64::from_bits(*bits)), *printed);
        }
    }

    #[test]
    fn math_round_sends_a_tie_towards_positive_infinity() {
        for (bits, printed, rounded, ..) in DOUBLES {
            assert_eq!(
                exact(math_round(f64::from_bits(*bits))),
                *rounded,
                "Math.round({printed})"
            );
        }
    }

    #[test]
    fn to_int32_wraps_modulo_two_to_the_32() {
        for (bits, printed, _, wrapped, _) in DOUBLES {
            assert_eq!(to_int32(f64::from_bits(*bits)), *wrapped, "{printed} | 0");
        }
    }

    #[test]
    fn to_string_radix16_prints_integers_beyond_64_bits() {
        for (bits, printed, _, _, hex) in DOUBLES {
            let rounded = math_round(f64::from_bits(*bits));
            assert_eq!(
                to_string_radix16(rounded),
                *hex,
                "Math.round({printed}).toString(16)"
            );
        }
    }
}
