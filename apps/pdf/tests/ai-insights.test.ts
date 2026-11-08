/**
 * The document overview, below the screen (reading-assist spec 4.8, 5.2, 5.5,
 * 10.9): what is sent and how it is split (one call up to the limit, else a
 * `summary` job of batches and a merge), the answer checks, the store round
 * trip with the fingerprints of the pages sent, and the two cases after a
 * save changed the document hash. The store and structure channels are fakes;
 * "sending" is a call to a fake model.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentStreamRequest } from '@genoffice/agent-core'
import { DocumentJobRegistry } from '../../../packages/pdf-structure/src/jobs'
import {
  AI_READ_CLOSE_TAG,
  AI_READ_OPEN_TAG,
  aiReadPayload,
  parseAiPageResponse,
} from '../../../packages/pdf-structure/src/ai-read'
import type { InsightsEntry } from '../../../packages/pdf-structure/src/store/reading'
import type { AiReadPayload } from '../../../packages/pdf-structure/src/store/store'
import type { DocumentTree } from '../../../packages/pdf-structure/src/tree/types'
import type { PdfStoreWriteRequest } from '../src/shared/ipc'
import { DocumentJobSession } from '../src/renderer/doc-jobs/job-session'
import {
  DocumentInsights,
  InsightsAnswerError,
  insightsStillMatch,
  type InsightsStoreApi,
  type InsightsStructureApi,
} from '../src/renderer/ai/insights/insights-controller'
import {
  INSIGHTS_LIMITS,
  parseInsightsAnswer,
  parsePartialAnswer,
} from '../src/renderer/ai/insights/insights-prompt'
import {
  INSIGHTS_SINGLE_CALL_MAX_CHARS,
  insightsPages,
  planInsights,
} from '../src/renderer/ai/insights/insights-text'

const DOC = 'a'.repeat(64)
const SAVED = 'b'.repeat(64)
const PATH = 'C:\\docs\\report.pdf'

function treeOf(pages: string[]): DocumentTree {
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: pages.length,
    pages: pages.map((_, i) => ({
      page: i + 1,
      fingerprint: `fp${i + 1}`,
      status: 'ok',
      widthPt: 600,
      heightPt: 800,
    })),
    blocks: pages
      .map((text, i) => ({
        id: `b${i}`,
        page: i + 1,
        pageFingerprint: `fp${i + 1}`,
        source: 'pdf',
        kind: 'paragraph',
        runs: [{ kind: 'text', text }],
      }))
      .filter((b) => b.runs[0]!.text),
    footnotes: [],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [],
    warnings: [],
  } as unknown as DocumentTree
}

const ANSWER = JSON.stringify({
  summary3: ['First line.', 'Second line.', 'Third line.'],
  summary: 'Para one.\n\nPara two.',
  terms: [
    { term: 'Widget', meaning: 'The product studied.', page: 1 },
    { term: 'Gadget', meaning: 'A page the model was not given.', page: 99 },
  ],
})

const entryOf = (over: Partial<InsightsEntry> = {}): InsightsEntry => ({
  lang: 'en',
  summary3: ['a', 'b', 'c'],
  summary: 's',
  terms: [],
  provider: 'claude-code',
  model: '',
  createdAt: 1,
  pageFingerprints: ['fp1', 'fp2'],
  ...over,
})

function fakeChannels(o: {
  pages: string[]
  stored?: Map<string, InsightsEntry>
  hash?: () => string
  fingerprints?: () => string[]
  /** stored AI page readings by page fingerprint */
  aiRead?: Map<string, AiReadPayload>
}) {
  const stored = o.stored ?? new Map<string, InsightsEntry>()
  const writes: PdfStoreWriteRequest[] = []
  const hash = o.hash ?? (() => DOC)
  const store = {
    docHash: vi.fn(async () => ({ ok: true as const, docHash: hash() })),
    insights: vi.fn(async (docHash: string, lang: string) => ({
      ok: true as const,
      insights: stored.get(`${docHash}/${lang}`) ?? null,
    })),
    pageFingerprints: vi.fn(async () => ({
      ok: true as const,
      docHash: hash(),
      fingerprints: o.fingerprints?.() ?? o.pages.map((_, i) => `fp${i + 1}`),
    })),
    write: vi.fn(async (request: PdfStoreWriteRequest) => {
      writes.push(request)
      if (request.kind === 'insights') {
        stored.set(`${request.docHash}/${request.entry.lang}`, request.entry)
      }
      return { ok: true as const }
    }),
    unfinishedJobs: vi.fn(async () => ({ ok: true as const, jobs: [] })),
    aiReadPages: vi.fn(async () => ({
      ok: true as const,
      pages: [...(o.aiRead ?? new Map<string, AiReadPayload>())].map(
        ([pageFingerprint, payload]) => ({
          pageFingerprint,
          payload,
          savedAt: 1,
        }),
      ),
    })),
  } satisfies InsightsStoreApi
  const structure = {
    tree: vi.fn(async () => ({
      ok: true as const,
      docHash: hash(),
      tree: treeOf(o.pages),
      fingerprints: o.pages.map((_, i) => ({ page: i + 1, fingerprint: `fp${i + 1}` })),
      cached: false,
    })),
    cancel: vi.fn(async () => ({ ok: true as const })),
  } as unknown as InsightsStructureApi
  return { store, structure, stored, writes }
}

