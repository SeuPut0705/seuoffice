/** Page-level rules: TOC pages, ranges, degraded pages, fingerprints, progress (spec §1). */
import { describe, expect, it } from 'vitest'
import type { OcrEngine } from '../../pdf2docx/src/ocr'
import { encodeRgbaPng } from '../../pdf2docx/src/extract'
import { withPdfDocument } from '../../pdf2docx/src/extract'
import { extractDocumentTree, PageRangeError } from '../src/tree'
import { subsetWithPdfium } from '../src/tree/pdfium-doc'
import {
  buildLatin1TextPdf,
  buildPdf,
  buildScannedPdf,
  loadPdfium,
  type PageItem,
  type TextItem,
} from './helpers/fixtures'
import { blockText, bodyBlocks } from './helpers/tree'

const line = (text: string, y: number, size = 12, x = 72): TextItem => ({
  kind: 'text',
  text,
  x,
  y,
  size,
})

const body = (tag: string, yTop: number, count = 3): PageItem[] =>
  Array.from({ length: count }, (_, i) =>
    line(`Paragraph ${tag} line ${i + 1} runs on with ordinary words.`, yTop - i * 14),
  )

const tocPage = (): PageItem[] => [
  line('Contents', 740),
  line('Introduction ............................ 2', 700),
  line('Methods ................................. 2', 680),
  line('Results ................................. 2', 660),
]

describe('printed TOC pages', () => {
  it('drops a page made mostly of TOC entries from the body', async () => {
    const pdf = await buildPdf([
      tocPage(),
      [line('Introduction', 740), ...body('a', 700), line('Methods', 620), line('Results', 560)],
    ])
    const { tree } = await extractDocumentTree(pdf, { pdfium: await loadPdfium() })
    expect(tree.pages.map((p) => p.status)).toEqual(['toc', 'text'])
    expect(tree.blocks.filter((b) => b.page === 1)).toEqual([])
    expect(tree.toc).toHaveLength(3)
  })

  it('keeps a page with a few leader lines among prose', async () => {
    const pdf = await buildPdf([
      [
        ...body('a', 740),
        line('Introduction ............................ 2', 680),
        ...body('b', 640),
        ...body('c', 580),
        ...body('d', 520),
        ...body('e', 460),
      ],
    ])
    const { tree } = await extractDocumentTree(pdf, { pdfium: await loadPdfium() })
    expect(tree.pages[0]!.status).toBe('text')
    expect(bodyBlocks(tree).some((b) => blockText(b).includes('Paragraph a line 1'))).toBe(true)
  })
})

describe('page range', () => {
  const threePages = () =>
    buildPdf(
      [
        [line('First page title', 740), ...body('a', 700)],
        [line('Second page title', 740), ...body('b', 700)],
        [line('Third page title', 740), ...body('c', 700)],
      ],
      { outline: [{ title: 'Second page title', page: 1 }] },
    )

  it('analyzes only the chosen pages and keeps original numbering', async () => {
    const { tree } = await extractDocumentTree(await threePages(), {
      pdfium: await loadPdfium(),
      pages: [2],
    })
    expect(tree.sourcePageCount).toBe(3)
    expect(tree.pages.map((p) => p.page)).toEqual([2])
    expect(new Set(tree.blocks.map((b) => b.page))).toEqual(new Set([2]))
    expect(tree.blocks.find((b) => blockText(b) === 'Second page title')).toMatchObject({
      kind: 'heading',
      levelSource: 'bookmark',
    })
    expect(tree.outline).toEqual([{ title: 'Second page title', level: 1, page: 2 }])
  })

  it('rejects a range outside the document', async () => {
    const pdf = await threePages()
    const run = extractDocumentTree(pdf, { pdfium: await loadPdfium(), pages: [2, 4] })
    await expect(run).rejects.toBeInstanceOf(PageRangeError)
    await expect(run).rejects.toMatchObject({ validRange: { first: 1, last: 3 } })
  })
})

describe('degraded and scanned pages', () => {
  it('turns a scanned page into a page-image block', async () => {
    const { tree } = await extractDocumentTree(await buildScannedPdf(), {
      pdfium: await loadPdfium(),
    })
    expect(tree.pages[0]!.status).toBe('scanned')
    const blocks = bodyBlocks(tree)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'pageImage', reason: 'scanned', mime: 'image/png' })
    if (blocks[0]!.kind === 'pageImage') expect(blocks[0]!.data.length).toBeGreaterThan(0)
  })

  it('turns a page with unreliable text encoding into a page image, never garbled text', async () => {
    const gibberish = [
      '¯?vxwn~·Ï¯¿²xvå{¾x{q»2wn{zq»¯¯ÿ»ùüñüóø1o~',
      'µöö½¹ø²Wy»±{Oÿowr»2ÿï~abcwn´»ùüõ³û¿üÿ¸·û²',
      'ù´ö³óÀ~ßýö¿ûó¿ÿ·üówwnÏ¸óóû´·üó (abc def)',
    ]
    const { tree } = await extractDocumentTree(await buildLatin1TextPdf(gibberish), {
      pdfium: await loadPdfium(),
    })
    expect(tree.pages[0]).toMatchObject({ status: 'degraded', reason: 'bad-tounicode' })
    expect(bodyBlocks(tree)).toEqual([
      expect.objectContaining({ kind: 'pageImage', reason: 'degraded', detail: 'bad-tounicode' }),
    ])
  })

  it('keeps accent-heavy real text as text', async () => {
    const portuguese = [
      'As diferenças na concentração de solutos através das membranas',
      'celulares são geradas e mantidas por mecanismos de transporte que',
    ]
    const { tree } = await extractDocumentTree(await buildLatin1TextPdf(portuguese), {
      pdfium: await loadPdfium(),
    })
    expect(tree.pages[0]!.status).toBe('text')
    expect(bodyBlocks(tree).some((b) => blockText(b).includes('concentração'))).toBe(true)
  })

  const fakeOcr =
    (confidence: number): OcrEngine =>
    () => ({
      lines: [
        {
          text: 'Recovered scan text line one',
          confidence,
          box: { x0: 0.1, y0: 0.8, x1: 0.7, y1: 0.82 },
        },
        {
          text: 'and its second line follows',
          confidence,
          box: { x0: 0.1, y0: 0.77, x1: 0.68, y1: 0.79 },
        },
      ],
    })

  it('keeps OCR-recovered text as text', async () => {
    const { tree } = await extractDocumentTree(await buildScannedPdf(), {
      pdfium: await loadPdfium(),
      ocr: fakeOcr(0.95),
    })
    expect(tree.pages[0]!.status).toBe('ocr')
    const blocks = bodyBlocks(tree)
    expect(blocks.some((b) => b.kind === 'pageImage')).toBe(false)
    expect(blocks.some((b) => blockText(b).includes('Recovered scan text'))).toBe(true)
    expect(blocks.every((b) => b.source === 'ocr')).toBe(true)
  })

  it('keeps the page image when OCR confidence is too low', async () => {
    const { tree } = await extractDocumentTree(await buildScannedPdf(), {
      pdfium: await loadPdfium(),
      ocr: fakeOcr(0.4),
    })
    expect(bodyBlocks(tree).map((b) => b.kind)).toEqual(['pageImage'])
  })
})

