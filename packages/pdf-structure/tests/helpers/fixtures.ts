/**
 * Synthetic PDFs for the document-tree tests. Built with pdf-lib (installed
 * for apps/pdf, resolved from the root node_modules) plus pdf2docx's own
 * fixture helpers, imported by relative path like the package sources.
 */
import type { PDFDocument, PDFFont, PDFPage, PDFRef } from 'pdf-lib'
import { tinyPng } from '../../../pdf2docx/tests/helpers/fixtures'

export { loadPdfium } from '../../../pdf2docx/tests/helpers/wasm'
export {
  buildLatin1TextPdf,
  buildScannedPdf,
  buildTablePdf,
  tinyPng,
} from '../../../pdf2docx/tests/helpers/fixtures'

export interface TextItem {
  kind: 'text'
  text: string
  x: number
  y: number
  size?: number
  bold?: boolean
  /** Courier (fixed pitch): equal-length lines get equal widths */
  mono?: boolean
}

export interface ImageItem {
  kind: 'image'
  x: number
  y: number
  width: number
  height: number
  png?: Uint8Array
}

export interface RuleItem {
  kind: 'rule'
  x1: number
  y1: number
  x2: number
  y2: number
  thickness?: number
}

export type PageItem = TextItem | ImageItem | RuleItem

export interface OutlineItem {
  title: string
  /** 0-based page index the bookmark targets */
  page: number
  children?: OutlineItem[]
}

export interface BuildOptions {
  size?: [number, number]
  info?: { title?: string; author?: string; subject?: string; keywords?: string[] }
  outline?: OutlineItem[]
}

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  mono: PDFFont
  monoBold: PDFFont
}

function drawItems(
  doc: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  items: PageItem[],
): Promise<void> {
  return items.reduce(async (prev, item) => {
    await prev
    if (item.kind === 'text') {
      const font = item.mono
        ? item.bold
          ? fonts.monoBold
          : fonts.mono
        : item.bold
          ? fonts.bold
          : fonts.regular
      page.drawText(item.text, { x: item.x, y: item.y, size: item.size ?? 12, font })
    } else if (item.kind === 'image') {
      const image = await doc.embedPng(item.png ?? tinyPng())
      page.drawImage(image, { x: item.x, y: item.y, width: item.width, height: item.height })
    } else {
      page.drawLine({
        start: { x: item.x1, y: item.y1 },
        end: { x: item.x2, y: item.y2 },
        thickness: item.thickness ?? 0.5,
      })
    }
  }, Promise.resolve())
}

async function addOutline(doc: PDFDocument, items: OutlineItem[]): Promise<void> {
  const { PDFName, PDFHexString, PDFNumber } = await import('pdf-lib')
  const ctx = doc.context
  const pages = doc.getPages()
  const rootRef = ctx.nextRef()
  const build = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = list.map(() => ctx.nextRef())
    list.forEach((item, i) => {
      const dict = ctx.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        Dest: [pages[item.page]!.ref, 'XYZ', null, null, null],
      })
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]!)
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]!)
      if (item.children?.length) {
        const kids = build(item.children, refs[i]!)
        dict.set(PDFName.of('First'), kids.first)
        dict.set(PDFName.of('Last'), kids.last)
        dict.set(PDFName.of('Count'), PDFNumber.of(item.children.length))
      }
      ctx.assign(refs[i]!, dict)
    })
    return { first: refs[0]!, last: refs[refs.length - 1]! }
  }
  const top = build(items, rootRef)
  ctx.assign(
    rootRef,
    ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: items.length }),
  )
  doc.catalog.set(PDFName.of('Outlines'), rootRef)
}

/** one PDF page per item list */
export async function buildPdf(pages: PageItem[][], opts: BuildOptions = {}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  }
  for (const items of pages) {
    const page = doc.addPage(opts.size ?? [612, 792])
    await drawItems(doc, page, fonts, items)
  }
  if (opts.info?.title) doc.setTitle(opts.info.title)
  if (opts.info?.author) doc.setAuthor(opts.info.author)
  if (opts.info?.subject) doc.setSubject(opts.info.subject)
  if (opts.info?.keywords) doc.setKeywords(opts.info.keywords)
  if (opts.outline?.length) await addOutline(doc, opts.outline)
  return doc.save()
}

// ── text helpers ──

/** five-letter words: in Courier every line of k words has the same width */
const WORDS = [
  'alpha',
  'bravo',
  'delta',
  'gamma',
  'omega',
  'sigma',
  'tango',
  'lemon',
  'melon',
  'piano',
  'river',
  'stone',
  'cloud',
  'grass',
  'light',
  'night',
]

/** `count` lines of `perLine` five-letter words, deterministic from `seed` */
export function wordLines(seed: number, count: number, perLine = 9): string[] {
  const lines: string[] = []
  let k = seed
  for (let i = 0; i < count; i++) {
    const words: string[] = []
    for (let j = 0; j < perLine; j++) words.push(WORDS[k++ % WORDS.length]!)
    lines.push(words.join(' '))
  }
  return lines
}

/** a paragraph of mono lines from `yTop` down at `leading` */
export function para(
  lines: string[],
  x: number,
  yTop: number,
  opts: { size?: number; leading?: number; indentFirst?: number } = {},
): TextItem[] {
  const size = opts.size ?? 10
  const leading = opts.leading ?? 13
  return lines.map((text, i) => ({
    kind: 'text' as const,
    text,
    x: x + (i === 0 ? (opts.indentFirst ?? 0) : 0),
    y: yTop - i * leading,
    size,
    mono: true,
  }))
}
