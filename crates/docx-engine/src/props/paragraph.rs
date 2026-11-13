//! Readers over a paragraph's XML text and node.

use std::borrow::Cow;

use jscompat::{JsNum, JsRegex, Radix, js_regex, math_round, parse_int, trim, trim_start};
use ooxml_pkg::canonical_xml_syntax;
use ooxml_xml::{XNode, mask_opaque, parse_ordered};
use serde::Serialize;

use crate::xml_tag::{TagName, find_start_tag, remove_segments};
use crate::xml_text::{EMU_PER_PX, decode_entities, on_off_of, plain_text};

/// `maxNestedTags` of the TypeScript engine's `xmlParser`.
pub const XML_PARSER_MAX_NESTED_TAGS: usize = 100;

/// No run un-hides itself and nothing anchors here (bookmarks, comments,
/// sectPr, drawings): safe to collapse a style-vanished paragraph entirely.
pub fn stays_vanished(xml: &str) -> bool {
    if js_regex!(
        r#"<w:vanish\s[^>]*w:val=(?:"(?:0|false|none|off)"|'(?:0|false|none|off)')"#,
        "i"
    )
    .test(xml)
    {
        return false;
    }
    !js_regex!(
        r"<w:(?:drawing|pict|object|sectPr|bookmarkStart|commentRangeStart|commentRangeEnd)[\s/>]"
    )
    .test(xml)
}

/// Every run of the paragraph is w:vanish (not specVanish). Runs inside
/// hyperlinks, fields and revisions count; w:pPr is skipped.
pub fn all_runs_vanished(node: &XNode) -> bool {
    for child in node.children() {
        match child.name() {
            Some("w:pPr" | "w:rPr") => {}
            Some("w:r") => {
                let vanished = child.find_child("w:rPr").is_some_and(|r_pr| {
                    on_off_of(r_pr, "w:vanish") == Some(true)
                        && on_off_of(r_pr, "w:specVanish") != Some(true)
                });
                if !vanished {
                    return false;
                }
            }
            _ => {
                if !all_runs_vanished(child) {
                    return false;
                }
            }
        }
    }
    true
}

/// Text-less run content that still affects layout (breaks, tabs, note marks,
/// symbol chars).
pub fn layout_run_content() -> &'static JsRegex {
    js_regex!(r"^w:(?:br|cr|tab|sym|footnoteReference|endnoteReference)$")
}

/// Layout run content other than line, page and column breaks.
pub fn layout_run_content_besides_breaks() -> &'static JsRegex {
    js_regex!(r"^w:(?:cr|tab|sym|footnoteReference|endnoteReference)$")
}

/// w:pPr is skipped so tab-stop definitions (w:tabs > w:tab) do not count.
pub fn has_layout_run_content(node: &XNode, pattern: &JsRegex) -> bool {
    node.children().iter().any(|child| match child.name() {
        Some("w:pPr" | "w:rPr") => false,
        name => {
            name.is_some_and(|name| pattern.test(name)) || has_layout_run_content(child, pattern)
        }
    })
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentMarkers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_starts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_ends: Option<Vec<String>>,
}

