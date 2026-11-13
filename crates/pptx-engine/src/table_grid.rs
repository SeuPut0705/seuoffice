//! Table grid-column accounting (packages/pptx-engine/src/table-grid.ts).

use serde::Deserialize;

/// What `tableRowGridCols` reads of a cell.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    pub grid_span: Option<f64>,
    pub merged: Option<bool>,
}

/// The starting grid column of each tc of a row. A tc advances the cursor by
/// one when the continuation tcs of its span follow it, all merged; otherwise
/// (a producer that leaves them out) by its span. Numbers as JavaScript has
/// them: a span can be fractional, zero or negative.
pub fn table_row_grid_cols(row: &[GridCell]) -> Vec<f64> {
    let mut cols = Vec::with_capacity(row.len());
    let mut c = 0.0;
    for (i, cell) in row.iter().enumerate() {
        cols.push(c);
        let span = cell.grid_span.unwrap_or(1.0);
        // row.slice(i + 1, i + span): the end truncated and clamped to the row
        let followers: &[GridCell] = if span > 1.0 {
            let end = ((i as f64) + span).trunc().min(row.len() as f64) as usize;
            &row[i + 1..end.max(i + 1)]
        } else {
            &[]
        };
        c += if followers.len() as f64 == span - 1.0
            && followers.iter().all(|f| f.merged == Some(true))
        {
            1.0
        } else {
            span
        };
    }
    cols
}
