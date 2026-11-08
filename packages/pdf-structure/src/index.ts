/**
 * @genoffice/pdf-structure — a reflowable document tree built on the
 * pdf2docx IR (extractIrDocument), plus the outputs and jobs that consume it.
 *
 * Pure-function package like pdf2docx: the caller owns PDFium wasm setup and
 * passes the initialized module in. Node-only parts (the result store) live
 * behind their own entry and are not exported here.
 */
export * from './tree'
export { extractEmbeddedImages, MIN_IMAGE_PX, MAX_IMAGE_TOTAL_PX } from './images'
export type { EmbeddedImage, ExtractEmbeddedImagesOptions } from './images'
export * from './markdown'
export {
  writeEpub,
  epubLanguages,
  guessLanguageFromText,
  MIN_LANGUAGE_SCORE,
  CJK_WEIGHT,
  KANA_SHARE_FOR_JA,
  LANGUAGE_SAMPLE_CHARS,
} from './epub'
export type { EpubWriteOptions, EpubLanguageOptions } from './epub'
export * from './jobs'
export * from './translate'
export * from './ai-read'
export * from './structured-text'
export * from './writeback'
export * from './highlight'
