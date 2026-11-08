/**
 * Translated PDF (spec §8): the translation written back into a
 * copy of the source PDF, block by block, in the blocks' own boxes.
 * Electron-free: the caller hands in PDFium, the font subsetter wasm and,
 * for scanned pages, the OCR engine.
 */
export { writeTranslatedPdf } from './write'
export { defaultWritebackFontLocator } from './font'
export {
  DEFAULT_LINE_HEIGHT,
  MIN_FONT_SCALE,
  WritebackEncryptedError,
  type HbSubsetWasm,
  type OriginalPage,
  type OriginalPageReason,
  type WritebackFontLocator,
  type WritebackOptions,
  type WritebackOverflow,
  type WritebackReport,
  type WritebackResult,
  type WritebackSkipReason,
  type WritebackSkippedBlock,
} from './types'
