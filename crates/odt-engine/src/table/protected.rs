//! `table/protected.ts`: reading the published list of locked cells from a
//! bridge map, for the editor and the command line (no conversion context
//! needed). The functions take `map.ext`, the `Pick<BridgeMap, 'ext'>` they
//! read.

use serde_json::{Map, Value};

use super::model::{NestedStep, ProtectedCellRef};

/// `protectedCellsOf`: every cell Hancom locked, as published by the table
/// layer (empty when none).
pub fn protected_cells_of(ext: &Map<String, Value>) -> Vec<ProtectedCellRef> {
    ext.get("table")
        .and_then(|table| table.get("protectedCells"))
        .and_then(|cells| serde_json::from_value(cells.clone()).ok())
        .unwrap_or_default()
}

/// `samePath`
fn same_path(a: &[NestedStep], b: &[NestedStep]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(s, t)| s.row == t.row && s.col == t.col && s.index == t.index)
}

/// How `isProtectedCell` addresses a cell inside its row: by grid position or
/// by `w:tc` index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellColumn {
    /// `{ col }`
    Col(usize),
    /// `{ tc }`
    Tc(usize),
}

/// The `cell` argument of `isProtectedCell`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellAddress {
    pub table: usize,
    /// `path`, empty when absent
    pub path: Vec<NestedStep>,
    pub row: usize,
    pub column: CellColumn,
}

/// `isProtectedCell`: whether a cell is locked. Address it by grid position
/// (`col`) or by its `w:tc` index in the row (`tc`), in the top-level table
/// whose `w:tbl` is bridge element `table`, through `path` for nested tables.
pub fn is_protected_cell(ext: &Map<String, Value>, cell: &CellAddress) -> bool {
    protected_cells_of(ext).iter().any(|p| {
        p.table == cell.table
            && p.row == cell.row
            && same_path(&p.path, &cell.path)
            && match cell.column {
                CellColumn::Col(col) => p.col == col,
                CellColumn::Tc(tc) => p.tc == tc,
            }
    })
}
