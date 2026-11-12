// Public API of the ODT bridge. The engine is the Rust crate crates/odt-engine
// (through the wasm, engine.ts); this package keeps the names and types its
// importers use.
//
// - `odtToDocx`: a received ODT → the bridge docx the Word editor opens, the
//   bridge map to save with, and what saving it as docx would change.
// - `saveOdt`: the edited docx written back into the received ODT (narrow
//   patches; untouched parts keep their bytes; no edit → the original bytes).
// - `docxToOdt`: a whole docx → a new ODT (no original), with its report.
// - `odtToText`: the plain text of an ODT for AI attachments.
export const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text'

export {
  OdtEncryptedError,
  OdtNotTextError,
  OdtOpenError,
  isOdtOpenError,
  type OdtOpenErrorCode,
} from './errors'
export {
  OBJECT_KINDS,
  REPORT_FEATURES,
  type BridgeMap,
  type ConversionReport,
  type DocxToOdtOptions,
  type DocxToOdtResult,
  type JsonValue,
  type ObjectKind,
  type ObjectPlaceholder,
  type ObjectsExt,
  type OdtToDocxResult,
  type ProtectedCellRef,
  type RenderedObject,
  type ReportFeature,
  type ReportItem,
  type SaveOdtInput,
} from './types'
export {
  docxToOdt,
  isProtectedCell,
  odtToDocx,
  odtToText,
  parseKeepName,
  protectedCellsOf,
  saveOdt,
} from './engine'
