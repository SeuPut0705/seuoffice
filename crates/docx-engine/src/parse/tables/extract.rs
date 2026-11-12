//! The display model of a `w:tbl`: its grid, widths, borders, rows and cells
//! (`extractTable`, `extractTableModel`, `extractCell` and what they lean on).

use std::collections::HashSet;
use std::rc::Rc;

use jscompat::{JsNum, js_regex, math_max, math_round, parse_float, to_number, try_js_regex};
use ooxml_xml::{XNode, parse_ordered, serialize};

use super::{
    DEEP_XML_PARSER_MAX_NESTED_TAGS, children_through_sdt, flattened_table_model, is_uniform_grid,
    reconcile_grid_columns, row_grid_edges, row_revision_of, table_lacks_tc_w, tbl_look_flags,
    usable_table_widths,
};
use crate::drawing_geometry::anchor::top_level_drawings;
use crate::generate::split_xml_children;
use crate::inline_opaque::InlineRawSource;
use crate::model::{
    CellBorders, CellMargins, ParaAlign, PropChangeInfo, SectionSettings, TableAutoFitMode,
    TableBorders, TableCell, TableCellCellRevision, TableCellCellRevisionKind, TableCellHMerge,
    TableCellTextDirection, TableCellVAlign, TableCellVMerge, TableLook, TableModel,
    TableModelAlign, TableModelFloatPos, TableModelFloatPosHorzAnchor,
    TableModelFloatPosVertAnchor, TableModelFloatPosXSpec, TableModelFloatPosYSpec,
    TableModelFloatSide, TableModelRowHeightRulesItem, TableModelRowRevisionsItem, TableParagraph,
    TableParagraphList, TableParagraphListKind, True,
};
use crate::package::Thrown;
use crate::parse::drawings::textbox::{ExtractTextboxOpts, extract_textboxes};
use crate::parse::drawings::vml::has_deep_child;
use crate::parse::text::{
    BuildContext, ParaResolve, bridge, cell_resolver_of, char_units_of, eff_to_model, extract_runs,
    fold_effective_format, list_kind_of, list_ref_of, mark_size_of, math_source_xml_of,
    para_cs_size, prop_change_info, resolved_para_format, shadow_para_format, style_bidi_of,
};
use crate::props::{
    XML_PARSER_MAX_NESTED_TAGS, cell_margins_of, empty_para_mark_font, empty_para_size_half_points,
    has_layout_run_content, layout_run_content, merged_border_lines_of, row_band_size_of,
    shd_display_fill, space_only_runs, table_look_of,
};
use crate::resolve::{ResolveParaOptions, TableCond, resolve_paragraph_props};
use crate::styles::TableCondFormat;
use crate::xml_text::{bool_prop, color_from};

/// `MAX_TABLE_NEST_DEPTH`: real documents rarely nest past 3-4 levels; below
/// the cap the subtree flattens so stress files cannot blank the page.
const MAX_TABLE_NEST_DEPTH: u32 = 8;
/// `DEFAULT_TABLE_CELL_MAR`
const DEFAULT_TABLE_CELL_MAR: f64 = 108.0;

/// `attrsOf(findChild(node ?? {}, name) ?? {})[key]`
fn child_attr<'a>(node: Option<&'a XNode>, name: &str, key: &str) -> Option<&'a str> {
    node?.find_child(name)?.attr(key)
}

/// `Number(attrsOf(findChild(node ?? {}, name) ?? {})[key])`
fn child_number(node: Option<&XNode>, name: &str, key: &str) -> f64 {
    child_attr(node, name, key).map_or(f64::NAN, to_number)
}

/// `!type || type === 'dxa'`
fn is_dxa(kind: Option<&str>) -> bool {
    kind.is_none_or(|kind| kind.is_empty() || kind == "dxa")
}

/// `!(x > 0)`: true for NaN too.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn not_positive(x: f64) -> bool {
    !(x > 0.0)
}

/// `x || 0`
fn or_zero(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 0.0 } else { x }
}

/// `tcwColumnWidths`: per-column widths reconstructed from cell `w:tcW` (dxa)
/// across all rows: the widest un-spanned cell per grid slot wins (Word
/// widens a column to fit later rows, never narrows it). `None` unless every
/// column got a value: partial data would skew the ratio worse than the
/// tblGrid fallback.
pub fn tcw_column_widths(tbl: &XNode, pct_table_twips: f64) -> Option<Vec<f64>> {
    // the array elements that were written: a key that is no array index is
    // never read back
    let mut cols: std::collections::HashMap<u64, f64> = std::collections::HashMap::new();
    let mut col_count = 0.0_f64;
    for tr in children_through_sdt(tbl, &["w:tr"]) {
        let edges = row_grid_edges(tr);
        let mut idx = edges.before.0;
        for tc in children_through_sdt(tr, &["w:tc"]) {
            let tc_pr = tc.find_child("w:tcPr");
            let span = math_max(1.0, {
                let n = child_number(tc_pr, "w:gridSpan", "w:val");
                if n == 0.0 || n.is_nan() { 1.0 } else { n }
            });
            // duplicated w:tcW: Word keeps the last occurrence (generators leave stale first values)
            let tc_w = tc_pr.and_then(|tc_pr| tc_pr.find_children("w:tcW").last());
            let kind = tc_w.and_then(|tc_w| tc_w.attr("w:type"));
            let raw = tc_w
                .and_then(|tc_w| tc_w.attr("w:w"))
                .map_or(f64::NAN, to_number);
            // pct cell widths (1/50 of a percent) of a pct table resolve against its width
            let w = if is_dxa(kind) {
                or_zero(raw)
            } else if kind == Some("pct") && pct_table_twips > 0.0 {
                math_round((or_zero(raw) / 5000.0) * pct_table_twips)
            } else {
                0.0
            };
            if span == 1.0 && w > 0.0 && idx >= 0.0 && idx.fract() == 0.0 && idx < 4_294_967_295.0 {
                let slot = cols.entry(idx as u64).or_insert(0.0);
                *slot = math_max(*slot, w);
            }
            idx += span;
        }
        col_count = math_max(col_count, idx + edges.after.0);
    }
    if col_count == 0.0 {
        return None;
    }
    let mut i = 0.0_f64;
    while i < col_count {
        if !cols.get(&(i as u64)).is_some_and(|w| *w > 0.0) {
            return None;
        }
        i += 1.0;
    }
    let len = col_count.trunc() as u64;
    Some((0..len).map(|i| cols[&i]).collect())
}

/// `RowPropExceptions`: `w:tblPrEx`, table properties one row overrides (the
/// raw bytes still round-trip).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RowPropExceptions {
    pub borders: Option<TableBorders>,
    pub cell_mar_twips: Option<CellMargins>,
    pub fill: Option<String>,
}

/// `tablePropExceptionsOf`
pub fn table_prop_exceptions_of(
    tbl_pr_ex: Option<&XNode>,
) -> Result<Option<RowPropExceptions>, Thrown> {
    let Some(tbl_pr_ex) = tbl_pr_ex else {
        return Ok(None);
    };
    let mut out = RowPropExceptions::default();
    if let Some(borders) = merged_border_lines_of(Some(tbl_pr_ex), "w:tblBorders", true) {
        out.borders = Some(bridge(&borders)?);
    }
    if let Some(mar) = cell_margins_of(tbl_pr_ex.find_child("w:tblCellMar")) {
        out.cell_mar_twips = Some(bridge(&mar)?);
    }
    out.fill =
        shd_display_fill(tbl_pr_ex.find_child("w:shd"), None).filter(|fill| !fill.is_empty());
    Ok(
        (out.borders.is_some() || out.cell_mar_twips.is_some() || out.fill.is_some())
            .then_some(out),
    )
}

