//! Field paragraphs (PAGE, TOC, REF, ...): the readers of
//! packages/docx-engine/src/parse-fields.ts that stand on no resolved
//! property chain.
//!
//! `fieldDisplayOf` and `applyTocEntryNumbers` are not here: the first calls
//! `resolveParagraphPropsXml` and `resolveRunProps` of resolve-props.ts, the
//! second `computeListMarkers` of list-markers.ts. The functions below that
//! read a resolved paragraph take it as a value ([`EffectivePPr`]).

use jscompat::{
    JsMap, JsNum, Radix, RegexError, TryJsRegex, js_regex, math_round, parse_int, trim,
};
use ooxml_xml::{XNode, parse_ordered};
use serde::Serialize;

use crate::props::XML_PARSER_MAX_NESTED_TAGS;
use crate::resolve::{EffectivePPr, PropSource, ResolveCtx};
use crate::styles::StyleInfo;

pub mod display;

/// `directParaGeometry`'s `Pick<FieldDisplay, ...>`.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaGeometry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first_line_twips: Option<JsNum>,
}

/// `directLineOf`'s `Pick<FieldDisplay, 'lineRule' | 'lineRawTwips' | 'lineSpacing'>`.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
}

/// `additiveSpacingOf`'s `Pick<FieldDisplay, 'additiveSpacing'>`.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdditiveSpacing {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additive_spacing: Option<bool>,
}

/// Parse a `<w:rPr>` XML slice to a node (`None` when absent or malformed).
pub fn r_pr_node_of(xml: &str) -> Option<XNode> {
    let found = js_regex!(r"<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>").exec(xml)?;
    parse_ordered(found.as_str(), XML_PARSER_MAX_NESTED_TAGS)
        .ok()?
        .into_iter()
        .find(|node| node.name() == Some("w:rPr"))
}

/// TOC entry level: styleId "TOC1" (Word) / "TOC 1" (Pages), or the style's
/// name "toc 1" when the styleId is opaque (html2docx exports numeric ids).
pub fn toc_level_of(style_id: &str, styles: Option<&JsMap<StyleInfo>>) -> Option<f64> {
    let name = styles
        .and_then(|styles| styles.get(style_id))
        .map_or("", |style| style.name.as_str());
    let found = js_regex!(r"^TOC ?([1-9])$", "i")
        .exec(style_id)
        .or_else(|| js_regex!(r"^toc ?([1-9])$", "i").exec(name));
    if let Some(found) = found {
        return Some(parse_int(found.get(1).unwrap_or(""), Radix::Ten));
    }
    // table-of-figures entries (TOC \c field results) are level-1 toc lines
    if js_regex!(r"^TableofFigures$", "i").test(style_id)
        || js_regex!(r"^table of figures$", "i").test(name)
    {
        return Some(1.0);
    }
    None
}

