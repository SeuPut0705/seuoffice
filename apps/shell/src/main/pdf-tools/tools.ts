/**
 * The PDF tools window's work, without Electron: read what a picked PDF is,
 * check a tool's options against it, and run the tool. Every tool goes
 * through the PDF editor's own functions (apps/pdf/src/main: save-pdf.ts for
 * pages, images-to-pdf.ts, read-text.ts), so a file made here matches the same
 * command in the editor. No AI, no network, and the source bytes are only read.
 */
import { PDFDocument } from 'pdf-lib'
import {
  applySaveRequest,
  extractPagesBytes,
  mergePagesBytes,
  mergePdfBytes,
  setPageSizeBytes,
  splitPagesBytes,
  splitPdfBytes,
} from '../../../../pdf/src/main/save-pdf'
import { imagesToPdfBytes, readImageInfo } from '../../../../pdf/src/main/images-to-pdf'
import { duplexMergeBytes } from '../../../../pdf/src/main/print-prep'
import { overlayPdfBytes } from '../../../../pdf/src/main/overlay'
import { stripAnnotsBytes } from '../../../../pdf/src/main/annot-strip'
import {
  COMPRESS_LEVELS,
  compressPdfBytes,
  type ImageRecoder,
} from '../../../../pdf/src/main/compress'
import { readPdfText, type PdfPageText } from '../../../../pdf/src/main/read-text'
import { parsePageRange } from '../../../../pdf/src/renderer/convert/page-range'
import type { StructureJob } from '../pdf-structure/protocol'
import {
  PDF_TOOL_ANNOT_KINDS,
  PDF_TOOL_IDS,
  PDF_TOOL_MARGINS,
  PDF_TOOL_PAPERS,
  PDF_TOOL_SHEET_PAGES,
  type PdfInputProblem,
  type PdfToolAccept,
  type PdfToolAnnotKind,
  type PdfToolId,
  type PdfToolInputKind,
  type PdfToolMargin,
  type PdfToolOptions,
  type PdfToolPaper,
} from '../../shared/pdf-tools-api'

/** Bytes one run may read in total, the editor's merge cap */
export const MAX_TOOL_INPUT_BYTES = 1024 * 1024 * 1024

/** The editor's "page size" list (apps/pdf/src/renderer/view-config.ts PAPER_SIZES) */
const PAPER_POINTS: Record<PdfToolPaper, { w: number; h: number }> = {
  A3: { w: 842, h: 1191 },
  A4: { w: 595, h: 842 },
  A5: { w: 420, h: 595 },
  Letter: { w: 612, h: 792 },
  Legal: { w: 612, h: 1008 },
}

export function isPdfToolId(value: unknown): value is PdfToolId {
  return typeof value === 'string' && (PDF_TOOL_IDS as readonly string[]).includes(value)
}

/** Points of space around a picture for each margin choice (imagesToPdf) */
const MARGIN_POINTS: Record<PdfToolMargin, number> = { none: 0, small: 18, large: 36 }

/** Merge, imagesToPdf and duplex take several files; every other tool takes one */
export function toolTakesMany(tool: PdfToolId): boolean {
  return tool === 'merge' || tool === 'imagesToPdf' || tool === 'duplex'
}

/** The fewest files a tool runs on: merge needs two */
export function toolMinInputs(tool: PdfToolId): number {
  return tool === 'merge' ? 2 : 1
}

/** Which PDFs a tool takes */
export function toolAccepts(tool: PdfToolId): PdfToolAccept {
  return tool === 'decrypt' ? 'encrypted' : tool === 'repair' ? 'damaged' : 'pdf'
}

/** Tools that run in the PDF job process (qpdf, PDFium repair) rather than here */
export function toolRunsAsJob(tool: PdfToolId): tool is 'encrypt' | 'decrypt' | 'repair' {
  return tool === 'encrypt' || tool === 'decrypt' || tool === 'repair'
}

/** the longest password AES-256 PDF encryption keeps (127 bytes of UTF-8) */
export const MAX_PASSWORD_BYTES = 127