/// `applyRowPropExceptions`: Word draws a row's `w:tblPrEx`
/// borders/margins/shading in place of the table-level ones: resolved onto
/// the row's cells (explicit tcPr stays on top, the table style below). Outer
/// sides map to the table edge, inner ones to insideH/insideV.
pub fn apply_row_prop_exceptions(
    rows: &mut [Vec<TableCell>],
    exceptions: &[Option<RowPropExceptions>],
) {
    let row_count = rows.len();
    for (r, row) in rows.iter_mut().enumerate() {
        let Some(ex) = exceptions.get(r).and_then(Option::as_ref) else {
            continue;
        };
        let cell_count = row.len();
        for (c, cell) in row.iter_mut().enumerate() {
            if let Some(b) = &ex.borders {
                let mut sides = CellBorders::default();
                let top = if r == 0 {
                    b.top.as_ref().cloned()
                } else {
                    b.inside_h.clone()
                };
                let bottom = if r == row_count - 1 {
                    b.bottom.as_ref().cloned()
                } else {
                    b.inside_h.clone()
                };
                let left = if c == 0 {
                    b.left.as_ref().cloned()
                } else {
                    b.inside_v.clone()
                };
                let right = if c == cell_count - 1 {
                    b.right.as_ref().cloned()
                } else {
                    b.inside_v.clone()
                };
                if let Some(top) = top {
                    sides.top.set(top);
                }
                if let Some(bottom) = bottom {
                    sides.bottom.set(bottom);
                }
                if let Some(left) = left {
                    sides.left.set(left);
                }
                if let Some(right) = right {
                    sides.right.set(right);
                }
                if !sides.has_no_key() {
                    // `{ ...sides, ...(cell.borders ?? {}) }`
                    if let Some(own) = cell.borders.as_ref() {
                        sides.assign(own);
                    }
                    cell.borders.set(sides);
                }
            }
            if let Some(mar) = &ex.cell_mar_twips {
                let mut merged = mar.clone();
                if let Some(own) = cell.cell_mar_twips.as_ref() {
                    merged.assign(own);
                }
                cell.cell_mar_twips.set(merged);
            }
            if let Some(fill) = ex.fill.as_ref().filter(|fill| !fill.is_empty())
                && cell.fill.is_none()
            {
                cell.fill.set(fill.clone());
            }
        }
    }
}

/// One condition of a table style with its borders and margins as model values.
struct Cond<'a> {
    format: &'a TableCondFormat,
    borders: Option<CellBorders>,
    margins: Option<CellMargins>,
}

fn cond_of(format: Option<&TableCondFormat>) -> Result<Option<Cond<'_>>, Thrown> {
    let Some(format) = format else {
        return Ok(None);
    };
    let borders = match format.borders.as_ref() {
        Some(borders) => Some(bridge(borders)?),
        None => None,
    };
    let margins = match format.cell_mar_twips.as_ref() {
        Some(margins) => Some(bridge(margins)?),
        None => None,
    };
    Ok(Some(Cond {
        format,
        borders,
        margins,
    }))
}

/// `applyTableStyleDisplay`: layers the referenced table style's fills /
/// first-row formatting under the cells' explicit properties, honoring the
/// `w:tblLook` flags. Display-only: untouched tables still save
/// byte-identically.
pub fn apply_table_style_display(
    rows: &mut [Vec<TableCell>],
    tbl_pr: Option<&XNode>,
    ctx: &BuildContext<'_>,
) -> Result<(), Thrown> {
    let Some(tbl_pr) = tbl_pr else {
        return Ok(());
    };
    let style_id = tbl_pr
        .find_child("w:tblStyle")
        .and_then(|style| style.attr("w:val"))
        .filter(|id| !id.is_empty());
    let Some(ts) = style_id
        .and_then(|id| ctx.resolver.styles.get(id))
        .and_then(|style| style.table_display.as_ref())
    else {
        return Ok(());
    };
    let look = tbl_look_flags(Some(tbl_pr));
    let band_size = row_band_size_of(Some(tbl_pr))
        .or((*ts.row_band_size).map(|size| size.0))
        .unwrap_or(1.0);

    let first_row = cond_of(ts.first_row.as_ref())?;
    let last_row = cond_of(ts.last_row.as_ref())?;
    let first_col = cond_of(ts.first_col.as_ref())?;
    let last_col = cond_of(ts.last_col.as_ref())?;
    let band1_horz = cond_of(ts.band1_horz.as_ref())?;
    let band2_horz = cond_of(ts.band2_horz.as_ref())?;

    let span_of = |cell: &TableCell| cell.col_span.map_or(1.0, |span| span.0);
    let mut total_cols = f64::NEG_INFINITY;
    for row in rows.iter() {
        let sum = row.iter().fold(0.0, |sum, cell| sum + span_of(cell));
        total_cols = math_max(total_cols, sum);
    }
    let row_count = rows.len();
    for (r, row) in rows.iter_mut().enumerate() {
        let is_first = look.first_row_on && r == 0;
        let is_last = look.last_row_on && r == row_count - 1;
        let band_row = if look.first_row_on {
            r as f64 - 1.0
        } else {
            r as f64
        };
        let band1 =
            look.h_band_on && band_row >= 0.0 && (band_row / band_size).floor() % 2.0 == 0.0;
        let band2 = look.h_band_on && band_row >= 0.0 && !band1;
        let band_fill: Option<&String> = if band1 {
            ts.band1_fill.as_ref()
        } else if band2 {
            ts.band2_fill.as_ref()
        } else {
            None
        };
        let mut col = 0.0;
        for cell in row.iter_mut() {
            let span = span_of(cell);
            // Word's conditional-format precedence: rows beat columns, all beat bands/whole-table
            let conds: [Option<&Cond<'_>>; 5] = [
                if is_first { first_row.as_ref() } else { None },
                if is_last { last_row.as_ref() } else { None },
                if look.first_col_on && col == 0.0 {
                    first_col.as_ref()
                } else {
                    None
                },
                if look.last_col_on && col + span == total_cols {
                    last_col.as_ref()
                } else {
                    None
                },
                if band1 {
                    band1_horz.as_ref()
                } else if band2 {
                    band2_horz.as_ref()
                } else {
                    None
                },
            ];
            col += span;
            if cell.fill.is_none() {
                let fill = conds
                    .iter()
                    .flatten()
                    .find_map(|cond| cond.format.fill.as_ref().filter(|fill| !fill.is_empty()))
                    .or(band_fill)
                    .or(ts.fill.as_ref());
                cell.fill.assign(fill.cloned());
            }
            let bold = conds
                .iter()
                .flatten()
                .any(|cond| *cond.format.bold == Some(true))
                || ts
                    .whole_table
                    .as_ref()
                    .is_some_and(|whole| *whole.bold == Some(true));
            if bold {
                cell.style_bold.set(True);
                if cell.bold.is_none() {
                    cell.bold.set(true);
                }
            }
            let color = conds
                .iter()
                .flatten()
                .find_map(|cond| cond.format.color.as_ref().filter(|color| !color.is_empty()))
                .or(ts
                    .whole_table
                    .as_ref()
                    .and_then(|whole| whole.color.as_ref()));
            if let Some(color) = color.filter(|color| !color.is_empty()) {
                cell.style_color.set(color.clone());
                if cell.color.as_deref().is_none_or(str::is_empty) {
                    cell.color.set(color.clone());
                }
            }
            // per side, the first matching condition wins; explicit tcBorders/tcMar stay on top
            let mut cond_borders = CellBorders::default();
            for cond in conds.iter().rev().flatten() {
                if let Some(borders) = &cond.borders {
                    cond_borders.assign(borders);
                }
            }
            if !cond_borders.has_no_key() {
                if let Some(own) = cell.borders.as_ref() {
                    cond_borders.assign(own);
                }
                cell.borders.set(cond_borders);
            }
            let mut cond_mar = CellMargins::default();
            for cond in conds.iter().rev().flatten() {
                if let Some(margins) = &cond.margins {
                    cond_mar.assign(margins);
                }
            }
            if !cond_mar.has_no_key() {
                if let Some(own) = cell.cell_mar_twips.as_ref() {
                    cond_mar.assign(own);
                }
                cell.cell_mar_twips.set(cond_mar);
            }
        }
    }
    Ok(())
}

