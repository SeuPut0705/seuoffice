//! `table/forward.ts`: ODF -> OOXML for tables.
//!
//! A table becomes one `w:tbl` with a fixed grid (column widths from the
//! column styles), row heights, header rows (`w:tblHeader`), merges
//! (`w:gridSpan` / `w:vMerge`), and per cell its borders, fill, vertical
//! alignment and padding. Cell paragraphs are converted by the text layer's
//! `paragraphToOoxml`; tables in cells (bare or framed) become nested tables.
//!
//! The cell properties are written exactly as the docx engine regenerates them
//! from its own model (`tcW`, `gridSpan`, `vMerge`, `tcBorders`, `shd`,
//! `tcMar`, `vAlign`, in schema order), so an editor that rewrites the table
//! reproduces the same `w:tcPr` for an untouched cell. The save side relies on
//! that to tell untouched cells from edited ones.

use std::collections::HashMap;

use docx_engine::model::{CellBorder, CellBorders, GeneratedBlockListKind};
use jscompat::{
    JsNum, JsObject, js_regex, math_max, math_min, math_round, number_to_string, parse_float, trim,
};

use crate::core::body::OdtNode;
use crate::core::convert::{BridgeListItem, OdfToOoxmlContext};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::core::xml::{ElementRange, escape_xml_attr};
use crate::offset::IndexedText;
use crate::text::lists::{ListInstance, ListInstanceAttrs, list_instance};
use crate::text::paragraph_ooxml::{ParagraphList, ParagraphOoxmlOptions, paragraph_to_ooxml};
use crate::text::units::length_to_twips;

use super::model::{
    AnchorCellRecord, CellRecord, ColumnRecord, CoveredCellRecord, ElementRecord, EmptyCellRecord,
    FrameRecord, HostRef, NestedStep, PosElement, PosRange, RangeRecord, RowRecord, Synthetic,
    TABLE_OWNER, TableExt, TableRecord, UnitRecord,
};
use super::odf_read::{
    FrameHost, OdfCellKind, OdfGrid, TableFrame, UnitDraft, cell_is_protected, content_units,
    read_grid, row_height_cm, style_props, tc_indexes,
};

/// `DEFAULT_TABLE_TWIPS`: default width of a table whose styles give none: A4
/// text width with 2 cm margins (twips).
const DEFAULT_TABLE_TWIPS: f64 = 9638.0;

/// `elementRecord`: the offsets of an element as the bridge stores them
/// (`xml` is the part string the byte offsets of `n` index).
pub fn element_record(xml: &IndexedText, n: &ElementRange) -> ElementRecord {
    ElementRecord {
        start: xml.to_u16(n.start),
        end: xml.to_u16(n.end),
        open_end: xml.to_u16(n.open_end),
        close_start: xml.to_u16(n.close_start),
        self_closing: n.self_closing,
    }
}

/// `elementRecord(node)`
fn node_record(xml: &IndexedText, n: &OdtNode) -> ElementRecord {
    element_record(xml, &n.range())
}

/// The range of `node` as the bridge stores it.
fn range_record(xml: &IndexedText, n: &OdtNode) -> RangeRecord {
    RangeRecord {
        start: xml.to_u16(n.start),
        end: xml.to_u16(n.end),
    }
}

// ---------------------------------------------------------------------------
// Cell properties

/// `CellProps['vAlign']`
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum CellVAlign {
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "bottom")]
    Bottom,
}

impl CellVAlign {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            CellVAlign::Center => "center",
            CellVAlign::Bottom => "bottom",
        }
    }
}

/// `CellProps`: the cell look the bridge maps, in the docx engine's model
/// shape (what it writes into `w:tcPr`).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_align: Option<CellVAlign>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borders: Option<CellBorders>,
}

/// `{ top?: number; left?: number; bottom?: number; right?: number }`
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct SideTwips {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<JsNum>,
}

impl SideTwips {
    /// `margins[side]`
    pub fn get(&self, side: &str) -> Option<JsNum> {
        match side {
            "top" => self.top,
            "left" => self.left,
            "bottom" => self.bottom,
            _ => self.right,
        }
    }

    fn set(&mut self, side: &str, value: JsNum) {
        match side {
            "top" => self.top = Some(value),
            "left" => self.left = Some(value),
            "bottom" => self.bottom = Some(value),
            _ => self.right = Some(value),
        }
    }
}

