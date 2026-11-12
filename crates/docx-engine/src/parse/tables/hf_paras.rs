//! The display paragraphs of a header/footer part: text paragraphs, layout
//! tables as one paragraph per row, and the cells' content.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use jscompat::{JsMap, JsNum, js_regex, to_number};
use ooxml_pkg::Package;
use ooxml_xml::{XNode, parse_ordered};

use super::hf::{
    anchor_doc_pr_ids, has_deep_child_outside, hf_line, hf_only_empty_runs, hf_table_float_of,
    without_resolved_geometry,
};
use super::hf_root::{HfRootName, hf_kept_root, hf_wrap_namespaces};
use super::{children_through_sdt, slice_range};
use crate::char_class::is_east_asian_lang_tag;
use crate::model::{
    CellBorder, CellBorders, CellMargins, HfCellParaProps, HfParagraph, HfParagraphFrameXAlign,
    HfParagraphPtabAlignsItem, HfTableCell, HfTableCellVAlign, HfTableRow, HfTableRowAlign,
    HfTableRowHeightRule, HfTableRowSource, HfTableRowTabOverflow, ParaAlign, ParaFormat,
    ParaFormatLineRule, Run, SharedStr, TableBorders, True,
};
use crate::package::Thrown;
use crate::parse::drawings::host::MediaEnv;
use crate::parse::drawings::textbox::textbox_paragraphs;
use crate::parse::drawings::vml::{has_deep_child, has_floating_vml_picture};
use crate::parse::text::{
    BuildContext, bridge, cell_resolver_of, extract_para_format, extract_runs, extract_runs_plain,
    merge_tab_stops,
};
use crate::props::{
    EMPTY_EA_THEME_FONT, XML_PARSER_MAX_NESTED_TAGS, cell_margins_of, empty_para_size_half_points,
    merged_border_lines_of,
};
use crate::resolve::{
    EffectiveParaFormatOptions, PropSource, ResolveCtx, ResolveParaOptions, effective_line_format,
    effective_para_format, effective_spacing_twips, hf_line_sources, resolve_paragraph_props,
};
use crate::styles::{StyleDisplay, StyleInfo};
use crate::xml_text::{bool_prop, strip_hash};

/// `TXBX_CONTENT`, `WP_INLINE`, `WP_ANCHOR`
const TXBX_CONTENT: [&str; 1] = ["w:txbxContent"];
const WP_INLINE: [&str; 1] = ["wp:inline"];
const WP_ANCHOR: [&str; 1] = ["wp:anchor"];

/// The paragraphs of a part with what the TypeScript keeps beside them in
/// module-level weak maps: `hfRowAnchorIds` (by paragraph) and
/// `hfRunImageIds` (by the list itself).
#[derive(Debug, Default)]
pub struct HfParaList {
    pub paras: Vec<HfParagraph>,
    /// `hfRowAnchorIds.get(paras[i])`: the `wp:docPr` ids of the anchored
    /// drawings in the layout-table row `paras[i]` stands for
    pub row_anchor_ids: Vec<Option<Vec<String>>>,
    /// `hfRunImageIds.get(paras)`: `wp:docPr` ids of inline pictures kept on a
    /// text paragraph's runs (not in the part image list)
    pub run_image_ids: HashSet<String>,
}

/// `Number(attrsOf(node)[key])`
fn number(node: Option<&XNode>, key: &str) -> f64 {
    node.and_then(|node| node.attr(key))
        .map_or(f64::NAN, to_number)
}

/// `x || 0`
fn or_zero(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 0.0 } else { x }
}

/// `hfParaStyleLayers`: the direct format of a strip paragraph and the display
/// of its paragraph style: Word's built-in Header/Footer styles carry the
/// center/right tab stops (and sometimes w:jc); direct pPr wins per property.
pub fn hf_para_style_layers<'a>(
    p_node: &XNode,
    styles: &'a JsMap<StyleInfo>,
) -> Result<(Option<ParaFormat>, Option<&'a StyleDisplay>), Thrown> {
    let p_pr = p_node.find_child("w:pPr");
    let direct = match p_pr {
        Some(p_pr) => extract_para_format(p_pr, None, None)?,
        None => None,
    };
    let style_id = p_pr
        .and_then(|p_pr| p_pr.find_child("w:pStyle"))
        .and_then(|style| style.attr("w:val"))
        .filter(|id| !id.is_empty());
    let display = style_id
        .and_then(|id| styles.get(id))
        .and_then(|style| style.display.as_ref());
    Ok((direct, display))
}

