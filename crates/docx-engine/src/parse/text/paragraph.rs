//! What a paragraph reads of its context: the resolver, the format of its
//! w:pPr, character-unit indents, anchor lines and rule overlays.

use std::borrow::Cow;

use jscompat::{JsMap, JsNum, Radix, js_regex, math_round, parse_int, truthy};
use ooxml_xml::XNode;
use serde_json::{Map, Value};

use super::context::{BuildContext, ShadowDiff};
use super::convert::{assign, json, model_of, num};
use super::format::frame_box_of;
use super::format::para_frame_of;
use super::lists::{heading_level_of, normal_size_half_points, para_style_display};
use super::runs::RunResolve;
use crate::drawing_geometry::anchor::{drawing_anchor_meta, top_level_drawings};
use crate::model::{self, ParaFormat, RuleOverlay, Run};
use crate::package::Thrown;
use crate::props::{
    CharUnits, active_char_indents, auto_space_flags_of, auto_space_mode, char_indents_of,
    empty_para_mark_font, empty_para_size_half_points, indent_twips_of, is_thin_rule, jc_align,
    merge_char_indents, para_border_sides_of, para_borders_of, resolve_char_indents,
    rule_display_of, shd_display_fill, tab_stops_of,
};
use crate::resolve::{
    self, EffectivePPr, ResolveCtx, ResolveParaOptions, TableCond, TableCtx, direct_para_format,
    resolve_paragraph_props, resolve_paragraph_props_xml, shadow_compare,
};
use crate::styles::{StyleDisplay, para_cs_format};
use crate::theme::ThemeColors;
use crate::xml_text::{EMU_PER_PX, line_twips_of, on_off_of, strip_hash};

/// `ParaResolve`: a paragraph resolved for its runs.
pub struct ParaResolve<'a> {
    pub eff: &'a EffectivePPr,
    pub rctx: &'a ResolveCtx,
}

/// `resolverOf`
pub fn resolver_of<'a>(ctx: &'a BuildContext<'_>) -> &'a ResolveCtx {
    &ctx.resolver
}

/// `cellResolverOf`: the document resolver scoped to a table's cells. The
/// style and numbering definitions stay shared with the document's: only the
/// table conditions are the cell's own.
pub fn cell_resolver_of(
    ctx: &BuildContext<'_>,
    table_style_id: Option<&str>,
    cond: &[TableCond],
) -> ResolveCtx {
    let mut scoped = (*ctx.resolver).clone();
    scoped.table = Some(TableCtx {
        style_id: truthy(table_style_id).map(str::to_owned),
        cond: Some(cond.to_vec()),
    });
    scoped
}

/// `runResolveOf`
pub fn run_resolve_of<'a>(
    ctx: &'a BuildContext<'_>,
    p_node: &XNode,
    para: Option<&ParaResolve<'a>>,
) -> Result<RunResolve<'a>, Thrown> {
    let rctx = para.map_or(&*ctx.resolver, |para| para.rctx);
    let eff: Cow<'a, EffectivePPr> = match para {
        Some(para) => Cow::Borrowed(para.eff),
        None => Cow::Owned(resolve_paragraph_props(
            p_node.find_child("w:pPr"),
            rctx,
            ResolveParaOptions::default(),
        )?),
    };
    let para_style = match truthy(eff.style_id.as_deref()) {
        Some(id) => rctx.styles.get(id),
        None => rctx.default_para_style(),
    };
    let para_rtl = para_style
        .and_then(|style| style.display.as_ref())
        .and_then(|display| *display.rtl)
        .or_else(|| rctx.doc_defaults.as_ref().and_then(|d| *d.rtl));
    Ok(RunResolve {
        eff,
        rctx,
        memo: JsMap::new(),
        para_rtl,
        diff: ctx.resolve_diff.clone(),
    })
}

/// `outlineOnlyHeading`: heading level owed to a direct w:outlineLvl alone.
pub fn outline_only_heading(
    p_pr: Option<&XNode>,
    style_id: Option<&str>,
    ctx: &BuildContext<'_>,
) -> Result<bool, Thrown> {
    let Some(p_pr) = p_pr else { return Ok(false) };
    if p_pr.find_child("w:outlineLvl").is_none() {
        return Ok(false);
    }
    Ok(heading_level_of(None, style_id, &ctx.style_ctx())?.is_none())
}

