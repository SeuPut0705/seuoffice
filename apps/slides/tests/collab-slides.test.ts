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
import { buildAllRenderSlides, type Session } from '../src/main/session-state'
import type { SlideUpdate } from '../src/shared/ipc'
import {
  createSlidesCollab,
  drawnOf,
  redrawFrom,
  slideEdit,
  textEdit,
  type Drawn,
  type Refusal,
  type SlidesCollab,
} from '../src/web/collab-adapter'
import { applyOp, fingerprint, slideIdAt, type SlidesOp } from '../src/web/collab-ops'
import { decodeOp, encodeOp, unshareable } from '../src/web/collab-wire'
import { decodeLinkTarget } from '../src/shared/run-link'

const FORMAT = { name: 'pptx', schema: 3 }
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
  /** what each integrate told the renderer to draw again; filled only when the page draws */
  redraws: SlideUpdate[]
  /** the slides each integrate reported as other slides under an old name */
  replaced: string[][]
}

/** `draws`: the page renders around every integrate, the way collab-side.ts does for the renderer */
function openPage(opened: OpenedPptx, draws = false): Page {
  const session: Session = {
    path: 'deck.pptx',
    opened,
    fitWidthPx: 960,
    undoStack: [],
    redoStack: [],
  }
  const refusals: Refusal[] = []
  const redraws: SlideUpdate[] = []
  const replaced: string[][] = []
  const render = () => buildAllRenderSlides(session.opened, session.fitWidthPx)
  let shown: Drawn = new Map()
  const collab = createSlidesCollab({
    session,
    fileName: 'deck.pptx',
    changing: () => {
      if (draws) shown = drawnOf(render())
    },
    refresh: (other) => {
      replaced.push(other)
      if (draws) redraws.push(redrawFrom(shown, render()))
    },
    refused: (reason) => refusals.push(reason),
  })
  return { session, collab, refusals, remote: [], redraws, replaced }
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
  /** The slide with the highest part number: the name a slide added after its delete takes again */
  const newestSlide = (opened: OpenedPptx): string =>
    opened.deck.slides
      .map(slideDurableId)
      .sort((x, y) => Number(y.slice(2)) - Number(x.slice(2)))[0]!

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

  it('other people’s edits redraw only the slides they changed, also around this person’s own edit', () => {
    const a = openPage(cloneDeck(baseDeck), true)
    const b = openPage(cloneDeck(baseDeck))
    const mine: SlidesOp[] = []
    a.collab.adapter.listen((ops) => mine.push(...ops))
    a.collab.adapter.setEditable(true)
    const theirs: SlidesOp[] = []
    b.collab.adapter.listen((ops) => theirs.push(...ops))
    b.collab.adapter.setEditable(true)
    const paths = a.session.opened.deck.slides.map((slide) => slide.path)
    const type = (page: Page, id: string, slide: number, text: string) => {
      const at = page.collab.refOf(firstBox(page.session.opened, slide).id)!
      expect(
        page.collab.edit(() => textEdit(page.session, id, at, [{ runs: [{ text }] }])),
      ).not.toBeNull()
    }

    // their text on the second slide: the renderer keeps the other three as they are, so a box
    // this person is typing in on one of them stays open with what they typed
    type(b, 'u1.0', 1, 'theirs')
    a.collab.adapter.integrate(theirs.splice(0), [])
    expect(a.redraws.at(-1)!.order).toEqual(paths)
    expect(a.redraws.at(-1)!.slides.map((slide) => slide.partPath)).toEqual([paths[1]])

    // the same with an edit of this person's own still unconfirmed: the deck is put back and
    // replayed, and still only their slide draws differently
    type(a, 'u0.0', 0, 'mine')
    type(b, 'u1.1', 2, 'theirs again')
    a.collab.adapter.integrate(theirs.splice(0), mine.splice(0))
    expect(a.redraws.at(-1)!.order).toEqual(paths)
    expect(a.redraws.at(-1)!.slides.map((slide) => slide.partPath)).toEqual([paths[2]])

    // a slide they add is new to the renderer; one they delete only leaves the order
    const first = slideIdAt(b.session.opened, 0)!
    expect(
      b.collab.edit(() =>
        slideEdit(b.session, 'u1.2', { kind: 'blankSlide', slide: first, before: false, made: '' }),
      ),
    ).not.toBeNull()
    a.collab.adapter.integrate(theirs.splice(0), [])
    const added = a.session.opened.deck.slides[1]!.path
    expect(paths).not.toContain(added)
    expect(a.redraws.at(-1)!.order).toEqual([paths[0], added, ...paths.slice(1)])
    expect(a.redraws.at(-1)!.slides.map((slide) => slide.partPath)).toEqual([added])
    const last = slideIdAt(b.session.opened, 4)!
    expect(
      b.collab.edit(() => slideEdit(b.session, 'u1.3', { kind: 'deleteSlides', slides: [last] })),
    ).not.toBeNull()
    a.collab.adapter.integrate(theirs.splice(0), [])
    expect(a.redraws.at(-1)!.order).toEqual([paths[0], added, paths[1], paths[2]])
    expect(a.redraws.at(-1)!.slides).toEqual([])
  })

  it('two people retype one growing box at once: the box ends at the size of the text that won', async () => {
    for (const index of [1, 2] as const) {
      const a = openPage(cloneDeck(baseDeck))
      const b = openPage(cloneDeck(baseDeck))
      const late = openPage(cloneDeck(baseDeck))
      const sentA: SlidesOp[] = []
      const sentB: SlidesOp[] = []
      a.collab.adapter.listen((ops) => sentA.push(...ops))
      a.collab.adapter.setEditable(true)
      b.collab.adapter.listen((ops) => sentB.push(...ops))
      b.collab.adapter.setEditable(true)
      const boxOf = (page: Page) =>
        page.session.opened.deck.slides[0]!.elements.filter(editable)[index]! as TextElement
      const fit = (page: Page) => ({
        ...boxOf(page).transform.offset,
        fontScale: boxOf(page).text!.fontScale ?? 1,
        lnSpcReduction: boxOf(page).text!.lnSpcReduction ?? 0,
      })
      const type = (page: Page, id: string, paragraphs: EditParagraph[]) => {
        const at = page.collab.refOf(boxOf(page).id)!
        expect(page.collab.edit(() => textEdit(page.session, id, at, paragraphs))).not.toBeNull()
      }
      // a short text everyone has, at the size its layout gives it
      type(a, 'u0.0', [{ runs: [{ text: 'short' }] }])
      b.collab.adapter.integrate(sentA.slice(), [])
      late.collab.adapter.integrate(sentA.slice(), [])
      a.collab.adapter.confirmed?.(sentA.splice(0))
      const small = fit(a)
      expect(fit(b)).toEqual(small)

      // at one version: b types a long text, a another short one that changes nothing in its layout
      const long = Array.from({ length: 12 }, (_, i) => ({
        runs: [{ text: `line ${i} ${WORDS.join(' ')}` }],
      }))
      type(b, 'u1.0', long)
      expect(fit(b)).not.toEqual(small)
      type(a, 'u0.1', [{ runs: [{ text: 'brief' }] }])
      expect(fit(a)).toEqual(small)
      // the server takes b's first
      b.collab.adapter.confirmed?.(sentB.slice())
      const kept = a.collab.adapter.integrate(sentB.slice(), sentA.splice(0))
      b.collab.adapter.integrate(kept, [])
      late.collab.adapter.integrate([...sentB, ...kept], [])
      for (const page of [a, b, late]) {
        expect(textOf(boxOf(page).text!.paragraphs)).toBe('brief')
        expect(fit(page), `box ${index}`).toEqual(small)
      }
      expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
      expect(await fingerprint(late.session.opened)).toBe(await fingerprint(a.session.opened))
    }
  })

  it('a slide this person made under a part name a peer’s delete freed keeps what was typed on it', () => {
    const a = openPage(cloneDeck(baseDeck))
    const sent: SlidesOp[] = []
    a.collab.adapter.listen((ops) => sent.push(...ops))
    a.collab.adapter.setEditable(true)
    const last = newestSlide(a.session.opened)
    // offline: delete the newest slide, add a blank one (which takes its part name) and type on it
    a.collab.edit(() => slideEdit(a.session, 'u0.0', { kind: 'deleteSlides', slides: [last] }))
    const third = slideIdAt(a.session.opened, 2)!
    const added = a.collab.edit(() =>
      slideEdit(a.session, 'u0.1', { kind: 'blankSlide', slide: third, before: false, made: '' }),
    )!
    expect(added.applied.made).toBe(last)
    expect(
      a.collab.edit(() =>
        slideEdit(a.session, 'u0.2', { kind: 'notes', slide: last, text: 'on my new slide' }),
      ),
    ).not.toBeNull()
    // meanwhile a peer deleted that slide too
    const theirs: SlidesOp = { id: 'u1.0', edit: { kind: 'deleteSlides', slides: [last] } }
    const kept = a.collab.adapter.integrate([theirs], sent.splice(0))
    const slides = a.session.opened.deck.slides
    expect(slides).toHaveLength(4)
    const mine = kept[1]!.edit
    if (mine.kind !== 'blankSlide' || kept[2]!.edit.kind !== 'notes') throw new Error('kinds')
    expect(kept[2]!.edit.slide).toBe(mine.made)
    const made = slides.find((slide) => slideDurableId(slide) === mine.made)!
    expect(getSlideNotes(a.session.opened.archive, made.path)).toBe('on my new slide')
    // nothing of this person's was lost: the delete both made is not reported as a dropped edit
    expect(a.refusals).toEqual([])
    // the slide under that name is the one this page showed before: nothing was replaced
    expect(a.replaced.at(-1)).toEqual([])
  })

  it('a slide deleted and another made under its part name in one batch is reported as replaced', () => {
    const a = openPage(cloneDeck(baseDeck))
    const b = openPage(cloneDeck(baseDeck))
    const theirs: SlidesOp[] = []
    b.collab.adapter.listen((ops) => theirs.push(...ops))
    b.collab.adapter.setEditable(true)
    const last = newestSlide(b.session.opened)
    b.collab.edit(() => slideEdit(b.session, 'u1.0', { kind: 'deleteSlides', slides: [last] }))
    const third = slideIdAt(b.session.opened, 2)!
    b.collab.edit(() =>
      slideEdit(b.session, 'u1.1', { kind: 'blankSlide', slide: third, before: false, made: '' }),
    )
    expect(slideIdAt(b.session.opened, 3)).toBe(last)
    a.collab.adapter.integrate(theirs.slice(0, 1), [])
    expect(a.replaced.at(-1)).toEqual([])
    const c = openPage(cloneDeck(baseDeck))
    c.collab.adapter.integrate(theirs, [])
    expect(c.replaced.at(-1)).toEqual([last])
    // a slide that only changed is not another slide
    const at = b.collab.refOf(firstBox(b.session.opened, 0).id)!
    b.collab.edit(() => textEdit(b.session, 'u1.2', at, [{ runs: [{ text: 'changed' }] }]))
    c.collab.adapter.integrate(theirs.slice(2), [])
    expect(c.replaced.at(-1)).toEqual([])
  })

  it('the engine’s random ids are the real ones again after an edit, also one that throws', () => {
    const a = openPage(cloneDeck(baseDeck))
    const at = a.collab.refOf(firstBox(a.session.opened, 1).id)!
    const real = globalThis.crypto.randomUUID
    const ok: SlidesOp = {
      id: 'u0.0',
      edit: { kind: 'text', at, paragraphs: [{ runs: [{ text: 'fine' }] }] },
    }
    expect(applyOp(a.session.opened, ok)).not.toBeNull()
    expect(globalThis.crypto.randomUUID).toBe(real)
    // a paragraph that cannot be copied makes the edit throw while the seeded ids answer
    const broken = [{ runs: [{ text: 'x' }], oops: () => {} }] as unknown as EditParagraph[]
    expect(() =>
      applyOp(a.session.opened, { id: 'u0.1', edit: { kind: 'text', at, paragraphs: broken } }),
    ).toThrow()
    expect(globalThis.crypto.randomUUID).toBe(real)
    expect(Object.hasOwn(globalThis.crypto, 'randomUUID')).toBe(false)
    expect(globalThis.crypto.randomUUID()).not.toBe(globalThis.crypto.randomUUID())
  })

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

describe('a text box holding a slide number field', () => {
  let fieldDeck: OpenedPptx
  beforeAll(async () => {
    const opened = await openPptx(await createBlankPptx())
    const added = runTxn(opened, {
      ops: [
        {
          op: 'addElement',
          target: { slide: 0 },
          kind: 'textbox',
          offset: { x: 457200, y: 300000, cx: 3600000, cy: 500000 },
          paragraphs: [{ runs: [{ text: 'Page ' }, { text: '1', field: 'slidenum' }] }],
        },
      ],
    })
    expect(added.applied).toBe(true)
    const bytes = await savePptx(opened)
    fieldDeck = await openPptx(bytes)
    expect(fieldDeck.archive.readText(fieldDeck.deck.slides[0]!.path)).toMatch(/<a:fld id="\{/)
  })

  /** Enter pressed at the end of the box: a second paragraph, so the body is written again */
  function pressEnter(page: Page, id: string): SlidesOp {
    page.collab.adapter.listen(() => {})
    page.collab.adapter.setEditable(true)
    const box = page.session.opened.deck.slides[0]!.elements.find(editable)!
    const at = page.collab.refOf(box.id)!
    const done = page.collab.edit(() =>
      textEdit(page.session, id, at, [
        {
          srcPara: 0,
          runs: [
            { text: 'Page ', srcRun: 0 },
            { text: '1', field: 'slidenum', srcRun: 1 },
          ],
        },
        { srcPara: 0, runs: [{ text: 'more', srcRun: 0 }] },
      ]),
    )
    expect(done).not.toBeNull()
    return done!.op
  }

  it('fingerprints the same every time, on every page, and as the saved file reopened', async () => {
    const a = openPage(cloneDeck(fieldDeck))
    const b = openPage(cloneDeck(fieldDeck))
    const op = pressEnter(a, 'u0.0')
    b.collab.adapter.integrate([decodeOp(encodeOp(op))], [])
    const first = await fingerprint(a.session.opened)
    expect(await fingerprint(a.session.opened)).toBe(first)
    expect(await fingerprint(b.session.opened)).toBe(first)

    const file = await a.collab.adapter.produceFile()
    const again = await a.collab.adapter.produceFile()
    const theirs = await b.collab.adapter.produceFile()
    const reopened = await openPptx(new Uint8Array(file.bytes))
    const slide = reopened.archive.readText(reopened.deck.slides[0]!.path)!
    // the edit made the engine write the field again
    expect(slide).toMatch(/<a:fld id="\{[0-9A-F-]{36}\}" type="slidenum"/)
    expect(slide).toContain('more')
    expect(await fingerprint(reopened)).toBe(first)
    for (const other of [again, theirs]) {
      const opened = await openPptx(new Uint8Array(other.bytes))
      expect(opened.archive.readText(opened.deck.slides[0]!.path)).toBe(slide)
    }
    // and the page's fingerprint did not move by writing files
    expect(await fingerprint(a.session.opened)).toBe(first)
  })

  it('a level change, which bakes the slide while the edit applies, gives every page the same field', async () => {
    const a = openPage(cloneDeck(fieldDeck))
    const b = openPage(cloneDeck(fieldDeck))
    a.collab.adapter.listen(() => {})
    a.collab.adapter.setEditable(true)
    const box = a.session.opened.deck.slides[0]!.elements.find(editable)!
    const at = a.collab.refOf(box.id)!
    const done = a.collab.edit(() =>
      textEdit(a.session, 'u0.0', at, [
        {
          srcPara: 0,
          level: 1,
          runs: [
            { text: 'Page ', srcRun: 0 },
            { text: '1', field: 'slidenum', srcRun: 1 },
          ],
        },
        { srcPara: 0, runs: [{ text: 'more', srcRun: 0 }] },
      ]),
    )!
    expect(done.applied.levelDirty).toBe(true)
    b.collab.adapter.integrate([decodeOp(encodeOp(done.op))], [])
    expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
  })

  it('leaves Math.random as it was, also after an edit that throws', () => {
    const a = openPage(cloneDeck(fieldDeck))
    const real = Math.random
    pressEnter(a, 'u0.0')
    expect(Math.random).toBe(real)
    const at = a.collab.refOf(a.session.opened.deck.slides[0]!.elements.find(editable)!.id)!
    const broken = [{ runs: [{ text: 'x' }], oops: () => {} }] as unknown as EditParagraph[]
    expect(() =>
      applyOp(a.session.opened, { id: 'u0.1', edit: { kind: 'text', at, paragraphs: broken } }),
    ).toThrow()
    expect(Math.random).toBe(real)
  })
})

describe('links on the runs of a text box', () => {
  const TEL = 'tel:+82-2-0000-0000'
  const FILE = '../docs/plan.docx'
  let linkDeck: OpenedPptx

  const boxOf = (opened: OpenedPptx, index: number): TextElement =>
    opened.deck.slides[0]!.elements.filter(editable)[index]!
  const linksOf = (opened: OpenedPptx, index: number): (string | undefined)[] =>
    boxOf(opened, index).text!.paragraphs.flatMap((p) => p.runs.map((r) => r.hyperlink))
  const wordsOf = (opened: OpenedPptx, index: number): string =>
    textOf(boxOf(opened, index).text!.paragraphs)

  beforeAll(async () => {
    const opened = await openPptx(await createBlankPptx())
    const box = (y: number) => ({
      op: 'addElement',
      target: { slide: 0 },
      kind: 'textbox',
      offset: { x: 457200, y, cx: 3600000, cy: 500000 },
      paragraphs: [{ runs: [{ text: 'plain' }] }],
    })
    const made = runTxn(opened, {
      ops: [
        { op: 'addBlankSlide', target: { slide: 0 } },
        { op: 'addBlankSlide', target: { slide: 0 } },
        box(300000),
        box(1100000),
        box(1900000),
      ],
    })
    expect(made.applied).toBe(true)
    const [jumps, foreign] = made.records!.slice(2).map((record) => record.created![0]!)
    const linked = runTxn(opened, {
      ops: [
        {
          op: 'setText',
          target: { slide: 0, el: jumps },
          paragraphs: [
            {
              runs: [
                { text: 'see ' },
                // a jump inside the deck: what PowerPoint writes as ppaction://hlinksldjump
                { text: 'the last slide', link: { kind: 'slide', slideIndex: 2 } },
                { text: ' or ' },
                { text: 'stop', link: { kind: 'action', action: 'endshow' } },
              ],
            },
          ],
        },
        {
          op: 'setText',
          target: { slide: 0, el: foreign },
          paragraphs: [
            {
              runs: [
                { text: 'call ' },
                // targets other editors wrote, which the app would not let a person add
                { text: 'the office', link: { kind: 'url', url: TEL } },
                { text: ' about ' },
                { text: 'the plan', link: { kind: 'url', url: FILE } },
              ],
            },
          ],
        },
      ],
    })
    expect(linked.applied).toBe(true)
    linkDeck = await openPptx(await savePptx(opened))
    expect(linksOf(linkDeck, 0)).toEqual([undefined, 'slide:2', undefined, 'action:endshow'])
    expect(linksOf(linkDeck, 1)).toEqual([undefined, TEL, undefined, FILE])
  })

  /** The box as the text editor sends it back: every run with the link its span holds */
  function retyped(opened: OpenedPptx, index: number, first: string): EditParagraph[] {
    const runs = boxOf(opened, index).text!.paragraphs[0]!.runs
    return [
      {
        srcPara: 0,
        level: 0,
        runs: runs.map((run, i) => ({
          text: i === 0 ? first : run.text,
          srcRun: i,
          redact: null,
          link: run.hyperlink ? decodeLinkTarget(run.hyperlink) : null,
        })),
      },
    ]
  }

  /** `a` types into box `index`; `b` takes the edit from the wire */
  function typeAndSend(index: number, first: string) {
    const a = openPage(cloneDeck(linkDeck))
    const b = openPage(cloneDeck(linkDeck))
    const sent: SlidesOp[] = []
    a.collab.adapter.listen((ops) => sent.push(...ops))
    a.collab.adapter.setEditable(true)
    const at = a.collab.refOf(boxOf(a.session.opened, index).id)!
    const paragraphs = retyped(a.session.opened, index, first)
    const done = a.collab.edit(() => textEdit(a.session, 'u0.0', at, paragraphs))
    return { a, b, sent, done, at, paragraphs }
  }

  it('a box with a slide jump and a show action is edited, and both stay on both pages', async () => {
    const { a, b, sent, done, paragraphs, at } = typeAndSend(0, 'look at ')
    expect(unshareable({ kind: 'text', at, paragraphs })).toBeNull()
    expect(done?.applied.linksDropped).toBeFalsy()
    b.collab.adapter.integrate(
      sent.map((op) => decodeOp(encodeOp(op))),
      [],
    )
    for (const page of [a, b]) {
      expect(wordsOf(page.session.opened, 0)).toBe('look at the last slide or stop')
      expect(linksOf(page.session.opened, 0)).toEqual([
        undefined,
        'slide:2',
        undefined,
        'action:endshow',
      ])
    }
    expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
    const saved = await openPptx(await a.collab.adapter.produceFile().then((file) => file.bytes))
    expect(linksOf(saved, 0)).toEqual([undefined, 'slide:2', undefined, 'action:endshow'])
  })

  it('a box whose file already links to a phone number and a file path is edited, and both links stay', async () => {
    const { a, b, sent, done, paragraphs, at } = typeAndSend(1, 'please call ')
    // nothing stops the person, and nothing is taken out of their edit
    expect(unshareable({ kind: 'text', at, paragraphs })).toBeNull()
    expect(done).not.toBeNull()
    expect(done?.applied.linksDropped).toBeFalsy()
    b.collab.adapter.integrate(
      sent.map((op) => decodeOp(encodeOp(op))),
      [],
    )
    for (const page of [a, b]) {
      expect(wordsOf(page.session.opened, 1)).toBe('please call the office about the plan')
      expect(linksOf(page.session.opened, 1)).toEqual([undefined, TEL, undefined, FILE])
    }
    expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
    const saved = await openPptx(await b.collab.adapter.produceFile().then((file) => file.bytes))
    expect(linksOf(saved, 1)).toEqual([undefined, TEL, undefined, FILE])
  })

  it('a link the box already has may move to other words of the same box', async () => {
    const a = openPage(cloneDeck(linkDeck))
    const b = openPage(cloneDeck(linkDeck))
    const at = a.collab.refOf(boxOf(a.session.opened, 1).id)!
    const op: SlidesOp = {
      id: 'u0.0',
      edit: {
        kind: 'text',
        at,
        paragraphs: [{ runs: [{ text: 'office', link: { kind: 'url', url: TEL } }] }],
      },
    }
    for (const page of [a, b]) {
      expect(applyOp(page.session.opened, decodeOp(encodeOp(op)))?.linksDropped).toBeFalsy()
      expect(linksOf(page.session.opened, 1)).toEqual([TEL])
    }
    expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
  })

  it.each([
    ['a script', 'javascript:alert(1)'],
    ['a script, in other letters', 'JaVaScRiPt:alert(1)'],
    ['a file on the reader’s disk', 'file:///etc/passwd'],
    ['a link another box has, not this one', TEL],
    ['a link with spaces around it', ' https://example.com '],
  ])(
    'a peer cannot put %s into a box as a new link: the edit lands without it, the same on every page',
    async (_name, url) => {
      const a = openPage(cloneDeck(linkDeck))
      const b = openPage(cloneDeck(linkDeck))
      const at = a.collab.refOf(boxOf(a.session.opened, 2).id)!
      // what a page running other code could send
      const wire = encodeOp({
        id: 'x9.0',
        edit: {
          kind: 'text',
          at,
          paragraphs: [
            { runs: [{ text: 'click ' }, { text: 'here', link: { kind: 'url', url } }] },
          ],
        },
      })
      for (const page of [a, b]) {
        page.collab.adapter.integrate([decodeOp(wire)], [])
        expect(wordsOf(page.session.opened, 2)).toBe('click here')
        expect(linksOf(page.session.opened, 2)).toEqual([undefined, undefined])
      }
      expect(await fingerprint(b.session.opened)).toBe(await fingerprint(a.session.opened))
      const bytes = (await a.collab.adapter.produceFile()).bytes
      const saved = await openPptx(bytes)
      expect(linksOf(saved, 2)).toEqual([undefined, undefined])
      const slide = saved.deck.slides[0]!.path
      const rels = slide.replace('slides/', 'slides/_rels/') + '.rels'
      const written = `${saved.archive.readText(slide)}${saved.archive.readText(rels) ?? ''}`
      if (url !== TEL) expect(written.toLowerCase()).not.toContain(url.trim().toLowerCase())
    },
  )

  it('a person’s own new link outside the gate is left out and they are told; a link the app allows stays', () => {
    const a = openPage(cloneDeck(linkDeck))
    a.collab.adapter.listen(() => {})
    a.collab.adapter.setEditable(true)
    const at = a.collab.refOf(boxOf(a.session.opened, 2).id)!
    const done = a.collab.edit(() =>
      textEdit(a.session, 'u0.0', at, [
        {
          runs: [
            { text: 'files ', link: { kind: 'url', url: 'ftp://example.com/files' } },
            { text: 'site', link: { kind: 'url', url: 'https://example.com/' } },
          ],
        },
      ]),
    )
    expect(done?.applied.linksDropped).toBe(true)
    expect(linksOf(a.session.opened, 2)).toEqual([undefined, 'https://example.com/'])
  })
})
