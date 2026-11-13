/**
 * What group `d2/epub` puts in place of the libraries the EPUB editor's main
 * process calls: `@seuoffice/epub-engine`, `@seuoffice/file-parse` and
 * `@seuoffice/pdf-structure/store` all resolve to this module (one module
 * that exports the names of all three). It is the TypeScript half of the
 * Rust fakes in crates/shell-ipc/d2/src/epub/hosts.rs (`FakeEngine`): both
 * answer from the case's `hosts.d2.epub.engine` and log the same lines.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import {
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_IMAGE_MAX_BYTES,
  ATTACHABLE_MAX_BYTES,
  attachableMaxBytes,
  diagramPictureExtOfName,
} from '../../../../../packages/file-parse/src/attachable.ts'
import { StoreWriteError } from '../../../../../packages/pdf-structure/src/store/files.ts'
import {
  isTranslationMode,
  jobKeyOf,
} from '../../../../../packages/pdf-structure/src/store/job-keys.ts'

export {
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_IMAGE_MAX_BYTES,
  ATTACHABLE_MAX_BYTES,
  StoreWriteError,
  attachableMaxBytes,
  diagramPictureExtOfName,
  isTranslationMode,
  jobKeyOf,
}

type Json = Record<string, unknown>

/** The case the fakes answer: set by the group's `load` */
interface CaseBox {
  engine: Json
  used: Map<string, number>
  log: unknown[]
}
const KEY = Symbol.for('ipc-diff.d2.epub')
const box = (): CaseBox => (globalThis as Record<symbol, CaseBox>)[KEY]

export function useCase(engine: unknown, log: unknown[]): void {
  ;(globalThis as Record<symbol, CaseBox>)[KEY] = {
    engine: (engine ?? {}) as Json,
    used: new Map(),
    log,
  }
}

/** `case[name]`: an array is a queue of answers (past its end: none), anything else answers every call */
function next(name: string): unknown {
  const { engine, used } = box()
  if (typeof engine !== 'object' || engine === null || !(name in engine)) return undefined
  const answer = engine[name]
  if (!Array.isArray(answer)) return answer
  const i = used.get(name) ?? 0
  used.set(name, i + 1)
  return answer[i]
}

const field = (v: unknown, key: string): unknown =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json)[key] : undefined
const textOf = (v: unknown, key: string): string => {
  const t = field(v, key)
  return typeof t === 'string' ? t : ''
}
const thrown = (v: unknown): string | undefined => {
  const t = field(v, 'throw')
  return typeof t === 'string' ? t : undefined
}

// ── the book ──

const DEFAULT_SUMMARY = {
  opfPath: 'OEBPS/content.opf',
  version: '3',
  metadata: {},
  manifest: [],
  spine: [
    {
      index: 0,
      idref: 'c1',
      path: 'OEBPS/c1.xhtml',
      mediaType: 'application/xhtml+xml',
      linear: true,
      properties: [],
      layout: null,
      fixedLayout: false,
    },
  ],
  pageProgressionDirection: null,
  toc: { source: 'spine', entries: [] },
  fixedLayout: false,
  verticalWriting: false,
}

/** the document hash `openEpub`'s answer named for these bytes */
const hashes = new WeakMap<Uint8Array, string>()
const bytesOf = new WeakMap<object, Uint8Array>()

export function openEpub(bytes: Uint8Array, _options?: unknown): unknown {
  const answer = next('open') ?? null
  const refused = field(answer, 'refused')
  if (typeof refused === 'string') return { ok: false, reason: refused }
  const summary = (field(answer, 'summary') ?? DEFAULT_SUMMARY) as Json
  const docHash = field(answer, 'docHash')
  if (typeof docHash === 'string') hashes.set(bytes, docHash)
  const texts = field(box().engine, 'readText')
  const book = {
    opfPath: summary.opfPath,
    version: summary.version,
    metadata: summary.metadata,
    manifest: summary.manifest,
    spine: { items: summary.spine, pageProgressionDirection: summary.pageProgressionDirection },
    toc: summary.toc,
    fixedLayout: summary.fixedLayout,
    verticalWriting: summary.verticalWriting,
    async readText(path: string) {
      const known = field(texts, path)
      if (known === undefined) return { text: `<p>${path}</p>`, valid: true }
      if (known === null) return null
      if (typeof known === 'string') return { text: known, valid: true }
      const valid = field(known, 'valid')
      return { text: textOf(known, 'text'), valid: typeof valid === 'boolean' ? valid : true }
    },
  }
  bytesOf.set(book, bytes)
  return { ok: true, book }
}

