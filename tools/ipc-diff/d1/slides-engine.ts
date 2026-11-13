/**
 * The TypeScript half of the fake deck engine of crates/shell-ipc/d1/src/slides/fake.rs:
 * the same tiny deck (slides with text elements, comments and a hidden flag, one
 * master part), the same file form, the same op checks, answering what
 * `@seuoffice/pptx-engine`, `pptx-ops` and `pptx-render` answer for the real
 * deck, and logging the same lines. A case's `hosts.d1.slides` scripts the rest
 * (`blankSlides`).
 */
import { readFileSync, writeFileSync } from 'node:fs'

type Json = Record<string, unknown>

export const MASTER_PART = 'ppt/slideMasters/slideMaster1.xml'

/** ops that make an element the executor answers with its id (CREATING of fake.rs) */
const CREATING = [
  'addTable',
  'addChart',
  'addSmartArt',
  'addModel3d',
  'addMedia',
  'groupElements',
  'pasteElements',
]

export interface FakeElement {
  id: string
  type: 'text'
  text: { paragraphs: { runs: { text: string }[] }[] }
  dirty?: boolean
}

export interface FakeSlide {
  path: string
  elements: FakeElement[]
  hidden: boolean
  comments: { author: string; text: string }[]
  structureDirty?: boolean
}

export interface FakeOpened {
  deck: { slides: FakeSlide[]; size: { cx: number; cy: number } }
  archive: FakeArchive
  nextId: number
  master: FakeElement[]
}

export class FakeArchive {
  entries = new Map<string, Uint8Array>()
  constructor(readonly owner: () => FakeOpened) {}
  readBytes(): Uint8Array | undefined {
    return undefined
  }
  readPresentation(): { slidePaths: string[] } {
    return { slidePaths: this.owner().deck.slides.map((s) => s.path) }
  }
  resolveSlideChain(): { themePath: string } {
    return { themePath: 'ppt/theme/theme1.xml' }
  }
  readText(): string {
    return 'THEME'
  }
  slides(): FakeSlide[] {
    return this.owner().deck.slides
  }
}

const elementText = (el: FakeElement): string =>
  el.text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')

const textElement = (id: string, text: string): FakeElement => ({
  id,
  type: 'text',
  text: { paragraphs: [{ runs: [{ text }] }] },
})

/** `paragraphs_text` of fake.rs: a line per paragraph, empty when it is no list */
export function paragraphsText(paragraphs: unknown): string {
  if (!Array.isArray(paragraphs)) return ''
  return paragraphs
    .map((p) => {
      const runs = (p as Json | null)?.runs
      return Array.isArray(runs)
        ? runs
            .map((r) => (typeof (r as Json | null)?.text === 'string' ? (r as Json).text : ''))
            .join('')
        : ''
    })
    .join('\n')
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function blankSlide(n: number): FakeSlide {
  return { path: `ppt/slides/slide${n}.xml`, elements: [], hidden: false, comments: [] }
}

function makeOpened(slides: FakeSlide[], cx: number, cy: number, nextId: number): FakeOpened {
  const opened: FakeOpened = {
    deck: { slides, size: { cx, cy } },
    archive: undefined as unknown as FakeArchive,
    nextId,
    master: [textElement('m0', 'Title')],
  }
  opened.archive = new FakeArchive(() => opened)
  return opened
}

/** the bytes `savePptx` writes: a line per slide */
export function toBytes(opened: FakeOpened): Uint8Array {
  let text = `FAKEPPTX ${opened.deck.size.cx} ${opened.deck.size.cy} ${opened.nextId}\n`
  for (const slide of opened.deck.slides) {
    const elements = slide.elements.map((e) => `${e.id}=${elementText(e).replaceAll('|', '/')}`)
    text += `${slide.path} ${slide.hidden ? 1 : 0} ${elements.join('|')}\n`
  }
  return new TextEncoder().encode(text)
}

function fromBytes(bytes: Uint8Array): FakeOpened | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const head = lines.shift()?.match(/^FAKEPPTX (\S+) (\S+) (\S+)$/)
  if (!head) return null
  const [cx, cy, nextId] = [Number(head[1]), Number(head[2]), Number(head[3])]
  if (![cx, cy, nextId].every(Number.isFinite)) return null
  const slides: FakeSlide[] = []
  for (const line of lines) {
    const first = line.indexOf(' ')
    const second = first < 0 ? -1 : line.indexOf(' ', first + 1)
    if (first < 0 || second < 0) return null
    const elements = line
      .slice(second + 1)
      .split('|')
      .filter((e) => e !== '')
      .flatMap((e) => {
        const eq = e.indexOf('=')
        return eq < 0 ? [] : [textElement(e.slice(0, eq), e.slice(eq + 1))]
      })
    slides.push({
      path: line.slice(0, first),
      hidden: line.slice(first + 1, second) === '1',
      elements,
      comments: [],
    })
  }
  return makeOpened(slides, cx, cy, nextId)
}