/// The result of `cellPropsFromOdf`.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct CellPropsAndMargins {
    pub props: CellProps,
    pub margins: SideTwips,
}

/// `ODF_TO_OOXML_BORDER`
fn odf_to_ooxml_border(style: &str) -> Option<&'static str> {
    Some(match style {
        "solid" => "single",
        "double" => "double",
        "dotted" => "dotted",
        "dashed" => "dashed",
        "dash-dot" => "dotDash",
        "dash-dot-dot" => "dotDotDash",
        "double-thin" => "double",
        "groove" => "threeDEngrave",
        "ridge" => "threeDEmboss",
        "inset" => "inset",
        "outset" => "outset",
        "fine-dashed" => "dashSmallGap",
        "wave" => "wave",
        _ => return None,
    })
}

/// `borderFromOdf`: an ODF border (`0.012cm solid #000000`, `none`) as an
/// engine border, or `None` when unset.
pub fn border_from_odf(value: Option<&str>) -> Option<CellBorder> {
    let value = value?;
    let tokens = js_regex!(r"\s+").split(trim(value));
    let mut width: Option<f64> = None;
    let mut style = "solid".to_string();
    let mut color: Option<String> = None;
    for t in tokens {
        if let Some(tw) = length_to_twips(Some(t)) {
            width = Some(tw);
        } else if js_regex!(r"^#[0-9a-fA-F]{6}$").test(t) {
            color = Some(t[1..].to_uppercase());
        } else if js_regex!(r"^#[0-9a-fA-F]{3}$").test(t) {
            color = Some(
                t[1..]
                    .chars()
                    .flat_map(|c| [c, c])
                    .collect::<String>()
                    .to_uppercase(),
            );
        } else {
            style = t.to_lowercase();
        }
    }
    if style == "none" || style == "hidden" || width == Some(0.0) {
        return Some(CellBorder {
            style: "nil".to_string(),
            sz_eighths: None,
            color: None,
        });
    }
    let ooxml = odf_to_ooxml_border(&style).unwrap_or("single");
    // w:sz is in eighths of a point; a double line's width covers both lines and the gap
    let pt = width.unwrap_or(20.0) / 20.0;
    let sz = math_max(
        2.0,
        math_min(
            96.0,
            math_round((pt * 8.0) / if ooxml == "double" { 3.0 } else { 1.0 }),
        ),
    );
    Some(CellBorder {
        style: ooxml.to_string(),
        sz_eighths: Some(JsNum(sz)),
        color: Some(color.unwrap_or_else(|| "000000".to_string())),
    })
}

/// `cellPropsFromOdf`: the cell properties the bridge maps from a cell style.
pub fn cell_props_from_odf(props: &JsObject<String>) -> CellPropsAndMargins {
    let get = |key: &str| props.get(key).map(String::as_str);
    let mut out = CellProps::default();
    if let Some(bg) = get("fo:background-color") {
        if !bg.is_empty() && js_regex!(r"^#[0-9a-fA-F]{6}$").test(bg) {
            out.fill = Some(bg[1..].to_uppercase());
        }
    }
    match get("style:vertical-align") {
        Some("middle") => out.v_align = Some(CellVAlign::Center),
        Some("bottom") => out.v_align = Some(CellVAlign::Bottom),
        _ => {}
    }
    let all = get("fo:border");
    let mut borders = CellBorders::default();
    for side in ["top", "left", "bottom", "right"] {
        let value = get(&format!("fo:border-{side}")).or(all);
        if let Some(b) = border_from_odf(value) {
            match side {
                "top" => borders.top.set(b),
                "left" => borders.left.set(b),
                "bottom" => borders.bottom.set(b),
                _ => borders.right.set(b),
            }
        }
    }
    if let Some(tl) = border_from_odf(get("style:diagonal-tl-br")) {
        if tl.style != "nil" {
            borders.tl2br.set(tl);
        }
    }
    if let Some(bl) = border_from_odf(get("style:diagonal-bl-tr")) {
        if bl.style != "nil" {
            borders.tr2bl.set(bl);
        }
    }
    if !borders.has_no_key() {
        out.borders = Some(borders);
    }
    let mut margins = SideTwips::default();
    for side in ["top", "left", "bottom", "right"] {
        let value = get(&format!("fo:padding-{side}")).or(get("fo:padding"));
        if let Some(t) = length_to_twips(value) {
            margins.set(side, JsNum(math_max(0.0, math_round(t))));
        }
    }
    CellPropsAndMargins {
        props: out,
        margins,
    }
}

