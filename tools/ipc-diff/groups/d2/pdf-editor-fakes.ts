/**
 * The TypeScript half of the PDF editor's fake hosts
 * (crates/shell-ipc/d2/src/pdf/editor/fakes.rs): the modules pdf-main.ts
 * reaches that the Rust port puts behind `PdfEngine` (pdf-lib, pdfium,
 * node-forge, pdf-crypt, pdf-shrink, the structure store, ai-search) are
 * replaced by these, which answer from the case's `hosts.d2.pdf.engine` the
 * same way and log the same lines. `pdf-editor.ts` points the imports here.
 *
 * Answers: `engine[<name>]`; an array is consumed one per call (the last
 * repeats) except for the names in ONE_ANSWER; `{error}` makes the call
 * throw that message. Bytes in answers are strings, taken as UTF-8.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

interface State {
  engine: Record<string, unknown>
  log: unknown[]
  used: Map<string, number>
  held: { bytes: Uint8Array; count: number } | null
  uuid: number
  /** the folder watches pdf-main made, by folder */
  watches: Map<string, (event: string, name: string | null) => void>
  /** the case's temp folder: pdf-main's `tmpdir()` */
  tmp: string
}

const KEY = Symbol.for('ipc-diff.d2.pdf-editor')
const holder = globalThis as unknown as Record<symbol, State>

/** The case's answers and log; every case starts afresh */
export function resetPdfEditorFakes(pdf: unknown, log: unknown[], tmp: string): void {
  const engine = ((pdf as { engine?: unknown } | undefined)?.engine ?? {}) as Record<
    string,
    unknown
  >
  holder[KEY] = { engine, log, used: new Map(), held: null, uuid: 0, watches: new Map(), tmp }
}

const st = (): State => holder[KEY]
const line = (...values: unknown[]): void => void st().log.push(values)

const ONE_ANSWER = new Set([
  'readStaticFormFills',
  'readAnnotSubjects',
  'listPageImages',
  'validateTextEdits',
  'readPdfSignatures',
  'openCertificate',
])

function take(name: string): unknown {
  const s = st()
  if (!(name in s.engine)) return undefined
  const v = s.engine[name]
  if (Array.isArray(v) && v.length > 0 && !ONE_ANSWER.has(name)) {
    const n = s.used.get(name) ?? 0
    s.used.set(name, n + 1)
    return v[Math.min(n, v.length - 1)]
  }
  return v
}

/** the answer, or throws the error it asks for */
function get(name: string): unknown {
  const v = take(name) as { error?: unknown } | undefined | null
  if (v && typeof v === 'object' && typeof v.error === 'string') throw new Error(v.error)
  return v
}

const utf8 = (v: unknown): Uint8Array => new Uint8Array(Buffer.from(String(v ?? ''), 'utf8'))
const bytesOr = (name: string, input: Uint8Array): Uint8Array => {
  const v = get(name)
  return v === undefined ? input : utf8(v)
}
const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts))
const skips = (name: string) => {
  const v = (get(name) ?? {}) as Record<string, unknown>
  const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]) : [])
  return {
    skippedTextEdits: list('skippedTextEdits'),
    skippedTextInserts: list('skippedTextInserts'),
    skippedImageEdits: list('skippedImageEdits'),
  }
}

// ---- save-pdf.ts ----

