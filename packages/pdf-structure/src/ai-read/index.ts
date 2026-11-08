/**
 * AI page reading (spec §7): the reading instruction and request, answer
 * parsing and checks, the repetition filter, the store payload, merging
 * readings into the document tree, the page picker's preselection and the
 * vision check. Environment-free; the caller renders pages and sends calls.
 */
export {
  AI_READ_CLOSE_TAG,
  AI_READ_EMPTY_PAGE,
  AI_READ_FOOTNOTES_LINE,
  AI_READ_INSTRUCTION,
  AI_READ_OPEN_TAG,
  base64Encode,
  buildAiReadRequest,
  type AiReadRequest,
  type BuildAiReadRequestInput,
} from './instruction'
export {
  AI_READ_PAYLOAD_VERSION,
  materializeReading,
  type AiContentBlock,
  type AiContentCaption,
  type AiContentFootnote,
  type AiPageContent,
  type AiPageReading,
  type AiReadBlock,
  type AiReadPagePayload,
} from './content'
export { parseAiInline } from './inline'
export { AI_READ_MAX_SPAN, parseHtmlTable } from './table'
export {
  AI_READ_REPETITION,
  filterRepetitions,
  findRepetitionLoop,
  type AiReadRepetitionTuning,
} from './repetition'
export {
  parseAiPageContent,
  parseAiPageResponse,
  type AiReadProblem,
  type ParseAiPageOptions,
  type ParseAiPageResult,
} from './parse'
export { aiReadPayload, aiReadingFromPayload, readAiReadPayload } from './payload'
export {
  AI_READ_MALFORMED_REASON,
  createAiReadCallModel,
  readAiPage,
  type AiReadAsk,
  type AiReadCallModelOptions,
  type AiReadRenderedPage,
  type ReadAiPageOptions,
} from './read-page'
export { applyStoredAiReadings, mergeAiReadPages } from './merge'
export {
  aiReadPreselectPages,
  type AiReadPreselectPage,
  type AiReadPreselectReason,
} from './preselect'
export { aiReadVisionCheck, type AiReadVisionCheck } from './vision'
