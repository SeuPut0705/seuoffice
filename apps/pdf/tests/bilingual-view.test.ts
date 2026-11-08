/**
 * Side-by-side translation view, display and linking (reading-assist spec
 * 4.5, 10 item 5): blocks matched to stored translation blocks by the job's
 * keys, the language rule, the drawn window, paragraphs across pages, the
 * link between a paragraph and its source boxes (rotated pages too), blocks
 * without boxes, unsaved page edits, two-page exclusivity, and the tree's
 * lifetime. The structure and store channels are fakes; turning the view on
 * and scrolling must never send anything or write anything.
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@genoffice/i18n'
import {
  blockKeyString,
  translationBlockKeys,
  type TranslationBlockKey,
} from '../../../packages/pdf-structure/src/store/keys'
import type { TranslationBlockEntry } from '../../../packages/pdf-structure/src/store/store'
import { translationUnits } from '../../../packages/pdf-structure/src/translate'
import type {
  BlockRegion,
  DocumentTree,
  InlineRun,
  TreeBlock,
} from '../../../packages/pdf-structure/src/tree/types'
import { strings } from '../src/renderer/i18n/strings'
import type { TFunc } from '../src/renderer/i18n/locale'
import type { PageGeom } from '../src/renderer/annotations'
import type { PdfStoredTranslation, PdfTranslationRecency } from '../src/shared/ipc'
import {
  BILINGUAL_NARROW_PAGE_PX,
  bilingualRenderWindow,
  buildBilingualModel,
  chooseBilingualLanguage,
  columnPageOf,
  hasUnsavedPageEdits,
  hitTestRegions,
  pagePointToTree,
  pendingUnits,
  regionCssBox,
  shouldAskToCollapse,
  toggleBilingual,
  toggleSpread,
} from '../src/renderer/bilingual/model'
import { useBilingual, type BilingualView } from '../src/renderer/bilingual/useBilingual'
import type { BilingualDataApi } from '../src/renderer/bilingual/useBilingualData'
import { BilingualColumn } from '../src/renderer/bilingual/BilingualColumn'
import { BilingualBar } from '../src/renderer/bilingual/BilingualBar'

const translate = createI18n(strings)
const t: TFunc = (key, params) => translate('en', key, params)

const DOC = 'b'.repeat(64)
const PATH = 'C:\\docs\\paper.pdf'

const runs = (text: string): InlineRun[] => [{ kind: 'text', text }]
const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })
const region = (page: number, x0 = 50, y0 = 600, x1 = 300, y1 = 700): BlockRegion => ({
  page,
  box: box(x0, y0, x1, y1),
})
const para = (
  id: string,
  page: number,
  text: string,
  /** null: no measured position (an AI-read page) */
  regions: BlockRegion[] | null = [region(page)],
): TreeBlock => ({
  kind: 'paragraph',
  id,
  page,
  pageFingerprint: `fp${page}`,
  source: regions ? 'pdf' : 'ai',
  runs: runs(text),
  ...(regions ? { regions } : {}),
})
const pageBreak = (page: number): TreeBlock => ({
  kind: 'pageBreak',
  id: `p${page}.break`,
  page,
  pageFingerprint: `fp${page}`,
  source: 'pdf',
})

/**
 * Three pages. Page 1: a heading, the same sentence twice, a paragraph that
 * runs onto page 2. Page 2: one paragraph. Page 3: AI-read (no boxes).
 */
function fakeTree(): DocumentTree {
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: 3,
    pages: [1, 2, 3].map((page) => ({
      page,
      fingerprint: `fp${page}`,
      status: page === 3 ? ('ai' as const) : ('text' as const),
      widthPt: 600,
      heightPt: 800,
    })),
    blocks: [
      pageBreak(1),
      {
        kind: 'heading',
        id: 'p1.0',
        page: 1,
        pageFingerprint: 'fp1',
        source: 'pdf',
        level: 1,
        levelSource: 'font',
        runs: runs('Introduction'),
        regions: [region(1, 50, 720, 400, 760)],
      },
      para('p1.1', 1, 'Same words here.', [region(1, 50, 600, 300, 640)]),
      para('p1.2', 1, 'Same words here.', [region(1, 50, 500, 300, 540)]),
      para('p1.3', 1, 'A paragraph that runs over the page end.', [
        region(1, 50, 40, 550, 100),
        region(2, 50, 700, 550, 760),
      ]),
      pageBreak(2),
      para('p2.0', 2, 'Second page text.', [region(2, 50, 500, 550, 600)]),
      pageBreak(3),
      para('p3.0', 3, 'Read by the AI.', null),
    ],
    footnotes: [],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [],
    warnings: [],
  }
}

