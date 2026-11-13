/**
 * What the Word editor's TypeScript reaches that its Rust port puts behind
 * `DocsEngine` and `DocsShell` (crates/shell-ipc/d2/src/docs/hosts.rs): the
 * lazy pictures, the byte handoff, officecrypto, doc2docx, html2docx, the mail
 * merge reader, pdf-lib, the Hangul worker, ai-search and the shell's hooks.
 * Each answers from the case's `hosts.d2.docs`, as the Rust fake does, and logs
 * the same line. Not a group.
 *
 * The modules are replaced for `docs-main.ts` only, by a resolve hook; their
 * functions call into `box`, which `useDocsCase` points at the case.
 */
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { CaseElectron } from '../../fakes.ts'

type Fn = (...args: unknown[]) => unknown

interface Box {
  case: Record<string, unknown>
  log: unknown[]
  uuid: number
  /** the case's folder: `os.tmpdir()` is its `temp` */
  dir: string
  fns: Record<string, Fn>
}

const KEY = Symbol.for('ipc-diff.d2.docs')
const g = globalThis as unknown as Record<symbol, Box>
const box: Box = (g[KEY] ??= { case: {}, log: [], uuid: 0, dir: '', fns: {} })

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** `case[method]`: an array is consumed one element per call (image_size excepted) */
export function answer(method: string): unknown {
  const slot = box.case[method]
  if (slot === undefined) return undefined
  if (Array.isArray(slot) && method !== 'image_size')
    return slot.length > 0 ? slot.shift() : undefined
  return slot
}

/** bytes as the Rust fake reads them: a string is its UTF-8, an array its numbers */
const bytesOf = (v: unknown): Buffer =>
  typeof v === 'string'
    ? Buffer.from(v, 'utf8')
    : Array.isArray(v)
      ? Buffer.from(v as number[])
      : Buffer.alloc(0)

const errorOf = (v: unknown): string | undefined => {
  const e = (v as { error?: unknown } | null | undefined)?.error
  return typeof e === 'string' ? e : undefined
}

const log = (...line: unknown[]): void => {
  box.log.push(line)
}

/** `crypto.randomUUID()` of the case: a counter, as the Rust fake's `random_uuid` */
export function nextUuid(): string {
  box.uuid++
  return `00000000-0000-4000-8000-${box.uuid.toString(16).padStart(12, '0')}`
}

