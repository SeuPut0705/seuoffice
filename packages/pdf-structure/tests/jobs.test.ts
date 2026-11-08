/**
 * Document job engine (spec §9): estimate, concurrency, retry and failure
 * counting, rate-limit and blocked stops, cancel, resume, provider change,
 * one job per document, job records and heartbeats, persist-before-count.
 * Model calls are fakes; nothing here reaches a real AI program.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JOB_CONCURRENCY,
  JOB_MAX_CONSECUTIVE_FAILURES,
  JOB_STOP_KINDS,
  DocumentJobBusyError,
  DocumentJobRegistry,
  JobUnitFailure,
  classifyRunError,
  estimateAiReadJob,
  estimateTranslationJob,
  runJobUnits,
  startAiReadJob,
  startTranslationJob,
  type DocumentJobStore,
  type JobProgressEvent,
  type TranslationBlockResult,
  type TranslationJobItem,
} from '../src/jobs'
import {
  ResultStore,
  blockKeyString,
  translationBlockKeys,
  type AiReadPageEntry,
  type AiReadPayload,
  type JobRecordInput,
  type StoredTranslation,
  type TranslationBlockEntry,
  type TranslationBlockInput,
  type TranslationMetaInput,
} from '../src/store'
import { sha256Hex } from '../src/tree'
import type { InlineRun } from '../src/tree'

// ── fakes ──

/** an error shaped like ai-provider's AiRunError */
class FakeRunError extends Error {
  constructor(
    readonly kind: string,
    readonly resetsAt?: number,
  ) {
    super(`run failed: ${kind}`)
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** never resolves; rejects when the signal aborts */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms))

/** the store contract the engine uses, in memory, with an event log */
class MemoryStore implements DocumentJobStore {
  readonly aiRead = new Map<string, Map<string, AiReadPageEntry>>()
  readonly translations = new Map<
    string,
    { meta: TranslationMetaInput | null; blocks: Map<string, TranslationBlockEntry> }
  >()
  readonly jobs: { docHash: string; record: JobRecordInput }[] = []
  /** 'ai-read:<fp>', 'block:<key>', 'meta:<lang>', 'job:<state>', 'delete:<lang>' */
  readonly log: string[] = []
  failDataWrites = false
  failJobWrites = false
  writeDelayMs = 0

  async writeJob(docHash: string, job: JobRecordInput): Promise<void> {
    if (this.failJobWrites) throw new Error('disk full')
    this.jobs.push({ docHash, record: structuredClone(job) })
    this.log.push(`job:${job.state}`)
  }

  async readAiReadPages(docHash: string): Promise<Map<string, AiReadPageEntry>> {
    return new Map(this.aiRead.get(docHash) ?? [])
  }

  async writeAiReadPage(
    docHash: string,
    pageFp: string,
    payload: AiReadPayload,
    meta: { provider?: string; model?: string } = {},
  ): Promise<void> {
    if (this.writeDelayMs > 0) await tick(this.writeDelayMs)
    if (this.failDataWrites) throw new Error('disk full')
    let doc = this.aiRead.get(docHash)
    if (!doc) this.aiRead.set(docHash, (doc = new Map()))
    doc.set(pageFp, { pageFingerprint: pageFp, payload, ...meta, savedAt: 1 })
    this.log.push(`ai-read:${pageFp}`)
  }

  private tr(docHash: string, lang: string) {
    const id = `${docHash}/${lang}`
    let t = this.translations.get(id)
    if (!t) this.translations.set(id, (t = { meta: null, blocks: new Map() }))
    return t
  }

  async readTranslation(docHash: string, lang: string): Promise<StoredTranslation | null> {
    const t = this.translations.get(`${docHash}/${lang}`)
    if (!t) return null
    return {
      lang,
      provider: t.meta?.provider ?? null,
      model: t.meta?.model ?? null,
      blocks: new Map(t.blocks),
    }
  }

  async writeTranslationMeta(
    docHash: string,
    lang: string,
    meta: TranslationMetaInput,
  ): Promise<void> {
    if (this.failDataWrites) throw new Error('disk full')
    this.tr(docHash, lang).meta = { ...meta }
    this.log.push(`meta:${lang}`)
  }