/** the store key of each unit of the tree, by block id (same as the translation job) */
function keysOf(tree: DocumentTree): Map<string, TranslationBlockKey> {
  const units = translationUnits(tree)
  const keys = translationBlockKeys(units)
  return new Map(units.map((u, i) => [u.key, keys[i]!]))
}

function storedOf(
  tree: DocumentTree,
  lang: string,
  blocks: Record<string, Partial<TranslationBlockEntry>>,
): PdfStoredTranslation {
  const keys = keysOf(tree)
  return {
    lang,
    provider: 'codex',
    model: 'm',
    blocks: Object.entries(blocks).map(([id, b]) => ({
      key: keys.get(id)!,
      status: 'translated',
      savedAt: 1,
      ...b,
    })),
  }
}

// ── matching ──

describe('bilingual model: blocks matched to stored translation blocks', () => {
  it('uses the job keys, the occurrence included', () => {
    const tree = fakeTree()
    const keys = keysOf(tree)
    // the two identical sentences share the text hash and differ by occurrence
    expect(keys.get('p1.1')!.textHash).toBe(keys.get('p1.2')!.textHash)
    expect(keys.get('p1.1')!.occurrence).toBe(0)
    expect(keys.get('p1.2')!.occurrence).toBe(1)
    const stored = storedOf(tree, 'ko', { 'p1.2': { text: '같은 말 두 번째' } })
    const model = buildBilingualModel(tree, stored)
    const first = model.itemsById.get('p1.1')!
    const second = model.itemsById.get('p1.2')!
    expect(first.kind === 'text' && first.unit.state).toBe('pending')
    expect(first.kind === 'text' && first.unit.runs).toEqual(runs('Same words here.'))
    expect(second.kind === 'text' && second.unit.state).toBe('translated')
    expect(second.kind === 'text' && second.unit.runs).toEqual(runs('같은 말 두 번째'))
    expect(second.kind === 'text' && second.unit.keyString).toBe(blockKeyString(keys.get('p1.2')!))
    expect(model.lang).toBe('ko')
  })

  it('shows an edit as plain text, keeps marks of a job translation, and marks failed blocks', () => {
    const tree = fakeTree()
    const marked: InlineRun[] = [{ kind: 'text', text: '서론', bold: true }]
    const stored = storedOf(tree, 'ko', {
      'p1.0': { text: '서론', runs: marked },
      'p1.1': { text: '사람이 고친 글', runs: marked, edited: true },
      'p2.0': { status: 'failed', reason: 'placeholder-mismatch' },
    })
    const model = buildBilingualModel(tree, stored)
    const heading = model.itemsById.get('p1.0')!
    const edited = model.itemsById.get('p1.1')!
    const failed = model.itemsById.get('p2.0')!
    expect(heading.kind === 'text' && heading.unit.runs).toEqual(marked)
    expect(edited.kind === 'text' && edited.unit.edited).toBe(true)
    expect(edited.kind === 'text' && edited.unit.runs).toEqual(runs('사람이 고친 글'))
    expect(failed.kind === 'text' && failed.unit.state).toBe('failed')
    expect(failed.kind === 'text' && failed.unit.reason).toBe('placeholder-mismatch')
    expect(failed.kind === 'text' && failed.unit.runs).toEqual(runs('Second page text.'))
  })

  it('counts each page and lists what a page translation would send', () => {
    const tree = fakeTree()
    const stored = storedOf(tree, 'ko', {
      'p1.0': { text: '서론' },
      'p2.0': { status: 'failed', reason: 'x' },
    })
    const model = buildBilingualModel(tree, stored)
    expect(model.pages.get(1)!.counts).toEqual({ units: 4, translated: 1, failed: 0, pending: 3 })
    expect(model.pages.get(2)!.counts).toEqual({ units: 1, translated: 0, failed: 1, pending: 0 })
    expect(pendingUnits(model.pages.get(1)).map((u) => u.unitKey)).toEqual(['p1.1', 'p1.2', 'p1.3'])
    expect(pendingUnits(model.pages.get(2))).toEqual([])
  })

  it('shows every block as its source when nothing is stored', () => {
    const model = buildBilingualModel(fakeTree(), null)
    expect(model.lang).toBeNull()
    for (const item of model.itemsById.values()) {
      expect(item.kind === 'text' && item.unit.state).toBe('pending')
    }
  })
})

