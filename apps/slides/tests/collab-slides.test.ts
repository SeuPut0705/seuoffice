// @vitest-environment node
/**
 * Co-editing one deck: the slides adapter under the collab conformance kit, over the real op
 * executor and the page's real session state. Every simulated person edits through the same
 * functions the web bridge calls (collab-side.ts), naming boxes by the parse-time ids a
 * renderer holds and slides by the positions it shows.
 */
import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: () => Promise.resolve(),
  },
  dialog: {},
  clipboard: { writeBuffer: () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
  nativeImage: {},
  shell: {},
}))
// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

import {
  PackageArchive,
  createBlankPptx,
  getSlideNotes,
  matchesElementRef,
  openPptx,
  savePptx,
  slideDurableId,
  type OpenedPptx,
  type SlideElement,
  type TextElement,
} from '@genoffice/pptx-engine'
import { runTxn, type EditParagraph } from '@genoffice/pptx-ops'
// the kit from its source: this package's vitest config has no seuoffice-source condition
import { simulate, type SimulatedEditor } from '../../../packages/collab/src/conformance/index'
import type { Session } from '../src/main/session-state'
import {
  createSlidesCollab,
  slideEdit,
  textEdit,
  type Refusal,
  type SlidesCollab,
} from '../src/web/collab-adapter'
import {
  applyOp,
  decodeOp,
  encodeOp,
  fingerprint,
  slideIdAt,
  type SlidesOp,
} from '../src/web/collab-ops'

const FORMAT = { name: 'pptx', schema: 1 }
const CREATION_ID =
  /<a:ext uri="\{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236\}"><a16:creationId[^>]*\/><\/a:ext>/g

/**
 * Four slides, each with a plain box, a box that grows with its text, one that shrinks its text
 * and a group of two shapes with text, and notes on one slide. Slides 2 and 4 carry no
 * creationIds, like decks other editors wrote: the first edit of one of their boxes mints one.
 */
async function buildBase(): Promise<Uint8Array> {
  const opened = await openPptx(await createBlankPptx())
  const box = (y: number, text: string, autoFit?: 'resize' | 'shrink', kind = 'textbox') => ({
    op: 'addElement',
    target: { slide: 0 },
    kind,
    offset: { x: 457200, y, cx: 3600000, cy: 500000 },
    paragraphs: [{ runs: [{ text }] }],
    ...(autoFit ? { bodyPr: { autoFit } } : {}),
  })
  const added = runTxn(opened, {
    ops: [
      box(300000, 'plain box'),
      box(1100000, 'growing box', 'resize'),
      box(1900000, 'shrinking box', 'shrink'),
      box(2700000, 'left shape', undefined, 'rect'),
      box(3500000, 'right shape', undefined, 'rect'),
    ],
  })
  expect(added.applied).toBe(true)
  const ids = added.records!.map((record) => record.created![0]!)
  expect(
    runTxn(opened, { ops: [{ op: 'groupElements', target: { slide: 0 }, els: ids.slice(3) }] })
      .applied,
  ).toBe(true)
  const copies = [1, 2, 3].map(() => ({ op: 'duplicateSlide', target: { slide: 0 } }))
  expect(runTxn(opened, { ops: copies }).applied).toBe(true)
  expect(
    runTxn(opened, { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'opening notes' }] })
      .applied,
  ).toBe(true)
  const saved = await openPptx(await savePptx(opened))
  saved.deck.slides.forEach((slide, i) => {
    if (i % 2 === 0) return
    const xml = saved.archive.readText(slide.path)!
    saved.archive.entries.set(slide.path, Buffer.from(xml.replace(CREATION_ID, ''), 'utf8'))
  })
  return new Uint8Array(await savePptx(saved))
}