/// `inheritedCsFont`: the w:cs face of a run without its own: character
/// style, paragraph style (or the default one), then docDefaults.
pub fn inherited_cs_font(
    r_style_id: Option<&str>,
    p_style_id: Option<&str>,
    ctx: &BuildContext<'_>,
) -> Option<String> {
    let styles = &ctx.resolver.styles;
    let para = match truthy(p_style_id) {
        Some(id) => styles.get(id),
        None => ctx.resolver.default_para_style(),
    };
    let from = |style: Option<&crate::styles::StyleInfo>| -> Option<String> {
        style
            .and_then(|style| style.display.as_ref())
            .and_then(|display| (*display.cs_font).clone())
    };
    truthy(r_style_id)
        .and_then(|id| from(styles.get(id)))
        .or_else(|| from(para))
        .or_else(|| ctx.doc_defaults().and_then(|d| (*d.cs_font).clone()))
}

/// `paraCsSize`: the Cs size an rtl paragraph mark falls back to.
pub fn para_cs_size(ctx: &BuildContext<'_>, style_id: Option<&str>) -> JsNum {
    let display: Option<&StyleDisplay> = para_style_display(&ctx.style_ctx(), style_id);
    para_cs_format(display, ctx.doc_defaults()).size_half_points
}

/// `paraTextSizeHalfPoints`: the size of the paragraph's first text run:
/// explicit w:sz, else its character style, else the paragraph mark of an
/// empty paragraph, else the paragraph style, else Normal.
pub fn para_text_size_half_points(
    ctx: &BuildContext<'_>,
    runs: &[Run],
    p_node: &XNode,
    p_pr: Option<&XNode>,
    style_id: Option<&str>,
) -> JsNum {
    let styles = &ctx.resolver.styles;
    let size_of = |style: Option<&crate::styles::StyleInfo>| -> Option<JsNum> {
        style
            .and_then(|style| style.display.as_ref())
            .and_then(|display| *display.size_half_points)
    };
    let style_size = match truthy(style_id) {
        Some(id) => size_of(styles.get(id)),
        None => size_of(ctx.default_para_style()),
    };
    let first = runs
        .iter()
        .find(|run| run.text.as_deref().is_some_and(|text| !text.is_empty()));
    let from_first = first.and_then(|first| {
        (*first.size_half_points)
            .or_else(|| truthy(first.style_id.as_deref()).and_then(|id| size_of(styles.get(id))))
    });
    from_first
        .or_else(|| {
            if first.is_some() {
                None
            } else {
                empty_para_size_half_points(
                    p_node,
                    p_pr,
                    false,
                    Some(para_cs_size(ctx, style_id).0),
                )
                .map(JsNum)
            }
        })
        .or(style_size)
        .unwrap_or_else(|| normal_size_half_points(&ctx.style_ctx()))
}

/// `charUnitsOf`: twips per "character" for a paragraph's character-unit indents.
pub fn char_units_of(
    ctx: &BuildContext<'_>,
    runs: &[Run],
    p_node: &XNode,
    p_pr: Option<&XNode>,
    style_id: Option<&str>,
    doc_offset: Option<usize>,
) -> CharUnits {
    let grid = doc_offset
        .and_then(|offset| ctx.section_at.as_ref().map(|section| section.at(offset)))
        .and_then(|section| section.doc_grid);
    let grid_delta = match &grid {
        Some(grid)
            if grid.r#type == model::DocGridType::LinesAndChars
                && grid
                    .char_space
                    .is_some_and(|space| space.0 != 0.0 && !space.0.is_nan()) =>
        {
            (grid.char_space.map_or(0.0, |space| space.0) / 4096.0) * 20.0
        }
        _ => 0.0,
    };
    let normal = normal_size_half_points(&ctx.style_ctx());
    let first = runs
        .iter()
        .find(|run| run.text.as_deref().is_some_and(|text| !text.is_empty()));
    let run = para_text_size_half_points(ctx, runs, p_node, p_pr, style_id);
    CharUnits {
        run: run.0 * 10.0
            + first
                .and_then(|f| *f.char_spacing_twips)
                .map_or(0.0, |t| t.0)
            + grid_delta,
        normal: normal.0 * 10.0 + grid_delta,
    }
}