// ── cross-page paragraphs and blocks without boxes ──

describe('bilingual model: page placement', () => {
  it('puts a paragraph across pages once, on its start page; the next page says it continues', () => {
    const model = buildBilingualModel(fakeTree(), null)
    expect(model.pages.get(1)!.items.map((i) => i.id)).toEqual(['p1.0', 'p1.1', 'p1.2', 'p1.3'])
    expect(model.pages.get(2)!.items.map((i) => i.id)).toEqual(['p2.0'])
    expect(model.pages.get(2)!.continued).toEqual([{ id: 'p1.3', fromPage: 1 }])
    expect(model.pages.get(1)!.continued).toEqual([])
    // its boxes are on both pages, for the outline
    expect(model.regionsByPage.get(2)!.map((r) => r.id)).toEqual(['p1.3', 'p2.0'])
  })

  it('keeps blocks without boxes (AI-read) in order, with nothing to link', () => {
    const model = buildBilingualModel(fakeTree(), null)
    const page3 = model.pages.get(3)!
    expect(page3.items.map((i) => i.id)).toEqual(['p3.0'])
    expect(page3.items[0]!.regions).toEqual([])
    expect(model.regionsByPage.get(3)).toBeUndefined()
    expect(hitTestRegions(model.regionsByPage.get(3), 100, 100)).toBeNull()
  })
})

// ── language ──

describe('bilingual language rule', () => {
  const recency = (langs: Array<[string, number | null]>): PdfTranslationRecency[] =>
    langs.map(([lang, savedAt]) => ({ lang, savedAt }))

  it('opens in the stored translation written most recently', () => {
    expect(
      chooseBilingualLanguage(
        recency([
          ['ja', 300],
          ['ko', 500],
          ['de', 100],
        ]),
        'en',
      ),
    ).toBe('ko')
  })

  it('skips languages without a readable block and unknown codes', () => {
    expect(
      chooseBilingualLanguage(
        recency([
          ['fr', null],
          ['xx', 900],
          ['de', 10],
        ]),
        'en',
      ),
    ).toBe('de')
  })

  it('falls back to the default target language when nothing is stored', () => {
    expect(chooseBilingualLanguage([], 'ko')).toBe('ko')
    expect(chooseBilingualLanguage(null, 'en')).toBe('en')
    expect(chooseBilingualLanguage(recency([['ja', null]]), 'zh')).toBe('zh')
  })
})

// ── drawn window ──

describe('bilingual drawn window', () => {
  it('draws the visible rows and two on each side, clipped to the document', () => {
    expect([...bilingualRenderWindow(new Set([5]), 20)].sort((a, b) => a - b)).toEqual([
      3, 4, 5, 6, 7,
    ])
    expect([...bilingualRenderWindow(new Set([0, 1]), 3)].sort((a, b) => a - b)).toEqual([0, 1, 2])
    expect(bilingualRenderWindow(new Set(), 10).size).toBe(0)
  })
})

// ── geometry ──