/// `cellBordersXml`: `w:tcBorders` exactly as the docx engine writes it.
pub fn cell_borders_xml(borders: &CellBorders) -> String {
    let side = |name: &str, b: Option<&CellBorder>| -> String {
        let Some(b) = b else { return String::new() };
        if b.style == "none" || b.style == "nil" {
            return format!("<w:{name} w:val=\"{}\"/>", b.style);
        }
        format!(
            "<w:{name} w:val=\"{}\" w:sz=\"{}\" w:space=\"0\" w:color=\"{}\"/>",
            escape_xml_attr(&b.style),
            number_to_string(b.sz_eighths.map_or(4.0, |n| n.0)),
            escape_xml_attr(b.color.as_deref().unwrap_or("auto")),
        )
    };
    format!(
        "<w:tcBorders>{}{}{}{}{}{}</w:tcBorders>",
        side("top", borders.top.as_ref()),
        side("left", borders.left.as_ref()),
        side("bottom", borders.bottom.as_ref()),
        side("right", borders.right.as_ref()),
        side("tl2br", borders.tl2br.as_ref()),
        side("tr2bl", borders.tr2bl.as_ref()),
    )
}

/// `vMerge` argument of `tcPrXml`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum VMerge {
    Restart,
    Continue,
}

/// `tcPrXml`
fn tc_pr_xml(
    width: f64,
    span: usize,
    v_merge: Option<VMerge>,
    props: &CellProps,
    margins: &SideTwips,
) -> String {
    let mut x = format!(
        "<w:tcW w:w=\"{}\" w:type=\"dxa\"/>",
        number_to_string(width)
    );
    if span > 1 {
        x.push_str(&format!("<w:gridSpan w:val=\"{span}\"/>"));
    }
    match v_merge {
        Some(VMerge::Restart) => x.push_str("<w:vMerge w:val=\"restart\"/>"),
        Some(VMerge::Continue) => x.push_str("<w:vMerge/>"),
        None => {}
    }
    if let Some(borders) = &props.borders {
        x.push_str(&cell_borders_xml(borders));
    }
    if let Some(fill) = &props.fill {
        x.push_str(&format!(
            "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/>"
        ));
    }
    let mut mar = String::new();
    for s in ["top", "left", "bottom", "right"] {
        if let Some(w) = margins.get(s) {
            mar.push_str(&format!(
                "<w:{s} w:w=\"{}\" w:type=\"dxa\"/>",
                number_to_string(w.0)
            ));
        }
    }
    if !mar.is_empty() {
        x.push_str(&format!("<w:tcMar>{mar}</w:tcMar>"));
    }
    if let Some(v) = props.v_align {
        x.push_str(&format!("<w:vAlign w:val=\"{}\"/>", v.as_str()));
    }
    format!("<w:tcPr>{x}</w:tcPr>")
}

// ---------------------------------------------------------------------------
// Tables

/// A locked cell of a converted table, as `ConvertedTable.protectedCells` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalProtected {
    pub path: Vec<NestedStep>,
    pub row: usize,
    pub col: usize,
    pub tc: usize,
}

/// `ConvertedTable`
#[derive(Clone, Debug)]
pub struct ConvertedTable {
    pub xml: String,
    /// `record`: the id of the table's record in `TableExt.tables` (the
    /// TypeScript holds the record itself; it lives in the `ext` here)
    pub record_id: usize,
    /// locked cells of this table and its nested tables (`table` is filled in by the caller)
    pub protected_cells: Vec<LocalProtected>,
}

/// `TableEnv['align']`: the frame paragraph's alignment for as-char framed tables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableAlign {
    Center,
    Right,
}

impl TableAlign {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            TableAlign::Center => "center",
            TableAlign::Right => "right",
        }
    }
}

/// `TableEnv`
pub struct TableEnv<'e> {
    pub block_id: usize,
    pub ext: &'e mut TableExt,
    pub host: Option<HostRef>,
    pub frame: Option<FrameRecord>,
    /// the frame paragraph's alignment for as-char framed tables (`center`, `right`)
    pub align: Option<TableAlign>,
    /// the table sits in a locked cell: all its cells are locked too
    pub locked: bool,
}

