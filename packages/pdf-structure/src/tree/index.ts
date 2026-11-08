/** Document tree module: types, extraction, and helpers other modules share. */
export * from './types'
export {
  extractDocumentTree,
  PageRangeError,
  type ExtractTreeOptions,
  type ExtractTreeResult,
  type PageFingerprint,
} from './extract'
export { buildDocumentTree, type BuildTreeInput } from './build'
export { tableFromSpans, type SpanCellInput } from './tables'
export { isCaptionText } from './captions'
export { runsText } from './inline'
export {
  deriveBilingualTree,
  deriveTranslatedTree,
  textUnits,
  type TextUnit,
  type Translations,
} from './derive'
export { sha256Hex } from './hash'
