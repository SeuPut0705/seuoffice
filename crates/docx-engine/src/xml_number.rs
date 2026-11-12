//! `xml-number.ts`: the one place a number becomes the text of an integer XML
//! attribute or element (EMU, twips, ranks, ids). NaN, an infinity, or a value
//! whose decimal form needs an exponent has no text there: a patch then keeps
//! what the XML held, a builder refuses the call.

use jscompat::{math_round, number_to_string};

/// `Number.isSafeInteger`
fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// `xmlInt`: the rounded value as plain decimal digits, or `None` when it has none.
pub fn xml_int(n: f64) -> Option<String> {
    let rounded = math_round(n);
    is_safe_integer(rounded).then(|| number_to_string(rounded))
}

/// `xmlId`: an id must already be an integer, since rounding could duplicate one.
pub fn xml_id(n: f64) -> Option<String> {
    is_safe_integer(n).then(|| number_to_string(n))
}

/// `xmlDecimal`: a decimal value as plain digits, or `None` for NaN, an
/// infinity or an exponent form.
pub fn xml_decimal(n: f64) -> Option<String> {
    let text = number_to_string(n);
    (n.is_finite() && !text.contains('e')).then_some(text)
}

/// `xmlIntIn`: `n` rounded, as plain digits, when it lies in `min..=max`.
fn xml_int_in(n: f64, min: f64, max: f64) -> Option<String> {
    let rounded = math_round(n);
    (is_safe_integer(rounded) && rounded >= min && rounded <= max)
        .then(|| number_to_string(rounded))
}

/// `MAX_COORDINATE_EMU`: the widest coordinate a drawing admits (ST_Coordinate).
pub const MAX_COORDINATE_EMU: f64 = 27_273_042_316_900.0;

/// `xmlPositionOffset`: wp:posOffset (ST_PositionOffset, an xsd:int), in EMU.
pub fn xml_position_offset(emu: f64) -> Option<String> {
    xml_int_in(emu, -2_147_483_648.0, 2_147_483_647.0)
}

/// `xmlPositiveCoordinate`: an extent's cx / cy (ST_PositiveCoordinate), in EMU.
pub fn xml_positive_coordinate(emu: f64) -> Option<String> {
    xml_int_in(emu, 0.0, MAX_COORDINATE_EMU)
}

/// `xmlUnsignedInt`: wp:anchor relativeHeight, distT / distB / distL / distR.
pub fn xml_unsigned_int(n: f64) -> Option<String> {
    xml_int_in(n, 0.0, 4_294_967_295.0)
}

/// `nonFinite`: a builder's refusal of an option that has no XML text. The
/// TypeScript throws `RangeError(...)`; this is its message.
pub fn non_finite(option: &str) -> String {
    format!("a non-finite number: {option}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_int_rounds_to_a_safe_integer() {
        assert_eq!(xml_int(2.5).as_deref(), Some("3"));
        assert_eq!(xml_int(-2.5).as_deref(), Some("-2"));
        assert_eq!(xml_int(-0.4).as_deref(), Some("0"));
        assert_eq!(
            xml_int(9_007_199_254_740_991.0).as_deref(),
            Some("9007199254740991")
        );
        assert_eq!(xml_int(9_007_199_254_740_992.0), None);
        assert_eq!(xml_int(1e21), None);
        assert_eq!(xml_int(f64::NAN), None);
        assert_eq!(xml_int(f64::INFINITY), None);
    }

    #[test]
    fn xml_id_takes_integers_only() {
        assert_eq!(xml_id(7.0).as_deref(), Some("7"));
        assert_eq!(xml_id(-0.0).as_deref(), Some("0"));
        assert_eq!(xml_id(2.5), None);
        assert_eq!(xml_id(1e21), None);
        assert_eq!(xml_id(f64::NAN), None);
    }

    #[test]
    fn xml_decimal_refuses_an_exponent() {
        assert_eq!(xml_decimal(2.5).as_deref(), Some("2.5"));
        assert_eq!(xml_decimal(0.00001).as_deref(), Some("0.00001"));
        assert_eq!(xml_decimal(1e-7), None);
        assert_eq!(xml_decimal(1e21), None);
        assert_eq!(xml_decimal(f64::NEG_INFINITY), None);
    }
}