export function epubDocumentHash(bytes: Uint8Array): string {
  return hashes.get(bytes) ?? createHash('sha256').update(bytes).digest('hex')
}

export const normalizeZipPath = (path: string): string => path

// ── chapters: a run of <p>…</p> blocks ──

interface Range {
  start: number
  end: number
}
interface Block {
  id: string
  kind: string
  tag: string
  flowing: boolean
  outer: Range
  inner: Range
}
interface Chapter {
  broken: boolean
  source: string
  blocks?: Block[]
  nextId?: number
  error?: string
  offset?: number
  doc?: unknown
}
interface Replacement {
  start: number
  end: number
  text: string
}

function paragraphs(text: string): [Range, Range][] {
  const out: [Range, Range][] = []
  let at = 0
  for (;;) {
    const start = text.indexOf('<p>', at)
    if (start < 0) break
    const end = text.indexOf('</p>', start)
    if (end < 0) break
    out.push([
      { start, end: end + 4 },
      { start: start + 3, end },
    ])
    at = end + 4
  }
  return out
}

const broken = (source: string): Chapter => ({
  broken: true,
  source,
  error: 'not well-formed',
  offset: 0,
})

function numbered(text: string, id: (start: number) => string, nextId: number): Chapter {
  const blocks = paragraphs(text).map(([outer, inner]) => ({
    id: id(outer.start),
    kind: 'paragraph',
    tag: 'p',
    flowing: true,
    outer,
    inner,
  }))
  return { broken: false, source: text, doc: null, blocks, nextId }
}

export function openChapter(text: string): Chapter {
  if (text.includes('<broken')) return broken(text)
  const count = paragraphs(text).length
  let n = 0
  return numbered(text, () => `b${++n}`, count + 1)
}

export function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end)
  let out = ''
  let at = 0
  for (const r of sorted) {
    out += source.slice(at, Math.max(at, r.start)) + r.text
    at = Math.max(r.end, at)
  }
  return out + source.slice(at)
}

function diffReplacement(from: string, to: string): Replacement {
  let head = 0
  const max = Math.min(from.length, to.length)
  while (head < max && from.charCodeAt(head) === to.charCodeAt(head)) head++
  let tail = 0
  while (
    tail < max - head &&
    from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)
  ) {
    tail++
  }
  return { start: head, end: from.length - tail, text: to.slice(head, to.length - tail) }
}

export function composeReplacements(
  stored: string,
  earlier: readonly Replacement[],
  later: readonly Replacement[],
): Replacement[] {
  const current = applyReplacements(applyReplacements(stored, earlier), later)
  return current === stored ? [] : [diffReplacement(stored, current)]
}

export function validateReplacements(
  replacements: readonly Replacement[],
  length: number,
): string | null {
  let at = 0
  for (const r of replacements) {
    if (r.start < at || r.end < r.start || r.end > length) {
      return 'replacements overlap or leave the text'
    }
    at = r.end
  }
  return null
}

