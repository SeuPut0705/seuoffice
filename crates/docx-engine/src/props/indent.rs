//! Tab stops, indents and the paragraph mark of an empty paragraph.

use jscompat::{JsNum, Radix, js_object, math_round, number_to_string, parse_int, truthy};
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::fonts::themed_r_fonts;
use crate::theme::ThemeFonts;
use crate::xml_text::on_off_of;

/// `JC_ALIGN[value]`
pub fn jc_align(value: &str) -> Option<&'static str> {
    Some(match value {
        "left" | "start" => "left",
        "center" => "center",
        "right" | "end" => "right",
        // kashida and Thai justification variants: plain justify
        "both" | "lowKashida" | "mediumKashida" | "highKashida" | "thaiDistribute" => "justify",
        "distribute" => "distribute",
        _ => return None,
    })
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct AutoSpaceFlags {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub de: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dn: Option<bool>,
}

/// w:autoSpaceDE (CJK and Latin letters) and w:autoSpaceDN (CJK and digits) as written.
pub fn auto_space_flags_of(p_pr: &XNode) -> AutoSpaceFlags {
    AutoSpaceFlags {
        de: on_off_of(p_pr, "w:autoSpaceDE"),
        dn: on_off_of(p_pr, "w:autoSpaceDN"),
    }
}

/// Which CJK auto-space gaps a paragraph gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AutoSpace {
    Both(bool),
    Only(&'static str),
}

