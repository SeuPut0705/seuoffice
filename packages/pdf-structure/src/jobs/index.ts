/**
 * Document jobs (spec §9): AI page reading and translation on one engine.
 * Environment-free; the result store is passed in.
 */
export {
  JOB_CONCURRENCY,
  JOB_HEARTBEAT_MS,
  JOB_MAX_CONSECUTIVE_FAILURES,
  JOB_RETRY_DELAY_MS,
  runJobUnits,
  type DocumentJobStore,
  type JobFailedUnit,
  type JobProgressEvent,
  type JobSummary,
  type JobTuning,
  type RunJobUnitsOptions,
} from './engine'
export {
  DocumentJobBusyError,
  JOB_STOP_KINDS,
  JobUnitFailure,
  classifyRunError,
  isJobStopKind,
  type ClassifiedRunError,
  type RunningDocumentJob,
} from './errors'
export {
  DocumentJobRegistry,
  documentJobs,
  type DocumentJobLease,
  type JobCancelReason,
} from './lock'
export {
  startDocumentJob,
  type DocumentJobEstimate,
  type DocumentJobHandle,
  type JobModelChoice,
  type PlannedJob,
  type ProviderChange,
  type StartDocumentJobOptions,
} from './job'
export {
  estimateAiReadJob,
  planAiReadJob,
  startAiReadJob,
  type AiReadJobInput,
  type AiReadJobPlan,
  type AiReadJobUnit,
  type AiReadPageRef,
  type StartAiReadJobOptions,
} from './ai-read'
export {
  estimateTranslationJob,
  planTranslationJob,
  startTranslationJob,
  type StartTranslationJobOptions,
  type TranslationBlockResult,
  type TranslationJobInput,
  type TranslationJobItem,
  type TranslationJobPlan,
  type TranslationSourceBlock,
} from './translate'