export async function savePdfToPath(source: string, target: string, _request: unknown) {
  line('savePdfToPath', source, target)
  const out = skips('savePdfToPath')
  writeFileSync(target, readFileSync(source))
  return out
}
export async function savePdfBytesToPath(source: Uint8Array, target: string, _request: unknown) {
  line('savePdfBytesToPath', target)
  const out = skips('savePdfBytesToPath')
  writeFileSync(target, source)
  return out
}
export async function copyPdfToPath(source: string, target: string) {
  line('copyPdfToPath', source, target)
  get('copyPdfToPath')
  writeFileSync(target, readFileSync(source))
}
export async function pdfBytesWithEdits(source: string, _request: unknown) {
  line('pdfBytesWithEdits', source)
  return bytesOr('pdfBytesWithEdits', new Uint8Array(readFileSync(source)))
}
export async function pdfBytesWithEditsOf(file: Uint8Array, _request: unknown) {
  line('pdfBytesWithEditsOf')
  return bytesOr('pdfBytesWithEditsOf', file)
}
export async function pdfBytesWithEditsFrom(source: Uint8Array, _request: unknown) {
  line('pdfBytesWithEditsFrom')
  return bytesOr('pdfBytesWithEditsFrom', source)
}
export async function readStaticFormFills(_bytes: Uint8Array) {
  line('readStaticFormFills')
  return get('readStaticFormFills') ?? []
}
export async function extractPagesBytes(bytes: Uint8Array, pages: unknown) {
  line('extractPagesBytes', pages)
  return bytesOr('extractPages', bytes)
}
export async function insertPdfBytes(target: Uint8Array, other: Uint8Array, after: number) {
  line('insertPdfBytes', after)
  const count = num(get('insertPdf'), 1)
  return { merged: concat(target, other), count }
}
export async function insertBlankPageBytes(bytes: Uint8Array, after: number) {
  line('insertBlankPageBytes', after)
  return bytesOr('insertBlankPage', bytes)
}
export async function splitPdfBytes(bytes: Uint8Array, chunk: number) {
  line('splitPdfBytes', chunk)
  const v = get('splitPdf')
  return Array.isArray(v) ? v.map(utf8) : [bytes]
}
export async function mergePagesBytes(
  bytes: Uint8Array,
  o: { perSheet: number; direction: string; separator: boolean },
) {
  line('mergePagesBytes', o.perSheet, o.direction, o.separator)
  return bytesOr('mergePages', bytes)
}
export async function mergePdfBytes(base: Uint8Array, others: Uint8Array[]) {
  line('mergePdfBytes', others.length)
  get('mergePdf')
  return { merged: concat(base, ...others), appended: others.length }
}
export async function replacePagesBytes(target: Uint8Array, other: Uint8Array, pages: unknown) {
  line('replacePagesBytes', pages)
  get('replacePages')
  return { merged: concat(target, other), removed: pages, inserted: 1 }
}
export async function setPageSizeBytes(bytes: Uint8Array, width: number, height: number) {
  line('setPageSizeBytes', width, height)
  return bytesOr('setPageSize', bytes)
}
export async function splitPagesBytes(bytes: Uint8Array, perPage: number) {
  line('splitPagesBytes', perPage)
  return bytesOr('splitPages', bytes)
}
export async function cropPagesBytes(bytes: Uint8Array, pages: unknown, rect: unknown) {
  line('cropPagesBytes', pages, rect)
  return bytesOr('cropPages', bytes)
}

// ---- page-clipboard.ts ----

export async function copiedPagesOf(source: Uint8Array, _request: unknown, positions: unknown[]) {
  line('copiedPagesOf', positions)
  const v = get('copiedPagesOf')
  if (v === null) return null
  if (v !== undefined) return { bytes: utf8(v), count: 1 }
  const n = positions.length
  return n > 0 ? { bytes: source, count: n } : null
}
export function holdCopiedPages(pages: State['held']): void {
  st().held = pages
}
export function heldCopiedPages(): State['held'] {
  return st().held
}

// ---- pdf-lib + pdf-shrink.ts (reduce-file-size) ----

interface FakeDoc {
  out: Uint8Array
  save(): Promise<Uint8Array>
}
export const PDFDocument = {
  load: async (bytes: Uint8Array): Promise<FakeDoc> => {
    const doc: FakeDoc = { out: bytes, save: async () => doc.out }
    return doc
  },
}
export function shrinkDocument(doc: FakeDoc) {
  line('shrinkDocument')
  const v = (get('shrink') ?? {}) as Record<string, unknown>
  if (v.bytes !== undefined) doc.out = utf8(v.bytes)
  return {
    streamsRecompressed: num(v.streamsRecompressed, 0),
    imagesDownsampled: num(v.imagesDownsampled, 0),
  }
}

// ---- pdf-crypt.ts ----

export class WrongPasswordError extends Error {}
export class CertificateEncryptionError extends Error {}
export async function decryptDocument(bytes: Uint8Array, password: string) {
  line('decryptDocument', password)
  try {
    get('decryptDocument')
  } catch (err) {
    const m = (err as Error).message
    if (m === 'wrong-password') throw new WrongPasswordError()
    if (m === 'certificate-encryption') throw new CertificateEncryptionError()
    throw err
  }
  return { bytes, permissions: {}, neededPassword: password.length > 0, unlockedAs: 'user' }
}

// ---- annot-subjects.ts, image-edit.ts, text-edit.ts, read-text.ts, ocr.ts ----

export async function readAnnotSubjects(_bytes: Uint8Array) {
  line('readAnnotSubjects')
  return get('readAnnotSubjects') ?? []
}
export async function listPageImages(_bytes: Uint8Array) {
  line('listPageImages')
  return get('listPageImages') ?? []
}
export async function renderImagePng(
  _b: Uint8Array,
  pageIndex: number,
  rect: unknown,
  scale: number,
) {
  line('renderImagePng', pageIndex, rect, scale)
  return get('renderImagePng') ?? null
}
export async function renderPagePreviewPng(_b: Uint8Array, request: unknown) {
  line('renderPagePreviewPng', request)
  return get('renderPagePreviewPng') ?? null
}
export async function validateTextEdits(_b: Uint8Array, edits: unknown) {
  line('validateTextEdits', edits)
  return get('validateTextEdits') ?? []
}
export function canDrawText(text: string, font?: string, bold = false, italic = false): boolean {
  line('canDrawText', text, font ?? null, bold, italic)
  const v = get('canDrawText')
  return typeof v === 'boolean' ? v : true
}
export function listEditFonts(): string[] {
  return []
}
const noPdfium = (): never => {
  throw new Error('pdfium is not part of the pdf editor group')
}
export const chainPdfium = noPdfium
export const loadPdfium = noPdfium
export const saveDoc = noPdfium
export const withDocument = noPdfium
export async function readPdfText(bytes: Uint8Array, options?: { password?: string }) {
  line('readPdfText', options?.password ?? null)
  const v = get('readPdfText') as { pages?: unknown } | undefined
  const pages = Array.isArray(v?.pages)
    ? (v.pages as unknown[]).map((p) => (typeof p === 'string' ? p : ''))
    : [Buffer.from(bytes).toString('utf8')]
  return { pageCount: pages.length, pages: pages.map((text) => ({ text })) }
}
/** no OCR engine, as the Rust fake's environment finds none */
export async function ocrPagePng(_png: string) {
  return null
}

