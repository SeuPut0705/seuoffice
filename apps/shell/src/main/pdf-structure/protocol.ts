/**
 * Messages between the shell main process and a structure-job process
 * (pdf-structure-process.ts). One process runs one job: the parent posts a single
 * `run` message, the child answers with any number of `progress` messages and
 * exactly one `result` or `error`, and the parent then ends the process.
 *
 * Pure (no Electron, no Node I/O) so both ends and the tests share it. Errors
 * are classified by name and code rather than by class, so this module does
 * not load the PDF packages.
 */
import type { DocumentTree, InlineRun } from '../../../../../packages/pdf-structure/src/tree/types'
import type { PageFingerprint } from '../../../../../packages/pdf-structure/src/tree/extract'
import type { MarkdownWarning } from '../../../../../packages/pdf-structure/src/markdown/write'
import type { TranslationReport } from '../../../../../packages/pdf-structure/src/translate/result'
import type {
  PdfStructureEpubOptions,
  PdfStructureErrorCode,
  PdfStructureFailure,
  PdfStructuredTextPage,
} from '../../../../pdf/src/shared/ipc'

/** the document a job reads */
export interface JobSource {
  pdfPath: string
  password?: string
  /** 1-based page numbers; absent = every page */
  pages?: number[]
}

export interface TranslationInput {
  lang: string
  bilingual: boolean
  /**
   * translated runs by text-unit key; absent = the result store's translation
   * of the file's document hash into `lang` (spec §8), finished blocks
   * translated and the rest in the source language
   */
  units?: Array<{ key: string; runs: InlineRun[] }>
}

/**
 * One job. `tree`, when present, is the main process's cached tree of the
 * same file bytes and pages; the job then skips extraction.
 */
export type StructureJob =
  | { op: 'tree'; source: JobSource }
  | { op: 'structuredText'; source: JobSource; tree?: DocumentTree }
  | {
      op: 'markdown'
      source: JobSource
      tree?: DocumentTree
      outPath: string
      translation?: TranslationInput
    }
  | {
      op: 'epub'
      source: JobSource
      tree?: DocumentTree
      outPath: string
      translation?: TranslationInput
      epub: PdfStructureEpubOptions
    }
  | { op: 'images'; source: JobSource; outDir: string; baseName: string; minImagePx?: number }
  | { op: 'fingerprints'; source: JobSource }
  /** the PDF tools window's blank-page candidates (apps/pdf/src/main/blank-pages.ts) */
  | { op: 'blankPages'; source: JobSource }
  /** the PDF tools window's add password, remove password and repair (apps/pdf/src/main/qpdf.ts, repair.ts) */
  | { op: 'encrypt'; source: JobSource; userPassword: string; ownerPassword?: string }
  | { op: 'decrypt'; source: JobSource; password: string }
  | { op: 'repair'; source: JobSource }
  | { op: 'writeBack'; source: JobSource; tree?: DocumentTree; outPath: string; payload: unknown }

export type StructureOp = StructureJob['op']

/** what the child needs from the main process to set itself up */
export interface ProcessSetup {
  /** pdfium.wasm on disk (node_modules in dev, Resources/wasm when packaged) */
  wasmPath: string
  /** OCR helper candidates, first usable wins; none usable = no OCR */
  ocrHelperPaths: string[]
  /** the app's user-data folder: its result store's AI readings go into conversions */
  userDataDir?: string
  /** harfbuzz subsetter wasm on disk (wasm-path.ts hbSubsetWasmPath); the translated PDF needs it */
  hbSubsetWasmPath?: string
  /** qpdf wasm on disk (wasm-path.ts qpdfWasmPath); adding and removing a password needs it */
  qpdfWasmPath?: string
}

export interface RunMessage {
  type: 'run'
  setup: ProcessSetup
  job: StructureJob
}

export type ChildMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; value: unknown }
  | {
      type: 'error'
      error: PdfStructureErrorCode
      message: string
      validRange?: { first: number; last: number }
    }

// ── job answers (the `value` of a result message, per op) ──

export interface TreeJobValue {
  docHash: string
  tree: DocumentTree
  fingerprints: PageFingerprint[]
}

export interface StructuredTextJobValue {
  docHash: string
  pages: PdfStructuredTextPage[]
  /** the tree, when the job had to extract it (the main process caches it) */
  extracted?: { tree: DocumentTree; fingerprints: PageFingerprint[] }
}

export interface MarkdownJobValue {
  docHash: string
  outPath: string
  warnings: MarkdownWarning[]
  assetsWritten: number
  assetsReused: number
  /** a translation read from the result store: what it holds for the written tree */
  translation?: TranslationReport
}

export interface EpubJobValue {
  docHash: string
  outPath: string
  /** as MarkdownJobValue.translation */
  translation?: TranslationReport
}