/// `withCharIndents`: fold a paragraph's character-unit indents (the style
/// chain's under the direct w:ind *Chars) into the format's twips fields.
#[allow(clippy::too_many_arguments)]
pub fn with_char_indents(
    format: Option<ParaFormat>,
    ctx: &BuildContext<'_>,
    p_node: &XNode,
    p_pr: Option<&XNode>,
    style_id: Option<&str>,
    runs: &[Run],
    list: bool,
    doc_offset: Option<usize>,
) -> Result<Option<ParaFormat>, Thrown> {
    let direct = char_indents_of(p_pr.and_then(|p_pr| p_pr.find_child("w:ind")));
    let style = if list {
        None
    } else {
        let styles = &ctx.resolver.styles;
        match truthy(style_id) {
            Some(id) => styles.get(id),
            None => ctx.default_para_style(),
        }
        .and_then(|style| style.display.as_ref())
        .and_then(|display| (*display.indent_chars).clone())
    };
    let chars = active_char_indents(merge_char_indents(style, direct.clone()).as_ref());
    let Some(chars) = chars else {
        return Ok(format);
    };
    let format_map = format
        .as_ref()
        .map(|format| super::convert::into_map(json(format)));
    let units = char_units_of(ctx, runs, p_node, p_pr, style_id, doc_offset);
    let mut out = resolve_char_indents(format_map.as_ref(), &chars, units);
    // the save path cancels these when it rebuilds w:ind in twips
    out.insert("charIndents".to_owned(), json(&chars));
    // the editor's direct-formatting mirror: only what the paragraph's own w:ind declares
    if let Some(direct) = &direct {
        out.insert("directCharIndents".to_owned(), json(direct));
    }
    Ok(Some(model_of(Value::Object(out))?))
}

/// `pPrOnlyFormat`: the w:pPr keys the resolver does not model (shading,
/// borders, tab stops, frames, flow).
pub fn ppr_only_format_map(p_pr: &XNode, theme: Option<&ThemeColors>) -> Map<String, Value> {
    let mut format = Map::new();
    let shd = p_pr.find_child("w:shd");
    if let Some(shd) = shd {
        let fill = shd.attr("w:fill");
        if let Some(fill) = truthy(fill).filter(|fill| *fill != "auto") {
            format.insert("shadingFill".to_owned(), Value::from(strip_hash(fill)));
        }
        // pattern shading (pctNN/stripes): white text on w:shd pct70 was invisible with the fill-only read
        let display = shd_display_fill(Some(shd), theme);
        let shading_fill = format
            .get("shadingFill")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match truthy(display.as_deref()) {
            Some(display) => {
                if Some(display) != shading_fill.as_deref() {
                    format.insert("shadingDisplay".to_owned(), Value::from(display));
                }
            }
            None => {
                format.insert("shadingClear".to_owned(), Value::Bool(true));
            }
        }
    }
    if let Some(sides) = para_border_sides_of(p_pr, theme) {
        assign(
            &mut format,
            super::convert::into_map(json(&para_borders_of(&sides))),
        );
    }
    if let Some(stops) = tab_stops_of(p_pr) {
        format.insert("tabStops".to_owned(), json(&stops));
    }
    if let Some(frame_box) = frame_box_of(p_pr) {
        format.insert("frameBox".to_owned(), json(&frame_box));
    }
    // Drop cap: w:framePr w:dropCap="drop"|"margin"
    if let Some(frame_pr) = p_pr.find_child("w:framePr") {
        match frame_pr.attr("w:dropCap") {
            Some(kind @ ("drop" | "margin")) => {
                let lines = parse_int(frame_pr.attr("w:lines").unwrap_or("3"), Radix::Ten);
                let lines = if lines == 0.0 || lines.is_nan() {
                    3.0
                } else {
                    lines
                };
                let mut cap = Map::new();
                cap.insert("type".to_owned(), Value::from(kind));
                cap.insert("lines".to_owned(), num(lines));
                format.insert("dropCap".to_owned(), Value::Object(cap));
            }
            _ => {
                if let Some(frame) = para_frame_of(frame_pr) {
                    format.insert("frame".to_owned(), json(&frame));
                }
            }
        }
    }
    let flow = p_pr
        .find_child("w:textDirection")
        .and_then(|child| child.attr("w:val"));
    if let Some(flow @ ("tbRl" | "tbRlV" | "btLr")) = flow {
        format.insert("textDirection".to_owned(), Value::from(flow));
    }
    format
}

