//! The pre-revision snapshot of a run's properties (`w:rPrChange`).

use jscompat::{Radix, parse_int, truthy};
use ooxml_xml::XNode;
use serde_json::{Map, Value};

use super::convert::num;
use crate::drawing_geometry::fill::w14_text_fill_hex;
use crate::theme::ThemeColors;
use crate::xml_text::{auto_color_of, bool_prop, color_from, on_off_of, strip_hash};

fn val<'a>(node: &'a XNode, name: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr("w:val"))
}

/// `parseInt(text, 10) || undefined`: a key that exists with no value is `null` here.
fn int_or_undefined(text: &str) -> Value {
    let n = parse_int(text, Radix::Ten);
    if n == 0.0 || n.is_nan() {
        Value::Null
    } else {
        num(n)
    }
}

/// The `old` object of `run.rPrChange`, in the order the TypeScript sets its keys.
/// A key the TypeScript sets to `undefined` is `Null` (it counts as a key).
pub fn old_run_properties(
    old_r_pr: &XNode,
    inherited_rtl: Option<bool>,
    theme: Option<&ThemeColors>,
) -> Map<String, Value> {
    let mut old = Map::new();
    // the pre-revision snapshot decodes under the same rtl selection
    let ocs = on_off_of(old_r_pr, "w:rtl").or(inherited_rtl) == Some(true);
    if bool_prop(old_r_pr, if ocs { "w:bCs" } else { "w:b" }) {
        old.insert("bold".to_owned(), Value::Bool(true));
    }
    if bool_prop(old_r_pr, if ocs { "w:iCs" } else { "w:i" }) {
        old.insert("italic".to_owned(), Value::Bool(true));
    }
    if val(old_r_pr, "w:u").is_some_and(|u| u != "none") {
        old.insert("underline".to_owned(), Value::Bool(true));
    }
    if bool_prop(old_r_pr, "w:strike") {
        old.insert("strike".to_owned(), Value::Bool(true));
    }
    let oc = color_from(Some(old_r_pr), theme)
        .filter(|c| !c.is_empty())
        .or_else(|| w14_text_fill_hex(old_r_pr, theme).filter(|c| !c.is_empty()))
        .or_else(|| auto_color_of(Some(old_r_pr)).map(str::to_owned));
    if let Some(oc) = &oc {
        old.insert("color".to_owned(), Value::from(oc.as_str()));
    }
    if let Some(osz) = truthy(val(old_r_pr, if ocs { "w:szCs" } else { "w:sz" })) {
        old.insert("sizeHalfPoints".to_owned(), int_or_undefined(osz));
    }
    let r_fonts = old_r_pr.find_child("w:rFonts");
    let font_attr = |name: &str| r_fonts.and_then(|node| node.attr(name));
    if let Some(font) = truthy(font_attr("w:eastAsia").or(font_attr("w:ascii"))) {
        old.insert("font".to_owned(), Value::from(font));
    }
    if let Some(ascii) = truthy(font_attr("w:ascii")) {
        old.insert("fontAscii".to_owned(), Value::from(ascii));
    }
    let ospc = parse_int(val(old_r_pr, "w:spacing").unwrap_or(""), Radix::Ten);
    if ospc.is_finite() {
        old.insert("charSpacingTwips".to_owned(), num(ospc));
    }
    let o_scale = parse_int(val(old_r_pr, "w:w").unwrap_or(""), Radix::Ten);
    if o_scale > 0.0 && o_scale != 100.0 {
        old.insert("charScalePct".to_owned(), num(o_scale));
    }
    if let Some(highlight) = truthy(val(old_r_pr, "w:highlight")).filter(|h| *h != "none") {
        old.insert("highlight".to_owned(), Value::from(highlight));
    }
    if let Some(v @ ("superscript" | "subscript")) = val(old_r_pr, "w:vertAlign") {
        old.insert("vertAlign".to_owned(), Value::from(v));
    }
    if let Some(style) = truthy(val(old_r_pr, "w:rStyle")) {
        old.insert("styleId".to_owned(), Value::from(style));
    }
    let ocaps = on_off_of(old_r_pr, "w:caps");
    let osmall = on_off_of(old_r_pr, "w:smallCaps");
    if ocaps == Some(true) {
        old.insert("caps".to_owned(), Value::from("all"));
    } else if osmall == Some(true) {
        old.insert("caps".to_owned(), Value::from("small"));
    } else if ocaps == Some(false) || osmall == Some(false) {
        old.insert("caps".to_owned(), Value::from("none"));
    }
    if bool_prop(old_r_pr, "w:dstrike") {
        old.insert("dstrike".to_owned(), Value::Bool(true));
    }
    let ovanish = if on_off_of(old_r_pr, "w:specVanish") == Some(true) {
        None
    } else {
        on_off_of(old_r_pr, "w:vanish")
    };
    if let Some(ovanish) = ovanish {
        old.insert("vanishOwn".to_owned(), Value::Bool(ovanish));
    }
    if let Some(okern) = val(old_r_pr, "w:kern") {
        let kern = parse_int(okern, Radix::Ten);
        old.insert(
            "kernHalfPoints".to_owned(),
            num(if kern == 0.0 || kern.is_nan() {
                0.0
            } else {
                kern
            }),
        );
    }
    let opos = parse_int(val(old_r_pr, "w:position").unwrap_or(""), Radix::Ten);
    if opos != 0.0 && !opos.is_nan() {
        old.insert("positionHalfPoints".to_owned(), num(opos));
    }
    if let Some(fill) = truthy(
        old_r_pr
            .find_child("w:shd")
            .and_then(|shd| shd.attr("w:fill")),
    )
    .filter(|fill| *fill != "auto")
    {
        old.insert("shading".to_owned(), Value::from(strip_hash(fill)));
    }
    if let Some(ortl) = on_off_of(old_r_pr, "w:rtl") {
        old.insert("rtl".to_owned(), Value::Bool(ortl));
    }
    if let Some(oc) = &oc
        && theme.is_some()
        && truthy(
            old_r_pr
                .find_child("w:color")
                .and_then(|c| c.attr("w:themeColor")),
        )
        .is_some()
    {
        old.insert("themeColor".to_owned(), Value::from(oc.as_str()));
    }
    old
}