/// Comment ids where only one end of the range falls in this paragraph.
pub fn cross_para_comment_markers(xml: &str) -> CommentMarkers {
    let ids = |regex: &JsRegex| -> Vec<&str> {
        regex
            .find_iter(xml)
            .map(|found| found.get(1).unwrap_or(""))
            .collect()
    };
    let starts = ids(js_regex!(
        r#"<w:commentRangeStart\b[^>]*\bw:id\s*=\s*["']([^"']+)["']"#
    ));
    let ends = ids(js_regex!(
        r#"<w:commentRangeEnd\b[^>]*\bw:id\s*=\s*["']([^"']+)["']"#
    ));
    let only_in = |these: &[&str], those: &[&str]| -> Option<Vec<String>> {
        let only: Vec<String> = these
            .iter()
            .filter(|id| !those.contains(id))
            .map(|id| (*id).to_owned())
            .collect();
        (!only.is_empty()).then_some(only)
    };
    CommentMarkers {
        comment_starts: only_in(&starts, &ends),
        comment_ends: only_in(&ends, &starts),
    }
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkNames {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bookmarks: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_bookmarks: Option<Vec<String>>,
}

/// User bookmark names starting in this paragraph; Word internals (`_Toc`,
/// `_Ref`, `_GoBack`) split out as hidden.
pub fn bookmark_names_of(xml: &str) -> BookmarkNames {
    let mut names: Vec<String> = Vec::new();
    let mut hidden: Vec<String> = Vec::new();
    for found in
        js_regex!(r#"<w:bookmarkStart [^>]*w:name="([^"]+)""#).find_iter(&canonical_xml_syntax(xml))
    {
        let name = decode_entities(found.get(1).unwrap_or(""));
        let list = if name.starts_with('_') {
            &mut hidden
        } else {
            &mut names
        };
        if !list.contains(&name) {
            list.push(name);
        }
    }
    BookmarkNames {
        bookmarks: (!names.is_empty()).then_some(names),
        hidden_bookmarks: (!hidden.is_empty()).then_some(hidden),
    }
}

/// Exact `<w:pPr>...</w:pPr>` slice of a paragraph (depth-aware: pPrChange
/// nests another w:pPr inside). `None` when the paragraph has no properties.
pub fn raw_ppr_of(xml: &str) -> Option<&str> {
    // tags are found in the XML with its comments and CDATA blanked, so their
    // text is never a tag; the slice is of the XML itself
    let masked = mask_opaque(xml);
    // the paragraph's own pPr must be the first child of w:p
    let open_end = find_start_tag(&masked, TagName::Any, 0)?.end;
    let start = masked.len() - trim_start(&masked[open_end..]).len();
    if !masked[start..].starts_with("<w:pPr") {
        return None;
    }
    let mut depth = 0i64;
    let mut at = start;
    while let Some(found) = js_regex!(r"<w:pPr(?=[\s/>])|<\/w:pPr\s*>")
        .find_from(&masked, at)
        .next()
    {
        at = found.end();
        if found.as_str().starts_with("</") {
            depth -= 1;
            if depth == 0 {
                return Some(&xml[start..found.end()]);
            }
        } else {
            // self-closing <w:pPr/> never opens
            let tag = find_start_tag(&masked, TagName::Exact("w:pPr"), found.start());
            if let Some(tag) = tag.filter(|tag| tag.self_closing) {
                if depth == 0 {
                    return Some(&xml[start..tag.end]);
                }
                at = tag.end;
                continue;
            }
            depth += 1;
        }
    }
    None
}

/// A text-less anchored shape no taller than about 10px is almost always a
/// decorative horizontal rule.
pub fn is_thin_rule(xml: &str) -> bool {
    let xml = canonical_xml_syntax(xml);
    let Some(extent) = js_regex!(r#"<wp:extent cx="(\d+)" cy="(\d+)""#).exec(&xml) else {
        return false;
    };
    let cx = parse_int(extent.get(1).unwrap_or(""), Radix::Ten);
    let cy = parse_int(extent.get(2).unwrap_or(""), Radix::Ten);
    // Word writes plain horizontal lines with cy="0"
    cy <= 130_000.0 && (cy > 0.0 || cx > 0.0)
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_color_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_thickness_px: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_width_px: Option<JsNum>,
}

/// Stroke color and thickness (a:ln) plus extent width of a decorative rule drawing.
pub fn rule_display_of(source: &str) -> RuleDisplay {
    let xml = &*canonical_xml_syntax(source);
    let mut out = RuleDisplay::default();
    let first_group_as_int = |regex: &JsRegex, text: &str| {
        let digits = regex.exec(text).and_then(|found| found.get(1));
        parse_int(digits.unwrap_or(""), Radix::Ten)
    };
    if let Some(ln) = js_regex!(r"<a:ln\b[^>]*>[\s\S]*?<\/a:ln>").exec(xml) {
        let ln = ln.as_str();
        let color = js_regex!(r#"<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})""#)
            .exec(ln)
            .and_then(|found| found.get(1));
        if let Some(color) = color.filter(|color| !color.is_empty()) {
            out.rule_color_hex = Some(color.to_uppercase());
        }
        let w = first_group_as_int(js_regex!(r#"<a:ln\b[^>]*\bw="(\d+)""#), ln);
        if w.is_finite() && w > 0.0 {
            out.rule_thickness_px = Some(JsNum(1f64.max(math_round(w / EMU_PER_PX))));
        }
    }
    let cx = first_group_as_int(js_regex!(r#"<wp:extent cx="(\d+)""#), xml);
    if cx.is_finite() && cx > 0.0 {
        out.rule_width_px = Some(JsNum(math_round(cx / EMU_PER_PX)));
    }
    out
}

/// Converter artifact: every shape declares noFill and a noFill outline and
/// carries no picture, no text and no effects. Word renders nothing.
pub fn is_invisible_empty_shape(xml: &str) -> bool {
    if !xml.contains("<wps:wsp") || xml.contains("<a:blip") || !trim(&plain_text(xml)).is_empty() {
        return false;
    }
    let Ok(parsed) = parse_ordered(xml, XML_PARSER_MAX_NESTED_TAGS) else {
        return false;
    };
    let mut shapes = Vec::new();
    collect_nodes(&parsed, "wps:wsp", &mut shapes);
    if shapes.is_empty() {
        return false;
    }
    shapes.iter().all(|shape| {
        let Some(sp_pr) = shape.find_child("wps:spPr") else {
            return false;
        };
        if sp_pr.find_child("a:noFill").is_none() {
            return false;
        }
        if !sp_pr
            .find_child("a:ln")
            .is_some_and(|ln| ln.find_child("a:noFill").is_some())
        {
            return false;
        }
        sp_pr
            .find_child("a:effectLst")
            .is_none_or(|effects| effects.children().is_empty())
    })
}

/// Legacy VML pict that draws nothing: only shapetype definitions, hidden
/// shapes, or white strokeless placeholder rectangles.
pub fn is_invisible_vml_pict(source: &str) -> bool {
    let xml = &*canonical_xml_syntax(source);
    if !js_regex!(r"<v:(?:shapetype|shape|rect|roundrect|oval|line|polyline)\b").test(xml) {
        return false;
    }
    if xml.contains("<v:imagedata") || xml.contains("<w:txbxContent") {
        return false;
    }
    // no drawable instances at all (a shapetype-only pict) also renders nothing
    js_regex!(r"<v:(?:shape|rect|roundrect|oval|line|polyline)\b[^>]*>")
        .find_iter(xml)
        .all(|tag| {
            let tag = tag.as_str();
            let style = js_regex!(r#"style="([^"]*)""#)
                .exec(tag)
                .and_then(|found| found.get(1));
            if js_regex!(r"visibility:\s*hidden").test(style.unwrap_or("")) {
                return true;
            }
            let fill = js_regex!(r#"fillcolor="([^"]+)""#)
                .exec(tag)
                .and_then(|found| found.get(1))
                .map(|fill| trim(fill).to_lowercase());
            let unstroked = js_regex!(r#"\bstroked="(?:f|false|0)""#).test(tag);
            unstroked && matches!(fill.as_deref(), Some("white" | "#ffffff" | "#fff"))
        })
}

/// Drops textbox content so "does the paragraph itself have text" checks work.
pub fn strip_textboxes(xml: &str) -> Cow<'_, str> {
    if !xml.contains("<w:txbxContent") {
        return Cow::Borrowed(xml);
    }
    remove_segments(xml, "w:txbxContent")
}

/// Page-type w:br carried by the anchor paragraph itself (not inside box content).
pub fn host_page_break(xml: &str) -> bool {
    js_regex!(r#"<w:br\s[^>]*w:type="page""#).test(&strip_textboxes(xml))
}

/// w:tbl or w:sdt among the txbxContent children: the box must stay read-only.
pub fn txbx_has_structured_content(content: &XNode) -> bool {
    content
        .children()
        .iter()
        .any(|child| matches!(child.name(), Some("w:tbl" | "w:sdt")))
}

pub fn collect_nodes<'a>(nodes: &'a [XNode], name: &str, out: &mut Vec<&'a XNode>) {
    for node in nodes {
        if node.name() == Some(name) {
            out.push(node);
        }
        collect_nodes(node.children(), name, out);
    }
}

/// Like `collect_nodes`, but does not descend into a matched node.
pub fn collect_top_nodes<'a>(nodes: &'a [XNode], name: &str, out: &mut Vec<&'a XNode>) {
    for node in nodes {
        if node.name() == Some(name) {
            out.push(node);
            continue;
        }
        collect_top_nodes(node.children(), name, out);
    }
}

/// xml:space="preserve" declared on the part's root element. `root_tag` goes
/// into the pattern unescaped, as in the original.
pub fn part_xml_space_preserve(
    part_xml: &str,
    root_tag: &str,
) -> Result<bool, jscompat::RegexError> {
    let open_tag = jscompat::TryJsRegex::new(&format!(r"<{root_tag}(\s[^>]*)?>"), "")?;
    let attributes = open_tag
        .try_exec(part_xml)?
        .and_then(|found| found.get(1))
        .unwrap_or("");
    Ok(js_regex!(r#"\sxml:space=(?:"preserve"|'preserve')"#).test(attributes))
}

/// Exact `<w:ruby>` fragments in document order.
pub fn ruby_fragments_of(xml: &str) -> Vec<&str> {
    js_regex!(r"<w:ruby>[\s\S]*?<\/w:ruby>")
        .find_iter(xml)
        .map(|found| found.as_str())
        .collect()
}