/// `pPrOnlyFormat` as the model type.
pub fn ppr_only_format(p_pr: &XNode, theme: Option<&ThemeColors>) -> Result<ParaFormat, Thrown> {
    model_of(Value::Object(ppr_only_format_map(p_pr, theme)))
}

/// `extractParaFormat`: the direct format of a w:pPr (the legacy reader).
/// `style_bidi` is the w:bidi of the paragraph's style chain.
pub fn extract_para_format_map(
    p_pr: &XNode,
    theme: Option<&ThemeColors>,
    style_bidi: Option<bool>,
) -> Option<Map<String, Value>> {
    let mut format = Map::new();
    let bidi_own = on_off_of(p_pr, "w:bidi");
    if bidi_own == Some(true) {
        format.insert("bidi".to_owned(), Value::Bool(true));
    } else if bidi_own.is_none() && style_bidi == Some(true) {
        format.insert("bidiInherited".to_owned(), Value::Bool(true));
    }
    let jc = p_pr
        .find_child("w:jc")
        .and_then(|child| child.attr("w:val"));
    if let Some(align) = truthy(jc).and_then(jc_align) {
        format.insert("align".to_owned(), Value::from(align));
    }
    // Word quirk: in bidi paragraphs w:jc left/right are logical values (start/end)
    if format.contains_key("bidi") || format.contains_key("bidiInherited") {
        let swapped = match format.get("align").and_then(Value::as_str) {
            Some("left") => Some("right"),
            Some("right") => Some("left"),
            _ => None,
        };
        if let Some(swapped) = swapped {
            format.insert("align".to_owned(), Value::from(swapped));
        }
    }
    if let Some(spacing) = p_pr.find_child("w:spacing") {
        let attr = |name: &str| spacing.attr(name);
        let rule = attr("w:lineRule").unwrap_or("auto");
        let line = line_twips_of(attr("w:line"));
        if line > 0.0 {
            format.insert("lineRawTwips".to_owned(), num(line));
            if rule == "auto" {
                format.insert(
                    "lineSpacing".to_owned(),
                    num(math_round((line / 240.0) * 100.0) / 100.0),
                );
                format.insert("lineRule".to_owned(), Value::from("auto"));
            } else {
                format.insert("lineRule".to_owned(), Value::from(rule));
            }
        } else if line == 0.0 && rule == "atLeast" {
            // w:line="0" atLeast: opts the paragraph out of docGrid snapping
            format.insert("lineRule".to_owned(), Value::from("atLeast"));
            format.insert("lineRawTwips".to_owned(), num(0.0));
        }
        let auto_of = |value: Option<&str>| value.map(|v| v == "1" || v == "true");
        if let Some(auto) = auto_of(attr("w:beforeAutospacing")) {
            format.insert("spaceBeforeAuto".to_owned(), Value::Bool(auto));
        }
        if let Some(auto) = auto_of(attr("w:afterAutospacing")) {
            format.insert("spaceAfterAuto".to_owned(), Value::Bool(auto));
        }
        let before = parse_int(attr("w:before").unwrap_or(""), Radix::Ten);
        if before >= 0.0 && attr("w:before").is_some() {
            format.insert("spaceBefore".to_owned(), num(before));
        }
        let after = parse_int(attr("w:after").unwrap_or(""), Radix::Ten);
        if after >= 0.0 && attr("w:after").is_some() {
            format.insert("spaceAfter".to_owned(), num(after));
        }
    }
    if let Some(ind) = p_pr.find_child("w:ind") {
        let twips = indent_twips_of(ind);
        if let Some(left) = twips.left {
            format.insert("indentLeft".to_owned(), json(&left));
        }
        if let Some(right) = twips.right {
            format.insert("indentRight".to_owned(), json(&right));
        }
        if let Some(first_line) = twips.first_line {
            format.insert("indentFirstLine".to_owned(), json(&first_line));
        }
    }
    for (name, key) in [
        ("w:pageBreakBefore", "pageBreakBefore"),
        ("w:keepNext", "keepNext"),
        ("w:keepLines", "keepLines"),
        ("w:suppressLineNumbers", "suppressLineNumbers"),
    ] {
        if let Some(on) = on_off_of(p_pr, name) {
            format.insert(key.to_owned(), Value::Bool(on));
        }
    }
    // snapToGrid: default ON; only store when explicitly set to OFF
    if on_off_of(p_pr, "w:snapToGrid") == Some(false) {
        format.insert("snapToGrid".to_owned(), Value::Bool(false));
    }
    if let Some(on) = on_off_of(p_pr, "w:widowControl") {
        format.insert("widowControl".to_owned(), Value::Bool(on));
    }
    if let Some(on) = on_off_of(p_pr, "w:contextualSpacing") {
        format.insert("contextualSpacing".to_owned(), Value::Bool(on));
    }
    let auto_space = auto_space_flags_of(p_pr);
    if let Some(de) = auto_space.de {
        format.insert("autoSpaceDE".to_owned(), Value::Bool(de));
    }
    if let Some(dn) = auto_space.dn {
        format.insert("autoSpaceDN".to_owned(), Value::Bool(dn));
    }
    if let Some(mode) = auto_space_mode(auto_space.de, auto_space.dn) {
        format.insert("autoSpace".to_owned(), json(&mode));
    }
    if let Some(on) = on_off_of(p_pr, "w:wordWrap") {
        format.insert("wordWrap".to_owned(), Value::Bool(on));
    }
    if let Some(on) = on_off_of(p_pr, "w:overflowPunct") {
        format.insert("overflowPunct".to_owned(), Value::Bool(on));
    }
    assign(&mut format, ppr_only_format_map(p_pr, theme));
    (!format.is_empty()).then_some(format)
}

