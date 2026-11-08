/**
 * The AI highlight job (reading-assist spec 4.6, 5.3) on the job engine:
 * kind 'highlight', its record keyed by the run id. The run's record (preset,
 * labels, the pages the person chose, provider) is written before anything
 * is sent, so a stopped run can be resumed with the same choices. Blocks
 * already in the run (any status) are skipped; the rest are cut into batches
 * of about 2,500 tokens, one call per batch, and each batch's blocks are
 * stored together once its answer is checked.
 *
 * Blocks are the translation units of the tree with the same keys
 * (store/keys.ts), so a page range keeps or drops whole pages without
 * changing them. The engine never starts by itself: the caller runs it after
 * the user pressed Start on the confirmation.
 */
import type { JobRecordInput } from '../store/store'
import type { HighlightBlockEntry, HighlightBlockInput, HighlightRun } from '../store/reading'
import { blockKeyString, translationBlockKeys, type TranslationBlockKey } from '../store/keys'
import { JobUnitFailure } from '../jobs/errors'
import {
  startDocumentJob,
  type DocumentJobEstimate,
  type DocumentJobHandle,
  type StartDocumentJobOptions,
} from '../jobs/job'
import { runsText } from '../tree/inline'
import type { TextUnit } from '../tree/derive'
import type { DocumentTree } from '../tree/types'
import { translationUnits } from '../translate/result'
import { batchHighlightItems } from './batch'
import { createHighlightModelCall, type HighlightBatchResult, type HighlightSend } from './call'

/** a block to mark: a tree text unit or anything with its runs and page */
export type HighlightSourceBlock = Pick<TextUnit, 'runs' | 'pageFingerprint' | 'page'>

export interface HighlightJobItem<B> {
  block: B
  /** the block's key in the store (the translation block key) */
  key: TranslationBlockKey
  /** the block's plain text, as sent */
  text: string
}

/** the result-store methods the job uses; ResultStore satisfies it */
export interface HighlightJobStore {
  writeJob(docHash: string, job: JobRecordInput): Promise<void>
  writeHighlightRun(docHash: string, run: HighlightRun): Promise<void>
  readHighlightBlocks(docHash: string, runId: string): Promise<Map<string, HighlightBlockEntry>>
  writeHighlightBlocks(
    docHash: string,
    runId: string,
    blocks: readonly HighlightBlockInput[],
  ): Promise<void>
}

export interface HighlightJobInput<B extends HighlightSourceBlock> {
  docHash: string
  /** the run: its id, preset, labels, chosen pages and the provider it sends to */
  run: HighlightRun
  /** every block of the confirmed page range, in reading order */
  blocks: readonly B[]
  /** cut the pending items into batches (each non-empty, all items once, in order) */
  batch: (items: readonly HighlightJobItem<B>[]) => HighlightJobItem<B>[][]
  store: HighlightJobStore
}

export interface HighlightJobPlan<B> {
  estimate: DocumentJobEstimate
  batches: HighlightJobItem<B>[][]
}

type PlanInput<B extends HighlightSourceBlock> = Omit<HighlightJobInput<B>, 'store'> & {
  store: Pick<HighlightJobStore, 'readHighlightBlocks'>
}

export async function planHighlightJob<B extends HighlightSourceBlock>(
  input: PlanInput<B>,
): Promise<HighlightJobPlan<B>> {
  const keys = translationBlockKeys(input.blocks)
  const stored = await input.store.readHighlightBlocks(input.docHash, input.run.runId)
  const pending: HighlightJobItem<B>[] = []
  input.blocks.forEach((block, i) => {
    const key = keys[i]!
    if (!stored.has(blockKeyString(key))) pending.push({ block, key, text: runsText(block.runs) })
  })
  const batches = pending.length > 0 ? input.batch(pending) : []
  const batched = batches.reduce((n, b) => n + b.length, 0)
  if (batches.some((b) => b.length === 0) || batched !== pending.length) {
    throw new TypeError('highlight job: the batches must hold every pending block once')
  }
  return {
    batches,
    estimate: {
      kind: 'highlight',
      runId: input.run.runId,
      calls: batches.length,
      pending: pending.length,
      done: input.blocks.length - pending.length,
      total: input.blocks.length,
      model: { provider: input.run.provider, model: input.run.model },
      providerChange: null,
    },
  }
}