// ---- pdf-signatures.ts, pdf-sign.ts ----

export async function readPdfSignatures(_bytes: Uint8Array) {
  line('readPdfSignatures')
  return get('readPdfSignatures') ?? []
}
export function describeCertificate(): never {
  throw new Error('no certificate reader in the pdf editor group')
}
export class SignError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function opened() {
  try {
    const v = get('openCertificate')
    return { ok: true as const, loaded: {}, info: Array.isArray(v) ? v : [{ commonName: 'Fake' }] }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
}
export function openCertificate(_p12: Uint8Array, password: string) {
  line('openCertificate', password)
  return opened()
}
export function openExternalCertificate(_signer: unknown) {
  line('openExternalCertificate')
  return opened()
}
export async function signPdf(
  bytes: Uint8Array,
  options: { reason?: string; certifyLevel?: number },
) {
  line('signPdf', options.reason ?? null, options.certifyLevel ?? null)
  const v = take('signPdf') as { code?: string; error?: string } | undefined
  if (v?.code !== undefined) throw new SignError(v.code)
  if (v?.error !== undefined) throw new Error(v.error)
  return concat(bytes, utf8('%signed'))
}

// ---- ai-search, ai-provider/subscription ----

export function documentMediaRoots(openPath: string | undefined, _pasted: string) {
  return { openPath: openPath ?? null }
}
export async function withMediaCallSignal<T>(
  _sender: unknown,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return fn(new AbortController().signal)
}
export async function generateImageTool(
  _settings: string,
  op: { prompt: string; aspectRatio?: string },
  options: { mediaRoots: { openPath: string | null } },
) {
  line('generateImageTool', op.prompt, op.aspectRatio ?? null, options.mediaRoots.openPath)
  return get('generateImage') ?? null
}
export function sharedSubscriptionStatuses(): unknown[] {
  return []
}

// ---- packages/pdf-structure/src/store ----

export class ResultStore {
  constructor(_dir: string) {}
  async readNoteLinks() {
    line('ResultStore.readNoteLinks')
    get('readNoteLinks')
    return { links: {} }
  }
  async findNoteLink(pdfPath: string, docHash: string) {
    line('ResultStore.findNoteLink', pdfPath, docHash)
    get('findNoteLink')
    return null
  }
  async setNoteLink(pdfPath: string, link: { notePath: string; docHash: string }) {
    line('ResultStore.setNoteLink', pdfPath, link.notePath, link.docHash)
    get('setNoteLink')
  }
  async updateNoteLinkDocHash(pdfPath: string, docHash: string) {
    line('ResultStore.updateNoteLinkDocHash', pdfPath, docHash)
    get('updateNoteLinkDocHash')
    return true
  }
}
export async function documentHashOfFile(path: string) {
  line('documentHashOfFile', path)
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ---- node:crypto of pdf-main.ts: the certificate ids ----

/** numbered from 1 in each case, as the Rust fake's `random_uuid` */
export function randomUUID(): string {
  const s = st()
  s.uuid += 1
  return `00000000-0000-4000-8000-${String(s.uuid).padStart(12, '0')}`
}

// ---- node:fs `watch` of pdf-main.ts (diskWatchDeps), as PdfShell::watch_dir ----

/** a folder watch that reports only what a case's `disk-change` trigger tells it */
export function watch(
  dir: string,
  _options: unknown,
  listener: (event: string, name: string | null) => void,
) {
  const watches = st().watches
  watches.set(dir, listener)
  return {
    on: () => {},
    close: () => {
      if (watches.get(dir) === listener) watches.delete(dir)
    },
  }
}

/** the folder watch of `dir` reports `name` */
export function fireWatch(dir: string, name: string): void {
  st().watches.get(dir)?.('change', name)
}

// ---- node:os `tmpdir` of pdf-main.ts ----

/**
 * The case's `temp`, as the Rust side's `app.getPath('temp')`: the recovery
 * working folder and its sweep (files over a day old are deleted) stay in
 * the case, never the machine's own temporary folder
 */
export function tmpdir(): string {
  return st().tmp
}