  async writeTranslationBlocks(
    docHash: string,
    lang: string,
    blocks: readonly TranslationBlockInput[],
  ): Promise<void> {
    if (this.writeDelayMs > 0) await tick(this.writeDelayMs)
    if (this.failDataWrites) throw new Error('disk full')
    const t = this.tr(docHash, lang)
    for (const b of blocks) {
      t.blocks.set(blockKeyString(b.key), { ...b, savedAt: 1 })
      this.log.push(`block:${blockKeyString(b.key)}`)
    }
  }

  async deleteTranslation(docHash: string, lang: string): Promise<void> {
    this.translations.delete(`${docHash}/${lang}`)
    this.log.push(`delete:${lang}`)
  }

  recordsOf(docHash: string): JobRecordInput[] {
    return this.jobs.filter((j) => j.docHash === docHash).map((j) => j.record)
  }
}

// ── fixtures ──

let docCounter = 0
/** a fresh document hash per test keeps the shared lock registry out of the way */
const newDoc = () => sha256Hex(`doc-${++docCounter}-${Math.random()}`)
const fp = (n: number) => sha256Hex(`page-${n}`)
const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ page: i + 1, pageFingerprint: fp(i + 1) }))
const payload = (n: number): AiReadPayload => ({ version: 1, markdown: `page ${n}` })
const CLAUDE = { provider: 'claude-code', model: 'opus' }
const CODEX = { provider: 'codex', model: 'gpt-5' }
/** no waiting between a failed attempt and its retry */
const FAST = { retryDelayMs: 0 }