/** the pre-start confirmation data: calls, blocks already done */
export async function estimateHighlightJob<B extends HighlightSourceBlock>(
  input: PlanInput<B>,
): Promise<DocumentJobEstimate> {
  return (await planHighlightJob(input)).estimate
}

/** what one stored batch added (the report after the run) */
export interface HighlightStoredCounts {
  /** answer entries */
  received: number
  /** entries dropped by the check */
  dropped: number
  /** suggestions stored */
  suggestions: number
}

export interface StartHighlightJobOptions<B extends HighlightSourceBlock>
  extends HighlightJobInput<B>, StartDocumentJobOptions<HighlightJobItem<B>[]> {
  /** mark one batch: one entry per block, in order */
  callModel: (batch: HighlightJobItem<B>[], signal: AbortSignal) => Promise<HighlightBatchResult>
  /** told after each batch is stored */
  onStored?: (counts: HighlightStoredCounts) => void
}

const isBatchResult = (r: unknown, size: number): r is HighlightBatchResult => {
  if (typeof r !== 'object' || r === null) return false
  const v = r as Partial<HighlightBatchResult>
  return (
    Array.isArray(v.blocks) &&
    v.blocks.length === size &&
    v.blocks.every((b) => Array.isArray(b?.suggestions)) &&
    typeof v.received === 'number' &&
    typeof v.dropped === 'number'
  )
}

/** start the run; throws DocumentJobBusyError when the document has a job */
export function startHighlightJob<B extends HighlightSourceBlock>(
  o: StartHighlightJobOptions<B>,
): DocumentJobHandle<HighlightJobItem<B>[]> {
  type Batch = HighlightJobItem<B>[]
  return startDocumentJob<Batch, HighlightBatchResult>(
    { ...o, kind: 'highlight', runId: o.run.runId },
    async (signal) => {
      // the run's choices first: a stopped run is resumed with them
      if (!signal.aborted) await o.store.writeHighlightRun(o.docHash, o.run)
      const { batches, estimate } = await planHighlightJob(o)
      return {
        store: o.store,
        units: batches,
        unitSize: (batch) => batch.length,
        doneBefore: estimate.done,
        total: estimate.total,
        callModel: async (batch, callSignal) => {
          const result = await o.callModel(batch, callSignal)
          if (!isBatchResult(result, batch.length)) throw new JobUnitFailure('result-mismatch')
          return result
        },
        persist: async (batch, result) => {
          const blocks: HighlightBlockInput[] = batch.map((item, i) => ({
            key: item.key,
            status: 'done',
            suggestions: result.blocks[i]!.suggestions.map((s, k) => ({
              id: `s${k + 1}`,
              labelId: s.labelId,
              quote: s.quote,
              state: 'pending',
            })),
          }))
          await o.store.writeHighlightBlocks(o.docHash, o.run.runId, blocks)
          o.onStored?.({
            received: result.received,
            dropped: result.dropped,
            suggestions: blocks.reduce((n, b) => n + b.suggestions.length, 0),
          })
        },
      }
    },
  )
}

export interface HighlightJobPartsOptions {
  labels: HighlightRun['labels']
  send: HighlightSend
  /** original page numbers to mark; default every page of the tree */
  pages?: Iterable<number>
  /** token budget per batch; default HIGHLIGHT_BATCH_TOKENS */
  maxTokens?: number
  /** resends of an unreadable answer; default HIGHLIGHT_MAX_RESENDS */
  maxResends?: number
}

/** the blocks of a tree an AI highlight run looks at (the translation units) */
export function highlightUnits(tree: DocumentTree, pages?: Iterable<number>): TextUnit[] {
  return translationUnits(tree, pages ? { pages } : {})
}

/** the tree-specific options of startHighlightJob / estimateHighlightJob */
export function highlightJobParts(
  tree: DocumentTree,
  o: HighlightJobPartsOptions,
): Pick<StartHighlightJobOptions<TextUnit>, 'blocks' | 'batch' | 'callModel'> {
  return {
    blocks: highlightUnits(tree, o.pages),
    batch: (items) =>
      batchHighlightItems(items, o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
    callModel: createHighlightModelCall<HighlightJobItem<TextUnit>>({
      labels: o.labels,
      send: o.send,
      ...(o.maxResends !== undefined ? { maxResends: o.maxResends } : {}),
    }),
  }
}
