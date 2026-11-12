//! `apps/sheets/src/main/csv-import-limit.ts`.

use crate::packages::xlsx_gateway::CSV_IMPORT_DEFAULT_LIMIT_MB;

/// The module state of csv-import-limit.ts (`let limitBytes`): the ceiling a
/// delimited import (a .csv/.tsv opened as a workbook) may reach.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DelimitedImportLimit {
    limit_bytes: f64,
}

impl Default for DelimitedImportLimit {
    fn default() -> Self {
        DelimitedImportLimit {
            limit_bytes: CSV_IMPORT_DEFAULT_LIMIT_MB * 1024.0 * 1024.0,
        }
    }
}

impl DelimitedImportLimit {
    pub fn new() -> Self {
        Self::default()
    }

    /// `delimitedImportLimit()`: the ceiling, in bytes
    pub fn delimited_import_limit(&self) -> f64 {
        self.limit_bytes
    }

    /// `setDelimitedImportLimit(bytes)`: a value that is not a whole, positive
    /// number of bytes is refused. `None` is anything that is not a number.
    pub fn set_delimited_import_limit(&mut self, bytes: Option<f64>) {
        let Some(bytes) = bytes else { return };
        // `Number.isInteger`
        if !(bytes.is_finite() && bytes.fract() == 0.0) || bytes <= 0.0 {
            return;
        }
        self.limit_bytes = bytes;
    }
}
