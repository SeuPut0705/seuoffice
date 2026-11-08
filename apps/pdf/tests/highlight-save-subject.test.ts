/**
 * AI highlights in the saved file (reading-assist spec 3.9, 5.7): an accepted
 * suggestion is saved as a /Highlight whose /Subj is its category; a markup
 * without `subject` saves exactly as before (the bytes are compared with a
 * baseline taken from the save code before `subject` existed).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString, degrees } from 'pdf-lib'
import { applySaveRequest } from '../src/main/save-pdf'
import type { MarkupInput, SavePdfRequest } from '../src/shared/ipc'

/** a fixed two-page document (the second rotated): the same bytes on every run */
async function fixedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([400, 500])
  doc.addPage([400, 500]).setRotation(degrees(90))
  return doc.save({ useObjectStreams: false })
}

const request = (markups: MarkupInput[]): SavePdfRequest => ({
  path: '/tmp/test.pdf',
  markups,
  drawings: [],
  formValues: [],
  stamps: [],
})

const MARKUPS: MarkupInput[] = [
  {
    pageIndex: 0,
    type: 'highlight',
    color: [1, 0.87, 0.35],
    quads: [[50, 120, 200, 120, 50, 100, 200, 100]],
  },
  {
    pageIndex: 0,
    type: 'underline',
    color: [0.17, 0.4, 1],
    quads: [[50, 220, 180, 220, 50, 200, 180, 200]],
  },
  {
    pageIndex: 1,
    type: 'strikeout',
    color: [0.86, 0.22, 0.18],
    quads: [[60, 320, 160, 320, 60, 300, 160, 300]],
  },
]

/** taken with the save code before MarkupInput.subject existed */
const BASELINE_INPUT = '5ea9553c3809ce08868b54dfb6386b4a1ccedd14bd8f817c197003ad5cf3cbba'
const BASELINE_OUTPUT = '3928334e29d69dd9c28984fbb16cb53430108541e6c5960502685d5df29d99f4'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function annotsOf(doc: PDFDocument, pageIndex: number): PDFDict[] {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) return []
  return Array.from({ length: annots.size() }, (_, i) => annots.lookup(i, PDFDict))
}

const subjOf = (annot: PDFDict): string | undefined => {
  const v = annot.lookup(PDFName.of('Subj'))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined
}

describe('save-pdf: markup subject', () => {
  it('saves markups without a subject byte for byte as before', async () => {
    const input = await fixedPdf()
    expect(sha(input)).toBe(BASELINE_INPUT)
    const out = await applySaveRequest(input, request(MARKUPS))
    expect(sha(out.bytes)).toBe(BASELINE_OUTPUT)
  })

  it('treats an empty or non-string subject as none', async () => {
    const input = await fixedPdf()
    const odd = MARKUPS.map((m, i) =>
      i === 0 ? { ...m, subject: '' } : i === 1 ? { ...m, subject: 7 as unknown as string } : m,
    )
    const out = await applySaveRequest(input, request(odd))
    expect(sha(out.bytes)).toBe(BASELINE_OUTPUT)
  })

  it('writes the subject as /Subj on an accepted highlight only', async () => {
    const input = await fixedPdf()
    const out = await applySaveRequest(
      input,
      request([{ ...MARKUPS[0]!, color: [0.4, 0.8, 0.4], subject: '핵심 주장' }, MARKUPS[1]!]),
    )
    const doc = await PDFDocument.load(out.bytes)
    const [highlight, underline] = annotsOf(doc, 0)
    expect(highlight!.lookup(PDFName.of('Subtype'), PDFName).decodeText()).toBe('Highlight')
    expect(subjOf(highlight!)).toBe('핵심 주장')
    expect(underline!.lookup(PDFName.of('Subtype'), PDFName).decodeText()).toBe('Underline')
    expect(subjOf(underline!)).toBeUndefined()
    // the label color is the annotation color (document data)
    const c = highlight!.lookup(PDFName.of('C'), PDFArray)
    expect(c.asArray().map((n) => Number(n.toString()))).toEqual([0.4, 0.8, 0.4])
  })

  it('caps a long subject by characters, never cutting a surrogate pair in half', async () => {
    const input = await fixedPdf()
    const subject = `${'a'.repeat(199)}😀😀tail`
    const out = await applySaveRequest(input, request([{ ...MARKUPS[0]!, subject }]))
    const doc = await PDFDocument.load(out.bytes)
    expect(subjOf(annotsOf(doc, 0)[0]!)).toBe(`${'a'.repeat(199)}😀`)
  })

  it('keeps the rest of an accepted highlight like any highlight', async () => {
    const input = await fixedPdf()
    const plain = await PDFDocument.load(
      (await applySaveRequest(input, request([MARKUPS[0]!]))).bytes,
    )
    const withSubj = await PDFDocument.load(
      (await applySaveRequest(input, request([{ ...MARKUPS[0]!, subject: 'Method' }]))).bytes,
    )
    const a = annotsOf(plain, 0)[0]!
    const b = annotsOf(withSubj, 0)[0]!
    const keys = (d: PDFDict) =>
      d
        .keys()
        .map((k) => k.decodeText())
        .sort()
    expect(keys(b)).toEqual([...keys(a), 'Subj'].sort())
    // the author stays the highlight's existing value (spec 5.7)
    expect(b.lookup(PDFName.of('T'))?.toString()).toBe(a.lookup(PDFName.of('T'))?.toString())
  })
})
