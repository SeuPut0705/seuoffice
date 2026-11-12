//! Content-control checkboxes (w14:checkbox):
//! packages/docx-engine/src/checkbox-control.ts. `w14:checked` picks between
//! the checkedState and uncheckedState glyphs, whose values are hex code
//! points; the glyph of the run inside sdtContent is the state the editor
//! writes back.

use jscompat::{Radix, js_regex, parse_int};
use ooxml_xml::{XNode, serialize};
use serde::Serialize;

/// `CheckboxGlyphs`: each glyph is one code point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CheckboxGlyphs {
    pub checked: char,
    pub unchecked: char,
}

/// `DEFAULT_GLYPHS`: Word's own, U+2612 and U+2610.
const DEFAULT_GLYPHS: CheckboxGlyphs = CheckboxGlyphs {
    checked: '\u{2612}',
    unchecked: '\u{2610}',
};

/// `glyphOf`
fn glyph_of(hex: Option<&str>, fallback: char) -> char {
    let code = parse_int(hex.unwrap_or(""), Radix::Sixteen);
    // half of a surrogate pair is not a character: it gets the fallback too
    if code.is_finite() && code > 0.0 && code <= 1_114_111.0 && !(55296.0..=57343.0).contains(&code)
    {
        // an integer in range: the cast is exact
        char::from_u32(code as u32).unwrap_or(fallback)
    } else {
        fallback
    }
}

/// `isOn`: an absent value means checked. `toLowerCase()` maps no character
/// outside A-Z onto the letters of `true` or `on`, so the ASCII comparison is
/// the same.
pub fn is_on(val: Option<&str>) -> bool {
    let Some(val) = val else {
        return true;
    };
    val == "1" || val.eq_ignore_ascii_case("true") || val.eq_ignore_ascii_case("on")
}

/// `sdtCheckboxGlyphs`: the glyph pair a w:sdtPr declares.
pub fn sdt_checkbox_glyphs(sdt_pr_xml: &str) -> CheckboxGlyphs {
    let state = |pattern: &jscompat::JsRegex| -> Option<&str> {
        let found = pattern.exec(sdt_pr_xml)?;
        found.get(1).or_else(|| found.get(2))
    };
    CheckboxGlyphs {
        checked: glyph_of(
            state(js_regex!(
                r#"<w14:checkedState\b[^>]*\bw14:val=(?:"([^"]*)"|'([^']*)')"#
            )),
            DEFAULT_GLYPHS.checked,
        ),
        unchecked: glyph_of(
            state(js_regex!(
                r#"<w14:uncheckedState\b[^>]*\bw14:val=(?:"([^"]*)"|'([^']*)')"#
            )),
            DEFAULT_GLYPHS.unchecked,
        ),
    }
}

/// What `sdtCheckboxControl` gives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdtCheckboxControl {
    pub sdt_pr_xml: String,
    pub glyph: char,
}

/// `sdtCheckboxControl`: a w:sdt element that is a checkbox control.
pub fn sdt_checkbox_control(sdt: &XNode) -> Option<SdtCheckboxControl> {
    let sdt_pr = sdt.find_child("w:sdtPr")?;
    let check_box = sdt_pr.find_child("w14:checkbox")?;
    let checked = check_box
        .find_child("w14:checked")
        .is_some_and(|checked_el| is_on(checked_el.attr("w14:val")));
    let sdt_pr_xml = serialize(sdt_pr);
    let glyphs = sdt_checkbox_glyphs(&sdt_pr_xml);
    Some(SdtCheckboxControl {
        sdt_pr_xml,
        glyph: if checked {
            glyphs.checked
        } else {
            glyphs.unchecked
        },
    })
}

/// `sdtCheckboxIsChecked`: whether `glyph` reads as the checked state.
pub fn sdt_checkbox_is_checked(sdt_pr_xml: &str, glyph: &str) -> bool {
    let glyphs = sdt_checkbox_glyphs(sdt_pr_xml);
    let is = |c: char| glyph == c.encode_utf8(&mut [0; 4]);
    if is(glyphs.checked) {
        return true;
    }
    if is(glyphs.unchecked) {
        return false;
    }
    js_regex!("[\u{2611}\u{2612}\u{2713}\u{2714}\u{2705}]", "u").test(glyph)
}

/// `syncSdtCheckbox`: the w:sdtPr with w14:checked set to `checked`.
pub fn sync_sdt_checkbox(sdt_pr_xml: &str, checked: bool) -> String {
    let val = if checked {
        r#"<w14:checked w14:val="1"/>"#
    } else {
        r#"<w14:checked w14:val="0"/>"#
    };
    let stripped =
        js_regex!(r"<w14:checked(?:\s[^>]*)?\/>", "g").replace_all(sdt_pr_xml, |_| String::new());
    // the `test` of the TypeScript is this pattern without the group
    if let Some(found) = js_regex!(r"<w14:checkbox((?:\s[^>]*)?)\/>").exec(&stripped) {
        return format!(
            "{}<w14:checkbox{}>{val}</w14:checkbox>{}",
            &stripped[..found.start()],
            found.get(1).unwrap_or(""),
            &stripped[found.end()..],
        );
    }
    match js_regex!(r"<w14:checkbox(?:\s[^>]*)?>").exec(&stripped) {
        Some(found) => format!(
            "{}{val}{}",
            &stripped[..found.end()],
            &stripped[found.end()..]
        ),
        None => stripped,
    }
}