describe('bilingual source boxes on the page', () => {
  // a 600 × 800 pt page, box near the top-left in tree space (y up)
  const b = box(100, 700, 300, 750)
  const geomOf = (rot: number): PageGeom => ({ pw: 600, ph: 800, rot })

  it('places a box on an upright page (y flips)', () => {
    expect(regionCssBox(b, geomOf(0), 0, 1)).toEqual({ left: 100, top: 50, width: 200, height: 50 })
    expect(regionCssBox(b, geomOf(0), 0, 2)).toEqual({
      left: 200,
      top: 100,
      width: 400,
      height: 100,
    })
  })

  it('a page saved rotated: the tree box is already in its display space', () => {
    // saved /Rotate 90: display is 800 × 600 and the tree boxes are measured on it
    const saved = box(100, 500, 300, 550)
    expect(regionCssBox(saved, geomOf(90), 90, 1)).toEqual({
      left: 100,
      top: 50,
      width: 200,
      height: 50,
    })
  })

  it('an unsaved rotation turns the box with the page', () => {
    // upright saved page turned 90° on screen: display 800 wide × 600 high
    const css = regionCssBox(b, geomOf(90), 0, 1)
    expect(css).toEqual({ left: 700, top: 100, width: 50, height: 200 })
    // the pointer over that box finds the block
    const [x, y] = pagePointToTree(725, 200, geomOf(90), 0, 1)
    expect(hitTestRegions([{ id: 'p1.0', box: b }], x, y)).toBe('p1.0')
    const [x2, y2] = pagePointToTree(100, 50, geomOf(90), 0, 1)
    expect(hitTestRegions([{ id: 'p1.0', box: b }], x2, y2)).toBeNull()
  })

  it('a hit picks the smallest box holding the point', () => {
    const regions = [
      { id: 'outer', box: box(0, 0, 600, 800) },
      { id: 'inner', box: box(100, 100, 200, 200) },
    ]
    expect(hitTestRegions(regions, 150, 150)).toBe('inner')
    expect(hitTestRegions(regions, 400, 400)).toBe('outer')
  })
})

// ── view rules ──

describe('bilingual view rules', () => {
  it('two-page view and the side-by-side view never show together', () => {
    expect(toggleBilingual(true, 2)).toEqual({ bilingual: true, spread: 1 })
    expect(toggleBilingual(false, 1)).toEqual({ bilingual: false, spread: 1 })
    expect(toggleSpread(2, true)).toEqual({ bilingual: false, spread: 2 })
    expect(toggleSpread(1, true)).toEqual({ bilingual: true, spread: 1 })
  })

  it('unsaved page inserts, deletes and reorders put the notice up; inserted pages get an empty column', () => {
    expect(hasUnsavedPageEdits({ insertedPages: 0, deletedPages: 0, reordered: false })).toBe(false)
    expect(hasUnsavedPageEdits({ insertedPages: 1, deletedPages: 0, reordered: false })).toBe(true)
    expect(hasUnsavedPageEdits({ insertedPages: 0, deletedPages: 2, reordered: false })).toBe(true)
    expect(hasUnsavedPageEdits({ insertedPages: 0, deletedPages: 0, reordered: true })).toBe(true)
    expect(columnPageOf(0, 3)).toBe(1)
    expect(columnPageOf(2, 3)).toBe(3)
    expect(columnPageOf(3, 3)).toBeNull()
  })

  it('asks once to fold the column when the page area is narrower than the threshold', () => {
    const narrow = BILINGUAL_NARROW_PAGE_PX - 1
    expect(shouldAskToCollapse({ pageAreaWidth: narrow, asked: false, collapsed: false })).toBe(
      true,
    )
    expect(shouldAskToCollapse({ pageAreaWidth: narrow, asked: true, collapsed: false })).toBe(
      false,
    )
    expect(shouldAskToCollapse({ pageAreaWidth: narrow, asked: false, collapsed: true })).toBe(
      false,
    )
    expect(
      shouldAskToCollapse({
        pageAreaWidth: BILINGUAL_NARROW_PAGE_PX,
        asked: false,
        collapsed: false,
      }),
    ).toBe(false)
  })
})

// ── the screen ──

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {})
}

interface FakeChannels {
  api: BilingualDataApi
  tree: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  translation: ReturnType<typeof vi.fn>
  /** everything that would send or write: must stay untouched */
  forbidden: Record<string, ReturnType<typeof vi.fn>>
  resolveTree: () => void
}