describe('page fingerprints', () => {
  const bluePng = (): Uint8Array => {
    const px = new Uint8Array(8 * 8 * 4)
    for (let i = 0; i < 64; i++) px.set([30, 30, 220, 255], i * 4)
    return encodeRgbaPng(px, 8, 8)
  }
  const A: PageItem[] = [line('Alpha page content', 740), ...body('a', 700)]
  const B: PageItem[] = [
    line('Beta page content', 740),
    { kind: 'image', x: 100, y: 400, width: 100, height: 100 },
  ]
  const B2: PageItem[] = [
    line('Beta page content', 740),
    { kind: 'image', x: 100, y: 400, width: 100, height: 100, png: bluePng() },
  ]
  const C: PageItem[] = [line('Gamma page content', 740), ...body('c', 700)]

  it('is stable when page order changes', async () => {
    const pdfium = await loadPdfium()
    const abc = await extractDocumentTree(await buildPdf([A, B, C]), { pdfium })
    const cab = await extractDocumentTree(await buildPdf([C, A, B]), { pdfium })
    const [fa, fb, fc] = abc.fingerprints.map((f) => f.fingerprint)
    expect(cab.fingerprints.map((f) => f.fingerprint)).toEqual([fc, fa, fb])
    expect(new Set([fa, fb, fc]).size).toBe(3)
    // every block carries its page's fingerprint
    for (const b of abc.tree.blocks) {
      expect(b.pageFingerprint).toBe(abc.fingerprints.find((f) => f.page === b.page)!.fingerprint)
    }
  })

  it('is the same when the page is analyzed inside a range', async () => {
    const pdfium = await loadPdfium()
    const pdf = await buildPdf([A, B, C])
    const full = await extractDocumentTree(pdf, { pdfium })
    const part = await extractDocumentTree(pdf, { pdfium, pages: [3] })
    expect(part.fingerprints).toEqual([{ page: 3, fingerprint: full.fingerprints[2]!.fingerprint }])
  })

  it('is the same in a PDFium page copy (the encrypted-source range path)', async () => {
    const pdfium = await loadPdfium()
    const pdf = await buildPdf([A, B, C])
    const full = await extractDocumentTree(pdf, { pdfium })
    const copy = withPdfDocument(pdfium, pdf, (doc) => subsetWithPdfium(pdfium, doc, [1, 2]))
    expect(copy).not.toBeNull()
    const part = await extractDocumentTree(copy!, { pdfium })
    expect(part.fingerprints.map((f) => f.fingerprint)).toEqual(
      full.fingerprints.slice(1).map((f) => f.fingerprint),
    )
  })

  it('changes when an image changes', async () => {
    const pdfium = await loadPdfium()
    const one = await extractDocumentTree(await buildPdf([B]), { pdfium })
    const two = await extractDocumentTree(await buildPdf([B2]), { pdfium })
    expect(one.fingerprints[0]!.fingerprint).not.toBe(two.fingerprints[0]!.fingerprint)
  })
})

describe('progress, cancellation and document info', () => {
  const pages = () =>
    buildPdf([[line('One', 740)], [line('Two', 740)], [line('Three', 740)]], {
      info: { title: 'Report', author: 'Kim', subject: 'Tests', keywords: ['pdf', 'tree'] },
    })

  it('reports progress per page and reads the document info', async () => {
    const calls: Array<[number, number]> = []
    const { tree } = await extractDocumentTree(await pages(), {
      pdfium: await loadPdfium(),
      onProgress: (done, total) => calls.push([done, total]),
    })
    expect(calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
    expect(tree.info).toEqual({
      title: 'Report',
      author: 'Kim',
      subject: 'Tests',
      keywords: 'pdf tree',
    })
  })

  it('stops as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const calls: number[] = []
    const run = extractDocumentTree(await pages(), {
      pdfium: await loadPdfium(),
      signal: controller.signal,
      onProgress: (done) => {
        calls.push(done)
        controller.abort()
      },
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([1])
  })

  it('does not start with an already aborted signal', async () => {
    const calls: number[] = []
    const run = extractDocumentTree(await pages(), {
      pdfium: await loadPdfium(),
      signal: AbortSignal.abort(),
      onProgress: (done) => calls.push(done),
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
  })
})