export function applyBlockEdits(map: Chapter, edits: readonly Json[]): unknown {
  const answer = next('applyBlockEdits')
  if (answer !== undefined) {
    const message = thrown(answer)
    if (message !== undefined) throw new Error(message)
    return {
      ok: false,
      refusal: field(answer, 'refusal') ?? null,
      index: field(answer, 'index') ?? 0,
    }
  }
  const items = (map.blocks ?? []).map((b) => [b.id, map.source.slice(b.inner.start, b.inner.end)])
  let nextId = map.nextId ?? 1
  const created: string[] = []
  for (const [i, edit] of edits.entries()) {
    const at = items.findIndex(([id]) => id === edit.blockId)
    const refused = {
      ok: false,
      refusal: { code: 'unsupported', message: 'the fake cannot apply this edit' },
      index: i,
    }
    if (at < 0) return refused
    if (edit.op === 'replace') items[at][1] = textOf(edit, 'text')
    else if (edit.op === 'insert_after') {
      const id = `b${nextId++}`
      created.push(id)
      items.splice(at + 1, 0, [id, textOf(edit, 'text')])
    } else if (edit.op === 'delete') items.splice(at, 1)
    else return refused
  }
  const text = items.map(([, t]) => `<p>${t}</p>`).join('')
  const ids = items.map(([id]) => id)
  let k = 0
  return {
    ok: true,
    map: numbered(text, () => ids[k++] ?? '', nextId),
    replacements: text === map.source ? [] : [diffReplacement(map.source, text)],
    created,
  }
}

function mapOffset(offset: number, replacements: readonly Replacement[]): number | null {
  let delta = 0
  for (const r of replacements) {
    if (offset < r.start) break
    if (offset < r.end) return null
    delta += r.text.length - (r.end - r.start)
  }
  return offset + delta
}

export function remapChapter(
  previous: Chapter,
  text: string,
  replacements: readonly Replacement[],
): Chapter {
  if (text.includes('<broken')) return broken(text)
  const carried = new Map<number, string>()
  for (const b of previous.blocks ?? []) {
    const at = mapOffset(b.outer.start, replacements)
    if (at !== null) carried.set(at, b.id)
  }
  let nextId = previous.nextId ?? 1
  const map = numbered(
    text,
    (start) => {
      const id = carried.get(start)
      if (id === undefined) return `b${nextId++}`
      carried.delete(start)
      return id
    },
    0,
  )
  map.nextId = nextId
  return map
}

export function extractChapterText(source: string): string {
  let out = ''
  let inTag = false
  for (const c of source) {
    if (c === '<') inTag = true
    else if (c === '>') inTag = false
    else if (!inTag) out += c
  }
  return out
}

export async function saveEpub(
  book: object,
  edits: Map<string, Replacement[]>,
  _options?: unknown,
): Promise<unknown> {
  const answer = next('save')
  if (answer === 'unchanged') return { ok: true, changed: false }
  if (answer !== undefined) {
    const message = thrown(answer)
    if (message !== undefined) throw new Error(message)
    const refused = field(answer, 'refused')
    if (refused !== undefined) {
      return { ok: false, reason: textOf(refused, 'reason'), detail: textOf(refused, 'detail') }
    }
  }
  if (edits.size === 0) return { ok: true, changed: false }
  const parts = [Buffer.from(bytesOf.get(book) ?? new Uint8Array())]
  for (const replacements of edits.values()) {
    for (const r of replacements) parts.push(Buffer.from(r.text, 'utf8'))
  }
  return { ok: true, changed: true, bytes: new Uint8Array(Buffer.concat(parts)) }
}

export async function epubMigrationInfo(
  _saved: unknown,
  hashes: { oldDocHash: string; newDocHash: string },
): Promise<unknown> {
  return { oldDocHash: hashes.oldDocHash, newDocHash: hashes.newDocHash }
}

export async function epubTranslationUnits(_book: unknown, _options: unknown): Promise<unknown> {
  const answer = next('translationUnits')
  if (answer === undefined) return { units: [], skipped: [] }
  const message = thrown(answer)
  if (message !== undefined) throw new Error(message)
  return answer
}

