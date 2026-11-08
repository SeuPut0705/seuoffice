/**
 * AI highlights (reading-assist spec 4.6): the request, the answer check
 * (only sentences that are really in their block), the run id, the batches
 * and the job on the document job engine. Environment-free; the store and the
 * model call are passed in.
 */
export { HIGHLIGHT_RUN_ID_LENGTH, highlightRunId, normalizeLabelName } from './run-id'
export {
  buildHighlightRequest,
  highlightSystemPrompt,
  parseHighlightOutput,
  type HighlightAnswerItem,
  type HighlightLabelRef,
  type HighlightRequest,
  type HighlightRequestBlock,
} from './prompt'
export {
  checkHighlightAnswer,
  normalizeWhitespace,
  quoteInBlock,
  type CheckedSuggestion,
  type HighlightCheck,
} from './check'
export { HIGHLIGHT_BATCH_TOKENS, batchHighlightItems, type HighlightBatchOptions } from './batch'
export {
  HIGHLIGHT_MAX_RESENDS,
  createHighlightModelCall,
  type HighlightBatchResult,
  type HighlightModelCallOptions,
  type HighlightModelRequest,
  type HighlightSend,
} from './call'
export {
  estimateHighlightJob,
  highlightJobParts,
  highlightUnits,
  planHighlightJob,
  startHighlightJob,
  type HighlightJobInput,
  type HighlightJobItem,
  type HighlightJobPartsOptions,
  type HighlightJobPlan,
  type HighlightJobStore,
  type HighlightSourceBlock,
  type HighlightStoredCounts,
  type StartHighlightJobOptions,
} from './job'
