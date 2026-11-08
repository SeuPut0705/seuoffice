import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import {
  PdfToolRefusal,
  MAX_PASSWORD_BYTES,
  checkOptions,
  encryptedPageCount,
  foundBlankPagesOf,
  inspectImage,
  inspectPdf,
  isPdfToolId,
  jobBytesOf,
  outputNames,
  pagesToText,
  runPdfTool,
  toolAccepts,
  toolInputKind,
  toolMinInputs,
  toolOutputExtension,
  toolRunsAsJob,
  toolTakesMany,
} from '../src/main/pdf-tools/tools'
import { PDF_TOOL_ANNOT_KINDS } from '../src/shared/pdf-tools-api'
import { ANNOT_KINDS } from '../../pdf/src/main/annot-strip'

/**
 * The PDF tools window's work: each tool's file is read back (page count,
 * order, size, rotation) and the source bytes are never touched.
 */

/** pages whose widths 100, 101, … tell them apart after any reorder */
async function pdf(pageCount: number, base = 100): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) doc.addPage([base + i, 300])
  return doc.save({ useObjectStreams: false })
}

async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((p) => Math.round(p.getWidth()))
}

/** a PDF whose trailer names an encryption dictionary */
async function encryptedPdf(): Promise<Uint8Array> {
  const text = Buffer.from(await pdf(1)).toString('latin1')
  const marked = text.replace(/trailer\s*<</, (m) => `${m}\n/Encrypt << /Filter /Standard >>`)
  expect(marked).not.toBe(text)
  return new Uint8Array(Buffer.from(marked, 'latin1'))
}

/** A real grey RGB PNG */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([len, typed, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/** a PDF with one line of text per entry; '' makes a page without text */
async function textPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const line of lines) {
    const page = doc.addPage([300, 300])
    if (line) page.drawText(line, { x: 20, y: 200, size: 14, font })
  }
  return doc.save({ useObjectStreams: false })
}

async function runUntouched(
  tool: Parameters<typeof runPdfTool>[0],
  inputs: Uint8Array[],
  options: Parameters<typeof runPdfTool>[2],
): Promise<Uint8Array[]> {
  const before = inputs.map((b) => Buffer.from(b))
  const out = await runPdfTool(tool, inputs, options)
  inputs.forEach((b, i) => expect(Buffer.from(b).equals(before[i]!)).toBe(true))
  return out
}

describe('reading a picked PDF', () => {
  it('counts the pages of a PDF', async () => {
    expect(await inspectPdf(await pdf(3))).toEqual({ ok: true, pages: 3 })
  })

  it('names a password-protected PDF and bytes that are no PDF', async () => {
    expect(await inspectPdf(await encryptedPdf())).toEqual({ ok: false, problem: 'encrypted' })
    expect(await inspectPdf(new TextEncoder().encode('not a pdf'))).toEqual({
      ok: false,
      problem: 'unreadable',
    })
  })

  it('takes a JPEG or PNG picture as one page and names anything else', () => {
    expect(inspectImage(png(4, 3))).toEqual({ ok: true, pages: 1 })
    expect(inspectImage(new TextEncoder().encode('%PDF-1.7'))).toEqual({
      ok: false,
      problem: 'not-image',
    })
  })
})