const fns: Record<string, Fn> = {
  randomUUID: () => nextUuid(),
  tmpdir: () => join(box.dir, 'temp'),
  // lazy-media.ts
  openLazyDocx: async (path, view) => {
    log('openLazyDocx', path, view)
    const v = answer('open_lazy_docx') as { bytes?: unknown; hash?: unknown } | null | undefined
    if (!v || typeof v.hash !== 'string' || v.bytes === undefined) return null
    return { bytes: bytesOf(v.bytes), hash: v.hash }
  },
  adoptLazyMediaHashes: async (_bytes, path, view) => log('adoptLazyMediaHashes', path, view),
  materializeLazyDocx: async (bytes) => {
    log('materializeLazyDocx', hex(bytes as Buffer))
    const v = answer('materialize_lazy_docx') as
      { bytes?: unknown; hashes?: string[]; error?: string } | undefined
    if (v === undefined) return { bytes, hashes: new Set() }
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return {
      bytes: v.bytes === undefined ? bytes : bytesOf(v.bytes),
      hashes: new Set(v.hashes ?? []),
    }
  },
  pointLazyMediaAt: (hashes, path, view, plain) =>
    log('pointLazyMediaAt', [...(hashes as Set<string>)], path, view, plain !== undefined),
  moveLazyMediaSource: (from, to) => log('moveLazyMediaSource', from, to),
  forgetLazyMediaOwner: (view) => log('forgetLazyMediaOwner', view),
  readLazyMedia: async (url) => {
    log('readLazyMedia', url)
    const v = answer('read_lazy_media') as { body?: unknown; mime?: string } | null | undefined
    if (v === undefined || v === null) return null
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return { body: bytesOf(v.body), mime: v.mime ?? '' }
  },
  registerLazyMediaProtocol: () => {},
  // byte-handoff.ts
  handOffBytes: (bytes) => {
    const v = answer('hand_off_bytes')
    return typeof v === 'string' ? v : `handoff:${hex(bytes as Buffer)}`
  },
  takeHandoff: () => null,
  // officecrypto-tool (docx-encryption.ts)
  decrypt: async (_bytes, options) => {
    const password = (options as { password: string }).password
    log('officeCrypto.decrypt', password)
    const v = answer('decrypt_docx')
    if (typeof v === 'string') return Buffer.from(v, 'utf8')
    throw new Error(errorOf(v) ?? 'no engine')
  },
  encrypt: (bytes, options) => {
    const password = (options as { password: string }).password
    log('officeCrypto.encrypt', password)
    const v = answer('encrypt_docx')
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return v === undefined ? Buffer.concat([Buffer.from('ENC:'), bytes as Buffer]) : bytesOf(v)
  },
  // packages/doc2docx
  convertLegacyDocToDocx: async (bytes) => {
    log('convertLegacyDocToDocx', hex(bytes as Uint8Array))
    const v = answer('convert_legacy_doc')
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return { docx: v === undefined ? bytes : new Uint8Array(bytesOf(v)) }
  },
  // packages/html2docx
  convertHtmlToDocx: async () => {
    log('convertHtmlToDocx')
    const v = answer('html_to_docx')
    if (v === null) return new Promise(() => {})
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return { docx: new Uint8Array(v === undefined ? Buffer.from('docx') : bytesOf(v)) }
  },
  // merge-data-source.ts
  readMergeDataSource: async (path) => {
    log('readMergeDataSource', path)
    const v = answer('read_merge_data_source')
    if (v === undefined) return { path }
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return v
  },
  // pdf-links.ts
  addPdfInternalLinks: (pdf, links) => {
    log('addPdfInternalLinks', links)
    const v = answer('add_pdf_internal_links')
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    if (v !== undefined) (pdf as FakePdf).bytes = bytesOf(v)
    return 1
  },
  // @seuoffice/ai-search
  analyzeMediaTool: async (settingsPath, request, options) => {
    const r = request as { mediaUrls: string[]; requirements: string }
    log(
      'analyzeMediaTool',
      settingsPath,
      r.mediaUrls,
      r.requirements,
      (options as { mediaRoots: string[] }).mediaRoots,
    )
    const v = answer('analyze_media')
    if (v === undefined) return { ok: true }
    const e = errorOf(v)
    if (e !== undefined) throw new Error(e)
    return v
  },
  documentMediaRoots: (open, pasted) => (open ? [dirname(open as string), pasted] : [pasted]),
  withMediaCallSignal: (_sender, fn) => (fn as Fn)(new AbortController().signal),
}
box.fns = fns

/** pdf-lib's `PDFDocument`, as far as docs-main uses it */
class FakePdf {
  bytes: Buffer = Buffer.alloc(0)
  pages: Buffer[] = []
  static async load(data: Uint8Array): Promise<FakePdf> {
    const pdf = new FakePdf()
    pdf.bytes = Buffer.from(data)
    return pdf
  }
  static async create(): Promise<FakePdf> {
    const pdf = new FakePdf()
    pdf.pages = []
    return pdf
  }
  getPageIndices(): number[] {
    return [0]
  }
  async copyPages(part: FakePdf): Promise<Buffer[]> {
    return [part.bytes]
  }
  addPage(page: Buffer): void {
    this.pages.push(page)
  }
  async save(): Promise<Uint8Array> {
    if (this.pages.length > 0) {
      const v = answer('merge_pdfs')
      const e = errorOf(v)
      if (e !== undefined) throw new Error(e)
      if (v !== undefined) return bytesOf(v)
      return Buffer.concat(this.pages)
    }
    return this.bytes
  }
}
;(box.fns as Record<string, unknown>).PDFDocument = FakePdf

/** node:worker_threads' Worker of the Hangul export */
class FakeWorker {
  private readonly listeners: Record<string, Fn[]> = {}
  on(event: string, listener: Fn): this {
    ;(this.listeners[event] ??= []).push(listener)
    return this
  }
  postMessage(job: { docx: Uint8Array; format: string }): void {
    log('convertInWorker', job.format)
    const v = answer('convert_to_hwp') as
      { bytes?: unknown; losses?: unknown[]; code?: string; error?: string } | undefined
    const reply =
      v?.code !== undefined
        ? { ok: false, code: v.code, error: v.error ?? '' }
        : {
            ok: true,
            bytes: new Uint8Array(
              v?.bytes !== undefined
                ? bytesOf(v.bytes)
                : Buffer.concat([Buffer.from('hwp:'), Buffer.from(job.docx)]),
            ),
            losses: v?.losses ?? [],
          }
    setImmediate(() => {
      for (const l of this.listeners.message ?? []) l(reply)
    })
  }
  async terminate(): Promise<number> {
    return 0
  }
}
;(box.fns as Record<string, unknown>).Worker = FakeWorker