function cloneDeck(opened: OpenedPptx): OpenedPptx {
  const archive = Object.assign(Object.create(PackageArchive.prototype) as PackageArchive, {
    entries: new Map(opened.archive.entries),
    originalHash: opened.archive.originalHash,
  })
  return { deck: structuredClone(opened.deck), archive }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const textOf = (paragraphs: ReadonlyArray<{ runs: ReadonlyArray<{ text?: string }> }>): string =>
  paragraphs.map((p) => p.runs.map((r) => r.text ?? '').join('')).join('\n')

const editable = (el: SlideElement): el is TextElement => el.type === 'text' || el.type === 'shape'

type Kind = 'text' | 'sameBox' | 'groupText' | 'duplicate' | 'blank' | 'delete' | 'notes'

interface Page {
  session: Session
  collab: SlidesCollab
  refusals: Refusal[]
  /** remote edits in the order this page integrated them */
  remote: SlidesOp[]
}

function openPage(opened: OpenedPptx): Page {
  const session: Session = {
    path: 'deck.pptx',
    opened,
    fitWidthPx: 960,
    undoStack: [],
    redoStack: [],
  }
  const refusals: Refusal[] = []
  const collab = createSlidesCollab({
    session,
    fileName: 'deck.pptx',
    refresh: () => {},
    refused: (reason) => refusals.push(reason),
  })
  return { session, collab, refusals, remote: [] }
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota']

/** New text for a box: tagged with the edit id, sometimes long enough to make autofit act */
function paragraphsFor(r: () => number, id: string, existing: number): EditParagraph[] {
  const count = 1 + Math.floor(r() * 3)
  return Array.from({ length: count }, (_, p) => {
    const words = Array.from(
      { length: 1 + Math.floor(r() * (r() < 0.3 ? 40 : 4)) },
      () => WORDS[Math.floor(r() * WORDS.length)],
    )
    const para: EditParagraph = { runs: [{ text: `${id}:${p} ${words.join(' ')}` }] }
    if (existing > 0 && r() < 0.5) para.srcPara = Math.floor(r() * existing)
    if (r() < 0.1) para.level = 1
    return para
  })
}

/** What a person does on a page, the way collab-side.ts turns renderer calls into edits */
function personEdits(page: Page): Record<Kind, (r: () => number, id: string) => boolean> {
  const { session, collab } = page
  const slides = () => session.opened.deck.slides
  const pick = <T>(r: () => number, items: T[]): T | undefined =>
    items[Math.floor(r() * items.length)]
  const type = (r: () => number, id: string, sourceId: string, groupId?: string) => {
    const at = collab.refOf(sourceId, groupId)
    if (!at) return false
    return !!collab.edit(() => textEdit(session, id, at, paragraphsFor(r, id, 3)))
  }
  const addSlide = (r: () => number, id: string, blank: boolean) => {
    if (slides().length >= 16) return false
    const slide = slideIdAt(session.opened, Math.floor(r() * slides().length))!
    const edit = blank
      ? ({ kind: 'blankSlide', slide, before: r() < 0.5, made: '' } as const)
      : ({ kind: 'duplicateSlide', slide, clearText: r() < 0.3, made: '' } as const)
    return !!collab.edit(() => slideEdit(session, id, edit))
  }
  return {
    text(r, id) {
      const slide = pick(r, slides())
      const el = slide && pick(r, slide.elements.filter(editable))
      return !!el && type(r, id, el.id)
    },
    sameBox(r, id) {
      const el = slides()[0]?.elements.find(editable)
      return !!el && type(r, id, el.id)
    },
    groupText(r, id) {
      const slide = pick(r, slides())
      const grp = slide?.elements.find((el) => el.type === 'group')
      const child = grp?.type === 'group' ? pick(r, grp.children.filter(editable)) : undefined
      return !!grp && !!child && type(r, id, child.id, grp.id)
    },
    duplicate: (r, id) => addSlide(r, id, false),
    blank: (r, id) => addSlide(r, id, true),
    delete(r, id) {
      if (slides().length <= 2) return false
      const count = 1 + Math.floor(r() * 2)
      const picked = new Set<string>()
      while (picked.size < count)
        picked.add(slideIdAt(session.opened, Math.floor(r() * slides().length))!)
      const edit = { kind: 'deleteSlides' as const, slides: [...picked] }
      return !!collab.edit(() => slideEdit(session, id, edit))
    },
    notes(r, id) {
      const slide = slideIdAt(session.opened, Math.floor(r() * slides().length))!
      return !!collab.edit(() =>
        slideEdit(session, id, { kind: 'notes', slide, text: `${id} notes` }),
      )
    },
  }
}

let base: Uint8Array
let baseDeck: OpenedPptx
/** the page the kit opened last: after a run, its late joiner */
let lastPage: Page | null = null

beforeAll(async () => {
  base = await buildBase()
  baseDeck = await openPptx(base)
})

/** A page for the kit. Saved files only need a fingerprint, so they open lazily. */
function opener(kinds: readonly Kind[]) {
  return (bytes: Uint8Array): SimulatedEditor<SlidesOp> => {
    if (!sameBytes(bytes, base)) {
      const reopened = openPptx(bytes)
      return {
        encode: encodeOp,
        decode: decodeOp,
        listen: () => () => {},
        integrate: () => {
          throw new Error('only the base file is replayed')
        },
        fingerprint: async () => fingerprint(await reopened),
        setEditable: () => {},
        produceFile: async () => ({ fileName: 'deck.pptx', bytes }),
        edit: () => false,
        opKey: (json) => decodeOp(json).id,
      }
    }
    const page = openPage(cloneDeck(baseDeck))
    lastPage = page
    const { adapter } = page.collab
    const person = personEdits(page)
    return {
      ...adapter,
      integrate(remote, local) {
        page.remote.push(...remote)
        return adapter.integrate(remote, local)
      },
      produceFile: async () => {
        const file = await adapter.produceFile()
        return { ...file, bytes: new Uint8Array(file.bytes) }
      },
      edit: (r, id) => person[kinds[Math.floor(r() * kinds.length)]!](r, id),
      opKey: (json) => decodeOp(json).id,
    }
  }
}

const run = (kinds: readonly Kind[], seed: number, clients = 3) =>
  simulate({
    seed,
    clients,
    steps: 400,
    file: { format: FORMAT, bytes: base },
    adapterFactory: opener(kinds),
  })

// the kit's scheduler lets three clients make no edit at all under seed 3, whatever the adapter
// (its own toyMap makes 0 ops there too)
const SEEDS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11]

describe('people editing one deck at once, under the conformance kit', () => {
  for (const seed of SEEDS) {
    it(`two people typing in the same text box end with the text the server ordered last (seed ${seed})`, async () => {
      const report = await run(['sameBox'], seed)
      expect(report.ops).toBeGreaterThan(10)
      const late = lastPage!
      const texts = late.remote.filter((op) => op.edit.kind === 'text')
      const lastText = texts.at(-1)!.edit
      if (lastText.kind !== 'text') throw new Error('unreachable')
      const box = late.session.opened.deck.slides[0]!.elements.find((el) =>
        matchesElementRef(el, lastText.at.el),
      ) as TextElement
      expect(textOf(box.text!.paragraphs)).toBe(textOf(lastText.paragraphs))
    }, 120_000)

    it(`slides two people add at the same place are all kept (seed ${seed})`, async () => {
      const report = await run(['duplicate', 'blank'], seed)
      expect(report.ops).toBeGreaterThan(10)
      const late = lastPage!
      expect(late.session.opened.deck.slides).toHaveLength(4 + late.remote.length)
      const made = late.remote.map((op) => ('made' in op.edit ? op.edit.made : ''))
      expect(new Set(made).size).toBe(made.length)
    }, 120_000)

    it(`typing on slides other people delete converges (seed ${seed})`, async () => {
      expect((await run(['text', 'groupText', 'delete', 'notes'], seed)).ops).toBeGreaterThan(10)
    }, 120_000)
  }

  // the same for four clients under seeds 20 and 23 (toyMap: 3 and 0 ops)
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 25, 26]) {
    it(`every edit kind at once, four people (seed ${seed})`, async () => {
      const all: Kind[] = ['text', 'sameBox', 'groupText', 'duplicate', 'blank', 'delete', 'notes']
      expect((await run(all, seed, 4)).ops).toBeGreaterThan(10)
    }, 180_000)
  }
})