export interface ImagesJobValue {
  docHash: string
  outDir: string
  images: Array<{ page: number; file: string; width: number; height: number }>
}

export interface FingerprintsJobValue {
  docHash: string
  /** in page order */
  fingerprints: string[]
}

export interface WriteBackJobValue {
  docHash: string
  outPath: string
  report: unknown
}

// ── validation ──

const ERROR_CODES: ReadonlySet<string> = new Set<PdfStructureErrorCode>([
  'not-granted',
  'invalid-request',
  'invalid-target',
  'busy',
  'cancelled',
  'password-required',
  'corrupt',
  'unsupported',
  'page-range',
  'asset-conflict',
  'not-available',
  'process-exited',
  'store-write-failed',
  'failed',
])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

function rangeOf(v: unknown): { first: number; last: number } | undefined {
  if (!isRecord(v) || !isCount(v.first) || !isCount(v.last)) return undefined
  return { first: v.first, last: v.last }
}

/** a message from the child, or null for anything malformed (ignored) */
export function parseChildMessage(raw: unknown): ChildMessage | null {
  if (!isRecord(raw)) return null
  if (raw.type === 'progress') {
    return isCount(raw.done) && isCount(raw.total)
      ? { type: 'progress', done: raw.done, total: raw.total }
      : null
  }
  if (raw.type === 'result') return { type: 'result', value: raw.value }
  if (raw.type === 'error') {
    const error = typeof raw.error === 'string' && ERROR_CODES.has(raw.error) ? raw.error : 'failed'
    const message = typeof raw.message === 'string' ? raw.message : ''
    const out: ChildMessage = { type: 'error', error: error as PdfStructureErrorCode, message }
    const validRange = rangeOf(raw.validRange)
    if (validRange) out.validRange = validRange
    return out
  }
  return null
}

const OPS: ReadonlySet<string> = new Set<StructureOp>([
  'tree',
  'structuredText',
  'markdown',
  'epub',
  'images',
  'fingerprints',
  'writeBack',
  'blankPages',
  'encrypt',
  'decrypt',
  'repair',
])

/** the child's view of the parent's message; null when it is not a run message */
export function parseRunMessage(raw: unknown): RunMessage | null {
  if (!isRecord(raw) || raw.type !== 'run') return null
  const { setup, job } = raw
  if (!isRecord(setup) || typeof setup.wasmPath !== 'string') return null
  if (!Array.isArray(setup.ocrHelperPaths)) return null
  if (!setup.ocrHelperPaths.every((p) => typeof p === 'string')) return null
  if (setup.userDataDir !== undefined && typeof setup.userDataDir !== 'string') return null
  if (setup.hbSubsetWasmPath !== undefined && typeof setup.hbSubsetWasmPath !== 'string')
    return null
  if (setup.qpdfWasmPath !== undefined && typeof setup.qpdfWasmPath !== 'string') return null
  if (!isRecord(job) || typeof job.op !== 'string' || !OPS.has(job.op)) return null
  if (!isRecord(job.source) || typeof job.source.pdfPath !== 'string') return null
  return raw as unknown as RunMessage
}

/** turn whatever a job threw into the error message the child posts */
export function errorMessageOf(err: unknown): Extract<ChildMessage, { type: 'error' }> {
  const e = isRecord(err) || err instanceof Error ? (err as Record<string, unknown>) : {}
  const name = typeof e.name === 'string' ? e.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'PdfLoadError') {
    const code = e.code
    if (code === 'password-required' || code === 'corrupt' || code === 'unsupported') {
      return { type: 'error', error: code, message }
    }
  }
  if (name === 'PageRangeError') {
    const out: Extract<ChildMessage, { type: 'error' }> = {
      type: 'error',
      error: 'page-range',
      message,
    }
    const validRange = rangeOf(e.validRange)
    if (validRange) out.validRange = validRange
    return out
  }
  if (name === 'AssetConflictError') return { type: 'error', error: 'asset-conflict', message }
  if (name === 'NotAvailableError') return { type: 'error', error: 'not-available', message }
  // a translated PDF cannot be written into an encrypted source
  if (name === 'WritebackEncryptedError') return { type: 'error', error: 'unsupported', message }
  if (name === 'AbortError') return { type: 'error', error: 'cancelled', message }
  return { type: 'error', error: 'failed', message }
}

/** the renderer-facing failure for a child error message */
export function failureOf(msg: Extract<ChildMessage, { type: 'error' }>): PdfStructureFailure {
  const out: PdfStructureFailure = { ok: false, error: msg.error }
  if (msg.message) out.message = msg.message
  if (msg.validRange) out.validRange = msg.validRange
  return out
}
