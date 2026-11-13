//! `odtTable.*`: the plain-data exports of `packages/odt-engine/src/table`.
//!
//! Conventions (the harness's `calls-odttable.ts` follows them):
//! - `text` is the first string parameter the function reads (`value`,
//!   `tcPr`, `xml`, `p`); where the TypeScript parameter may be `undefined`
//!   (`borderFromOdf`, `lengthCm`), `args.missing: true` stands for it;
//! - every other parameter is `args.<its name>`;
//! - `elementRecord` reads its offsets (UTF-16 units, `args.n`) over `text`,
//!   which must be at least as long as the largest offset;
//! - `tcIndexes` reads only `kind` and `anchor` of each grid cell (its `node`
//!   is never read);
//! - `protectedCellsOf` and `isProtectedCell` take `args.map` (an object whose
//!   `ext` holds the table slot);
//! - `paraText` takes `args.p`, `{ runs: [{ text }] }` or missing;
//! - `borderToOdf` takes `args.b`, a border or missing.
//!
//! The functions that need an `OdtDocument`, an `OdtNode` or a conversion
//! context (`readGrid`, `tableFrameOf`, `frameHostOf`, `contentUnits`,
//! `styleProps`, `cellIsProtected`, `rowHeightCm`, `frameRecord`,
//! `hostAlignment`, `convertTable`, `convertFrameHost`, `writeTable`,
//! `writeCellContent`, `writeFrameHost`, `newTableOdf`, `tableExt`,
//! `registerTableConverters`, the two converters) are not answered here.

use docx_engine::model::{CellBorder, CellBorders, TableCell, TableModel, TableParagraph};
use jscompat::{JsNum, JsObject};
use odt_engine::core::xml::ElementRange;
use odt_engine::offset::{IndexedText, U16};
use odt_engine::table::{
    CellAddress, CellColumn, CellRecord, NestedStep, OdfCellKind, OdfGridCell, OxCell, OxTable,
    TABLE_EXT_VERSION, TABLE_OWNER, anchor_of, as_json, border_from_odf, border_to_odf,
    cell_borders_xml, cell_props_from_odf, edited_grid, edited_items, element_record,
    empty_table_ext, is_protected_cell, length_cm, map_sequence, normalized_tc_pr, para_text,
    protected_cells_of, segment_table, span_of, tc_indexes, without_bridge_bookmarks,
};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{Returned, arg, required, value};

/// `ElementRange` as the TypeScript literal `{ start, end, openEnd, closeStart, selfClosing }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElementArg {
    start: U16,
    end: U16,
    open_end: U16,
    close_start: U16,
    self_closing: bool,
}

/// One grid cell of `tcIndexes`: its `kind` and `anchor`; the rest is not read.
#[derive(Deserialize)]
struct GridCellArg {
    kind: GridKind,
    anchor: (usize, usize),
}

#[derive(Deserialize, Clone, Copy)]
enum GridKind {
    #[serde(rename = "cell")]
    Cell,
    #[serde(rename = "covered")]
    Covered,
    #[serde(rename = "filler")]
    Filler,
}

/// `{ cell: TableCell, ox: OxCell | null }` of `editedItems`.
#[derive(Deserialize)]
struct AnchorArg {
    cell: TableCell,
    ox: Option<OxCell>,
}

/// `{ table, path?, row, col | tc }` of `isProtectedCell`.
#[derive(Deserialize)]
struct CellArg {
    table: usize,
    #[serde(default)]
    path: Vec<NestedStep>,
    row: usize,
    col: Option<usize>,
    tc: Option<usize>,
}

/// `{ runs: [{ text }] }` of `paraText`.
#[derive(Deserialize)]
struct ParaArg {
    #[serde(default)]
    runs: Vec<RunArg>,
}

#[derive(Deserialize)]
struct RunArg {
    text: Option<String>,
}

fn ext_of(args: &Value) -> Result<Map<String, Value>, String> {
    let map: Value = required(args, "map")?;
    Ok(match map.get("ext") {
        Some(Value::Object(ext)) => ext.clone(),
        _ => Map::new(),
    })
}