/// `columnWidths`
fn column_widths(ctx: &OdfToOoxmlContext, grid: &OdfGrid<'_>) -> Vec<f64> {
    let doc = ctx.doc.clone();
    let table_props = style_props(
        &doc,
        grid.table.attr("table:style-name"),
        "table",
        "style:table-properties",
    );
    let table_width = length_to_twips(table_props.get("style:width").map(String::as_str));
    let mut abs: Vec<Option<f64>> = Vec::new();
    let mut rel: Vec<Option<f64>> = Vec::new();
    for col in &grid.columns {
        let p = style_props(
            &doc,
            col.node.and_then(|n| n.attr("table:style-name")),
            "table-column",
            "style:table-column-properties",
        );
        abs.push(length_to_twips(
            p.get("style:column-width").map(String::as_str),
        ));
        let r = js_regex!(r"^\s*(\d+(?:\.\d+)?)\*\s*$")
            .exec(p.get("style:rel-column-width").map_or("", String::as_str));
        rel.push(r.and_then(|m| m.get(1)).map(parse_float));
    }
    if abs.iter().all(|w| w.is_some_and(|w| w > 0.0)) {
        return abs
            .iter()
            .map(|w| math_max(1.0, math_round(w.expect("checked above"))))
            .collect();
    }
    let total = table_width.unwrap_or(DEFAULT_TABLE_TWIPS);
    if rel.iter().all(|w| w.is_some_and(|w| w > 0.0)) {
        let sum = rel.iter().fold(0.0, |a, b| a + b.expect("checked above"));
        return rel
            .iter()
            .map(|w| math_max(1.0, math_round((w.expect("checked above") / sum) * total)))
            .collect();
    }
    let known: Vec<f64> = abs.iter().filter_map(|w| w.filter(|&w| w > 0.0)).collect();
    let rest = math_max(0.0, total - known.iter().fold(0.0, |a, b| a + b));
    let missing = (abs.len() - known.len()) as f64;
    abs.iter()
        .map(|w| {
            math_max(
                1.0,
                math_round(match w {
                    Some(w) if *w > 0.0 => *w,
                    _ => rest / math_max(1.0, missing),
                }),
            )
        })
        .collect()
}

/// `widthOf`
fn width_of(widths: &[f64], c: usize, span: usize) -> f64 {
    let end = (c + span).min(widths.len());
    widths[c.min(end)..end].iter().fold(0.0, |a, b| a + b)
}

