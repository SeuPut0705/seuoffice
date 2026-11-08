/**
 * A page operation that rewrites the open file in place (delete, insert a
 * PDF) reloads the document under the same path (reading-assist spec 4.2,
 * 4.6, 4.8, 6): passage cards, AI highlight suggestions and the overview are
 * read again for the rewritten file, and what was placed on the old pages is
 * dropped at once, so no mark lands on a wrong page and no Accept writes a
 * highlight onto one. Reading sends nothing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  HighlightBlockEntry,
  HighlightRun,
  PassageCard,
} from '../../../packages/pdf-structure/src/store/reading'
import { useDocumentInsights } from '../src/renderer/ai/insights/useDocumentInsights'
import type { DocumentInsights } from '../src/renderer/ai/insights/insights-controller'
import type { HighlightSuggestions } from '../src/renderer/highlight/highlight-controller'
import { useAiHighlights } from '../src/renderer/highlight/useAiHighlights'
import { createI18n } from '@genoffice/i18n'
import { DocumentJobRegistry } from '../../../packages/pdf-structure/src/jobs'
import {
  AiPageReading,
  type AiPageReadingApi,
  type AiPageReadingHandle,
  type AiPageReadingProps,
} from '../src/renderer/ai-read/AiPageReading'
import { DocumentJobSession } from '../src/renderer/doc-jobs/job-session'
import { strings } from '../src/renderer/i18n/strings'
import type { PassageCards } from '../src/renderer/reading/passage-controller'
import type { PdfStoreWriteRequest } from '../src/shared/ipc'
import { passageHash } from '../src/renderer/reading/passage-text'
import { createSaveConfirmations } from '../src/renderer/reading/save-confirmations'
import { afterReadingSave, usePassageCards } from '../src/renderer/reading/usePassageCards'
import type { PageEntry, SearchIndex } from '../src/renderer/search'

const PATH = 'C:\\docs\\paper.pdf'
const BEFORE = 'a'.repeat(64)
const AFTER = 'b'.repeat(64)

const RUN: HighlightRun = {
  runId: 'r'.repeat(32),
  presetId: 'research',
  labels: [{ id: 'l1', name: 'Key claim', color: [1, 0.85, 0.3] }],
  pages: [1, 2],
  provider: 'claude-code',
  model: '',
  createdAt: 1,
}
const BLOCKS: HighlightBlockEntry[] = [
  {
    key: { pageFingerprint: 'fp2', textHash: 'h2', occurrence: 0 },
    status: 'done',
    savedAt: 1,
    suggestions: [{ id: 's1', labelId: 'l1', quote: 'Silt doubled.', state: 'pending' }],
  },
]
const CARD: PassageCard = {
  id: 'c1',
  kind: 'explain',
  page: 2,
  pageFingerprint: 'fp2',
  quads: [[1, 2, 3, 2, 1, 1, 3, 1]],
  excerpt: 'Silt doubled.',
  passageHash: passageHash('Silt doubled.'),
  text: 'An answer.',
  provider: 'codex',
  model: '',
  createdAt: 1,
  savedAt: 1,
}

const entry = (text: string): PageEntry =>
  ({
    text,
    lower: text.toLowerCase(),
    items: [{ start: 0, end: text.length, x: 72, y: 700, w: text.length * 5, h: 10 }],
  }) as unknown as PageEntry
const INDEX: SearchIndex = [entry('Intro.'), entry('Silt doubled.')]

/** the store as one file: page 1 is deleted in place, so the file gets a new hash */
function fakeStore() {
  let hash = BEFORE
  let fingerprints = ['fp1', 'fp2']
  const store = {
    docHash: vi.fn(async () => ({ ok: true as const, docHash: hash })),
    pageFingerprints: vi.fn(async () => ({ ok: true as const, docHash: hash, fingerprints })),
    passages: vi.fn(async (h: string) => ({
      ok: true as const,
      cards: h === BEFORE ? [{ ...CARD }] : [],
    })),
    latestHighlight: vi.fn(async (h: string) =>
      h === BEFORE
        ? { ok: true as const, run: RUN, blocks: structuredClone(BLOCKS) }
        : { ok: true as const, run: null, blocks: [] },
    ),
    highlightRuns: vi.fn(async () => ({ ok: true as const, runs: [RUN] })),
    insights: vi.fn(async () => ({ ok: true as const, insights: null })),
    write: vi.fn(async () => ({ ok: true as const })),
    unfinishedJobs: vi.fn(async () => ({ ok: true as const, jobs: [] })),
    aiReadPages: vi.fn(async () => ({ ok: true as const, pages: [] })),
  }
  return {
    store,
    /** the page operation rewrote the file: page 1 is gone */
    rewrite: () => {
      hash = AFTER
      fingerprints = ['fp2']
    },
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })

