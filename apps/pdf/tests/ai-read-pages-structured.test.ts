/**
 * read_pages on the structured reading path (spec §2): the document tree's
 * text through the structure channel, AI-read pages from the store, and the
 * PDF.js fallback with a note when the structured reading fails or is slow.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  STRUCTURED_READ_UNAVAILABLE_NOTE,
  executePdfTool,
  type PdfAiDeps,
  type StructuredReadAccess,
} from '../src/renderer/ai/tools'
import { pageImageNote } from '../../../packages/pdf-structure/src/structured-text'
import type {
  PdfStructureOutcome,
  PdfStructureTextResult,
  PdfStructureTreeResult,
} from '../src/shared/ipc'
import type { AiReadPageEntry } from '../../../packages/pdf-structure/src/store/store'
import type { DocumentTree } from '../../../packages/pdf-structure/src/tree/types'

const FP = (n: number) => String(n).repeat(64).slice(0, 64)

function fakeDoc(pageTexts: string[]): PDFDocumentProxy {
  return {
    numPages: pageTexts.length,
    getPage: async (n: number) => ({
      getTextContent: async () => ({ items: [{ str: pageTexts[n - 1], hasEOL: true }] }),
      cleanup: () => {},
    }),
  } as unknown as PDFDocumentProxy
}

const plainTexts = (n: number) => Array.from({ length: n }, (_, k) => `plain text ${k + 1}`)

function makeDeps(
  docRef: { current: PDFDocumentProxy },
  access: StructuredReadAccess | null,
  over: Partial<PdfAiDeps> = {},
): PdfAiDeps {
  return {
    doc: () => docRef.current,
    pageCount: () => docRef.current.numPages,
    ocrText: () => null,
    isDeleted: () => false,
    structuredRead: () => access,
    ...over,
  } as unknown as PdfAiDeps
}

function textResult(pages: Array<[number, string]>): PdfStructureOutcome<PdfStructureTextResult> {
  return { ok: true, docHash: 'h'.repeat(64), pages: pages.map(([page, text]) => ({ page, text })) }
}

function treeResult(pages: number[]): PdfStructureOutcome<PdfStructureTreeResult> {
  return {
    ok: true,
    docHash: 'h'.repeat(64),
    tree: {} as DocumentTree,
    fingerprints: pages.map((page) => ({ page, fingerprint: FP(page) })),
    cached: true,
  }
}

function makeAccess(over: Partial<StructuredReadAccess> = {}): StructuredReadAccess & {
  text: ReturnType<typeof vi.fn>
  tree: ReturnType<typeof vi.fn>
  aiReadPages: ReturnType<typeof vi.fn>
} {
  return {
    source: { path: 'C:/docs/book.pdf' },
    text: vi.fn(async () =>
      textResult([
        [1, '# Chapter One\n\nBody one.'],
        [2, 'Body two.'],
        [3, 'Body three.'],
      ]),
    ),
    tree: vi.fn(async () => treeResult([1, 2, 3])),
    aiReadPages: vi.fn(async () => ({ ok: true as const, pages: [] as AiReadPageEntry[] })),
    timeoutMs: 1000,
    ...over,
  } as never
}

const call = (input: Record<string, unknown>) => ({ id: 't1', name: 'read_pages', input })

describe('read_pages structured path', () => {
  it('reads the structured text of the whole document once and slices the requested pages', async () => {
    const doc = { current: fakeDoc(plainTexts(3)) }
    const access = makeAccess({ source: { path: 'C:/docs/book.pdf', password: 'pw' } })
    const result = await executePdfTool(makeDeps(doc, access), call({ start: 1, end: 2 }))
    expect(result.isError).toBeUndefined()
    expect(result.output).toBe('[Page 1]\n# Chapter One\n\nBody one.\n\n[Page 2]\nBody two.')
    expect(result.output).not.toContain(STRUCTURED_READ_UNAVAILABLE_NOTE)
    expect(access.text).toHaveBeenCalledTimes(1)
    const request = access.text.mock.calls[0]![0] as Record<string, unknown>
    expect(request).toMatchObject({ path: 'C:/docs/book.pdf', password: 'pw' })
    expect(request.pages).toBeUndefined()
    expect(String(request.jobId)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    // no AI-read pages: no tree request
    expect(access.tree).not.toHaveBeenCalled()
  })

  it('keeps the structured text per file and drops it when a save reloads the document', async () => {
    const doc = { current: fakeDoc(plainTexts(3)) }
    const access = makeAccess()
    const deps = makeDeps(doc, access)
    await executePdfTool(deps, call({ start: 1 }))
    await executePdfTool(deps, call({ start: 3 }))
    expect(access.text).toHaveBeenCalledTimes(1)

    // a save reloads the file into a new PDF.js document
    doc.current = fakeDoc(plainTexts(3))
    access.text.mockResolvedValueOnce(textResult([[1, 'Saved body.']]))
    const after = await executePdfTool(deps, call({ start: 1 }))
    expect(access.text).toHaveBeenCalledTimes(2)
    expect(after.output).toBe('[Page 1]\nSaved body.')
  })

  it('reads a page the AI has read from the stored reading', async () => {
    const doc = { current: fakeDoc(plainTexts(3)) }
    const access = makeAccess({
      aiReadPages: vi.fn(async () => ({
        ok: true as const,
        pages: [
          {
            pageFingerprint: FP(2),
            savedAt: 1,
            payload: {
              version: 1,
              blocks: [
                { kind: 'heading', level: 2, runs: [{ kind: 'text', text: 'Scanned heading' }] },
                { kind: 'paragraph', runs: [{ kind: 'text', text: 'Recovered body.' }] },
              ],
              footnotes: [],
              droppedRepetitions: 0,
              reasked: false,
            },
          },
        ],
      })),
    })
    const result = await executePdfTool(makeDeps(doc, access), call({ start: 1, end: 3 }))
    expect(result.output).toContain('[Page 1]\n# Chapter One')
    expect(result.output).toMatch(
      /\[Page 2\]\n\(read by AI[^\n]*\)\n## Scanned heading\n\nRecovered body\./,
    )
    expect(result.output).not.toContain('Body two.')
    expect(result.output).toContain('[Page 3]\nBody three.')
    expect(access.aiReadPages).toHaveBeenCalledWith('h'.repeat(64))
  })

  it('keeps the structured text of a page whose stored reading cannot be read', async () => {
    const doc = { current: fakeDoc(plainTexts(3)) }
    const access = makeAccess({
      aiReadPages: vi.fn(async () => ({
        ok: true as const,
        pages: [{ pageFingerprint: FP(2), savedAt: 1, payload: { version: 1 } }],
      })),
    })
    const result = await executePdfTool(makeDeps(doc, access), call({ start: 2 }))
    expect(result.output).toBe('[Page 2]\nBody two.')
  })

  it('falls back to the page text with a note when the structured reading fails', async () => {
    const doc = { current: fakeDoc(plainTexts(2)) }
    const access = makeAccess({
      text: vi.fn(async () => ({ ok: false as const, error: 'failed' as const })),
    })
    const result = await executePdfTool(makeDeps(doc, access), call({ start: 1, end: 2 }))
    expect(result.isError).toBeUndefined()
    expect(result.output).toBe(
      `${STRUCTURED_READ_UNAVAILABLE_NOTE}\n[Page 1]\nplain text 1\n\n[Page 2]\nplain text 2`,
    )
  })

  it('falls back with a note when the structured call throws', async () => {
    const doc = { current: fakeDoc(plainTexts(1)) }
    const access = makeAccess({ text: vi.fn(async () => Promise.reject(new Error('boom'))) })
    const result = await executePdfTool(makeDeps(doc, access), call({ start: 1 }))
    expect(result.output).toBe(`${STRUCTURED_READ_UNAVAILABLE_NOTE}\n[Page 1]\nplain text 1`)
  })

  it('falls back with a note on timeout, and uses the analysis once it has finished', async () => {
    const doc = { current: fakeDoc(plainTexts(2)) }
    let finish: (v: PdfStructureOutcome<PdfStructureTextResult>) => void = () => {}
    const pending = new Promise<PdfStructureOutcome<PdfStructureTextResult>>((resolve) => {
      finish = resolve
    })
    const access = makeAccess({ text: vi.fn(() => pending), timeoutMs: 200 })
    const deps = makeDeps(doc, access)
    const slow = await executePdfTool(deps, call({ start: 1 }))
    expect(slow.output).toBe(`${STRUCTURED_READ_UNAVAILABLE_NOTE}\n[Page 1]\nplain text 1`)

    // still running: the next call does not wait again
    const started = Date.now()
    const again = await executePdfTool(deps, call({ start: 2 }))
    expect(again.output).toBe(`${STRUCTURED_READ_UNAVAILABLE_NOTE}\n[Page 2]\nplain text 2`)
    expect(Date.now() - started).toBeLessThan(150)

    finish(textResult([[2, 'Structured two.']]))
    await pending
    const done = await executePdfTool(deps, call({ start: 2 }))
    expect(done.output).toBe('[Page 2]\nStructured two.')
    expect(access.text).toHaveBeenCalledTimes(1)
  })

  it('retries after a transient failure instead of keeping it', async () => {
    const doc = { current: fakeDoc(plainTexts(1)) }
    const access = makeAccess()
    access.text.mockResolvedValueOnce({ ok: false, error: 'busy' })
    const deps = makeDeps(doc, access)
    expect((await executePdfTool(deps, call({ start: 1 }))).output).toContain(
      STRUCTURED_READ_UNAVAILABLE_NOTE,
    )
    expect((await executePdfTool(deps, call({ start: 1 }))).output).toBe(
      '[Page 1]\n# Chapter One\n\nBody one.',
    )
    expect(access.text).toHaveBeenCalledTimes(2)
  })

  it('keeps the limits: 10 pages and 24,000 characters per call', async () => {
    const doc = { current: fakeDoc(plainTexts(14)) }
    const pages: Array<[number, string]> = Array.from({ length: 14 }, (_, k) => [
      k + 1,
      `s${k + 1}`,
    ])
    const access = makeAccess({ text: vi.fn(async () => textResult(pages)) })
    const deps = makeDeps(doc, access)
    const ten = await executePdfTool(deps, call({ start: 2, end: 14 }))
    expect(ten.output).toContain('[Page 11]')
    expect(ten.output).not.toContain('[Page 12]')

    const long = 'x'.repeat(9000)
    const bigDoc = { current: fakeDoc(plainTexts(4)) }
    const bigAccess = makeAccess({
      text: vi.fn(async () => textResult([1, 2, 3, 4].map((n) => [n, long] as [number, string]))),
    })
    const big = await executePdfTool(makeDeps(bigDoc, bigAccess), call({ start: 1, end: 4 }))
    expect(big.output).toContain('… (truncated; read the rest in further calls)')
    expect(big.output.length).toBeLessThan(24_000 + 100)
    expect(big.output).not.toContain('[Page 4]')
  })

  it('adds the OCR text the viewer recovered to a page kept as an image', async () => {
    const doc = { current: fakeDoc(['']) }
    const access = makeAccess({
      text: vi.fn(async () => textResult([[1, pageImageNote(1, 'scanned')]])),
    })
    const deps = makeDeps(doc, access, { ocrText: () => 'OCR words' })
    const result = await executePdfTool(deps, call({ start: 1 }))
    expect(result.output).toBe(
      `[Page 1]\n${pageImageNote(1, 'scanned')}\n(recovered by OCR; may contain recognition errors)\nOCR words`,
    )
  })

  it('reads the page text without a note when no structured reading is wired', async () => {
    const doc = { current: fakeDoc(plainTexts(1)) }
    const result = await executePdfTool(makeDeps(doc, null), call({ start: 1 }))
    expect(result.output).toBe('[Page 1]\nplain text 1')
  })
})
