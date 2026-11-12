//! The public API of the ODT bridge (`src/index.ts`) as Rust functions.
//!
//! - `odt_to_docx`: a received ODT to the bridge docx the Word editor opens,
//!   the bridge map to save with, and what saving it as docx would change.
//! - `save_odt`: the edited docx written back into the received ODT (narrow
//!   patches; untouched parts keep their bytes; no edit: the original bytes).
//! - `docx_to_odt`: a whole docx to a new ODT (no original), with its report.
//! - `odt_to_text`: the plain text of an ODT for AI attachments.

pub mod export;
pub mod meta;
pub mod odt;
pub mod registry;
pub mod report;
pub mod text;
pub mod zip;

/// `ODT_MIMETYPE`
pub const ODT_MIMETYPE: &str = "application/vnd.oasis.opendocument.text";

pub use export::{DocxToOdtResult, RenderedObject, docx_to_odt};
pub use odt::{OdtToDocxResult, Replacement, SavedOdt, odt_to_docx, repack_odt, save_odt};
pub use report::{
    ConversionReport, REPORT_FEATURES, ReportFeature, ReportItem, ReportKind, odt_to_docx_report,
};
pub use text::odt_to_text;

// `OdtEncryptedError`, `OdtNotTextError`, `OdtOpenError`, `isOdtOpenError`,
// `OdtOpenErrorCode`, `BridgeMap` and `JsonValue` are the core layer's:
pub use crate::core::{BridgeMap, JsonValue, OdtError, OdtOpenErrorCode, is_odt_open_error};
// `isProtectedCell`, `protectedCellsOf`, `ProtectedCellRef` (table) and
// `OBJECT_KINDS`, `parseKeepName`, `ObjectKind`, `ObjectPlaceholder`,
// `ObjectsExt` (objects):
pub use crate::objects::{ObjectKind, ObjectPlaceholder, ObjectsExt};
pub use crate::table::{ProtectedCellRef, is_protected_cell, protected_cells_of};
