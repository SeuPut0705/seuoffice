/**
 * The reading assistant's store channels in the shell (reading-assist spec
 * 5.1-5.5): new write kinds and reads accept only the document hash the
 * shell computed for the calling view, refuse malformed input without
 * throwing, and the page-fingerprint read uses the fingerprint job (never
 * the document tree). Job-record migration carries highlight records with
 * their run id.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ResultStore,
  documentHashOfFile,
  type HighlightRun,
  type InsightsEntry,
  type PassageCardInput,
} from '../../../packages/pdf-structure/src/store'
import { createPdfStructureHandlers, type CallContext } from '../src/main/pdf-structure/handlers'
import { migrateJobRecords } from '../src/main/pdf-structure/job-migration'
import type { StructureJob } from '../src/main/pdf-structure/protocol'
import type { JobRunOutcome } from '../src/main/pdf-structure/runner'
import type { PdfStoreWriteRequest } from '../../pdf/src/shared/ipc'

const OWNER = 7
const OTHER = 8
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)
const RUN = 'r'.repeat(40)
const KEY_A = { pageFingerprint: FP_A, textHash: 'c'.repeat(64), occurrence: 0 }

let dir: string
let pdfPath: string
let store: ResultStore
let granted: Map<number, Set<string>>
let jobs: Array<{ owner: number; jobId: string; job: StructureJob }>
let answer: (job: StructureJob) => JobRunOutcome
let now: number

const ctx = (owner = OWNER): CallContext => ({ owner, progress: () => {} })

function makeHandlers() {
  return createPdfStructureHandlers({
    runner: {
      run: async (owner, jobId, job) => {
        jobs.push({ owner, jobId, job })
        return answer(job)
      },
      cancel: () => false,
      cancelOwner: vi.fn(() => 0),
    },
    store: () => store,
    isGranted: (owner, path) => !!granted.get(owner)?.has(path),
    pickPath: async () => null,
    hashFile: documentHashOfFile,
    caseInsensitivePaths: process.platform === 'win32',
  })
}

const card = (id: string, over: Partial<PassageCardInput> = {}): PassageCardInput => ({
  id,
  kind: 'explain',
  page: 1,
  pageFingerprint: FP_A,
  quads: [[0, 0, 1, 0, 0, 1, 1, 1]],
  excerpt: 'the passage',
  passageHash: 'p'.repeat(64),
  text: 'an explanation',
  provider: 'codex',
  model: 'm',
  createdAt: 1,
  ...over,
})

const run = (runId: string, createdAt: number): HighlightRun => ({
  runId,
  presetId: 'research',
  labels: [{ id: 'l1', name: 'Claim', color: [1, 0.9, 0.2] }],
  pages: [1, 2],
  provider: 'codex',
  model: 'm',
  createdAt,
})

const insights = (lang: string): InsightsEntry => ({
  lang,
  summary3: ['one', 'two', 'three'],
  summary: 'summary',
  terms: [{ term: 't', meaning: 'm', page: 1 }],
  provider: 'codex',
  model: 'm',
  createdAt: 1,
  pageFingerprints: [FP_A],
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf-reading-store-'))
  pdfPath = join(dir, 'book.pdf')
  writeFileSync(pdfPath, '%PDF-1.4 version one\n%%EOF\n')
  now = 1_000_000
  store = new ResultStore(join(dir, 'userData'), { now: () => now })
  granted = new Map([[OWNER, new Set([pdfPath])]])
  jobs = []
  answer = () => ({ ok: false, error: 'failed', message: 'unexpected job' })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function ownHash(handlers: ReturnType<typeof makeHandlers>): Promise<string> {
  return ((await handlers.storeDocHash(OWNER, pdfPath)) as { docHash: string }).docHash
}

describe('reading store writes', () => {
  it('accept every new write kind only for the view’s own document hash', async () => {
    const handlers = makeHandlers()
    const docHash = await documentHashOfFile(pdfPath)
    const requests: PdfStoreWriteRequest[] = [
      { kind: 'passage', docHash, card: card('c1') },
      { kind: 'deletePassage', docHash, id: 'c1' },
      { kind: 'highlightRun', docHash, run: run(RUN, 1) },
      {
        kind: 'highlightBlocks',
        docHash,
        runId: RUN,
        blocks: [{ key: KEY_A, status: 'done', suggestions: [] }],
      },
      {
        kind: 'highlightSuggestionStates',
        docHash,
        runId: RUN,
        key: KEY_A,
        states: { s1: 'dismissed' },
      },
      { kind: 'deleteHighlightRun', docHash, runId: RUN },
      { kind: 'insights', docHash, entry: insights('en') },
      { kind: 'editedTranslationBlock', docHash, lang: 'en', key: KEY_A, text: 'Edited' },
      { kind: 'deleteTranslationExceptEdited', docHash, lang: 'en' },
      { kind: 'heartbeat', docHash, job: 'highlight', runId: RUN },
    ]
    // not computed for any view yet
    for (const req of requests) {
      expect(await handlers.storeWrite(OWNER, req), req.kind).toMatchObject({
        ok: false,
        error: 'not-granted',
      })
    }
    await ownHash(handlers)
    // another view did not compute it
    for (const req of requests) {
      expect(await handlers.storeWrite(OTHER, req), req.kind).toMatchObject({
        ok: false,
        error: 'not-granted',
      })
    }
    expect(await store.readPassages(docHash)).toEqual([])
    expect(await store.listHighlightRuns(docHash)).toEqual([])
  })

  it('writes, reads and deletes cards, highlight runs, insights and edited blocks', async () => {
    const handlers = makeHandlers()
    const docHash = await ownHash(handlers)

    expect(
      await handlers.storeWrite(OWNER, { kind: 'passage', docHash, card: card('c1') }),
    ).toEqual({ ok: true })
    await handlers.storeWrite(OWNER, { kind: 'passage', docHash, card: card('c2') })
    expect(await handlers.storePassages(OWNER, docHash)).toMatchObject({
      ok: true,
      cards: expect.arrayContaining([
        expect.objectContaining({ id: 'c1' }),
        expect.objectContaining({ id: 'c2' }),
      ]),
    })
    expect(await handlers.storeWrite(OWNER, { kind: 'deletePassage', docHash, id: 'c2' })).toEqual({
      ok: true,
    })
    expect(await handlers.storePassages(OWNER, docHash)).toMatchObject({
      cards: [expect.objectContaining({ id: 'c1' })],
    })

    const older = 'o'.repeat(40)
    await handlers.storeWrite(OWNER, { kind: 'highlightRun', docHash, run: run(older, 1) })
    await handlers.storeWrite(OWNER, { kind: 'highlightRun', docHash, run: run(RUN, 5) })
    await handlers.storeWrite(OWNER, {
      kind: 'highlightBlocks',
      docHash,
      runId: RUN,
      blocks: [
        {
          key: KEY_A,
          status: 'done',
          suggestions: [{ id: 's1', labelId: 'l1', quote: 'q', state: 'pending' }],
        },
      ],
    })
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'highlightSuggestionStates',
        docHash,
        runId: RUN,
        key: KEY_A,
        states: { s1: 'dismissed' },
      }),
    ).toEqual({ ok: true })
    // a block that is not there
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'highlightSuggestionStates',
        docHash,
        runId: RUN,
        key: { ...KEY_A, occurrence: 4 },
        states: { s1: 'dismissed' },
      }),
    ).toMatchObject({ ok: false })
    const runs = await handlers.storeHighlightRuns(OWNER, docHash)
    expect(runs).toMatchObject({ ok: true })
    expect((runs as { runs: HighlightRun[] }).runs.map((r) => r.runId)).toEqual([RUN, older])
    expect(await handlers.storeLatestHighlight(OWNER, docHash)).toMatchObject({
      ok: true,
      run: { runId: RUN },
      blocks: [{ key: KEY_A, suggestions: [{ id: 's1', state: 'dismissed' }] }],
    })
    expect(await handlers.storeHighlightBlocks(OWNER, docHash, older)).toEqual({
      ok: true,
      blocks: [],
    })

    // deleting a run removes its job record too
    await handlers.storeWrite(OWNER, {
      kind: 'job',
      docHash,
      job: { kind: 'highlight', runId: RUN, state: 'stopped' },
    })
    expect(
      await handlers.storeWrite(OWNER, { kind: 'deleteHighlightRun', docHash, runId: RUN }),
    ).toEqual({ ok: true })
    expect(await store.listJobs(docHash)).toEqual([])
    expect(await handlers.storeLatestHighlight(OWNER, docHash)).toMatchObject({
      run: { runId: older },
      blocks: [],
    })

    expect(
      await handlers.storeWrite(OWNER, { kind: 'insights', docHash, entry: insights('ko') }),
    ).toEqual({ ok: true })
    expect(await handlers.storeInsights(OWNER, docHash, 'ko')).toMatchObject({
      ok: true,
      insights: { lang: 'ko', summary: 'summary' },
    })
    expect(await handlers.storeInsights(OWNER, docHash, 'fr')).toEqual({
      ok: true,
      insights: null,
    })

    await handlers.storeWrite(OWNER, {
      kind: 'translationBlocks',
      docHash,
      lang: 'en',
      blocks: [
        { key: { ...KEY_A, occurrence: 1 }, status: 'translated', text: 'Machine' },
        { key: { ...KEY_A, occurrence: 2 }, status: 'translated', text: 'Machine 2' },
      ],
    })
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'editedTranslationBlock',
        docHash,
        lang: 'en',
        key: KEY_A,
        text: 'Edited',
      }),
    ).toEqual({ ok: true })
    expect(await handlers.storeDeleteCounts(OWNER, docHash)).toEqual({
      ok: true,
      editedTranslationBlocks: 1,
      passages: 1,
    })
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'deleteTranslationExceptEdited',
        docHash,
        lang: 'en',
      }),
    ).toEqual({ ok: true, removed: 2 })
    const tr = await store.readTranslation(docHash, 'en')
    expect([...tr!.blocks.values()].map((b) => b.text)).toEqual(['Edited'])
  })

  it('keys job records and heartbeats by run id for highlight jobs', async () => {
    const handlers = makeHandlers()
    const docHash = await ownHash(handlers)
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'job',
        docHash,
        job: { kind: 'highlight', runId: RUN, state: 'running', progress: { done: 1, total: 4 } },
      }),
    ).toEqual({ ok: true })
    now += 5_000
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'heartbeat',
        docHash,
        job: 'highlight',
        runId: RUN,
      }),
    ).toEqual({ ok: true })
    expect((await store.readJob(docHash, 'highlight', RUN)).updatedAt).toBe(now)
    // the wrong key finds no record
    expect(
      await handlers.storeWrite(OWNER, {
        kind: 'heartbeat',
        docHash,
        job: 'highlight',
        runId: 'x'.repeat(40),
      }),
    ).toMatchObject({ ok: false })
    expect(
      await handlers.storeWrite(OWNER, { kind: 'heartbeat', docHash, job: 'nope' } as never),
    ).toMatchObject({ ok: false, error: 'invalid-request' })
  })

  it('refuses malformed input without throwing', async () => {
    const handlers = makeHandlers()
    const docHash = await ownHash(handlers)
    const bad = [
      { kind: 'passage', docHash },
      { kind: 'passage', docHash, card: 'x' },
      { kind: 'passage', docHash, card: { ...card('c1'), id: '../evil' } },
      { kind: 'passage', docHash, card: { ...card('c1'), quads: 'nope' } },
      { kind: 'deletePassage', docHash, id: '../x' },
      { kind: 'deletePassage', docHash },
      { kind: 'highlightRun', docHash, run: { ...run(RUN, 1), labels: [] } },
      { kind: 'highlightRun', docHash, run: null },
      { kind: 'highlightBlocks', docHash, runId: RUN, blocks: 'x' },
      { kind: 'highlightBlocks', docHash, runId: '../r', blocks: [] },
      { kind: 'highlightBlocks', docHash, runId: RUN, blocks: [7] },
      { kind: 'highlightSuggestionStates', docHash, runId: RUN, key: KEY_A, states: { s: 'nope' } },
      { kind: 'highlightSuggestionStates', docHash, runId: RUN, key: KEY_A, states: [] },
      {
        kind: 'highlightSuggestionStates',
        docHash,
        runId: RUN,
        key: { ...KEY_A, occurrence: -1 },
        states: {},
      },
      { kind: 'deleteHighlightRun', docHash, runId: 5 },
      { kind: 'insights', docHash, entry: { ...insights('en'), summary3: ['a'] } },
      { kind: 'insights', docHash, entry: [] },
      { kind: 'editedTranslationBlock', docHash, lang: 'en', key: KEY_A },
      { kind: 'editedTranslationBlock', docHash, lang: 'e/n', key: KEY_A, text: 'x' },
      {
        kind: 'editedTranslationBlock',
        docHash,
        lang: 'en',
        key: { ...KEY_A, textHash: '' },
        text: 'x',
      },
      { kind: 'deleteTranslationExceptEdited', docHash, lang: '..' },
      { kind: 'job', docHash, job: { kind: 'highlight', state: 'stopped' } },
      { kind: 'heartbeat', docHash, job: 'highlight', runId: 7 },
    ]
    for (const req of bad) {
      const out = await handlers.storeWrite(OWNER, req as never)
      expect(out, JSON.stringify(req)).toMatchObject({ ok: false, error: 'invalid-request' })
    }
    expect(await store.readPassages(docHash)).toEqual([])
    expect(await store.listHighlightRuns(docHash)).toEqual([])
    expect(await store.listInsights(docHash)).toEqual([])
  })
})

describe('reading store reads', () => {
  it('accept only the view’s own document hash and check their arguments', async () => {
    const handlers = makeHandlers()
    const docHash = await documentHashOfFile(pdfPath)
    const reads = () => [
      handlers.storePassages(OWNER, docHash),
      handlers.storeHighlightRuns(OWNER, docHash),
      handlers.storeHighlightBlocks(OWNER, docHash, RUN),
      handlers.storeLatestHighlight(OWNER, docHash),
      handlers.storeInsights(OWNER, docHash, 'en'),
      handlers.storeDeleteCounts(OWNER, docHash),
      handlers.storeTranslationRecency(OWNER, docHash),
    ]
    for (const out of await Promise.all(reads())) {
      expect(out).toMatchObject({ ok: false, error: 'not-granted' })
    }
    await ownHash(handlers)
    for (const out of await Promise.all(reads())) expect(out).toMatchObject({ ok: true })
    expect(await handlers.storePassages(OTHER, docHash)).toMatchObject({ error: 'not-granted' })
    expect(await handlers.storeInsights(OWNER, docHash, '../x')).toMatchObject({
      error: 'invalid-request',
    })
    expect(await handlers.storeHighlightBlocks(OWNER, docHash, '../x')).toMatchObject({
      error: 'invalid-request',
    })
    expect(await handlers.storeDeleteCounts(OWNER, docHash)).toEqual({
      ok: true,
      editedTranslationBlocks: 0,
      passages: 0,
    })
    expect(await handlers.storeLatestHighlight(OWNER, docHash)).toEqual({
      ok: true,
      run: null,
      blocks: [],
    })
  })

  it('answers the newest block savedAt per translation language, newest first', async () => {
    const handlers = makeHandlers()
    const docHash = await ownHash(handlers)
    const block = (occurrence: number) => ({
      key: { ...KEY_A, occurrence },
      status: 'translated' as const,
      text: 't',
    })
    await store.writeTranslationBlocks(docHash, 'en', [block(0)])
    now += 100
    await store.writeTranslationBlocks(docHash, 'fr', [block(0)])
    now += 100
    await store.writeTranslationBlocks(docHash, 'en', [block(1)])
    // a language with only its provider record and no blocks
    await store.writeTranslationMeta(docHash, 'de', { provider: 'codex', model: 'm' })
    expect(await handlers.storeTranslationRecency(OWNER, docHash)).toEqual({
      ok: true,
      langs: [
        { lang: 'en', savedAt: 1_000_200 },
        { lang: 'fr', savedAt: 1_000_100 },
        { lang: 'de', savedAt: null },
      ],
    })
  })
})

describe('page fingerprints of the open file', () => {
  it('runs the fingerprint job (not the tree), answers in page order and caches per file bytes', async () => {
    const handlers = makeHandlers()
    let docHash = await documentHashOfFile(pdfPath)
    answer = (job) =>
      job.op === 'fingerprints'
        ? { ok: true, value: { docHash, fingerprints: [FP_B, FP_A] } }
        : { ok: false, error: 'failed' }
    expect(await handlers.storePageFingerprints(ctx(), { path: pdfPath })).toEqual({
      ok: true,
      docHash,
      fingerprints: [FP_B, FP_A],
    })
    expect(jobs.map((j) => j.job)).toEqual([{ op: 'fingerprints', source: { pdfPath } }])
    // the hash it answered is now this view's
    expect(await handlers.storePassages(OWNER, docHash)).toMatchObject({ ok: true })

    // same bytes: no second job
    expect(await handlers.storePageFingerprints(ctx(), { path: pdfPath })).toMatchObject({
      fingerprints: [FP_B, FP_A],
    })
    expect(jobs).toHaveLength(1)

    // the file changed: a new job
    writeFileSync(pdfPath, '%PDF-1.4 saved\n%%EOF\n')
    docHash = await documentHashOfFile(pdfPath)
    answer = () => ({ ok: true, value: { docHash, fingerprints: [FP_A] } })
    expect(await handlers.storePageFingerprints(ctx(), { path: pdfPath, password: 'pw' })).toEqual({
      ok: true,
      docHash,
      fingerprints: [FP_A],
    })
    expect(jobs.at(-1)!.job).toEqual({
      op: 'fingerprints',
      source: { pdfPath, password: 'pw' },
    })
    expect(jobs.every((j) => j.job.op === 'fingerprints')).toBe(true)
  })

  it('refuses a file not granted to the view and passes job failures on', async () => {
    const handlers = makeHandlers()
    expect(
      await handlers.storePageFingerprints(ctx(), { path: join(dir, 'other.pdf') }),
    ).toMatchObject({ ok: false, error: 'not-granted' })
    expect(await handlers.storePageFingerprints(ctx(OTHER), { path: pdfPath })).toMatchObject({
      ok: false,
      error: 'not-granted',
    })
    expect(await handlers.storePageFingerprints(ctx(), null as never)).toMatchObject({
      ok: false,
      error: 'invalid-request',
    })
    expect(jobs).toEqual([])
    answer = () => ({ ok: false, error: 'password-required' })
    expect(await handlers.storePageFingerprints(ctx(), { path: pdfPath })).toMatchObject({
      ok: false,
      error: 'password-required',
    })
  })
})

describe('migrateJobRecords and the reading assistant', () => {
  const oldHash = '1'.repeat(64)
  const newHash = '2'.repeat(64)

  it('moves highlight records with their run id, and every kind by the same rule', async () => {
    const other = 'q'.repeat(40)
    await store.writeJob(oldHash, {
      kind: 'highlight',
      runId: RUN,
      state: 'stopped',
      progress: { done: 2, total: 5 },
    })
    await store.writeJob(oldHash, { kind: 'highlight', runId: other, state: 'stopped' })
    await store.writeJob(oldHash, { kind: 'translate-page', lang: 'en', state: 'stopped' })
    await store.writeJob(oldHash, { kind: 'summary', lang: 'ko', state: 'complete' })
    now += 10
    // a newer record of one run is already in the new document
    await store.writeJob(newHash, { kind: 'highlight', runId: other, state: 'complete' })
    expect(await migrateJobRecords(store, oldHash, newHash)).toBe(3)
    expect(await store.readJob(newHash, 'highlight', RUN)).toMatchObject({
      kind: 'highlight',
      runId: RUN,
      state: 'stopped',
      progress: { done: 2, total: 5 },
    })
    expect((await store.readJob(newHash, 'highlight', other)).state).toBe('complete')
    expect((await store.readJob(newHash, 'translate-page', 'en')).state).toBe('stopped')
    expect((await store.readJob(newHash, 'summary', 'ko')).state).toBe('complete')
    // running again moves nothing
    expect(await migrateJobRecords(store, oldHash, newHash)).toBe(0)
  })
})