/// Attribute value of the first `tag` element that declares `name`, in either
/// quote. Both go into the pattern unescaped, as in the original.
pub fn tag_attr<'a>(xml: &'a str, tag: &str, name: &str) -> Result<Option<&'a str>, RegexError> {
    let pattern = TryJsRegex::new(&format!(r#"<{tag}\b[^>]*\s{name}=(["'])([^"']*)\1"#), "")?;
    Ok(pattern.try_exec(xml)?.and_then(|found| found.get(2)))
}

/// Direct paragraph geometry Word applies over the style: before/after spacing
/// and w:ind. Only direct-sourced values travel inline.
pub fn direct_para_geometry(eff: &EffectivePPr) -> ParaGeometry {
    let direct = |key: &str| eff.source.get(key) == Some(&PropSource::Direct);
    ParaGeometry {
        space_before_twips: direct("spaceBefore").then_some(eff.spacing.before),
        space_after_twips: direct("spaceAfter").then_some(eff.spacing.after),
        space_before_auto: (direct("spaceBeforeAuto") && eff.spacing.before_auto).then_some(true),
        space_after_auto: (direct("spaceAfterAuto") && eff.spacing.after_auto).then_some(true),
        indent_left_twips: direct("indentLeft").then_some(eff.indent.left),
        indent_right_twips: direct("indentRight").then_some(eff.indent.right),
        indent_first_line_twips: direct("indentFirstLine").then_some(eff.indent.first_line),
    }
}

/// Direct w:spacing line of the paragraph (OOXML defaults w:lineRule to auto).
pub fn direct_line_of(eff: &EffectivePPr) -> DirectLine {
    let Some(line) = &eff.spacing.line else {
        return DirectLine::default();
    };
    // `line.raw <= 0` is false for NaN, which goes on
    if eff.source.get("line") != Some(&PropSource::Direct) || line.raw.0 <= 0.0 {
        return DirectLine::default();
    }
    DirectLine {
        line_rule: Some(line.rule.clone()),
        line_raw_twips: Some(line.raw),
        line_spacing: (line.rule == "auto")
            .then(|| JsNum(math_round((line.raw.0 / 240.0) * 100.0) / 100.0)),
    }
}

/// Compat flag the renderer's spacing helper reads instead of its module global.
pub fn additive_spacing_of(ctx: &ResolveCtx) -> AdditiveSpacing {
    AdditiveSpacing {
        additive_spacing: ctx.compat.additive_para_spacing.then_some(true),
    }
}

/// Open fields after a paragraph's fldChars; an entry turns true past its separator.
pub fn field_stack_after(xml: &str, stack: &[bool]) -> Vec<bool> {
    let mut next = stack.to_vec();
    let fld_char = js_regex!(
        r#"<w:fldChar\b[^>]*\bw:fldCharType=(?:"(begin|separate|end)"|'(begin|separate|end)')"#
    );
    for found in fld_char.find_iter(xml) {
        match found.get(1).or_else(|| found.get(2)) {
            Some("begin") => next.push(false),
            Some("separate") => {
                if let Some(last) = next.last_mut() {
                    *last = true;
                }
            }
            _ => {
                next.pop();
            }
        }
    }
    next
}

/// Word hides a paragraph mark inside field code (begin..separate): the paragraphs join.
pub fn mark_inside_field_code(stack: &[bool]) -> bool {
    stack.last().is_some_and(|past_separator| !past_separator)
}

fn field_label_of(keyword: &str) -> Option<&'static str> {
    Some(match keyword {
        "TOC" => "Auto TOC (updates when opened in Word)",
        "PAGE" => "Page number field",
        "NUMPAGES" => "Page count field",
        "PAGEREF" => "Page reference field",
        "REF" => "Cross-reference field",
        "SEQ" => "Caption number field",
        "HYPERLINK" => "Hyperlink field",
        "DATE" => "Date field",
        "TIME" => "Time field",
        "INCLUDEPICTURE" => "Linked picture field",
        "STYLEREF" => "Style reference field",
        _ => return None,
    })
}

/// A paragraph whose only field machinery closes a field begun earlier (TOC
/// end split off into its own paragraph); Word lays an empty line.
pub fn lone_field_end(xml: &str) -> bool {
    let ends = js_regex!(r#"fldCharType=["']end["']"#)
        .find_iter(xml)
        .count();
    ends == 1
        && !js_regex!(r#"fldCharType=["'](?:begin|separate)["']"#).test(xml)
        && !xml.contains("<w:instrText")
        && !xml.contains("<w:fldSimple")
        && !xml.contains("<w:drawing")
        && !xml.contains("<w:pict")
        && !xml.contains("<w:object")
        && !js_regex!(r"<w:(?:tab|br|cr)\b")
            .test(&js_regex!(r"<w:tabs>[\s\S]*?<\/w:tabs>").replace_all(xml, |_| String::new()))
}

/// Human-readable label for a protected field paragraph, based on its field code.
pub fn field_label(xml: &str) -> String {
    let instr = js_regex!(r"<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>")
        .exec(xml)
        .and_then(|found| found.get(1))
        .or_else(|| {
            js_regex!(r#"<w:fldSimple[^>]*w:instr="([^"]*)""#)
                .exec(xml)
                .and_then(|found| found.get(1))
        })
        .unwrap_or("");
    let keyword = js_regex!(r"\s+")
        .split(trim(instr))
        .first()
        .map_or_else(String::new, |first| first.to_uppercase());
    if !keyword.is_empty() {
        if let Some(label) = field_label_of(&keyword) {
            return label.to_owned();
        }
        return format!("Field ({keyword})");
    }
    // No field code in this paragraph: it only closes a field started earlier
    // (e.g. the paragraph holding the TOC's fldChar end + page break).
    let has_end = xml.contains(r#"fldCharType="end""#) || xml.contains("fldCharType='end'");
    let has_begin = xml.contains(r#"fldCharType="begin""#) || xml.contains("fldCharType='begin'");
    if has_end && !has_begin {
        return if xml.contains(r#"w:type="page""#) {
            "Field end marker + page break"
        } else {
            "Field end marker"
        }
        .to_owned();
    }
    "Field (TOC/page number/etc.)".to_owned()
}