/// `extractParaFormat` as the model type.
pub fn extract_para_format(
    p_pr: &XNode,
    theme: Option<&ThemeColors>,
    style_bidi: Option<bool>,
) -> Result<Option<ParaFormat>, Thrown> {
    extract_para_format_map(p_pr, theme, style_bidi)
        .map(|map| model_of(Value::Object(map)))
        .transpose()
}

/// `resolvedParaFormat`: the paragraph's direct ParaFormat off the resolver,
/// plus the w:pPr-only keys.
pub fn resolved_para_format_map(
    eff: &EffectivePPr,
    p_pr: Option<&XNode>,
    theme: Option<&ThemeColors>,
) -> Option<Map<String, Value>> {
    let mut format = super::convert::into_map(json(&direct_para_format(eff)));
    if let Some(p_pr) = p_pr {
        assign(&mut format, ppr_only_format_map(p_pr, theme));
    }
    (!format.is_empty()).then_some(format)
}

/// `resolvedParaFormat` as the model type.
pub fn resolved_para_format(
    eff: &EffectivePPr,
    p_pr: Option<&XNode>,
    theme: Option<&ThemeColors>,
) -> Result<Option<ParaFormat>, Thrown> {
    resolved_para_format_map(eff, p_pr, theme)
        .map(|map| model_of(Value::Object(map)))
        .transpose()
}

/// `styleBidiOf(ctx, ...)`
pub fn style_bidi_of_ctx(
    ctx: &BuildContext<'_>,
    style_id: Option<&str>,
    list_ref: Option<&super::ParaListRef>,
) -> Result<Option<bool>, Thrown> {
    super::style_bidi_of(&ctx.style_ctx(), style_id, list_ref)
}

/// `shadowParaFormat`: shadow mode reads the paragraph's own w:pPr through
/// the legacy reader and records where it disagrees with the resolver's
/// direct view. No effect on the parsed model; a no-op unless shadow mode is on.
pub fn shadow_para_format(
    ctx: &BuildContext<'_>,
    surface: &'static str,
    p_pr: Option<&XNode>,
    style_bidi: Option<bool>,
    resolved: Option<&ParaFormat>,
    runs: &[Run],
) -> Result<(), Thrown> {
    let map = resolved.map(|format| super::convert::into_map(json(format)));
    shadow_para_format_map(ctx, surface, p_pr, style_bidi, map.as_ref(), runs)
}

