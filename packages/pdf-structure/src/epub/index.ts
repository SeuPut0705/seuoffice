/** EPUB writer: document tree → EPUB 3 bytes (spec §5). */
export { writeEpub, type EpubWriteOptions } from './write'
export {
  CJK_WEIGHT,
  epubLanguages,
  guessLanguageFromText,
  KANA_SHARE_FOR_JA,
  LANGUAGE_SAMPLE_CHARS,
  MIN_LANGUAGE_SCORE,
  type EpubLanguageOptions,
} from './language'