/** imagesToPdf takes pictures; every other tool takes PDFs */
export function toolInputKind(tool: PdfToolId): PdfToolInputKind {
  return tool === 'imagesToPdf' ? 'image' : 'pdf'
}

/** The kind of file a tool writes */
export function toolOutputExtension(tool: PdfToolId): 'pdf' | 'txt' {
  return tool === 'toText' ? 'txt' : 'pdf'
}

/**
 * A tool ran but has nothing to write: a PDF without any text layer (toText),
 * or none of the chosen kinds of annotation (stripAnnots)
 */
export class PdfToolRefusal extends Error {
  constructor(readonly reason: 'no-text' | 'no-annots' | 'not-smaller') {
    super(reason)
  }
}

export type InspectResult = { ok: true; pages: number } | { ok: false; problem: PdfInputProblem }

/** A picked picture counts as one page, or is not a JPEG or PNG */
export function inspectImage(bytes: Uint8Array): InspectResult {
  return readImageInfo(bytes) ? { ok: true, pages: 1 } : { ok: false, problem: 'not-image' }
}

/** Page count of a password-protected PDF (the page tree itself is not encrypted); 0 if unknown */
export async function encryptedPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    return doc.getPageCount()
  } catch {
    return 0
  }
}

/** Page count of a PDF, or why the tools cannot use it */
export async function inspectPdf(bytes: Uint8Array): Promise<InspectResult> {
  try {
    // read past the encryption check only to learn that the file is encrypted:
    // the page functions refuse such a file, so the tools never run on it
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    if (doc.isEncrypted) return { ok: false, problem: 'encrypted' }
    const pages = doc.getPageCount()
    return pages > 0 ? { ok: true, pages } : { ok: false, problem: 'unreadable' }
  } catch {
    return { ok: false, problem: 'unreadable' }
  }
}

export type CheckedOptions =
  | { ok: true; options: PdfToolOptions }
  | {
      ok: false
      error:
        | 'range'
        | 'no-kinds'
        | 'none-chosen'
        | 'all-pages'
        | 'password-empty'
        | 'password-same'
        | 'password-long'
    }

/** Annotation kinds stripAnnots removes when the window sends none (links stay) */
export const DEFAULT_ANNOT_KINDS: PdfToolAnnotKind[] = PDF_TOOL_ANNOT_KINDS.filter(
  (kind) => kind !== 'links',
)