/// `shadowParaFormat` over the format as the JSON object it is built as.
pub fn shadow_para_format_map(
    ctx: &BuildContext<'_>,
    surface: &'static str,
    p_pr: Option<&XNode>,
    style_bidi: Option<bool>,
    resolved: Option<&Map<String, Value>>,
    runs: &[Run],
) -> Result<(), Thrown> {
    let Some(collector) = &ctx.resolve_diff else {
        return Ok(());
    };
    let empty = XNode::empty();
    let legacy = extract_para_format_map(
        p_pr.unwrap_or(&empty),
        ctx.resolver.theme_colors.as_ref(),
        style_bidi,
    )
    .map(Value::Object);
    let resolved = resolved.map(|map| Value::Object(map.clone()));
    let diffs = shadow_compare(legacy.as_ref(), resolved.as_ref(), None);
    if diffs.is_empty() {
        return Ok(());
    }
    let joined: String = runs
        .iter()
        .map(|run| run.text.as_deref().unwrap_or(""))
        .collect();
    let units: Vec<u16> = joined.encode_utf16().take(40).collect();
    let text = String::from_utf16_lossy(&units);
    for diff in diffs {
        collector.borrow_mut().push(ShadowDiff {
            surface,
            key: diff.key,
            old: diff.old,
            eff: diff.eff,
            text: text.clone(),
        });
    }
    Ok(())
}