const renderElements = (elements: FakeElement[]) =>
  elements.map((e) => ({ id: e.id, text: elementText(e) }))

export interface EngineBox {
  log: (line: unknown[]) => void
  blankSlides: number
}

/** `check` of fake.rs: the failure of one op against `working`, if it cannot apply */
function check(working: Working, op: Json): string | undefined {
  const name = str(op.op) ?? ''
  const target = (op.target ?? {}) as Json
  if (typeof target.part === 'string') {
    if (target.part !== MASTER_PART) return 'part not found'
    if (name === 'addElement') return undefined
    if (name === 'setText' || name === 'deleteElement') {
      const id = str(target.el) ?? ''
      return working.master.some((e) => e.id === id) ? undefined : `element ${id} not found`
    }
    return `unsupported op ${name}`
  }
  const slide = num(target.slide)
  const slideOk =
    slide !== undefined && Number.isInteger(slide) && slide >= 0 && slide < working.slides.length
  switch (name) {
    case 'addElement':
    case 'setHidden':
    case 'deleteSlide':
    case 'duplicateSlide':
    case 'addComment':
    case 'addPicture':
      return slideOk ? undefined : 'slide not found'
    case 'setText':
    case 'deleteElement': {
      if (!slideOk) return 'slide not found'
      const id = str(target.el) ?? ''
      return working.slides[slide].elements.some((e) => e.id === id)
        ? undefined
        : `element ${id} not found`
    }
    case 'deleteComment': {
      if (!slideOk) return 'slide not found'
      const idx = num(op.idx) ?? -1
      return idx >= 0 && idx < working.slides[slide].comments.length
        ? undefined
        : 'no such comment'
    }
    default: {
      // any other op addresses a slide, and an element of it, or none
      if (target.slide === undefined) return undefined
      if (!slideOk) return 'slide not found'
      const id = str(target.el)
      return id !== undefined && !working.slides[slide].elements.some((e) => e.id === id)
        ? `element ${id} not found`
        : undefined
    }
  }
}

interface Working {
  slides: FakeSlide[]
  master: FakeElement[]
  nextId: number
}

interface TxnRecord {
  op: Json
  slideId?: string
  created?: string[]
  after: undefined
}

