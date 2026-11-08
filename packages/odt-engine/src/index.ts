// Public API of the ODT bridge. Only the assembling task writes this file; the
// feature modules (core, text, table, objects, page) are imported relatively.
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
} from './core/errors'
export type { BridgeMap, JsonValue } from './core/convert'
export {
  type ConversionReport,
  REPORT_FEATURES,
  type ReportFeature,
  type ReportItem,
} from './assemble/report'
export { type OdtToDocxResult, type SaveOdtInput, odtToDocx, saveOdt } from './assemble/odt'
export { odtToText } from './assemble/text'
export {
  type DocxToOdtOptions,
  type DocxToOdtResult,
  type RenderedObject,
  docxToOdt,
} from './assemble/export'
export { isProtectedCell, protectedCellsOf, type ProtectedCellRef } from './table'
export {
  OBJECT_KINDS,
  parseKeepName,
  type ObjectKind,
  type ObjectPlaceholder,
  type ObjectsExt,
} from './objects'
