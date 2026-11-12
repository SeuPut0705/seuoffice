//! `buildTextParagraph`, `strayParaRuns`, `fieldResultRuns` and
//! `foldFieldCodeParagraphs` of parse.ts: a w:p as an editable block.

use jscompat::{JsNum, Radix, js_regex, math_round, parse_int, trim, truthy};
use ooxml_xml::XNode;
use serde_json::{Map, Value};

use super::context::BuildContext;
use super::convert::{eff_to_model, into_map, json, model_of, num};
use super::extract_runs::extract_runs;
use super::paragraph::{
    ParaResolve, char_units_of, extract_para_format_map, outline_only_heading, para_cs_size,
    resolved_para_format_map, shadow_para_format_map, style_bidi_of_ctx,
};
use super::{
    ZoteroFieldParagraph, fold_effective_format, heading_level_of, list_kind_of, list_ref_of,
    mark_size_of, math_source_xml_of,
};
use crate::fields::display::field_display_of;
use crate::fields::{direct_para_geometry, field_label, field_stack_after, mark_inside_field_code};
use crate::inline_opaque::inline_raw_source;
use crate::model::{Block, FieldRun, ParaFormat, Run};
use crate::package::{Thrown, parse_part};
use crate::props::{
    all_runs_vanished, bookmark_names_of, break_only_runs, cross_para_comment_markers,
    empty_para_mark_font, empty_para_size_half_points, has_layout_run_content, layout_run_content,
    layout_run_content_besides_breaks, ptab_display_stops, raw_ppr_of, space_only_runs,
    stays_vanished, strip_textboxes,
};
use crate::resolve::{ResolveParaOptions, resolve_paragraph_props};
use crate::xml_text::{EMU_PER_PX, plain_text};
use omml::omml_fragments_of;

/// The `{ id, docxIndex, originalXml }` every block starts with.
#[derive(Debug, Clone)]
pub struct BlockBase {
    pub id: String,
    pub docx_index: JsNum,
    pub original_xml: String,
}

impl BlockBase {
    /// `{ ...base }`
    pub fn map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("id".to_owned(), Value::from(self.id.as_str()));
        map.insert("docxIndex".to_owned(), json(&self.docx_index));
        map.insert(
            "originalXml".to_owned(),
            Value::from(self.original_xml.as_str()),
        );
        map
    }
}

fn val_of<'a>(node: &'a XNode, name: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr("w:val"))
}

/// A revision record `{ author, date?, dateUtc?, id? }` of an element's attributes.
fn revision_map(node: &XNode) -> Map<String, Value> {
    let mut info = Map::new();
    info.insert(
        "author".to_owned(),
        Value::from(node.attr("w:author").unwrap_or("")),
    );
    for (attr, key) in [
        ("w:date", "date"),
        ("w16du:dateUtc", "dateUtc"),
        ("w:id", "id"),
    ] {
        if let Some(value) = truthy(node.attr(attr)) {
            info.insert(key.to_owned(), Value::from(value));
        }
    }
    info
}

fn block_of(map: Map<String, Value>) -> Result<Block, Thrown> {
    model_of(Value::Object(map))
}