/// `hfEmptyMarkFont`: the face sizing an empty strip paragraph's line. Word
/// lays the mark with its East Asian font only under w:hint="eastAsia" AND an
/// East Asian w:lang; otherwise the Latin font. Decided only for hinted marks
/// and marks whose two slots name one face; other marks keep the strip's
/// document line factor.
pub fn hf_empty_mark_font(
    p_pr: Option<&XNode>,
    ctx: &BuildContext<'_>,
) -> Result<Option<String>, Thrown> {
    let r_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:rPr"));
    let hinted = r_pr
        .and_then(|r_pr| r_pr.find_child("w:rFonts"))
        .and_then(|fonts| fonts.attr("w:hint"))
        == Some("eastAsia");
    let eff = resolve_paragraph_props(p_pr, &ctx.resolver, ResolveParaOptions::default())?;
    let mark = &eff.mark;
    let fonts = &mark.fonts;
    // an empty theme slot that only reaches the generic stand-in has no real face
    let ea = if fonts.ea_slot_empty == Some(true)
        && fonts.east_asia.as_deref() == Some(EMPTY_EA_THEME_FONT)
    {
        None
    } else {
        fonts.east_asia.clone()
    };
    // without the hint the mark's own (direct or style) Latin face sizes the
    // line: four Times New Roman sz 16 marks push the body 4 x 9.2, not 4 x 9.76
    // (Word probe 2026-10-29); a docDefaults face is the strip's inherited face
    if !hinted {
        let declared = matches!(
            mark.source.get("ascii"),
            Some(PropSource::Direct | PropSource::ParaStyle | PropSource::TableStyle)
        );
        return Ok(if declared {
            fonts.ascii.clone()
        } else {
            ea.filter(|ea| !ea.is_empty() && fonts.ascii.as_deref() == Some(ea.as_str()))
        });
    }
    let ea_lang = is_east_asian_lang_tag(mark.east_asia_lang.as_deref(), true);
    Ok(if ea_lang { ea } else { None }.or_else(|| fonts.ascii.clone()))
}

/// `hfStyledParaFormat`: the display format of a strip paragraph: the direct
/// pPr with the geometry the resolver settles through the style chain,
/// docDefaults and compat (spacing, line, alignment, indents, borders) laid
/// over it.
pub fn hf_styled_para_format(p_node: &XNode, ctx: &BuildContext<'_>) -> Result<ParaFormat, Thrown> {
    let p_pr = p_node.find_child("w:pPr");
    let direct = match p_pr {
        Some(p_pr) => extract_para_format(p_pr, None, None)?,
        None => None,
    };
    let rctx: &ResolveCtx = &ctx.resolver;
    let eff = resolve_paragraph_props(p_pr, rctx, ResolveParaOptions::default())?;
    let mut format = without_resolved_geometry(direct);
    let resolved: ParaFormat = bridge(&effective_para_format(
        &eff,
        &rctx.compat,
        &EffectiveParaFormatOptions {
            line_sources: Some(hf_line_sources(&eff, false)),
        },
    ))?;
    format.assign(&resolved);
    Ok(format)
}

/// `HfRawCell`
#[derive(Debug, Clone)]
pub struct HfRawCell<'a> {
    pub tc: &'a XNode,
    pub tc_pr: Option<&'a XNode>,
    pub grid_start: f64,
    pub span: f64,
    pub width_twips: f64,
    pub width_is_pct: bool,
    pub v_merge_continue: bool,
    pub borders: Option<CellBorders>,
}

/// `NO_BORDER`
fn no_border() -> CellBorder {
    CellBorder {
        style: "none".to_owned(),
        sz_eighths: None,
        color: None,
    }
}

/// The cell of `row` covering grid column `col`.
fn covering<'r, 'a>(row: &'r [HfRawCell<'a>], col: f64) -> Option<&'r HfRawCell<'a>> {
    row.iter()
        .find(|x| x.grid_start <= col && col < x.grid_start + x.span)
}