function fakeChannels(
  o: {
    tree?: DocumentTree
    stored?: Record<string, PdfStoredTranslation>
    recency?: PdfTranslationRecency[]
    holdTree?: boolean
  } = {},
): FakeChannels {
  const tree = o.tree ?? fakeTree()
  let release: () => void = () => {}
  const gate = o.holdTree
    ? new Promise<void>((resolve) => {
        release = resolve
      })
    : Promise.resolve()
  const treeFn = vi.fn(async () => {
    await gate
    return { ok: true as const, docHash: DOC, tree, fingerprints: [], cached: false }
  })
  const cancel = vi.fn(async () => true)
  const translation = vi.fn(async (_doc: string, lang: string) => ({
    ok: true as const,
    translation: o.stored?.[lang] ?? null,
  }))
  const forbidden = {
    write: vi.fn(),
    migrate: vi.fn(),
    deleteDocument: vi.fn(),
    aiStream: vi.fn(),
    convert: vi.fn(),
    writeBack: vi.fn(),
  }
  // the editor's bridge: anything that sends or writes is a spy that must stay unused
  vi.stubGlobal('pdfApi', {
    aiStream: forbidden.aiStream,
    store: { write: forbidden.write, migrate: forbidden.migrate },
    structure: { convert: forbidden.convert, writeBack: forbidden.writeBack },
  })
  const api = {
    tree: treeFn,
    cancel,
    onProgress: () => () => {},
    store: {
      aiReadPages: vi.fn(async () => ({ ok: true as const, pages: [] })),
      translationRecency: vi.fn(async () => ({ ok: true as const, langs: o.recency ?? [] })),
      translation,
      // not part of the view's api: present only to prove it is never used
      write: forbidden.write,
      deleteDocument: forbidden.deleteDocument,
    },
  } as unknown as BilingualDataApi
  return { api, tree: treeFn, cancel, translation, forbidden, resolveTree: () => release() }
}

interface HarnessProps {
  enabled: boolean
  api: BilingualDataApi
  visibleRows?: Set<number>
  savedPageCount?: number
  /** on-screen page indices (an inserted page is past savedPageCount) */
  pages?: number[]
  rotations?: Record<number, number>
  unsavedPageEdits?: boolean
  revision?: number
  scrollRef: { current: HTMLElement | null }
  onView: (view: BilingualView) => void
}

function Harness(p: HarnessProps): ReactElement {
  const pages = p.pages ?? [0, 1, 2]
  const view = useBilingual({
    enabled: p.enabled,
    onClose: () => {},
    filePath: PATH,
    password: undefined,
    uiLang: 'en',
    t,
    revision: p.revision ?? 0,
    api: p.api,
    scrollRef: p.scrollRef,
    scale: 1,
    pageGeom: (i) => ({ pw: 600, ph: 800, rot: p.rotations?.[i] ?? 0 }),
    savedRot: () => 0,
    savedPageCount: p.savedPageCount ?? 3,
    rowCount: pages.length,
    visibleRows: p.visibleRows ?? new Set([0]),
    unsavedPageEdits: p.unsavedPageEdits ?? false,
    reservedWidth: 0,
  })
  p.onView(view)
  return createElement(
    'div',
    null,
    view.bar,
    pages.map((origIdx, r) =>
      createElement(
        'div',
        { key: r, className: 'pdf-row', 'data-idx': r },
        createElement(
          'div',
          { className: 'pdf-page', 'data-page': origIdx, style: { width: 600, height: 800 } },
          view.overlay(origIdx),
        ),
        view.column([origIdx], r),
      ),
    ),
  )
}

function mount(props: Omit<HarnessProps, 'onView' | 'scrollRef'>): {
  view: () => BilingualView
  rerender: (next: Partial<HarnessProps>) => void
} {
  let current: BilingualView | null = null
  // the scroll element the view listens on wraps the rows
  const scroller = document.createElement('div')
  scroller.className = 'h-scroll'
  container.appendChild(scroller)
  let last: HarnessProps = {
    ...props,
    scrollRef: { current: scroller },
    onView: (v) => (current = v),
  }
  const scrollRoot = createRoot(scroller)
  root = scrollRoot
  act(() => scrollRoot.render(createElement(Harness, last)))
  return {
    view: () => current!,
    rerender: (next) => {
      last = { ...last, ...next }
      act(() => scrollRoot.render(createElement(Harness, last)))
    },
  }
}

