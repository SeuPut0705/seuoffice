//! Tables and headers and footers.

pub mod extract;
pub mod hf;
pub mod hf_fields;
pub mod hf_images;
pub mod hf_paras;
pub mod hf_part;
pub mod hf_root;

use jscompat::{JsNum, Radix, Slot, js_regex, math_max, parse_int, to_int32, to_number};
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};

use crate::generate::rpr::js_slice;
use crate::model::{
    ParaFormat, Run, SectionSettings, TableCell, TableModel, TableModelRowRevisionsItem,
    TableModelRowRevisionsItemKind, TableParagraph,
};
use crate::resolve::TableCond;
use crate::xml_text::plain_text;

/// `maxNestedTags` of `deepXmlParser`, the parser of table XML.
pub const DEEP_XML_PARSER_MAX_NESTED_TAGS: usize = 100_000;

/// `Number(attrsOf(node)[key])`: an absent attribute is NaN.
fn number_attr(node: Option<&XNode>, key: &str) -> f64 {
    node.and_then(|node| node.attr(key))
        .map_or(f64::NAN, to_number)
}

/// `childrenThroughSdt`: the children named one of `names`, looking through
/// `w:sdt` → `w:sdtContent` wrappers at any depth.
pub fn children_through_sdt<'a>(node: &'a XNode, names: &[&str]) -> Vec<&'a XNode> {
    fn visit<'a>(node: &'a XNode, names: &[&str], out: &mut Vec<&'a XNode>) {
        for child in node.children() {
            match child.name() {
                Some(name) if names.contains(&name) => out.push(child),
                Some("w:sdt") => {
                    if let Some(content) = child.find_child("w:sdtContent") {
                        visit(content, names, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    visit(node, names, &mut out);
    out
}

/// What `tableSummary` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSummary {
    pub label: String,
    pub preview_text: String,
}

/// `tableSummary`: rows counted over the whole table, columns over its first
/// row, nested tables included; the text cut at 120 UTF-16 units.
pub fn table_summary(xml: &str) -> TableSummary {
    let rows = js_regex!(r"<w:tr[\s>]").find_iter(xml).count();
    let first_row = js_regex!(r"<w:tr[\s>][\s\S]*?<\/w:tr>")
        .exec(xml)
        .map_or("", |found| found.as_str());
    let cols = js_regex!(r"<w:tc[\s>]").find_iter(first_row).count();
    TableSummary {
        label: format!("Table {rows}×{cols}"),
        preview_text: js_slice(&plain_text(xml), 0, 120),
    }
}

/// `tableLacksTcW`: no direct cell of the table declares `w:tcW`.
pub fn table_lacks_tc_w(tbl: &XNode) -> bool {
    for tr in children_through_sdt(tbl, &["w:tr"]) {
        for tc in children_through_sdt(tr, &["w:tc"]) {
            if tc
                .find_child("w:tcPr")
                .and_then(|tc_pr| tc_pr.find_child("w:tcW"))
                .is_some()
            {
                return false;
            }
        }
    }
    true
}

/// What `rowGridEdges` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowGridEdges {
    pub before: JsNum,
    pub after: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w_before: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w_after: Option<JsNum>,
}

/// `rowGridEdges`: the `w:gridBefore`/`w:gridAfter` column counts of a row and
/// their `w:wBefore`/`w:wAfter` widths in twips.
pub fn row_grid_edges(tr: &XNode) -> RowGridEdges {
    let Some(tr_pr) = tr.find_child("w:trPr") else {
        return RowGridEdges {
            before: JsNum(0.0),
            after: JsNum(0.0),
            w_before: None,
            w_after: None,
        };
    };
    let count = |name: &str| {
        let v = number_attr(tr_pr.find_child(name), "w:val");
        JsNum(if v.is_finite() && v > 0.0 {
            v.floor()
        } else {
            0.0
        })
    };
    let width = |name: &str| {
        let a = tr_pr.find_child(name);
        let kind = a.and_then(|a| a.attr("w:type"));
        let w = if kind.is_none_or(|kind| kind.is_empty() || kind == "dxa") {
            number_attr(a, "w:w")
        } else {
            f64::NAN
        };
        (w > 0.0).then_some(JsNum(w))
    };
    RowGridEdges {
        before: count("w:gridBefore"),
        after: count("w:gridAfter"),
        w_before: width("w:wBefore"),
        w_after: width("w:wAfter"),
    }
}

/// Boundary positions within this many twips fuse into one grid line.
const GRID_SNAP_TOL: f64 = 20.0;

/// The indices `array.slice(start, end)` takes from an array of `len`.
fn slice_range(len: usize, start: f64, end: f64) -> std::ops::Range<usize> {
    let len_f = len as f64;
    let clamp = |i: f64| {
        // ToIntegerOrInfinity: NaN is 0, fractions go toward 0
        let i = if i.is_nan() { 0.0 } else { i.trunc() };
        if i < 0.0 {
            (len_f + i).max(0.0)
        } else {
            i.min(len_f)
        }
    };
    let (from, to) = (clamp(start), clamp(end));
    if from >= to {
        return 0..0;
    }
    from as usize..to as usize
}

/// `reconcileGridColumns`: rebuilds the grid of a table whose rows do not all
/// span the column count from the union of every row's cell boundaries.
/// Rewrites the cells' `colSpan` and returns the column widths; `None` where
/// the grid is consistent already or a width cannot be resolved. `Err` where
/// the TypeScript throws (`rowTcws` holds fewer rows than `rows`).
pub fn reconcile_grid_columns(
    rows: &mut [Vec<TableCell>],
    row_tcws: &[Vec<Option<JsNum>>],
    grid_cols: Option<&[JsNum]>,
) -> Result<Option<Vec<JsNum>>, String> {
    let spans: Vec<Vec<Option<JsNum>>> = rows
        .iter()
        .map(|row| row.iter().map(|cell| *cell.col_span).collect())
        .collect();
    let Some((new_spans, widths)) = reconcile_grid_spans(&spans, row_tcws, grid_cols)? else {
        return Ok(None);
    };
    for (row, spans) in rows.iter_mut().zip(&new_spans) {
        for (cell, &span) in row.iter_mut().zip(spans) {
            if span > 1 {
                cell.col_span.set(JsNum(span as f64));
            } else {
                cell.col_span.delete();
            }
        }
    }
    Ok(Some(widths))
}

/// The new spans of each row's cells and the column widths: `reconcileGridColumns`
/// over the cells' `colSpan` alone (`None` where a cell has none), the one
/// field it reads. The binding sends only these, not the cells.
pub fn reconcile_grid_spans(
    rows: &[Vec<Option<JsNum>>],
    row_tcws: &[Vec<Option<JsNum>>],
    grid_cols: Option<&[JsNum]>,
) -> Result<Option<(Vec<Vec<i64>>, Vec<JsNum>)>, String> {
    let span_of = |span: &Option<JsNum>| span.map_or(1.0, |span| span.0);
    let span_sums: Vec<f64> = rows
        .iter()
        .map(|row| row.iter().fold(0.0, |sum, cell| sum + span_of(cell)))
        .collect();
    let mut widest_span = 0.0;
    for &sum in &span_sums {
        if sum > widest_span {
            widest_span = sum;
        }
    }
    let col_count = grid_cols.map_or(widest_span, |grid| grid.len() as f64);
    if span_sums.iter().all(|&sum| sum == col_count) {
        return Ok(None);
    }
    let mut row_bounds: Vec<Vec<f64>> = Vec::with_capacity(rows.len());
    for (r, row) in rows.iter().enumerate() {
        let mut bounds = Vec::with_capacity(row.len());
        let mut x = 0.0;
        let mut pos = 0.0;
        for (c, cell) in row.iter().enumerate() {
            let span = span_of(cell);
            // `rowTcws[r][c]`: a missing row throws only once a cell reads it
            let tcws = row_tcws.get(r).ok_or_else(|| {
                "TypeError: Cannot read properties of undefined (reading '0')".to_owned()
            })?;
            let mut w = tcws.get(c).copied().flatten().map(|w| w.0);
            if !w.is_some_and(|w| w > 0.0) {
                w = grid_cols.map(|grid| {
                    grid[slice_range(grid.len(), pos, pos + span)]
                        .iter()
                        .fold(0.0, |sum, v| sum + v.0)
                });
            }
            let Some(w) = w.filter(|&w| w > 0.0) else {
                return Ok(None);
            };
            x += w;
            bounds.push(x);
            pos += span;
        }
        row_bounds.push(bounds);
    }
    let mut sorted: Vec<f64> = row_bounds.iter().flatten().copied().collect();
    sorted.sort_by(|a, b| {
        (a - b)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut reps: Vec<f64> = Vec::new();
    for b in sorted {
        if reps.last().is_none_or(|&last| b - last > GRID_SNAP_TOL) {
            reps.push(b);
        }
    }
    // Word caps table grids at 63 columns; a wider union means garbage input
    if reps.is_empty() || reps.len() > 96 {
        return Ok(None);
    }
    let rep_index = |b: f64| -> i64 {
        let (mut lo, mut hi) = (0usize, reps.len() - 1);
        while lo < hi {
            let mid = (lo + hi + 1) >> 1;
            if reps[mid] <= b {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        if reps[lo] <= b && b - reps[lo] <= GRID_SNAP_TOL {
            lo as i64
        } else {
            -1
        }
    };
    let mut new_spans: Vec<Vec<i64>> = Vec::with_capacity(row_bounds.len());
    for bounds in &row_bounds {
        let mut spans = Vec::with_capacity(bounds.len());
        let mut prev = -1;
        for &b in bounds {
            let idx = rep_index(b);
            if idx <= prev {
                return Ok(None);
            }
            spans.push(idx - prev);
            prev = idx;
        }
        new_spans.push(spans);
    }
    Ok(Some((
        new_spans,
        reps.iter()
            .enumerate()
            .map(|(i, &v)| JsNum(v - if i > 0 { reps[i - 1] } else { 0.0 }))
            .collect(),
    )))
}

/// `flattenedTableModel`: the whole subtree as a 1×1 table of the plain texts
/// of its outermost paragraphs; walked without recursion, as the subtree can
/// be thousands of levels deep.
pub fn flattened_table_model(tbl: &XNode) -> Option<TableModel> {
    enum Item<'a> {
        Node(&'a XNode),
        ParaEnd,
    }
    let mut paras: Vec<String> = Vec::new();
    let mut buf: Option<String> = None;
    let mut stack = vec![Item::Node(tbl)];
    while let Some(item) = stack.pop() {
        let node = match item {
            Item::ParaEnd => {
                paras.push(buf.take().unwrap_or_default());
                continue;
            }
            Item::Node(node) => node,
        };
        if let XNode::Text(text) = node {
            if let Some(buf) = buf.as_mut() {
                buf.push_str(text);
            }
            continue;
        }
        if buf.is_none() && node.name() == Some("w:p") {
            buf = Some(String::new());
            stack.push(Item::ParaEnd);
        }
        stack.extend(node.children().iter().rev().map(Item::Node));
    }
    if paras.is_empty() {
        return None;
    }
    let rich_paras = paras
        .iter()
        .map(|text| TableParagraph {
            para_format: ParaFormat::default(),
            style_id: None,
            list: None,
            runs: if text.is_empty() {
                Vec::new()
            } else {
                vec![Run {
                    text: Slot::of(text.clone()),
                    ..Run::default()
                }]
            },
        })
        .collect();
    let cell = TableCell {
        paras: Slot::of(paras),
        rich_paras: Slot::of(rich_paras),
        ..TableCell::default()
    };
    // autofit: without it the synthetic table collapses to a sliver and wraps every word
    Some(TableModel {
        rows: vec![vec![cell]],
        auto_layout: Some(true),
        ..TableModel::default()
    })
}

/// `new Set(values)` in insertion order: SameValueZero, so NaN is one value
/// and -0 is 0.
fn distinct(values: Vec<f64>) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::with_capacity(values.len());
    for value in values {
        if !out
            .iter()
            .any(|&seen| seen == value || (seen.is_nan() && value.is_nan()))
        {
            out.push(value);
        }
    }
    out
}

/// `usableTableWidths`: the widths Word shrinks an over-wide autofit table
/// to (the text column, one newspaper column), each also less the table
/// indent, and each of those also widened by `hang_twips` where it is
/// positive. `tbl_ind_twips` may be NaN.
pub fn usable_table_widths(
    sect: &SectionSettings,
    tbl_ind_twips: f64,
    hang_twips: f64,
) -> Vec<JsNum> {
    let text = sect.page_width.0 - sect.margin_left.0 - sect.margin_right.0;
    let columns = sect.columns.0;
    let per_column: Vec<f64> = if columns > 1.0 {
        match &sect.col_widths {
            Some(widths) if widths.len() as f64 == columns => widths.iter().map(|w| w.0).collect(),
            _ => vec![
                (text - sect.col_space.map_or(720.0, |space| space.0) * (columns - 1.0)) / columns,
            ],
        }
    } else {
        Vec::new()
    };
    let indent = if tbl_ind_twips.is_finite() {
        tbl_ind_twips
    } else {
        0.0
    };
    let mut bases = vec![text];
    bases.extend(per_column);
    let mut spans = bases.clone();
    spans.extend(bases.iter().map(|w| w - indent));
    if hang_twips > 0.0 {
        let hung: Vec<f64> = spans.iter().map(|w| w + hang_twips).collect();
        spans.extend(hung);
    }
    distinct(spans)
        .into_iter()
        .filter(|&w| w > 0.0)
        .map(JsNum)
        .collect()
}

/// `isUniformGrid`: every gridCol within 1% of the mean (or none given).
pub fn is_uniform_grid(widths: Option<&[JsNum]>) -> bool {
    let Some(widths) = widths else {
        return true;
    };
    let total = widths.iter().fold(0.0, |a, b| a + b.0);
    let len = widths.len() as f64;
    widths
        .iter()
        .all(|w| (w.0 * len - total).abs() <= math_max(2.0, total * 0.01))
}

/// `rowRevisionOf`: the first `w:ins`, else the first `w:del`, of a `w:trPr`.
pub fn row_revision_of(tr_pr: &XNode) -> Option<TableModelRowRevisionsItem> {
    for (kind, name) in [
        (TableModelRowRevisionsItemKind::Ins, "w:ins"),
        (TableModelRowRevisionsItemKind::Del, "w:del"),
    ] {
        let Some(node) = tr_pr.find_child(name) else {
            continue;
        };
        let truthy = |key: &str| node.attr(key).filter(|v| !v.is_empty()).map(str::to_owned);
        return Some(TableModelRowRevisionsItem {
            kind,
            author: node.attr("w:author").unwrap_or("").to_owned(),
            date: truthy("w:date"),
            date_utc: truthy("w16du:dateUtc"),
            id: truthy("w:id"),
            r#move: None,
        });
    }
    None
}

/// `TblLookFlags`: which conditional formats of its table style a table opts into.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TblLookFlags {
    pub first_row_on: bool,
    pub last_row_on: bool,
    pub first_col_on: bool,
    pub last_col_on: bool,
    pub h_band_on: bool,
}

/// `tblLookFlags`: the attributes of `w:tblLook`, else the bits of its
/// `w:val`, else Word's defaults.
pub fn tbl_look_flags(tbl_pr: Option<&XNode>) -> TblLookFlags {
    let look = tbl_pr.and_then(|tbl_pr| tbl_pr.find_child("w:tblLook"));
    let attr = |key: &str| look.and_then(|look| look.attr(key));
    let bits = parse_int(attr("w:val").unwrap_or(""), Radix::Sixteen);
    let flag = |key: &str, bit: i32, dflt: bool| match attr(key) {
        Some(value) => value != "0" && value != "false",
        None if bits.is_finite() => to_int32(bits) & bit != 0,
        None => dflt,
    };
    TblLookFlags {
        first_row_on: flag("w:firstRow", 0x20, true),
        last_row_on: flag("w:lastRow", 0x40, false),
        first_col_on: flag("w:firstColumn", 0x80, true),
        last_col_on: flag("w:lastColumn", 0x100, false),
        h_band_on: !flag("w:noHBand", 0x200, false),
    }
}

/// `cellConds`: the conditions a cell sits under, lowest precedence first.
pub fn cell_conds(
    look: &TblLookFlags,
    r: f64,
    row_count: f64,
    col: f64,
    span: f64,
    total_cols: f64,
) -> Vec<TableCond> {
    let mut out = Vec::new();
    if look.last_col_on && col + span == total_cols {
        out.push(TableCond::LastCol);
    }
    if look.first_col_on && col == 0.0 {
        out.push(TableCond::FirstCol);
    }
    if look.last_row_on && r == row_count - 1.0 {
        out.push(TableCond::LastRow);
    }
    if look.first_row_on && r == 0.0 {
        out.push(TableCond::FirstRow);
    }
    out
}