/// `hfCellBorders`: the resolved per-side borders of a layout-table cell
/// (`w:tcBorders` over `w:tblBorders`): each line shared between two cells is
/// assigned to one of them (the earlier cell's right / bottom) so it never
/// paints twice, and a vertically merged cell keeps no line through its
/// interior.
pub fn hf_cell_borders(
    rows: &[Vec<HfRawCell<'_>>],
    r: usize,
    c: usize,
    tbl: Option<&TableBorders>,
) -> Option<CellBorders> {
    let cell = &rows[r][c];
    let own = cell.borders.as_ref();
    let own_side =
        |pick: fn(&CellBorders) -> &Option<CellBorder>| own.and_then(|own| pick(own).clone());
    let below = rows.get(r + 1);
    let mut bottom: Option<CellBorder>;
    match below {
        None => {
            bottom = own_side(|b| &b.bottom)
                .or_else(|| tbl.and_then(|tbl| tbl.bottom.as_ref().cloned()));
        }
        Some(below) => {
            bottom = None;
            let mut col = cell.grid_start;
            while col < cell.grid_start + cell.span {
                let under = covering(below, col);
                let line = if under.is_some_and(|under| under.v_merge_continue) {
                    Some(no_border())
                } else {
                    own_side(|b| &b.bottom)
                        .or_else(|| {
                            under
                                .and_then(|under| under.borders.as_ref())
                                .and_then(|borders| borders.top.as_ref().cloned())
                        })
                        .or_else(|| tbl.and_then(|tbl| tbl.inside_h.clone()))
                };
                if hf_line(line.clone()).is_some() {
                    bottom = line;
                    break;
                }
                if bottom.is_none() {
                    bottom = line;
                }
                col += 1.0;
            }
        }
    }
    let next = rows[r].get(c + 1);
    let right = match next {
        Some(next) => own_side(|b| &b.right)
            .or_else(|| {
                next.borders
                    .as_ref()
                    .and_then(|borders| borders.left.as_ref().cloned())
            })
            .or_else(|| tbl.and_then(|tbl| tbl.inside_v.clone())),
        None => own_side(|b| &b.right).or_else(|| tbl.and_then(|tbl| tbl.right.as_ref().cloned())),
    };
    // inner lines belong to the cell above / to the left (own top and left feed
    // their resolution there); only the table's first row and column paint them
    let top = if r == 0 {
        own_side(|b| &b.top).or_else(|| tbl.and_then(|tbl| tbl.top.as_ref().cloned()))
    } else {
        None
    };
    let left = if c == 0 {
        own_side(|b| &b.left).or_else(|| tbl.and_then(|tbl| tbl.left.as_ref().cloned()))
    } else {
        None
    };
    let mut out = CellBorders::default();
    if let Some(top) = hf_line(top) {
        out.top.set(top);
    }
    if let Some(left) = hf_line(left) {
        out.left.set(left);
    }
    if let Some(bottom) = hf_line(bottom) {
        out.bottom.set(bottom);
    }
    if let Some(right) = hf_line(right) {
        out.right.set(right);
    }
    (!out.has_no_key()).then_some(out)
}

/// `hfVSpanOf`: the rows a `w:vMerge` restart cell at `col` spans: itself plus
/// the continuation cells below.
pub fn hf_v_span_of(rows: &[Vec<HfRawCell<'_>>], r: usize, col: f64) -> f64 {
    let mut span = 1.0;
    for row in rows.iter().skip(r + 1) {
        let under = covering(row, col);
        if !under.is_some_and(|under| under.v_merge_continue) {
            break;
        }
        span += 1.0;
    }
    span
}

/// What `hfCellContent` returns.
#[derive(Debug, Default)]
pub struct HfCellContent {
    pub paras: Vec<Vec<Run>>,
    pub para_props: Option<Vec<Option<HfCellParaProps>>>,
    pub align: Option<ParaAlign>,
    pub fill: Option<String>,
    pub locked: bool,
}

/// `ParaAlign` of a resolved paragraph's alignment keyword.
fn para_align_of(align: &str) -> ParaAlign {
    match align {
        "left" => ParaAlign::Left,
        "center" => ParaAlign::Center,
        "right" => ParaAlign::Right,
        "distribute" => ParaAlign::Distribute,
        _ => ParaAlign::Justify,
    }
}

/// `x` kept where it is truthy.
fn truthy_num(x: JsNum) -> Option<JsNum> {
    (x.0 != 0.0 && !x.0.is_nan()).then_some(x)
}

/// `hfCellContent`: cell content in document order, nested layout tables
/// flattened into the cell (their cell text, alignment and shading would
/// otherwise be dropped).
pub fn hf_cell_content(
    tc: &XNode,
    ctx: &BuildContext<'_>,
    table_style_id: Option<&str>,
) -> Result<HfCellContent, Thrown> {
    let mut paras: Vec<Vec<Run>> = Vec::new();
    let mut para_props: Vec<Option<HfCellParaProps>> = Vec::new();
    let mut align: Option<ParaAlign> = None;
    let shd = tc
        .find_child("w:tcPr")
        .and_then(|tc_pr| tc_pr.find_child("w:shd"))
        .and_then(|shd| shd.attr("w:fill"));
    let mut fill: Option<String> = match shd {
        Some(shd) if !shd.is_empty() && shd != "auto" => Some(strip_hash(shd).to_owned()),
        _ => None,
    };
    let mut saw_nested = false;
    let rctx = cell_resolver_of(ctx, table_style_id, &[]);
    for node in children_through_sdt(tc, &["w:p", "w:tbl"]) {
        if node.name() == Some("w:tbl") {
            saw_nested = true;
            let nested_style = node
                .find_child("w:tblPr")
                .and_then(|tbl_pr| tbl_pr.find_child("w:tblStyle"))
                .and_then(|style| style.attr("w:val"));
            for tr in children_through_sdt(node, &["w:tr"]) {
                for inner in children_through_sdt(tr, &["w:tc"]) {
                    let c = hf_cell_content(inner, ctx, nested_style)?;
                    let count = c.paras.len();
                    paras.extend(c.paras);
                    match c.para_props {
                        Some(props) => para_props.extend(props),
                        None => para_props.extend((0..count).map(|_| None)),
                    }
                    if align.is_none() {
                        align = c.align;
                    }
                    if fill.is_none() {
                        fill = c.fill;
                    }
                }
            }
            continue;
        }
        // anchored pictures stay in the part-level image list (page positioning);
        // a run carrying both text and an anchored drawing keeps its text
        let runs = extract_runs_plain(node, ctx, true)?
            .into_iter()
            .filter_map(|run| {
                let Some(image) = run.image.as_ref() else {
                    return Some(run);
                };
                if !js_regex!(r"<wp:anchor[\s>]").test(&image.xml)
                    && !js_regex!(r"position:\s*absolute").test(&image.xml)
                {
                    return Some(run);
                }
                let mut rest = run;
                rest.image.delete();
                (rest.text.as_deref() != Some("")).then_some(rest)
            })
            .collect();
        paras.push(runs);
        let p_pr = node.find_child("w:pPr");
        let eff = resolve_paragraph_props(p_pr, &rctx, ResolveParaOptions::default())?;
        let sp = effective_spacing_twips(&eff, &rctx.compat);
        // the paragraph / table style's run size: runs without their own w:sz
        // inherit it, docDefaults stay with the strip base size
        let style_size = match eff.mark.source.get("sizeHalfPoints") {
            Some(PropSource::ParaStyle | PropSource::TableStyle) => Some(eff.mark.size_half_points),
            _ => None,
        };
        let mut props = HfCellParaProps::default();
        let mut any = false;
        if let Some(align) = eff.align.filter(|align| !align.is_empty()) {
            props.align = Some(para_align_of(align));
            any = true;
        }
        if let Some(left) = truthy_num(eff.indent.left) {
            props.indent_left = Some(left);
            any = true;
        }
        if let Some(first) = truthy_num(eff.indent.first_line) {
            props.indent_first_line = Some(first);
            any = true;
        }
        if let Some(before) = truthy_num(sp.before) {
            props.space_before = Some(before);
            any = true;
        }
        if let Some(after) = truthy_num(sp.after) {
            props.space_after = Some(after);
            any = true;
        }
        if !eff.tab_stops.is_empty() {
            props.tab_stops = Some(bridge(&eff.tab_stops)?);
            any = true;
        }
        let line_included = eff
            .source
            .get("line")
            .is_some_and(|line| hf_line_sources(&eff, true).contains(line));
        let line = effective_line_format(if line_included {
            eff.spacing.line.as_ref()
        } else {
            None
        });
        if let Some(rule) = line.line_rule.as_deref() {
            // the TypeScript stores whatever the attribute holds; the model type refuses what is none of the three
            props.line_rule = Some(
                serde_json::from_value::<ParaFormatLineRule>(serde_json::Value::from(rule))
                    .map_err(|error| error.to_string())?,
            );
            any = true;
        }
        if let Some(raw) = line.line_raw_twips {
            props.line_raw_twips = Some(raw);
            any = true;
        }
        if let Some(spacing) = line.line_spacing {
            props.line_spacing = Some(spacing);
            any = true;
        }
        if let Some(style_id) = eff.style_id.as_ref().filter(|id| !id.is_empty()) {
            props.style_id = Some(style_id.clone());
            any = true;
        }
        if let Some(size) = style_size.and_then(truthy_num) {
            props.size_half_points = Some(size);
            any = true;
        }
        if !eff.word_wrap {
            props.word_wrap = Some(false);
            any = true;
        }
        let props_align = props.align;
        para_props.push(any.then_some(props));
        if align.is_none() {
            align = props_align;
        }
    }
    // the mandatory empty paragraph after a nested table is layout noise
    if saw_nested {
        while paras.last().is_some_and(Vec::is_empty) {
            paras.pop();
            para_props.pop();
        }
    }
    Ok(HfCellContent {
        paras,
        para_props: para_props.iter().any(Option::is_some).then_some(para_props),
        align,
        fill: fill.filter(|fill| !fill.is_empty()),
        locked: saw_nested,
    })
}

/// The paragraphs of a table, each with the `hfRowAnchorIds` of its row.
pub type HfRows = Vec<(HfParagraph, Option<Vec<String>>)>;

/// `hfTableRowParagraphs`: a header/footer top-level table as one paragraph
/// per row, cells as columns. With the `hfRowAnchorIds` of each paragraph
/// beside it (`None` where the row anchors no drawing).
pub fn hf_table_rows(
    tbl: &XNode,
    ctx: &BuildContext<'_>,
    compatibility_mode: f64,
    tbl_index: Option<f64>,
) -> Result<HfRows, Thrown> {
    let tbl_pr = tbl.find_child("w:tblPr");
    let style_id = tbl_pr
        .and_then(|tbl_pr| tbl_pr.find_child("w:tblStyle"))
        .and_then(|style| style.attr("w:val"));
    let style_table = style_id
        .filter(|id| !id.is_empty())
        .and_then(|id| ctx.resolver.styles.get(id))
        .and_then(|style| style.table_display.as_ref());
    let tbl_borders: Option<TableBorders> =
        match merged_border_lines_of(tbl_pr, "w:tblBorders", true)
            .or_else(|| style_table.and_then(|ts| (*ts.borders).clone()))
        {
            Some(borders) => Some(bridge(&borders)?),
            None => None,
        };
    let tbl_mar: Option<CellMargins> =
        match cell_margins_of(tbl_pr.and_then(|tbl_pr| tbl_pr.find_child("w:tblCellMar")))
            .or_else(|| style_table.and_then(|ts| (*ts.cell_mar_twips).clone()))
        {
            Some(mar) => Some(bridge(&mar)?),
            None => None,
        };
    let tbl_w = tbl_pr.and_then(|tbl_pr| tbl_pr.find_child("w:tblW"));
    let tbl_w_type = tbl_w.and_then(|w| w.attr("w:type"));
    let tbl_ind = tbl_pr.and_then(|tbl_pr| tbl_pr.find_child("w:tblInd"));
    let ind_type = tbl_ind.and_then(|ind| ind.attr("w:type"));
    let ind_raw = if ind_type.is_none_or(|kind| kind.is_empty() || kind == "dxa") {
        number(tbl_ind, "w:w")
    } else {
        0.0
    };
    // legacy layout (Word 2010 and before) measures tblInd to the cell text, so
    // the left border sits one cell margin further out; Word 2013+ to the border
    let mar_left = tbl_mar
        .as_ref()
        .and_then(|mar| *mar.left)
        .map_or(108.0, |left| left.0);
    let indent_twips = (if ind_raw.is_finite() { ind_raw } else { 0.0 })
        - (if compatibility_mode >= 15.0 {
            0.0
        } else {
            mar_left
        });
    let bidi_visual = tbl_pr.is_some_and(|tbl_pr| bool_prop(tbl_pr, "w:bidiVisual"));
    let tbl_jc = tbl_pr
        .and_then(|tbl_pr| tbl_pr.find_child("w:jc"))
        .and_then(|jc| jc.attr("w:val"));
    let align = match tbl_jc {
        Some("center") => Some(HfTableRowAlign::Center),
        Some("right" | "end") => Some(HfTableRowAlign::Right),
        _ => None,
    };
    let float = hf_table_float_of(tbl_pr);
    let mut row_base = HfTableRow {
        indent_twips: Some(JsNum(indent_twips)),
        tab_overflow: Some(if compatibility_mode >= 15.0 {
            HfTableRowTabOverflow::Wrap
        } else {
            HfTableRowTabOverflow::Clip
        }),
        bidi_visual: bidi_visual.then_some(true),
        align,
        float,
        additive_spacing: ctx.resolver.compat.additive_para_spacing.then_some(true),
        ..HfTableRow::default()
    };
    let grid_cols: Vec<f64> = match tbl.find_child("w:tblGrid") {
        Some(grid) => grid
            .find_children("w:gridCol")
            .map(|g| or_zero(number(Some(g), "w:w")))
            .collect(),
        None => Vec::new(),
    };
    let grid_width: f64 = grid_cols.iter().fold(0.0, |sum, w| sum + w);
    let tbl_width = if grid_width != 0.0 && !grid_width.is_nan() {
        grid_width
    } else if tbl_w_type == Some("dxa") || tbl_w_type.is_none_or(str::is_empty) {
        or_zero(number(tbl_w, "w:w"))
    } else {
        0.0
    };
    if tbl_width > 0.0 {
        row_base.width_twips = Some(JsNum(tbl_width));
    }
    let trs = children_through_sdt(tbl, &["w:tr"]);
    let mut raw_rows: Vec<Vec<HfRawCell<'_>>> = Vec::with_capacity(trs.len());
    for tr in &trs {
        let mut col = 0.0;
        let mut row = Vec::new();
        for tc in children_through_sdt(tr, &["w:tc"]) {
            let tc_pr = tc.find_child("w:tcPr");
            let span = {
                let n = number(tc_pr.and_then(|p| p.find_child("w:gridSpan")), "w:val");
                if n == 0.0 || n.is_nan() { 1.0 } else { n }
            };
            let tc_w = tc_pr.and_then(|p| p.find_child("w:tcW"));
            let v = number(tc_w, "w:w");
            let width_is_pct = tc_w.and_then(|a| a.attr("w:type")) == Some("pct");
            let declared = if !width_is_pct && v.is_finite() && v > 0.0 {
                v
            } else {
                0.0
            };
            let from_grid: f64 = grid_cols[slice_range(grid_cols.len(), col, col + span)]
                .iter()
                .fold(0.0, |s, w| s + w);
            let v_merge = tc_pr.and_then(|p| p.find_child("w:vMerge"));
            let borders = match merged_border_lines_of(tc_pr, "w:tcBorders", false) {
                Some(borders) => Some(bridge::<_, CellBorders>(&borders)?),
                None => None,
            };
            row.push(HfRawCell {
                tc,
                tc_pr,
                grid_start: col,
                span,
                width_twips: if declared != 0.0 { declared } else { from_grid },
                width_is_pct,
                v_merge_continue: v_merge.is_some_and(|m| m.attr("w:val") != Some("restart")),
                borders,
            });
            col += span;
        }
        raw_rows.push(row);
    }
    // w:left / w:right borders are physical sides: resolve neighbours in visual order
    let visual_rows: Vec<Vec<HfRawCell<'_>>> = if bidi_visual {
        raw_rows
            .iter()
            .map(|row| row.iter().rev().cloned().collect())
            .collect()
    } else {
        raw_rows.clone()
    };
    // declared widths hold as absolute columns unless the table (or a cell) is
    // sized as a percentage of the strip; then the cells share the row
    let absolute = tbl_w_type != Some("pct")
        && raw_rows
            .iter()
            .all(|row| row.iter().all(|c| !c.width_is_pct && c.width_twips > 0.0));
    let mut out: Vec<(HfParagraph, Option<Vec<String>>)> = Vec::new();
    for (r, raw) in raw_rows.iter().enumerate() {
        let tr_pr = trs[r].find_child("w:trPr");
        let tr_height = tr_pr.and_then(|p| p.find_child("w:trHeight"));
        let height_twips = number(tr_height, "w:val");
        let mut row = row_base.clone();
        if height_twips > 0.0 {
            row.height_twips = Some(JsNum(height_twips));
            row.height_rule = Some(
                if tr_height.and_then(|h| h.attr("w:hRule")) == Some("exact") {
                    HfTableRowHeightRule::Exact
                } else {
                    HfTableRowHeightRule::AtLeast
                },
            );
        }
        if let Some(tbl) = tbl_index {
            row.source = Some(HfTableRowSource {
                tbl: JsNum(tbl),
                tr: JsNum(r as f64),
            });
        }
        let total: f64 = raw.iter().fold(0.0, |s, c| s + c.width_twips);
        let mut cells: Vec<HfTableCell> = Vec::with_capacity(raw.len());
        for (c, rc) in raw.iter().enumerate() {
            let content = hf_cell_content(rc.tc, ctx, style_id)?;
            let v_align = match rc
                .tc_pr
                .and_then(|p| p.find_child("w:vAlign"))
                .and_then(|a| a.attr("w:val"))
            {
                Some("center") => Some(HfTableCellVAlign::Center),
                Some("bottom") => Some(HfTableCellVAlign::Bottom),
                _ => None,
            };
            let tc_mar: Option<CellMargins> =
                match cell_margins_of(rc.tc_pr.and_then(|p| p.find_child("w:tcMar"))) {
                    Some(mar) => Some(bridge(&mar)?),
                    None => None,
                };
            let mar = if tbl_mar.is_some() || tc_mar.is_some() {
                let mut merged = tbl_mar.clone().unwrap_or_default();
                if let Some(tc_mar) = &tc_mar {
                    merged.assign(tc_mar);
                }
                Some(merged)
            } else {
                None
            };
            let borders = hf_cell_borders(
                &visual_rows,
                r,
                if bidi_visual { raw.len() - 1 - c } else { c },
                tbl_borders.as_ref(),
            );
            let v_span = if rc.v_merge_continue {
                1.0
            } else {
                hf_v_span_of(&raw_rows, r, rc.grid_start)
            };
            cells.push(HfTableCell {
                paras: content.paras,
                para_props: content.para_props,
                align: content.align,
                fill: content.fill,
                locked: content.locked.then_some(True),
                v_span: (v_span > 1.0).then_some(JsNum(v_span)),
                v_merge_continue: rc.v_merge_continue.then_some(True),
                width_pct: (total > 0.0 && rc.width_twips > 0.0)
                    .then(|| JsNum((rc.width_twips / total) * 100.0)),
                width_twips: absolute.then_some(JsNum(rc.width_twips)),
                borders,
                v_align,
                mar_twips: mar,
                ..HfTableCell::default()
            });
        }
        // bordered / shaded-only rows still render (banner bars with no text)
        let renders = cells.iter().any(|c| {
            c.paras.iter().any(|rs| {
                rs.iter()
                    .any(|r| r.text.as_deref() != Some("") || r.image.is_some())
            }) || c.fill.as_deref().is_some_and(|fill| !fill.is_empty())
                || c.borders.is_some()
        });
        if renders {
            let mut row_para = HfParagraph::default();
            row_para.runs.set(Vec::new());
            row_para.cells.set(cells);
            row_para.row.set(row);
            let ids = anchor_doc_pr_ids(trs[r]);
            out.push((row_para, (!ids.is_empty()).then_some(ids)));
        }
    }
    Ok(out)
}

/// `hfTableRowParagraphs(tbl, ctx, compatibilityMode)`: the paragraphs of a
/// layout table, without the table index and the anchor ids (what
/// `txbxTableParas` asks for).
pub fn hf_table_row_paragraphs(
    tbl: &XNode,
    ctx: &BuildContext<'_>,
    compatibility_mode: f64,
) -> Result<Vec<HfParagraph>, Thrown> {
    Ok(hf_table_rows(tbl, ctx, compatibility_mode, None)?
        .into_iter()
        .map(|(para, _)| para)
        .collect())
}

/// The paragraph's `w:tab` / `w:ptab` alignments in overall tab order.
fn walk_tabs(
    node: &XNode,
    aligns: &mut Vec<Option<HfParagraphPtabAlignsItem>>,
    saw_ptab: &mut bool,
) {
    for c in node.children() {
        match c.name() {
            Some("w:pPr") => {}
            Some("w:tab") => aligns.push(None),
            Some("w:ptab") => {
                *saw_ptab = true;
                aligns.push(Some(match c.attr("w:alignment") {
                    Some("center") => HfParagraphPtabAlignsItem::Center,
                    Some("right") => HfParagraphPtabAlignsItem::Right,
                    _ => HfParagraphPtabAlignsItem::Left,
                }));
            }
            _ => walk_tabs(c, aligns, saw_ptab),
        }
    }
}

/// `hfParagraphs`: the rich paragraphs of a header/footer part (watermark and
/// drawing paragraphs skipped). `resolver` is the document's, which holds the
/// styles and theme the TypeScript passes beside it; `table_media` is
/// `hfTableMedia`'s result.
pub fn hf_paragraphs(
    part_xml: &str,
    zip: &Package,
    resolver: &Rc<ResolveCtx>,
    table_media: Option<&JsMap<SharedStr>>,
    compatibility_mode: f64,
    media: &MediaEnv<'_>,
) -> Result<HfParaList, Thrown> {
    let Ok(parsed) = parse_ordered(part_xml, XML_PARSER_MAX_NESTED_TAGS) else {
        return Ok(HfParaList::default());
    };
    let Some(root) = parsed
        .iter()
        .find(|node| matches!(node.name(), Some("w:hdr" | "w:ftr")))
    else {
        return Ok(HfParaList::default());
    };
    let root_name = if root.name() == Some("w:hdr") {
        HfRootName::Hdr
    } else {
        HfRootName::Ftr
    };
    // header parts have their own rels; hyperlink targets are not resolved here
    let mut ctx = BuildContext::bare(zip, Rc::clone(resolver), media);
    ctx.xml_space_preserve = root.attr("xml:space") == Some("preserve");
    // a wrapper is carried when the root a rewrite of the part is written
    // under declares its prefixes
    ctx.part_namespaces = Some(
        hf_wrap_namespaces(
            Some(part_xml),
            hf_kept_root(root_name, part_xml)
                .map_err(|limit| limit.to_string())?
                .is_some(),
        )
        .map_err(|limit| limit.to_string())?,
    );
    let ctx_media = table_media.map(|table_media| {
        let mut with_media = ctx.clone();
        with_media.media_by_rid = Some(RefCell::new(clone_map(table_media)));
        with_media
    });
    let mut list = HfParaList::default();
    // text-anchored floating tables (w:tblpPr) hang off the paragraph that
    // follows them in markup; Word draws that paragraph first, so their rows are
    // deferred past it. Page/margin-anchored ones sit at their own coordinates
    // and the strip flow continues below them in markup order.
    let mut deferred: HfRows = Vec::new();
    fn push(list: &mut HfParaList, para: HfParagraph, ids: Option<Vec<String>>) {
        list.paras.push(para);
        list.row_anchor_ids.push(ids);
    }
    fn flush(list: &mut HfParaList, deferred: &mut HfRows) {
        for (para, ids) in deferred.drain(..) {
            push(list, para, ids);
        }
    }
    let mut tbl_index = 0.0;
    // paragraphs may sit inside (nested) w:sdt content controls (OpenXML SDK footers)
    for node in children_through_sdt(root, &["w:tbl", "w:p"]) {
        if node.name() == Some("w:tbl") {
            // layout tables (logo | title | date rows): one display paragraph per row
            let rows = hf_table_rows(
                node,
                ctx_media.as_ref().unwrap_or(&ctx),
                compatibility_mode,
                Some(tbl_index),
            )?;
            tbl_index += 1.0;
            let float = hf_table_float_of(node.find_child("w:tblPr"));
            let in_text = float.is_some_and(|float| {
                float
                    .vert_anchor
                    .is_none_or(|anchor| anchor == crate::model::HfTableFloatVertAnchor::Text)
            });
            if in_text {
                deferred.extend(rows);
            } else {
                for (para, ids) in rows {
                    push(&mut list, para, ids);
                }
            }
            continue;
        }
        if node.name() != Some("w:p") {
            continue;
        }
        let p_node = node;
        let mut runs = extract_runs_plain(p_node, &ctx, false)?;
        // Word lays an inline picture out at its run position (after a tab, on the
        // text line); only a picture sharing its paragraph with text takes this
        // path, picture-only paragraphs stay on the part-level image list
        if !runs.is_empty()
            && let Some(ctx_media) = &ctx_media
            && has_deep_child_outside(p_node, &WP_INLINE, Some(&TXBX_CONTENT))
        {
            runs = extract_runs(p_node, ctx_media, &[], &[], true, None, None, None)?
                .into_iter()
                .filter_map(|run| {
                    let Some(image) = run.image.as_ref() else {
                        return Some(run);
                    };
                    if js_regex!(r"<wp:inline[\s>]").test(&image.xml) {
                        if let Some(id) = js_regex!(r#"<wp:docPr\s[^>]*\bid="([^"]+)""#)
                            .exec(&image.xml)
                            .and_then(|found| found.get(1))
                        {
                            list.run_image_ids.insert(id.to_owned());
                        }
                        return Some(run);
                    }
                    let mut rest = run;
                    rest.image.delete();
                    (rest.text.as_deref() != Some("")).then_some(rest)
                })
                .collect();
        }
        let mut boxed: Vec<HfParagraph> = if has_deep_child(p_node, &["w:txbxContent"]) {
            textbox_paragraphs(p_node, &ctx)?
        } else {
            Vec::new()
        };
        // runs carrying only w:rPr are a blank line like a bare w:p (genoffice#2116)
        if runs.is_empty()
            && !hf_only_empty_runs(p_node)
            && (p_node.find_child("w:r").is_some() || p_node.find_child("w:pict").is_some())
        {
            // Government-style footers keep their text (e.g. the "— PAGE —" page number)
            // inside a VML textbox shape; surface those inner paragraphs instead of dropping
            // the content. Watermark / decorative drawing paragraphs still skip.
            // A paragraph carrying only floating boxes, anchored drawings (logo
            // groups) or a floating VML shape (picture watermark) keeps its own line
            // in Word (often collapsed by w:spacing w:line): the body starts below
            // that line. Word probe 2026-09-23: a Normal-style header paragraph whose
            // only content is a picture watermark reserves a full 22.56pt line.
            if (!boxed.is_empty()
                || has_deep_child(p_node, &WP_ANCHOR)
                || has_floating_vml_picture(p_node))
                && boxed.iter().all(|p| p.r#box.is_some())
                && !has_deep_child_outside(p_node, &WP_INLINE, Some(&TXBX_CONTENT))
            {
                let anchor_para = JsNum(list.paras.len() as f64);
                for p in &mut boxed {
                    if let Some(r#box) = p.r#box.as_mut() {
                        r#box.anchor_para.set(anchor_para);
                    }
                }
                let mut line = HfParagraph {
                    para_format: hf_styled_para_format(p_node, &ctx)?,
                    ..HfParagraph::default()
                };
                line.runs.set(Vec::new());
                line.line_only.set(true);
                push(&mut list, line, None);
            }
            for p in boxed {
                push(&mut list, p, None);
            }
            flush(&mut list, &mut deferred);
            continue;
        }
        // floating boxes sharing the paragraph with text: surfaced after it and
        // anchored to it (paragraph-relative offsets measure from that paragraph)
        let mut anchored_boxes: Vec<HfParagraph> =
            boxed.into_iter().filter(|p| p.r#box.is_some()).collect();
        let anchor_para = JsNum(list.paras.len() as f64);
        for p in &mut anchored_boxes {
            if let Some(r#box) = p.r#box.as_mut() {
                r#box.anchor_para.set(anchor_para);
            }
        }
        let p_pr = p_node.find_child("w:pPr");
        let (direct, display) = hf_para_style_layers(p_node, &resolver.styles)?;
        // absolute position tabs (w:ptab): carry their own alignment, ignore stops.
        // Indexed by overall tab order: regular w:tab occupies a slot as undefined,
        // so mixed tab/ptab paragraphs keep their alignments on the right segment.
        let mut ptab_aligns: Vec<Option<HfParagraphPtabAlignsItem>> = Vec::new();
        let mut saw_ptab = false;
        walk_tabs(p_node, &mut ptab_aligns, &mut saw_ptab);
        // w:framePr frames (page-number "1" floated at the right margin): the frame
        // shares the following paragraph's flow line instead of stacking above it
        let frame_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:framePr"));
        let x_align = frame_pr
            .filter(|frame| frame.attr("w:dropCap").is_none_or(str::is_empty))
            .and_then(|frame| frame.attr("w:xAlign"));
        let frame_x_align = match x_align {
            Some("right" | "outside") => Some(HfParagraphFrameXAlign::Right),
            Some("center") => Some(HfParagraphFrameXAlign::Center),
            Some("left" | "inside") => Some(HfParagraphFrameXAlign::Left),
            _ => None,
        };
        let style_tabs = match display.and_then(|display| display.tab_stops.as_ref()) {
            Some(stops) => Some(bridge::<_, Vec<crate::model::TabStop>>(stops)?),
            None => None,
        };
        let merged_stops = merge_tab_stops(
            style_tabs.as_deref(),
            direct
                .as_ref()
                .and_then(|direct| direct.tab_stops.as_deref()),
        );
        // a blank strip line is sized by its paragraph mark, else by the style's run
        // size; space-only runs never size a line, so such a paragraph is blank too
        // (Word probe 2026-10-29: a sz 32 space under a sz 16 mark is a sz 16 line)
        let style_id = p_pr
            .and_then(|p_pr| p_pr.find_child("w:pStyle"))
            .and_then(|style| style.attr("w:val"))
            .filter(|id| !id.is_empty());
        let blank = runs.iter().all(|r| {
            r.image.is_none()
                && js_regex!(r"^[ \u00a0\u3000]*$").test(r.text.as_deref().unwrap_or(""))
        });
        let empty_sz = if blank {
            empty_para_size_half_points(p_node, p_pr, false, None).or_else(|| {
                style_id
                    .and_then(|id| resolver.styles.get(id))
                    .and_then(|style| style.display.as_ref())
                    .and_then(|display| display.size_half_points.map(|size| size.0))
            })
        } else {
            None
        };
        let empty_font = if blank {
            hf_empty_mark_font(p_pr, &ctx)?
        } else {
            None
        };
        let mut para = HfParagraph {
            para_format: hf_styled_para_format(p_node, &ctx)?,
            ..HfParagraph::default()
        };
        if let Some(stops) = merged_stops {
            para.para_format.tab_stops.set(stops);
        }
        if saw_ptab {
            para.ptab_aligns.set(ptab_aligns);
        }
        if let Some(align) = frame_x_align {
            para.frame_x_align.set(align);
        }
        if let Some(size) = empty_sz.filter(|size| *size != 0.0 && !size.is_nan()) {
            para.para_format.empty_run_size_half_points.set(JsNum(size));
        }
        if let Some(font) = empty_font.filter(|font| !font.is_empty()) {
            para.empty_run_font.set(font);
        }
        para.runs.set(runs);
        push(&mut list, para, None);
        for p in anchored_boxes {
            push(&mut list, p, None);
        }
        flush(&mut list, &mut deferred);
    }
    flush(&mut list, &mut deferred);
    // empty paragraphs stay, even when the whole part is blank: Word lays them
    // out and their height pushes the body when it exceeds the margin
    Ok(list)
}

/// A copy of a map of strings.
fn clone_map(map: &JsMap<SharedStr>) -> JsMap<SharedStr> {
    map.iter()
        .map(|(key, value)| (key.to_owned(), value.clone()))
        .collect()
}