const intIn = (value: unknown, lo: number, hi: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi
    ? value
    : undefined

/**
 * Only the options `tool` reads, each checked against the first input's
 * `pageCount`; anything missing or out of range takes the dialog's default,
 * except a page range, which must name pages that exist.
 */
export function checkOptions(
  tool: PdfToolId,
  raw: unknown,
  pageCount: number,
  backgroundPages = 1,
): CheckedOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  switch (tool) {
    case 'split':
      return { ok: true, options: { chunkSize: intIn(o.chunkSize, 1, pageCount) ?? 1 } }
    case 'extract': {
      const range = parsePageRange(typeof o.pages === 'string' ? o.pages : '', pageCount)
      return range.ok
        ? { ok: true, options: { pages: range.pages.join(',') } }
        : { ok: false, error: 'range' }
    }
    case 'nup':
      return {
        ok: true,
        options: {
          perSheet: intIn(o.perSheet, 2, 16) ?? 2,
          direction: o.direction === 'vertical' ? 'vertical' : 'horizontal',
          separator: o.separator === true,
        },
      }
    case 'rotate':
      return {
        ok: true,
        options: { rotation: o.rotation === 180 || o.rotation === 270 ? o.rotation : 90 },
      }
    case 'pageSize':
      return {
        ok: true,
        options: {
          paper: (PDF_TOOL_PAPERS as readonly unknown[]).includes(o.paper)
            ? (o.paper as PdfToolPaper)
            : 'A4',
        },
      }
    case 'splitPages':
      return { ok: true, options: { perPage: o.perPage === 4 || o.perPage === 9 ? o.perPage : 2 } }
    case 'encrypt': {
      // passwords are taken as typed: no trimming
      const password = typeof o.password === 'string' ? o.password : ''
      const restrict = o.restrict === true
      const permission = typeof o.permissionPassword === 'string' ? o.permissionPassword : ''
      if (!password || (restrict && !permission)) return { ok: false, error: 'password-empty' }
      const tooLong = (text: string) => new TextEncoder().encode(text).length > MAX_PASSWORD_BYTES
      if (tooLong(password) || tooLong(permission)) return { ok: false, error: 'password-long' }
      if (restrict && permission === password) return { ok: false, error: 'password-same' }
      return {
        ok: true,
        options: restrict ? { password, restrict, permissionPassword: permission } : { password },
      }
    }
    case 'decrypt': {
      const password = typeof o.password === 'string' ? o.password : ''
      if (!password) return { ok: false, error: 'password-empty' }
      return { ok: true, options: { password } }
    }
    case 'compress':
      return {
        ok: true,
        options: {
          compressLevel: (COMPRESS_LEVELS as readonly unknown[]).includes(o.compressLevel)
            ? (o.compressLevel as 'light' | 'medium' | 'strong')
            : 'medium',
        },
      }
    case 'blankPages': {
      const raw = typeof o.removePages === 'string' ? o.removePages : ''
      const pages = [...new Set(raw.split(',').map((p) => Number(p.trim())))]
        .filter((p) => Number.isInteger(p) && p >= 1 && p <= pageCount)
        .sort((a, b) => a - b)
      if (pages.length === 0) return { ok: false, error: 'none-chosen' }
      if (pages.length >= pageCount) return { ok: false, error: 'all-pages' }
      return { ok: true, options: { removePages: pages.join(',') } }
    }
    case 'stripAnnots': {
      const text = typeof o.applyPages === 'string' ? o.applyPages.trim() : ''
      const range = text ? parsePageRange(text, pageCount) : null
      if (range && !range.ok) return { ok: false, error: 'range' }
      const kinds = Array.isArray(o.annotKinds)
        ? PDF_TOOL_ANNOT_KINDS.filter((kind) => (o.annotKinds as unknown[]).includes(kind))
        : DEFAULT_ANNOT_KINDS
      if (kinds.length === 0) return { ok: false, error: 'no-kinds' }
      return {
        ok: true,
        options: { annotKinds: kinds, applyPages: range?.ok ? range.pages.join(',') : '' },
      }
    }
    case 'overlay': {
      const text = typeof o.applyPages === 'string' ? o.applyPages.trim() : ''
      const range = text ? parsePageRange(text, pageCount) : null
      if (range && !range.ok) return { ok: false, error: 'range' }
      return {
        ok: true,
        options: {
          layer: o.layer === 'front' ? 'front' : 'behind',
          backgroundPage: intIn(o.backgroundPage, 1, backgroundPages) ?? 1,
          applyPages: range?.ok ? range.pages.join(',') : '',
        },
      }
    }
    case 'duplex':
      return {
        ok: true,
        options: {
          sheetPages: (PDF_TOOL_SHEET_PAGES as readonly unknown[]).includes(o.sheetPages)
            ? (o.sheetPages as number)
            : 1,
        },
      }
    case 'imagesToPdf':
      return {
        ok: true,
        options: {
          imagePaper:
            o.imagePaper === 'image' ||
            (PDF_TOOL_PAPERS as readonly unknown[]).includes(o.imagePaper)
              ? (o.imagePaper as PdfToolPaper | 'image')
              : 'A4',
          margin: (PDF_TOOL_MARGINS as readonly unknown[]).includes(o.margin)
            ? (o.margin as PdfToolMargin)
            : 'small',
        },
      }
    default:
      return { ok: true, options: {} }
  }
}