/// `attachRawTablePr`: attaches each cell's rawTcPr and each row's rawTrPr
/// from the original table XML (byte fidelity: surgically patched on
/// regeneration so unmodeled tcMar/textDirection/tblHeader etc. are not
/// lost). Uses depth-aware `splitXmlChildren` so nested tables do not
/// misalign; gives up when row/column counts disagree with the parse result
/// (conservative: never attach to the wrong cell).
pub fn attach_raw_table_pr(
    xml: &str,
    model: &mut TableModel,
    raw_tr_prs: &mut [Option<String>],
) -> Result<(), Thrown> {
    let Some(open) = js_regex!(r"<w:tbl[\s>]").exec(xml) else {
        return Ok(());
    };
    // `xml.indexOf('>', open.index) + 1`
    let Some(inner_start) = xml[open.start()..]
        .find('>')
        .map(|at| open.start() + at + 1)
    else {
        return Ok(());
    };
    let Some(inner_end) = xml.rfind("</w:tbl>") else {
        return Ok(());
    };
    let inner = xml.get(inner_start..inner_end).unwrap_or("");
    let tbl_kids = split_xml_children(inner).map_err(|limit| limit.to_string())?;
    let find = |kids: &[(String, String)], name: &str| -> Option<String> {
        kids.iter()
            .find(|(kid, _)| kid == name)
            .map(|(_, xml)| xml.clone())
    };
    if let Some(tbl_pr) = find(&tbl_kids, "w:tblPr")
        && let Some(change) = prop_change_info(&tbl_pr, "w:tblPrChange")
    {
        model.tbl_pr_change = Some(Some(change));
    }
    if let Some(tbl_grid) = find(&tbl_kids, "w:tblGrid")
        && let Some(change) = prop_change_info(&tbl_grid, "w:tblGridChange")
    {
        model.tbl_grid_change = Some(Some(change));
    }
    let trs: Vec<&String> = tbl_kids
        .iter()
        .filter(|(name, _)| name == "w:tr")
        .map(|(_, xml)| xml)
        .collect();
    if trs.len() != model.rows.len() {
        return Ok(());
    }
    let row_count = model.rows.len();
    let mut row_pr_changes: Vec<Option<PropChangeInfo>> = vec![None; row_count];
    let mut raw_tbl_pr_exs: Vec<Option<String>> = vec![None; row_count];
    let mut row_tbl_pr_ex_changes: Vec<Option<PropChangeInfo>> = vec![None; row_count];
    for (ri, tr) in trs.iter().enumerate() {
        let tr_open_end = tr.find('>').map_or(0, |at| at + 1);
        let tr_inner = js_slice_from(tr, tr_open_end, tr.rfind("</w:tr>"));
        let kids = split_xml_children(tr_inner).map_err(|limit| limit.to_string())?;
        if let Some(tr_pr) = find(&kids, "w:trPr") {
            row_pr_changes[ri] = prop_change_info(&tr_pr, "w:trPrChange");
            raw_tr_prs[ri] = Some(tr_pr);
        }
        if let Some(tbl_pr_ex) = find(&kids, "w:tblPrEx") {
            row_tbl_pr_ex_changes[ri] = prop_change_info(&tbl_pr_ex, "w:tblPrExChange");
            raw_tbl_pr_exs[ri] = Some(tbl_pr_ex);
        }
        let tcs: Vec<&String> = kids
            .iter()
            .filter(|(name, _)| name == "w:tc")
            .map(|(_, xml)| xml)
            .collect();
        // gridGap placeholders have no w:tc in the source: align against real cells only
        let mut targets: Vec<&mut TableCell> = model.rows[ri]
            .iter_mut()
            .filter(|cell| cell.grid_gap.as_ref() != Some(&true))
            .collect();
        if tcs.len() != targets.len() {
            // `return` of the forEach callback: the next row
            continue;
        }
        for (ci, tc) in tcs.iter().enumerate() {
            let tc_open_end = tc.find('>').map_or(0, |at| at + 1);
            let tc_inner = js_slice_from(tc, tc_open_end, tc.rfind("</w:tc>"));
            let tc_kids = split_xml_children(tc_inner).map_err(|limit| limit.to_string())?;
            let Some(tc_pr) = find(&tc_kids, "w:tcPr") else {
                continue;
            };
            let target = &mut targets[ci];
            target.raw_tc_pr.set(tc_pr.clone());
            if let Some(change) = prop_change_info(&tc_pr, "w:tcPrChange") {
                target.tc_pr_change.set(Some(change));
            }
            if let Some(merge) = prop_change_info(&tc_pr, "w:cellMerge") {
                target.cell_merge.set(Some(merge));
            }
        }
    }
    if row_pr_changes.iter().any(Option::is_some) {
        model.row_pr_changes = Some(row_pr_changes);
    }
    if raw_tbl_pr_exs.iter().any(Option::is_some) {
        model.raw_tbl_pr_exs = Some(raw_tbl_pr_exs);
    }
    if row_tbl_pr_ex_changes.iter().any(Option::is_some) {
        model.row_tbl_pr_ex_changes = Some(row_tbl_pr_ex_changes);
    }
    Ok(())
}

/// `text.slice(from, to)` where `to` may be `lastIndexOf`'s -1 (no match):
/// `slice(from, -1)` stops one unit short of the end.
fn js_slice_from(text: &str, from: usize, to: Option<usize>) -> &str {
    let end = match to {
        Some(to) => to,
        None => text.char_indices().next_back().map_or(0, |(at, _)| at),
    };
    text.get(from..end).unwrap_or("")
}

/// `extractTable`: display-only table structure. Nested tables render as
/// read-only sub-tables inside their cell; the exact original bytes are what
/// get saved, so lossiness here only affects on-screen rendering.
///
/// `doc_offset` is the table's document.xml offset: cell paragraphs resolve
/// their character-unit indents under that section's document grid.
///
/// The TypeScript wraps the whole read in a `try`, so a table it cannot
/// build (hostile depth inside a cell paragraph) degrades to `None`, not a
/// failed document: so does every refusal here.
pub fn extract_table(
    xml: &str,
    ctx: &BuildContext<'_>,
    doc_offset: Option<usize>,
) -> Result<Option<TableModel>, Thrown> {
    let Ok(parsed) = parse_ordered(xml, DEEP_XML_PARSER_MAX_NESTED_TAGS) else {
        return Ok(None);
    };
    let parsed = Rc::new(parsed);
    let Some(tbl_at) = parsed.iter().position(|node| node.name() == Some("w:tbl")) else {
        return Ok(None);
    };
    let outer = ctx.table_raw.replace(Some(Rc::new(InlineRawSource::owned(
        xml.to_owned(),
        Rc::clone(&parsed),
        tbl_at,
    ))));
    let tbl = &parsed[tbl_at];
    let model = extract_table_model(tbl, ctx, 1, doc_offset);
    ctx.table_raw.replace(outer);
    // the whole read sits in the TypeScript's `try`: whatever it throws, the table is `undefined`
    let read = || -> Result<Option<TableModel>, Thrown> {
        let Some(mut model) = model? else {
            return Ok(None);
        };
        let mut raw_tr_prs: Vec<Option<String>> = vec![None; model.rows.len()];
        attach_raw_table_pr(xml, &mut model, &mut raw_tr_prs)?;
        if raw_tr_prs.iter().any(Option::is_some) {
            model.raw_tr_prs = Some(raw_tr_prs);
        }
        Ok(Some(model))
    };
    Ok(read().unwrap_or(None))
}

