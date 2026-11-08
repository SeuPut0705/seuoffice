/**
 * The AI page-reading job (spec §7) on the job engine: one call per page not
 * yet in the store. Pages that share a fingerprint (identical content) are
 * read once. What a call sends and how its answer is checked belongs to the
 * caller's `callModel`; `createAiReadCallModel` (../ai-read) builds one that
 * sends the page image, re-asks a malformed answer once and then fails the
 * page with a JobUnitFailure.
 */
import type { AiReadPayload } from '../store/store'
import type { DocumentJobStore } from './engine'
import {
  startDocumentJob,
  type DocumentJobEstimate,
  type DocumentJobHandle,
  type JobModelChoice,
  type StartDocumentJobOptions,
} from './job'

export interface AiReadPageRef {
  /** 1-based page number */
  page: number
  pageFingerprint: string
}

/** one call: a page fingerprint and the pages that have it (usually one) */
export interface AiReadJobUnit<P extends AiReadPageRef = AiReadPageRef> {
  pageFingerprint: string
  pages: P[]
}

export interface AiReadJobInput<P extends AiReadPageRef> {
  docHash: string
  /** the pages the user confirmed */
  pages: readonly P[]
  model: JobModelChoice
  store: Pick<DocumentJobStore, 'readAiReadPages' | 'writeAiReadPage' | 'writeJob'>
}

export interface AiReadJobPlan<P extends AiReadPageRef> {
  estimate: DocumentJobEstimate
  /** units still to read, in page order */
  units: AiReadJobUnit<P>[]
}

export async function planAiReadJob<P extends AiReadPageRef>(
  input: Omit<AiReadJobInput<P>, 'store'> & {
    store: Pick<DocumentJobStore, 'readAiReadPages'>
  },
): Promise<AiReadJobPlan<P>> {
  const stored = await input.store.readAiReadPages(input.docHash)
  const groups = new Map<string, P[]>()
  for (const p of input.pages) {
    const group = groups.get(p.pageFingerprint)
    if (group) group.push(p)
    else groups.set(p.pageFingerprint, [p])
  }
  const units: AiReadJobUnit<P>[] = []
  let done = 0
  for (const [pageFingerprint, pages] of groups) {
    if (stored.has(pageFingerprint)) done += pages.length
    else units.push({ pageFingerprint, pages })
  }
  return {
    units,
    estimate: {
      kind: 'ai-read',
      calls: units.length,
      pending: input.pages.length - done,
      done,
      total: input.pages.length,
      model: { ...input.model },
      providerChange: null,
    },
  }
}

/** the pre-start confirmation data: calls, pages already read */
export async function estimateAiReadJob<P extends AiReadPageRef>(
  input: Omit<AiReadJobInput<P>, 'store'> & {
    store: Pick<DocumentJobStore, 'readAiReadPages'>
  },
): Promise<DocumentJobEstimate> {
  return (await planAiReadJob(input)).estimate
}

export interface StartAiReadJobOptions<P extends AiReadPageRef>
  extends AiReadJobInput<P>, StartDocumentJobOptions<AiReadJobUnit<P>> {
  /** read one page; throw JobUnitFailure for an answer that stays unusable */
  callModel: (unit: AiReadJobUnit<P>, signal: AbortSignal) => Promise<AiReadPayload>
}

/** start reading; throws DocumentJobBusyError when the document has a job */
export function startAiReadJob<P extends AiReadPageRef>(
  o: StartAiReadJobOptions<P>,
): DocumentJobHandle<AiReadJobUnit<P>> {
  return startDocumentJob<AiReadJobUnit<P>, AiReadPayload>({ ...o, kind: 'ai-read' }, async () => {
    const { units, estimate } = await planAiReadJob(o)
    return {
      store: o.store,
      units,
      unitSize: (u) => u.pages.length,
      doneBefore: estimate.done,
      total: estimate.total,
      callModel: o.callModel,
      persist: (unit, payload) =>
        o.store.writeAiReadPage(o.docHash, unit.pageFingerprint, payload, {
          provider: o.model.provider,
          model: o.model.model,
        }),
    }
  })
}