/// `convertTable`: converts a `table:table` node (and the tables nested in
/// its cells) to a `w:tbl`.
pub fn convert_table(
    ctx: &mut OdfToOoxmlContext,
    node: &OdtNode,
    env: &mut TableEnv<'_>,
) -> Result<ConvertedTable, OdtError> {
    let doc = ctx.doc.clone();
    let source = node.source_xml().clone();
    let xml: &IndexedText = &source;
    let grid = read_grid(node);
    let widths = column_widths(ctx, &grid);
    let total = widths.iter().fold(0.0, |a, b| a + b);
    let tcs = tc_indexes(&grid.cells);
    let id = env.ext.tables.len();
    let record = TableRecord {
        element: node_record(xml, node),
        id,
        block: env.block_id,
        element_id: None,
        host: env.host,
        frame: env.frame.clone(),
        header_rows: grid.header_rows.map(|h| node_record(xml, h)),
        rows: Vec::new(),
        columns: Vec::new(),
        cells: Vec::new(),
        width_twips: JsNum(total),
        structure_locked: grid.structure_locked.clone(),
    };
    env.ext.tables.push(record);
    let mut protected_cells: Vec<LocalProtected> = Vec::new();
    let table_locked = env.locked || node.attr("table:protected") == Some("true");

    let columns: Vec<ColumnRecord> = grid
        .columns
        .iter()
        .enumerate()
        .map(|(i, col)| match col.node {
            Some(n) => ColumnRecord {
                element: pos_element(xml, n),
                style: n.attr("table:style-name").map(str::to_string),
                repeated: col.repeated,
                width_twips: JsNum(widths[i]),
            },
            None => ColumnRecord {
                element: PosElement {
                    start: super::model::Pos::NONE,
                    end: super::model::Pos::NONE,
                    open_end: super::model::Pos::NONE,
                    close_start: super::model::Pos::NONE,
                    self_closing: true,
                },
                style: None,
                repeated: false,
                width_twips: JsNum(widths[i]),
            },
        })
        .collect();
    env.ext.tables[id].columns = columns;

    // cell properties per anchor (also used by vertical-merge continuations)
    let mut props_of: HashMap<(usize, usize), CellPropsAndMargins> = HashMap::new();
    let mut cell_props = |r: usize, c: usize| -> CellPropsAndMargins {
        props_of
            .entry((r, c))
            .or_insert_with(|| {
                let n = grid.cells[r][c].node;
                cell_props_from_odf(&style_props(
                    &doc,
                    n.and_then(|n| n.attr("table:style-name")),
                    "table-cell",
                    "style:table-cell-properties",
                ))
            })
            .clone()
    };

    let mut rows_xml = String::new();
    let mut rows_out: Vec<RowRecord> = Vec::new();
    let mut cells_out: Vec<Vec<CellRecord>> = Vec::new();
    for (r, row) in grid.rows.iter().enumerate() {
        let height = row_height_cm(&doc, row.node.attr("table:style-name"));
        rows_out.push(RowRecord {
            element: node_record(xml, row.node),
            header: row.header,
            style: row.node.attr("table:style-name").map(str::to_string),
            height_cm: height.map(|h| JsNum(h.cm)),
        });
        let mut cell_records: Vec<CellRecord> = Vec::new();
        let mut tc_xml = String::new();
        for (c, cell) in grid.cells[r].iter().enumerate() {
            let (ar, ac) = cell.anchor;
            let range = match cell.node {
                Some(n) => PosRange {
                    start: xml.to_u16(n.start).into(),
                    end: xml.to_u16(n.end).into(),
                },
                None => PosRange {
                    start: super::model::Pos::NONE,
                    end: super::model::Pos::NONE,
                },
            };
            if ar != r || ac != c {
                let tc = tcs[r][c];
                cell_records.push(CellRecord::Covered(CoveredCellRecord {
                    range,
                    anchor: (ar, ac),
                    tc,
                }));
                if tc.is_none() {
                    continue;
                }
                // continuation of a vertical merge: same look as its anchor
                let anchor = &grid.cells[ar][ac];
                let p = cell_props(ar, ac);
                tc_xml.push_str(&format!(
                    "<w:tc>{}<w:p/></w:tc>",
                    tc_pr_xml(
                        width_of(&widths, c, anchor.col_span),
                        anchor.col_span,
                        Some(VMerge::Continue),
                        &p.props,
                        &p.margins
                    )
                ));
                continue;
            }
            let Some(cell_node) = cell.node.filter(|_| cell.kind == OdfCellKind::Cell) else {
                // a covered cell no merge explains, or a gap the ODT left: an empty cell
                let empty = EmptyCellRecord {
                    range,
                    tc: tcs[r][c].expect("an anchor position starts a w:tc"),
                };
                cell_records.push(if cell.node.is_some() {
                    CellRecord::Orphan(empty)
                } else {
                    CellRecord::Filler(empty)
                });
                tc_xml.push_str(&format!(
                    "<w:tc>{}<w:p/></w:tc>",
                    tc_pr_xml(
                        width_of(&widths, c, 1),
                        1,
                        None,
                        &CellProps::default(),
                        &SideTwips::default()
                    )
                ));
                continue;
            };
            let mut rec = AnchorCellRecord {
                element: node_record(xml, cell_node),
                tc: tcs[r][c].expect("an anchor position starts a w:tc"),
                style: cell_node.attr("table:style-name").map(str::to_string),
                units: Vec::new(),
                col_span: None,
                row_span: None,
                protected: false,
                synthetic: None,
            };
            if cell.col_span > 1 {
                rec.col_span = Some(cell.col_span);
            }
            if cell.row_span > 1 {
                rec.row_span = Some(cell.row_span);
            }
            let p = cell_props(r, c);
            if cell_is_protected(&doc, cell_node, table_locked) {
                rec.protected = true;
                protected_cells.push(LocalProtected {
                    path: Vec::new(),
                    row: r,
                    col: c,
                    tc: rec.tc,
                });
            }
            let content = convert_cell_content(ctx, cell_node, xml, env, id, r, c, &mut rec)?;
            protected_cells.extend(content.protected_cells);
            tc_xml.push_str(&format!(
                "<w:tc>{}{}</w:tc>",
                tc_pr_xml(
                    width_of(&widths, c, cell.col_span),
                    cell.col_span,
                    if cell.row_span > 1 {
                        Some(VMerge::Restart)
                    } else {
                        None
                    },
                    &p.props,
                    &p.margins
                ),
                content.xml
            ));
            cell_records.push(CellRecord::Cell(rec));
        }
        cells_out.push(cell_records);
        let mut tr_pr = String::new();
        if let Some(height) = height {
            let tw = math_round((height.cm * 1440.0) / 2.54);
            if tw > 0.0 {
                tr_pr.push_str(&format!(
                    "<w:trHeight w:val=\"{}\" w:hRule=\"{}\"/>",
                    number_to_string(tw),
                    if height.exact { "exact" } else { "atLeast" }
                ));
            }
        }
        if row.header {
            tr_pr.push_str("<w:tblHeader/>");
        }
        rows_xml.push_str(&format!(
            "<w:tr>{}{tc_xml}</w:tr>",
            if tr_pr.is_empty() {
                String::new()
            } else {
                format!("<w:trPr>{tr_pr}</w:trPr>")
            }
        ));
    }
    env.ext.tables[id].rows = rows_out;
    env.ext.tables[id].cells = cells_out;

    let table_props = style_props(
        &doc,
        node.attr("table:style-name"),
        "table",
        "style:table-properties",
    );
    let align = table_props.get("table:align").map(String::as_str);
    let jc: Option<&str> = match align {
        Some("center") => Some("center"),
        Some("right") => Some("right"),
        None | Some("left") | Some("margins") => env.align.map(TableAlign::as_str),
        _ => None,
    };
    let indent = if jc.is_some() {
        None
    } else {
        length_to_twips(table_props.get("fo:margin-left").map(String::as_str))
    };
    let nil = |s: &str| format!("<w:{s} w:val=\"nil\"/>");
    let tbl_pr = format!(
        "<w:tblPr><w:tblW w:w=\"{}\" w:type=\"dxa\"/>{}{}<w:tblBorders>{}</w:tblBorders><w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"0\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"0\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr>",
        number_to_string(total),
        match jc {
            Some(jc) => format!("<w:jc w:val=\"{jc}\"/>"),
            None => String::new(),
        },
        match indent {
            Some(indent) if indent != 0.0 && !indent.is_nan() && math_round(indent) != 0.0 =>
                format!(
                    "<w:tblInd w:w=\"{}\" w:type=\"dxa\"/>",
                    number_to_string(math_round(indent))
                ),
            _ => String::new(),
        },
        ["top", "left", "bottom", "right", "insideH", "insideV"]
            .iter()
            .map(|s| nil(s))
            .collect::<String>(),
    );
    let tbl_grid = format!(
        "<w:tblGrid>{}</w:tblGrid>",
        widths
            .iter()
            .map(|w| format!("<w:gridCol w:w=\"{}\"/>", number_to_string(*w)))
            .collect::<String>()
    );
    if let Some(why) = &grid.structure_locked {
        ctx.warn(&format!(
            "table structure kept as written ({why}): only cell text is editable"
        ));
    }
    Ok(ConvertedTable {
        xml: format!("<w:tbl>{tbl_pr}{tbl_grid}{rows_xml}</w:tbl>"),
        record_id: id,
        protected_cells,
    })
}