export async function buildTranslatedEpub(
  _bytes: Uint8Array,
  options: {
    kind: string
    lang: string
    chapters?: number[]
    results: Map<unknown, unknown>
    mode?: string
  },
): Promise<unknown> {
  const answer = next('buildTranslated')
  if (answer !== undefined) {
    const message = thrown(answer)
    if (message !== undefined) throw new Error(message)
    const refused = field(answer, 'refused')
    if (refused !== undefined) {
      return { ok: false, reason: textOf(refused, 'reason'), detail: textOf(refused, 'detail') }
    }
  }
  const easy = options.mode === 'easy' ? ' easy' : ''
  return {
    ok: true,
    bytes: new Uint8Array(
      Buffer.from(`${options.kind} ${options.lang} ${options.results.size} blocks${easy}`),
    ),
    report: { chapters: options.chapters?.length ?? 0 },
    identifier: 'urn:uuid:fake',
  }
}

// ── file-parse ──

export function diagramPictureExtOf(filePath: string): string | null {
  const ext = diagramPictureExtOfName(basename(filePath))
  if (!ext) return null
  try {
    if (statSync(filePath).size > ATTACHABLE_MAX_BYTES) return ext
  } catch {
    return ext
  }
  const holds = next('pictureHoldsDiagram')
  return typeof holds === 'boolean' && !holds ? null : ext
}

export async function parseFileToText(filePath: string): Promise<unknown> {
  const answer = next('parseFileToText')
  if (typeof answer === 'string') return { ok: true, kind: 'text', text: answer }
  if (answer !== undefined) {
    const error = field(answer, 'error')
    return {
      ok: false,
      damaged: field(answer, 'damaged') === true,
      ...(typeof error === 'string' ? { error } : {}),
    }
  }
  return { ok: true, kind: 'text', text: readFileSync(filePath, 'utf8') }
}

// ── the result store ──

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const nullableText = (v: unknown, key: string): string | null => {
  const t = field(v, key)
  return typeof t === 'string' ? t : null
}

export class ResultStore {
  readonly dir: string

  constructor(userDataDir: string) {
    if (!isAbsolute(userDataDir)) {
      throw new TypeError(`result store: the user-data folder must be absolute: ${userDataDir}`)
    }
    if (userDataDir.split(/[\\/]/).some((part) => part.toLowerCase() === '.genoffice')) {
      throw new TypeError('result store: ~/.genoffice belongs to the upstream program')
    }
    this.dir = join(userDataDir, 'pdf-store')
  }

  private line(method: string, ...args: unknown[]): void {
    box().log.push([`ResultStore.${method}`, ...args])
  }

  async listTranslations(): Promise<string[]> {
    return strings(next('listTranslations'))
  }

  async readTranslation(_docHash: string, lang: string): Promise<unknown> {
    const v = next('readTranslation')
    if (v === undefined || v === null) return null
    const blocks = field(v, 'blocks')
    return {
      lang,
      provider: nullableText(v, 'provider'),
      model: nullableText(v, 'model'),
      blocks: new Map((Array.isArray(blocks) ? blocks : []).map((b, i) => [i, b])),
    }
  }

  async unfinishedJobs(): Promise<unknown[]> {
    const v = next('unfinishedJobs')
    return Array.isArray(v) ? v : []
  }

  async writeTranslationMeta(...args: unknown[]): Promise<void> {
    this.line('writeTranslationMeta', ...args)
  }

  async writeTranslationBlocks(...args: unknown[]): Promise<void> {
    this.line('writeTranslationBlocks', ...args)
  }

  async deleteTranslation(...args: unknown[]): Promise<void> {
    this.line('deleteTranslation', ...args)
  }

  async deleteTranslationExceptEdited(...args: unknown[]): Promise<number> {
    this.line('deleteTranslationExceptEdited', ...args)
    const v = next('deleteTranslationExceptEdited')
    return typeof v === 'number' ? v : 0
  }

  async writeJob(...args: unknown[]): Promise<void> {
    this.line('writeJob', ...args)
  }

  async heartbeatJob(...args: unknown[]): Promise<boolean> {
    this.line('heartbeatJob', ...args)
    const v = next('heartbeatJob')
    return typeof v === 'boolean' ? v : true
  }

  async migrateDocument(info: unknown): Promise<unknown> {
    this.line('migrateDocument', info)
    return null
  }
}