class FakeDriver {
  static async create(): Promise<FakeDriver> {
    return new FakeDriver()
  }
  isWindowDestroyed(): boolean {
    return false
  }
  destroyNow(): void {}
  async close(): Promise<void> {}
}
;(box.fns as Record<string, unknown>).ElectronBrowserDriver = FakeDriver

/** module name -> the names it exports to docs-main */
const MODULES: Record<string, string[]> = {
  './lazy-media': [
    'openLazyDocx',
    'adoptLazyMediaHashes',
    'materializeLazyDocx',
    'pointLazyMediaAt',
    'moveLazyMediaSource',
    'forgetLazyMediaOwner',
    'readLazyMedia',
    'registerLazyMediaProtocol',
  ],
  './byte-handoff': ['handOffBytes', 'takeHandoff'],
  './merge-data-source': ['readMergeDataSource'],
  './pdf-links': ['addPdfInternalLinks'],
  '../../../../packages/doc2docx/src': ['convertLegacyDocToDocx'],
  '../../../../packages/html2docx/src': ['convertHtmlToDocx'],
  '../../../../packages/html2docx/src/drivers/electron': ['ElectronBrowserDriver'],
  'pdf-lib': ['PDFDocument'],
  'node:worker_threads': ['Worker'],
  'officecrypto-tool': [],
}

/** constants the replaced modules export as values */
const CONSTANTS: Record<string, string> = {
  './merge-data-source': `export const MERGE_DATA_SOURCE_EXTENSIONS = ['xlsx', 'csv']`,
  '../../../../packages/doc2docx/src': `export const LEGACY_DOC_LIMITS = { maxBytes: 256 * 1024 * 1024 }`,
  'officecrypto-tool': `export default { decrypt: (...a) => box.fns.decrypt(...a), encrypt: (...a) => box.fns.encrypt(...a) }`,
}

const AI_SEARCH = ['analyzeMediaTool', 'documentMediaRoots', 'withMediaCallSignal']

const PREFIX = 'ipc-diff-d2-docs:'