const t = (text: string): InlineRun[] => [{ kind: 'text', text }]
function blocks(n: number, perPage = 2) {
  return Array.from({ length: n }, (_, i) => {
    const page = Math.floor(i / perPage) + 1
    return { runs: t(`block ${i}`), page, pageFingerprint: fp(page), id: `b${i}` }
  })
}
type Block = ReturnType<typeof blocks>[number]
/** fixed-size batches in reading order */
const batchesOf =
  (size: number) =>
  <B>(items: readonly TranslationJobItem<B>[]): TranslationJobItem<B>[][] => {
    const out: TranslationJobItem<B>[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
  }
const translated = (items: readonly TranslationJobItem<Block>[]): TranslationBlockResult[] =>
  items.map((it) => ({ status: 'translated', text: `T(${it.block.id})` }))

// ── generic runner ──

describe('runJobUnits', () => {
  it('defaults to 2 calls at a time and never exceeds the cap', async () => {
    expect(JOB_CONCURRENCY).toBe(2)
    for (const cap of [undefined, 1, 3]) {
      const store = new MemoryStore()
      let inFlight = 0
      let peak = 0
      const summary = await runJobUnits({
        docHash: newDoc(),
        kind: 'ai-read',
        store,
        units: Array.from({ length: 7 }, (_, i) => i),
        concurrency: cap,
        ...FAST,
        callModel: async (u) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await tick(5)
          inFlight--
          return u
        },
        persist: async () => {},
      })
      expect(summary.state).toBe('complete')
      expect(peak).toBe(cap ?? 2)
    }
  })

  it('retries a run error once; a second failure marks the unit failed and the job goes on', async () => {
    const store = new MemoryStore()
    const calls: number[] = []
    const summary = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store,
      units: [0, 1, 2, 3],
      concurrency: 1,
      ...FAST,
      callModel: async (u) => {
        calls.push(u)
        const attempt = calls.filter((c) => c === u).length
        if (u === 1) throw new FakeRunError('timeout') // fails both times
        if (u === 2 && attempt === 1) throw new FakeRunError('network') // recovers on retry
        return u
      },
      persist: async () => {},
    })
    expect(calls).toEqual([0, 1, 1, 2, 2, 3])
    expect(summary.state).toBe('complete')
    expect(summary.doneUnits).toEqual([0, 2, 3])
    expect(summary.failedUnits).toEqual([{ unit: 1, reason: 'timeout' }])
    expect(summary.progress).toEqual({ done: 3, total: 4 })
  })

  it('an error without a kind (empty answer, bug) is retried like a run error', async () => {
    let calls = 0
    const summary = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store: new MemoryStore(),
      units: [0],
      ...FAST,
      callModel: async () => {
        calls++
        if (calls === 1) throw new Error('empty answer')
        return 0
      },
      persist: async () => {},
    })
    expect(calls).toBe(2)
    expect(summary.doneUnits).toEqual([0])
  })

  it('a unit failure from the caller is not retried and does not count toward the stop', async () => {
    const calls: number[] = []
    const summary = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store: new MemoryStore(),
      units: [0, 1, 2, 3, 4],
      concurrency: 1,
      ...FAST,
      callModel: async (u) => {
        calls.push(u)
        throw new JobUnitFailure('malformed')
      },
      persist: async () => {},
    })
    expect(calls).toEqual([0, 1, 2, 3, 4])
    expect(summary.state).toBe('complete')
    expect(summary.failedUnits.map((f) => f.reason)).toEqual(Array(5).fill('malformed'))
  })

  it('stops after 3 consecutive failed units (tunable); a success resets the count', async () => {
    expect(JOB_MAX_CONSECUTIVE_FAILURES).toBe(3)
    const store = new MemoryStore()
    const docHash = newDoc()
    const calls: number[] = []
    const summary = await runJobUnits({
      docHash,
      kind: 'ai-read',
      store,
      units: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      concurrency: 1,
      ...FAST,
      callModel: async (u) => {
        calls.push(u)
        if (u === 2) return u // breaks the first streak
        throw new FakeRunError('overloaded')
      },
      persist: async () => {},
    })
    // 0,1 fail (2 each), 2 succeeds, 3,4,5 fail -> stop; 6.. never sent
    expect(calls).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5])
    expect(summary.state).toBe('stopped')
    expect(summary.stopReason).toBe('failures')
    expect(summary.failedUnits.map((f) => f.unit)).toEqual([0, 1, 3, 4, 5])
    expect(store.recordsOf(docHash).at(-1)).toMatchObject({
      state: 'stopped',
      last_error: 'failures',
      progress: { done: 1, total: 10 },
    })

    const tuned = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store,
      units: [0, 1, 2, 3],
      concurrency: 1,
      maxConsecutiveFailures: 1,
      ...FAST,
      callModel: async () => {
        throw new FakeRunError('timeout')
      },
      persist: async () => {},
    })
    expect(tuned.stopReason).toBe('failures')
    expect(tuned.failedUnits).toHaveLength(1)
  })

  it('rate-limit stops at once: no retry, no new unit, in-flight calls aborted, resetsAt passed on', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const resetsAt = Date.UTC(2026, 9, 14, 18)
    const signals: AbortSignal[] = []
    const first = deferred<number>()
    const summary = runJobUnits({
      docHash,
      kind: 'ai-read',
      store,
      units: [0, 1, 2, 3, 4, 5],
      ...FAST,
      callModel: (u, signal) => {
        signals.push(signal)
        return u === 0 ? first.promise : untilAborted(signal)
      },
      persist: async () => {},
    })
    await tick()
    expect(signals).toHaveLength(2)
    first.reject(new FakeRunError('rate-limit', resetsAt))
    const s = await summary
    expect(signals).toHaveLength(2) // nothing sent after the rate limit, and no retry
    expect(signals[1]!.aborted).toBe(true)
    expect(s).toMatchObject({ state: 'stopped', stopReason: 'rate-limit', resetsAt })
    expect(s.failedUnits).toEqual([])
    expect(store.recordsOf(docHash).at(-1)).toMatchObject({
      state: 'stopped',
      last_error: 'rate-limit',
      resetsAt,
      progress: { done: 0, total: 6 },
    })
  })

  it('rate-limit on a retry attempt also stops at once', async () => {
    let calls = 0
    const s = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store: new MemoryStore(),
      units: [0, 1, 2],
      concurrency: 1,
      ...FAST,
      callModel: async () => {
        calls++
        throw new FakeRunError(calls === 1 ? 'timeout' : 'rate-limit')
      },
      persist: async () => {},
    })
    expect(calls).toBe(2)
    expect(s.stopReason).toBe('rate-limit')
    expect(s.resetsAt).toBeUndefined()
  })

  it('every blocked kind stops at once with its own error code', async () => {
    const blocked = [
      'signed-out',
      'not-installed',
      'needs-update',
      'metered-not-accepted',
      'unsafe-tools',
      'not-connected',
      // the person declined a prompt close to the model's window: asking the next batch would ignore that
      'context-limit',
    ]
    for (const kind of blocked) expect(JOB_STOP_KINDS).toContain(kind)
    for (const kind of blocked) {
      const store = new MemoryStore()
      const docHash = newDoc()
      let calls = 0
      const s = await runJobUnits({
        docHash,
        kind: 'translate',
        lang: 'en',
        store,
        units: [0, 1, 2],
        concurrency: 1,
        ...FAST,
        callModel: async () => {
          calls++
          throw new FakeRunError(kind)
        },
        persist: async () => {},
      })
      expect(calls).toBe(1)
      expect(s).toMatchObject({ state: 'stopped', stopReason: kind })
      expect(store.recordsOf(docHash).at(-1)).toMatchObject({
        kind: 'translate',
        lang: 'en',
        state: 'stopped',
        last_error: kind,
      })
    }
  })

  it('classifies errors by kind or errorCode and carries resetsAt', () => {
    expect(classifyRunError(new FakeRunError('rate-limit', 5))).toMatchObject({
      kind: 'rate-limit',
      resetsAt: 5,
    })
    expect(classifyRunError({ errorCode: 'network', errorResetsAt: 7 })).toMatchObject({
      kind: 'network',
      resetsAt: 7,
    })
    expect(classifyRunError(new Error('boom'))).toEqual({ message: 'boom' })
    expect(classifyRunError('x')).toEqual({ message: 'x' })
  })

  it('cancel: the signal stops the job, aborts in-flight calls and sends nothing more', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const ac = new AbortController()
    const signals: AbortSignal[] = []
    const run = runJobUnits({
      docHash,
      kind: 'ai-read',
      store,
      units: [0, 1, 2, 3],
      signal: ac.signal,
      ...FAST,
      callModel: (u, signal) => {
        signals.push(signal)
        return untilAborted(signal)
      },
      persist: async () => {},
    })
    await tick()
    ac.abort()
    const s = await run
    expect(signals).toHaveLength(2)
    expect(signals.every((x) => x.aborted)).toBe(true)
    expect(s).toMatchObject({ state: 'stopped', stopReason: 'cancelled', failedUnits: [] })
    expect(store.recordsOf(docHash).at(-1)).toMatchObject({
      state: 'stopped',
      last_error: 'cancelled',
    })
  })

  it('an already-aborted signal sends nothing', async () => {
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    const s = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store: new MemoryStore(),
      units: [0, 1],
      signal: ac.signal,
      callModel: async (u) => {
        calls++
        return u
      },
      persist: async () => {},
    })
    expect(calls).toBe(0)
    expect(s.stopReason).toBe('cancelled')
  })

  it('a call that ignores the abort does not hold the job, and its late result is dropped', async () => {
    const ac = new AbortController()
    const late = deferred<number>()
    const persisted: number[] = []
    const run = runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store: new MemoryStore(),
      units: [0],
      signal: ac.signal,
      callModel: () => late.promise,
      persist: async (u) => {
        persisted.push(u)
      },
    })
    await tick()
    ac.abort()
    const s = await run
    late.resolve(0)
    await tick()
    expect(s.stopReason).toBe('cancelled')
    expect(persisted).toEqual([])
  })

  it('persists each result before it counts as done', async () => {
    const store = new MemoryStore()
    store.writeDelayMs = 3
    const persisted = new Set<number>()
    const events: JobProgressEvent<number>[] = []
    const s = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store,
      units: [0, 1, 2, 3],
      doneBefore: 2,
      ...FAST,
      callModel: async (u) => u,
      persist: async (u) => {
        await tick(3)
        persisted.add(u)
      },
      onProgress: (e) => {
        events.push(e)
        // every unit counted as done is already in the store
        expect(persisted.size).toBe(e.done - 2)
      },
    })
    expect(s.progress).toEqual({ done: 6, total: 6 })
    expect(s.skippedItems).toBe(2)
    expect(events[0]).toMatchObject({ done: 2, total: 6, current: 0 })
    expect(events.at(-1)).toMatchObject({ done: 6, total: 6 })
  })

  it('a store write failure stops the job and reports the lost result', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    let calls = 0
    const s = await runJobUnits({
      docHash,
      kind: 'ai-read',
      store,
      units: [0, 1, 2],
      concurrency: 1,
      ...FAST,
      callModel: async (u) => {
        calls++
        return u
      },
      persist: async (u) => {
        if (u === 1) throw new Error('ENOSPC')
      },
    })
    expect(calls).toBe(2)
    expect(s).toMatchObject({ state: 'stopped', stopReason: 'store-write-failed', lostUnits: [1] })
    expect(store.recordsOf(docHash).at(-1)).toMatchObject({ last_error: 'store-write-failed' })
  })

  it('a job record that cannot be written at start stops before any call', async () => {
    const store = new MemoryStore()
    store.failJobWrites = true
    let calls = 0
    const s = await runJobUnits({
      docHash: newDoc(),
      kind: 'ai-read',
      store,
      units: [0],
      callModel: async (u) => {
        calls++
        return u
      },
      persist: async () => {},
    })
    expect(calls).toBe(0)
    expect(s).toMatchObject({ state: 'stopped', stopReason: 'store-write-failed' })
    expect(s.recordWriteFailed).toBe(true)
  })

  it('writes the job record at start, as a heartbeat while running, and at the end', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const s = await runJobUnits({
      docHash,
      kind: 'translate',
      lang: 'ja',
      store,
      units: [0, 1],
      concurrency: 1,
      heartbeatMs: 10,
      ...FAST,
      callModel: async (u) => {
        await tick(60)
        return u
      },
      persist: async () => {},
    })
    expect(s.state).toBe('complete')
    const records = store.recordsOf(docHash)
    expect(records[0]).toEqual({
      kind: 'translate',
      lang: 'ja',
      state: 'running',
      progress: { done: 0, total: 2 },
    })
    const running = records.filter((r) => r.state === 'running')
    expect(running.length).toBeGreaterThanOrEqual(3) // start + heartbeats
    expect(running.some((r) => r.progress?.done === 1)).toBe(true) // heartbeats carry progress
    expect(records.at(-1)).toEqual({
      kind: 'translate',
      lang: 'ja',
      state: 'complete',
      progress: { done: 2, total: 2 },
    })
    // nothing is written after the final record
    const count = records.length
    await tick(40)
    expect(store.recordsOf(docHash)).toHaveLength(count)
  })

  it('the heartbeat interval stays inside the running window', async () => {
    const { JOB_HEARTBEAT_MS } = await import('../src/jobs')
    expect(JOB_HEARTBEAT_MS).toBeLessThan(30_000)
  })
})