describe('bilingual view on screen', () => {
  it('turning the view on and scrolling reads only: no AI call, no job, no store write', async () => {
    const tree = fakeTree()
    const ch = fakeChannels({
      tree,
      recency: [{ lang: 'ko', savedAt: 9 }],
      stored: { ko: storedOf(tree, 'ko', { 'p1.0': { text: '서론' } }) },
    })
    const h = mount({ enabled: true, api: ch.api })
    await flush()
    expect(ch.tree).toHaveBeenCalledTimes(1)
    expect(h.view().data.lang).toBe('ko')
    expect(container.textContent).toContain('서론')
    // scrolling: other rows come into view
    h.rerender({ visibleRows: new Set([1, 2]) })
    await flush()
    const scroller = container.querySelector('.h-scroll')!
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
      container
        .querySelector('.pdf-page')!
        .dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    await flush()
    for (const spy of Object.values(ch.forbidden)) expect(spy).not.toHaveBeenCalled()
    // the tree is built once, not again on scroll
    expect(ch.tree).toHaveBeenCalledTimes(1)
  })

  it('drops the tree when the view turns off, and stops a build still running', async () => {
    const ch = fakeChannels({ holdTree: true })
    const h = mount({ enabled: true, api: ch.api })
    await flush()
    expect(h.view().data.load.kind).toBe('loading')
    h.rerender({ enabled: false })
    await flush()
    expect(ch.cancel).toHaveBeenCalledTimes(1)
    ch.resolveTree()
    await flush()
    expect(h.view().data.tree).toBeNull()
    expect(h.view().data.load.kind).toBe('off')

    // a finished tree is dropped too
    const ch2 = fakeChannels()
    h.rerender({ enabled: true, api: ch2.api })
    await flush()
    expect(h.view().data.tree).not.toBeNull()
    h.rerender({ enabled: false })
    await flush()
    expect(h.view().data.tree).toBeNull()
    expect(h.view().data.model).toBeNull()
    expect(container.querySelector('.bl-col')).toBeNull()
    expect(container.querySelector('.bl-bar')).toBeNull()
  })

  it('builds the tree again after a save (revision), not on every render', async () => {
    const ch = fakeChannels()
    const h = mount({ enabled: true, api: ch.api })
    await flush()
    h.rerender({ visibleRows: new Set([1]) })
    await flush()
    expect(ch.tree).toHaveBeenCalledTimes(1)
    h.rerender({ revision: 1 })
    await flush()
    expect(ch.tree).toHaveBeenCalledTimes(2)
  })

  it('an in-place rewrite (revision) rebuilds the tree and a stale build in flight is discarded', async () => {
    const before = fakeTree()
    const after: DocumentTree = {
      ...fakeTree(),
      blocks: [pageBreak(1), para('p1.0', 1, 'Rewritten page one.')],
    }
    const ch = fakeChannels({ tree: before })
    // the first build hangs until released; the rebuild answers at once with the new bytes
    let releaseOld: () => void = () => {}
    ch.tree
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseOld = resolve
        })
        return { ok: true as const, docHash: DOC, tree: before, fingerprints: [], cached: false }
      })
      .mockImplementationOnce(async () => ({
        ok: true as const,
        docHash: 'c'.repeat(64),
        tree: after,
        fingerprints: [],
        cached: false,
      }))
    const h = mount({ enabled: true, api: ch.api })
    await flush()
    expect(h.view().data.load.kind).toBe('loading')
    // the file was rewritten in place and reloaded: the editor bumps the revision
    h.rerender({ revision: 1 })
    await flush()
    expect(ch.tree).toHaveBeenCalledTimes(2)
    // the older build is stopped
    expect(ch.cancel).toHaveBeenCalledTimes(1)
    expect(h.view().data.tree).toBe(after)
    expect(h.view().data.docHash).toBe('c'.repeat(64))
    // the stale answer arriving late does not replace the new tree
    releaseOld()
    await flush()
    expect(h.view().data.tree).toBe(after)
    expect(h.view().data.docHash).toBe('c'.repeat(64))
    expect(container.textContent).toContain('Rewritten page one.')
    expect(container.textContent).not.toContain('Same words here.')
  })

  it('opens in the default target language when nothing is stored, and reads the picked language', async () => {
    const tree = fakeTree()
    const ch = fakeChannels({
      tree,
      stored: { ja: storedOf(tree, 'ja', { 'p2.0': { text: '二ページ目' } }) },
    })
    const h = mount({ enabled: true, api: ch.api, visibleRows: new Set([1]) })
    await flush()
    // an English document under an English UI: the default target is not English
    expect(h.view().data.lang).not.toBeNull()
    act(() => h.view().data.setLang('ja'))
    await flush()
    expect(ch.translation).toHaveBeenLastCalledWith(DOC, 'ja')
    expect(container.textContent).toContain('二ページ目')
  })

  it('draws only the visible pages and two on each side', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => i)
    const big: DocumentTree = {
      ...fakeTree(),
      sourcePageCount: 8,
      pages: pages.map((i) => ({
        page: i + 1,
        fingerprint: `fp${i + 1}`,
        status: 'text' as const,
        widthPt: 600,
        heightPt: 800,
      })),
      blocks: pages.flatMap((i) => [
        pageBreak(i + 1),
        para(`p${i + 1}.0`, i + 1, `Page ${i + 1} text.`),
      ]),
    }
    const ch = fakeChannels({ tree: big })
    mount({ enabled: true, api: ch.api, pages, savedPageCount: 8, visibleRows: new Set([0]) })
    await flush()
    const drawn = [...container.querySelectorAll('.bl-col')].map(
      (col) => col.querySelector('.bl-col-body') !== null,
    )
    expect(drawn).toEqual([true, true, true, false, false, false, false, false])
  })

  it('a paragraph across pages: shown on its start page, the next page says it continues', async () => {
    const ch = fakeChannels()
    mount({ enabled: true, api: ch.api, visibleRows: new Set([0, 1]) })
    await flush()
    const cols = container.querySelectorAll('.bl-col')
    expect(cols[0]!.querySelector('[data-bl-id="p1.3"]')).not.toBeNull()
    expect(cols[1]!.querySelector('[data-bl-id="p1.3"]')).toBeNull()
    expect(cols[1]!.querySelector('.bl-continued')!.textContent).toBe(t('blContinued'))
  })

  it('hovering a translated paragraph outlines its source boxes, on a rotated page too', async () => {
    const ch = fakeChannels()
    const h = mount({
      enabled: true,
      api: ch.api,
      visibleRows: new Set([0, 1]),
      rotations: { 1: 90 },
    })
    await flush()
    const item = container.querySelector('[data-bl-id="p1.3"]')!
    act(() => {
      item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await flush()
    const pagesEl = container.querySelectorAll('.pdf-page')
    const onPage1 = pagesEl[0]!.querySelectorAll('.bl-overlay-box')
    const onPage2 = pagesEl[1]!.querySelectorAll('.bl-overlay-box')
    expect(onPage1).toHaveLength(1)
    expect(onPage2).toHaveLength(1)
    // page 1 upright: box (50,40)-(550,100) → top = 800 - 100
    expect((onPage1[0] as HTMLElement).style.top).toBe('700px')
    // page 2 turned 90° on screen: box (50,700)-(550,760) lands on the right edge
    const rotated = onPage2[0] as HTMLElement
    expect(rotated.style.left).toBe('700px')
    expect(rotated.style.width).toBe('60px')
    expect(h.view().overlay(2)).toBeNull()
    act(() => {
      item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    await flush()
    expect(container.querySelector('.bl-overlay-box')).toBeNull()
  })

  it('the pointer over source text highlights its translated paragraph; boxless blocks never link', async () => {
    const ch = fakeChannels()
    mount({ enabled: true, api: ch.api, visibleRows: new Set([0, 1, 2]) })
    await flush()
    const page1 = container.querySelectorAll<HTMLElement>('.pdf-page')[0]!
    page1.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0 }) as DOMRect
    // (100, 180) on screen = tree (100, 620): inside p1.1's box (50,600)-(300,640)
    act(() => {
      page1.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 180 }),
      )
    })
    await flush()
    expect(container.querySelector('[data-bl-id="p1.1"]')!.className).toContain('bl-hover')
    expect(container.querySelector('[data-bl-id="p1.2"]')!.className).not.toContain('bl-hover')
    // page hover does not draw outlines (that is the paragraph's hover)
    expect(container.querySelector('.bl-overlay-box')).toBeNull()
    // the AI-read paragraph has no boxes: no link class, hover does nothing
    const boxless = container.querySelector('[data-bl-id="p3.0"]')!
    expect(boxless.className).not.toContain('bl-linked')
    act(() => {
      boxless.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await flush()
    expect(container.querySelector('.bl-overlay-box')).toBeNull()
  })

  it('unsaved page edits: the notice shows and an inserted page has an empty column', async () => {
    const ch = fakeChannels()
    mount({
      enabled: true,
      api: ch.api,
      pages: [0, 3, 1, 2],
      savedPageCount: 3,
      unsavedPageEdits: true,
      visibleRows: new Set([0, 1, 2]),
    })
    await flush()
    expect(container.querySelector('.bl-bar')!.textContent).toContain(t('blUnsavedPages'))
    const cols = container.querySelectorAll('.bl-col')
    expect(cols[1]!.className).toContain('bl-col-blank')
    expect(cols[1]!.textContent).toBe('')
    // the reordered saved pages keep their own columns
    expect(cols[2]!.querySelector('[data-bl-id="p2.0"]')).not.toBeNull()
  })

  it('T7 slots: page actions get the pending units, paragraph slots get the unit', async () => {
    const tree = fakeTree()
    const ch = fakeChannels({
      tree,
      recency: [{ lang: 'ko', savedAt: 1 }],
      stored: { ko: storedOf(tree, 'ko', { 'p1.0': { text: '서론' } }) },
    })
    const pageCalls: Array<{ page: number; pending: number }> = []
    const paraCalls: string[] = []
    function SlotHarness(p: { onView: (v: BilingualView) => void }): ReactElement {
      const view = useBilingual({
        enabled: true,
        onClose: () => {},
        filePath: PATH,
        password: undefined,
        uiLang: 'en',
        t,
        revision: 0,
        api: ch.api,
        scrollRef: { current: null },
        scale: 1,
        pageGeom: () => ({ pw: 600, ph: 800, rot: 0 }),
        savedRot: () => 0,
        savedPageCount: 3,
        rowCount: 3,
        visibleRows: new Set([0]),
        unsavedPageEdits: false,
        reservedWidth: 0,
        slots: {
          pageActions: (ctx) => {
            pageCalls.push({ page: ctx.page, pending: ctx.pending.length })
            return createElement('button', { className: 'slot-page' }, `N=${ctx.counts.pending}`)
          },
          paragraphActions: (ctx) => {
            paraCalls.push(ctx.unit.unitKey)
            return null
          },
        },
      })
      p.onView(view)
      return createElement('div', null, view.column([0], 0))
    }
    let view: BilingualView | null = null
    act(() => root.render(createElement(SlotHarness, { onView: (v) => (view = v) })))
    await flush()
    expect(container.querySelector('.slot-page')!.textContent).toBe('N=3')
    expect(pageCalls.at(-1)).toEqual({ page: 1, pending: 3 })
    expect(new Set(paraCalls)).toEqual(new Set(['p1.0', 'p1.1', 'p1.2', 'p1.3']))
    expect(view!.pageCounts(1)).toEqual({ units: 4, translated: 1, failed: 0, pending: 3 })
    for (const spy of Object.values(ch.forbidden)) expect(spy).not.toHaveBeenCalled()
  })
})

