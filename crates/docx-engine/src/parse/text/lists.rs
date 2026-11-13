//! The paragraph's list, heading level and style look, read off the document's
//! styles and numbering.

use jscompat::{JsMap, JsNum, Radix, js_regex, number_to_string, parse_int, truthy};
use ooxml_xml::XNode;
use serde::Serialize;

use crate::numbering::NumberingDef;
use crate::package::Thrown;
use crate::styles::{DocDefaults, NumPr, StyleDisplay, StyleInfo};

/// The members of `BuildContext` these readers take. `None` where the context
/// has no such member: the notes context has no numbering, a header's may have
/// no styles. The TypeScript throws where it calls a method of a missing one.
#[derive(Debug, Clone, Copy, Default)]
pub struct StyleCtx<'a> {
    pub styles: Option<&'a JsMap<StyleInfo>>,
    pub numbering: Option<&'a JsMap<NumberingDef>>,
    /// `numFormats`: numId to "bullet" or "ordered"
    pub num_formats: Option<&'a JsMap<&'static str>>,
    pub default_para_style: Option<&'a StyleInfo>,
    pub doc_defaults: Option<&'a DocDefaults>,
}

/// `undefined.get(...)`
fn missing<T>(member: Option<&JsMap<T>>) -> Result<&JsMap<T>, Thrown> {
    member
        .ok_or_else(|| "TypeError: Cannot read properties of undefined (reading 'get')".to_owned())
}

/// `attrsOf(findChild(node, name) ?? {})['w:val']`
fn child_val<'a>(node: &'a XNode, name: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr("w:val"))
}

/// The `{ numId, ilvl }` a paragraph's numbering reference is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaListRef {
    pub num_id: String,
    pub ilvl: JsNum,
}

/// `listRefOf`: the direct w:numPr, else the paragraph style's; numId "0"
/// is Word's explicit "no numbering".
pub fn list_ref_of(
    ctx: &StyleCtx<'_>,
    p_pr: Option<&XNode>,
    style_id: Option<&str>,
) -> Result<Option<ParaListRef>, Thrown> {
    let num_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:numPr"));
    let direct_num_id = num_pr.and_then(|num_pr| child_val(num_pr, "w:numId"));
    let direct_ilvl = num_pr.and_then(|num_pr| child_val(num_pr, "w:ilvl"));
    if direct_num_id == Some("0") {
        return Ok(None);
    }
    let style_num = match truthy(style_id) {
        Some(id) => missing(ctx.styles)?
            .get(id)
            .and_then(|style| style.num_pr.as_ref()),
        None => None,
    };
    let style_num_pr = match style_num {
        Some(NumPr::Num { num_id, ilvl }) => Some((num_id.as_str(), *ilvl)),
        Some(NumPr::None) | None => None,
    };
    let num_id = direct_num_id.or(style_num_pr.map(|(num_id, _)| num_id));
    let Some(num_id) = truthy(num_id) else {
        return Ok(None);
    };
    let ilvl = match direct_ilvl {
        Some(ilvl) => {
            let ilvl = parse_int(ilvl, Radix::Ten);
            // `|| 0`: NaN and -0 alike
            if ilvl == 0.0 || ilvl.is_nan() {
                0.0
            } else {
                ilvl
            }
        }
        None => style_num_pr.map_or(0.0, |(_, ilvl)| ilvl.0),
    };
    Ok(Some(ParaListRef {
        num_id: num_id.to_owned(),
        ilvl: JsNum(ilvl),
    }))
}

/// `listKindOf`: the level's own numFmt, else the w:num's classification.
pub fn list_kind_of(ctx: &StyleCtx<'_>, num_id: &str, ilvl: f64) -> Result<&'static str, Thrown> {
    let fmt = missing(ctx.numbering)?
        .get(num_id)
        .and_then(|def| def.levels.get(&number_to_string(ilvl)))
        .and_then(|level| level.num_fmt.as_deref());
    if let Some(fmt) = fmt {
        return Ok(if fmt == "bullet" { "bullet" } else { "ordered" });
    }
    Ok(missing(ctx.num_formats)?
        .get(num_id)
        .copied()
        .unwrap_or("bullet"))
}

/// `headingLevelOf`: a direct w:outlineLvl wins (9 is body text), then the
/// style's level, then a built-in HeadingN id the document never defined.
pub fn heading_level_of(
    p_pr: Option<&XNode>,
    style_id: Option<&str>,
    ctx: &StyleCtx<'_>,
) -> Result<Option<JsNum>, Thrown> {
    if let Some(direct) = p_pr.and_then(|p_pr| child_val(p_pr, "w:outlineLvl")) {
        let lvl = parse_int(direct, Radix::Ten);
        return Ok((0.0..=8.0).contains(&lvl).then_some(JsNum(lvl + 1.0)));
    }
    let Some(style_id) = truthy(style_id) else {
        return Ok(None);
    };
    if let Some(info) = missing(ctx.styles)?.get(style_id) {
        return Ok(info.heading_level);
    }
    Ok(js_regex!(r"^Heading([1-9])$", "i")
        .exec(style_id)
        .and_then(|found| found.get(1))
        .map(|digit| JsNum(parse_int(digit, Radix::Ten))))
}

/// `styleBidiOf`: the legacy reader's style-chain bidi, from the numbering
/// level, the paragraph style, then docDefaults.
pub fn style_bidi_of(
    ctx: &StyleCtx<'_>,
    style_id: Option<&str>,
    list_ref: Option<&ParaListRef>,
) -> Result<Option<bool>, Thrown> {
    let level_bidi = match list_ref {
        Some(list_ref) => missing(ctx.numbering)?
            .get(&list_ref.num_id)
            .and_then(|def| def.levels.get(&number_to_string(list_ref.ilvl.0)))
            .and_then(|level| *level.bidi),
        None => None,
    };
    let para_style = match truthy(style_id) {
        Some(id) => missing(ctx.styles)?.get(id),
        None => ctx.default_para_style,
    };
    Ok(level_bidi
        .or_else(|| {
            para_style
                .and_then(|style| style.display.as_ref())
                .and_then(|d| *d.bidi)
        })
        .or_else(|| ctx.doc_defaults.and_then(|d| *d.bidi)))
}

/// `WORD_DEFAULT_SIZE_HALF_POINTS`: Word's text size when neither docDefaults
/// nor the default style sets one.
const WORD_DEFAULT_SIZE_HALF_POINTS: f64 = 20.0;

/// `normalSizeHalfPoints`: the default paragraph style's size, else
/// docDefaults', else Word's.
pub fn normal_size_half_points(ctx: &StyleCtx<'_>) -> JsNum {
    ctx.default_para_style
        .and_then(|style| style.display.as_ref())
        .and_then(|d| *d.size_half_points)
        .or_else(|| ctx.doc_defaults.and_then(|d| *d.size_half_points))
        .unwrap_or(JsNum(WORD_DEFAULT_SIZE_HALF_POINTS))
}

/// `paraStyleDisplay`: the display of the paragraph's style, or of the
/// default paragraph style.
pub fn para_style_display<'a>(
    ctx: &StyleCtx<'a>,
    style_id: Option<&str>,
) -> Option<&'a StyleDisplay> {
    match truthy(style_id) {
        Some(id) => ctx.styles?.get(id),
        None => ctx.default_para_style,
    }?
    .display
    .as_ref()
}
