/**
 * The PDF document tree (packages/pdf-structure) for the command line: page
 * lists, the tree of a page range with the stored AI readings merged in, page
 * fingerprints and page images, and the result store the app shares. PDFium
 * and the OCR engine are set up the way the other PDF commands set them up
 * (formats/pdf.ts).
 */
import { extract, PdfLoadError, type PdfiumModule } from '@genoffice/pdf2docx'
import {
  applyStoredAiReadings,
  extractDocumentTree,
  PageRangeError,
  type DocumentTree,
} from '../../../pdf-structure/src'
import { documentHash, ResultStore } from '../../../pdf-structure/src/store'
import { pageFingerprint } from '../../../pdf-structure/src/tree/pdfium-doc'
import { genofficeUserDataDir } from '../gui'
import { CliError, EXIT } from '../result'
import { loadPdfium, ocr } from './pdf'

/** spec §7: a page image of about 175 dpi (150-200) */
export const AI_READ_RENDER_SCALE = 175 / 72

/** The store the app uses: `<userData>/pdf-store`, in the same folder as the app's. */
export function resultStore(env: NodeJS.ProcessEnv): ResultStore {
  return new ResultStore(genofficeUserDataDir(env))
}

export { documentHash }

/**
 * `1-5,8,10-12` (1-based) as page numbers in the order given, without
 * duplicates. Checked against `count` when it is known.
 */
export function parsePageList(spec: string, count?: number): number[] {
  const pages: number[] = []
  for (const { start, end } of pageSpans(spec)) {
    if (count !== undefined && end > count) throw pagesOutOfRange(spec, count)
    for (let p = start; p <= end; p++) if (!pages.includes(p)) pages.push(p)
  }
  return pages
}

/** Validate syntax and integer bounds without expanding ranges before the PDF page count is known. */
export function validatePageList(spec: string): void {
  pageSpans(spec)
}

function pageSpans(spec: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  const parts = spec.split(',').map((p) => p.trim())
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) {
      throw new CliError(
        EXIT.usage,
        `--pages must look like 1-5,8,10-12 (got ${JSON.stringify(spec)})`,
        undefined,
        { reason: 'invalid_argument' },
      )
    }
    const start = Number(m[1])
    const end = m[2] === undefined ? start : Number(m[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new CliError(EXIT.usage, `--pages: ${part} is not a 1-based span`, undefined, {
        reason: 'invalid_argument',
      })
    }
    spans.push({ start, end })
  }
  return spans
}

export function pagesOutOfRange(spec: string, count: number): CliError {
  return new CliError(
    EXIT.usage,
    `pages ${spec} out of bounds (1-${count})`,
    { valid_range: [1, count] },
    { reason: 'out_of_range', suggestion: `use pages between 1 and ${count}` },
  )
}

/** A PDF load failure as the CLI error a program branches on; anything else passes through. */
export function pdfLoadError(err: unknown, password: string | undefined): unknown {
  if (err instanceof PageRangeError) {
    const { first, last } = err.validRange
    return new CliError(
      EXIT.usage,
      err.message,
      { valid_range: [first, last] },
      { reason: 'out_of_range', suggestion: `use pages between ${first} and ${last}` },
    )
  }
  if (!(err instanceof PdfLoadError)) return err
  if (err.code === 'password-required') {
    return password === undefined
      ? new CliError(EXIT.usage, 'the PDF is encrypted', undefined, {
          reason: 'missing_argument',
          suggestion: 'pass --password <pw>',
        })
      : new CliError(EXIT.usage, 'wrong password for this PDF', undefined, {
          reason: 'invalid_argument',
          suggestion: 'check the --password value',
        })
  }
  return new CliError(EXIT.file, `not a readable PDF (${err.code})`, undefined, {
    reason: 'unsupported',
  })
}

export interface PdfFacts {
  pages: number
  /** a password or an owner restriction: a translated copy cannot be written (spec §8) */
  encrypted: boolean
}

interface SecurityPdfium extends PdfiumModule {
  _FPDF_GetSecurityHandlerRevision(doc: number): number
}

/** Page count and whether the document is encrypted; load errors come back as CLI errors. */
export async function pdfFacts(bytes: Uint8Array, password: string | undefined): Promise<PdfFacts> {
  const m = (await loadPdfium()) as SecurityPdfium
  try {
    return extract.withPdfDocument(
      m,
      bytes,
      (doc) => ({
        pages: m._FPDF_GetPageCount(doc),
        encrypted: password !== undefined || m._FPDF_GetSecurityHandlerRevision(doc) !== -1,
      }),
      password,
    )
  } catch (err) {
    throw pdfLoadError(err, password)
  }
}

/** Fingerprints of `pages` (1-based), in that order. */
export async function pageFingerprints(
  bytes: Uint8Array,
  password: string | undefined,
  pages: readonly number[],
): Promise<string[]> {
  const m = await loadPdfium()
  try {
    return extract.withPdfDocument(
      m,
      bytes,
      (doc) => pages.map((p) => pageFingerprint(m, doc, p - 1)),
      password,
    )
  } catch (err) {
    throw pdfLoadError(err, password)
  }
}

/** One page (1-based) as PNG, rendered with PDFium as `render` renders PDF pages. */
export async function renderPdfPage(
  bytes: Uint8Array,
  password: string | undefined,
  page: number,
  scale: number,
): Promise<Uint8Array> {
  const m = await loadPdfium()
  const png = extract.withPdfDocument(
    m,
    bytes,
    (doc) => extract.renderPageByIndexPng(m, doc, page - 1, scale)?.data,
    password,
  )
  if (!png) throw new CliError(EXIT.conversion, `could not render page ${page}`)
  return png
}

export interface TreeOptions {
  password?: string
  /** 1-based pages; absent = every page */
  pages?: number[]
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** The document tree of the chosen pages, as the app extracts it (same OCR engine for scans). */
export async function documentTree(bytes: Uint8Array, o: TreeOptions): Promise<DocumentTree> {
  const engine = ocr()
  try {
    const { tree } = await extractDocumentTree(bytes, {
      pdfium: await loadPdfium(),
      ...(o.password !== undefined ? { password: o.password } : {}),
      ...(o.pages !== undefined ? { pages: o.pages } : {}),
      ...(engine ? { ocr: engine } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    })
    return tree
  } catch (err) {
    throw pdfLoadError(err, o.password)
  }
}

/**
 * The tree with the AI readings the store holds for its pages in their place
 * (spec §7: conversion, structured reading and translation all use them).
 * An unreadable store reads as empty.
 */
export async function withStoredReadings(
  tree: DocumentTree,
  store: ResultStore,
  docHash: string,
): Promise<{ tree: DocumentTree; aiPages: number[] }> {
  const entries = await store.readAiReadPages(docHash).catch(() => new Map())
  if (entries.size === 0) return { tree, aiPages: [] }
  const merged = applyStoredAiReadings(tree, entries)
  const aiPages = merged.pages.filter((p) => p.status === 'ai').map((p) => p.page)
  return { tree: merged, aiPages }
}

/** Every chosen page is a picture (scanned or unreadable text): the conversion holds no text. */
export function onlyPageImages(tree: DocumentTree): boolean {
  return (
    tree.pages.length > 0 &&
    tree.pages.every((p) => p.status === 'scanned' || p.status === 'degraded')
  )
}
