/**
 * The seam between a PDF tab's document job and the shell's result store
 * across an in-app save: the renderer job (DocumentJobSession, the engine,
 * createIpcJobStore) writes through the real store handlers into a real
 * ResultStore on a temp folder. Only the model call and the utility process
 * (page fingerprints) are fakes; nothing reaches a provider.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentJobRegistry,
  startAiReadJob,
  type AiReadJobUnit,
  type AiReadPageRef,
} from '../../../packages/pdf-structure/src/jobs'
import {
  ResultStore,
  documentHashOfFile,
  type AiReadPayload,
} from '../../../packages/pdf-structure/src/store'
import { createIpcJobStore, type JobStoreApi } from '../../pdf/src/renderer/doc-jobs/ipc-store'
import {
  DocumentJobSession,
  type DocumentJobView,
} from '../../pdf/src/renderer/doc-jobs/job-session'
import type { JobStatus } from '../../../packages/pdf-structure/src/store/store'
import { createPdfStructureHandlers, type CallContext } from '../src/main/pdf-structure/handlers'

const OWNER = 7
const PAGES: AiReadPageRef[] = [
  { page: 1, pageFingerprint: 'a'.repeat(64) },
  { page: 2, pageFingerprint: 'b'.repeat(64) },
]

let dir: string
let pdfPath: string
let store: ResultStore
/** the store's clock runs ahead of the wall clock by this much */
let skew: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf-job-save-seam-'))
  pdfPath = join(dir, 'book.pdf')
  writeFileSync(pdfPath, '%PDF-1.4 before the save\n%%EOF\n')
  skew = 0
  store = new ResultStore(join(dir, 'userData'), { now: () => Date.now() + skew })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ctx: CallContext = { owner: OWNER, progress: () => {} }

function shell() {
  return createPdfStructureHandlers({
    runner: {
      // the utility process reads the saved file's page fingerprints
      run: async (_owner, _jobId, job) =>
        job.op === 'fingerprints'
          ? {
              ok: true,
              value: {
                docHash: await documentHashOfFile(pdfPath),
                fingerprints: PAGES.map((p) => p.pageFingerprint),
              },
            }
          : { ok: false, error: 'failed', message: 'unexpected job' },
      cancel: () => false,
      cancelOwner: () => 0,
    },
    store: () => store,
    isGranted: (owner, path) => owner === OWNER && path === pdfPath,
    pickPath: async () => null,
    hashFile: documentHashOfFile,
    caseInsensitivePaths: process.platform === 'win32',
  })
}

/** the tab's store channels (window.pdfApi.store) bound straight to the handlers */
function channels(h: ReturnType<typeof shell>): JobStoreApi {
  return {
    aiReadPages: (docHash) => h.storeAiReadPages(OWNER, docHash),
    translation: (docHash, lang) => h.storeTranslation(OWNER, docHash, lang),
    write: (request) => h.storeWrite(OWNER, request),
  }
}