/// `buildTextParagraph`: parse a w:p as editable text content (paragraph / heading / listItem).
pub fn build_text_paragraph(
    base: &BlockBase,
    xml: &str,
    ctx: &BuildContext<'_>,
    with_images: bool,
    doc_offset: Option<usize>,
    zotero_field: Option<&ZoteroFieldParagraph>,
) -> Result<Block, Thrown> {
    let Ok(parsed) = parse_part(xml) else {
        // unparseable paragraph (e.g. pathological nesting): keep the original bytes
        let mut map = base.map();
        map.insert("type".to_owned(), Value::from("passthrough"));
        map.insert("label".to_owned(), Value::from("Paragraph"));
        map.insert("previewText".to_owned(), Value::from(plain_text(xml)));
        return block_of(map);
    };
    let Some(p_node) = parsed.iter().find(|node| node.name() == Some("w:p")) else {
        let mut map = base.map();
        map.insert("type".to_owned(), Value::from("passthrough"));
        map.insert("label".to_owned(), Value::from("Unknown paragraph"));
        map.insert("previewText".to_owned(), Value::from(plain_text(xml)));
        return block_of(map);
    };

    let p_pr = p_node.find_child("w:pPr");
    let style_id: Option<&str> = p_pr.and_then(|p_pr| val_of(p_pr, "w:pStyle"));
    let rctx = &*ctx.resolver;
    let eff0 = resolve_paragraph_props(p_pr, rctx, ResolveParaOptions::default())?;
    // a hidden paragraph still consumes its list number, so the numbering reference rides along
    let hidden_paragraph = || -> Result<Block, Thrown> {
        let list = list_ref_of(&ctx.style_ctx(), p_pr, style_id)?;
        let mut map = base.map();
        map.insert("type".to_owned(), Value::from("passthrough"));
        map.insert("label".to_owned(), Value::from("Hidden paragraph"));
        map.insert("invisibleMarker".to_owned(), Value::Bool(true));
        if let Some(list) = list {
            map.insert("strayList".to_owned(), json(&list));
        }
        block_of(map)
    };
    // Whole paragraph hidden: a style-chain w:vanish on the mark hides the runs with it; a
    // direct mark w:vanish only collapses an empty paragraph or one whose every run is hidden
    if eff0.hidden
        && stays_vanished(xml)
        && (eff0.mark.source.get("vanish") != Some(&crate::resolve::PropSource::Direct)
            || (trim(&plain_text(xml)).is_empty()
                && !has_layout_run_content(p_node, layout_run_content()))
            || all_runs_vanished(p_node))
    {
        return hidden_paragraph();
    }
    let list_ref = list_ref_of(&ctx.style_ctx(), p_pr, style_id)?;
    let direct = resolved_para_format_map(&eff0, p_pr, ctx.resolver.theme_colors.as_ref());
    let mut format: Option<Map<String, Value>> = direct.clone();
    let raw_p_pr = raw_ppr_of(xml);
    let math_xml = math_source_xml_of(xml);
    let omml = omml_fragments_of(&math_xml);
    let ruby = crate::props::ruby_fragments_of(&math_xml);
    let raw = inline_raw_source(xml, p_node);
    let mut runs: Vec<Run> = extract_runs(
        p_node,
        ctx,
        &omml,
        &ruby,
        with_images,
        zotero_field,
        Some(&ParaResolve { eff: &eff0, rctx }),
        Some(&raw),
    )?;
    shadow_para_format_map(
        ctx,
        "body",
        p_pr,
        style_bidi_of_ctx(ctx, style_id, list_ref.as_ref())?,
        direct.as_ref(),
        &runs,
    )?;
    let texts: Vec<&str> = runs
        .iter()
        .map(|r| r.text.as_deref().unwrap_or(""))
        .collect();
    let space_only = !runs.is_empty()
        && space_only_runs(&texts)
        && !has_layout_run_content(p_node, layout_run_content());
    // a paragraph holding only page/column breaks lays its break line like an empty one
    let break_only = !runs.is_empty()
        && break_only_runs(&texts)
        && !has_layout_run_content(p_node, layout_run_content_besides_breaks());
    if runs.is_empty() || space_only || break_only {
        // the mark sizes the line; a run-less line without a sized mark still takes the dropped run's w:sz
        let eff0_model = eff_to_model(&eff0)?;
        let empty_sz = mark_size_of(&eff0_model, p_pr)
            .map(|size| size.0)
            .or_else(|| {
                if space_only {
                    None
                } else {
                    empty_para_size_half_points(
                        p_node,
                        None,
                        false,
                        Some(para_cs_size(ctx, style_id).0),
                    )
                }
            });
        if let Some(empty_sz) = empty_sz.filter(|size| *size != 0.0 && !size.is_nan()) {
            format
                .get_or_insert_with(Map::new)
                .insert("emptyRunSizeHalfPoints".to_owned(), num(empty_sz));
        }
        if let Some(font) =
            empty_para_mark_font(p_node, p_pr, ctx.resolver.theme_fonts.as_ref(), space_only)
        {
            format
                .get_or_insert_with(Map::new)
                .insert("emptyRunFontFamily".to_owned(), Value::from(font));
        }
    }

    // w:ptab absolute-position tabs: surface each as a display-only margin-relative stop
    let ptab_stops = ptab_display_stops(p_node);
    if !ptab_stops.is_empty() {
        let mut stops: Vec<Value> = format
            .as_ref()
            .and_then(|f| f.get("tabStops"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for st in &ptab_stops {
            let exists = stops.iter().any(|s| {
                s.get("rel").and_then(Value::as_str) == Some("margin")
                    && s.get("pos") == Some(&json(&st.pos))
            });
            if !exists {
                stops.push(json(st));
            }
        }
        format
            .get_or_insert_with(Map::new)
            .insert("tabStops".to_owned(), Value::Array(stops));
    }

    // allowOverlap="0" colliding with a sibling anchor (tdf#134114)
    displace_overlapping_floats(&mut runs);
    let stripped = strip_textboxes(xml);
    let names = bookmark_names_of(&stripped);
    let comments = cross_para_comment_markers(&stripped);

    // --- move revision detection ---
    let move_revision = if js_regex!(r"<w:moveFrom[\s/>]").test(xml) {
        Some("from")
    } else if js_regex!(r"<w:moveTo[\s/>]").test(xml) {
        Some("to")
    } else {
        None
    };

    // --- pPrChange info extraction ---
    let mut p_pr_change_info: Option<Map<String, Value>> = None;
    if let Some(p_pr) = p_pr
        && let Some(change_el) = p_pr.find_child("w:pPrChange")
    {
        let mut info = revision_map(change_el);
        if let Some(old_p_pr) = change_el.find_child("w:pPr") {
            let mut old = extract_para_format_map(old_p_pr, None, None).unwrap_or_default();
            let old_style_id = val_of(old_p_pr, "w:pStyle");
            if let Some(id) = truthy(old_style_id) {
                old.insert("styleId".to_owned(), Value::from(id));
            }
            let old_num_pr = old_p_pr.find_child("w:numPr");
            let old_num_id = old_num_pr.and_then(|n| val_of(n, "w:numId"));
            if let (Some(old_num_id), Some(old_num_pr)) = (truthy(old_num_id), old_num_pr) {
                old.insert("type".to_owned(), Value::from("docListItem"));
                old.insert("numId".to_owned(), Value::from(old_num_id));
                let ilvl = parse_int(val_of(old_num_pr, "w:ilvl").unwrap_or("0"), Radix::Ten);
                let ilvl = if ilvl == 0.0 || ilvl.is_nan() {
                    0.0
                } else {
                    ilvl
                };
                old.insert("ilvl".to_owned(), num(ilvl));
                old.insert(
                    "kind".to_owned(),
                    Value::from(list_kind_of(&ctx.style_ctx(), old_num_id, ilvl)?),
                );
            } else {
                let old_level = heading_level_of(Some(old_p_pr), old_style_id, &ctx.style_ctx())?;
                if let Some(level) = old_level.filter(|l| l.0 != 0.0 && !l.0.is_nan()) {
                    old.insert("type".to_owned(), Value::from("docHeading"));
                    old.insert("level".to_owned(), json(&level));
                } else if truthy(old_style_id).is_some() {
                    old.insert("type".to_owned(), Value::from("docParagraph"));
                }
            }
            if !old.is_empty() {
                info.insert("old".to_owned(), Value::Object(old));
            }
        }
        p_pr_change_info = Some(info);
    }

    // --- deleted / inserted paragraph mark ---
    let para_mark_revision = |tag: &str| -> Option<Map<String, Value>> {
        let p_r_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:rPr"));
        let el = p_r_pr.and_then(|r| r.find_child(tag))?;
        Some(revision_map(el))
    };
    let para_mark_del = para_mark_revision("w:del").or_else(|| para_mark_revision("w:moveFrom"));
    let para_mark_ins = para_mark_revision("w:ins").or_else(|| para_mark_revision("w:moveTo"));
    let para_mark_r_pr_change = para_mark_revision("w:rPrChange");
    let prop_change_in = |holder: &str, tag: &str| -> Option<Map<String, Value>> {
        let el = p_pr
            .and_then(|p_pr| p_pr.find_child(holder))
            .and_then(|h| h.find_child(tag))?;
        Some(revision_map(el))
    };
    let numbering_change = prop_change_in("w:numPr", "w:numberingChange");
    let sect_pr_change = prop_change_in("w:sectPr", "w:sectPrChange");

    // character-unit indents scale with the first text run, so the full resolution waits for the runs
    let eff = if eff0.indent.chars.is_some() {
        resolve_paragraph_props(
            p_pr,
            rctx,
            ResolveParaOptions {
                char_units: Some(char_units_of(
                    ctx, &runs, p_node, p_pr, style_id, doc_offset,
                )),
            },
        )?
    } else {
        eff0.clone()
    };
    let eff_model = eff_to_model(&eff)?;
    let typed_format: Option<ParaFormat> =
        format.map(|f| model_of(Value::Object(f))).transpose()?;
    let folded = fold_effective_format(typed_format.as_ref(), p_pr, &eff_model);
    let mut format = into_map(json(&folded));
    let mark_sz = if list_ref.is_some() {
        mark_size_of(&eff_model, p_pr)
    } else {
        None
    };
    if let Some(mark_sz) = mark_sz.filter(|size| size.0 != 0.0 && !size.0.is_nan()) {
        format.insert("markSizeHalfPoints".to_owned(), json(&mark_sz));
    }
    // extra revision fields shared across all return paths
    let mut rev_extras = Map::new();
    if let Some(mv) = move_revision {
        rev_extras.insert("moveRevision".to_owned(), Value::from(mv));
    }
    for (key, value) in [
        ("pPrChangeInfo", p_pr_change_info),
        ("paraMarkDel", para_mark_del),
        ("paraMarkIns", para_mark_ins),
        ("paraMarkRPrChange", para_mark_r_pr_change),
        ("numberingChange", numbering_change),
        ("sectPrChange", sect_pr_change),
    ] {
        if let Some(value) = value {
            rev_extras.insert(key.to_owned(), Value::Object(value));
        }
    }
    let mut map = base.map();
    let common = |map: &mut Map<String, Value>, format: &Map<String, Value>| {
        if let Some(id) = style_id {
            map.insert("styleId".to_owned(), Value::from(id));
        }
        map.insert("format".to_owned(), Value::Object(format.clone()));
        if let Some(raw) = raw_p_pr {
            map.insert("rawPPr".to_owned(), Value::from(raw));
        }
        if let Some(bookmarks) = &names.bookmarks {
            map.insert("bookmarks".to_owned(), json(bookmarks));
        }
        if let Some(hidden) = &names.hidden_bookmarks {
            map.insert("hiddenBookmarks".to_owned(), json(hidden));
        }
        if let Some(starts) = &comments.comment_starts {
            map.insert("commentStarts".to_owned(), json(starts));
        }
        if let Some(ends) = &comments.comment_ends {
            map.insert("commentEnds".to_owned(), json(ends));
        }
        // the runs go in by value below
        map.insert("runs".to_owned(), Value::Array(Vec::new()));
    };
    // A JSON value would copy the data URL of every picture among the runs.
    let finish = |map: Map<String, Value>| -> Result<Block, Thrown> {
        let mut block = block_of(map)?;
        if let Some(slot) = block.runs.as_mut() {
            *slot = runs;
        }
        Ok(block)
    };
    if let Some(list_ref) = &list_ref {
        let kind = list_kind_of(&ctx.style_ctx(), &list_ref.num_id, list_ref.ilvl.0)?;
        map.insert("type".to_owned(), Value::from("listItem"));
        // `styleId` precedes `list` in the literal
        if let Some(id) = style_id {
            map.insert("styleId".to_owned(), Value::from(id));
        }
        let mut list = Map::new();
        list.insert("kind".to_owned(), Value::from(kind));
        list.insert("numId".to_owned(), Value::from(list_ref.num_id.as_str()));
        list.insert("ilvl".to_owned(), json(&list_ref.ilvl));
        map.insert("list".to_owned(), Value::Object(list));
        let mut rest = Map::new();
        common(&mut rest, &format);
        rest.shift_remove("styleId");
        for (key, value) in rest {
            map.insert(key, value);
        }
        for (key, value) in rev_extras {
            map.insert(key, value);
        }
        return finish(map);
    }

    // heading?
    let heading_level = heading_level_of(p_pr, style_id, &ctx.style_ctx())?;
    if let Some(level) = heading_level.filter(|l| l.0 != 0.0 && !l.0.is_nan()) {
        map.insert("type".to_owned(), Value::from("heading"));
        map.insert("level".to_owned(), json(&level));
        if outline_only_heading(p_pr, style_id, ctx)? {
            map.insert("outlineOnly".to_owned(), Value::Bool(true));
        }
        common(&mut map, &format);
        for (key, value) in rev_extras {
            map.insert(key, value);
        }
        return finish(map);
    }

    map.insert("type".to_owned(), Value::from("paragraph"));
    common(&mut map, &format);
    for (key, value) in rev_extras {
        map.insert(key, value);
    }
    finish(map)
}

/// Where an `allowOverlap="0"` float collides with a sibling anchor, Word
/// displaces it out of the other's box: a front overlay at the collider's bottom.
fn displace_overlapping_floats(runs: &mut [Run]) {
    use crate::model::ImageWrap;
    let wrapped: Vec<usize> = runs
        .iter()
        .enumerate()
        .filter(|(_, run)| {
            run.image
                .as_ref()
                .is_some_and(|image| matches!(image.wrap, Some(w) if w != ImageWrap::Front && w != ImageWrap::Behind))
        })
        .map(|(index, _)| index)
        .collect();
    if wrapped.len() <= 1 {
        return;
    }
    for &r in &wrapped {
        let Some(img) = runs[r].image.as_ref() else {
            continue;
        };
        if img.no_overlap.unwrap_or(false) {
            let top = img.offset_y_emu.map_or(0.0, |v| v.0) / EMU_PER_PX;
            let height = img.height_px.map_or(0.0, |v| v.0);
            let hit = wrapped.iter().copied().find(|&o| {
                if o == r {
                    return false;
                }
                let Some(other) = runs[o].image.as_ref() else {
                    return false;
                };
                if other.no_overlap.unwrap_or(false) {
                    return false;
                }
                let o_top = other.offset_y_emu.map_or(0.0, |v| v.0) / EMU_PER_PX;
                top < o_top + other.height_px.map_or(0.0, |v| v.0) && o_top < top + height
            });
            let Some(hit) = hit else { continue };
            let hit_height = runs[hit]
                .image
                .as_ref()
                .and_then(|i| i.height_px)
                .map_or(0.0, |v| v.0);
            if let Some(img) = runs[r].image.as_mut() {
                img.wrap = Some(ImageWrap::Front);
                img.offset_x_emu = Some(JsNum(0.0));
                // the collider float renders at its line top (run floats ignore posOffset)
                img.offset_y_emu = Some(JsNum(math_round((hit_height + 2.0) * EMU_PER_PX)));
            }
        }
    }
}

/// What `strayParaRuns` finds: the text runs an anchor paragraph carries next to boxes.
pub struct StrayParaRuns {
    pub runs: Vec<Run>,
    pub style_id: Option<String>,
    pub indent: Option<Map<String, Value>>,
    pub align: Option<String>,
    pub list: Option<Value>,
}

/// `strayParaRuns`: text runs the anchor paragraph carries alongside content
/// textboxes. Display-only: the block still saves byte-identical. `None` is
/// the TypeScript's `null` (also where it throws).
pub fn stray_para_runs(
    paragraph_xml: &str,
    ctx: &BuildContext<'_>,
    with_images: bool,
) -> Option<StrayParaRuns> {
    stray_para_runs_inner(paragraph_xml, ctx, with_images)
        .ok()
        .flatten()
}

fn stray_para_runs_inner(
    paragraph_xml: &str,
    ctx: &BuildContext<'_>,
    with_images: bool,
) -> Result<Option<StrayParaRuns>, Thrown> {
    let mut stray_xml = strip_textboxes(paragraph_xml).into_owned();
    // inline run images only — anchored drawings already render as boxes
    if with_images {
        let frags: Vec<String> = crate::drawing_geometry::anchor::top_level_drawings(&stray_xml)
            .into_iter()
            .filter(|frag| frag.contains("<wp:anchor"))
            .map(str::to_owned)
            .collect();
        for frag in frags {
            stray_xml = jscompat::replace_first_string(&stray_xml, &frag, "");
        }
    }
    let parsed = parse_part(&stray_xml)?;
    let Some(p_node) = parsed.iter().find(|node| node.name() == Some("w:p")) else {
        return Ok(None);
    };
    let runs: Vec<Run> = super::extract_runs_plain(p_node, ctx, with_images)?
        .into_iter()
        .filter(|r| r.text.as_deref().is_some_and(|t| !t.is_empty()) || r.image.is_some())
        .collect();
    if runs.is_empty() {
        return Ok(None);
    }
    let p_pr = p_node.find_child("w:pPr");
    let style_id = p_pr.and_then(|p_pr| val_of(p_pr, "w:pStyle"));
    // the anchor paragraph's own w:ind shapes the stray line
    let eff = resolve_paragraph_props(p_pr, &ctx.resolver, ResolveParaOptions::default())?;
    let g = direct_para_geometry(&eff);
    let indent = if g.indent_left_twips.is_some()
        || g.indent_right_twips.is_some()
        || g.indent_first_line_twips.is_some()
    {
        let mut indent = Map::new();
        if let Some(v) = g.indent_left_twips {
            indent.insert("leftTwips".to_owned(), json(&v));
        }
        if let Some(v) = g.indent_right_twips {
            indent.insert("rightTwips".to_owned(), json(&v));
        }
        if let Some(v) = g.indent_first_line_twips {
            indent.insert("firstLineTwips".to_owned(), json(&v));
        }
        Some(indent)
    } else {
        None
    };
    let list = list_ref_of(&ctx.style_ctx(), p_pr, style_id)?;
    Ok(Some(StrayParaRuns {
        runs,
        style_id: truthy(style_id).map(str::to_owned),
        indent,
        align: eff.align.map(str::to_owned),
        list: list.map(|l| json(&l)),
    }))
}

/// `fieldResultRuns`: formatted result runs of a protected text-field paragraph
/// (display only). Only accepted when the runs reproduce the visible text exactly.
pub fn field_result_runs(
    xml: &str,
    ctx: &BuildContext<'_>,
    visible: &str,
) -> Result<Option<Vec<FieldRun>>, Thrown> {
    let Ok(parsed) = parse_part(&strip_textboxes(xml)) else {
        return Ok(None);
    };
    let Some(p_node) = parsed.iter().find(|node| node.name() == Some("w:p")) else {
        return Ok(None);
    };
    let mut runs: Vec<Map<String, Value>> = Vec::new();
    for r in super::extract_runs_plain(p_node, ctx, false)? {
        let text = r.text.as_deref().unwrap_or("");
        if text.is_empty() || r.vanish.unwrap_or(false) {
            continue;
        }
        let mut run = Map::new();
        run.insert("text".to_owned(), Value::from(text));
        if let Some(v) = *r.bold {
            run.insert("bold".to_owned(), Value::Bool(v));
        }
        if let Some(v) = *r.italic {
            run.insert("italic".to_owned(), Value::Bool(v));
        }
        if r.underline.unwrap_or(false) {
            run.insert("underline".to_owned(), Value::Bool(true));
        }
        if let Some(v) = truthy(r.color.as_deref()) {
            run.insert("color".to_owned(), Value::from(v));
        }
        if let Some(v) = (*r.size_half_points).filter(|v| v.0 != 0.0 && !v.0.is_nan()) {
            run.insert("sizeHalfPoints".to_owned(), json(&v));
        }
        if let Some(v) = truthy(r.font.as_deref()) {
            run.insert("font".to_owned(), Value::from(v));
        }
        if let Some(v) = truthy(r.font_ascii.as_deref()) {
            run.insert("fontAscii".to_owned(), Value::from(v));
        }
        if let Some(v) = truthy(r.cs_font.as_deref()) {
            run.insert("csFont".to_owned(), Value::from(v));
        }
        if let Some(v) = r.link.as_ref() {
            run.insert("link".to_owned(), json(v));
        }
        if let Some(v) = truthy(r.style_id.as_deref()) {
            run.insert("styleId".to_owned(), Value::from(v));
        }
        if let Some(v) = r.math.as_ref() {
            run.insert("math".to_owned(), json(v));
        }
        runs.push(run);
    }
    // plainText trims the visible result: trim the run edges the same way
    let text_of = |run: &Map<String, Value>| {
        run.get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    while let Some(first) = runs.first_mut() {
        let stripped = jscompat::trim_start(&text_of(first)).to_owned();
        first.insert("text".to_owned(), Value::from(stripped.as_str()));
        if !stripped.is_empty() {
            break;
        }
        runs.remove(0);
    }
    while let Some(last) = runs.last_mut() {
        let text = text_of(last);
        let stripped = js_regex!(r"\s+$").replace_all(&text, |_| String::new());
        last.insert("text".to_owned(), Value::from(stripped.as_str()));
        if !stripped.is_empty() {
            break;
        }
        runs.pop();
    }
    if runs.is_empty() || runs.iter().map(text_of).collect::<String>() != visible {
        return Ok(None);
    }
    runs.into_iter()
        .map(|run| model_of::<FieldRun>(Value::Object(run)))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// `fieldDisplayOf(xml, ctx.styles, ctx.resolver)`, its text runs attached as the
/// TypeScript callers do: `if (fieldDisplay?.kind === 'text') { runs = fieldResultRuns(xml, ctx, fieldDisplay.left ?? ''); if (runs) fieldDisplay.runs = runs }`.
pub fn field_display_with_runs(
    xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Option<crate::model::FieldDisplay>, Thrown> {
    let display = field_display_of(xml, Some(&ctx.resolver.styles), Some(&ctx.resolver))?;
    let Some(display) = display else {
        return Ok(None);
    };
    let mut map = into_map(json(&display));
    if display.kind == "text" {
        let left = display.left.as_deref().unwrap_or("");
        if let Some(runs) = field_result_runs(xml, ctx, left)? {
            map.insert("runs".to_owned(), json(&runs));
        }
    }
    Ok(Some(model_of(Value::Object(map))?))
}

/// `foldFieldCodeParagraphs`: paragraph marks inside field code are hidden in
/// Word: the paragraphs show as one under the last mark's properties. Blocks
/// stay separate for saving; the tail shows the joined result, the earlier
/// ones render as nothing.
pub fn fold_field_code_paragraphs(
    blocks: &mut [Block],
    ctx: &BuildContext<'_>,
) -> Result<(), Thrown> {
    let para_inner = |block: &Block| -> Option<String> {
        if *block.r#type != Some(crate::model::BlockType::Passthrough)
            || block.sdt_shell.is_some()
            || block.hidden.is_some_and(|h| h)
        {
            return None;
        }
        let original = (*block.original_xml).clone().flatten();
        js_regex!(r"^<w:p(?:\s[^>]*)?>([\s\S]*)<\/w:p>$")
            .exec(original.as_deref().unwrap_or(""))
            .and_then(|found| found.get(1))
            .map(str::to_owned)
    };
    let mut i = 0;
    while i < blocks.len() {
        let Some(head_inner) = para_inner(&blocks[i]) else {
            i += 1;
            continue;
        };
        let mut stack = field_stack_after(&strip_textboxes(&head_inner), &[]);
        if !mark_inside_field_code(&stack) {
            i += 1;
            continue;
        }
        let mut end = i;
        while mark_inside_field_code(&stack) && end + 1 < blocks.len() {
            let Some(inner) = para_inner(&blocks[end + 1]) else {
                break;
            };
            end += 1;
            stack = field_stack_after(&strip_textboxes(&inner), &stack);
        }
        if mark_inside_field_code(&stack) {
            i += 1;
            continue;
        }
        let body: String = blocks[i..=end]
            .iter()
            .map(|b| {
                let inner = para_inner(b).unwrap_or_default();
                js_regex!(r"^<w:pPr>[\s\S]*?<\/w:pPr>").replace_all(&inner, |_| String::new())
            })
            .collect::<Vec<_>>()
            .concat();
        let tail_inner = para_inner(&blocks[end]).unwrap_or_default();
        let p_pr = js_regex!(r"^<w:pPr>[\s\S]*?<\/w:pPr>")
            .exec(&tail_inner)
            .map_or("", |found| found.as_str());
        let joined = format!("<w:p>{p_pr}{body}</w:p>");
        let field_display = field_display_with_runs(&joined, ctx)?;
        let tail = &mut blocks[end];
        tail.field_display.assign(field_display);
        tail.preview_text.set(plain_text(&joined));
        tail.label.set(field_label(&joined));
        for block in &mut blocks[i..end] {
            block.invisible_marker.set(true);
            block.field_display.delete();
        }
        i = end + 1;
    }
    Ok(())
}