interface Seen {
  cards: PassageCards
  highlights: HighlightSuggestions
  insights: DocumentInsights
}

async function mount() {
  const f = fakeStore()
  vi.stubGlobal('pdfApi', { store: f.store, structure: { tree: vi.fn(), cancel: vi.fn() } })
  const confirmations = createSaveConfirmations()
  const seen = {} as Seen
  function Probe({ revision }: { revision: number }) {
    seen.cards = usePassageCards({
      filePath: PATH,
      password: undefined,
      lang: 'en',
      ready: true,
      revision,
    })
    seen.highlights = useAiHighlights({
      filePath: PATH,
      password: undefined,
      ready: true,
      doc: null,
      searchIndex: () => Promise.resolve(INDEX),
      confirmations,
      preview: true,
      markupIds: [],
      panelOpen: false,
      revision,
    }).suggestions
    seen.insights = useDocumentInsights({
      filePath: PATH,
      password: undefined,
      lang: 'en',
      ready: true,
      revision,
    })
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = (revision: number) =>
    act(async () => root!.render(createElement(Probe, { revision })))
  await render(0)
  await settle()
  return { f, seen, render }
}

describe('a page operation that rewrites the file in place', () => {
  it('reads cards, suggestions and the overview again for the rewritten file', async () => {
    const m = await mount()
    expect(m.seen.cards.pageOf(m.seen.cards.get('c1')!)).toBe(1)
    expect(m.seen.highlights.pending().map((v) => v.found && v.found.origIdx)).toEqual([1])
    expect(m.seen.insights.snapshot().docHash).toBe(BEFORE)

    m.f.rewrite()
    await m.render(1)
    // what was placed on the old pages is gone at once, before the store answers
    expect(m.seen.highlights.snapshot().views).toBeNull()
    expect(m.seen.highlights.pending()).toEqual([])
    expect(m.seen.cards.snapshot().fingerprints).toBeNull()
    await settle()
    expect(m.seen.cards.docHash).toBe(AFTER)
    expect(m.seen.cards.list()).toEqual([])
    expect(m.seen.highlights.snapshot().docHash).toBe(AFTER)
    expect(m.seen.highlights.snapshot().run).toBeNull()
    expect(m.seen.insights.snapshot().docHash).toBe(AFTER)
    expect(m.f.store.write).not.toHaveBeenCalled()
  })

  it('the same revision reads nothing again', async () => {
    const m = await mount()
    const reads = m.f.store.docHash.mock.calls.length
    await m.render(0)
    await settle()
    expect(m.f.store.docHash.mock.calls.length).toBe(reads)
  })
})

/**
 * The store as one file whose hash changes with each rewrite, keeping cards
 * per hash; migrate copies the cards of surviving pages to the file's hash
 * now, the way the shell's migration does (spec 5.5).
 */
function hashedStore() {
  const H0 = '0'.repeat(64)
  let hash = H0
  let fingerprints = ['fp1', 'fp2']
  const byHash = new Map<string, PassageCard[]>([[H0, []]])
  const cardsOf = (h: string) => byHash.get(h) ?? []
  const store = {
    docHash: vi.fn(async () => ({ ok: true as const, docHash: hash })),
    pageFingerprints: vi.fn(async () => ({ ok: true as const, docHash: hash, fingerprints })),
    passages: vi.fn(async (h: string) => ({
      ok: true as const,
      cards: cardsOf(h).map((c) => ({ ...c })),
    })),
    write: vi.fn(async (request: PdfStoreWriteRequest) => {
      if (request.kind === 'passage') {
        const rest = cardsOf(request.docHash).filter((c) => c.id !== request.card.id)
        byHash.set(request.docHash, [...rest, { ...request.card, savedAt: 5 }])
      }
      return { ok: true as const }
    }),
    migrate: vi.fn(async (req: { oldDocHash: string }) => {
      const moved = cardsOf(req.oldDocHash).filter((c) => fingerprints.includes(c.pageFingerprint))
      const kept = cardsOf(hash).filter((c) => !moved.some((m) => m.id === c.id))
      byHash.set(hash, [...kept, ...moved])
      return {
        ok: true as const,
        docHash: hash,
        aiReadPages: 0,
        translationBlocks: 0,
        languages: [],
        jobs: 0,
      }
    }),
    unfinishedJobs: vi.fn(async () => ({ ok: true as const, jobs: [] })),
  }
  let n = 0
  return {
    store,
    cardsOf,
    hash: () => hash,
    seed: (card: PassageCard) => byHash.set(hash, [...cardsOf(hash), card]),
    /** the file is rewritten (a page operation or a save): a new hash, these pages */
    rewrite: (fps: string[]) => {
      hash = String(++n).repeat(64)
      fingerprints = fps
    },
  }
}

const translate = createI18n(strings)
const tEn: AiPageReadingProps['t'] = (key, params) => translate('en', key, params)

async function mountReading() {
  const f = hashedStore()
  vi.stubGlobal('pdfApi', { store: f.store })
  const api = {
    tree: vi.fn(),
    cancel: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    store: f.store,
  } as unknown as AiPageReadingApi
  const session = new DocumentJobSession(new DocumentJobRegistry())
  const handle = createRef<AiPageReadingHandle>()
  const seen = {} as { cards: PassageCards }
  function Probe({ revision }: { revision: number }) {
    seen.cards = usePassageCards({
      filePath: PATH,
      password: undefined,
      lang: 'en',
      ready: true,
      revision,
    })
    const props: AiPageReadingProps = {
      filePath: PATH,
      password: undefined,
      pageCount: 2,
      lang: 'en',
      t: tEn,
      api,
      session,
      openPageRenderer: vi.fn(),
      onNotice: vi.fn(),
      revision,
    }
    return createElement(AiPageReading, { ...props, ref: handle })
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = (revision: number) =>
    act(async () => root!.render(createElement(Probe, { revision })))
  await render(0)
  await settle()
  return { f, seen, handle, render }
}

const SOURCE = {
  origIdx: 0,
  quads: [[1, 2, 3, 2, 1, 1, 3, 1]],
  excerpt: 'Silt doubled.',
  pageText: 'Silt doubled.',
  title: '',
}

describe('the stored results follow a page operation and the next save', () => {
  it('a card written after a page operation is still there after the next save', async () => {
    const m = await mountReading()
    // a page operation rewrote the file in place (page 1 removed): new hash, reload
    m.f.rewrite(['fp2'])
    const afterPageOp = m.f.hash()
    await m.render(1)
    await settle()
    expect(m.seen.cards.docHash).toBe(afterPageOp)
    // a card is made on the rewritten file
    const prepared = await m.seen.cards.prepare('explain', undefined, SOURCE)
    if (!prepared || !('target' in prepared)) throw new Error('expected a request')
    const ask = vi.fn(async () => ({ text: 'An answer.', provider: 'codex', model: '' }))
    const made = await m.seen.cards.generate(prepared, ask, new AbortController().signal)
    expect(m.f.cardsOf(afterPageOp).map((c) => c.id)).toEqual([made.id])
    // the next save: the store moves from the hash the card was written under
    m.f.rewrite(['fp2'])
    let migrated: string | null = null
    await act(async () => {
      migrated = (await m.handle.current!.afterSave()) ?? null
    })
    expect(m.f.store.migrate).toHaveBeenLastCalledWith(
      expect.objectContaining({ oldDocHash: afterPageOp }),
    )
    expect(migrated).toBe(m.f.hash())
    await afterReadingSave(createSaveConfirmations(), m.seen.cards, [], migrated)
    expect(m.seen.cards.docHash).toBe(m.f.hash())
    expect(m.seen.cards.list().map((c) => c.id)).toEqual([made.id])
  })

  it('a card of a page the page operation kept follows the rewritten file', async () => {
    const m = await mountReading()
    m.f.seed({ ...CARD, id: 'kept' })
    m.f.seed({ ...CARD, id: 'gone', pageFingerprint: 'fp1', page: 1 })
    // the page operation runs the migration before the reload (App: rewriteInPlace)
    m.f.rewrite(['fp2'])
    await act(async () => {
      await m.handle.current!.afterPageOperation()
    })
    await m.render(1)
    await settle()
    expect(m.seen.cards.docHash).toBe(m.f.hash())
    expect(m.seen.cards.list().map((c) => c.id)).toEqual(['kept'])
    expect(m.seen.cards.pageOf(m.seen.cards.get('kept')!)).toBe(0)
  })

  it('the editor passes its reload revision and migrates before reloading a rewritten file', () => {
    const app = readFileSync(join(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    const start = app.indexOf('<AiPageReading')
    const reading = app.slice(start, app.indexOf('/>', app.indexOf('languageName=', start)))
    expect(reading.includes('revision={docReloadRev}')).toBe(true)
    const migratesFirst = (block: string) => {
      const at = block.indexOf('afterPageOperation()')
      return at > -1 && at < block.indexOf('loadDoc(')
    }
    const rewrite = app.slice(app.indexOf('const rewriteInPlace'), app.indexOf('const baseName'))
    expect(migratesFirst(rewrite)).toBe(true)
    const insert = app.slice(app.indexOf('const insertPdf'), app.indexOf('const insertBlankPage'))
    expect(migratesFirst(insert)).toBe(true)
  })
})