function apply(working: Working, op: Json): TxnRecord {
  const name = str(op.op) ?? ''
  const target = (op.target ?? {}) as Json
  if (typeof target.part === 'string') {
    let created: string[] | undefined
    if (name === 'addElement') {
      const id = `m${working.nextId++}`
      working.master.push(textElement(id, paragraphsText(op.paragraphs)))
      created = [id]
    } else if (name === 'setText') {
      const el = working.master.find((e) => e.id === str(target.el))
      if (el) el.text = textElement('', paragraphsText(op.paragraphs)).text
    } else if (name === 'deleteElement') {
      working.master = working.master.filter((e) => e.id !== str(target.el))
    }
    return { op, ...(created ? { created } : {}), after: undefined }
  }
  const slideGiven = num(target.slide) !== undefined
  const slide = num(target.slide) ?? 0
  let created: string[] | undefined
  const here = working.slides[slide]
  switch (name) {
    case 'addElement': {
      const id = `e${working.nextId++}`
      here.elements.push(textElement(id, paragraphsText(op.paragraphs)))
      created = [id]
      break
    }
    case 'setText': {
      const el = here.elements.find((e) => e.id === str(target.el))
      if (el) el.text = textElement('', paragraphsText(op.paragraphs)).text
      break
    }
    case 'deleteElement':
      here.elements = here.elements.filter((e) => e.id !== str(target.el))
      break
    case 'setHidden':
      here.hidden = op.hidden === true
      break
    case 'deleteSlide':
      working.slides.splice(slide, 1)
      break
    case 'duplicateSlide': {
      const copy = structuredClone(here)
      copy.path = `ppt/slides/slide${working.nextId + 100}.xml`
      working.nextId += 1
      working.slides.splice(slide + 1, 0, copy)
      break
    }
    case 'addComment':
      here.comments.push({ author: str(op.author) ?? '', text: str(op.text) ?? '' })
      break
    case 'deleteComment':
      here.comments.splice(num(op.idx) ?? 0, 1)
      break
    case 'addPicture': {
      const id = `e${working.nextId++}`
      here.elements.push(textElement(id, `picture:${str(op.ext) ?? ''}`))
      created = [id]
      break
    }
  }
  if (CREATING.includes(name)) {
    const id = `e${working.nextId++}`
    here?.elements.push(textElement(id, name))
    created = [id]
  }
  const after = (): unknown => {
    switch (name) {
      case 'applyTheme':
        return { patched: 1, remapped: 0 }
      case 'findReplace':
        return { count: 1, changedSlides: [0] }
      case 'tableStructure':
      case 'tableMerge':
        return { elementId: str(target.el) ?? '' }
      case 'pasteSlide':
      case 'insertSlidePptx':
        return { index: slide + 1 }
      case 'addSection':
      case 'renameSection':
      case 'removeSection':
      case 'moveSection':
      case 'setSections':
        return { section: name }
      case 'addPicture':
      case 'replacePicture':
      case 'setBackground':
        return { mediaPath: 'ppt/media/image1.png' }
      default:
        return undefined
    }
  }
  return {
    op,
    ...(slideGiven ? { slideId: `slide-${slide}` } : {}),
    ...(created ? { created } : {}),
    after: after(),
  }
}