/// `anchorLineOf`: the paragraph's own empty line, kept beside a side-wrapped
/// picture (or under an invisible pict) and sized by the paragraph mark alone.
pub fn anchor_line_of(
    xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Option<model::BlockAnchorLine>, Thrown> {
    let Ok(parsed) = crate::package::parse_part(xml) else {
        return Ok(None);
    };
    let Some(p_node) = parsed.iter().find(|node| node.name() == Some("w:p")) else {
        return Ok(None);
    };
    let p_pr = p_node.find_child("w:pPr");
    let style_id = p_pr
        .and_then(|p_pr| p_pr.find_child("w:pStyle"))
        .and_then(|child| child.attr("w:val"));
    let mut format: Option<Map<String, Value>> =
        p_pr.and_then(|p_pr| extract_para_format_map(p_pr, None, None));
    // the mark's own size (w:szCs for an rtl mark) sizes the empty line
    let mark = resolve_paragraph_props(p_pr, &ctx.resolver, ResolveParaOptions::default())?.mark;
    if mark.source.get("sizeHalfPoints") == Some(&resolve::PropSource::Direct) {
        format.get_or_insert_with(Map::new).insert(
            "emptyRunSizeHalfPoints".to_owned(),
            json(&mark.size_half_points),
        );
    }
    if let Some(font) = empty_para_mark_font(p_node, p_pr, ctx.resolver.theme_fonts.as_ref(), true)
    {
        format
            .get_or_insert_with(Map::new)
            .insert("emptyRunFontFamily".to_owned(), Value::from(font));
    }
    let clear = js_regex!(r#"<w:br\b[^>]*\bw:clear="(all|left|right)""#)
        .exec(xml)
        .and_then(|found| found.get(1));
    let mut line = Map::new();
    if let Some(style_id) = truthy(style_id) {
        line.insert("styleId".to_owned(), Value::from(style_id));
    }
    if let Some(format) = format {
        line.insert("format".to_owned(), Value::Object(format));
    }
    if let Some(clear) = clear {
        line.insert("clear".to_owned(), Value::from(clear));
    }
    Ok(Some(model_of(Value::Object(line))?))
}

/// `strayAnchorLine`: the anchor line of a stray textbox paragraph with the
/// style chain's tab stops merged in.
pub fn stray_anchor_line(
    xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Option<model::BlockAnchorLine>, Thrown> {
    let Some(line) = anchor_line_of(xml, ctx)? else {
        return Ok(None);
    };
    let style = line
        .style_id
        .as_deref()
        .and_then(|id| ctx.resolver.styles.get(id))
        .and_then(|style| style.display.as_ref());
    let Some(style) = style else {
        return Ok(Some(line));
    };
    let mut line_json = super::convert::into_map(json(&line));
    let mut format = line_json
        .get("format")
        .cloned()
        .map(super::convert::into_map)
        .unwrap_or_default();
    let style_stops = &*style.tab_stops;
    if style_stops.as_ref().is_some_and(|stops| !stops.is_empty()) {
        let style_stops = style_stops.clone().unwrap_or_default();
        let direct: Vec<Value> = format
            .get("tabStops")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pos_of = |value: &Value| value.get("pos").cloned();
        let mut merged: Vec<Value> = style_stops
            .iter()
            .map(json)
            .filter(|stop| !direct.iter().any(|d| pos_of(d) == pos_of(stop)))
            .collect();
        merged.extend(
            direct
                .into_iter()
                .filter(|stop| stop.get("val").and_then(Value::as_str) != Some("clear")),
        );
        format.insert("tabStops".to_owned(), Value::Array(merged));
    }
    // stops are margin-relative: the tab grid needs the effective left indent, style-inherited included
    if !format.contains_key("indentLeft")
        && let Some(left) = *style.indent_left_twips
    {
        format.insert("indentLeft".to_owned(), json(&left));
    }
    line_json.insert("format".to_owned(), Value::Object(format));
    Ok(Some(model_of(Value::Object(line_json))?))
}

/// `anchoredRuleOverlays`: the anchored thin lines a text paragraph carries,
/// positioned from the column left and the paragraph top.
pub fn anchored_rule_overlays(
    xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Vec<RuleOverlay>, Thrown> {
    let mut out = Vec::new();
    let mut eff: Option<EffectivePPr> = None;
    for frag in top_level_drawings(xml) {
        if !frag.contains("<wp:anchor") || !is_thin_rule(frag) {
            continue;
        }
        if frag.contains("<pic:pic") || frag.contains("<w:txbxContent") {
            continue;
        }
        let meta = drawing_anchor_meta(frag);
        let (Some(offset_x), Some(offset_y)) = (meta.offset_x_emu, meta.offset_y_emu) else {
            continue;
        };
        if meta
            .rel_h
            .as_deref()
            .is_some_and(|rel| !rel.is_empty() && rel != "column")
            || meta
                .rel_v
                .as_deref()
                .is_some_and(|rel| !rel.is_empty() && rel != "paragraph")
        {
            continue;
        }
        if eff.is_none() {
            eff = Some(resolve_paragraph_props_xml(
                xml,
                &ctx.resolver,
                ResolveParaOptions::default(),
            )?);
        }
        let eff = eff
            .as_ref()
            .unwrap_or_else(|| unreachable!("resolved just above"));
        let display = rule_display_of(frag);
        let mut overlay = Map::new();
        overlay.insert(
            "xPx".to_owned(),
            num(math_round(
                offset_x.0 / EMU_PER_PX - eff.indent.left.0 / 15.0,
            )),
        );
        overlay.insert(
            "yPx".to_owned(),
            num(math_round((offset_y.0 / EMU_PER_PX) * 100.0) / 100.0),
        );
        let width = match display.rule_width_px {
            Some(width) if width.0 != 0.0 && !width.0.is_nan() => width.0,
            _ => math_round(meta.extent_x_emu.map_or(0.0, |e| e.0) / EMU_PER_PX),
        };
        overlay.insert("widthPx".to_owned(), num(width));
        overlay.insert(
            "spaceBeforePx".to_owned(),
            num(math_round((eff.spacing.before.0 / 15.0) * 100.0) / 100.0),
        );
        if let Some(thickness) = display
            .rule_thickness_px
            .filter(|t| t.0 != 0.0 && !t.0.is_nan())
        {
            overlay.insert("thicknessPx".to_owned(), json(&thickness));
        }
        if let Some(color) = truthy(display.rule_color_hex.as_deref()) {
            overlay.insert("colorHex".to_owned(), Value::from(color));
        }
        out.push(model_of(Value::Object(overlay))?);
    }
    Ok(out)
}