/** What a long tool needs from the window: Chromium's picture code, progress, a stop */
export interface RunDeps {
  recode?: ImageRecoder
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** Run `tool` on `inputs` (already checked); one file, or one per part for split */
export async function runPdfTool(
  tool: PdfToolId,
  inputs: Uint8Array[],
  options: PdfToolOptions,
  deps: RunDeps = {},
): Promise<Uint8Array[]> {
  const [first, ...rest] = inputs
  if (!first) throw new Error('no input')
  switch (tool) {
    case 'merge':
      return [(await mergePdfBytes(first, rest)).merged]
    case 'split':
      return splitPdfBytes(first, options.chunkSize ?? 1)
    case 'extract': {
      const pages = (options.pages ?? '').split(',').map((p) => Number(p) - 1)
      return [await extractPagesBytes(first, pages)]
    }
    case 'reverse': {
      const count = (await PDFDocument.load(first, { updateMetadata: false })).getPageCount()
      return [
        await extractPagesBytes(
          first,
          Array.from({ length: count }, (_, i) => count - 1 - i),
        ),
      ]
    }
    case 'nup':
      return [
        await mergePagesBytes(first, {
          perSheet: options.perSheet ?? 2,
          direction: options.direction ?? 'horizontal',
          separator: options.separator ?? false,
        }),
      ]
    case 'rotate': {
      const count = (await PDFDocument.load(first, { updateMetadata: false })).getPageCount()
      const delta = options.rotation ?? 90
      const applied = await applySaveRequest(first, {
        path: '',
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
        rotations: Array.from({ length: count }, (_, pageIndex) => ({ pageIndex, delta })),
      })
      return [applied.bytes]
    }
    case 'pageSize': {
      const paper = PAPER_POINTS[options.paper ?? 'A4']
      return [await setPageSizeBytes(first, paper.w, paper.h)]
    }
    case 'splitPages':
      return [await splitPagesBytes(first, options.perPage ?? 2)]
    case 'imagesToPdf': {
      const paper = options.imagePaper ?? 'A4'
      return [
        await imagesToPdfBytes(inputs, {
          paper: paper === 'image' ? null : PAPER_POINTS[paper],
          marginPt: MARGIN_POINTS[options.margin ?? 'small'],
        }),
      ]
    }
    case 'duplex':
      // both sides of every sheet: two pages, or two times what N-up puts on a side
      return [await duplexMergeBytes(inputs, 2 * (options.sheetPages ?? 1))]
    case 'overlay': {
      const background = inputs[1]
      if (!background) throw new Error('no background')
      const pages = options.applyPages
        ? options.applyPages.split(',').map((p) => Number(p) - 1)
        : null
      return [
        await overlayPdfBytes(first, background, {
          behind: options.layer !== 'front',
          backgroundPage: (options.backgroundPage ?? 1) - 1,
          pages,
        }),
      ]
    }
    case 'encrypt':
    case 'decrypt':
    case 'repair':
      // the window runs these in the PDF job process (jobFor)
      throw new Error(`${tool} runs as a job`)
    case 'compress': {
      if (!deps.recode) throw new Error('no picture code')
      const made = await compressPdfBytes(first, options.compressLevel ?? 'medium', deps.recode, {
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
      // a file that did not get smaller is not worth a copy
      if (made.bytes.length >= first.length) throw new PdfToolRefusal('not-smaller')
      return [made.bytes]
    }
    case 'blankPages': {
      // the editor's own page removal on save, which keeps bookmarks and forms
      const deletedPages = (options.removePages ?? '').split(',').map((p) => Number(p) - 1)
      const applied = await applySaveRequest(first, {
        path: '',
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
        deletedPages,
      })
      return [applied.bytes]
    }
    case 'stripAnnots': {
      const pages = options.applyPages
        ? options.applyPages.split(',').map((p) => Number(p) - 1)
        : null
      const stripped = await stripAnnotsBytes(first, {
        kinds: options.annotKinds ?? DEFAULT_ANNOT_KINDS,
        pages,
      })
      if (stripped.removed === 0) throw new PdfToolRefusal('no-annots')
      return [stripped.bytes]
    }
    case 'toText': {
      const doc = await readPdfText(first)
      if (!doc.pages.some((page) => page.text.trim() !== '')) throw new PdfToolRefusal('no-text')
      return [new TextEncoder().encode(pagesToText(doc.pages))]
    }
  }
}

/** The pages' text in order, a blank line between pages; a page without text adds nothing */
export function pagesToText(pages: Pick<PdfPageText, 'text'>[]): string {
  const texts = pages.map((page) => page.text.trimEnd()).filter((text) => text.trim() !== '')
  return `${texts.join('\n\n')}\n`
}

/** File names the save dialog suggests, from the first input's name */
export function outputNames(
  tool: PdfToolId,
  sourceName: string,
  count: number,
  options: PdfToolOptions,
): string[] {
  const base = sourceName.replace(/\.(pdf|jpe?g|png)$/i, '') || 'document'
  if (tool === 'split') return Array.from({ length: count }, (_, i) => `${base}-${i + 1}.pdf`)
  if (tool === 'imagesToPdf') return [`${base}.pdf`]
  if (tool === 'toText') return [`${base}.txt`]
  const suffix: Record<Exclude<PdfToolId, 'split' | 'imagesToPdf' | 'toText'>, string> = {
    merge: 'merged',
    duplex: 'duplex',
    overlay: 'background',
    stripAnnots: 'clean',
    blankPages: 'no-blank',
    compress: 'smaller',
    encrypt: 'locked',
    decrypt: 'unlocked',
    repair: 'repaired',
    extract: 'pages',
    reverse: 'reversed',
    nup: `${options.perSheet ?? 2}up`,
    rotate: 'rotated',
    pageSize: options.paper ?? 'A4',
    splitPages: 'split',
  }
  return [`${base}-${suffix[tool]}.pdf`]
}

export interface FoundBlankPages {
  pageCount: number
  candidates: {
    page: number
    reason: 'empty' | 'nearly-white'
    thumb: { width: number; height: number; bgra: Uint8Array } | null
  }[]
}

/** The blank-pages job's answer, checked; null when it is not that shape */
export function foundBlankPagesOf(value: unknown): FoundBlankPages | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.pageCount !== 'number' || !Array.isArray(v.candidates)) return null
  const candidates: FoundBlankPages['candidates'] = []
  for (const raw of v.candidates as unknown[]) {
    if (!raw || typeof raw !== 'object') return null
    const c = raw as Record<string, unknown>
    if (typeof c.page !== 'number' || !Number.isInteger(c.page)) return null
    if (c.page < 1 || c.page > v.pageCount) return null
    if (c.reason !== 'empty' && c.reason !== 'nearly-white') return null
    let thumb: FoundBlankPages['candidates'][number]['thumb'] = null
    if (c.thumb) {
      const t = c.thumb as Record<string, unknown>
      const { width, height, bgra } = t
      if (typeof width !== 'number' || typeof height !== 'number') return null
      if (!(bgra instanceof Uint8Array) || bgra.length !== width * height * 4) return null
      thumb = { width, height, bgra }
    }
    candidates.push({ page: c.page, reason: c.reason, thumb })
  }
  return { pageCount: v.pageCount, candidates }
}

/** The PDF job process's work for a tool that runs there, on the file at `path` */
export function jobFor(
  tool: 'encrypt' | 'decrypt' | 'repair',
  path: string,
  options: PdfToolOptions,
): StructureJob {
  const source = { pdfPath: path }
  if (tool === 'repair') return { op: 'repair', source }
  if (tool === 'decrypt') return { op: 'decrypt', source, password: options.password ?? '' }
  return {
    op: 'encrypt',
    source,
    userPassword: options.password ?? '',
    ...(options.restrict && options.permissionPassword
      ? { ownerPassword: options.permissionPassword }
      : {}),
  }
}

/** The bytes a tool job answered with; null when it is not that shape */
export function jobBytesOf(value: unknown): Uint8Array | null {
  const bytes = (value as { bytes?: unknown } | null)?.bytes
  return bytes instanceof Uint8Array && bytes.length > 0 ? bytes : null
}
