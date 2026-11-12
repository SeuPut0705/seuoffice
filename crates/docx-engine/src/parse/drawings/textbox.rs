//! Display boxes of a paragraph's drawings: the paragraphs of a
//! `w:txbxContent`, DrawingML shapes and pictures (placed and wrapped like
//! their anchors), legacy VML shapes, and lockedCanvas text.

use jscompat::{
    JsNum, Radix, js_regex, math_max, math_round, number_to_string, parse_float, parse_int,
};
use ooxml_xml::{XNode, parse_ordered, serialize};

use super::EMU_PER_PT;
use super::EMU_PER_PX;
use super::EMU_PER_TWIP;
use super::picture::txbx_para_visible;
use super::vml::{
    apply_vml_mso_position, vml_flag_off, vml_stroke_child_off, vml_stroke_weight_px,
};
use crate::drawing_geometry::anchor::{
    DEFAULT_WRAP_DIST_EMU, DrawingAnchorMeta, GroupCtm, IDENTITY_CTM, LINE_PRSTS,
    MIN_WRAP_SLIVER_EMU, ResolvedAnchorPos, compose_group_ctm, drawing_anchor_meta, line_prsts_re,
    resolve_anchor_page_pos, resolve_anchor_page_y_emu, top_level_drawings,
};
use crate::drawing_geometry::fill::{color_node_hex, grad_fill_approx_hex, solid_fill_alpha};
use crate::drawing_geometry::line_box::line_box_of;
use crate::list_markers::{ListItemRef, compute_list_marker_infos};
use crate::model::{
    ParaAlign, Run, SectionSettings, TextboxDisplay, TextboxDisplayBorderDash,
    TextboxDisplayPageRelVFrom, TextboxDisplayPageRelXFrom, TextboxDisplayPathData,
    TextboxDisplayVAlign, TextboxDisplayWrapDistPx, TextboxDisplayWrapSide, TextboxListMarker,
    TextboxListMarkerKind, TextboxParaDisplay,
};
use crate::package::Thrown;
use crate::parse::tables::hf_paras::hf_table_row_paragraphs;
use crate::parse::text::{
    BuildContext, ParaListRef, emu_to_px, extract_para_format, extract_runs_plain, list_ref_of,
    para_text_size_half_points, with_char_indents,
};
use crate::props::{
    XML_PARSER_MAX_NESTED_TAGS, collect_nodes, collect_top_nodes, empty_para_size_half_points,
    has_layout_run_content, is_invisible_vml_pict, space_only_runs, txbx_has_structured_content,
};
use crate::vml::shape::{
    Coord, VML_WORDART_RE, VmlGroupScale, VmlOrigin, vml_coord_px, vml_group_scale,
    vml_path_to_norm_d, vml_shape_dim_px, vml_shape_svg,
};
use crate::vml::word_art::vml_word_art_box;
use crate::vml::{Dim, vml_color_hex, vml_rotation_deg};
use crate::xml_text::decode_numeric_char_refs;

pub use super::hf_textbox::textbox_paragraphs;

/// `ExtractTextboxOpts`
#[derive(Debug, Clone, Copy, Default)]
pub struct ExtractTextboxOpts<'a> {
    /// include textless preset shapes (stars, block arrows…) as display boxes
    pub shapes: bool,
    /// include picture-only drawings (pic:pic without a shape) as picture boxes
    pub pictures: bool,
    /// page geometry of the governing section (page/margin-anchored placement)
    pub section: Option<&'a SectionSettings>,
    /// document.xml byte offset of the host paragraph: textbox paragraphs
    /// resolve their character-unit indents under that section's document grid
    pub doc_offset: Option<usize>,
    /// the paragraph sits before the first explicit page break: page-V-anchored
    /// cover art may pin to the page origin instead of the paragraph origin
    pub first_page: bool,
}

/// `txbxContentParas`: the paragraphs (and tables, one display line per row)
/// of a w:txbxContent node. `doc_offset` is the host paragraph's document.xml
/// offset (section grid for character indents).
pub fn txbx_content_paras(
    content: &XNode,
    ctx: &BuildContext<'_>,
    doc_offset: Option<usize>,
) -> Result<Vec<TextboxParaDisplay>, Thrown> {
    let mut out = Vec::new();
    let mut list_items: Vec<TxbxListItem> = Vec::new();
    collect_txbx_paras(content, ctx, doc_offset, &mut out, &mut list_items)?;
    if list_items.is_empty() {
        return Ok(out);
    }
    // counters run per textbox: its sub-editor renders the markers, so the
    // document-wide sequence of the main editor is out of reach
    if !ctx.has_numbering {
        return Err(NO_NUMBERING.to_owned());
    }
    let refs: Vec<ListItemRef> = list_items
        .iter()
        .map(|item| ListItemRef {
            num_id: Some(item.list_ref.num_id.clone()),
            ilvl: item.list_ref.ilvl,
            deleted: None,
        })
        .collect();
    let infos = compute_list_marker_infos(&refs, &ctx.resolver.numbering);
    for (item, info) in list_items.iter().zip(infos) {
        let Some(info) = info else {
            continue;
        };
        let ilvl = math_max(0.0, item.list_ref.ilvl.0);
        let level = ctx
            .resolver
            .numbering
            .get(&item.list_ref.num_id)
            .and_then(|def| def.levels.get(&number_to_string(ilvl)));
        // identity + kind ride along so an edit inside the sub-editor can keep,
        // clear or re-point the paragraph's w:numPr on save
        let mut marker = TextboxListMarker {
            text: info.text.clone(),
            num_id: Some(item.list_ref.num_id.clone()),
            ilvl: Some(JsNum(ilvl)),
            ..TextboxListMarker::default()
        };
        if let Some(level) = level {
            marker.kind = Some(if level.num_fmt() == "bullet" {
                TextboxListMarkerKind::Bullet
            } else {
                TextboxListMarkerKind::Ordered
            });
        }
        if info
            .symbol_font
            .as_ref()
            .is_some_and(|font| !font.is_empty())
        {
            marker.symbol = Some(true);
        }
        if info
            .pic_bullet_src
            .as_ref()
            .is_some_and(|src| !src.is_empty())
        {
            marker.pic_bullet_src = info.pic_bullet_src.clone();
        }
        if let Some(level) = level {
            marker.indent_left = *level.indent_left;
            marker.indent_right = *level.indent_right;
            let truthy = |v: Option<JsNum>| v.filter(|v| v.0 != 0.0 && !v.0.is_nan());
            marker.hanging = truthy(*level.hanging);
            marker.first_line = truthy(*level.first_line);
            marker.sz_half_points = truthy(*level.sz_half_points);
            if let Some(sz) = marker.sz_half_points
                && sz.0 > item.text_size_half.0
            {
                marker.oversized = Some(true);
            }
        }
        out[item.index].list_marker = Some(marker);
    }
    Ok(out)
}

/// `ctx.numbering.get` of a context that has no numbering.
const NO_NUMBERING: &str = "TypeError: Cannot read properties of undefined (reading 'get')";

/// `TxbxListItem`: the paragraph at `index` of the output.
pub struct TxbxListItem {
    pub index: usize,
    pub list_ref: ParaListRef,
    pub text_size_half: JsNum,
}