describe('checking options', () => {
  it('takes a page range only when every page exists', () => {
    expect(checkOptions('extract', { pages: '3-1, 5' }, 5)).toEqual({
      ok: true,
      options: { pages: '1,2,3,5' },
    })
    expect(checkOptions('extract', { pages: '2-9' }, 5)).toEqual({ ok: false, error: 'range' })
    expect(checkOptions('extract', { pages: 'abc' }, 5)).toEqual({ ok: false, error: 'range' })
    expect(checkOptions('extract', {}, 5)).toEqual({ ok: false, error: 'range' })
  })

  it('falls back to the dialog defaults for anything out of range', () => {
    expect(checkOptions('split', { chunkSize: 0 }, 4).options).toEqual({ chunkSize: 1 })
    expect(checkOptions('split', { chunkSize: 9 }, 4).options).toEqual({ chunkSize: 1 })
    expect(checkOptions('nup', { perSheet: 40, direction: 'diagonal' }, 4).options).toEqual({
      perSheet: 2,
      direction: 'horizontal',
      separator: false,
    })
    expect(checkOptions('rotate', { rotation: 45 }, 4).options).toEqual({ rotation: 90 })
    expect(checkOptions('pageSize', { paper: 'B5' }, 4).options).toEqual({ paper: 'A4' })
    expect(checkOptions('splitPages', { perPage: 3 }, 4).options).toEqual({ perPage: 2 })
    expect(checkOptions('imagesToPdf', { imagePaper: 'B5', margin: 'huge' }, 1).options).toEqual({
      imagePaper: 'A4',
      margin: 'small',
    })
    expect(checkOptions('imagesToPdf', { imagePaper: 'image', margin: 'none' }, 1).options).toEqual(
      { imagePaper: 'image', margin: 'none' },
    )
    expect(checkOptions('toText', { pages: '1' }, 3).options).toEqual({})
    expect(checkOptions('duplex', { sheetPages: 3 }, 3).options).toEqual({ sheetPages: 1 })
    expect(checkOptions('duplex', { sheetPages: 4 }, 3).options).toEqual({ sheetPages: 4 })
    expect(checkOptions('overlay', { layer: 'side', backgroundPage: 5 }, 3, 2).options).toEqual({
      layer: 'behind',
      backgroundPage: 1,
      applyPages: '',
    })
    expect(
      checkOptions('overlay', { layer: 'front', backgroundPage: 2, applyPages: '3,1' }, 3, 2)
        .options,
    ).toEqual({ layer: 'front', backgroundPage: 2, applyPages: '1,3' })
    expect(checkOptions('stripAnnots', {}, 3).options).toEqual({
      annotKinds: ['comments', 'highlights', 'drawings', 'stamps', 'other'],
      applyPages: '',
    })
    expect(
      checkOptions('stripAnnots', { annotKinds: ['links', 'bogus'], applyPages: '2' }, 3).options,
    ).toEqual({ annotKinds: ['links'], applyPages: '2' })
    expect(checkOptions('stripAnnots', { annotKinds: [] }, 3)).toEqual({
      ok: false,
      error: 'no-kinds',
    })
    expect(checkOptions('compress', {}, 3).options).toEqual({ compressLevel: 'medium' })
    expect(checkOptions('compress', { compressLevel: 'strong' }, 3).options).toEqual({
      compressLevel: 'strong',
    })
    expect(checkOptions('compress', { compressLevel: 'max' }, 3).options).toEqual({
      compressLevel: 'medium',
    })
    expect(checkOptions('blankPages', { removePages: '4, 2,2,9' }, 5).options).toEqual({
      removePages: '2,4',
    })
    expect(checkOptions('blankPages', { removePages: '' }, 5)).toEqual({
      ok: false,
      error: 'none-chosen',
    })
    expect(checkOptions('blankPages', { removePages: '1,2' }, 2)).toEqual({
      ok: false,
      error: 'all-pages',
    })
    expect(checkOptions('overlay', { applyPages: '4' }, 3, 1)).toEqual({
      ok: false,
      error: 'range',
    })
  })

  it('takes passwords exactly as typed, and checks them before anything runs', () => {
    expect(checkOptions('encrypt', { password: ' a b ', passwordConfirm: 'x' }, 1)).toEqual({
      ok: true,
      options: { password: ' a b ' },
    })
    expect(checkOptions('encrypt', { password: '' }, 1)).toEqual({
      ok: false,
      error: 'password-empty',
    })
    expect(checkOptions('encrypt', { password: 'a', restrict: true }, 1)).toEqual({
      ok: false,
      error: 'password-empty',
    })
    expect(
      checkOptions('encrypt', { password: 'a', restrict: true, permissionPassword: 'a' }, 1),
    ).toEqual({ ok: false, error: 'password-same' })
    expect(
      checkOptions('encrypt', { password: 'a', restrict: true, permissionPassword: 'b' }, 1),
    ).toEqual({ ok: true, options: { password: 'a', restrict: true, permissionPassword: 'b' } })
    // 127 bytes of UTF-8 is the most AES-256 keeps: 42 Korean syllables fit, 43 do not
    expect(MAX_PASSWORD_BYTES).toBe(127)
    expect(checkOptions('encrypt', { password: '가'.repeat(42) }, 1).ok).toBe(true)
    expect(checkOptions('encrypt', { password: '가'.repeat(43) }, 1)).toEqual({
      ok: false,
      error: 'password-long',
    })
    expect(checkOptions('decrypt', {}, 1)).toEqual({ ok: false, error: 'password-empty' })
    expect(checkOptions('decrypt', { password: 'p', restrict: true }, 1)).toEqual({
      ok: true,
      options: { password: 'p' },
    })
    expect(checkOptions('repair', { password: 'p' }, 0)).toEqual({ ok: true, options: {} })
  })

  it('takes password-protected PDFs only to remove the password, and damaged ones only to repair', async () => {
    expect(toolAccepts('decrypt')).toBe('encrypted')
    expect(toolAccepts('repair')).toBe('damaged')
    expect(toolAccepts('encrypt')).toBe('pdf')
    expect(toolAccepts('merge')).toBe('pdf')
    for (const tool of ['encrypt', 'decrypt', 'repair'] as const) {
      expect(toolRunsAsJob(tool)).toBe(true)
      await expect(runPdfTool(tool, [await pdf(1)], {})).rejects.toThrow(/runs as a job/)
    }
    expect(toolRunsAsJob('compress')).toBe(false)
    expect(await encryptedPageCount(await encryptedPdf())).toBe(1)
    expect(await encryptedPageCount(new TextEncoder().encode('nothing'))).toBe(0)
  })

  it('reads only bytes from a tool job', () => {
    const bytes = new Uint8Array([1, 2])
    expect(jobBytesOf({ bytes })).toBe(bytes)
    expect(jobBytesOf({ bytes: new Uint8Array(0) })).toBeNull()
    expect(jobBytesOf({ bytes: [1, 2] })).toBeNull()
    expect(jobBytesOf(null)).toBeNull()
  })

  it('keeps only the options the tool reads', () => {
    expect(checkOptions('reverse', { pages: '1', chunkSize: 2 }, 3).options).toEqual({})
  })

  it('knows its tools and which one takes several files', () => {
    expect(isPdfToolId('merge')).toBe(true)
    expect(isPdfToolId('stamps')).toBe(false)
    expect(isPdfToolId(undefined)).toBe(false)
    expect(toolTakesMany('merge')).toBe(true)
    expect(toolTakesMany('split')).toBe(false)
    expect(toolTakesMany('imagesToPdf')).toBe(true)
    expect(toolTakesMany('duplex')).toBe(true)
    expect(toolMinInputs('duplex')).toBe(1)
    expect(toolMinInputs('merge')).toBe(2)
    expect(toolMinInputs('imagesToPdf')).toBe(1)
    expect(toolInputKind('imagesToPdf')).toBe('image')
    expect(toolInputKind('toText')).toBe('pdf')
    expect(toolOutputExtension('toText')).toBe('txt')
    expect(toolOutputExtension('imagesToPdf')).toBe('pdf')
  })
})