/// The two switches folded into the renderer's mode; `None` when neither is written.
pub fn auto_space_mode(de: Option<bool>, dn: Option<bool>) -> Option<AutoSpace> {
    if de.is_none() && dn.is_none() {
        return None;
    }
    Some(match (de, dn) {
        (Some(false), Some(false)) => AutoSpace::Both(false),
        (Some(false), _) => AutoSpace::Only("digits"),
        (_, Some(false)) => AutoSpace::Only("latin"),
        _ => AutoSpace::Both(true),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabStop {
    pub pos: JsNum,
    pub val: String,
    /// Only a w:ptab stop has it, written before its leader.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "jscompat::wire::static_str_opt"
    )]
    pub rel: Option<jscompat::wire::StaticStr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader: Option<String>,
}

const TAB_LEADERS: [&str; 5] = ["dot", "hyphen", "underscore", "heavy", "middleDot"];

/// pPr `<w:tabs>` as tab stops.
pub fn tab_stops_of(p_pr: &XNode) -> Option<Vec<TabStop>> {
    let tabs = p_pr.find_child("w:tabs")?;
    let stops: Vec<TabStop> = tabs
        .find_children("w:tab")
        .filter_map(|tab| {
            let pos = parse_int(tab.attr("w:pos").unwrap_or(""), Radix::Ten);
            if !pos.is_finite() {
                return None;
            }
            let val = tab.attr("w:val").unwrap_or("left");
            let known = ["left", "center", "right", "decimal", "bar", "clear"].contains(&val);
            Some(TabStop {
                pos: JsNum(pos),
                val: if known { val } else { "left" }.to_owned(),
                leader: tab
                    .attr("w:leader")
                    .filter(|leader| TAB_LEADERS.contains(leader))
                    .map(str::to_owned),
                rel: None,
            })
        })
        .collect();
    (!stops.is_empty()).then_some(stops)
}

/// Display-only stops for the paragraph's w:ptab elements (left-aligned ones advance nothing).
pub fn ptab_display_stops(p_node: &XNode) -> Vec<TabStop> {
    fn walk(node: &XNode, out: &mut Vec<TabStop>) {
        for child in node.children() {
            match child.name() {
                Some("w:pPr") => {}
                Some("w:ptab") => {
                    let Some(align @ ("center" | "right")) = child.attr("w:alignment") else {
                        continue;
                    };
                    out.push(TabStop {
                        pos: JsNum(if align == "center" { 50.0 } else { 100.0 }),
                        val: align.to_owned(),
                        leader: child
                            .attr("w:leader")
                            .filter(|leader| TAB_LEADERS.contains(leader))
                            .map(str::to_owned),
                        rel: Some("margin"),
                    });
                }
                _ => walk(child, out),
            }
        }
    }
    let mut out = Vec::new();
    walk(p_node, &mut out);
    out
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndentTwips {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_line: Option<JsNum>,
}

fn int_attr(node: &XNode, key: &str, fallback_key: Option<&str>) -> f64 {
    let value = node
        .attr(key)
        .or_else(|| fallback_key.and_then(|key| node.attr(key)));
    parse_int(value.unwrap_or(""), Radix::Ten)
}

/// Twips attributes a w:ind specifies (hanging as a negative firstLine).
/// Explicit zeros are kept: a 0 cancels that component's inherited value.
pub fn indent_twips_of(ind: &XNode) -> IndentTwips {
    let finite = |value: f64| value.is_finite().then_some(JsNum(value));
    let first_line = int_attr(ind, "w:firstLine", None);
    let hanging = int_attr(ind, "w:hanging", None);
    IndentTwips {
        left: finite(int_attr(ind, "w:left", Some("w:start"))),
        right: finite(int_attr(ind, "w:right", Some("w:end"))),
        first_line: if hanging > 0.0 {
            Some(JsNum(-hanging))
        } else if first_line > 0.0 {
            Some(JsNum(first_line))
        } else if first_line.is_finite() || hanging.is_finite() {
            Some(JsNum(0.0))
        } else {
            None
        },
    }
}

js_object! {
    deserialize;
    /// Character-unit indents (`CharIndents`). The order of its keys follows
    /// the code that made it: `mergeCharIndents` spreads one and deletes keys.
    #[derive(Debug, Clone, PartialEq)]
    pub struct CharIndents {
        pub left: JsNum,
        pub right: JsNum,
        pub first_line: JsNum,
        pub hanging: JsNum,
    }
}

impl CharIndents {
    /// `Object.keys(chars).length > 0 ? chars : undefined`
    fn non_empty(self) -> Option<Self> {
        (!self.has_no_key()).then_some(self)
    }
}

/// Character-unit attributes a w:ind specifies. Zeros are kept: Word writes
/// `w:firstLineChars="0"` to say the indent is not character-based.
pub fn char_indents_of(ind: Option<&XNode>) -> Option<CharIndents> {
    let ind = ind?;
    let num = |key, fallback_key| {
        let value = int_attr(ind, key, fallback_key);
        value.is_finite().then_some(JsNum(value))
    };
    let not_negative = |value: Option<JsNum>| value.filter(|value| value.0 >= 0.0);
    let mut chars = CharIndents::default();
    chars
        .left
        .set_some(num("w:leftChars", Some("w:startChars")));
    chars
        .right
        .set_some(num("w:rightChars", Some("w:endChars")));
    chars
        .first_line
        .set_some(not_negative(num("w:firstLineChars", None)));
    chars
        .hanging
        .set_some(not_negative(num("w:hangingChars", None)));
    chars.non_empty()
}

/// Layers one w:ind's character-unit attributes over inherited ones: a *Chars
/// attribute, zero included, replaces its component. firstLineChars and
/// hangingChars are one component: setting either replaces both.
pub fn merge_char_indents(
    base: Option<CharIndents>,
    over: Option<CharIndents>,
) -> Option<CharIndents> {
    let (Some(base), Some(over)) = (&base, &over) else {
        return base.or(over);
    };
    let mut merged = base.clone();
    merged.left.set_some(*over.left);
    merged.right.set_some(*over.right);
    if over.first_line.is_some() || over.hanging.is_some() {
        merged.first_line.delete();
        merged.hanging.delete();
        merged.first_line.set_some(*over.first_line);
        merged.hanging.set_some(*over.hanging);
    }
    Some(merged)
}

/// The character indents that lay out: an explicit zero means "absolute" and drops out.
pub fn active_char_indents(chars: Option<&CharIndents>) -> Option<CharIndents> {
    let active = |value: Option<JsNum>| value.filter(|value| value.0 != 0.0 && !value.0.is_nan());
    let chars = chars?;
    let mut out = CharIndents::default();
    out.left.set_some(active(*chars.left));
    out.right.set_some(active(*chars.right));
    out.first_line.set_some(active(*chars.first_line));
    out.hanging.set_some(active(*chars.hanging));
    out.non_empty()
}

/// Twips of one "character" for each family of character-unit indents.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CharUnits {
    /// w:firstLineChars and w:hangingChars: the paragraph's first text run.
    /// `null` is the NaN `JSON.stringify` wrote.
    #[serde(deserialize_with = "nan_of_null")]
    pub run: f64,
    /// w:leftChars and w:rightChars: the default paragraph style's font size.
    #[serde(deserialize_with = "nan_of_null")]
    pub normal: f64,
}

fn nan_of_null<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Option::<f64>::deserialize(deserializer).map(|number| number.unwrap_or(f64::NAN))
}

fn number_field(format: &Map<String, Value>, key: &str) -> Option<f64> {
    format.get(key).and_then(Value::as_f64)
}

fn set_number(format: &mut Map<String, Value>, key: &str, value: f64) {
    format.insert(
        key.to_owned(),
        serde_json::to_value(JsNum(value)).unwrap_or(Value::Null),
    );
}

/// What `resolveCharIndents` does to `indentFirstLine`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FirstLineFold {
    Set(f64),
    /// `delete f.indentFirstLine`
    Delete,
    /// left as it was
    Keep,
}

/// What `resolveCharIndents` does to the three indent fields, in the order
/// it does it: `left` and `right` are `None` where the field is left as it was.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharIndentFold {
    pub left: Option<f64>,
    pub first_line: FirstLineFold,
    pub right: Option<f64>,
}