/** model calls the test answers one by one */
function fakeModel() {
  const pending: Array<{ resolve: (p: AiReadPayload) => void; reject: (e: unknown) => void }> = []
  return {
    pending,
    call: (_unit: AiReadJobUnit<AiReadPageRef>, signal: AbortSignal) =>
      new Promise<AiReadPayload>((resolve, reject) => {
        pending.push({ resolve, reject })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function hashOf(h: ReturnType<typeof shell>): Promise<string> {
  const out = await h.storeDocHash(OWNER, pdfPath)
  if (!out.ok) throw new Error('no document hash')
  return out.docHash
}

/** the in-app save: new bytes, then the tab carries the store over (afterSave / onEnd) */
async function carry(h: ReturnType<typeof shell>, session: DocumentJobSession, from: string) {
  const out = await h.storeMigrate(ctx, { path: pdfPath, oldDocHash: from })
  if (!out.ok) throw new Error(`migration failed: ${out.error}`)
  session.adopt(from, out.docHash)
  return out.docHash
}

/** start the tab's AI page reading on `docHash`; resolves the ended view through `ended` */
function startJob(
  h: ReturnType<typeof shell>,
  session: DocumentJobSession,
  docHash: string,
  model: ReturnType<typeof fakeModel>,
) {
  let ended!: (view: DocumentJobView) => void
  const end = new Promise<DocumentJobView>((resolve) => {
    ended = resolve
  })
  const outcome = session.start<AiReadJobUnit<AiReadPageRef>>({
    docHash,
    kind: 'ai-read',
    provider: 'claude-code',
    launch: ({ signal, registry, onProgress }) =>
      startAiReadJob({
        docHash,
        pages: PAGES,
        model: { provider: 'claude-code', model: 'fake' },
        store: createIpcJobStore(channels(h)),
        callModel: model.call,
        concurrency: 1,
        signal,
        registry,
        onProgress,
      }),
    onEnd: ended,
  })
  return { outcome, end }
}

/** what the resume offer of a newly opened file would list (AiPageReading's filter) */
const offered = (jobs: JobStatus[]) => jobs.filter((j) => j.state === 'stopped')

/** run a job on the file, save while its second page is in flight */
async function jobAcrossSave() {
  const h = shell()
  const session = new DocumentJobSession(new DocumentJobRegistry())
  const model = fakeModel()
  const before = await hashOf(h)
  const { outcome, end } = startJob(h, session, before, model)
  expect(outcome.ok).toBe(true)
  await until(() => model.pending.length === 1, 'the first call')
  model.pending[0]!.resolve({ version: 1 })
  await until(() => model.pending.length === 2, 'the second call')

  writeFileSync(pdfPath, '%PDF-1.4 after the save\n%%EOF\n')
  const after = await carry(h, session, before)
  expect(after).not.toBe(before)
  // the save carried the job as running
  const atSave = await h.storeUnfinishedJobs(OWNER, after)
  expect(atSave).toMatchObject({ ok: true, jobs: [{ kind: 'ai-read', state: 'running' }] })
  return { h, session, model, before, after, end }
}

describe('a document job across an in-app save', () => {
  it('a job that completes after the save leaves nothing unfinished in the saved file', async () => {
    const { h, session, model, before, after, end } = await jobAcrossSave()
    model.pending[1]!.resolve({ version: 1 })
    expect((await end).state).toBe('complete')
    // the job ended under the old hash: its tab carries the results over again
    await carry(h, session, before)

    expect(await h.storeUnfinishedJobs(OWNER, after)).toEqual({ ok: true, jobs: [] })
    // still nothing once a stale 'running' copy would read as interrupted
    skew += 60_000
    const later = await h.storeUnfinishedJobs(OWNER, after)
    expect(later).toEqual({ ok: true, jobs: [] })
    expect(await store.readJob(after, 'ai-read')).toMatchObject({
      state: 'complete',
      progress: { done: 2, total: 2 },
    })
    expect(await h.storeAiReadPages(OWNER, after)).toMatchObject({
      pages: [
        { pageFingerprint: PAGES[0]!.pageFingerprint },
        { pageFingerprint: PAGES[1]!.pageFingerprint },
      ],
    })
    expect(later.ok && offered(later.jobs)).toEqual([])
  })

  it('a job that stops on a rate limit after the save shows as stopped with its progress', async () => {
    const { h, session, model, before, after, end } = await jobAcrossSave()
    const resetsAt = Date.now() + 3_600_000
    model.pending[1]!.reject({ kind: 'rate-limit', resetsAt, message: 'limit' })
    expect((await end).state).toBe('stopped')
    await carry(h, session, before)

    skew += 60_000
    const unfinished = await h.storeUnfinishedJobs(OWNER, after)
    expect(unfinished).toMatchObject({
      ok: true,
      jobs: [
        {
          kind: 'ai-read',
          state: 'stopped',
          last_error: 'rate-limit',
          resetsAt,
          progress: { done: 1, total: 2 },
        },
      ],
    })
    expect(unfinished.ok && offered(unfinished.jobs)).toHaveLength(1)
  })

  it('a second start right after the save is not refused by its own copy', async () => {
    const { h, session, model, after, end } = await jobAcrossSave()
    model.pending[1]!.resolve({ version: 1 })
    expect((await end).state).toBe('complete')
    // the tab's carry after the job ended has not landed yet: the saved file
    // still holds the 'running' copy the save made
    const records = await h.storeUnfinishedJobs(OWNER, after)
    expect(records).toMatchObject({ ok: true, jobs: [{ state: 'running' }] })
    if (!records.ok) return
    expect(session.running(after)).toBeNull()
    expect(session.runningElsewhere(after, records.jobs)).toBeUndefined()
    // another window does not own that copy and keeps refusing until it goes stale
    const otherTab = new DocumentJobSession(new DocumentJobRegistry())
    expect(otherTab.runningElsewhere(after, records.jobs)).toMatchObject({ state: 'running' })

    // so the tab starts again on the saved file, and that job runs to the end
    const again = fakeModel()
    const second = startJob(h, session, after, again)
    expect(second.outcome.ok).toBe(true)
    await until(() => again.pending.length === 1, 'the second job to send')
    again.pending[0]!.resolve({ version: 1 })
    expect((await second.end).state).toBe('complete')
  })

  it('a job another process starts on the saved file after the carry is still refused', async () => {
    const { h, session, model, after, end } = await jobAcrossSave()
    model.pending[1]!.resolve({ version: 1 })
    await end
    // the terminal starts reading the saved file: its record is newer than the carry
    skew += 1_000
    await store.writeJob(after, {
      kind: 'ai-read',
      state: 'running',
      progress: { done: 0, total: 9 },
    })
    const records = await h.storeUnfinishedJobs(OWNER, after)
    if (!records.ok) throw new Error('no records')
    expect(session.runningElsewhere(after, records.jobs)).toMatchObject({
      state: 'running',
      progress: { done: 0, total: 9 },
    })
  })
})