/// `elementRecord` of a node that may be missing (`ColumnRecord`'s offsets).
fn pos_element(xml: &IndexedText, n: &OdtNode) -> PosElement {
    let e = node_record(xml, n);
    PosElement {
        start: e.start.into(),
        end: e.end.into(),
        open_end: e.open_end.into(),
        close_start: e.close_start.into(),
        self_closing: e.self_closing,
    }
}

/// The result of `convertCellContent`.
struct CellContent {
    xml: String,
    protected_cells: Vec<LocalProtected>,
}

/// `NestedTable`: converts one table found in a frame (or a cell) and returns
/// its record id and `w:tbl`.
pub type NestedTable<'f> = dyn FnMut(
        &mut OdfToOoxmlContext,
        &OdtNode,
        Option<FrameRecord>,
        Option<TableAlign>,
    ) -> Result<NestedTableResult, OdtError>
    + 'f;

/// What a `NestedTable` returns.
pub struct NestedTableResult {
    pub id: usize,
    pub xml: String,
}

/// `convertCellContent`: converts the content of an anchor cell; fills
/// `rec.units` and `rec.synthetic`.
#[allow(clippy::too_many_arguments)]
fn convert_cell_content(
    ctx: &mut OdfToOoxmlContext,
    cell: &OdtNode,
    xml: &IndexedText,
    env: &mut TableEnv<'_>,
    table_id: usize,
    row: usize,
    col: usize,
    rec: &mut AnchorCellRecord,
) -> Result<CellContent, OdtError> {
    let units = content_units(cell, &xml.text);
    let mut lists: Vec<(*const OdtNode, String, Vec<GeneratedBlockListKind>)> = Vec::new();
    let mut out = String::new();
    let mut last_was_table = false;
    let mut table_index = 0usize;
    let mut protected_cells: Vec<LocalProtected> = Vec::new();
    let block_id = env.block_id;
    let locked = rec.protected;
    let ext = &mut *env.ext;
    let mut nested = |ctx: &mut OdfToOoxmlContext,
                      node: &OdtNode,
                      frame: Option<FrameRecord>,
                      align: Option<TableAlign>|
     -> Result<NestedTableResult, OdtError> {
        let step = NestedStep {
            row,
            col,
            index: table_index,
        };
        let mut inner = TableEnv {
            block_id,
            ext: &mut *ext,
            host: Some(HostRef {
                table: table_id,
                row,
                col,
                index: table_index,
            }),
            frame,
            align,
            locked,
        };
        let converted = convert_table(ctx, node, &mut inner)?;
        table_index += 1;
        for p in &converted.protected_cells {
            let mut path = vec![step];
            path.extend(p.path.iter().copied());
            protected_cells.push(LocalProtected {
                path,
                row: p.row,
                col: p.col,
                tc: p.tc,
            });
        }
        Ok(NestedTableResult {
            id: converted.record_id,
            xml: converted.xml,
        })
    };
    for u in &units {
        match u {
            UnitDraft::P { node, list } => {
                let mut member: Option<ParagraphList> = None;
                if let Some(l) = list {
                    let root = l.root as *const OdtNode;
                    let at = match lists.iter().position(|(k, _, _)| *k == root) {
                        Some(at) => at,
                        None => {
                            let inst: ListInstance = list_instance(
                                ctx,
                                block_id,
                                &ListInstanceAttrs {
                                    style_name: l.root.attr("text:style-name").map(str::to_string),
                                    xml_id: l.root.attr("xml:id").map(str::to_string),
                                    continue_list: l
                                        .root
                                        .attr("text:continue-list")
                                        .map(str::to_string),
                                    continue_numbering: l.root.attr("text:continue-numbering")
                                        == Some("true"),
                                },
                            );
                            lists.push((root, inst.num_id, inst.kinds));
                            lists.len() - 1
                        }
                    };
                    let (_, num_id, kinds) = &lists[at];
                    member = Some(ParagraphList {
                        item: BridgeListItem {
                            num_id: num_id.clone(),
                            level: l.depth,
                            header: l.header,
                            continuation: l.continuation,
                        },
                        kind: kinds
                            .get(l.depth.min(8))
                            .copied()
                            .unwrap_or(GeneratedBlockListKind::Ordered),
                    });
                }
                let p = paragraph_to_ooxml(
                    ctx,
                    &node.range(),
                    &ParagraphOoxmlOptions {
                        part: OdtStylePart::ContentXml,
                        owner: Some(TABLE_OWNER.to_string()),
                        block: Some(block_id),
                        list: member,
                    },
                )?;
                out.push_str(&p.xml);
                last_was_table = false;
                rec.units.push(UnitRecord::P {
                    paragraph: p.paragraph.id,
                    start: xml.to_u16(node.start),
                    end: xml.to_u16(node.end),
                });
            }
            UnitDraft::T { node } => {
                let t = nested(ctx, node, None, None)?;
                out.push_str(&t.xml);
                last_was_table = true;
                rec.units.push(UnitRecord::T {
                    table: t.id,
                    start: xml.to_u16(node.start),
                    end: xml.to_u16(node.end),
                });
            }
            UnitDraft::F { host, .. } => {
                let converted = convert_frame_host(ctx, host, block_id, xml, &mut nested)?;
                for part in &converted.parts {
                    out.push_str(&part.xml);
                }
                last_was_table = converted
                    .parts
                    .last()
                    .is_some_and(|p| p.kind == FramePartKind::Table);
                rec.units.push(converted.unit);
            }
        }
    }
    if units.is_empty() {
        rec.synthetic = Some(Synthetic::Empty);
        out.push_str("<w:p/>");
    } else if last_was_table {
        rec.synthetic = Some(Synthetic::Trailing);
        out.push_str("<w:p/>");
    }
    Ok(CellContent {
        xml: out,
        protected_cells,
    })
}