// ── AI page reading ──

describe('AI page reading job', () => {
  it('estimate: calls are the pages not yet read; read pages are counted as skipped', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    await store.writeAiReadPage(docHash, fp(2), payload(2))
    await store.writeAiReadPage(docHash, fp(4), payload(4))
    const est = await estimateAiReadJob({ docHash, pages: pages(5), model: CLAUDE, store })
    expect(est).toMatchObject({
      kind: 'ai-read',
      calls: 3,
      pending: 3,
      done: 2,
      total: 5,
      model: CLAUDE,
      providerChange: null,
    })
  })

  it('pages sharing a fingerprint are read once', async () => {
    const store = new MemoryStore()
    const same = [
      { page: 1, pageFingerprint: fp(1) },
      { page: 2, pageFingerprint: fp(1) },
      { page: 3, pageFingerprint: fp(3) },
    ]
    const est = await estimateAiReadJob({ docHash: newDoc(), pages: same, model: CLAUDE, store })
    expect(est).toMatchObject({ calls: 2, pending: 3, total: 3 })
  })

  it('runs, persists each page with provider and model, then resume skips what is done', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const sent: number[] = []
    const first = startAiReadJob({
      docHash,
      pages: pages(5),
      model: CLAUDE,
      store,
      concurrency: 1,
      ...FAST,
      callModel: async (unit) => {
        const n = unit.pages[0]!.page
        sent.push(n)
        if (n === 3) throw new FakeRunError('rate-limit', 99)
        return payload(n)
      },
    })
    const s1 = await first.result
    expect(s1).toMatchObject({ state: 'stopped', stopReason: 'rate-limit', resetsAt: 99 })
    expect(sent).toEqual([1, 2, 3])
    expect(store.aiRead.get(docHash)?.get(fp(1))).toMatchObject({
      provider: 'claude-code',
      model: 'opus',
    })

    sent.length = 0
    const second = startAiReadJob({
      docHash,
      pages: pages(5),
      model: CLAUDE,
      store,
      ...FAST,
      callModel: async (unit) => {
        sent.push(unit.pages[0]!.page)
        return payload(unit.pages[0]!.page)
      },
    })
    const s2 = await second.result
    expect(sent.sort()).toEqual([3, 4, 5])
    expect(s2).toMatchObject({
      state: 'complete',
      skippedItems: 2,
      progress: { done: 5, total: 5 },
    })
    expect(store.recordsOf(docHash).at(-1)).toMatchObject({ kind: 'ai-read', state: 'complete' })
  })

  it('progress events carry the page being read', async () => {
    const events: JobProgressEvent<{ pages: { page: number }[] }>[] = []
    const job = startAiReadJob({
      docHash: newDoc(),
      pages: pages(2),
      model: CLAUDE,
      store: new MemoryStore(),
      concurrency: 1,
      callModel: async (unit) => payload(unit.pages[0]!.page),
      onProgress: (e) => events.push(e),
    })
    await job.result
    expect(events.map((e) => [e.done, e.total, e.current?.pages[0]?.page ?? null])).toEqual([
      [0, 2, 1],
      [1, 2, null],
      [1, 2, 2],
      [2, 2, null],
    ])
  })
})