/// `collectTxbxParas`
pub fn collect_txbx_paras(
    content: &XNode,
    ctx: &BuildContext<'_>,
    doc_offset: Option<usize>,
    out: &mut Vec<TextboxParaDisplay>,
    list_items: &mut Vec<TxbxListItem>,
) -> Result<(), Thrown> {
    for child in content.children() {
        match child.name() {
            Some("w:p") => {
                // withImages: inline drawings in textbox paragraphs (form
                // checkboxes) must become run images or they are dropped, and
                // lost on first edit
                let runs = extract_runs_plain(child, ctx, true)?;
                let p_pr = child.find_child("w:pPr");
                let style_id = p_pr
                    .and_then(|p_pr| p_pr.find_child("w:pStyle"))
                    .and_then(|style| style.attr("w:val"));
                let list_ref = list_ref_of(&ctx.style_ctx(), p_pr, style_id)?;
                let level_bidi = match &list_ref {
                    Some(list_ref) => {
                        if !ctx.has_numbering {
                            return Err(NO_NUMBERING.to_owned());
                        }
                        ctx.resolver
                            .numbering
                            .get(&list_ref.num_id)
                            .and_then(|def| def.levels.get(&number_to_string(list_ref.ilvl.0)))
                            .and_then(|level| *level.bidi)
                    }
                    None => None,
                };
                let style_bidi = style_id
                    .filter(|id| !id.is_empty())
                    .and_then(|id| ctx.resolver.styles.get(id))
                    .and_then(|style| style.display.as_ref())
                    .and_then(|display| *display.bidi);
                let bidi = level_bidi.or(style_bidi).or_else(|| {
                    ctx.resolver
                        .doc_defaults
                        .as_ref()
                        .and_then(|defaults| *defaults.bidi)
                });
                // pPr-less paragraphs too: the Normal style's character indents
                // apply to them in a textbox just as in the body
                let format = match p_pr {
                    Some(p_pr) => {
                        extract_para_format(p_pr, ctx.resolver.theme_colors.as_ref(), bidi)?
                    }
                    None => None,
                };
                let format = with_char_indents(
                    format,
                    ctx,
                    child,
                    p_pr,
                    style_id,
                    &runs,
                    list_ref.is_some(),
                    doc_offset,
                )?;
                let mut para = TextboxParaDisplay {
                    runs,
                    ..TextboxParaDisplay::default()
                };
                if let Some(format) = format {
                    para.para_format.assign(&format);
                }
                if let Some(style_id) = style_id.filter(|id| !id.is_empty()) {
                    para.style_id = Some(style_id.to_owned());
                }
                let texts: Vec<&str> = para
                    .runs
                    .iter()
                    .map(|run| run.text.as_deref().unwrap_or(""))
                    .collect();
                if space_only_runs(&texts)
                    && !has_layout_run_content(child, crate::props::layout_run_content())
                    && let Some(mark_sz) = empty_para_size_half_points(child, p_pr, true, None)
                    && mark_sz != 0.0
                    && !mark_sz.is_nan()
                {
                    para.para_format
                        .empty_run_size_half_points
                        .set(JsNum(mark_sz));
                }
                if let Some(list_ref) = list_ref {
                    let text_size_half =
                        para_text_size_half_points(ctx, &para.runs, child, p_pr, style_id);
                    list_items.push(TxbxListItem {
                        index: out.len(),
                        list_ref,
                        text_size_half,
                    });
                }
                out.push(para);
            }
            Some("w:tbl") => out.extend(txbx_table_paras(child, ctx)?),
            Some("w:sdt") => {
                if let Some(inner) = child.find_child("w:sdtContent") {
                    collect_txbx_paras(inner, ctx, doc_offset, out, list_items)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// `txbxTableParas`: a table inside a textbox: the same layout-table rows as a
/// header/footer table (cell columns from tblGrid / tcW, per-cell borders,
/// margins, shading), one display paragraph per row. Nested tables flatten
/// into their host cell.
pub fn txbx_table_paras(
    tbl: &XNode,
    ctx: &BuildContext<'_>,
) -> Result<Vec<TextboxParaDisplay>, Thrown> {
    let compat_mode = ctx.compatibility_mode.map_or(0.0, |mode| mode.0);
    Ok(hf_table_row_paragraphs(tbl, ctx, compat_mode)?
        .into_iter()
        .map(|p| TextboxParaDisplay {
            runs: Vec::new(),
            cells: (*p.cells).clone(),
            row: (*p.row).clone(),
            ..TextboxParaDisplay::default()
        })
        .collect())
}

/// `paragraphStrayBox`: a display-only line for text a paragraph carries
/// alongside its VML shapes (canvas + trailing hyperlinks): the shape XML is
/// stripped and the remaining runs rendered as a boxless read-only paragraph,
/// so the text stays visible.
pub fn paragraph_stray_box(
    p_xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<Option<TextboxDisplay>, Thrown> {
    let stripped = js_regex!(r"<w:pict>[\s\S]*?<\/w:pict>")
        .replace_all(&crate::props::strip_textboxes(p_xml), |_| String::new());
    let Ok(parsed) = parse_ordered(&stripped, XML_PARSER_MAX_NESTED_TAGS) else {
        return Ok(None);
    };
    let mut p_nodes: Vec<&XNode> = Vec::new();
    collect_nodes(&parsed, "w:p", &mut p_nodes);
    let Some(first) = p_nodes.first() else {
        return Ok(None);
    };
    let mut para = TextboxParaDisplay {
        runs: extract_runs_plain(first, ctx, false)?,
        ..TextboxParaDisplay::default()
    };
    if let Some(p_pr) = first.find_child("w:pPr")
        && let Some(format) = extract_para_format(p_pr, ctx.resolver.theme_colors.as_ref(), None)?
    {
        para.para_format.assign(&format);
    }
    if !para
        .runs
        .iter()
        .any(|run| !jscompat::trim(run.text.as_deref().unwrap_or("")).is_empty())
    {
        return Ok(None);
    }
    let mut stray = TextboxDisplay::default();
    stray.paras.set(vec![para]);
    stray.read_only.set(true);
    stray.inset_top_px.set(JsNum(0.0));
    stray.inset_right_px.set(JsNum(0.0));
    stray.inset_bottom_px.set(JsNum(0.0));
    stray.inset_left_px.set(JsNum(0.0));
    Ok(Some(stray))
}

/// The geometry of a model section as the engine's `SectionSettings` the
/// anchor readers of `drawing_geometry` take; they read page size, margins
/// and columns only.
fn engine_section_of(sect: &SectionSettings) -> crate::section::SectionSettings {
    crate::section::SectionSettings {
        page_width: sect.page_width,
        page_height: sect.page_height,
        margin_top: sect.margin_top,
        margin_right: sect.margin_right,
        margin_bottom: sect.margin_bottom,
        margin_left: sect.margin_left,
        columns: sect.columns,
        ..crate::section::DEFAULT_SECTION
    }
}

/// `(v ?? 0)` of a number slot.
fn or_zero(value: Option<JsNum>) -> f64 {
    value.map_or(0.0, |value| value.0)
}

/// `parseInt(attrsOf(node ?? {})[name] ?? '', 10)`
fn int_attr(node: Option<&XNode>, name: &str) -> f64 {
    parse_int(
        node.and_then(|node| node.attr(name)).unwrap_or(""),
        Radix::Ten,
    )
}

/// The usable column width of a section, in EMU.
fn column_width_emu(s: &SectionSettings) -> f64 {
    (s.page_width.0 - s.margin_left.0 - s.margin_right.0) * EMU_PER_TWIP
}

/// What one `extractTextboxes` call carries between its inner functions.
struct Textboxes<'a, 'c> {
    xml: &'a str,
    ctx: &'a BuildContext<'c>,
    opts: ExtractTextboxOpts<'a>,
    section: Option<crate::section::SectionSettings>,
    has_line_shapes: bool,
    /// a paragraph anchoring several drawings never stacks them: every
    /// anchored shape floats at its own offset
    multi_drawing: bool,
    out: Vec<TextboxDisplay>,
    /// every w:txbxContent consumes one save-path ordinal (box emitted or
    /// not), mirroring how patchTextboxParas counts the non-fallback segments
    txbx_ordinal: f64,
    frag_metas: Vec<DrawingAnchorMeta>,
    union_spans: Option<bool>,
}

/// The state of one drawing fragment of the paragraph.
struct Frag {
    meta: DrawingAnchorMeta,
    page_pos: Option<ResolvedAnchorPos>,
    wsp_count: usize,
    inline_extent_px: f64,
}

/// `extractTextboxes`: the display boxes of a paragraph's drawings.
pub fn extract_textboxes(
    xml: &str,
    ctx: &BuildContext<'_>,
    opts: ExtractTextboxOpts<'_>,
) -> Result<Vec<TextboxDisplay>, Thrown> {
    // wrapSquare gate keeps converter-emitted decorative rules on the thin-rule path
    let has_line_shapes = xml.contains("<wp:wrapSquare") && line_prsts_re().test(xml);
    let has_canvas_text = xml.contains("<a:txSp");
    let has_vml_word_art = VML_WORDART_RE.test(xml);
    if !xml.contains("<w:txbxContent")
        && !has_line_shapes
        && !has_canvas_text
        && !has_vml_word_art
        && !(opts.shapes || opts.pictures)
    {
        return Ok(Vec::new());
    }
    let frags = top_level_drawings(xml);
    let mut state = Textboxes {
        xml,
        ctx,
        opts,
        section: opts.section.map(engine_section_of),
        has_line_shapes,
        multi_drawing: frags.len() > 1,
        out: Vec::new(),
        txbx_ordinal: 0.0,
        frag_metas: frags.iter().map(|frag| drawing_anchor_meta(frag)).collect(),
        union_spans: None,
    };
    state.fix_up_metas();
    let pin_all = state.pin_all();
    for (index, frag) in frags.iter().enumerate() {
        state.fragment(index, frag, pin_all)?;
    }
    state.legacy_vml()?;
    if has_canvas_text {
        state.canvas_text();
    }
    Ok(state.out)
}

impl<'a, 'c> Textboxes<'a, 'c> {
    /// `pinnable`: first-page cover art with a page-relative V anchor keeps
    /// RAW page coordinates and pins to the page box itself.
    fn pinnable(&self, m: &DrawingAnchorMeta) -> bool {
        m.anchored == Some(true)
            && (m.no_wrap == Some(true) || m.behind == Some(true) || self.multi_drawing)
            && m.rel_v.as_deref() == Some("page")
            && matches!(m.rel_h.as_deref(), Some("page" | "margin"))
    }

    /// All-or-nothing per paragraph: the un-positioned pagepinned wrapper
    /// would break any sibling drawing still positioned from the paragraph
    /// origin.
    fn pin_all(&self) -> bool {
        let anchored: Vec<&DrawingAnchorMeta> = self
            .frag_metas
            .iter()
            .filter(|m| m.anchored == Some(true))
            .collect();
        self.opts.first_page
            && self.opts.section.is_some()
            && !anchored.is_empty()
            && anchored.iter().all(|m| self.pinnable(m))
    }

    /// Page-relative posOffset measures from the page edge; boxes render from
    /// the column/paragraph origin, so keeping the raw value double-counts the
    /// margins (X is exact; Y approximates the anchor paragraph at body top,
    /// strictly closer than the raw page offset). One pass up front keeps every
    /// consumer in the same column space; pinned metas keep raw page
    /// coordinates.
    fn fix_up_metas(&mut self) {
        let Some(section) = self.opts.section else {
            return;
        };
        let pin_all = self.pin_all();
        for index in 0..self.frag_metas.len() {
            if pin_all && self.pinnable(&self.frag_metas[index]) {
                continue;
            }
            let m = &mut self.frag_metas[index];
            let truthy_align =
                |align: &Option<String>| align.as_ref().is_some_and(|a| !a.is_empty());
            if m.rel_h.as_deref() == Some("page")
                && !truthy_align(&m.align_h)
                && let Some(offset) = m.offset_x_emu
            {
                m.offset_x_emu = Some(JsNum(offset.0 - section.margin_left.0 * EMU_PER_TWIP));
            }
            if m.rel_v.as_deref() == Some("page")
                && !truthy_align(&m.align_v)
                && let Some(offset) = m.offset_y_emu
            {
                m.offset_y_emu = Some(JsNum(offset.0 - section.margin_top.0 * EMU_PER_TWIP));
            }
        }
    }

    /// `anchorUnionSpansColumn`: the union of the paragraph's anchored drawing
    /// extents; when the widest remaining horizontal gap in the column is a
    /// sliver, no text fits beside the boxes and Word lays it above/below the
    /// row.
    fn anchor_union_spans_column(&mut self, sect: &SectionSettings) -> bool {
        if let Some(known) = self.union_spans {
            return known;
        }
        let col_w_emu = column_width_emu(sect);
        let mut iv: Vec<[f64; 2]> = self
            .frag_metas
            .iter()
            .filter(|m| {
                m.anchored == Some(true)
                    && m.offset_x_emu.is_some()
                    && or_zero(m.extent_x_emu) > 0.0
            })
            .map(|m| {
                let x = or_zero(m.offset_x_emu);
                [x, x + or_zero(m.extent_x_emu)]
            })
            .collect();
        // `.sort((a, b) => a[0] - b[0])`
        iv.sort_by(|a, b| {
            (a[0] - b[0])
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut gap = 0.0;
        let mut cursor = 0.0;
        for [a, b] in &iv {
            gap = math_max(gap, a - cursor);
            cursor = math_max(cursor, *b);
        }
        gap = math_max(gap, col_w_emu - cursor);
        let spans = !iv.is_empty() && gap < MIN_WRAP_SLIVER_EMU;
        self.union_spans = Some(spans);
        spans
    }

    /// `applyAnchor`: placement and wrap of a box from its drawing's anchor.
    fn apply_anchor(
        &mut self,
        b: &mut TextboxDisplay,
        meta: &DrawingAnchorMeta,
        page_pos: Option<&ResolvedAnchorPos>,
        grouped: bool,
    ) {
        if meta.anchored != Some(true) {
            return;
        }
        if meta.behind == Some(true) {
            b.behind.set(true);
        }
        if meta.no_wrap == Some(true) {
            b.no_wrap.set(true);
        }
        if meta.outside_cell == Some(true) {
            b.outside_cell.set(true);
        }
        if let Some(z) = meta.z {
            b.z.set(z);
        }
        // first-page page-anchored cover art: raw page coordinates, rendered
        // against the page box (doc-protected-pagepinned)
        if let Some(page_x) = meta.page_x_emu {
            b.offset_x_emu
                .set(JsNum(or_zero(*b.offset_x_emu) + page_x.0));
            b.offset_y_emu
                .set(JsNum(or_zero(*b.offset_y_emu) + or_zero(meta.page_y_emu)));
            b.floating.set(true);
            b.page_pinned.set(true);
            return;
        }
        // page/margin-anchored drawing sitting outside the body column (Word
        // resume sidebars): absolute placement at the resolved position instead
        // of stacking in the flow, wrap kind notwithstanding. Page/margin-relative
        // X is absolute on the page in Word: a column-translated anchor block
        // must not drag the box sideways
        let rel_x_absolute = matches!(meta.rel_h.as_deref(), Some("page" | "margin"));
        if let Some(pos) = page_pos
            && pos.outside_column
        {
            // group children already carry a group-relative offset: the anchor adds
            b.offset_x_emu
                .set(JsNum(or_zero(*b.offset_x_emu) + pos.x_emu.0));
            let y = pos
                .y_emu
                .map(|y| y.0)
                .unwrap_or_else(|| or_zero(meta.offset_y_emu));
            b.offset_y_emu.set(JsNum(or_zero(*b.offset_y_emu) + y));
            b.floating.set(true);
            if rel_x_absolute {
                b.page_rel_x.set(true);
            }
            return;
        }
        if let Some(offset) = meta.offset_x_emu {
            b.offset_x_emu
                .set(JsNum(or_zero(*b.offset_x_emu) + offset.0));
            if rel_x_absolute {
                b.page_rel_x.set(true);
            }
            if meta.rel_h.as_deref() == Some("page") {
                b.page_rel_x_from.set(TextboxDisplayPageRelXFrom::Page);
            }
        }
        // page/margin-relative V places the box on its anchor's page in Word
        // whatever the wrap kind (wrap only decides how body text flows around
        // it). A wrapped one floats at that position instead of stacking into the
        // flow at the anchor paragraph (cover bands drawn margin-shifted), but
        // only where floating cannot lay body text over it: the box lies wholly
        // outside the body area, spans the column (text only above/below), or is
        // a topAndBottom band covering the body top (its band is exact). A narrow
        // in-column wrapped box keeps the flow placement: text cannot wrap around
        // an absolute box, and its band would be relative to an unknown anchor.
        let section = self.opts.section;
        let page_abs_v =
            section.is_some() && matches!(meta.rel_v.as_deref(), Some("page" | "margin"));
        let aligned_y_emu = if page_abs_v && meta.offset_y_emu.is_none() {
            resolve_anchor_page_y_emu(meta, self.section.as_ref())
        } else {
            None
        };
        let mut page_v_float = false;
        // band only inside the body area: a box clear of it excludes no text
        let mut page_v_band = false;
        if page_abs_v
            && meta.no_wrap != Some(true)
            && let Some(s) = section
        {
            // column / body-top space: page-relative X/Y are exact here (only the
            // anchor paragraph's own position is unknown)
            let x = or_zero(*b.offset_x_emu)
                + match page_pos {
                    Some(pos) if !pos.outside_column && meta.offset_x_emu.is_none() => pos.x_emu.0,
                    _ => 0.0,
                };
            let y = or_zero(*b.offset_y_emu)
                + meta
                    .offset_y_emu
                    .map(|y| y.0)
                    .or(aligned_y_emu)
                    .unwrap_or(0.0);
            let w = match *b.width_px {
                Some(width) => Some(width.0 * EMU_PER_PX),
                None => meta.extent_x_emu.map(|w| w.0),
            };
            let h = match *b.height_px {
                Some(height) => Some(height.0 * EMU_PER_PX),
                None if !grouped => meta.extent_y_emu.map(|h| h.0),
                None => None,
            };
            let col_w = column_width_emu(s);
            let body_h = (s.page_height.0 - s.margin_top.0 - s.margin_bottom.0) * EMU_PER_TWIP;
            if let (Some(w), Some(h)) = (w, h)
                && w > 0.0
                && h > 0.0
            {
                let outside_body = y + h <= 0.0
                    || y >= body_h
                    || (s.columns.0 <= 1.0 && (x + w <= 0.0 || x >= col_w));
                let spans = s.columns.0 <= 1.0
                    && !grouped
                    && x < MIN_WRAP_SLIVER_EMU
                    && col_w - x - w < MIN_WRAP_SLIVER_EMU;
                let exact_band = meta.top_bottom == Some(true) && y <= 0.0 && y + h > 0.0;
                page_v_float = outside_body || spans || exact_band;
                page_v_band = page_v_float && !outside_body;
            }
        }
        // margin-aligned X (wp:align left/center/right) on a floating drawing (photo
        // rows): resolve against the margin box; in-flow wrapSquare boxes keep the
        // legacy flow placement
        if let Some(pos) = page_pos
            && !pos.outside_column
            && meta.offset_x_emu.is_none()
            && (meta.top_bottom == Some(true)
                || meta.no_wrap == Some(true)
                || self.multi_drawing
                || page_v_float)
        {
            b.offset_x_emu
                .set(JsNum(or_zero(*b.offset_x_emu) + pos.x_emu.0));
            if rel_x_absolute {
                b.page_rel_x.set(true);
            }
        }
        if let Some(offset) = meta.offset_y_emu {
            b.offset_y_emu
                .set(JsNum(or_zero(*b.offset_y_emu) + offset.0));
        }
        // wp:align / pctPosVOffset against the page or margin box on a floating
        // box: the resolved body-top offset, re-pinned onto the anchor's page like
        // a posOffset (in-flow boxes keep ignoring it)
        if let Some(aligned) = aligned_y_emu
            && (meta.no_wrap == Some(true) || self.multi_drawing || page_v_float)
        {
            b.offset_y_emu
                .set(JsNum(or_zero(*b.offset_y_emu) + aligned));
            b.page_rel_v.set(true);
            b.page_rel_v_from
                .set(if meta.rel_v.as_deref() == Some("page") {
                    TextboxDisplayPageRelVFrom::Page
                } else {
                    TextboxDisplayPageRelVFrom::Margin
                });
        }
        // page/margin-relative posOffset V is absolute on the anchor's page in
        // Word; rendered from the anchor paragraph it needs the canvas re-pin
        if matches!(meta.rel_v.as_deref(), Some("page" | "margin"))
            && meta.offset_y_emu.is_some()
            && !meta.align_v.as_ref().is_some_and(|align| !align.is_empty())
        {
            b.page_rel_v.set(true);
            b.page_rel_v_from
                .set(if meta.rel_v.as_deref() == Some("page") {
                    TextboxDisplayPageRelVFrom::Page
                } else {
                    TextboxDisplayPageRelVFrom::Margin
                });
        }
        // wrapSquare box spanning (nearly) the whole column: no text fits in the
        // leftover sliver, so Word floats the box at its offset (the anchor line
        // stays under it) and lays text above/below: reserve the band like
        // wrapTopAndBottom instead of stacking the box into the flow (or, in a
        // multi-drawing paragraph, overlaying the flow with zero footprint).
        // A multi-drawing paragraph covers the column with the UNION of its boxes
        // (half-width sign-off frames side by side): the wrapSquare ones band too.
        let mut own_spans_column = false;
        let mut square_spans_column = false;
        if meta.no_wrap != Some(true)
            && meta.top_bottom != Some(true)
            && !grouped
            && let Some(sect) = section
            && sect.columns.0 <= 1.0
        {
            let col_w_emu = column_width_emu(sect);
            let w_emu = match *b.width_px {
                Some(width) => Some(width.0 * EMU_PER_PX),
                None => meta.extent_x_emu.map(|w| w.0),
            };
            let x_emu = or_zero(*b.offset_x_emu);
            own_spans_column = w_emu.is_some_and(|w| {
                w > 0.0
                    && x_emu < MIN_WRAP_SLIVER_EMU
                    && col_w_emu - x_emu - w < MIN_WRAP_SLIVER_EMU
            });
            square_spans_column =
                own_spans_column || (self.multi_drawing && self.anchor_union_spans_column(sect));
        }
        // wrapTopAndBottom (Word): body text is excluded from the box's whole
        // vertical band. The box floats at its offset and the anchor paragraph
        // reserves flow height down to the box bottom (union over its boxes).
        if (meta.top_bottom == Some(true) || square_spans_column)
            && (matches!(meta.rel_v.as_deref(), Some("paragraph" | "line")) || page_v_band)
        {
            // wp:extent cy covers the whole drawing: a usable height fallback only
            // for an ungrouped shape (each group child would claim the group height)
            let h = match *b.height_px {
                Some(height) => Some(height.0),
                None if !grouped => meta
                    .extent_y_emu
                    .map(|extent| math_round(extent.0 / EMU_PER_PX)),
                None => None,
            };
            if let Some(h) = h {
                let top = math_round(or_zero(*b.offset_y_emu) / EMU_PER_PX);
                // a page-relative top counts from the body top (anchor paragraph
                // assumed there): only a box covering that origin (a band hanging
                // from the page top) bands exactly; reserving down to a box lower
                // on the page would blank all the flow above it
                if top + h > 0.0 && (!page_abs_v || top <= 0.0) {
                    b.band_top_px.set(JsNum(top));
                    b.band_bottom_px.set(JsNum(top + h));
                    // only a box that spans the column BY ITSELF may overflow the
                    // page bottom (Word keeps it on its anchor's page); a union
                    // band (side by side frames) is pushed whole to the next page
                    // like Word
                    if own_spans_column && meta.top_bottom != Some(true) {
                        b.band_overflow.set(true);
                    }
                }
            }
            b.floating.set(true);
        }
        if meta.no_wrap == Some(true) || self.multi_drawing || page_v_float {
            b.floating.set(true);
        }
        if meta.no_wrap != Some(true) && meta.top_bottom != Some(true) {
            b.wrap_sides.set(true);
            if *b.floating == Some(true) {
                let d = |v: Option<JsNum>, dflt: f64| {
                    JsNum(math_round((v.map_or(dflt, |v| v.0) / EMU_PER_PX) * 10.0) / 10.0)
                };
                b.wrap_dist_px.set(TextboxDisplayWrapDistPx {
                    l: d(meta.dist_l_emu, DEFAULT_WRAP_DIST_EMU),
                    r: d(meta.dist_r_emu, DEFAULT_WRAP_DIST_EMU),
                    t: d(meta.dist_t_emu, 0.0),
                    b: d(meta.dist_b_emu, 0.0),
                });
            }
        }
        // in-column wrapSquare box: Word flows the body text beside it (from the
        // anchor paragraph on) instead of stacking it into the flow: a CSS float
        // on the side with less room, when the other side keeps a usable column
        if *b.wrap_sides == Some(true)
            && *b.floating != Some(true)
            && !grouped
            && let Some(sect) = section
            && sect.columns.0 <= 1.0
            && meta.rel_v.as_deref() != Some("page")
            && meta.rel_v.as_deref() != Some("margin")
            && meta.align_h.as_deref() != Some("center")
        {
            let col_w_emu = column_width_emu(sect);
            let w_emu = match *b.width_px {
                Some(width) => Some(width.0 * EMU_PER_PX),
                None => meta.extent_x_emu.map(|w| w.0),
            };
            if let Some(w_emu) = w_emu
                && w_emu > 0.0
            {
                let x_emu = match meta.align_h.as_deref() {
                    Some("right") => col_w_emu - w_emu,
                    Some("left") => 0.0,
                    _ => or_zero(*b.offset_x_emu),
                };
                let dist_l = meta.dist_l_emu.map_or(DEFAULT_WRAP_DIST_EMU, |d| d.0);
                let dist_r = meta.dist_r_emu.map_or(DEFAULT_WRAP_DIST_EMU, |d| d.0);
                let left_gap = x_emu - dist_l;
                let right_gap = col_w_emu - x_emu - w_emu - dist_r;
                let right = left_gap >= right_gap;
                if (if right { left_gap } else { right_gap }) >= MIN_WRAP_SLIVER_EMU {
                    b.wrap_side.set(if right {
                        TextboxDisplayWrapSide::Right
                    } else {
                        TextboxDisplayWrapSide::Left
                    });
                    b.wrap_edge_px.set(JsNum(
                        (if right {
                            col_w_emu - x_emu - w_emu
                        } else {
                            x_emu
                        }) / EMU_PER_PX,
                    ));
                    b.wrap_gap_px
                        .set(JsNum((if right { dist_l } else { dist_r }) / EMU_PER_PX));
                }
            }
        }
    }
}

/// `extentTag`'s `cx`/`cy` of a drawing's wp:extent tag.
fn extent_px_pair(frag: &str) -> (f64, f64) {
    let tag = js_regex!(r"<wp:extent[^>]*\/?>")
        .exec(frag)
        .map_or("", |found| found.as_str());
    let size = |pattern: &jscompat::JsRegex| {
        parse_int(
            pattern
                .exec(tag)
                .and_then(|found| found.get(1))
                .unwrap_or(""),
            Radix::Ten,
        )
    };
    (
        size(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#)),
        size(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#)),
    )
}

/// The picture box skeleton: read-only, inkless insets.
fn picture_box(
    shape_id: Option<&str>,
    data_url: String,
    width_px: f64,
    height_px: f64,
) -> TextboxDisplay {
    let mut b = TextboxDisplay::default();
    b.paras.set(Vec::new());
    b.read_only.set(true);
    b.picture.set(true);
    if let Some(id) = shape_id.filter(|id| !id.is_empty()) {
        b.shape_id.set(id.to_owned());
    }
    b.fill_image_data_url.set(data_url);
    b.width_px.set(JsNum(width_px));
    b.height_px.set(JsNum(height_px));
    b.inset_top_px.set(JsNum(0.0));
    b.inset_right_px.set(JsNum(0.0));
    b.inset_bottom_px.set(JsNum(0.0));
    b.inset_left_px.set(JsNum(0.0));
    b
}

/// `ctx.mediaByRid?.get(rId)`, an empty URL being no URL.
fn media_of(ctx: &BuildContext<'_>, r_id: Option<&str>) -> Option<String> {
    let r_id = r_id?;
    ctx.media_by_rid
        .as_ref()
        .and_then(|media| media.borrow().get(r_id).cloned())
        .filter(|url| !url.is_empty())
}

impl<'a, 'c> Textboxes<'a, 'c> {
    /// One top-level drawing fragment of the paragraph.
    fn fragment(&mut self, index: usize, frag: &str, pin_all: bool) -> Result<(), Thrown> {
        let Ok(parsed_frag) = parse_ordered(frag, XML_PARSER_MAX_NESTED_TAGS) else {
            return Ok(());
        };
        let mut meta = self.frag_metas[index].clone();
        if pin_all
            && self.pinnable(&meta)
            && let Some(section) = self.opts.section
        {
            let mar_l = section.margin_left.0 * EMU_PER_TWIP;
            let mar_t = section.margin_top.0 * EMU_PER_TWIP;
            let aligned = resolve_anchor_page_pos(&meta, self.section.as_ref());
            meta.page_x_emu = Some(JsNum(match &aligned {
                Some(aligned) => aligned.x_emu.0 + mar_l,
                None => {
                    (if meta.rel_h.as_deref() == Some("margin") {
                        mar_l
                    } else {
                        0.0
                    }) + or_zero(meta.offset_x_emu)
                }
            }));
            // aligned V resolves on its own: a posOffset X leaves `aligned` null
            let aligned_y = resolve_anchor_page_y_emu(&meta, self.section.as_ref());
            meta.page_y_emu = Some(JsNum(match aligned_y {
                Some(y) => y + mar_t,
                None => or_zero(meta.offset_y_emu),
            }));
            self.frag_metas[index] = meta.clone();
        }
        let page_pos = if meta.page_x_emu.is_none() {
            resolve_anchor_page_pos(&meta, self.section.as_ref())
        } else {
            None
        };
        let extent_cy = parse_int(
            js_regex!(r#"<wp:extent[^>]*cy="(\d+)""#)
                .exec(frag)
                .and_then(|found| found.get(1))
                .unwrap_or(""),
            Radix::Ten,
        );
        let inline_extent_px = if meta.anchored != Some(true) && extent_cy > 0.0 {
            emu_to_px(extent_cy)
        } else {
            0.0
        };
        let mut state = Frag {
            meta,
            page_pos,
            wsp_count: 0,
            inline_extent_px,
        };
        self.walk_shapes(&parsed_frag, None, None, false, &mut state)?;
        // picture-only drawing sharing a multi-drawing paragraph: a photo box.
        // Inline pics in a paragraph that also anchors drawings stay out: they
        // flow as stray run images, keeping every box floating (overlay layout)
        if self.opts.pictures
            && state.wsp_count == 0
            && frag.contains("<pic:pic")
            && (state.meta.anchored == Some(true) || !self.xml.contains("<wp:anchor"))
        {
            let r_id = js_regex!(r#"<a:blip[^>]*r:embed\s*=\s*["']([^"']+)["']"#)
                .exec(frag)
                .and_then(|found| found.get(1))
                .or_else(|| {
                    js_regex!(r#"<a:blip[^>]*r:link\s*=\s*["']([^"']+)["']"#)
                        .exec(frag)
                        .and_then(|found| found.get(1))
                });
            let data_url = media_of(self.ctx, r_id);
            let (ext_cx, ext_cy) = extent_px_pair(frag);
            if let Some(data_url) = data_url
                && ext_cx.is_finite()
                && ext_cy.is_finite()
            {
                let pic_id = js_regex!(r#"<pic:cNvPr\b[^>]*\bid="([^"]+)""#)
                    .exec(frag)
                    .and_then(|found| found.get(1));
                let mut b = picture_box(pic_id, data_url, emu_to_px(ext_cx), emu_to_px(ext_cy));
                // rotation lives on the pic's own xfrm (same read as imageMeta)
                let pic_sp_pr = js_regex!(r"<pic:spPr[^>]*>([\s\S]*?)<\/pic:spPr>")
                    .exec(frag)
                    .and_then(|found| found.get(1))
                    .unwrap_or("");
                let pic_xfrm = js_regex!(r"<a:xfrm([^>]*)>")
                    .exec(pic_sp_pr)
                    .and_then(|found| found.get(1));
                let rot = parse_int(
                    js_regex!(r#"\brot="(-?\d+)""#)
                        .exec(pic_xfrm.unwrap_or(""))
                        .and_then(|found| found.get(1))
                        .unwrap_or(""),
                    Radix::Ten,
                );
                if rot.is_finite() && rot != 0.0 {
                    b.rot_deg.set(JsNum(math_round(rot / 60000.0)));
                }
                // Word clips the photo to its preset geometry (rounded, flowchart...)
                let pic_prst = js_regex!(r#"<a:prstGeom\b[^>]*\bprst="([^"]+)""#)
                    .exec(pic_sp_pr)
                    .and_then(|found| found.get(1));
                if let Some(prst) = pic_prst.filter(|prst| *prst != "rect") {
                    b.prst.set(prst.to_owned());
                }
                let meta = state.meta.clone();
                self.apply_anchor(&mut b, &meta, state.page_pos.as_ref(), false);
                self.out.push(b);
            }
        }
        Ok(())
    }

    /// `walkShapes`: a document-order walk (box order must match
    /// w:txbxContent order for the patch-save mapping), carrying the enclosing
    /// wpg group transform and fill; anything below a wps:wsp lives inside its
    /// txbx and is nested.
    fn walk_shapes(
        &mut self,
        nodes: &[XNode],
        ctm: Option<GroupCtm>,
        group_fill: Option<&str>,
        nested: bool,
        frag: &mut Frag,
    ) -> Result<(), Thrown> {
        for node in nodes {
            let name = node.name();
            if name == Some("wps:wsp") {
                self.push_shape(node, ctm, group_fill, nested, frag)?;
            }
            if name == Some("pic:pic")
                && self.opts.pictures
                && let Some(ctm) = ctm
            {
                self.push_pic(node, Some(ctm), frag);
            }
            if name == Some("wpg:wgp") || name == Some("wpg:grpSp") {
                let own_fill = color_node_hex(
                    node.find_child("wpg:grpSpPr")
                        .and_then(|props| props.find_child("a:solidFill")),
                    self.ctx.resolver.theme_colors.as_ref(),
                );
                let fill = own_fill.or_else(|| group_fill.map(str::to_owned));
                let composed = compose_group_ctm(node, &ctm.unwrap_or(IDENTITY_CTM)).or(ctm);
                self.walk_shapes(node.children(), composed, fill.as_deref(), nested, frag)?;
            } else {
                self.walk_shapes(
                    node.children(),
                    ctm,
                    group_fill,
                    nested || name == Some("wps:wsp"),
                    frag,
                )?;
            }
        }
        Ok(())
    }

    /// `pushShape`
    fn push_shape(
        &mut self,
        shape: &XNode,
        ctm: Option<GroupCtm>,
        group_fill: Option<&str>,
        nested: bool,
        frag: &mut Frag,
    ) -> Result<(), Thrown> {
        frag.wsp_count += 1;
        let Some(mut b) = self.build_wps_box(shape, group_fill, nested, ctm.is_some())? else {
            return Ok(());
        };
        if let Some(ctm) = ctm {
            let xfrm = shape
                .find_child("wps:spPr")
                .and_then(|sp_pr| sp_pr.find_child("a:xfrm"));
            let off = xfrm.and_then(|xfrm| xfrm.find_child("a:off"));
            let x = int_attr(off, "x");
            let y = int_attr(off, "y");
            if x.is_finite() {
                b.offset_x_emu
                    .set(JsNum(math_round(ctm.tx.0 + x * ctm.sx.0)));
            }
            if y.is_finite() {
                b.offset_y_emu
                    .set(JsNum(math_round(ctm.ty.0 + y * ctm.sy.0)));
            }
            let truthy = |v: Option<JsNum>| v.filter(|v| v.0 != 0.0 && !v.0.is_nan());
            if ctm.sx.0 != 1.0
                && let Some(width) = truthy(*b.width_px)
            {
                b.width_px.set(JsNum(math_round(width.0 * ctm.sx.0)));
            }
            if ctm.sy.0 != 1.0 {
                if let Some(height) = truthy(*b.height_px) {
                    b.height_px.set(JsNum(math_round(height.0 * ctm.sy.0)));
                }
                if let Some(min_height) = truthy(*b.min_height_px) {
                    b.min_height_px
                        .set(JsNum(math_round(min_height.0 * ctm.sy.0)));
                }
            }
            // grouped shapes place absolutely at their mapped offset like Word
            b.floating.set(true);
            if frag.inline_extent_px > 0.0 {
                b.inline_extent_px.set(JsNum(frag.inline_extent_px));
            }
        }
        let meta = frag.meta.clone();
        self.apply_anchor(&mut b, &meta, frag.page_pos.as_ref(), ctm.is_some());
        self.out.push(b);
        Ok(())
    }

    /// `pushPic`: a grouped pic:pic (photo inside a wpg group) as a photo box
    /// at the mapped child offset, painted in document order between its
    /// sibling shapes.
    fn push_pic(&mut self, node: &XNode, ctm: Option<GroupCtm>, frag: &mut Frag) {
        let blip = node
            .find_child("pic:blipFill")
            .and_then(|fill| fill.find_child("a:blip"));
        let r_id = blip
            .and_then(|blip| blip.attr("r:embed"))
            .or_else(|| blip.and_then(|blip| blip.attr("r:link")));
        let Some(data_url) = media_of(self.ctx, r_id.filter(|id| !id.is_empty())) else {
            return;
        };
        let xfrm = node
            .find_child("pic:spPr")
            .and_then(|sp_pr| sp_pr.find_child("a:xfrm"));
        let ext = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
        let cx = int_attr(ext, "cx");
        let cy = int_attr(ext, "cy");
        if cx.is_nan() || cx <= 0.0 || cy.is_nan() || cy <= 0.0 {
            return;
        }
        let rot = int_attr(xfrm, "rot");
        let pic_id = node
            .find_child("pic:nvPicPr")
            .and_then(|nv| nv.find_child("pic:cNvPr"))
            .and_then(|c| c.attr("id"));
        let sx = ctm.map_or(1.0, |ctm| ctm.sx.0);
        let sy = ctm.map_or(1.0, |ctm| ctm.sy.0);
        let mut b = picture_box(pic_id, data_url, emu_to_px(cx * sx), emu_to_px(cy * sy));
        if rot.is_finite() && rot != 0.0 {
            b.rot_deg.set(JsNum(math_round(rot / 60000.0)));
        }
        if let Some(ctm) = ctm {
            let off = xfrm.and_then(|xfrm| xfrm.find_child("a:off"));
            let x = int_attr(off, "x");
            let y = int_attr(off, "y");
            if x.is_finite() {
                b.offset_x_emu
                    .set(JsNum(math_round(ctm.tx.0 + x * ctm.sx.0)));
            }
            if y.is_finite() {
                b.offset_y_emu
                    .set(JsNum(math_round(ctm.ty.0 + y * ctm.sy.0)));
            }
            b.floating.set(true);
            if frag.inline_extent_px > 0.0 {
                b.inline_extent_px.set(JsNum(frag.inline_extent_px));
            }
        }
        let meta = frag.meta.clone();
        self.apply_anchor(&mut b, &meta, frag.page_pos.as_ref(), ctm.is_some());
        self.out.push(b);
    }
}

/// `(w / EMU_PER_PX)` to 1/100 px.
fn round_hundredths(emu: f64) -> f64 {
    math_round((emu / EMU_PER_PX) * 100.0) / 100.0
}

impl<'a, 'c> Textboxes<'a, 'c> {
    /// `buildWpsBox`: one wps:wsp as a display box; `None` when it renders
    /// nothing.
    fn build_wps_box(
        &mut self,
        shape: &XNode,
        group_fill: Option<&str>,
        nested: bool,
        grouped: bool,
    ) -> Result<Option<TextboxDisplay>, Thrown> {
        let ctx = self.ctx;
        let theme = ctx.resolver.theme_colors.as_ref();
        let mut contents: Vec<&XNode> = Vec::new();
        collect_nodes(shape.children(), "w:txbxContent", &mut contents);
        // only top-level contents of a top-level shape consume a save-path
        // ordinal: xmlSegments never descends into a segment, so neither a
        // textbox nested inside another nor a shape living inside some other
        // box's w:txbxContent may advance the counter
        let mut top_contents: Vec<&XNode> = Vec::new();
        collect_top_nodes(shape.children(), "w:txbxContent", &mut top_contents);
        let ordinal = self.txbx_ordinal;
        if !nested {
            self.txbx_ordinal += top_contents.len() as f64;
        }
        // external textbox part (wps:txbx r:txbx, word/txbx*.xml): its root
        // w14:txbx carries the w:p list directly. Display-only: it stays out of
        // topContents, so the box takes no save ordinal and turns readOnly below.
        let mut external: Vec<XNode> = Vec::new();
        if contents.is_empty() {
            let ext_rid = shape
                .find_child("wps:txbx")
                .and_then(|txbx| txbx.attr("r:txbx"))
                .filter(|rid| !rid.is_empty());
            let ext_xml = ext_rid
                .and_then(|rid| {
                    ctx.external_txbx_by_rid
                        .as_ref()
                        .and_then(|parts| parts.get(rid))
                })
                .filter(|xml| !xml.is_empty());
            if let Some(ext_xml) = ext_xml
                // an unreadable part falls through to the textless-shape path
                && let Ok(nodes) = parse_ordered(ext_xml, XML_PARSER_MAX_NESTED_TAGS)
                && let Some(root) = nodes
                    .into_iter()
                    .find(|node| node.name().is_some_and(|name| name.ends_with(":txbx")))
            {
                external.push(root);
            }
        }
        contents.extend(external.iter());
        let sp_pr = shape.find_child("wps:spPr");
        let prst_of = sp_pr
            .and_then(|sp_pr| sp_pr.find_child("a:prstGeom"))
            .and_then(|geom| geom.attr("prst"))
            .filter(|prst| !prst.is_empty());
        let cust_geom_node = sp_pr.and_then(|sp_pr| sp_pr.find_child("a:custGeom"));
        if contents.is_empty() {
            if let Some(prst) = prst_of
                && LINE_PRSTS.contains(&prst)
            {
                if self.has_line_shapes {
                    return Ok(line_box_of(shape, theme));
                }
                if !self.opts.shapes {
                    return Ok(None);
                }
                // anchored gallery connector: a real vertical extent, flips, or
                // arrow ends mark a drawn connector; plain near-flat lines stay
                // on the decorative thin-rule path
                let xfrm = sp_pr.and_then(|sp_pr| sp_pr.find_child("a:xfrm"));
                let cy = int_attr(xfrm.and_then(|xfrm| xfrm.find_child("a:ext")), "cy");
                let flipped = ["flipH", "flipV"]
                    .iter()
                    .any(|key| matches!(xfrm.and_then(|xfrm| xfrm.attr(key)), Some("1" | "true")));
                let ln = sp_pr.and_then(|sp_pr| sp_pr.find_child("a:ln"));
                let arrowed = ["a:headEnd", "a:tailEnd"].iter().any(|name| {
                    ln.and_then(|ln| ln.find_child(name))
                        .and_then(|end| end.attr("type"))
                        .is_some_and(|kind| !kind.is_empty() && kind != "none")
                });
                return Ok(
                    if (cy.is_finite() && cy > 130_000.0) || flipped || arrowed {
                        line_box_of(shape, theme)
                    } else {
                        None
                    },
                );
            }
            if self.has_line_shapes && !self.opts.shapes {
                return Ok(None);
            }
            if !self.opts.shapes || (prst_of.is_none() && cust_geom_node.is_none()) {
                return Ok(None);
            }
            if prst_of == Some("rect") {
                // near-flat rects stay on the decorative thin-rule path; a real
                // rectangle (pattern/solid-filled swatch, tdf dml-shape-fillpattern)
                // renders like any other textless preset shape
                let xfrm = sp_pr.and_then(|sp_pr| sp_pr.find_child("a:xfrm"));
                let cy = int_attr(xfrm.and_then(|xfrm| xfrm.find_child("a:ext")), "cy");
                // a filled strip sharing its paragraph (or group) with other
                // drawings is drawn geometry (Word masks part of a sibling
                // picture with it) and nothing else would paint it (the
                // decorative-rule path only takes a lone drawing paragraph)
                let filled_sibling = (grouped || self.multi_drawing)
                    && sp_pr.is_some_and(|sp_pr| sp_pr.find_child("a:solidFill").is_some());
                if !filled_sibling && (!cy.is_finite() || cy <= 130_000.0) {
                    return Ok(None);
                }
            }
        }
        let mut b = TextboxDisplay::default();
        b.paras.set(Vec::new());
        if !nested && !top_contents.is_empty() {
            b.txbx_index.set(JsNum(ordinal));
        }
        if nested {
            b.read_only.set(true);
        }
        let shape_id = shape
            .find_child("wps:cNvPr")
            .and_then(|c| c.attr("id"))
            .filter(|id| !id.is_empty());
        if !nested && let Some(shape_id) = shape_id {
            b.shape_id.set(shape_id.to_owned());
        }
        if let Some(sp_pr) = sp_pr {
            if sp_pr.find_child("a:noFill").is_none() {
                // a:pattFill approximates to its foreground color (same tradeoff as gradFill)
                let patt_fill = sp_pr.find_child("a:pattFill");
                let fill = color_node_hex(sp_pr.find_child("a:solidFill"), theme)
                    .or_else(|| grad_fill_approx_hex(sp_pr, theme))
                    .or_else(|| {
                        patt_fill.and_then(|patt| color_node_hex(patt.find_child("a:fgClr"), theme))
                    })
                    // a:grpFill inherits the enclosing wpg group's fill
                    .or_else(|| {
                        sp_pr
                            .find_child("a:grpFill")
                            .and_then(|_| group_fill.map(str::to_owned))
                    })
                    .filter(|fill| !fill.is_empty());
                if let Some(fill) = &fill {
                    b.fill.set(fill.clone());
                }
                let alpha = solid_fill_alpha(sp_pr.find_child("a:solidFill"));
                if fill.is_some()
                    && let Some(alpha) = alpha
                {
                    b.fill_alpha.set(JsNum(alpha));
                }
                if let Some(blip_fill) = sp_pr.find_child("a:blipFill") {
                    let r_id = blip_fill
                        .find_child("a:blip")
                        .and_then(|blip| blip.attr("r:embed"))
                        .filter(|id| !id.is_empty());
                    if let Some(data_url) = media_of(ctx, r_id) {
                        b.fill_image_data_url.set(data_url);
                        if blip_fill.find_child("a:tile").is_some() {
                            b.fill_tile.set(true);
                        }
                    }
                }
            }
            let ln = sp_pr.find_child("a:ln");
            if let Some(ln) = ln
                && ln.find_child("a:noFill").is_none()
            {
                if let Some(border) = color_node_hex(ln.find_child("a:solidFill"), theme)
                    .filter(|border| !border.is_empty())
                {
                    b.border_color.set(border);
                }
                let w = int_attr(Some(ln), "w");
                if w.is_finite() && w > 0.0 {
                    b.border_width_px.set(JsNum(round_hundredths(w)));
                }
                let dash = ln
                    .find_child("a:prstDash")
                    .and_then(|dash| dash.attr("val"))
                    .filter(|dash| !dash.is_empty());
                if let Some(dash) = dash
                    && dash != "solid"
                {
                    b.border_dash.set(if js_regex!(r"dot", "i").test(dash) {
                        TextboxDisplayBorderDash::Dotted
                    } else {
                        TextboxDisplayBorderDash::Dashed
                    });
                }
            }
            // shape-style references (wps:style): theme fill/line for shapes whose
            // spPr declares no explicit color (Word gallery shapes)
            if let Some(style_node) = shape.find_child("wps:style") {
                if b.fill.is_none()
                    && b.fill_image_data_url.is_none()
                    && sp_pr.find_child("a:noFill").is_none()
                    && let Some(r#ref) = style_node.find_child("a:fillRef")
                    && parse_int(r#ref.attr("idx").unwrap_or("0"), Radix::Ten) > 0.0
                    && let Some(fill) = color_node_hex(Some(r#ref), theme).filter(|f| !f.is_empty())
                {
                    b.fill.set(fill);
                }
                if b.border_color.is_none()
                    && !ln.is_some_and(|ln| ln.find_child("a:noFill").is_some())
                    && let Some(r#ref) = style_node.find_child("a:lnRef")
                    && parse_int(r#ref.attr("idx").unwrap_or("0"), Radix::Ten) > 0.0
                    && let Some(border) =
                        color_node_hex(Some(r#ref), theme).filter(|border| !border.is_empty())
                {
                    b.border_color.set(border);
                }
                // a:fontRef is where a gallery shape's text color comes from: the
                // default blue shape references lt1, which is why Word and
                // PowerPoint show white text on it without writing a color on any
                // run. Runs with their own w:color win.
                if let Some(font_color) = color_node_hex(style_node.find_child("a:fontRef"), theme)
                    .filter(|color| !color.is_empty())
                {
                    b.text_color.set(font_color);
                }
            }
            if let Some(prst) = prst_of
                && prst != "rect"
            {
                b.prst.set(prst.to_owned());
            }
            let xfrm = sp_pr.find_child("a:xfrm");
            if cust_geom_node.is_some() {
                let ext_attrs = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
                let or_zero = |v: f64| if v.is_nan() { 0.0 } else { v };
                let geom = pptx_engine::custgeom::parse_cust_geom(
                    &serialize(sp_pr),
                    or_zero(int_attr(ext_attrs, "cx")),
                    or_zero(int_attr(ext_attrs, "cy")),
                )
                .map_err(|limit| limit.to_string())?;
                if let Some(geom) = geom {
                    b.path_data.set(TextboxDisplayPathData {
                        path: geom.path,
                        fill_path: geom.fill_path,
                        stroke_path: geom.stroke_path,
                    });
                }
            }
            let rot = int_attr(xfrm, "rot");
            if rot.is_finite() && rot != 0.0 {
                b.rot_deg.set(JsNum(math_round(rot / 60000.0)));
            }
            let ext = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
            let cx = if ext.is_some() {
                int_attr(ext, "cx")
            } else {
                f64::NAN
            };
            if cx.is_finite() && cx > 0.0 {
                b.width_px.set(JsNum(math_round(cx / EMU_PER_PX)));
            }
            // Word clips overflowing text unless the shape auto-fits its content;
            // carrying the fixed height keeps tall sparse boxes from exploding layout
            let body_pr_node = shape.find_child("wps:bodyPr");
            let auto_fit =
                body_pr_node.is_some_and(|body_pr| body_pr.find_child("a:spAutoFit").is_some());
            let cy = if ext.is_some() {
                int_attr(ext, "cy")
            } else {
                f64::NAN
            };
            if !auto_fit && cy.is_finite() && cy > 0.0 {
                let height = JsNum(math_round(cy / EMU_PER_PX));
                b.height_px.set(height);
                b.min_height_px.set(height);
            }
        }
        let body_pr = shape.find_child("wps:bodyPr");
        if let Some(body_pr) = body_pr {
            let inset = |name: &str| {
                let emu = int_attr(Some(body_pr), name);
                (emu.is_finite() && emu >= 0.0).then(|| JsNum(round_hundredths(emu)))
            };
            b.inset_left_px.assign(inset("lIns"));
            b.inset_top_px.assign(inset("tIns"));
            b.inset_right_px.assign(inset("rIns"));
            b.inset_bottom_px.assign(inset("bIns"));
            match body_pr.attr("anchor") {
                Some("b") => b.v_align.set(TextboxDisplayVAlign::Bottom),
                Some("ctr") => b.v_align.set(TextboxDisplayVAlign::Center),
                _ => {}
            }
        }
        for content in &contents {
            let paras = txbx_content_paras(content, ctx, self.opts.doc_offset)?;
            if let Some(existing) = b.paras.as_mut() {
                existing.extend(paras);
            }
        }
        if contents
            .iter()
            .any(|content| txbx_has_structured_content(content))
        {
            b.read_only.set(true);
        }
        // a textbox nested inside this one flattens into paras above: a commit
        // would rewrite the outer w:p list and destroy the nested shape
        if contents.len() > top_contents.len() {
            b.read_only.set(true);
        }
        if contents.is_empty() {
            // textless preset shape: keep it if the geometry has any visible ink
            if b.fill.is_none() && b.border_color.is_none() && b.fill_image_data_url.is_none() {
                return Ok(None);
            }
            // no w:txbxContent to patch: editable only when the cNvPr id gives
            // the save path a shape to inject a fresh wps:txbx into
            if b.shape_id.is_none() {
                b.read_only.set(true);
            }
            // Word centers shape text: without an explicit anchor the live preview
            // and the anchor="ctr" the inject path writes agree
            else if b.v_align.is_none()
                && !body_pr
                    .and_then(|body_pr| body_pr.attr("anchor"))
                    .is_some_and(|anchor| !anchor.is_empty())
            {
                b.v_align.set(TextboxDisplayVAlign::Center);
            }
            return Ok(Some(b));
        }
        if b.paras
            .as_ref()
            .is_some_and(|paras| paras.iter().any(txbx_para_visible))
        {
            return Ok(Some(b));
        }
        // text-empty box: keep visible ink (a full-page white box must occupy its
        // extent instead of degrading to a chip); its w:txbxContent stays
        // addressable, so typing into the empty shape still commits
        if b.fill.is_none() && b.border_color.is_none() && b.fill_image_data_url.is_none() {
            return Ok(None);
        }
        b.paras.set(Vec::new());
        Ok(Some(b))
    }
}

/// The v:shapetype templates of one `extractTextboxes` call.
struct VmlCx {
    /// the v:shapetype elements of the paragraph by id, the first of an id
    /// winning (`shapeTypes.find`)
    local: jscompat::JsMap<jscompat::JsObject<String>>,
    /// `vmlShapeTypeLookup`: the same, then the document-wide ones, without
    /// the empty
    lookup: jscompat::JsMap<jscompat::JsObject<String>>,
}

/// `attrsOf(node)` of an element: its attributes as an own-key record.
fn attrs_record(node: &XNode) -> jscompat::JsObject<String> {
    let mut record = jscompat::JsObject::new();
    for (name, value) in node.attrs().unwrap_or(&[]) {
        record.set(name.as_str(), value.clone());
    }
    record
}

fn capture<'t>(found: Option<jscompat::JsMatch<'t>>) -> Option<&'t str> {
    found.and_then(|found| found.get(1))
}

impl<'a, 'c> Textboxes<'a, 'c> {
    /// `vmlShapeTypeAttrs(type)`: the attributes of the v:shapetype a shape's
    /// `type="#id"` names, in the paragraph or document-wide.
    fn vml_shape_type_attrs<'s>(
        &'s self,
        cx: &'s VmlCx,
        shape_type: Option<&str>,
    ) -> Option<&'s jscompat::JsObject<String>> {
        let id = shape_type
            .and_then(|ty| ty.strip_prefix('#'))
            .filter(|id| !id.is_empty())?;
        cx.local.get(id).or_else(|| {
            self.ctx
                .vml_shape_types
                .as_ref()
                .and_then(|types| types.get(id))
        })
    }

    /// `placeVmlBox`: top-level absolute shapes float at their pt margins;
    /// group children float at the group origin plus scaled group coordinates.
    fn place_vml_box(
        &self,
        b: &mut TextboxDisplay,
        style: &str,
        scale: Option<VmlGroupScale>,
        origin: Option<VmlOrigin>,
    ) {
        if scale.is_none() && js_regex!(r"position:absolute").test(style) {
            b.floating.set(true);
            let mx = parse_float(
                capture(js_regex!(r"margin-left:(-?[\d.]+)pt").exec(style)).unwrap_or(""),
            );
            let my = parse_float(
                capture(js_regex!(r"margin-top:(-?[\d.]+)pt").exec(style)).unwrap_or(""),
            );
            if mx.is_finite() {
                b.offset_x_emu.set(JsNum(math_round(mx * EMU_PER_PT)));
            }
            if my.is_finite() {
                b.offset_y_emu.set(JsNum(math_round(my * EMU_PER_PT)));
            }
            if let Some(section) = self.opts.section {
                apply_vml_mso_position(b, style, section);
            }
        } else if let (Some(scale), Some(origin)) = (scale, origin) {
            b.floating.set(true);
            b.offset_x_emu.set(JsNum(math_round(
                vml_coord_px(style, Coord::Left, scale, origin) * EMU_PER_PX,
            )));
            b.offset_y_emu.set(JsNum(math_round(
                vml_coord_px(style, Coord::Top, scale, origin) * EMU_PER_PX,
            )));
        }
    }

    /// `vmlPicBox`: a VML picture shape (v:imagedata with an r:id) as a photo
    /// box, like the DrawingML pushPic path: dropping it loses real page
    /// content.
    fn vml_pic_box(
        &mut self,
        shape: &XNode,
        scale: Option<VmlGroupScale>,
        origin: Option<VmlOrigin>,
    ) -> bool {
        let r_id = shape
            .find_child("v:imagedata")
            .and_then(|data| data.attr("r:id"))
            .filter(|id| !id.is_empty());
        let Some(data_url) = media_of(self.ctx, r_id) else {
            return false;
        };
        let style = shape.attr("style").unwrap_or("");
        let mut b = TextboxDisplay::default();
        b.paras.set(Vec::new());
        b.read_only.set(true);
        b.fill_image_data_url.set(data_url);
        b.inset_top_px.set(JsNum(0.0));
        b.inset_right_px.set(JsNum(0.0));
        b.inset_bottom_px.set(JsNum(0.0));
        b.inset_left_px.set(JsNum(0.0));
        if let Some(w) =
            vml_shape_dim_px(style, Dim::Width, scale).filter(|w| *w != 0.0 && !w.is_nan())
        {
            b.width_px.set(JsNum(w));
        }
        if let Some(h) =
            vml_shape_dim_px(style, Dim::Height, scale).filter(|h| *h != 0.0 && !h.is_nan())
        {
            b.height_px.set(JsNum(h));
        }
        self.place_vml_box(&mut b, style, scale, origin);
        self.out.push(b);
        true
    }

    /// `vmlGeomBox`: textless VML geometry with a visible fill or stroke
    /// (callout tabs, path-drawn table backdrops): rendered, not silently
    /// dropped.
    fn vml_geom_box(
        &mut self,
        shape: &XNode,
        scale: Option<VmlGroupScale>,
        origin: Option<VmlOrigin>,
        cx: &VmlCx,
    ) {
        let style = shape.attr("style").unwrap_or("");
        if shape.attr("o:hr") == Some("t") || js_regex!(r"visibility:\s*hidden").test(style) {
            return;
        }
        // a picture shape (t75) whose image did not resolve draws no frame
        if shape.attr("o:spt") == Some("75")
            || js_regex!(r"_x0000_t75\b").test(shape.attr("type").unwrap_or(""))
        {
            return;
        }
        // floating top-level shapes draw like header/footer shapes: the SVG path
        // keeps VML's default black stroke, gradients and shapetype geometry.
        // Canvas children (unitless dims) and inline shapes (run images) stay
        // on the box path below.
        let shape_xml = (scale.is_none() && js_regex!(r"position:\s*absolute").test(style))
            .then(|| serialize(shape));
        let svg = shape_xml
            .as_deref()
            .filter(|xml| !is_invisible_vml_pict(xml))
            .and_then(|xml| vml_shape_svg(xml, Some(&cx.lookup)));
        if let Some(svg) = svg {
            let mut b = TextboxDisplay::default();
            b.paras.set(Vec::new());
            b.read_only.set(true);
            b.fill_image_data_url.set(svg.data_url);
            b.width_px.set(svg.width_px);
            b.height_px.set(svg.height_px);
            b.inset_top_px.set(JsNum(0.0));
            b.inset_right_px.set(JsNum(0.0));
            b.inset_bottom_px.set(JsNum(0.0));
            b.inset_left_px.set(JsNum(0.0));
            if js_regex!(r"z-index:\s*-").test(style) {
                b.behind.set(true);
            }
            if let Some(rot) = vml_rotation_deg(style) {
                b.rot_deg.set(JsNum(rot));
            }
            self.place_vml_box(&mut b, style, scale, origin);
            self.out.push(b);
            return;
        }
        let fill = if shape.attr("filled") == Some("f") {
            None
        } else {
            vml_color_hex(shape.attr("fillcolor"))
        };
        // VML strokes default on/black; like the textbox path, only canvas
        // (group) children get that default: top-level shapes need an explicit
        // strokecolor so converter placeholder furniture stays invisible
        let stroke = if shape.attr("stroked") == Some("f") {
            None
        } else {
            vml_color_hex(shape.attr("strokecolor"))
                .or_else(|| scale.is_some().then(|| "000000".to_owned()))
        };
        // white unstroked placeholders draw nothing in Word (isInvisibleVmlPict)
        let blank_fill = fill
            .as_deref()
            .is_none_or(|fill| fill.is_empty() || fill.to_uppercase() == "FFFFFF");
        let has_stroke = stroke.as_deref().is_some_and(|stroke| !stroke.is_empty());
        if blank_fill && !has_stroke {
            return;
        }
        let w = vml_shape_dim_px(style, Dim::Width, scale).filter(|w| *w != 0.0 && !w.is_nan());
        let h = vml_shape_dim_px(style, Dim::Height, scale).filter(|h| *h != 0.0 && !h.is_nan());
        let (Some(w), Some(h)) = (w, h) else {
            return;
        };
        let mut b = TextboxDisplay::default();
        b.paras.set(Vec::new());
        b.read_only.set(true);
        b.width_px.set(JsNum(w));
        b.height_px.set(JsNum(h));
        b.min_height_px.set(JsNum(h));
        b.inset_top_px.set(JsNum(0.0));
        b.inset_right_px.set(JsNum(0.0));
        b.inset_bottom_px.set(JsNum(0.0));
        b.inset_left_px.set(JsNum(0.0));
        if let Some(fill) = fill.filter(|fill| !fill.is_empty()) {
            b.fill.set(fill);
        }
        if let Some(stroke) = stroke.filter(|stroke| !stroke.is_empty()) {
            b.border_color.set(stroke);
        }
        match shape.name() {
            Some("v:roundrect") => b.prst.set("roundRect".to_owned()),
            Some("v:oval") => b.prst.set("ellipse".to_owned()),
            _ => {}
        }
        if let Some(path) = shape.attr("path").filter(|path| !path.is_empty()) {
            let coord_size =
                js_regex!(r"^\s*(\d+)[,\s]+(\d+)").exec(shape.attr("coordsize").unwrap_or(""));
            let d = coord_size.and_then(|cs| {
                vml_path_to_norm_d(
                    path,
                    parse_int(cs.get(1).unwrap_or(""), Radix::Ten),
                    parse_int(cs.get(2).unwrap_or(""), Radix::Ten),
                )
            });
            // an unconvertible path must not degrade to a solid bounding box
            let Some(d) = d.filter(|d| !d.is_empty()) else {
                return;
            };
            b.path_data.set(TextboxDisplayPathData {
                path: Some(d),
                fill_path: None,
                stroke_path: None,
            });
        }
        self.place_vml_box(&mut b, style, scale, origin);
        self.out.push(b);
    }

    /// `vmlBox`: children of a v:group (drawing canvas) position and size in
    /// the group's own coordinate space (unitless style values); the scale
    /// maps them to px.
    fn vml_box(
        &mut self,
        shape: &XNode,
        scale: Option<VmlGroupScale>,
        origin: Option<VmlOrigin>,
        nested: bool,
        cx: &VmlCx,
    ) -> Result<(), Thrown> {
        let style = shape.attr("style").unwrap_or("");
        let mut contents: Vec<&XNode> = Vec::new();
        collect_nodes(shape.children(), "w:txbxContent", &mut contents);
        if contents.is_empty() {
            if let Some(word_art) = vml_word_art_box(shape) {
                self.out.push(word_art);
                return Ok(());
            }
            // a shape nested inside some textbox's content must not escape onto
            // the page as a sibling box
            if nested {
                return Ok(());
            }
            if self.vml_pic_box(shape, scale, origin) {
                return Ok(());
            }
            self.vml_geom_box(shape, scale, origin, cx);
            return Ok(());
        }
        let mut top_contents: Vec<&XNode> = Vec::new();
        collect_top_nodes(shape.children(), "w:txbxContent", &mut top_contents);
        let mut b = TextboxDisplay::default();
        b.paras.set(Vec::new());
        if !nested {
            b.txbx_index.set(JsNum(self.txbx_ordinal));
            self.txbx_ordinal += top_contents.len() as f64;
        }
        if nested || contents.len() > top_contents.len() {
            b.read_only.set(true);
        }
        // VML shape: geometry from the style attribute, colors from fillcolor/strokecolor
        let truthy = |v: Option<f64>| v.filter(|v| *v != 0.0 && !v.is_nan());
        if let Some(w) = truthy(vml_shape_dim_px(style, Dim::Width, scale)) {
            b.width_px.set(JsNum(w));
        }
        let h = truthy(vml_shape_dim_px(style, Dim::Height, scale));
        // mso-fit-shape-to-text: Word resizes the shape to its text, so the
        // declared height is stale and the box sizes to content like autofit
        let fit_to_text = js_regex!(r"mso-fit-shape-to-text:\s*t").test(
            shape
                .find_child("v:textbox")
                .and_then(|textbox| textbox.attr("style"))
                .unwrap_or(""),
        );
        if let Some(h) = h
            && !fit_to_text
        {
            b.height_px.set(JsNum(h));
            b.min_height_px.set(JsNum(h));
        }
        let type_attrs = self.vml_shape_type_attrs(cx, shape.attr("type"));
        let inherited = |name: &str| -> Option<&str> {
            shape.attr(name).or_else(|| {
                type_attrs
                    .and_then(|attrs| attrs.get(name))
                    .map(String::as_str)
            })
        };
        let fill = vml_color_hex(inherited("fillcolor"));
        if let Some(fill) = fill.filter(|fill| !fill.is_empty())
            && !vml_flag_off(inherited("filled"))
        {
            b.fill.set(fill);
        }
        match shape.name() {
            Some("v:roundrect") => b.prst.set("roundRect".to_owned()),
            Some("v:oval") => b.prst.set("ellipse".to_owned()),
            _ => {}
        }
        // VML strokes default to on/black (Word draws every textbox frame that
        // is not switched off on the shape, its shapetype or a v:stroke child)
        if !vml_flag_off(inherited("stroked")) && !vml_stroke_child_off(shape) {
            b.border_color.set(
                vml_color_hex(inherited("strokecolor")).unwrap_or_else(|| "000000".to_owned()),
            );
            if let Some(weight) = vml_stroke_weight_px(inherited("strokeweight")) {
                b.border_width_px.set(JsNum(weight));
            }
        }
        // absolutely positioned VML shape: leaves the flow like a wp:anchor box
        // (page banners stack at full height otherwise, tdf 1194 family).
        // Canvas (v:group) children float at their scaled group coordinates.
        self.place_vml_box(&mut b, style, scale, origin);
        for content in &contents {
            let paras = txbx_content_paras(content, self.ctx, self.opts.doc_offset)?;
            if let Some(existing) = b.paras.as_mut() {
                existing.extend(paras);
            }
        }
        if contents
            .iter()
            .any(|content| txbx_has_structured_content(content))
        {
            b.read_only.set(true);
        }
        // a text-empty box still paints its ink (a filled banner shape holding
        // one blank paragraph); white unstroked placeholders stay invisible
        let inked = b
            .fill
            .as_ref()
            .is_some_and(|fill| fill.to_uppercase() != "FFFFFF")
            || b.border_color
                .as_ref()
                .is_some_and(|color| !color.is_empty());
        if b.paras
            .as_ref()
            .is_some_and(|paras| paras.iter().any(txbx_para_visible))
            || inked
        {
            self.out.push(b);
        }
        Ok(())
    }

    /// `walkVml`
    fn walk_vml(
        &mut self,
        nodes: &[XNode],
        scale: Option<VmlGroupScale>,
        origin: Option<VmlOrigin>,
        nested: bool,
        cx: &VmlCx,
    ) -> Result<(), Thrown> {
        for node in nodes {
            let name = node.name();
            if name == Some("v:group") {
                let g_scale = vml_group_scale(node, scale);
                let g_style = node.attr("style").unwrap_or("");
                let mut g_origin: Option<VmlOrigin> = None;
                if let (Some(_), Some(scale), Some(origin)) = (g_scale, scale, origin) {
                    // nested group: placed in the parent group's coordinate space
                    g_origin = Some(VmlOrigin {
                        x: vml_coord_px(g_style, Coord::Left, scale, origin),
                        y: vml_coord_px(g_style, Coord::Top, scale, origin),
                    });
                } else if g_scale.is_some() && js_regex!(r"position:absolute").test(g_style) {
                    let mx = parse_float(
                        capture(js_regex!(r"margin-left:(-?[\d.]+)pt").exec(g_style)).unwrap_or(""),
                    );
                    let my = parse_float(
                        capture(js_regex!(r"margin-top:(-?[\d.]+)pt").exec(g_style)).unwrap_or(""),
                    );
                    g_origin = Some(VmlOrigin {
                        x: if mx.is_finite() {
                            (mx * 96.0) / 72.0
                        } else {
                            0.0
                        },
                        y: if my.is_finite() {
                            (my * 96.0) / 72.0
                        } else {
                            0.0
                        },
                    });
                } else if g_scale.is_some() && !nested {
                    // inline canvas: reserve its flow footprint so the floated
                    // children overlay it instead of collapsing the paragraph
                    let truthy = |v: Option<f64>| v.filter(|v| *v != 0.0 && !v.is_nan());
                    let w = truthy(vml_shape_dim_px(g_style, Dim::Width, scale));
                    let h = truthy(vml_shape_dim_px(g_style, Dim::Height, scale));
                    if let (Some(w), Some(h)) = (w, h) {
                        let mut reserve = TextboxDisplay::default();
                        reserve.paras.set(Vec::new());
                        reserve.read_only.set(true);
                        reserve.width_px.set(JsNum(w));
                        reserve.height_px.set(JsNum(h));
                        reserve.min_height_px.set(JsNum(h));
                        reserve.inset_top_px.set(JsNum(0.0));
                        reserve.inset_right_px.set(JsNum(0.0));
                        reserve.inset_bottom_px.set(JsNum(0.0));
                        reserve.inset_left_px.set(JsNum(0.0));
                        self.out.push(reserve);
                        g_origin = Some(VmlOrigin { x: 0.0, y: 0.0 });
                    }
                }
                // children position from coordorigin, not 0,0 (drawing canvases)
                if let (Some(g_scale), Some(current)) = (g_scale, g_origin)
                    && let Some(co) = js_regex!(r"^\s*(-?\d+)[,\s]+(-?\d+)")
                        .exec(node.attr("coordorigin").unwrap_or(""))
                {
                    g_origin = Some(VmlOrigin {
                        x: current.x
                            - parse_int(co.get(1).unwrap_or(""), Radix::Ten) * g_scale.sx.0,
                        y: current.y
                            - parse_int(co.get(2).unwrap_or(""), Radix::Ten) * g_scale.sy.0,
                    });
                }
                self.walk_vml(
                    node.children(),
                    g_scale.or(scale),
                    if g_scale.is_some() { g_origin } else { None },
                    nested,
                    cx,
                )?;
                continue;
            }
            if matches!(name, Some("v:shape" | "v:rect" | "v:roundrect" | "v:oval")) {
                self.vml_box(node, scale, origin, nested, cx)?;
            }
            // below a w:txbxContent = inside some box: consumes no save ordinal
            self.walk_vml(
                node.children(),
                scale,
                origin,
                nested || name == Some("w:txbxContent"),
                cx,
            )?;
        }
        Ok(())
    }

    /// The legacy VML shapes (w:pict, outside w:drawing fragments).
    fn legacy_vml(&mut self) -> Result<(), Thrown> {
        if !js_regex!(r"<v:(?:shape|rect|roundrect|oval)\b").test(self.xml) {
            return Ok(());
        }
        let Ok(parsed) = parse_ordered(self.xml, XML_PARSER_MAX_NESTED_TAGS) else {
            return Ok(());
        };
        let mut shape_types: Vec<&XNode> = Vec::new();
        collect_nodes(&parsed, "v:shapetype", &mut shape_types);
        let mut local = jscompat::JsMap::new();
        for node in &shape_types {
            if let Some(id) = node.attr("id")
                && !local.has(id)
            {
                local.set(id, attrs_record(node));
            }
        }
        let mut lookup = jscompat::JsMap::new();
        for (id, attrs) in local.iter() {
            lookup.set(id, attrs.clone());
        }
        if let Some(types) = &self.ctx.vml_shape_types {
            for (id, attrs) in types.iter() {
                if !lookup.has(id) && !attrs.is_empty() {
                    lookup.set(id, attrs.clone());
                }
            }
        }
        let cx = VmlCx { local, lookup };
        self.walk_vml(&parsed, None, None, false, &cx)
    }

    /// lockedCanvas text shapes (a:txSp): DrawingML a:p/a:r/a:t text bodies
    /// inside a drawing canvas (logo lockups etc.) that neither the wps nor the
    /// VML path sees. Display-only, so all characters at least remain visible.
    fn canvas_text(&mut self) {
        let Ok(parsed_all) = parse_ordered(self.xml, XML_PARSER_MAX_NESTED_TAGS) else {
            return;
        };
        let mut tx_sps: Vec<&XNode> = Vec::new();
        collect_nodes(&parsed_all, "a:txSp", &mut tx_sps);
        for sp in tx_sps {
            let Some(body) = sp.find_child("a:txBody") else {
                continue;
            };
            let mut paras: Vec<TextboxParaDisplay> = Vec::new();
            for p in body.children() {
                if p.name() != Some("a:p") {
                    continue;
                }
                let mut runs: Vec<Run> = Vec::new();
                for r in p.children() {
                    if r.name() != Some("a:r") {
                        continue;
                    }
                    let text = r
                        .find_child("a:t")
                        .map(|t| decode_numeric_char_refs(&t.text()).into_owned())
                        .unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    let mut run = Run::default();
                    run.text.set(text);
                    if let Some(r_pr) = r.find_child("a:rPr") {
                        let sz = parse_int(r_pr.attr("sz").unwrap_or(""), Radix::Ten);
                        // a:sz is in hundredths of a point
                        if sz.is_finite() && sz > 0.0 {
                            run.size_half_points.set(JsNum(math_round(sz / 50.0)));
                        }
                        if r_pr.attr("b") == Some("1") {
                            run.bold.set(true);
                        }
                        let latin = r_pr
                            .find_child("a:latin")
                            .and_then(|latin| latin.attr("typeface"))
                            .filter(|latin| !latin.is_empty());
                        if let Some(latin) = latin
                            && !latin.starts_with('+')
                        {
                            run.font.set(latin.to_owned());
                        }
                    }
                    runs.push(run);
                }
                if !runs.is_empty() {
                    let mut para = TextboxParaDisplay {
                        runs,
                        ..TextboxParaDisplay::default()
                    };
                    if p.find_child("a:pPr").and_then(|p_pr| p_pr.attr("algn")) == Some("ctr") {
                        para.para_format.align.set(ParaAlign::Center);
                    }
                    paras.push(para);
                }
            }
            if !paras.is_empty() {
                let mut b = TextboxDisplay::default();
                b.paras.set(paras);
                b.read_only.set(true);
                self.out.push(b);
            }
        }
    }
}