describe('what the overview sends', () => {
  it('heads each page with its number and skips pages without text', () => {
    const pages = insightsPages(treeOf(['Alpha text.', '', 'Gamma text.']))
    expect(pages.map((p) => p.page)).toEqual([1, 3])
    const plan = planInsights(pages)
    expect(plan.mode).toBe('single')
    if (plan.mode === 'single') {
      expect(plan.text).toContain('[page 1]\nAlpha text.')
      expect(plan.text).toContain('[page 3]\nGamma text.')
    }
  })

  it('is one call up to the limit, a summary job of batches and a merge above it', () => {
    const small = [{ page: 1, text: 'x'.repeat(100) }]
    expect(planInsights(small).mode).toBe('single')
    expect(INSIGHTS_SINGLE_CALL_MAX_CHARS).toBe(60_000)
    const big = Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: 'y'.repeat(20_000) }))
    const plan = planInsights(big)
    expect(plan.mode).toBe('job')
    if (plan.mode !== 'job') return
    expect(plan.batches.every((b) => b.text.length <= INSIGHTS_SINGLE_CALL_MAX_CHARS)).toBe(true)
    expect(plan.batches.flatMap((b) => b.pages)).toEqual([1, 2, 3, 4, 5])
    expect(plan.calls).toBe(plan.batches.length + 1)
  })

  it('cuts a page longer than a batch into pieces that each fit', () => {
    const plan = planInsights([{ page: 4, text: 'z'.repeat(250) }], 100)
    expect(plan.mode).toBe('job')
    if (plan.mode !== 'job') return
    expect(plan.batches.length).toBeGreaterThan(2)
    expect(plan.batches.every((b) => b.text.length <= 100 && b.pages[0] === 4)).toBe(true)
    expect(plan.batches[1]!.text.startsWith('[page 4, continued]')).toBe(true)
  })
})

describe('answer checks', () => {
  it('accepts the shape, cleans it and drops terms on pages not sent', () => {
    const out = parseInsightsAnswer(`Here it is:\n\`\`\`json\n${ANSWER}\n\`\`\``, [1, 2])
    expect(out?.summary3).toEqual(['First line.', 'Second line.', 'Third line.'])
    expect(out?.summary).toBe('Para one.\n\nPara two.')
    expect(out?.terms).toEqual([{ term: 'Widget', meaning: 'The product studied.', page: 1 }])
  })

  it.each([
    ['not JSON', 'I cannot do that.'],
    ['two lines', JSON.stringify({ summary3: ['a', 'b'], summary: 's', terms: [] })],
    ['four lines', JSON.stringify({ summary3: ['a', 'b', 'c', 'd'], summary: 's', terms: [] })],
    ['an empty line', JSON.stringify({ summary3: ['a', ' ', 'c'], summary: 's', terms: [] })],
    ['no summary', JSON.stringify({ summary3: ['a', 'b', 'c'], terms: [] })],
    ['terms not a list', JSON.stringify({ summary3: ['a', 'b', 'c'], summary: 's', terms: {} })],
    [
      'a term without a page',
      JSON.stringify({
        summary3: ['a', 'b', 'c'],
        summary: 's',
        terms: [{ term: 't', meaning: 'm' }],
      }),
    ],
    ['an array', JSON.stringify([{ summary3: ['a', 'b', 'c'], summary: 's' }])],
  ])('rejects %s', (_label, raw) => {
    expect(parseInsightsAnswer(raw, [1])).toBeNull()
  })

  it('caps what an answer may store', () => {
    const long = JSON.stringify({
      summary3: ['x'.repeat(5000), 'b', 'c'],
      summary: 's',
      terms: Array.from({ length: 80 }, (_, i) => ({ term: `t${i}`, meaning: 'm', page: 1 })),
    })
    const out = parseInsightsAnswer(long, [1])!
    expect(out.summary3[0].length).toBeLessThanOrEqual(INSIGHTS_LIMITS.line + 1)
    expect(out.terms).toHaveLength(INSIGHTS_LIMITS.terms)
  })

  it('checks a batch partial', () => {
    expect(parsePartialAnswer('{"summary":"part","terms":[]}', [1])).toEqual({
      summary: 'part',
      terms: [],
    })
    expect(parsePartialAnswer('{"terms":[]}', [1])).toBeNull()
  })
})