/** the fakes of `@seuoffice/pptx-engine`, `pptx-ops` and `pptx-render` */
export function makeEngine(box: EngineBox) {
  const log = (...line: unknown[]) => box.log(line)
  const engine = {
    async createBlankPptx(): Promise<Uint8Array> {
      log('pptx-engine.createBlankPptx')
      const count = Math.max(0, box.blankSlides)
      const slides = Array.from({ length: count }, (_, i) => blankSlide(i + 1))
      return toBytes(makeOpened(slides, 9_144_000, 5_143_500, 1))
    },
    async openPptx(bytes: Uint8Array): Promise<FakeOpened> {
      log('pptx-engine.openPptx', bytes.byteLength)
      const opened = fromBytes(bytes)
      if (!opened) throw new Error('not a pptx')
      return opened
    },
    setSlideSize(opened: FakeOpened, cx: number, cy: number): void {
      log('pptx-engine.setSlideSize', cx, cy)
      opened.deck.size = { cx, cy }
    },
    async savePptx(opened: FakeOpened): Promise<Uint8Array> {
      log('pptx-engine.savePptx')
      return toBytes(opened)
    },
    async savePptxToFile(opened: FakeOpened, path: string): Promise<void> {
      log('pptx-engine.savePptxToFile')
      writeFileSync(path, toBytes(opened))
    },
    commitSaved(opened: FakeOpened): void {
      for (const slide of opened.deck.slides) delete slide.structureDirty
    },
    reparseDeck: (opened: FakeOpened) => opened,
    materializeSlide: (opened: FakeOpened, index: number) => opened.deck.slides[index] ?? null,
    slideDurableId: (slide: FakeSlide) => `slide-${currentSlides.indexOf(slide)}`,
    parseTheme: () => ({ minorFont: 'Calibri' }),
    listEmbeddedFonts: () => [],
    getSections: () => [],
    // the fake merge: every slide of the page lands at the end under the Rust fake's path rule
    mergeSlideFromPptx: async (base: FakeOpened & { mergeN?: number }, bytes: Uint8Array) => {
      const page = fromBytes(bytes)
      if (!page) throw new Error('not a pptx')
      const n = base.mergeN ?? 0
      base.mergeN = n + 1
      for (const slide of page.deck.slides) {
        slide.path = `ppt/slides/slide${base.deck.slides.length + n + 1}.xml`
        base.deck.slides.push(slide)
      }
    },
    promoteSlideBackground: () => {},
    autofitGeneratedTextBoxes: () => {},
    extractMergeSlideSource: async (bytes: Uint8Array) => {
      const page = fromBytes(bytes)
      const slide = page?.deck.slides[0]
      return slide
        ? { partPath: slide.path, hidden: slide.hidden, elements: renderElements(slide.elements) }
        : null
    },
    copySlide: (opened: FakeOpened, index: number) => {
      const slide = opened.deck.slides[index]
      return slide
        ? { partPath: slide.path, hidden: slide.hidden, elements: renderElements(slide.elements) }
        : null
    },
    copyElementData: (_opened: FakeOpened, _slide: number, el: FakeElement) => ({
      id: el.id,
      text: elementText(el),
    }),
    getSlideNotes: () => '',
    getSlideComments: (archive: FakeArchive, path: string) =>
      (archive.slides().find((s) => s.path === path)?.comments ?? []).map((c, idx) => ({
        author: c.author,
        text: c.text,
        idx,
      })),
    getElementLink: () => null,
    getSlideLinks: () => [],
    getRunLinks: () => [],
    readHeaderFooter: () => ({ footer: null, slideNum: false, date: null }),
    getSlideTransition: () => 'none',
    getSlideAdvanceTime: () => null,
    narrationSpids: () => [] as string[],
    getSlideAnimations: () => [],
    elementSpid: () => undefined,
    listMasterParts: () => [{ partPath: MASTER_PART, kind: 'master', name: 'Office Theme' }],
    parseMasterPart: (archive: FakeArchive, partPath: string) => {
      if (partPath !== MASTER_PART) return null
      const owner = archive.owner()
      return { path: partPath, elements: structuredClone(owner.master) }
    },
    ensureBuiltinLayout: (_archive: unknown, _size: unknown, key: string) =>
      `ppt/slideLayouts/builtin-${key}.xml`,
    listSlideLayouts: () => [] as unknown[],
    shouldOfferBuiltinLayouts: () => false,
    builtinLayoutInfos: () => [] as unknown[],
  }
  let currentSlides: FakeSlide[] = []

  const ops = {
    runTxn(opened: FakeOpened, req: Json) {
      const list = (req.ops as Json[]) ?? []
      const dryRun = req.dryRun === true
      log('pptx-ops.runTxn', list.length, dryRun)
      currentSlides = opened.deck.slides
      const working: Working = {
        slides: structuredClone(opened.deck.slides),
        master: structuredClone(opened.master),
        nextId: opened.nextId,
      }
      const failures: { index: number; error: string }[] = []
      const records: TxnRecord[] = []
      list.forEach((op, index) => {
        const error = check(working, op)
        if (error !== undefined) failures.push({ index, error })
        else if (!dryRun) records.push(apply(working, op))
      })
      const perOp = req.isolation === 'per_op'
      const blocked = perOp ? failures.length >= list.length : failures.length > 0
      const applied = !dryRun && !blocked && records.length > 0
      if (applied) {
        opened.deck.slides = working.slides
        opened.master = working.master
        opened.nextId = working.nextId
        for (const slide of opened.deck.slides) slide.structureDirty = true
        currentSlides = opened.deck.slides
        // the seeded master slides of a master edit follow the live master
        const parts = req.parts as Map<string, { elements: FakeElement[] }> | undefined
        for (const slide of parts?.values() ?? []) slide.elements = structuredClone(opened.master)
      }
      const shown = applied || dryRun ? records : []
      return {
        applied,
        ...(failures.length > 0 ? { failures } : {}),
        ...(shown.length > 0 ? { records: shown } : {}),
        ...(dryRun ? { plan: [] } : {}),
      }
    },
    mapScriptOps: () => [] as unknown[],
  }

  const render = {
    buildRenderSlide(slide: FakeSlide & { hidden?: boolean }) {
      return {
        partPath: slide.path,
        ...(typeof slide.hidden === 'boolean' ? { hidden: slide.hidden } : {}),
        elements: renderElements(slide.elements),
      }
    },
    imageDpiFromBytes: () => undefined,
  }
  const pipelines = {
    parsePageSpec: (json: string) =>
      json === '' ? { ok: false, error: 'empty page spec' } : { ok: true, spec: json },
    async buildPagePptx(spec: string) {
      log('pipelines.buildPagePptx', spec.length)
      const slides = [blankSlide(1)]
      slides[0].elements.push(textElement('e0', spec))
      return { bytes: toBytes(makeOpened(slides, 9_144_000, 5_143_500, 1)), imageFailures: [] }
    },
  }
  return { engine, ops, render, pipelines, fromFile: (path: string) => readFileSync(path) }
}