describe('running each tool', () => {
  it('merges the inputs in the given order', async () => {
    const [out] = await runUntouched('merge', [await pdf(2, 100), await pdf(1, 200)], {})
    expect(await widths(out!)).toEqual([100, 101, 200])
  })

  it('splits into files of the chosen page count', async () => {
    const parts = await runUntouched('split', [await pdf(5)], { chunkSize: 2 })
    expect(await Promise.all(parts.map(widths))).toEqual([[100, 101], [102, 103], [104]])
  })

  it('extracts the chosen pages', async () => {
    const [out] = await runUntouched('extract', [await pdf(5)], { pages: '2,4,5' })
    expect(await widths(out!)).toEqual([101, 103, 104])
  })

  it('reverses the page order', async () => {
    const [out] = await runUntouched('reverse', [await pdf(3)], {})
    expect(await widths(out!)).toEqual([102, 101, 100])
  })

  it('rotates every page by the chosen angle', async () => {
    const [out] = await runUntouched('rotate', [await pdf(2)], { rotation: 270 })
    const doc = await PDFDocument.load(out!)
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([270, 270])
  })

  it('places several pages on each sheet', async () => {
    const [out] = await runUntouched('nup', [await pdf(5)], {
      perSheet: 4,
      direction: 'horizontal',
      separator: false,
    })
    expect((await PDFDocument.load(out!)).getPageCount()).toBe(2)
  })

  it('fits every page to the chosen paper', async () => {
    const [out] = await runUntouched('pageSize', [await pdf(2)], { paper: 'A5' })
    const doc = await PDFDocument.load(out!)
    for (const page of doc.getPages()) {
      expect([Math.round(page.getWidth()), Math.round(page.getHeight())]).toEqual([420, 595])
    }
  })

  it('cuts each page into pieces', async () => {
    const [out] = await runUntouched('splitPages', [await pdf(3)], { perPage: 2 })
    expect((await PDFDocument.load(out!)).getPageCount()).toBe(6)
  })

  it('makes one page per picture, in order, on the chosen paper', async () => {
    const [out] = await runUntouched('imagesToPdf', [png(40, 20), png(20, 40)], {
      imagePaper: 'A5',
      margin: 'large',
    })
    const doc = await PDFDocument.load(out!)
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [595, 420],
      [420, 595],
    ])
  })

  it('makes pages the size of each picture when asked', async () => {
    const [out] = await runUntouched('imagesToPdf', [png(40, 20)], {
      imagePaper: 'image',
      margin: 'small',
    })
    const page = (await PDFDocument.load(out!)).getPage(0)
    expect([page.getWidth(), page.getHeight()]).toEqual([30, 15])
  })

  it('saves the text page by page, skipping pages without text', async () => {
    const [out] = await runUntouched('toText', [await textPdf(['Page one', '', 'Page three'])], {})
    expect(new TextDecoder().decode(out!)).toBe('Page one\n\nPage three\n')
  })

  it('pads each file to an even page count before combining them', async () => {
    const [out] = await runUntouched('duplex', [await pdf(3, 100), await pdf(2, 200)], {
      sheetPages: 1,
    })
    expect(await widths(out!)).toEqual([100, 101, 102, 102, 200, 201])
  })

  it('pads to whole sheets when the pages are put several to a side later', async () => {
    const [out] = await runUntouched('duplex', [await pdf(3, 100), await pdf(1, 200)], {
      sheetPages: 2,
    })
    expect(await widths(out!)).toEqual([100, 101, 102, 102, 200, 200, 200, 200])
  })

  it('lays the chosen background page on the chosen pages only', async () => {
    const [out] = await runUntouched('overlay', [await pdf(3, 100), await textPdf(['a', 'b'])], {
      layer: 'behind',
      backgroundPage: 2,
      applyPages: '1,3',
    })
    const doc = await PDFDocument.load(out!)
    expect(await widths(out!)).toEqual([100, 101, 102])
    const drawn = doc
      .getPages()
      .map(
        (p) => p.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0,
      )
    expect(drawn).toEqual([1, 0, 1])
  })

  it('names a PDF with none of the chosen annotations rather than writing a copy', async () => {
    await expect(
      runPdfTool('stripAnnots', [await pdf(2)], { annotKinds: ['comments'], applyPages: '' }),
    ).rejects.toBeInstanceOf(PdfToolRefusal)
  })

  it('offers the same annotation kinds the editor module removes', () => {
    expect([...PDF_TOOL_ANNOT_KINDS]).toEqual([...ANNOT_KINDS])
  })

  it('removes the chosen pages and keeps the rest in order', async () => {
    const [out] = await runUntouched('blankPages', [await pdf(5)], { removePages: '2,4' })
    expect(await widths(out!)).toEqual([100, 102, 104])
  })

  it('makes smaller only with the picture code, and names a file that did not shrink', async () => {
    await expect(runPdfTool('compress', [await pdf(2)], {})).rejects.toThrow()
    // already as small as pdf-lib writes it: nothing to win
    const tight = await (await PDFDocument.load(await pdf(1))).save({ useObjectStreams: true })
    await expect(
      runPdfTool('compress', [tight], { compressLevel: 'light' }, { recode: async () => null }),
    ).rejects.toBeInstanceOf(PdfToolRefusal)
  })

  it('refuses a PDF with no text at all', async () => {
    await expect(runPdfTool('toText', [await textPdf(['', ''])], {})).rejects.toBeInstanceOf(
      PdfToolRefusal,
    )
  })
})