/// `Number(attrsOf(node)[key])` of an optional attribute
fn attr_number(value: Option<&str>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `extractTableModel`: one `w:tbl` node to the display model (shared by
/// top-level tables and tables nested in cells).
pub fn extract_table_model(
    tbl: &XNode,
    ctx: &BuildContext<'_>,
    depth: u32,
    doc_offset: Option<usize>,
) -> Result<Option<TableModel>, Thrown> {
    let grid = tbl.find_child("w:tblGrid");
    let mut col_widths_pct: Option<Vec<f64>> = None;
    let mut col_widths_twips: Option<Vec<f64>> = None;
    let mut grid_widths_raw: Option<Vec<f64>> = None;
    if let Some(grid) = grid {
        let widths: Vec<f64> = grid
            .find_children("w:gridCol")
            .map(|col| or_zero(attr_number(col.attr("w:w"))))
            .collect();
        let total: f64 = widths.iter().fold(0.0, |a, b| a + b);
        if total > 0.0 {
            grid_widths_raw = Some(widths.clone());
            col_widths_pct = Some(widths.iter().map(|w| (w / total) * 100.0).collect());
            if widths.iter().all(|w| *w > 0.0) {
                col_widths_twips = Some(widths);
            }
        }
    }
    let tbl_pr_node = tbl.find_child("w:tblPr");
    let fixed_layout = child_attr(tbl_pr_node, "w:tblLayout", "w:type") == Some("fixed");
    let tbl_w_node = tbl_pr_node.and_then(|tbl_pr| tbl_pr.find_child("w:tblW"));
    let tbl_w_type = tbl_w_node.and_then(|node| node.attr("w:type"));
    let tbl_w_w = tbl_w_node.and_then(|node| node.attr("w:w"));
    let tbl_ind = tbl_pr_node.and_then(|tbl_pr| tbl_pr.find_child("w:tblInd"));
    let tbl_ind_twips = if is_dxa(tbl_ind.and_then(|ind| ind.attr("w:type"))) {
        attr_number(tbl_ind.and_then(|ind| ind.attr("w:w")))
    } else {
        f64::NAN
    };
    let cell_mar =
        cell_margins_of(tbl_pr_node.and_then(|tbl_pr| tbl_pr.find_child("w:tblCellMar")));
    // Borders/margins from the table style (styles.xml, basedOn chain included): fallback
    // when the document level declares none
    let style_id_early = child_attr(tbl_pr_node, "w:tblStyle", "w:val");
    let style_table = style_id_early
        .filter(|id| !id.is_empty())
        .and_then(|id| ctx.resolver.styles.get(id))
        .and_then(|style| style.table_display.as_ref());
    let eff_cell_mar: Option<crate::props::CellMargins> = cell_mar
        .clone()
        .or_else(|| style_table.and_then(|ts| (*ts.cell_mar_twips).clone()));
    let legacy_hang = if ctx.compatibility_mode.map_or(0.0, |mode| mode.0) < 15.0 {
        eff_cell_mar
            .as_ref()
            .and_then(|mar| mar.left.map(|v| v.0))
            .unwrap_or(DEFAULT_TABLE_CELL_MAR)
            + eff_cell_mar
                .as_ref()
                .and_then(|mar| mar.right.map(|v| v.0))
                .unwrap_or(DEFAULT_TABLE_CELL_MAR)
    } else {
        0.0
    };
    let spacing_of = |node: Option<&XNode>| -> Option<f64> {
        let a = node.and_then(|node| node.find_child("w:tblCellSpacing"));
        let w = if is_dxa(a.and_then(|a| a.attr("w:type"))) {
            attr_number(a.and_then(|a| a.attr("w:w")))
        } else {
            f64::NAN
        };
        (w > 0.0).then_some(w)
    };
    let first_tr = children_through_sdt(tbl, &["w:tr"]).first().copied();
    let tbl_spacing = spacing_of(tbl_pr_node)
        .or_else(|| first_tr.and_then(|tr| spacing_of(tr.find_child("w:trPr"))));
    let js = |values: &[f64]| -> Vec<JsNum> { values.iter().copied().map(JsNum).collect() };
    let uniform_grid = {
        let widths = col_widths_twips.as_deref().map(js);
        is_uniform_grid(widths.as_deref())
    };
    let mut width_pct: Option<f64> = None;
    if tbl_w_type == Some("pct") {
        let raw = tbl_w_w.unwrap_or("");
        // The pct unit is 1/50 of a percentage point; some generators write a literal "NN%"
        let pct = if raw.ends_with('%') {
            parse_float(raw)
        } else {
            to_number(raw) / 50.0
        };
        if pct.is_finite() && pct > 0.0 && pct <= 100.0 {
            width_pct = Some(pct);
        }
    }
    let sect: Option<SectionSettings> = match (doc_offset, ctx.section_at.as_ref()) {
        (Some(offset), Some(section_at)) => Some(section_at.at(offset)),
        _ => None,
    };
    let grid_total_raw: f64 = col_widths_twips
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .fold(0.0, |a, b| a + b);
    // a pct table's saved grid is Word's own layout only when it sums to the pct
    // width (3 %); any other non-uniform grid is a generator artefact and yields
    // to tcW (probe 2026-10-29)
    let pct_widths: Vec<f64> = match (width_pct, sect.as_ref()) {
        (Some(pct), Some(sect)) => usable_table_widths(sect, tbl_ind_twips, 0.0)
            .iter()
            .map(|usable| (usable.0 * pct) / 100.0)
            .collect(),
        _ => Vec::new(),
    };
    let grid_matches_pct = width_pct.is_some()
        && grid_total_raw > 0.0
        && !table_lacks_tc_w(tbl)
        && (pct_widths.is_empty()
            || pct_widths
                .iter()
                .any(|w| (grid_total_raw - w).abs() <= w * 0.03));
    // Cell-level w:tcW is Word's actual layout input for auto tables; generators often
    // leave a stale evenly-split tblGrid behind. When the two disagree, tcW wins.
    let tcw_widths = tcw_column_widths(
        tbl,
        if width_pct.is_some() {
            pct_widths.first().copied().unwrap_or(grid_total_raw)
        } else {
            0.0
        },
    );
    let mut tcw_wins = false;
    if let Some(tcw_widths) = tcw_widths {
        let tcw_total: f64 = tcw_widths.iter().fold(0.0, |a, b| a + b);
        let tcw_pct: Vec<f64> = tcw_widths.iter().map(|w| (w / tcw_total) * 100.0).collect();
        let len = tcw_widths.len() as f64;
        let grid_total: f64 = col_widths_twips
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .fold(0.0, |a, b| a + b);
        // an autofit grid with unequal columns is Word's finished layout (Word
        // draws it on open even when tcW disagree); only an evenly split
        // placeholder grid yields to tcW
        let tbl_w_auto = tbl_w_type == Some("auto")
            || (is_dxa(tbl_w_type) && not_positive(attr_number(tbl_w_w)));
        let grid_is_shrunk_layout = match sect.as_ref() {
            Some(sect) => usable_table_widths(sect, tbl_ind_twips, legacy_hang)
                .iter()
                .any(|usable| {
                    tcw_total > usable.0 + len && (grid_total - usable.0).abs() <= usable.0 * 0.03
                }),
            None => false,
        };
        // with w:tblCellSpacing the grid also holds the gaps that w:tcW leaves out
        // (Word saves 2s per column plus s on the outer two, other generators 3s
        // each); Word draws that wider grid, so it is not a stale one
        let grid_excess = grid_total - tcw_total;
        let spacing_room = match tbl_spacing {
            Some(spacing) if spacing != 0.0 => 3.0 * spacing * len,
            _ => 0.0,
        };
        let disagree = match &col_widths_pct {
            None => true,
            Some(pct) => {
                pct.len() != tcw_pct.len()
                    || (uniform_grid
                        && pct
                            .iter()
                            .enumerate()
                            .any(|(i, w)| (w - tcw_pct[i]).abs() > 2.0))
                    || ((fixed_layout || (tbl_w_auto && !grid_is_shrunk_layout))
                        && (grid_excess < -len || grid_excess > len + spacing_room))
                    || (width_pct.is_some() && !grid_matches_pct)
            }
        };
        if disagree {
            col_widths_pct = Some(tcw_pct);
            col_widths_twips = Some(tcw_widths);
            tcw_wins = true;
        }
    }
    // Placeholder grids (generators emit 100-twip gridCols without computing a
    // layout) collapse the table to a strip. Word lays autofit tables out from
    // tblW/tcW, so a grid summing below the declared dxa width stretches to it.
    if !fixed_layout && let Some(widths) = col_widths_twips.as_mut() {
        let tbl_w_dxa = if is_dxa(tbl_w_type) {
            attr_number(tbl_w_w)
        } else {
            f64::NAN
        };
        let grid_total: f64 = widths.iter().fold(0.0, |a, b| a + b);
        if tbl_w_dxa > 0.0 && grid_total > 0.0 && grid_total < tbl_w_dxa - widths.len() as f64 {
            let scale = tbl_w_dxa / grid_total;
            for w in widths.iter_mut() {
                *w = math_round(*w * scale);
            }
        }
    }
    let tbl_borders = merged_border_lines_of(tbl_pr_node, "w:tblBorders", true);
    let tbl_jc = child_attr(tbl_pr_node, "w:jc", "w:val");
    let tbl_align = match tbl_jc {
        Some("center") => Some(TableModelAlign::Center),
        Some("right" | "end") => Some(TableModelAlign::Right),
        _ => None,
    };
    let tblp_pr = tbl_pr_node.and_then(|tbl_pr| tbl_pr.find_child("w:tblpPr"));
    let mut float_side: Option<TableModelFloatSide> = None;
    let mut float_pos: Option<TableModelFloatPos> = None;
    if let Some(tblp_pr) = tblp_pr.filter(|node| node.attrs().is_some()) {
        let attr = |key: &str| tblp_pr.attr(key);
        let x_spec = attr("w:tblpXSpec");
        // no alignment keyword: an absolute X past mid-body (~9360 twips of usable
        // width on Letter/A4) means the table hugs the right side
        float_side = Some(
            if matches!(x_spec, Some("right" | "outside"))
                || (x_spec.is_none_or(str::is_empty) && attr_number(attr("w:tblpX")) > 4680.0)
            {
                TableModelFloatSide::Right
            } else {
                TableModelFloatSide::Left
            },
        );
        let x = attr_number(attr("w:tblpX"));
        let y = attr_number(attr("w:tblpY"));
        let mut distance_twips = CellMargins::default();
        for (side, key) in [
            ("top", "w:topFromText"),
            ("right", "w:rightFromText"),
            ("bottom", "w:bottomFromText"),
            ("left", "w:leftFromText"),
        ] {
            let value = attr_number(attr(key));
            if value.is_finite() && value >= 0.0 {
                let slot = match side {
                    "top" => &mut distance_twips.top,
                    "right" => &mut distance_twips.right,
                    "bottom" => &mut distance_twips.bottom,
                    _ => &mut distance_twips.left,
                };
                slot.set(JsNum(value));
            }
        }
        let horz_anchor = match attr("w:horzAnchor") {
            Some("page") => Some(TableModelFloatPosHorzAnchor::Page),
            Some("margin") => Some(TableModelFloatPosHorzAnchor::Margin),
            Some("text") => Some(TableModelFloatPosHorzAnchor::Text),
            _ => None,
        };
        let y_spec = match attr("w:tblpYSpec") {
            Some("top") => Some(TableModelFloatPosYSpec::Top),
            Some("center") => Some(TableModelFloatPosYSpec::Center),
            Some("bottom") => Some(TableModelFloatPosYSpec::Bottom),
            Some("inside") => Some(TableModelFloatPosYSpec::Inside),
            Some("outside") => Some(TableModelFloatPosYSpec::Outside),
            _ => None,
        };
        let x_spec_ok = match x_spec {
            Some("left") => Some(TableModelFloatPosXSpec::Left),
            Some("center") => Some(TableModelFloatPosXSpec::Center),
            Some("right") => Some(TableModelFloatPosXSpec::Right),
            Some("inside") => Some(TableModelFloatPosXSpec::Inside),
            Some("outside") => Some(TableModelFloatPosXSpec::Outside),
            _ => None,
        };
        // a keyword Y with no vertAnchor aligns to the margin box in Word (cover
        // page gallery tables sit at the bottom margin); a numeric Y stays text-relative
        let vert_anchor = match attr("w:vertAnchor").or(y_spec.as_ref().map(|_| "margin")) {
            Some("page") => Some(TableModelFloatPosVertAnchor::Page),
            Some("margin") => Some(TableModelFloatPosVertAnchor::Margin),
            Some("text") => Some(TableModelFloatPosVertAnchor::Text),
            _ => None,
        };
        float_pos = Some(TableModelFloatPos {
            x_twips: JsNum(if x.is_finite() { x } else { 0.0 }),
            y_twips: JsNum(if y.is_finite() { y } else { 0.0 }),
            horz_anchor,
            vert_anchor,
            x_spec: x_spec_ok,
            y_spec,
            distance_twips: (!distance_twips.has_no_key()).then_some(distance_twips),
        });
    }

    let mut cell_spacing = tbl_spacing;
    let tbl_fill = shd_display_fill(
        tbl_pr_node.and_then(|tbl_pr| tbl_pr.find_child("w:shd")),
        None,
    );
    let table_style_id = child_attr(tbl_pr_node, "w:tblStyle", "w:val");

    let mut rows: Vec<Vec<TableCell>> = Vec::new();
    // per-cell w:tcW (dxa twips), aligned with rows: grid-repair input
    let mut row_tcws: Vec<Vec<Option<f64>>> = Vec::new();
    let mut row_edges = Vec::new();
    let mut row_exceptions: Vec<Option<RowPropExceptions>> = Vec::new();
    let mut row_heights_twips: Vec<Option<f64>> = Vec::new();
    let mut row_height_rules: Vec<Option<TableModelRowHeightRulesItem>> = Vec::new();
    let mut repeat_header_rows: Vec<bool> = Vec::new();
    let mut row_cant_split: Vec<bool> = Vec::new();
    let mut row_revisions: Vec<Option<TableModelRowRevisionsItem>> = Vec::new();
    let trs = children_through_sdt(tbl, &["w:tr"]);
    let span_of = |tc: &XNode| -> f64 {
        or_one(child_number(tc.find_child("w:tcPr"), "w:gridSpan", "w:val"))
    };
    let tr_cells: Vec<Vec<&XNode>> = trs
        .iter()
        .map(|tr| children_through_sdt(tr, &["w:tc"]))
        .collect();
    let row_count = tr_cells.iter().filter(|tcs| !tcs.is_empty()).count() as f64;
    let total_cols = tr_cells
        .iter()
        .map(|tcs| tcs.iter().fold(0.0, |n, tc| n + span_of(tc)))
        .fold(0.0, math_max);
    let look = tbl_look_flags(tbl_pr_node);
    let h_merge_continues = |tc: &XNode| -> bool {
        let h = tc
            .find_child("w:tcPr")
            .and_then(|tc_pr| tc_pr.find_child("w:hMerge"));
        h.is_some_and(|h| h.attr("w:val") != Some("restart"))
    };
    for (i, tr) in trs.iter().enumerate() {
        let mut cells: Vec<TableCell> = Vec::new();
        let mut tcws: Vec<Option<f64>> = Vec::new();
        let tcs = &tr_cells[i];
        let mut col = 0.0;
        for (j, tc) in tcs.iter().enumerate() {
            let span = span_of(tc);
            // the conditions see the visual span: legacy w:hMerge continue cells fold into
            // this one below, so a restart reaching the last column still gets lastCol
            let mut vis_span = span;
            let mut k = j + 1;
            while k < tcs.len() && h_merge_continues(tcs[k]) {
                vis_span += span_of(tcs[k]);
                k += 1;
            }
            let conds = super::cell_conds(
                &look,
                rows.len() as f64,
                row_count,
                col,
                vis_span,
                total_cols,
            );
            col += span;
            let cell = extract_cell(tc, ctx, depth, doc_offset, table_style_id, &conds)?;
            let tc_w = tc
                .find_child("w:tcPr")
                .and_then(|tc_pr| tc_pr.find_children("w:tcW").last());
            let raw_w = if is_dxa(tc_w.and_then(|a| a.attr("w:type"))) {
                attr_number(tc_w.and_then(|a| a.attr("w:w")))
            } else {
                f64::NAN
            };
            let tcw = (raw_w > 0.0).then_some(raw_w);
            // Legacy horizontal merge: continue cells fold into the cell to their left (same effect
            // as gridSpan)
            if *cell.h_merge == Some(TableCellHMerge::Continue)
                && let Some(prev) = cells.last_mut()
            {
                let merged =
                    prev.col_span.map_or(1.0, |s| s.0) + cell.col_span.map_or(1.0, |s| s.0);
                prev.col_span.set(JsNum(merged));
                let prev_w = tcws.last().copied().flatten();
                if let Some(last) = tcws.last_mut() {
                    *last = match (prev_w, tcw) {
                        (Some(prev_w), Some(tcw)) => Some(prev_w + tcw),
                        _ => None,
                    };
                }
                continue;
            }
            cells.push(cell);
            tcws.push(tcw);
        }
        if !cells.is_empty() {
            rows.push(cells);
            row_tcws.push(tcws);
            row_edges.push(row_grid_edges(tr));
            row_exceptions.push(table_prop_exceptions_of(tr.find_child("w:tblPrEx"))?);
            let tr_pr = tr.find_child("w:trPr");
            cell_spacing = cell_spacing.or_else(|| spacing_of(tr_pr));
            let tr_h = tr_pr.and_then(|tr_pr| tr_pr.find_child("w:trHeight"));
            let h = attr_number(tr_h.and_then(|h| h.attr("w:val")));
            let has_h = h.is_finite() && h > 0.0;
            // Word clamps trHeight to 31680 twips / 22in (MS-OI29500 2.1.51); some generators leak EMU-scale values here
            row_heights_twips.push(has_h.then(|| h.min(31680.0)));
            row_height_rules.push(has_h.then(|| {
                if tr_h.and_then(|h| h.attr("w:hRule")) == Some("exact") {
                    TableModelRowHeightRulesItem::Exact
                } else {
                    TableModelRowHeightRulesItem::AtLeast
                }
            }));
            repeat_header_rows.push(tr_pr.is_some_and(|tr_pr| bool_prop(tr_pr, "w:tblHeader")));
            row_cant_split.push(tr_pr.is_some_and(|tr_pr| bool_prop(tr_pr, "w:cantSplit")));
            row_revisions.push(match tr_pr {
                Some(tr_pr) => row_revision_of(tr_pr),
                None => None,
            });
        }
    }
    if rows.is_empty() {
        return Ok(None);
    }
    apply_row_prop_exceptions(&mut rows, &row_exceptions);
    apply_table_style_display(&mut rows, tbl.find_child("w:tblPr"), ctx)?;
    // w:gridBefore/w:gridAfter offset rows within the grid: placeholder cells keep
    // the offset visible (inserted after style banding so real cells keep their look)
    if row_edges
        .iter()
        .any(|e| e.before.0 > 0.0 || e.after.0 > 0.0)
    {
        for (i, cells) in rows.iter_mut().enumerate() {
            let e = &row_edges[i];
            if e.before.0 > 0.0 {
                let mut gap = TableCell::default();
                gap.paras.set(Vec::new());
                gap.grid_gap.set(true);
                if e.before.0 > 1.0 {
                    gap.col_span.set(e.before);
                }
                cells.insert(0, gap);
                row_tcws[i].insert(0, e.w_before.map(|w| w.0));
            }
            if e.after.0 > 0.0 {
                let mut gap = TableCell::default();
                gap.paras.set(Vec::new());
                gap.grid_gap.set(true);
                if e.after.0 > 1.0 {
                    gap.col_span.set(e.after);
                }
                cells.push(gap);
                row_tcws[i].push(e.w_after.map(|w| w.0));
            }
        }
    }
    let tcws_js: Vec<Vec<Option<JsNum>>> = row_tcws
        .iter()
        .map(|row| row.iter().map(|w| w.map(JsNum)).collect())
        .collect();
    let grid_raw_js = grid_widths_raw.as_deref().map(js);
    let reconciled = reconcile_grid_columns(&mut rows, &tcws_js, grid_raw_js.as_deref())?;
    if let Some(reconciled) = reconciled {
        let total: f64 = reconciled.iter().fold(0.0, |a, b| a + b.0);
        col_widths_pct = Some(reconciled.iter().map(|w| (w.0 / total) * 100.0).collect());
        col_widths_twips = Some(reconciled.iter().map(|w| w.0).collect());
    }
    let eff_borders: Option<crate::props::Borders> =
        tbl_borders.or_else(|| style_table.and_then(|ts| (*ts.borders).clone()));
    let mut model = TableModel {
        rows,
        col_widths_pct: col_widths_pct.as_deref().map(js),
        ..TableModel::default()
    };
    if let Some(widths) = &col_widths_twips {
        model.col_widths_twips = Some(js(widths));
    }
    if let Some(pct) = width_pct.filter(|pct| *pct != 0.0) {
        model.width_pct = Some(JsNum(pct));
    }
    let auto_width = tbl_w_node.is_none()
        || tbl_w_type == Some("auto")
        || (is_dxa(tbl_w_type) && not_positive(attr_number(tbl_w_w)));
    // pct widths still lay out with the autofit algorithm (only w:tblLayout
    // fixed switches it off), so their columns keep the min-content floor
    if !fixed_layout && (auto_width || width_pct.is_some()) {
        model.auto_layout = Some(true);
    }
    // Word lays an autofit table (tblW auto or dxa) out from tcW/content and saves
    // the result as the grid, so an unequal grid it kept is Word's own measure of
    // every word (probe: a dxa table drawn at its saved grid, not its tcW)
    if !fixed_layout
        && (width_pct.is_none() || grid_matches_pct)
        && col_widths_twips.is_some()
        && !tcw_wins
        && !uniform_grid
    {
        model.layout_grid = Some(true);
    }
    // no w:tcW at all: Word lays the pct table out from the cell content and never
    // consults the generator's grid (probe 2026-10-20: uniform and skewed grids
    // give identical columns)
    if !fixed_layout && width_pct.is_some() && table_lacks_tc_w(tbl) {
        model.content_autofit = Some(true);
    }
    model.auto_fit = Some(if fixed_layout || (!auto_width && width_pct.is_none()) {
        TableAutoFitMode::Fixed
    } else if width_pct == Some(100.0) {
        TableAutoFitMode::Window
    } else {
        TableAutoFitMode::Contents
    });
    if fixed_layout {
        model.fixed_layout = Some(true);
    } else if is_dxa(tbl_w_type) && attr_number(tbl_w_w) > 0.0 && width_pct.is_none() {
        model.dxa_width = Some(true);
    }
    if let Some(mar) = eff_cell_mar {
        model.cell_mar_twips = Some(bridge(&mar)?);
    }
    if let Some(spacing) = cell_spacing.filter(|spacing| *spacing != 0.0 && !spacing.is_nan()) {
        model.cell_spacing_twips = Some(JsNum(spacing));
    }
    if let Some(fill) = tbl_fill.filter(|fill| !fill.is_empty()) {
        model.fill = Some(fill);
    }
    if let Some(borders) = eff_borders {
        model.borders = Some(bridge(&borders)?);
    }
    if let Some(align) = tbl_align {
        model.align = Some(align);
    }
    if let Some(side) = float_side {
        model.float_side = Some(Some(side));
    }
    if let Some(pos) = float_pos {
        model.float_pos = Some(pos);
    }
    if tbl_ind_twips.is_finite() && tbl_ind_twips != 0.0 {
        model.indent_twips = Some(JsNum(tbl_ind_twips));
    }
    let tbl_style = child_attr(tbl.find_child("w:tblPr"), "w:tblStyle", "w:val");
    if let Some(style) = tbl_style.filter(|style| !style.is_empty()) {
        model.tbl_style_id = Some(style.to_owned());
    }
    let table_look: TableLook = bridge(&table_look_of(tbl_pr_node))?;
    model.table_look = Some(table_look);
    if tbl_pr_node.is_some_and(|tbl_pr| bool_prop(tbl_pr, "w:bidiVisual")) {
        model.bidi_visual = Some(true);
    }
    if row_heights_twips.iter().any(Option::is_some) {
        model.row_heights_twips = Some(row_heights_twips.iter().map(|h| h.map(JsNum)).collect());
        model.row_height_rules = Some(row_height_rules);
    }
    model.repeat_header_rows = Some(repeat_header_rows.into_iter().map(Some).collect());
    if row_cant_split.iter().any(|split| *split) {
        model.row_cant_split = Some(row_cant_split.into_iter().map(Some).collect());
    }
    if row_revisions.iter().any(Option::is_some) {
        model.row_revisions = Some(row_revisions);
    }
    let caption = child_attr(tbl_pr_node, "w:tblCaption", "w:val").filter(|c| !c.is_empty());
    if let Some(caption) = caption {
        model.caption = Some(caption.to_owned());
    }
    let description =
        child_attr(tbl_pr_node, "w:tblDescription", "w:val").filter(|d| !d.is_empty());
    if let Some(description) = description {
        model.description = Some(description.to_owned());
    }
    Ok(Some(model))
}

/// `x || 1`
fn or_one(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 1.0 } else { x }
}

/// `extractCell`: one `w:tc` to its display cell: properties, paragraphs with
/// their runs, nested tables and anchored boxes.
pub fn extract_cell(
    tc: &XNode,
    ctx: &BuildContext<'_>,
    depth: u32,
    doc_offset: Option<usize>,
    table_style_id: Option<&str>,
    conds: &[TableCond],
) -> Result<TableCell, Thrown> {
    let mut cell = TableCell::default();
    cell.paras.set(Vec::new());
    let mut rich_paras: Vec<TableParagraph> = Vec::new();
    let rctx = cell_resolver_of(ctx, table_style_id, conds);
    let theme = ctx.resolver.theme_colors.as_ref();

    if let Some(tc_pr) = tc.find_child("w:tcPr") {
        let span = child_number(Some(tc_pr), "w:gridSpan", "w:val");
        if span > 1.0 {
            cell.col_span.set(JsNum(span));
        }
        if let Some(v_merge) = tc_pr.find_child("w:vMerge") {
            cell.v_merge
                .set(if v_merge.attr("w:val") == Some("restart") {
                    TableCellVMerge::Restart
                } else {
                    TableCellVMerge::Continue
                });
        }
        if let Some(fill) =
            shd_display_fill(tc_pr.find_child("w:shd"), None).filter(|fill| !fill.is_empty())
        {
            cell.fill.set(fill);
        }
        match child_attr(Some(tc_pr), "w:vAlign", "w:val") {
            Some("center") => cell.v_align.set(TableCellVAlign::Center),
            Some("bottom") => cell.v_align.set(TableCellVAlign::Bottom),
            Some("top") => cell.v_align.set(TableCellVAlign::Top),
            _ => {}
        }
        if let Some(tc_mar) = cell_margins_of(tc_pr.find_child("w:tcMar")) {
            cell.cell_mar_twips.set(bridge(&tc_mar)?);
        }
        match child_attr(Some(tc_pr), "w:textDirection", "w:val") {
            Some("tbRl" | "tbRlV") => cell.text_direction.set(TableCellTextDirection::TbRl),
            Some("btLr" | "btLrV") => cell.text_direction.set(TableCellTextDirection::BtLr),
            _ => {}
        }
        if bool_prop(tc_pr, "w:noWrap") {
            cell.no_wrap.set(true);
        }
        if bool_prop(tc_pr, "w:hideMark") {
            cell.hide_mark.set(true);
        }
        if let Some(h_merge) = tc_pr.find_child("w:hMerge") {
            cell.h_merge
                .set(if h_merge.attr("w:val") == Some("restart") {
                    TableCellHMerge::Restart
                } else {
                    TableCellHMerge::Continue
                });
        }
        if let Some(borders) = merged_border_lines_of(Some(tc_pr), "w:tcBorders", false) {
            cell.borders.set(bridge(&borders)?);
        }
        for (kind, name) in [
            (TableCellCellRevisionKind::Ins, "w:cellIns"),
            (TableCellCellRevisionKind::Del, "w:cellDel"),
        ] {
            let Some(node) = tc_pr.find_child(name) else {
                continue;
            };
            let truthy = |key: &str| node.attr(key).filter(|v| !v.is_empty()).map(str::to_owned);
            cell.cell_revision.set(TableCellCellRevision {
                kind,
                author: node.attr("w:author").unwrap_or("").to_owned(),
                date: truthy("w:date"),
                date_utc: truthy("w16du:dateUtc"),
                id: truthy("w:id"),
                r#move: None,
            });
            break;
        }
    }

    // Tables nested in a cell: parsed as read-only sub-tables (byte fidelity is the
    // outer table's responsibility); anchors record their position among the paragraphs
    let mut nested: Vec<TableModel> = Vec::new();
    let mut nested_anchors: Vec<f64> = Vec::new();
    let mut saw_bold = false;
    let mut saw_non_bold = false;
    let mut run_colors: Vec<String> = Vec::new();
    let mut text_para_jcs: Vec<String> = Vec::new();
    let paras_len = |cell: &TableCell| cell.paras.as_ref().map_or(0, Vec::len);
    for block in children_through_sdt(tc, &["w:p", "w:tbl"]) {
        if block.name() == Some("w:tbl") {
            let model = if depth >= MAX_TABLE_NEST_DEPTH {
                flattened_table_model(block)
            } else {
                extract_table_model(block, ctx, depth + 1, doc_offset)?
            };
            if let Some(model) = model {
                nested.push(model);
                nested_anchors.push(paras_len(&cell) as f64);
            }
            continue;
        }
        let mut stripped: Option<XNode> = None;
        // anchored shapes/textboxes in cell paragraphs (blip images already ride the
        // runs): Word renders them inside the cell and grows the row to hold them
        // (tdf134277). Their w:txbxContent is stripped from the paragraph so the box
        // text does not additionally render as plain cell text.
        if has_deep_child(block, &["w:drawing", "w:pict"]) {
            // Word pairs every DrawingML shape with a VML twin in mc:Fallback: strip the
            // fallback like buildBlock's detect, or each shape extracts twice
            let raw_p_xml = serialize(block);
            let p_xml = if raw_p_xml.contains("<mc:Fallback") {
                js_regex!(r"<mc:Fallback[^>]*>[\s\S]*?<\/mc:Fallback>", "g")
                    .replace_all(&raw_p_xml, |_| String::new())
            } else {
                raw_p_xml
            };
            if p_xml.contains("<wp:anchor") || js_regex!(r"<w:pict[\s>]").test(&p_xml) {
                // two or more pictures anchored in one cell paragraph sit at their own
                // offsets (side by side in Word); as run images they would float one
                // below the other and grow the row
                let pictures = top_level_drawings(&p_xml)
                    .iter()
                    .filter(|f| f.contains("<wp:anchor") && f.contains("<pic:pic"))
                    .count()
                    >= 2;
                let boxes = extract_textboxes(
                    &p_xml,
                    ctx,
                    ExtractTextboxOpts {
                        shapes: true,
                        pictures,
                        doc_offset,
                        ..ExtractTextboxOpts::default()
                    },
                )?;
                if !boxes.is_empty() {
                    let mut all: Vec<_> = cell.anchored_boxes.as_ref().cloned().unwrap_or_default();
                    all.extend(boxes.iter().cloned());
                    cell.anchored_boxes.set(all);
                    // positionV relativeFrom="paragraph" measures from the anchor
                    // paragraph, not the cell top: remember which paragraph hosts each box
                    let mut anchors: Vec<JsNum> = cell
                        .anchored_box_anchors
                        .as_ref()
                        .cloned()
                        .unwrap_or_default();
                    let here = JsNum(paras_len(&cell) as f64);
                    anchors.extend(boxes.iter().map(|_| here));
                    cell.anchored_box_anchors.set(anchors);
                    // the boxes now display separately: drop the anchored drawings (and
                    // textbox picts) from the paragraph node so their inner text/offsets
                    // don't leak into the cell's own runs; inline drawings stay for images
                    let mut txml = p_xml.clone();
                    for frag in top_level_drawings(&p_xml) {
                        // a lone anchored picture is no shape box: it stays on the run-image path
                        if frag.contains("<wp:anchor") && (pictures || !frag.contains("<pic:pic")) {
                            txml = txml.replace(frag, "");
                        }
                    }
                    let txml = try_js_regex!(
                        r"<w:pict>(?:(?!<\/w:pict>)[\s\S])*?<w:txbxContent>[\s\S]*?<\/w:pict>",
                        "g"
                    )
                    .try_replace_all(&txml, |_| String::new())
                    .map_err(|limit| limit.to_string())?;
                    // a parser refusal keeps the original paragraph node
                    if let Ok(nodes) = parse_ordered(&txml, XML_PARSER_MAX_NESTED_TAGS)
                        && let Some(first) = nodes.into_iter().next()
                        && first.name() == Some("w:p")
                    {
                        stripped = Some(first);
                    }
                }
            }
        }
        let p: &XNode = stripped.as_ref().unwrap_or(block);
        let para_text = p.text();
        cell.paras
            .as_mut()
            .unwrap_or_else(|| unreachable!("paras was set first"))
            .push(para_text.clone());
        let p_pr = p.find_child("w:pPr");
        let cell_style_id = p_pr.and_then(|p_pr| child_attr(Some(p_pr), "w:pStyle", "w:val"));
        let style_ctx = ctx.style_ctx();
        let cell_ref = list_ref_of(&style_ctx, p_pr, cell_style_id)?;
        let list = match &cell_ref {
            Some(cell_ref) => Some(TableParagraphList {
                kind: match list_kind_of(&style_ctx, &cell_ref.num_id, cell_ref.ilvl.0)? {
                    "bullet" => TableParagraphListKind::Bullet,
                    _ => TableParagraphListKind::Ordered,
                },
                num_id: cell_ref.num_id.clone(),
                ilvl: cell_ref.ilvl,
            }),
            None => None,
        };
        let eff0 = resolve_paragraph_props(p_pr, &rctx, ResolveParaOptions::default())?;
        // equations in cells: the m:oMath fragments the run walk turns into atomic
        // math runs (without them the walk yields nothing and the formula is lost)
        let math_source = if has_deep_child(p, &["m:oMath"]) {
            Some(math_source_xml_of(&serialize(p)))
        } else {
            None
        };
        let math_fragments: Vec<&str> = math_source
            .as_deref()
            .map_or_else(Vec::new, omml::omml_fragments_of);
        let runs = extract_runs(
            p,
            ctx,
            &math_fragments,
            &[],
            true,
            None,
            Some(&ParaResolve {
                eff: &eff0,
                rctx: &rctx,
            }),
            ctx.table_raw.borrow().as_deref(),
        )?;
        let eff = if eff0.indent.chars.is_some() {
            resolve_paragraph_props(
                p_pr,
                &rctx,
                ResolveParaOptions {
                    char_units: Some(char_units_of(
                        ctx,
                        &runs,
                        p,
                        p_pr,
                        cell_style_id,
                        doc_offset,
                    )),
                },
            )?
        } else {
            eff0.clone()
        };
        let direct = resolved_para_format(&eff0, p_pr, theme)?;
        shadow_para_format(
            ctx,
            "cell",
            p_pr,
            style_bidi_of(&style_ctx, cell_style_id, cell_ref.as_ref())?,
            direct.as_ref(),
            &runs,
        )?;
        let eff_model = eff_to_model(&eff)?;
        let mut format = fold_effective_format(direct.as_ref(), p_pr, &eff_model);
        let texts: Vec<&str> = runs
            .iter()
            .map(|run| run.text.as_deref().unwrap_or(""))
            .collect();
        let space_only = !runs.is_empty()
            && space_only_runs(&texts)
            && !has_layout_run_content(p, layout_run_content());
        let mark_sized = runs.is_empty() || space_only;
        let empty_sz = if mark_sized {
            mark_size_of(&eff_model, p_pr)
                .map(|size| size.0)
                .or_else(|| {
                    if space_only {
                        None
                    } else {
                        empty_para_size_half_points(
                            p,
                            None,
                            false,
                            Some(para_cs_size(ctx, cell_style_id).0),
                        )
                    }
                })
        } else {
            None
        };
        let empty_font = if mark_sized {
            empty_para_mark_font(p, p_pr, ctx.resolver.theme_fonts.as_ref(), space_only)
        } else {
            None
        };
        let mark_sz = if cell_ref.is_some() {
            mark_size_of(&eff_model, p_pr)
        } else {
            None
        };
        if let Some(size) = empty_sz.filter(|size| *size != 0.0 && !size.is_nan()) {
            format.empty_run_size_half_points.set(JsNum(size));
        }
        if let Some(font) = empty_font.filter(|font| !font.is_empty()) {
            format.empty_run_font_family.set(font);
        }
        if let Some(size) = mark_sz.filter(|size| size.0 != 0.0 && !size.0.is_nan()) {
            format.mark_size_half_points.set(size);
        }
        rich_paras.push(TableParagraph {
            para_format: format,
            style_id: cell_style_id.filter(|id| !id.is_empty()).map(str::to_owned),
            list,
            runs,
        });
        if !para_text.is_empty() {
            text_para_jcs.push(child_attr(p_pr, "w:jc", "w:val").unwrap_or("").to_owned());
        }
        for r in p.find_children("w:r") {
            let r_pr = r.find_child("w:rPr");
            if r_pr.is_some_and(|r_pr| bool_prop(r_pr, "w:b")) {
                saw_bold = true;
            } else {
                saw_non_bold = true;
            }
            if !r.text().is_empty() {
                run_colors.push(match r_pr {
                    Some(r_pr) => {
                        color_from(Some(r_pr), theme).unwrap_or_else(|| "none".to_owned())
                    }
                    None => "none".to_owned(),
                });
            }
        }
    }
    // cell.align only when every text paragraph declares the same jc; a first-wins
    // td-level text-align would leak onto the cell's jc-less paragraphs
    let distinct_jcs: HashSet<&String> = text_para_jcs.iter().collect();
    if distinct_jcs.len() == 1 {
        match text_para_jcs[0].as_str() {
            "center" => cell.align.set(ParaAlign::Center),
            "right" => cell.align.set(ParaAlign::Right),
            "left" => cell.align.set(ParaAlign::Left),
            "justify" => cell.align.set(ParaAlign::Justify),
            _ => {}
        }
    }
    cell.rich_paras.set(rich_paras);
    if !nested.is_empty() {
        cell.nested_tables.set(nested);
        let len = paras_len(&cell) as f64;
        cell.nested_table_anchors.set(
            nested_anchors
                .into_iter()
                .map(|a| JsNum(a.min(len)))
                .collect(),
        );
    }
    if saw_bold && !saw_non_bold {
        cell.bold.set(true);
    }
    // cell.color only when every text run agrees (mixed colors stay run-level)
    let distinct_colors: HashSet<&String> = run_colors.iter().collect();
    if distinct_colors.len() == 1 && run_colors[0] != "none" {
        cell.color.set(run_colors[0].clone());
    }
    Ok(cell)
}