/** a fake model: answers by request kind and records every request */
function fakeModel(answer: (request: AgentStreamRequest) => string) {
  const requests: AgentStreamRequest[] = []
  const call = vi.fn(async (request: AgentStreamRequest) => {
    requests.push(request)
    return answer(request)
  })
  return { call, requests }
}

describe('the overview in the store', () => {
  it('reads the stored overview on load without sending or building the tree', async () => {
    const stored = new Map([[`${DOC}/en`, entryOf()]])
    const f = fakeChannels({ pages: ['a', 'b'], stored })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    await insights.load()
    expect(insights.snapshot().entry).toEqual(entryOf())
    expect(insights.snapshot().stale).toBe(false)
    expect(f.structure.tree).not.toHaveBeenCalled()
    expect(f.writes).toHaveLength(0)
  })

  it('makes one call for a short document and stores it with the fingerprints sent', async () => {
    const f = fakeChannels({ pages: ['Widget page.', 'Second page.'] })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
      now: () => 42,
    })
    await insights.load()
    const prepared = await insights.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.prepared.plan.mode).toBe('single')
    const model = fakeModel(() => ANSWER)
    const entry = await insights.runSingle(
      prepared.prepared,
      async (request, signal) => ({
        text: await model.call(request, signal),
        provider: 'claude-code',
        model: '',
      }),
      new AbortController().signal,
    )
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]!.tools).toEqual([])
    expect(model.requests[0]!.messages[0]!.text).toContain('[page 1]\nWidget page.')
    expect(entry).toMatchObject({
      lang: 'en',
      provider: 'claude-code',
      createdAt: 42,
      pageFingerprints: ['fp1', 'fp2'],
    })
    expect(f.writes).toEqual([{ kind: 'insights', docHash: DOC, entry }])
    // round trip: a fresh controller reads what was written
    const again = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    await again.load()
    expect(again.snapshot().entry).toEqual(entry)
  })

  it('stores nothing from a malformed answer', async () => {
    const f = fakeChannels({ pages: ['Widget page.'] })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    const prepared = await insights.prepare()
    if (!prepared.ok) throw new Error('prepare failed')
    await expect(
      insights.runSingle(
        prepared.prepared,
        async () => ({ text: '{"summary3":["only one"]}', provider: 'codex', model: '' }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(InsightsAnswerError)
    expect(f.writes).toHaveLength(0)
    expect(insights.snapshot().entry).toBeNull()
  })

  it('sends the AI reading of a page that has no text layer of its own', async () => {
    const reading = parseAiPageResponse(
      `${AI_READ_OPEN_TAG}\nScanned page read by AI.\n${AI_READ_CLOSE_TAG}`,
      { page: 2, pageFingerprint: 'fp2' },
    )
    if (!reading.ok) throw new Error(reading.problems.join(', '))
    const payload = JSON.parse(JSON.stringify(aiReadPayload(reading.reading))) as AiReadPayload
    const f = fakeChannels({ pages: ['Text page.', ''], aiRead: new Map([['fp2', payload]]) })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    const prepared = await insights.prepare()
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(f.store.aiReadPages).toHaveBeenCalledWith(DOC)
    expect(prepared.prepared.plan.pages).toEqual([1, 2])
    expect(prepared.prepared.fingerprints).toEqual(['fp1', 'fp2'])
    const plan = prepared.prepared.plan
    expect(plan.mode === 'single' && plan.text).toContain('[page 2]\nScanned page read by AI.')
  })

  it('says why nothing can be prepared', async () => {
    const empty = fakeChannels({ pages: ['', ''] })
    const insights = new DocumentInsights({
      store: empty.store,
      structure: empty.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    expect(await insights.prepare()).toEqual({ ok: false, reason: 'no-text' })
    const standalone = new DocumentInsights({
      store: null,
      structure: null,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    expect(standalone.available).toBe(false)
    expect(await standalone.prepare()).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('after a save, keeps an overview whose pages are all still there', async () => {
    let hash = DOC
    const stored = new Map([[`${DOC}/en`, entryOf()]])
    const f = fakeChannels({ pages: ['a', 'b', 'c'], stored, hash: () => hash })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    await insights.load()
    hash = SAVED
    await insights.load()
    expect(insights.snapshot()).toMatchObject({ docHash: SAVED, stale: false, entry: entryOf() })
    expect(stored.get(`${SAVED}/en`)).toEqual(entryOf())
  })

  it('after a save that changed a page it was made from, shows it as changed', async () => {
    let hash = DOC
    let fps = ['fp1', 'fp2']
    const stored = new Map([[`${DOC}/en`, entryOf()]])
    const f = fakeChannels({
      pages: ['a', 'b'],
      stored,
      hash: () => hash,
      fingerprints: () => fps,
    })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    await insights.load()
    hash = SAVED
    fps = ['fp1', 'fp2-edited']
    await insights.load()
    expect(insights.snapshot()).toMatchObject({ docHash: SAVED, stale: true, entry: entryOf() })
    expect(stored.has(`${SAVED}/en`)).toBe(false)
    expect(insightsStillMatch(entryOf(), ['fp2', 'fp1', 'fp9'])).toBe(true)
    expect(insightsStillMatch(entryOf(), ['fp1'])).toBe(false)
  })
})

describe('the summary job of a long document', () => {
  const longPages = Array.from({ length: 4 }, (_, i) => `Page ${i + 1} ${'w'.repeat(25_000)}`)

  async function setup(answer: (request: AgentStreamRequest) => string) {
    const f = fakeChannels({ pages: longPages })
    const insights = new DocumentInsights({
      store: f.store,
      structure: f.structure,
      file: () => ({ path: PATH }),
      lang: 'en',
    })
    await insights.load()
    const prepared = await insights.prepare()
    if (!prepared.ok) throw new Error('prepare failed')
    const model = fakeModel(answer)
    const session = new DocumentJobSession(new DocumentJobRegistry())
    return { f, insights, prepared: prepared.prepared, model, session }
  }

  const partialOrMerge = (request: AgentStreamRequest) =>
    request.system!.startsWith('You merge')
      ? ANSWER.replace('"page":99', '"page":2')
      : JSON.stringify({
          summary: 'part notes',
          terms: [{ term: 'Widget', meaning: 'm', page: 1 }],
        })

  it('summarizes every batch, then merges once, under the summary job record', async () => {
    const { f, insights, prepared, model, session } = await setup(partialOrMerge)
    expect(prepared.plan.mode).toBe('job')
    if (prepared.plan.mode !== 'job') return
    const ended = new Promise<string>((resolve) => {
      const out = session.start(
        insights.summaryJob({
          prepared,
          provider: 'codex',
          model: '',
          call: model.call,
          onEnd: (view) => resolve(view.state),
        }),
      )
      expect(out.ok).toBe(true)
    })
    expect(await ended).toBe('complete')
    expect(model.requests).toHaveLength(prepared.plan.calls)
    expect(model.requests.at(-1)!.system).toMatch(/^You merge/)
    expect(model.requests.every((r) => r.tools?.length === 0)).toBe(true)
    const jobs = f.writes.filter((w) => w.kind === 'job')
    expect(jobs.length).toBeGreaterThan(0)
    expect(
      jobs.every((w) => w.kind === 'job' && w.job.kind === 'summary' && w.job.lang === 'en'),
    ).toBe(true)
    const saved = f.writes.find((w) => w.kind === 'insights')
    expect(saved?.kind === 'insights' && saved.entry.pageFingerprints).toEqual([
      'fp1',
      'fp2',
      'fp3',
      'fp4',
    ])
    expect(insights.snapshot().entry?.provider).toBe('codex')
  })

  it('stores no overview when a batch answer is unusable (the merge is not sent)', async () => {
    let n = 0
    const { f, insights, prepared, model, session } = await setup((request) =>
      request.system!.startsWith('You merge')
        ? ANSWER
        : n++ === 0
          ? 'not json'
          : partialOrMerge(request),
    )
    const view = await new Promise<{ state: string }>((resolve) => {
      session.start(
        insights.summaryJob({
          prepared,
          provider: 'codex',
          model: '',
          call: model.call,
          onEnd: resolve,
        }),
      )
    })
    expect(view.state).toBe('complete')
    expect(model.requests.some((r) => r.system!.startsWith('You merge'))).toBe(false)
    expect(f.writes.some((w) => w.kind === 'insights')).toBe(false)
  })

  it('stops on Stop and is never resumed: nothing is stored', async () => {
    let release: (() => void) | null = null
    const { f, insights, prepared, session } = await setup(() => '')
    const call = vi.fn(
      (_request: AgentStreamRequest, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          release = () => reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const ended = new Promise<{ state: string }>((resolve) => {
      session.start(
        insights.summaryJob({ prepared, provider: 'codex', model: '', call, onEnd: resolve }),
      )
    })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    session.stop(prepared.docHash)
    expect((await ended).state).toBe('stopped')
    expect(release).not.toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
    expect(f.writes.some((w) => w.kind === 'insights')).toBe(false)
  })
})