/// The core of [`resolve_char_indents`] over numbers, NaN and the infinities
/// as they are. `indent_first_line` is the format's `indentFirstLine`.
pub fn fold_char_indents(
    indent_first_line: Option<f64>,
    chars: &CharIndents,
    units: CharUnits,
) -> CharIndentFold {
    let twips = |hundredths: JsNum, unit: f64| math_round((hundredths.0 / 100.0) * unit);
    let twips_hanging = indent_first_line
        .filter(|value| *value < 0.0)
        .map_or(0.0, |value| -value);
    let twips_first = indent_first_line
        .filter(|value| *value > 0.0)
        .unwrap_or(0.0);
    let hanging = match (*chars.hanging, *chars.first_line) {
        (Some(hanging), _) => twips(hanging, units.run),
        (None, Some(_)) => 0.0,
        (None, None) => twips_hanging,
    };
    let first_line = if hanging > 0.0 {
        0.0
    } else {
        chars
            .first_line
            .map_or(twips_first, |first_line| twips(first_line, units.run))
    };
    let left = (chars.left.is_some() || chars.hanging.is_some()).then(|| {
        let ui_left = chars.left.map_or(0.0, |left| twips(left, units.normal));
        ui_left + hanging
    });
    let first_line = if hanging > 0.0 {
        FirstLineFold::Set(-hanging)
    } else if first_line > 0.0 {
        FirstLineFold::Set(first_line)
    } else if indent_first_line.is_some_and(|value| value != 0.0 && !value.is_nan()) {
        FirstLineFold::Delete
    } else {
        FirstLineFold::Keep
    };
    CharIndentFold {
        left,
        first_line,
        right: chars.right.map(|right| twips(right, units.normal)),
    }
}

/// Folds character-unit indents into the twips fields of a paragraph format,
/// the way Word lays them out. `format` is a `ParaFormat`: only its three
/// indent fields are read and written.
pub fn resolve_char_indents(
    format: Option<&Map<String, Value>>,
    chars: &CharIndents,
    units: CharUnits,
) -> Map<String, Value> {
    let mut f = format.cloned().unwrap_or_default();
    let fold = fold_char_indents(number_field(&f, "indentFirstLine"), chars, units);
    if let Some(left) = fold.left {
        set_number(&mut f, "indentLeft", left);
    }
    match fold.first_line {
        FirstLineFold::Set(first_line) => set_number(&mut f, "indentFirstLine", first_line),
        // not `remove`: that moves the last key into the place of the one removed
        FirstLineFold::Delete => {
            f.shift_remove("indentFirstLine");
        }
        FirstLineFold::Keep => {}
    }
    if let Some(right) = fold.right {
        set_number(&mut f, "indentRight", right);
    }
    f
}

/// w:sz governing a run-less paragraph's line height: the paragraph-mark rPr,
/// else the last run's rPr.
pub fn empty_para_size_half_points(
    p_node: &XNode,
    p_pr: Option<&XNode>,
    mark_only: bool,
    cs_size_half_points: Option<f64>,
) -> Option<f64> {
    // an rtl mark, or the mark of a bidi paragraph, is sized by its Cs twin, the
    // chain's szCs when it has none
    let bidi = p_pr.is_some_and(|p_pr| on_off_of(p_pr, "w:bidi") == Some(true));
    let size_of = |r_pr: Option<&XNode>, is_mark: bool| -> Option<String> {
        let r_pr = r_pr?;
        let val_of = |name| r_pr.find_child(name).and_then(|size| size.attr("w:val"));
        if (is_mark && bidi) || on_off_of(r_pr, "w:rtl") == Some(true) {
            return val_of("w:szCs")
                .map(str::to_owned)
                .or_else(|| cs_size_half_points.map(number_to_string));
        }
        val_of("w:sz").map(str::to_owned)
    };
    let mut size = p_pr.and_then(|p_pr| size_of(p_pr.find_child("w:rPr"), true));
    if truthy(size.as_deref()).is_none() && !mark_only {
        for run in p_node.find_children("w:r") {
            let value = size_of(run.find_child("w:rPr"), false);
            if truthy(value.as_deref()).is_some() {
                size = value;
            }
        }
    }
    let n = truthy(size.as_deref()).map_or(f64::NAN, |size| parse_int(size, Radix::Ten));
    (n.is_finite() && n > 0.0).then_some(n)
}

/// w:rFonts governing a run-less paragraph's line height: same sources as
/// `empty_para_size_half_points`.
pub fn empty_para_mark_font(
    p_node: &XNode,
    p_pr: Option<&XNode>,
    theme_fonts: Option<&ThemeFonts>,
    mark_only: bool,
) -> Option<String> {
    let empty = XNode::empty();
    let pick = |r_pr: Option<&XNode>| {
        let r_fonts = r_pr
            .and_then(|r_pr| r_pr.find_child("w:rFonts"))
            .unwrap_or(&empty);
        themed_r_fonts(r_fonts, theme_fonts).ascii
    };
    let mut font = p_pr.and_then(|p_pr| pick(p_pr.find_child("w:rPr")));
    if truthy(font.as_deref()).is_none() && !mark_only {
        for run in p_node.find_children("w:r") {
            let value = pick(run.find_child("w:rPr"));
            if truthy(value.as_deref()).is_some() {
                font = value;
            }
        }
    }
    font
}