describe('bilingual pieces', () => {
  it('a column for an inserted page is empty', () => {
    act(() =>
      root.render(
        createElement(BilingualColumn, {
          page: null,
          docHash: DOC,
          lang: 'ko',
          width: 300,
          height: 800,
          fontSize: 14,
          drawn: true,
          hoverId: null,
          t,
          slots: undefined,
          onHover: () => {},
          onResizeStart: () => {},
        }),
      ),
    )
    const col = container.querySelector('.bl-col')!
    expect(col.className).toContain('bl-col-blank')
    expect(col.childElementCount).toBe(0)
  })

  it('the bar shows the fold prompt and its answers', () => {
    const onCollapse = vi.fn()
    act(() =>
      root.render(
        createElement(BilingualBar, {
          load: { kind: 'ready' },
          lang: 'ko',
          storedLangs: ['ko'],
          uiLang: 'en',
          fontSize: 14,
          unsavedPageEdits: false,
          askCollapse: true,
          t,
          onLang: () => {},
          onFontSize: () => {},
          onCollapse,
          onDismissCollapse: () => {},
          onClose: () => {},
        }),
      ),
    )
    expect(container.textContent).toContain(t('blCollapseAsk'))
    const fold = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === t('blCollapse'),
    )!
    act(() => fold.click())
    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(container.querySelector('select')!.value).toBe('ko')
  })
})