describe('the blank-page job answer', () => {
  const thumb = { width: 2, height: 1, bgra: new Uint8Array(8) }
  it('takes a well-formed answer', () => {
    const value = { pageCount: 3, candidates: [{ page: 2, reason: 'empty', thumb }] }
    expect(foundBlankPagesOf(value)).toEqual(value)
    expect(
      foundBlankPagesOf({
        pageCount: 3,
        candidates: [{ page: 3, reason: 'nearly-white', thumb: null }],
      }),
    ).toEqual({ pageCount: 3, candidates: [{ page: 3, reason: 'nearly-white', thumb: null }] })
  })

  it('refuses pages out of range, unknown reasons and short pixel data', () => {
    expect(
      foundBlankPagesOf({ pageCount: 3, candidates: [{ page: 4, reason: 'empty' }] }),
    ).toBeNull()
    expect(foundBlankPagesOf({ pageCount: 3, candidates: [{ page: 1, reason: 'odd' }] })).toBeNull()
    expect(
      foundBlankPagesOf({
        pageCount: 3,
        candidates: [{ page: 1, reason: 'empty', thumb: { ...thumb, bgra: new Uint8Array(4) } }],
      }),
    ).toBeNull()
    expect(foundBlankPagesOf(null)).toBeNull()
  })
})