/// `frameRecord`
pub fn frame_record(xml: &IndexedText, host: &FrameHost<'_>, f: &TableFrame<'_>) -> FrameRecord {
    FrameRecord {
        paragraph: range_record(xml, host.node),
        frame: node_record(xml, f.frame),
        style: f.frame.attr("draw:style-name").map(str::to_string),
        anchor: f.frame.attr("text:anchor-type").map(str::to_string),
    }
}

/// `hostAlignment`: the alignment an as-char framed table takes from its paragraph.
pub fn host_alignment(
    ctx: &OdfToOoxmlContext,
    host: &FrameHost<'_>,
    f: &TableFrame<'_>,
) -> Option<TableAlign> {
    if f.frame.attr("text:anchor-type").unwrap_or("paragraph") != "as-char" {
        return None;
    }
    let p = style_props(
        &ctx.doc,
        host.node.attr("text:style-name"),
        "paragraph",
        "style:paragraph-properties",
    );
    match p.get("fo:text-align").map(String::as_str) {
        Some("center") => Some(TableAlign::Center),
        Some("end") | Some("right") => Some(TableAlign::Right),
        _ => None,
    }
}

/// `convertFrameHost(...).parts[i].kind`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FramePartKind {
    Paragraph,
    Table,
}

impl FramePartKind {
    /// The string the TypeScript holds (`BridgeElementKind`).
    pub fn as_str(self) -> &'static str {
        match self {
            FramePartKind::Paragraph => "paragraph",
            FramePartKind::Table => "table",
        }
    }
}

