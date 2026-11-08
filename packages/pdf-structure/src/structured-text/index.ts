/** Structured text for the AI read path (spec §2): document tree → per-page text. */
export {
  FIGURE_MARKER,
  FOOTNOTES_LABEL,
  TOC_LABEL,
  formatStructuredPage,
  pageImageNote,
  treeToStructuredText,
  type StructuredPageInput,
  type StructuredTextPage,
} from './format'
export { aiReadPayloadText } from './ai-payload'