/** builtins whose randomness and folders are the case's (the Rust takes them from its hosts) */
const BUILTINS: Record<string, string> = {
  'node:crypto': `export * from 'node:crypto'
import * as real from 'node:crypto'
export const randomUUID = () => box.fns.randomUUID()
export default { ...real, randomUUID }`,
  'node:os': `export * from 'node:os'
import * as real from 'node:os'
export const tmpdir = () => box.fns.tmpdir()
export default { ...real, tmpdir }`,
}

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (
      specifier in BUILTINS &&
      (parent.includes('/apps/docs/src/main/') || parent.includes('/packages/electron-utils/src/'))
    ) {
      return { url: `${PREFIX}${specifier}`, shortCircuit: true }
    }
    const fromDocs =
      parent.includes('/apps/docs/src/main/docs-main.ts') ||
      (specifier === 'officecrypto-tool' &&
        parent.includes('/apps/docs/src/main/docx-encryption.ts'))
    if (fromDocs && (specifier in MODULES || specifier === '@seuoffice/ai-search')) {
      return { url: `${PREFIX}${specifier}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith(PREFIX)) return next(url, context)
    const name = url.slice(PREFIX.length)
    const lines = [`const box = globalThis[Symbol.for('ipc-diff.d2.docs')]`]
    if (name in BUILTINS) {
      return { format: 'module', source: `${lines[0]}\n${BUILTINS[name]}`, shortCircuit: true }
    }
    if (name === '@seuoffice/ai-search') {
      lines.push(...AI_SEARCH.map((n) => `export const ${n} = (...a) => box.fns.${n}(...a)`))
      // every other name docs-main imports from it serves batch A's channels: no-ops
      lines.push(
        `const none = () => undefined`,
        ...[
          'abortMediaCalls',
          'aiToolCapabilities',
          'createCodexImageCliGenerator',
          'generateImageTool',
          'registerCodexImageGenerator',
          'testSearchProvider',
          'webSearchTool',
          'imageSearchTool',
          'readUrlTool',
        ].map((n) => `export const ${n} = none`),
      )
    } else {
      for (const n of MODULES[name]) {
        lines.push(
          n === 'PDFDocument' || n === 'Worker' || n === 'ElectronBrowserDriver'
            ? `export const ${n} = box.fns.${n}`
            : `export const ${n} = (...a) => box.fns.${n}(...a)`,
        )
      }
      if (CONSTANTS[name]) lines.push(CONSTANTS[name])
    }
    return { format: 'module', source: lines.join('\n'), shortCircuit: true }
  },
})

/** Points the fakes at a case: its answers (`hosts.d2.docs`), its log, its folder */
export function useDocsCase(
  electron: CaseElectron,
  dir: string,
  docs: Record<string, unknown>,
): void {
  box.case = structuredClone(docs)
  box.log = electron.log
  box.uuid = 0
  box.dir = dir
  // Date.now of the case: the recovery copies' metadata records it
  const now = typeof docs.now === 'number' ? docs.now : 1_700_000_000_000
  Date.now = () => now
}

/** The shell's hooks of this case (`setDocsShellHooks` and the hook setters) */
export function shellHooks(electron: CaseElectron): Record<string, unknown> {
  const view = (wc: unknown): number => (wc as { id: number }).id
  return {
    hooks: {
      openTab: () => {},
      listTabs: () => [],
      focusTab: () => {},
      closeActiveTab: () => {},
      openAiDocTabFor: (content: unknown, owner: number) => log('openAiDocTabFor', content, owner),
      openGeneratedPath: (path: string) => {
        log('openGeneratedPath', path)
        return answer('open_generated_path') === true
      },
      newDocumentDir: async (id: number) => {
        log('newDocumentDir', id)
        const v = answer('new_document_dir')
        return typeof v === 'string' ? v : null
      },
      ...(box.case.write_new_document === 'none'
        ? {}
        : {
            writeNewDocument: async (id: number, name: string, bytes: Uint8Array) => {
              log('writeNewDocument', id, name, hex(bytes))
              const v = answer('write_new_document')
              const e = errorOf(v)
              if (e !== undefined) throw new Error(e)
              if (typeof v !== 'string') return null
              writeFileSync(v, bytes)
              return v
            },
          }),
    },
    fileSaved: (wc: unknown, path: string) => {
      log('fileSavedHook', view(wc), path)
      const v = answer('file_saved')
      return typeof v === 'string' ? v : undefined
    },
    fileOpened: (id: number, path: string) => log('fileOpenedHook', id, path),
    active: () => {
      const v = answer('active_docs_view')
      return typeof v === 'number' ? electron.contents(v) : null
    },
  }
}

/** `Menu.getApplicationMenu()` whose items log what is set on them */
export function fakeMenu(): unknown {
  const item = (id: string) => ({
    set checked(v: boolean) {
      log('MenuItem.checked', id, v)
    },
    set enabled(v: boolean) {
      log('MenuItem.enabled', id, v)
    },
  })
  return {
    getApplicationMenu: () => ({ getMenuItemById: (id: string) => item(id) }),
    buildFromTemplate: () => ({}),
    setApplicationMenu: () => {},
  }
}

/** `nativeImage` with the size the case gives (`image_size`) */
export function fakeNativeImage(): unknown {
  return {
    createFromBuffer: (bytes: Buffer) => {
      const v = answer('image_size')
      const size =
        Array.isArray(v) && v.length === 2
          ? { width: v[0] as number, height: v[1] as number }
          : v === null
            ? null
            : bytes.length > 0
              ? { width: 1, height: 1 }
              : null
      return {
        isEmpty: () => size === null,
        getSize: () => size ?? { width: 0, height: 0 },
        toPNG: () => bytes,
      }
    },
    createEmpty: () => ({ isEmpty: () => true }),
  }
}

/** `net.fetch(url)` from the case (`net_fetch`) */
export function fakeNet(): unknown {
  return {
    fetch: async (url: string) => {
      log('net.fetch', url)
      const v = answer('net_fetch') as
        { status?: number; body?: unknown; type?: string; error?: string } | undefined
      if (v === undefined) throw new TypeError('fetch failed')
      const e = errorOf(v)
      if (e !== undefined) throw new Error(e)
      return new Response(bytesOf(v.body), {
        status: v.status ?? 200,
        headers: v.type ? { 'content-type': v.type } : {},
      })
    },
  }
}