/// One of `convertFrameHost(...).parts`.
#[derive(Clone, Debug)]
pub struct FramePart {
    pub kind: FramePartKind,
    pub xml: String,
    pub paragraph: Option<usize>,
}

/// What `convertFrameHost` returns.
pub struct ConvertedFrameHost {
    pub parts: Vec<FramePart>,
    /// always a `UnitRecord::F`
    pub unit: UnitRecord,
}

/// `convertFrameHost`: a paragraph holding framed tables. A pure one shows
/// only its tables; a mixed one also shows its own text as a paragraph
/// (before the tables when its text starts before the first frame, else after
/// them). The framed tables of a mixed paragraph stay in its text as kept
/// markers.
pub fn convert_frame_host(
    ctx: &mut OdfToOoxmlContext,
    host: &FrameHost<'_>,
    block_id: usize,
    xml: &IndexedText,
    table: &mut NestedTable<'_>,
) -> Result<ConvertedFrameHost, OdtError> {
    let mut parts: Vec<FramePart> = Vec::new();
    let mut paragraph: Option<usize> = None;
    let text = |ctx: &mut OdfToOoxmlContext,
                parts: &mut Vec<FramePart>,
                paragraph: &mut Option<usize>|
     -> Result<(), OdtError> {
        let p = paragraph_to_ooxml(
            ctx,
            &host.node.range(),
            &ParagraphOoxmlOptions {
                part: OdtStylePart::ContentXml,
                owner: Some(TABLE_OWNER.to_string()),
                block: Some(block_id),
                list: None,
            },
        )?;
        *paragraph = Some(p.paragraph.id);
        parts.push(FramePart {
            kind: FramePartKind::Paragraph,
            xml: p.xml,
            paragraph: Some(p.paragraph.id),
        });
        Ok(())
    };
    if !host.pure && host.paragraph_first {
        text(ctx, &mut parts, &mut paragraph)?;
    }
    let mut ids: Vec<usize> = Vec::new();
    for f in &host.frames {
        let align = host_alignment(ctx, host, f);
        let t = table(ctx, f.table, Some(frame_record(xml, host, f)), align)?;
        ids.push(t.id);
        parts.push(FramePart {
            kind: FramePartKind::Table,
            xml: t.xml,
            paragraph: None,
        });
    }
    if !host.pure && !host.paragraph_first {
        text(ctx, &mut parts, &mut paragraph)?;
    }
    Ok(ConvertedFrameHost {
        parts,
        unit: UnitRecord::F {
            start: xml.to_u16(host.node.start),
            end: xml.to_u16(host.node.end),
            paragraph,
            paragraph_first: !host.pure && host.paragraph_first,
            tables: ids,
        },
    })
}
