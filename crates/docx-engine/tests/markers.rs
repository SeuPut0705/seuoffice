//! Expected values are what the TypeScript gave for the same calls
//! (`formatNumber`, `markerTabAdvance`, ... of list-markers.ts and
//! symbol-fonts.ts, run with `npx tsx` and printed with non-ASCII escaped).

use docx_engine::list_markers::{
    custom_enum_items, format_number, marker_fallback_face, marker_tab_advance,
};
use docx_engine::symbol_fonts::{decode_symbol_text, symbol_glyph, symbol_pua_char};

#[test]
fn number_formats_at_their_boundaries() {
    let cases: [(f64, &str, &str); 15] = [
        (10.0, "chineseCounting", "\u{5341}"),
        (110.0, "chineseCounting", "\u{4e00}\u{767e}\u{4e00}\u{5341}"),
        (
            1010.0,
            "chineseLegalSimplified",
            "\u{58f9}\u{4edf}\u{96f6}\u{58f9}\u{62fe}",
        ),
        (12.0, "ordinalText", "Twelfth"),
        (20.0, "ordinalText", "Twentieth"),
        (-0.0, "decimalZero", "00"),
        (1.9, "decimalZero", "01"),
        (27.0, "lowerLetter", "aa"),
        (25.0, "lowerGreek", "\u{3b1}\u{3b1}"),
        (18.0, "upperGreek", "\u{3a3}"),
        (f64::NAN, "upperRoman", "I"),
        (
            1e9,
            "cardinalText",
            "Nine Hundred Ninety-Nine Thousand Nine Hundred Ninety-Nine",
        ),
        (112.0, "ordinal", "112th"),
        (-1.0, "ordinal", "-1th"),
        (21.0, "decimalEnclosedCircle", "21"),
    ];
    for (value, fmt, expected) in cases {
        assert_eq!(format_number(value, fmt, None), expected, "{value} {fmt}");
    }
    assert_eq!(format_number(4.0, "custom", Some("a, b, c, ...")), "a");
}

#[test]
fn marker_tab_stops() {
    assert_eq!(marker_tab_advance(0.0, 200.0, 360.0, 720.0, &[]), None);
    assert_eq!(marker_tab_advance(0.0, 500.0, 360.0, 0.0, &[]), Some(500.0));
    assert_eq!(
        marker_tab_advance(0.0, 500.0, 360.0, 720.0, &[300.0, 900.0]),
        Some(900.0)
    );
    assert_eq!(
        marker_tab_advance(0.0, 200.0, 720.0, 720.0, &[500.0, 400.0]),
        Some(400.0)
    );
}

#[test]
fn custom_enumerations_and_fallback_faces() {
    assert_eq!(
        custom_enum_items("a, b, ..."),
        Some(vec!["a".to_owned(), "b".to_owned()])
    );
    assert_eq!(custom_enum_items("a"), None);
    assert_eq!(
        marker_fallback_face("\u{25cf}", "Cambria"),
        Some("Segoe UI Symbol")
    );
    assert_eq!(marker_fallback_face("\u{25cf}", "Calibri"), None);
}

#[test]
fn symbol_glyphs() {
    assert_eq!(
        symbol_glyph("Wingdings", "F06C").as_deref(),
        Some("\u{25cf}")
    );
    assert_eq!(symbol_glyph("Calibri", "F06C").as_deref(), Some("\u{f06c}"));
    assert_eq!(symbol_pua_char("-41").as_deref(), Some("\u{f0bf}"));
    assert_eq!(symbol_pua_char(&"f".repeat(300)), None);
    assert_eq!(
        decode_symbol_text("Webdings", ">", false).as_deref(),
        Some("A")
    );
    assert_eq!(decode_symbol_text("Webdings", ">", true), None);
    assert_eq!(
        decode_symbol_text("Symbol", "a b", false).as_deref(),
        Some("\u{3b1} \u{3b2}")
    );
    assert_eq!(decode_symbol_text("Symbol", "a\u{7f}", false), None);
}