describe('the edits themselves', () => {
  const firstBox = (opened: OpenedPptx, slide: number) =>
    opened.deck.slides[slide]!.elements.find(editable)!

  it('one edit gives the same file on two pages, also on a slide without creationIds', async () => {
    const a = openPage(cloneDeck(baseDeck))
    const b = openPage(cloneDeck(baseDeck))
    const at = a.collab.refOf(firstBox(a.session.opened, 1).id)!
    expect(at.el).toMatch(/^e_\d+$/)
    const op: SlidesOp = {
      id: 'u0.0',
      edit: { kind: 'text', at, paragraphs: [{ runs: [{ text: 'hello' }] }] },
    }
    expect(applyOp(a.session.opened, op)).not.toBeNull()
    expect(applyOp(b.session.opened, decodeOp(encodeOp(op)))).not.toBeNull()
    const minted = (opened: OpenedPptx) =>
      /a16:creationId[^>]*id="([^"]+)"/.exec(firstBox(opened, 1).anchor.originalXml)?.[1]
    expect(minted(a.session.opened)).toBeDefined()
    expect(minted(a.session.opened)).toBe(minted(b.session.opened))
    expect(await fingerprint(a.session.opened)).toBe(await fingerprint(b.session.opened))
  })

  for (const [name, index] of [
    ['grows with its text', 1],
    ['shrinks its text', 2],
  ] as const) {
    it(`a box that ${name} ends the same on a page drawn at another width`, async () => {
      const a = openPage(cloneDeck(baseDeck))
      const b = openPage(cloneDeck(baseDeck))
      b.session.fitWidthPx = 1700
      a.collab.adapter.listen(() => {})
      a.collab.adapter.setEditable(true)
      const box = a.session.opened.deck.slides[0]!.elements.filter(editable)[index]!
      const at = a.collab.refOf(box.id)!
      const long = Array.from({ length: 12 }, (_, i) => ({
        runs: [{ text: `line ${i} ${WORDS.join(' ')}` }],
      }))
      const done = a.collab.edit(() => textEdit(a.session, 'u0.0', at, long))!
      expect(done.op.edit.kind === 'text' && done.op.edit.autofit).toBeTruthy()
      expect(applyOp(b.session.opened, decodeOp(encodeOp(done.op)))).not.toBeNull()
      expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
    })
  }

  it('text typed into a box whose slide a peer moved lands in that box', () => {
    const a = openPage(cloneDeck(baseDeck))
    const held = firstBox(a.session.opened, 0).id
    const first = slideIdAt(a.session.opened, 0)!
    const blank: SlidesOp = {
      id: 'u1.0',
      edit: { kind: 'blankSlide', slide: first, before: true, made: 's_5' },
    }
    a.collab.adapter.integrate([blank], [])
    expect(slideIdAt(a.session.opened, 1)).toBe(first)
    const at = a.collab.refOf(held)!
    expect(at.slide).toBe(first)
    a.collab.adapter.listen(() => {})
    a.collab.adapter.setEditable(true)
    const done = a.collab.edit(() =>
      textEdit(a.session, 'u0.0', at, [{ runs: [{ text: 'moved but mine' }] }]),
    )
    expect(done).not.toBeNull()
    expect(textOf((firstBox(a.session.opened, 1) as TextElement).text!.paragraphs)).toBe(
      'moved but mine',
    )
  })

  it('an edit while input is frozen is refused and the person is told', () => {
    const a = openPage(cloneDeck(baseDeck))
    const sent: SlidesOp[][] = []
    a.collab.adapter.listen((ops) => sent.push(ops))
    a.collab.adapter.setEditable(false)
    const slide = slideIdAt(a.session.opened, 0)!
    const done = a.collab.edit(() =>
      slideEdit(a.session, 'u0.0', { kind: 'notes', slide, text: 'x' }),
    )
    expect(done).toBeNull()
    expect(a.refusals).toEqual(['frozen'])
    expect(sent).toEqual([])
    expect(getSlideNotes(a.session.opened.archive, a.session.opened.deck.slides[0]!.path)).toBe('')
  })

  it('typing on a slide a peer deleted first is dropped, and the person is told', async () => {
    const a = openPage(cloneDeck(baseDeck))
    const sent: SlidesOp[] = []
    a.collab.adapter.listen((ops) => sent.push(...ops))
    a.collab.adapter.setEditable(true)
    const at = a.collab.refOf(firstBox(a.session.opened, 2).id)!
    a.collab.edit(() => textEdit(a.session, 'u0.0', at, [{ runs: [{ text: 'lost' }] }]))
    expect(sent).toHaveLength(1)
    const removed: SlidesOp = { id: 'u1.0', edit: { kind: 'deleteSlides', slides: [at.slide] } }
    const kept = a.collab.adapter.integrate([removed], sent)
    expect(a.refusals).toEqual(['gone'])
    expect(a.session.opened.deck.slides.map(slideDurableId)).not.toContain(at.slide)
    // still sent, so the log holds it, but it names no slide and changes nothing anywhere
    expect(kept).toHaveLength(1)
    expect(kept[0]!.edit.kind === 'text' && kept[0]!.edit.at.slide).not.toBe(at.slide)
    const settled = await fingerprint(a.session.opened)
    expect(applyOp(a.session.opened, kept[0]!)).toBeNull()
    expect(await fingerprint(a.session.opened)).toBe(settled)
  })

  it('a slide two people add at once keeps each person’s next edit on their own slide', () => {
    const a = openPage(cloneDeck(baseDeck))
    const sent: SlidesOp[] = []
    a.collab.adapter.listen((ops) => sent.push(...ops))
    a.collab.adapter.setEditable(true)
    const source = slideIdAt(a.session.opened, 0)!
    a.collab.edit(() =>
      slideEdit(a.session, 'u0.0', {
        kind: 'duplicateSlide',
        slide: source,
        clearText: false,
        made: '',
      }),
    )
    const mine = slideIdAt(a.session.opened, 1)!
    const at = a.collab.refOf(firstBox(a.session.opened, 1).id)!
    expect(at.slide).toBe(mine)
    a.collab.edit(() => textEdit(a.session, 'u0.1', at, [{ runs: [{ text: 'on my copy' }] }]))
    // a peer's copy of the same slide reached the server first and took that part name
    const theirs: SlidesOp = {
      id: 'u1.0',
      edit: { kind: 'duplicateSlide', slide: source, clearText: true, made: mine },
    }
    const kept = a.collab.adapter.integrate([theirs], sent)
    expect(kept).toHaveLength(2)
    const renamed = kept[0]!.edit
    if (renamed.kind !== 'duplicateSlide' || kept[1]!.edit.kind !== 'text') throw new Error('kinds')
    expect(renamed.made).not.toBe(mine)
    expect(kept[1]!.edit.at.slide).toBe(renamed.made)
    const order = a.session.opened.deck.slides.map(slideDurableId)
    const box = (id: string) =>
      a.session.opened.deck.slides[order.indexOf(id)]!.elements.find(editable) as TextElement
    expect(textOf(box(renamed.made).text!.paragraphs)).toBe('on my copy')
    expect(textOf(box(mine).text!.paragraphs)).toBe('')
  })
})