// ── translation ──

describe('translation job', () => {
  it('estimate: done blocks are skipped and the rest batched; calls = batches', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const bs = blocks(10)
    const keys = translationBlockKeys(bs)
    await store.writeTranslationMeta(docHash, 'en', CLAUDE)
    await store.writeTranslationBlocks(docHash, 'en', [
      { key: keys[0]!, status: 'translated', text: 'x' },
      { key: keys[1]!, status: 'failed', reason: 'placeholders' },
      { key: keys[5]!, status: 'translated', text: 'y' },
    ])
    const est = await estimateTranslationJob({
      docHash,
      lang: 'en',
      blocks: bs,
      batch: batchesOf(3),
      model: CLAUDE,
      store,
    })
    // 7 pending blocks in batches of 3 -> 3 calls
    expect(est).toMatchObject({
      kind: 'translate',
      lang: 'en',
      calls: 3,
      pending: 7,
      done: 3,
      total: 10,
    })
    expect(est.providerChange).toBeNull()

    const restart = await estimateTranslationJob({
      docHash,
      lang: 'en',
      blocks: bs,
      batch: batchesOf(3),
      model: CLAUDE,
      store,
      restart: true,
    })
    expect(restart).toMatchObject({ calls: 4, pending: 10, done: 0 })
  })

  it('flags a provider or model different from the stored translation', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const bs = blocks(4)
    const base = { docHash, lang: 'de', blocks: bs, batch: batchesOf(2), store }

    expect((await estimateTranslationJob({ ...base, model: CLAUDE })).providerChange).toBeNull()

    const keys = translationBlockKeys(bs)
    await store.writeTranslationMeta(docHash, 'de', CODEX)
    await store.writeTranslationBlocks(docHash, 'de', [
      { key: keys[0]!, status: 'translated', text: 'x' },
    ])
    expect((await estimateTranslationJob({ ...base, model: CODEX })).providerChange).toBeNull()
    expect((await estimateTranslationJob({ ...base, model: CLAUDE })).providerChange).toEqual({
      stored: CODEX,
      next: CLAUDE,
    })
    const otherModel = { provider: 'codex', model: 'gpt-5-mini' }
    expect((await estimateTranslationJob({ ...base, model: otherModel })).providerChange).toEqual({
      stored: CODEX,
      next: otherModel,
    })
    // restarting replaces the stored translation: nothing to warn about
    expect(
      (await estimateTranslationJob({ ...base, model: CLAUDE, restart: true })).providerChange,
    ).toBeNull()
  })

  it('persists blocks (translated and failed) with the provider recorded before the first block', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const bs = blocks(5)
    const job = startTranslationJob({
      docHash,
      lang: 'fr',
      blocks: bs,
      batch: batchesOf(2),
      model: CODEX,
      store,
      concurrency: 1,
      ...FAST,
      callModel: async (items) =>
        items.map((it) =>
          it.block.id === 'b3'
            ? { status: 'failed', reason: 'placeholders' }
            : { status: 'translated', text: `T(${it.block.id})` },
        ),
    })
    const s = await job.result
    expect(s).toMatchObject({ state: 'complete', progress: { done: 5, total: 5 } })
    expect(s.doneUnits.map((u) => u.length)).toEqual([2, 2, 1])
    const firstData = store.log.findIndex((e) => e.startsWith('block:'))
    expect(store.log.indexOf('meta:fr')).toBeGreaterThan(-1)
    expect(store.log.indexOf('meta:fr')).toBeLessThan(firstData)
    const stored = await store.readTranslation(docHash, 'fr')
    expect(stored).toMatchObject({ provider: 'codex', model: 'gpt-5' })
    expect(stored!.blocks.size).toBe(5)
    const k3 = blockKeyString(translationBlockKeys(bs)[3]!)
    expect(stored!.blocks.get(k3)).toMatchObject({ status: 'failed', reason: 'placeholders' })
  })

  it('a result list that does not match its batch fails that batch without storing it', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const s = await startTranslationJob({
      docHash,
      lang: 'fr',
      blocks: blocks(2),
      batch: batchesOf(2),
      model: CODEX,
      store,
      ...FAST,
      callModel: async () => [{ status: 'translated', text: 'only one' }],
    }).result
    expect(s.failedUnits).toHaveLength(1)
    expect(s.failedUnits[0]!.reason).toBe('result-mismatch')
    expect(store.log.some((e) => e.startsWith('block:'))).toBe(false)
  })

  it('restart deletes the stored translation and sends every block', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const bs = blocks(4)
    const keys = translationBlockKeys(bs)
    await store.writeTranslationMeta(docHash, 'en', CODEX)
    await store.writeTranslationBlocks(docHash, 'en', [
      { key: keys[0]!, status: 'translated', text: 'old' },
    ])
    let sent = 0
    const s = await startTranslationJob({
      docHash,
      lang: 'en',
      blocks: bs,
      batch: batchesOf(2),
      model: CLAUDE,
      store,
      restart: true,
      callModel: async (items) => {
        sent += items.length
        return translated(items)
      },
    }).result
    expect(sent).toBe(4)
    expect(s.skippedItems).toBe(0)
    expect(store.log).toContain('delete:en')
    expect((await store.readTranslation(docHash, 'en'))?.provider).toBe('claude-code')
  })

  it('resumes on the real result store: only blocks not yet stored are sent again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pdf-jobs-'))
    try {
      const store = new ResultStore(root)
      const docHash = newDoc()
      const bs = blocks(8)
      const sentFirst: string[] = []
      const s1 = await startTranslationJob({
        docHash,
        lang: 'ko',
        blocks: bs,
        batch: batchesOf(2),
        model: CLAUDE,
        store,
        concurrency: 1,
        ...FAST,
        callModel: async (items) => {
          sentFirst.push(...items.map((i) => i.block.id))
          if (items[0]!.block.id === 'b4') throw new FakeRunError('rate-limit', 1234)
          return translated(items)
        },
      }).result
      expect(s1).toMatchObject({ state: 'stopped', stopReason: 'rate-limit', resetsAt: 1234 })
      expect(sentFirst).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5'])
      const job = await store.readJob(docHash, 'translate', 'ko')
      expect(job).toMatchObject({
        state: 'stopped',
        last_error: 'rate-limit',
        resetsAt: 1234,
        progress: { done: 4, total: 8 },
      })

      const est = await estimateTranslationJob({
        docHash,
        lang: 'ko',
        blocks: bs,
        batch: batchesOf(2),
        model: CODEX,
        store,
      })
      expect(est).toMatchObject({ calls: 2, pending: 4, done: 4 })
      expect(est.providerChange).toEqual({ stored: CLAUDE, next: CODEX })

      const sentSecond: string[] = []
      const s2 = await startTranslationJob({
        docHash,
        lang: 'ko',
        blocks: bs,
        batch: batchesOf(2),
        model: CLAUDE,
        store,
        ...FAST,
        callModel: async (items) => {
          sentSecond.push(...items.map((i) => i.block.id))
          return translated(items)
        },
      }).result
      expect(sentSecond.sort()).toEqual(['b4', 'b5', 'b6', 'b7'])
      expect(s2).toMatchObject({ state: 'complete', progress: { done: 8, total: 8 } })
      expect((await store.readTranslation(docHash, 'ko'))!.blocks.size).toBe(8)
      expect(await store.readJob(docHash, 'translate', 'ko')).toMatchObject({ state: 'complete' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── one job per document ──

describe('one job per document', () => {
  let registry: DocumentJobRegistry
  beforeEach(() => {
    registry = new DocumentJobRegistry()
  })
  afterEach(() => {
    for (const docHash of registry.documents()) registry.cancel(docHash)
  })

  it('a second start on the same document is rejected with the running job and its progress', async () => {
    const store = new MemoryStore()
    const docHash = newDoc()
    const gate = deferred<void>()
    const first = startAiReadJob({
      docHash,
      pages: pages(3),
      model: CLAUDE,
      store,
      registry,
      concurrency: 1,
      callModel: async (unit) => {
        if (unit.pages[0]!.page === 2) await gate.promise
        return payload(unit.pages[0]!.page)
      },
    })
    await tick(5)
    let calls = 0
    const tryStart = () =>
      startTranslationJob({
        docHash,
        lang: 'en',
        blocks: blocks(2),
        batch: batchesOf(2),
        model: CLAUDE,
        store,
        registry,
        callModel: async (items) => {
          calls++
          return translated(items)
        },
      })
    let err: unknown
    try {
      tryStart()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DocumentJobBusyError)
    expect((err as DocumentJobBusyError).running).toMatchObject({
      docHash,
      kind: 'ai-read',
      progress: { done: 1, total: 3 },
    })
    expect(registry.running(docHash)).toMatchObject({ kind: 'ai-read' })
    expect(calls).toBe(0)

    // another document is not blocked
    const other = startAiReadJob({
      docHash: newDoc(),
      pages: pages(1),
      model: CLAUDE,
      store,
      registry,
      callModel: async () => payload(1),
    })
    expect((await other.result).state).toBe('complete')

    gate.resolve()
    expect((await first.result).state).toBe('complete')
    expect(registry.running(docHash)).toBeNull()
    // free again once the first job ended
    expect((await tryStart().result).state).toBe('complete')
    expect(calls).toBe(1)
  })

  it('the lock is taken before any await, so two starts in the same tick cannot both run', () => {
    const docHash = newDoc()
    const opts = {
      docHash,
      pages: pages(1),
      model: CLAUDE,
      store: new MemoryStore(),
      registry,
      callModel: async () => payload(1),
    }
    const a = startAiReadJob(opts)
    expect(() => startAiReadJob(opts)).toThrow(DocumentJobBusyError)
    return a.result
  })

  it('cancel through the handle or the registry; interrupted is kept as its own reason', async () => {
    const store = new MemoryStore()
    const run = (docHash: string) =>
      startAiReadJob({
        docHash,
        pages: pages(2),
        model: CLAUDE,
        store,
        registry,
        callModel: (_unit, signal) => untilAborted(signal),
      })
    const a = run(newDoc())
    await tick()
    a.cancel()
    expect(await a.result).toMatchObject({ state: 'stopped', stopReason: 'cancelled' })

    const docB = newDoc()
    const b = run(docB)
    await tick()
    expect(registry.cancel(docB, 'interrupted')).toBe(true)
    expect(await b.result).toMatchObject({ state: 'stopped', stopReason: 'interrupted' })
    expect(store.recordsOf(docB).at(-1)).toMatchObject({ last_error: 'interrupted' })
    expect(registry.cancel(docB)).toBe(false)
  })

  it('a job that fails while planning still releases the lock', async () => {
    const store = new MemoryStore()
    store.readAiReadPages = async () => {
      throw new Error('broken disk')
    }
    const docHash = newDoc()
    const job = startAiReadJob({
      docHash,
      pages: pages(1),
      model: CLAUDE,
      store,
      registry,
      callModel: async () => payload(1),
    })
    await expect(job.result).rejects.toThrow('broken disk')
    expect(registry.running(docHash)).toBeNull()
  })
})

describe('store contract', () => {
  it('the real ResultStore satisfies the engine store interface', () => {
    const store: DocumentJobStore = new ResultStore(join(tmpdir(), 'pdf-jobs-type-check'))
    expect(typeof store.writeJob).toBe('function')
  })
})