fn missing(args: &Value) -> Result<bool, String> {
    Ok(arg::<bool>(args, "missing")?.unwrap_or(false))
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "anchorOf" => {
            let cell: CellRecord = required(args, "cell")?;
            let row: usize = required(args, "row")?;
            let col: usize = required(args, "col")?;
            let (r, c) = anchor_of(&cell, row, col);
            value([r, c])
        }
        "spanOf" => {
            let cell: CellRecord = required(args, "cell")?;
            value(span_of(&cell))
        }
        "constant" => match required::<String>(args, "name")?.as_str() {
            "TABLE_OWNER" => value(TABLE_OWNER),
            "TABLE_EXT_VERSION" => value(TABLE_EXT_VERSION),
            "emptyTableExt" => Ok(Some(as_json(&empty_table_ext()))),
            other => Err(format!("no constant {other}")),
        },
        "asJson" => Ok(args.get("value").cloned()),
        "emptyTableExt" => Ok(Some(as_json(&empty_table_ext()))),
        "elementRecord" => {
            let n: ElementArg = required(args, "n")?;
            let xml = IndexedText::new(text.to_string());
            let range = ElementRange {
                start: xml.to_byte(n.start),
                end: xml.to_byte(n.end),
                open_end: xml.to_byte(n.open_end),
                close_start: xml.to_byte(n.close_start),
                self_closing: n.self_closing,
            };
            value(element_record(&xml, &range))
        }
        "tcIndexes" => {
            let cells: Vec<Vec<GridCellArg>> = required(args, "cells")?;
            let grid: Vec<Vec<OdfGridCell<'_>>> = cells
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|c| OdfGridCell {
                            node: None,
                            kind: match c.kind {
                                GridKind::Cell => OdfCellKind::Cell,
                                GridKind::Covered => OdfCellKind::Covered,
                                GridKind::Filler => OdfCellKind::Filler,
                            },
                            anchor: c.anchor,
                            col_span: 1,
                            row_span: 1,
                        })
                        .collect()
                })
                .collect();
            value(tc_indexes(&grid))
        }
        "lengthCm" => value(length_cm((!missing(args)?).then_some(text)).map(JsNum)),
        "segmentTable" => value(segment_table(text)),
        "normalizedTcPr" => value(normalized_tc_pr(text)),
        "withoutBridgeBookmarks" => value(without_bridge_bookmarks(text)),
        "editedGrid" => {
            let model: TableModel = required(args, "model")?;
            let ox: OxTable = required(args, "ox")?;
            value(edited_grid(&model, &ox))
        }
        "editedItems" => {
            let anchor: AnchorArg = required(args, "anchor")?;
            value(edited_items(&anchor.cell, anchor.ox.as_ref()))
        }
        "paraText" => {
            let p: Option<ParaArg> = arg(args, "p")?;
            let para = p.map(|p| {
                let mut para = TableParagraph::default();
                for run in p.runs {
                    let mut r = docx_engine::model::Run::default();
                    if let Some(t) = run.text {
                        r.text.set(t);
                    }
                    para.runs.push(r);
                }
                para
            });
            value(para_text(para.as_ref()))
        }
        "borderFromOdf" => value(border_from_odf((!missing(args)?).then_some(text))),
        "cellPropsFromOdf" => {
            let props: JsObject<String> = required(args, "props")?;
            value(cell_props_from_odf(&props))
        }
        "cellBordersXml" => {
            let borders: CellBorders = required(args, "borders")?;
            value(cell_borders_xml(&borders))
        }
        "borderToOdf" => {
            let b: Option<CellBorder> = arg(args, "b")?;
            value(border_to_odf(b.as_ref()))
        }
        "mapSequence" => {
            let original: Vec<String> = required(args, "original")?;
            let edited: Vec<String> = required(args, "edited")?;
            value(map_sequence(&original, &edited))
        }
        "protectedCellsOf" => value(protected_cells_of(&ext_of(args)?)),
        "isProtectedCell" => {
            let ext = ext_of(args)?;
            let cell: CellArg = required(args, "cell")?;
            let column = match (cell.col, cell.tc) {
                (Some(col), _) => CellColumn::Col(col),
                (None, Some(tc)) => CellColumn::Tc(tc),
                (None, None) => {
                    return Err("the cell argument names neither col nor tc".to_string());
                }
            };
            value(is_protected_cell(
                &ext,
                &CellAddress {
                    table: cell.table,
                    path: cell.path,
                    row: cell.row,
                    column,
                },
            ))
        }
        _ => Err(format!("no function {function}")),
    }
}