describe('text output', () => {
  it('joins the pages with a blank line and ends with one line break', () => {
    expect(pagesToText([{ text: 'a\nb  ' }, { text: '   ' }, { text: 'c' }])).toBe('a\nb\n\nc\n')
  })
})

describe('suggested file names', () => {
  it('names the result after the first source', () => {
    expect(outputNames('merge', 'Report.PDF', 1, {})).toEqual(['Report-merged.pdf'])
    expect(outputNames('nup', 'a.pdf', 1, { perSheet: 4 })).toEqual(['a-4up.pdf'])
    expect(outputNames('pageSize', 'a.pdf', 1, { paper: 'Letter' })).toEqual(['a-Letter.pdf'])
    expect(outputNames('split', 'a.pdf', 3, {})).toEqual(['a-1.pdf', 'a-2.pdf', 'a-3.pdf'])
    expect(outputNames('imagesToPdf', 'Photo 1.JPEG', 1, {})).toEqual(['Photo 1.pdf'])
    expect(outputNames('toText', 'Report.pdf', 1, {})).toEqual(['Report.txt'])
    expect(outputNames('duplex', 'a.pdf', 1, {})).toEqual(['a-duplex.pdf'])
    expect(outputNames('overlay', 'a.pdf', 1, {})).toEqual(['a-background.pdf'])
    expect(outputNames('stripAnnots', 'a.pdf', 1, {})).toEqual(['a-clean.pdf'])
    expect(outputNames('compress', 'a.pdf', 1, {})).toEqual(['a-smaller.pdf'])
    expect(outputNames('encrypt', 'a.pdf', 1, {})).toEqual(['a-locked.pdf'])
    expect(outputNames('decrypt', 'a.pdf', 1, {})).toEqual(['a-unlocked.pdf'])
    expect(outputNames('repair', 'a.pdf', 1, {})).toEqual(['a-repaired.pdf'])
  })
})
