/**
 * Group `d2/pdf-editor`: the PDF editor's handlers
 * (`apps/pdf/src/main/pdf-main.ts`, its recovery in `pdf-recovery.ts`)
 * against crates/shell-ipc/d2/src/pdf/editor, configured as the shell entry
 * configures it (`configurePdfRuntime`, the redaction and rename hooks, the
 * split-pane probe).
 *
 * What the Rust port puts behind `PdfEngine` is replaced for this group by
 * `pdf-editor-fakes.ts` (a resolve hook below), answering from the same
 * `hosts.d2.pdf.engine` as the Rust fake; the shell hooks answer from
 * `hosts.d2.pdf.shell` here and in `PdfShell`'s fake. Both log the same
 * lines.
 *
 * A view gets its file only from the shell (`createPdfView`), so most cases
 * start with the `open-view` trigger; the other triggers are the shell's
 * calls into the editor (`flushPdfSave`, `requestPdfSaveAsOutcome`, ...).
 * The Rust side is `pdf::editor::probe::probe_trigger`.
 *
 * `pdf:disk-file-changed`: pdf-main's `fs.watch` is the fake of
 * `pdf-editor-fakes.ts`, which reports only what the `disk-change` trigger
 * tells it; the trigger then waits out pdf-main's real settle timers. The
 * Rust side runs the watcher's timers at once (`disk_change_now`).
 */
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setOpenPathProbe } from '@seuoffice/electron-utils'
import type * as PdfMainModule from '../../../../apps/pdf/src/main/pdf-main.ts'
import type { Call, Case, Group, LoadContext } from '../../types.ts'
import { fireWatch, resetPdfEditorFakes } from './pdf-editor-fakes.ts'
import { basename, dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'

const ENTRY = 'apps/pdf/src/main/pdf-main.ts'
type PdfMain = typeof PdfMainModule

// ---- the modules behind PdfEngine answer from the fakes ----

const FAKES = pathToFileURL(fileURLToPath(new URL('./pdf-editor-fakes.ts', import.meta.url))).href
const FAKED_FILES = [
  'apps/pdf/src/main/save-pdf.ts',
  'apps/pdf/src/main/page-clipboard.ts',
  'apps/pdf/src/main/pdf-shrink.ts',
  'apps/pdf/src/main/pdf-crypt.ts',
  'apps/pdf/src/main/annot-subjects.ts',
  'apps/pdf/src/main/image-edit.ts',
  'apps/pdf/src/main/text-edit.ts',
  'apps/pdf/src/main/read-text.ts',
  'apps/pdf/src/main/ocr.ts',
  'apps/pdf/src/main/pdf-sign.ts',
  'apps/pdf/src/main/pdf-signatures.ts',
  'packages/pdf-structure/src/store/index.ts',
]
const FAKED_PACKAGES = ['pdf-lib', '@seuoffice/ai-search', '@seuoffice/ai-provider/subscription']
const CRYPTO = 'ipc-diff:d2-pdf-editor-crypto'
const FS = 'ipc-diff:d2-pdf-editor-fs'
const OS = 'ipc-diff:d2-pdf-editor-os'
const fromPdfMain = (parent: string | undefined) =>
  /\/apps\/pdf\/src\/main\/pdf-main\.ts/.test(parent ?? '')

registerHooks({
  resolve(specifier, context, next) {
    if (FAKED_PACKAGES.includes(specifier)) return { url: FAKES, shortCircuit: true }
    // pdf-main's certificate ids come from randomUUID: numbered per case
    if ((specifier === 'node:crypto' || specifier === 'crypto') && fromPdfMain(context.parentURL)) {
      return { url: CRYPTO, shortCircuit: true }
    }
    // its folder watch reports only what a case tells it (PdfShell::watch_dir)
    if ((specifier === 'node:fs' || specifier === 'fs') && fromPdfMain(context.parentURL)) {
      return { url: FS, shortCircuit: true }
    }
    // its recovery working folder (and the sweep of it) under the case's temp
    if ((specifier === 'node:os' || specifier === 'os') && fromPdfMain(context.parentURL)) {
      return { url: OS, shortCircuit: true }
    }
    const resolved = next(specifier, context)
    const path = resolved.url.split('?')[0]
    if (FAKED_FILES.some((f) => path.endsWith(`/${f}`))) return { url: FAKES, shortCircuit: true }
    return resolved
  },
  load(url, context, next) {
    if (url === CRYPTO) {
      return {
        format: 'module',
        source: `export * from 'node:crypto'\nexport { randomUUID } from ${JSON.stringify(FAKES)}`,
        shortCircuit: true,
      }
    }
    if (url === OS) {
      return {
        format: 'module',
        source: `export * from 'node:os'\nexport { tmpdir } from ${JSON.stringify(FAKES)}`,
        shortCircuit: true,
      }
    }
    if (url === FS) {
      return {
        format: 'module',
        source: `export * from 'node:fs'\nexport { watch } from ${JSON.stringify(FAKES)}`,
        shortCircuit: true,
      }
    }
    return next(url, context)
  },
})

// ---- the shell around the editor ----

type Fn = (...args: unknown[]) => unknown

/** what the shell gave a view: the listeners createPdfView attached */
interface Hooked {
  open?: Fn
  on: Map<string, Fn[]>
}

interface Loaded {
  cx: LoadContext
  mod: PdfMain
  hooked: Map<number, Hooked>
  /** the contents the next `new WebContentsView()` gets */
  next: Record<string, unknown> | null
}
let loaded: Loaded | null = null

/** `hosts.d2.pdf.shell`, taken as the Rust fake takes it */
function shellAnswers(cx: LoadContext) {
  const pdf = (
    (cx.case.hosts ?? {}).d2 as { pdf?: { shell?: Record<string, unknown> } } | undefined
  )?.pdf
  const shell = pdf?.shell ?? {}
  const used = new Map<string, number>()
  const take = (name: string): unknown => {
    const v = shell[name]
    if (!Array.isArray(v) || v.length === 0) return v
    const n = used.get(name) ?? 0
    used.set(name, n + 1)
    return v[Math.min(n, v.length - 1)]
  }
  return { shell, take }
}

/** a view's contents as createPdfView uses them */
function hook(l: Loaded, contents: Record<string, unknown>): Record<string, unknown> {
  const id = contents.id as number
  const h: Hooked = { on: new Map() }
  l.hooked.set(id, h)
  const listen = (event: string, fn: Fn) => h.on.set(event, [...(h.on.get(event) ?? []), fn])
  return Object.assign(contents, {
    setWindowOpenHandler: (fn: Fn) => (h.open = fn),
    on: listen,
    once: listen,
    loadURL: async () => {},
    reload: () => l.cx.electron.log.push(['webContents.reload', id]),
  })
}

async function load(cx: LoadContext): Promise<void> {
  const pdf = ((cx.case.hosts ?? {}).d2 as { pdf?: unknown } | undefined)?.pdf
  resetPdfEditorFakes(pdf, cx.electron.log, join(cx.dir, 'temp'))
  const shared = (cx.case.hosts?.shared ?? {}) as { recoveryRunId?: string }
  ;(globalThis as Record<symbol, unknown>)[Symbol.for('seuoffice.recovery-store.shared')] = {
    shuttingDown: false,
    epochs: new Map(),
    queues: new Map(),
    runId: shared.recoveryRunId ?? '0000000000000000',
    discarded: new Set(),
  }
  const { shell, take } = shellAnswers(cx)
  setOpenPathProbe(() => take('isPathOpenElsewhere') === true)
  const log = cx.electron.log

  const l: Loaded = { cx, mod: null as unknown as PdfMain, hooked: new Map(), next: null }
  class WebContentsView {
    webContents: Record<string, unknown>
    constructor() {
      this.webContents = l.next ?? hook(l, { id: 9999, isDestroyed: () => false, send() {} })
      l.next = null
    }
  }
  cx.install({ WebContentsView })
  l.mod = await cx.fresh<PdfMain>(ENTRY)
  l.mod.configurePdfRuntime({
    preloadPath: '',
    openGeneratedPath: (path: string) => {
      log.push(['openGeneratedPath', path])
      return take('openGeneratedPath') === true
    },
    ...('createDocument' in shell
      ? {
          createDocument: async (request: unknown, owner?: number) => {
            log.push(['createDocument', request, owner])
            const v = take('createDocument') as { error?: unknown } | undefined
            if (v && typeof v === 'object' && typeof v.error === 'string') throw new Error(v.error)
            return v as never
          },
        }
      : {}),
    ...('openPdfTools' in shell
      ? {
          openPdfTools: (path: string, tool: string) => {
            log.push(['openPdfTools', path, tool])
            const v = take('openPdfTools')
            return typeof v === 'boolean' ? v : (undefined as unknown as boolean)
          },
        }
      : {}),
    ...(shell.noteHooks === true
      ? {
          openNote: (path: string) => (log.push(['openNote', path]), true),
          insertIntoNote: (path: string, text: string) => (
            log.push(['insertIntoNote', path, text]),
            true
          ),
        }
      : {}),
    newDocumentDir: async () => {
      const v = take('newDocumentDir')
      return typeof v === 'string' ? v : null
    },
  })
  l.mod.setPdfRedactionSavedHook((wc, path) => log.push(['pdfRedactionSavedHook', wc.id, path]))
  l.mod.setPdfRenamedHook((wc, oldPath, newPath) =>
    log.push(['pdfRenamedHook', wc.id, oldPath, newPath]),
  )
  // registerPdfIpc runs with the first view; a view no case calls from
  l.mod.createPdfView(null)
  loaded = l
}

/** the shell's calls into the editor, by `d2/pdf:<name>`: the pdf-main.ts export */
const calls: Record<string, (view: number, args: unknown[]) => Promise<unknown>> = {
  async 'open-view'(view, args) {
    const l = loaded!
    l.next = hook(l, l.cx.electron.contents(view) as unknown as Record<string, unknown>)
    l.mod.createPdfView((args[0] as string | undefined) ?? null)
  },
  'flush-pdf-save': (view, args) => loaded!.mod.flushPdfSave(contentsOf(view), args[0] === true),
  'request-pdf-close': (view, args) => {
    const BrowserWindow = loaded!.cx.electron.BrowserWindow as { fromId(id: number): unknown }
    const parent = typeof args[0] === 'number' ? BrowserWindow.fromId(args[0]) : undefined
    return loaded!.mod.requestPdfClose(contentsOf(view), parent as never)
  },
  'request-pdf-save-as-outcome': async (view, args) =>
    loaded!.mod.requestPdfSaveAsOutcome(contentsOf(view), args[0] as string),
  'request-pdf-save-as': async (view, args) =>
    loaded!.mod.requestPdfSaveAs(contentsOf(view), args[0] as string),
  'request-pdf-page-images': async (view, args) =>
    loaded!.mod.requestPdfPageImages(contentsOf(view), args[0] as string),
  'set-pdf-save-as-in-flight': async (view, args) =>
    loaded!.mod.setPdfSaveAsInFlight(contentsOf(view), args[0] === true),
  'pdf-file-renamed': async (view, args) =>
    loaded!.mod.pdfFileRenamed(contentsOf(view), args[0] as string, args[1] as string),
  'write-pdf-copies-now': () => loaded!.mod.writePdfCopiesNow(),
  'discard-pdf-recovery': async (view) => loaded!.mod.discardPdfRecovery(contentsOf(view)),
  'pdf-close-cancelled': async (view) => loaded!.mod.pdfCloseCancelled(contentsOf(view)),
  'pdf-is-dirty': async (view) => loaded!.mod.pdfIsDirty(view),
  'clear-pdf-dirty': async (view) => loaded!.mod.clearPdfDirty(view),
  'mark-pdf-untitled-path': async (_view, args) =>
    loaded!.mod.markPdfUntitledPath(args[0] as string),
  'mark-pdf-untitled-copy': async (_view, args) =>
    loaded!.mod.markPdfUntitledCopy(args[0] as string),
  'open-file-with-decision': async (view, args) =>
    loaded!.mod.pdfRecoveryEditor.openFileWithDecision(contentsOf(view), args[0] as never),
  async 'disk-change'(_view, args) {
    const path = String(args[0])
    if (typeof args[1] === 'string') writeFileSync(path, args[1])
    else rmSync(path, { force: true })
    fireWatch(dirname(path), basename(path))
    // pdf-main's settle timer (400 ms) runs twice for a change, twice for a removal
    await new Promise((r) => setTimeout(r, 2000))
  },
  'window-open': async (view, args) => loaded!.hooked.get(view)?.open?.({ url: args[0] }),
  'render-process-gone': async (view) => fire(view, 'render-process-gone'),
  'did-start-loading': async (view) => fire(view, 'did-start-loading'),
}

export const triggers: Group['triggers'] = Object.fromEntries(
  Object.entries(calls).map(([name, run]) => [
    `d2/pdf:${name}`,
    (_cx: unknown, view: number, args: unknown[]) => run(view, args),
  ]),
)

function contentsOf(view: number): never {
  return loaded!.cx.electron.contents(view) as never
}

function fire(view: number, event: string): void {
  for (const fn of loaded!.hooked.get(view)?.on.get(event) ?? []) fn()
}

// ---- cases ----

/** a step of a case: a renderer call, or the shell calling the editor */

const DOC = '$DIR/doc.pdf'
const ORIGINAL = '%PDF-1.7 original %%EOF'
const PDF_VIEW = [{ view: 1, surface: 'Pdf' }]
const TWO_VIEWS = [
  { view: 1, surface: 'Pdf' },
  { view: 2, surface: 'Pdf' },
]
const files = { 'doc.pdf': ORIGINAL }

const call = (channel: string, ...args: unknown[]): Call => ({ channel, args })
const send = (channel: string, ...args: unknown[]): Call => ({ channel, kind: 'send', args })
const trigger = (name: string, ...args: unknown[]): Call => ({
  channel: `d2/pdf:${name}`,
  kind: 'trigger',
  name: `d2/pdf:${name}`,
  view: 1,
  args,
})
/** a trigger that waits for the renderer: its answer is taken by `awaitStep` */
const waits = (name: string, ...args: unknown[]): Call => ({
  ...trigger(name, ...args),
  defer: true,
})
/** the answer of the deferred step at `index` */
const awaitStep = (index: number): Call => ({ channel: '', args: [], await: index })
const open = (path = DOC) => trigger('open-view', path)
const u8 = (text: string) => ({
  args: { $: 'b', k: 'u8', i: 0 },
  hex: Buffer.from(text).toString('hex'),
})
const ab = (text: string) => ({
  args: { $: 'b', k: 'ab', i: 0 },
  hex: Buffer.from(text).toString('hex'),
})
const withBuffer = (
  channel: string,
  before: unknown[],
  b: { args: unknown; hex: string },
  after: unknown[] = [],
): Call => ({
  channel,
  args: [...before, b.args, ...after],
  buffers: [b.hex],
})

interface CaseIn {
  note: string
  views?: Case['views']
  files?: Case['files']
  pdf?: { engine?: Record<string, unknown>; shell?: Record<string, unknown> }
  shared?: Record<string, unknown>
  calls: Call[]
}
const c = (x: CaseIn): Case =>
  ({
    note: x.note,
    views: x.views ?? PDF_VIEW,
    files: x.files ?? files,
    hosts: { d2: { pdf: x.pdf ?? {} }, ...(x.shared ? { shared: x.shared } : {}) },
    calls: x.calls,
  }) as Case

const save = (extra: Record<string, unknown> = {}) =>
  call('pdf:save', { path: DOC, markups: [], drawings: [], formValues: [], stamps: [], ...extra })

const cases: Case[] = [
  // ---- a view the shell did not give a file ----
  c({
    note: 'the shell window cannot reach the editor',
    views: [{ view: 1, surface: 'Shell' }],
    calls: [call('pdf:read-file', DOC)],
  }),
  c({
    note: 'a PDF view without a file: reads are refused',
    calls: [
      call('pdf:consume-pending'),
      call('pdf:read-file', DOC),
      call('pdf:read-file-chunk', DOC, 0, 4),
      call('pdf:watch-disk-file', DOC),
      call('pdf:discard-for-disk-reload', DOC),
      call('pdf:is-untitled', DOC),
      call('pdf:is-untitled-copy', DOC),
      call('pdf:auto-rename', DOC, 'Name'),
      call('pdf:open-in-pdf-tools', DOC, 'compress'),
      call('pdf:note-unsaved'),
      call('pdf:copied-page-count'),
      call('pdf:recovery-state', DOC),
      call('pdf:list-digital-signatures', DOC),
    ],
  }),
  c({
    note: 'a PDF view without a file: writes are refused',
    calls: [
      save(),
      call('pdf:request-redaction-copy', DOC),
      call('pdf:template-bytes', { path: DOC }),
      call('pdf:pick-untitled-copy-target', DOC, 'a.pdf'),
      call('pdf:adopt-untitled-copy', DOC),
      call('pdf:restore-file', { path: DOC }),
      call('pdf:copy-pages', { source: { path: DOC }, pages: [0] }),
      call('pdf:paste-pages', { path: DOC }),
      call('pdf:insert-blank-page', { path: DOC }),
      call('pdf:insert-pdf', { path: DOC }),
      call('pdf:extract-pages', { path: DOC, pages: [0] }),
      call('pdf:split-pdf', { path: DOC }),
      call('pdf:merge-pdf', { path: DOC }),
      call('pdf:merge-pages', { path: DOC, perSheet: 2 }),
      call('pdf:replace-pages', { path: DOC, pages: [0] }),
      call('pdf:set-page-size', { path: DOC, width: 10, height: 10 }),
      call('pdf:split-pages', { path: DOC, perPage: 2 }),
      call('pdf:crop-pages', { path: DOC, pages: [0], rect: [0, 0, 1, 1] }),
      call('pdf:reduce-file-size', DOC),
      call('pdf:export-attachment', DOC, 'a.txt', 'aGk='),
      call('pdf:sign-with-certificate', { path: DOC }),
      call('pdf:compare-read-open', DOC),
      call('pdf:recovery-write-copy', { path: DOC }),
    ],
  }),
  c({
    note: 'a PDF view without a file: engine reads throw',
    calls: [
      call('pdf:list-page-images', DOC),
      call('pdf:annot-subjects', DOC),
      call('pdf:list-static-form-fills', DOC),
      call('pdf:page-image-png', { path: DOC, pageIndex: 0, rect: [0, 0, 1, 1] }),
      call('pdf:page-preview-png', { path: DOC }),
      call('pdf:validate-text-edits', { path: DOC, edits: [] }),
    ],
  }),
  c({
    note: 'a PDF view without a file is not a registered view',
    calls: [
      call('pdf:create-document', { type: 'md', title: 'T', content: 'c' }),
      call('pdf:note-open', {}),
      call('pdf:note-insert', { kind: 'text' }),
      call('pdf:pick-attachment-file'),
      call('pdf:compare-read-pdf'),
    ],
  }),
  // ---- calls that need no file ----
  c({
    note: 'the author name comes from the app settings',
    files: { 'userData/app-settings.json': '{"authorName":"  Kim  "}' },
    calls: [call('pdf:get-username')],
  }),
  c({
    note: 'decrypt: a malformed request, then the engine opens it',
    calls: [
      call('pdf:decrypt', 'not bytes', 'pw'),
      withBuffer('pdf:decrypt', [], u8('%PDF enc'), [7]),
      withBuffer('pdf:decrypt', [], u8('%PDF enc'), ['secret']),
      withBuffer('pdf:decrypt', [], u8('%PDF enc'), ['']),
    ],
  }),
  c({
    note: 'decrypt: why the engine refused',
    pdf: {
      engine: {
        decryptDocument: [
          { error: 'wrong-password' },
          { error: 'certificate-encryption' },
          { error: 'pdf: broken xref' },
        ],
      },
    },
    calls: [
      withBuffer('pdf:decrypt', [], u8('x'), ['a']),
      withBuffer('pdf:decrypt', [], u8('x'), ['b']),
      withBuffer('pdf:decrypt', [], u8('x'), ['c']),
    ],
  }),
  c({
    note: 'can-draw-text checks its text and asks the font engine',
    pdf: { engine: { canDrawText: [true, false] } },
    calls: [
      call('pdf:can-draw-text', 3),
      call('pdf:can-draw-text', '가', 'Serif', true, 'yes'),
      call('pdf:can-draw-text', 'x'),
    ],
  }),
  c({
    note: 'ocr: a bad payload is a failed page, no engine is null',
    calls: [
      call('pdf:ocr-page', ''),
      call('pdf:ocr-page', 5),
      call('pdf:ocr-page', 'iVBORw0KGgo='),
    ],
  }),
  c({
    note: 'generate-image answers what the tool gave, and rejects with its error',
    pdf: { engine: { generateImage: [{ ok: true, path: '/img.png' }, { error: 'quota' }] } },
    calls: [
      call('pdf:generate-image', { prompt: 'a cat', aspectRatio: '1:1' }),
      call('pdf:generate-image', { prompt: 7 }),
    ],
  }),
  // ---- saved signatures (userData/pdf-signatures.json) ----
  c({
    note: 'no signatures yet; bad data and an unknown id change nothing',
    files: {},
    calls: [
      call('pdf:list-signatures'),
      call('pdf:add-signature', { kind: 'image' }),
      call('pdf:remove-signature', 'nope'),
      call('pdf:remove-signature', 3),
    ],
  }),
  c({
    note: 'saved signatures are read, and one is removed',
    files: {
      'userData/pdf-signatures.json': JSON.stringify([
        { id: 'a', createdAt: 1, data: { kind: 'image', image: 'data:x', width: 10, height: 5 } },
        { id: 'b', createdAt: 2, data: { kind: 'image', image: 'data:y', width: 20, height: 8 } },
      ]),
    },
    calls: [
      call('pdf:list-signatures'),
      call('pdf:add-signature', null),
      call('pdf:remove-signature', 'a'),
      call('pdf:list-signatures'),
    ],
  }),
  // ---- certificates ----
  c({
    note: 'picking a certificate file: cancelled, then picked and inspected',
    files: { 'me.p12': 'p12 bytes' },
    shared: { dialogs: { open: [null, ['$DIR/me.p12']] } },
    calls: [
      call('pdf:pick-certificate'),
      call('pdf:pick-certificate'),
      call('pdf:inspect-certificate', '00000000-0000-4000-8000-000000000001', 'pw'),
      call('pdf:inspect-certificate', '00000000-0000-4000-8000-000000000001', 5),
      call('pdf:inspect-certificate', 'other', 'pw'),
      send('pdf:release-certificate', '00000000-0000-4000-8000-000000000001'),
      send('pdf:release-certificate', 4),
    ],
  }),
  c({
    note: 'a certificate the engine refuses, and a file that went missing',
    files: { 'me.p12': 'p12', 'gone.p12': 'p12' },
    pdf: { engine: { openCertificate: { error: 'cert-wrong-password' } } },
    shared: { dialogs: { open: [['$DIR/me.p12']] } },
    calls: [
      call('pdf:pick-certificate'),
      call('pdf:inspect-certificate', '00000000-0000-4000-8000-000000000001', 'bad'),
    ],
  }),
  c({
    note: 'a picked file removed before it is read',
    files: {},
    shared: { dialogs: { open: [['$DIR/missing.p12']] } },
    calls: [
      call('pdf:pick-certificate'),
      call('pdf:inspect-certificate', '00000000-0000-4000-8000-000000000001', 'pw'),
    ],
  }),
  c({
    note: 'the OS certificate store as this platform has it',
    calls: [call('pdf:list-system-certificates'), call('pdf:list-system-certificates', 'store-pw')],
  }),
  // ---- renderer sends that only change state ----
  c({
    note: 'the renderer reports without anyone waiting',
    calls: [
      send('pdf:dirty-changed', true),
      send('pdf:close-save-result', true),
      send('pdf:save-as-result', 'cancelled'),
      send('pdf:recovery-flush-done'),
      call('pdf:recovery-resume'),
      call('pdf:recovery-unprotectable', false),
    ],
  }),
  c({
    note: 'export-images checks its request before any dialog',
    calls: [
      call('pdf:export-images', { images: [] }),
      call('pdf:export-images', { images: ['aGk='], pageNumbers: [0] }),
      call('pdf:export-images', { images: ['aGk='], pageNumbers: [1], saveAs: true }),
    ],
  }),

  // ---- with the file the shell gave (trigger open-view) ----
  c({
    note: 'the opened file reads whole and in chunks, others not',
    files: { ...files, 'other.pdf': 'x' },
    calls: [
      open(),
      call('pdf:consume-pending'),
      call('pdf:read-file', DOC),
      call('pdf:read-file', '$DIR/other.pdf'),
      call('pdf:read-file-chunk', DOC, 2, 5),
      call('pdf:read-file-chunk', DOC, 5, 2),
      call('pdf:read-file-chunk', DOC, 0, 8388609),
      call('pdf:read-file-chunk', DOC, 0.5, 3),
    ],
  }),
  c({
    note: 'a file that does not exist gives the view nothing',
    files: {},
    calls: [
      open('$DIR/missing.pdf'),
      call('pdf:consume-pending'),
      call('pdf:read-file', '$DIR/missing.pdf'),
    ],
  }),
  c({
    note: 'watching the file; an untitled copy is not watched',
    calls: [
      open(),
      call('pdf:watch-disk-file', DOC),
      call('pdf:discard-for-disk-reload', DOC),
      trigger('mark-pdf-untitled-copy', DOC),
      call('pdf:watch-disk-file', DOC),
      call('pdf:is-untitled-copy', DOC),
      trigger('did-start-loading'),
    ],
  }),
  c({
    note: 'another program changes the file, then removes it: the view hears of both',
    calls: [
      open(),
      call('pdf:read-file', DOC),
      call('pdf:watch-disk-file', DOC),
      trigger('disk-change', DOC, '%PDF-1.7 rewritten elsewhere %%EOF'),
      trigger('disk-change', DOC, null),
    ],
  }),
  c({
    note: 'save in place and its refusals',
    files: { ...files, 'copy.pdf': 'c' },
    calls: [
      open(),
      save(),
      save({ targetPath: '$DIR/copy.pdf' }),
      save({ annotations: 'burn' }),
      save({ annotations: 'flatten' }),
      save({ copyOnly: true }),
      call('pdf:save', null),
    ],
  }),
  c({
    note: 'save in place: the engine failed or skipped edits',
    pdf: {
      engine: {
        savePdfToPath: [{ error: 'pdf: save failed' }, { skippedTextEdits: [{ id: 'e1' }] }],
      },
    },
    calls: [open(), save(), save()],
  }),
  c({
    note: 'Save As through the shell: the copy goes to the granted target only',
    calls: [
      open(),
      waits('request-pdf-save-as-outcome', '$DIR/copy.pdf'),
      save({ targetPath: '$DIR/copy.pdf', copyOnly: true, redactions: [] }),
      save({ targetPath: '$DIR/copy.pdf', copyOnly: true }),
      save({ targetPath: '$DIR/copy.pdf', annotations: 'strip', encryption: {} }),
      send('pdf:save-as-result', true),
      awaitStep(1),
      save({ targetPath: '$DIR/copy.pdf', copyOnly: true }),
    ],
  }),
  c({
    note: 'a Save As the renderer cancels, then one it fails',
    calls: [
      open(),
      waits('request-pdf-save-as-outcome', '$DIR/a.pdf'),
      send('pdf:save-as-result', 'cancelled'),
      awaitStep(1),
      waits('request-pdf-save-as', '$DIR/b.pdf'),
      send('pdf:save-as-result', 'oops'),
      awaitStep(4),
    ],
  }),
  c({
    note: 'a sibling pane holds the file: an automatic save defers',
    pdf: { shell: { isPathOpenElsewhere: true } },
    calls: [open(), save({ auto: true }), save({ auto: 'yes' })],
  }),
  c({
    note: 'redactions need a Save As copy and nothing else pending',
    calls: [
      open(),
      save({ redactions: [{ pageIndex: 0, rect: [0, 0, 10, 10] }] }),
      save({ redactions: [{ pageIndex: -1, rect: [0, 0, 10, 10] }] }),
      waits('request-pdf-save-as-outcome', '$DIR/red.pdf'),
      save({
        targetPath: '$DIR/red.pdf',
        redactions: [{ pageIndex: 0, rect: [0, 0, 10, 10] }],
        deletedPages: [1],
      }),
      call('pdf:save', {
        path: DOC,
        targetPath: '$DIR/red.pdf',
        redactions: [{ pageIndex: 0, rect: [0, 0, 10, 10] }],
      }),
      save({ targetPath: '$DIR/red.pdf', redactions: [{ pageIndex: 0, rect: [0, 0, 10, 10] }] }),
      call('pdf:read-file', '$DIR/red.pdf'),
      call('pdf:read-file', DOC),
      send('pdf:save-as-result', true),
      awaitStep(3),
    ],
  }),
  c({
    note: 'the redaction copy flow: cancelled, then picked and saved by the renderer',
    shared: { dialogs: { save: [null, '$DIR/doc-redacted.pdf'] } },
    calls: [
      open(),
      call('pdf:request-redaction-copy', DOC),
      call('pdf:request-redaction-copy', '$DIR/other.pdf'),
      trigger('set-pdf-save-as-in-flight', true),
      { ...call('pdf:request-redaction-copy', DOC), defer: true },
      call('pdf:request-redaction-copy', DOC),
      send('pdf:save-as-result', true),
      awaitStep(4),
    ],
  }),
  c({
    note: 'template bytes: the edits applied, none for a protected document',
    pdf: { engine: { pdfBytesWithEdits: '%PDF with edits' } },
    calls: [
      open(),
      call('pdf:template-bytes', { path: DOC }),
      call('pdf:template-bytes', { path: DOC, decryption: { userPassword: 'x' } }),
    ],
  }),
  c({
    note: 'an untitled copy goes where the person picks',
    files: { ...files, documents: { dir: true } },
    shared: { dialogs: { save: [null, '$DIR/Kept'] } },
    calls: [
      open(),
      call('pdf:adopt-untitled-copy', DOC),
      trigger('mark-pdf-untitled-copy', DOC),
      call('pdf:adopt-untitled-copy', DOC),
      call('pdf:pick-untitled-copy-target', DOC, 'Mine.pdf'),
      call('pdf:pick-untitled-copy-target', DOC, 'Mine.pdf'),
      call('pdf:adopt-untitled-copy', DOC),
      call('pdf:read-file', '$DIR/Kept.pdf'),
      call('pdf:is-untitled-copy', '$DIR/Kept.pdf'),
    ],
  }),
  c({
    note: 'an untitled copy in a project folder starts there',
    pdf: { shell: { newDocumentDir: '$DIR/project' } },
    shared: { dialogs: { save: [null] } },
    calls: [
      open(),
      trigger('mark-pdf-untitled-copy', DOC),
      call('pdf:pick-untitled-copy-target', DOC, 3),
    ],
  }),
  c({
    note: 'restoring a kept copy needs this view to own the last write',
    calls: [
      open(),
      withBuffer('pdf:restore-file', [], ab('old')),
      call('pdf:restore-file', { path: DOC, bytes: 'old' }),
      call('pdf:insert-blank-page', { path: DOC, afterPageIndex: 0 }),
      {
        channel: 'pdf:restore-file',
        args: [{ path: DOC, bytes: { $: 'b', k: 'ab', i: 0 } }],
        buffers: [Buffer.from('old').toString('hex')],
      },
    ],
  }),
  // ---- untitled blanks and renames ----
  c({
    note: 'only an untitled blank renames from its content, never over a file',
    files: { ...files, 'Budget.pdf': 'taken' },
    calls: [
      open(),
      call('pdf:auto-rename', DOC, 'Budget'),
      trigger('mark-pdf-untitled-path', DOC),
      call('pdf:is-untitled', DOC),
      call('pdf:note-unsaved'),
      call('pdf:auto-rename', DOC, 7),
      call('pdf:auto-rename', DOC, ' ... '),
      call('pdf:auto-rename', DOC, 'doc'),
      call('pdf:auto-rename', DOC, 'Budget'),
      call('pdf:auto-rename', DOC, 'Budget'),
      call('pdf:note-unsaved'),
      save({ path: '$DIR/Budget-2.pdf' }),
      call('pdf:note-unsaved'),
    ],
  }),
  c({
    note: 'the shell renamed the file: the view follows and hears of it',
    calls: [
      open(),
      trigger('pdf-file-renamed', DOC, '$DIR/moved.pdf'),
      call('pdf:read-file', DOC),
      call('pdf:consume-pending'),
    ],
  }),
  // ---- hand-offs ----
  c({
    note: 'documents are created by the shell after the request checks',
    pdf: { shell: { createDocument: [{ ok: true, path: '/x.md' }, { error: 'disk full' }] } },
    calls: [
      open(),
      call('pdf:create-document', { type: 'txt', title: 'a', content: 'b' }),
      call('pdf:create-document', { type: 'md', title: '  ', content: 'b' }),
      call('pdf:create-document', { type: 'md', title: ' Notes ', content: 'body' }),
      call('pdf:create-document', { type: 'pdf', title: 'x'.repeat(201), content: 'b' }),
      call('pdf:create-document', { type: 'docx', title: 'Report', content: 'body' }),
    ],
  }),
  c({
    note: 'without a creator in the host, documents are unavailable',
    calls: [open(), call('pdf:create-document', { type: 'md', title: 'a', content: 'b' })],
  }),
  c({
    note: "the PDF tools open only for the view's file and a listed task",
    pdf: { shell: { openPdfTools: true } },
    calls: [
      open(),
      call('pdf:open-in-pdf-tools', DOC, 'format'),
      call('pdf:open-in-pdf-tools', DOC, 'compress'),
      call('pdf:open-in-pdf-tools', '$DIR/x.pdf', 'compress'),
    ],
  }),
  c({
    note: 'notes: no shell hooks, and a malformed insert',
    calls: [
      open(),
      call('pdf:note-open', { title: 'T' }),
      call('pdf:note-insert', 'x'),
      call('pdf:note-insert', { kind: 'nope' }),
    ],
  }),
  c({
    note: 'notes: the dialog is cancelled, then a note is opened',
    pdf: { shell: { noteHooks: true } },
    shared: { dialogs: { save: [null, '$DIR/doc-note.md'] } },
    calls: [open(), call('pdf:note-open', {}), call('pdf:note-open', { title: 'Mine' })],
  }),
  // ---- page operations ----
  c({
    note: 'insert a blank page, then insert a picked PDF',
    files: { ...files, 'other.pdf': '+OTHER' },
    pdf: { engine: { insertBlankPage: '%PDF blank added', insertPdf: 3 } },
    shared: { dialogs: { open: [null, ['$DIR/other.pdf']] } },
    calls: [
      open(),
      call('pdf:insert-blank-page', { path: DOC, afterPageIndex: 2 }),
      call('pdf:insert-pdf', { path: DOC, afterPageIndex: 0 }),
      call('pdf:insert-pdf', { path: DOC, afterPageIndex: '1' }),
      call('pdf:read-file', DOC),
    ],
  }),
  c({
    note: 'copy pages, paste them in another view',
    files: { ...files, 'two.pdf': 'TWO' },
    views: TWO_VIEWS,
    calls: [
      open(),
      { ...trigger('open-view', '$DIR/two.pdf'), view: 2 },
      call('pdf:paste-pages', { path: DOC }),
      call('pdf:copy-pages', { source: { path: DOC, encryption: {} }, pages: [0] }),
      call('pdf:copy-pages', { source: { path: DOC, targetPath: '$DIR/x.pdf' }, pages: [0] }),
      call('pdf:copy-pages', { source: { path: DOC }, pages: [0, 1] }),
      call('pdf:copied-page-count'),
      { channel: 'pdf:paste-pages', view: 2, args: [{ path: '$DIR/two.pdf', afterPageIndex: 0 }] },
      { channel: 'pdf:read-file', view: 2, args: ['$DIR/two.pdf'] },
    ],
  }),
  c({
    note: 'copy pages of an encrypted source: protected',
    files: { 'doc.pdf': 'trailer << /Encrypt 3 0 R >>' },
    calls: [open(), call('pdf:copy-pages', { source: { path: DOC }, pages: [0] })],
  }),
  c({
    note: 'copy pages that are not there',
    pdf: { engine: { copiedPagesOf: null } },
    calls: [open(), call('pdf:copy-pages', { source: { path: DOC }, pages: [9] })],
  }),
  c({
    note: 'generated PDFs go to the save folder and open in a tab',
    files: { ...files, documents: { dir: true } },
    pdf: { shell: { openGeneratedPath: [true, false] } },
    calls: [
      open(),
      call('pdf:extract-pages', { path: DOC, pages: [0], suggestedName: 'part.pdf' }),
      call('pdf:extract-pages', { path: DOC, pages: 'all' }),
      call('pdf:split-pages', { path: DOC, perPage: 3 }),
      call('pdf:split-pages', { path: DOC, perPage: 4 }),
      call('pdf:merge-pages', { path: DOC, perSheet: 17 }),
      call('pdf:merge-pages', { path: DOC, perSheet: 4, direction: 'horizontal', separator: true }),
    ],
  }),
  c({
    note: 'split into a picked folder, merge picked files',
    files: { ...files, out: { dir: true }, 'a.pdf': 'AAA', documents: { dir: true } },
    pdf: { engine: { splitPdf: [['one', 'two']] } },
    shared: { dialogs: { open: [null, ['$DIR/out'], null, ['$DIR/a.pdf']] } },
    calls: [
      open(),
      call('pdf:split-pdf', { path: DOC }),
      call('pdf:split-pdf', { path: DOC, chunkSize: 2, baseName: 'a:b' }),
      call('pdf:merge-pdf', { path: DOC }),
      call('pdf:merge-pdf', { path: DOC, suggestedName: 'all.pdf' }),
    ],
  }),
  c({
    note: 'replace, resize and crop pages in place',
    files: { ...files, 'new.pdf': 'NEW' },
    shared: { dialogs: { open: [null, ['$DIR/new.pdf']] } },
    pdf: { engine: { setPageSize: '%PDF resized', cropPages: { error: 'pdf: bad crop' } } },
    calls: [
      open(),
      call('pdf:replace-pages', { path: DOC, pages: [] }),
      call('pdf:replace-pages', { path: DOC, pages: [0] }),
      call('pdf:replace-pages', { path: DOC, pages: [0] }),
      call('pdf:set-page-size', { path: DOC, width: 0, height: 10 }),
      call('pdf:set-page-size', { path: DOC, width: 100, height: 200 }),
      call('pdf:crop-pages', { path: DOC, pages: [0] }),
      call('pdf:crop-pages', { path: DOC, pages: [0], rect: [0, 0, 5, 5] }),
      call('pdf:read-file', DOC),
    ],
  }),
  c({
    note: 'reduce file size: cancelled, not smaller, smaller',
    shared: { dialogs: { save: [null, '$DIR/doc-small.pdf', '$DIR/doc-small.pdf'] } },
    pdf: {
      engine: { shrink: [{}, { bytes: 'tiny', imagesDownsampled: 2, streamsRecompressed: 1 }] },
    },
    calls: [
      open(),
      call('pdf:reduce-file-size', DOC),
      call('pdf:reduce-file-size', DOC),
      call('pdf:reduce-file-size', DOC),
    ],
  }),
  // ---- images and attachments ----
  c({
    note: 'export page images into a picked folder',
    files: { ...files, imgs: { dir: true } },
    shared: { dialogs: { open: [null, ['$DIR/imgs']] } },
    calls: [
      open(),
      call('pdf:export-images', { images: ['aGk='], pageNumbers: [1], baseName: 'doc' }),
      call('pdf:export-images', {
        images: ['aGk=', 'aGk='],
        pageNumbers: [1, 3],
        baseName: 'doc',
        format: 'jpg',
      }),
    ],
  }),
  c({
    note: 'Save As > PNG: the name the shell picked, used once',
    calls: [
      open(),
      trigger('request-pdf-page-images', '$DIR/pages.jpg'),
      trigger('request-pdf-page-images', '$DIR/pages.png'),
      call('pdf:export-images', {
        images: ['aGk=', 'aGk='],
        pageNumbers: [1, 2],
        saveAs: true,
        format: 'jpg',
      }),
      trigger('request-pdf-page-images', '$DIR/pages.png'),
      call('pdf:export-images', { images: ['aGk=', 'aGk='], pageNumbers: [1, 2], saveAs: true }),
    ],
  }),
  c({
    note: 'attachments travel base64 through main-side dialogs',
    files: { ...files, 'note.txt': 'hi' },
    shared: {
      dialogs: {
        open: [null, ['$DIR/note.txt'], ['$DIR/missing.txt']],
        save: [null, '$DIR/out.txt'],
      },
    },
    calls: [
      open(),
      call('pdf:pick-attachment-file'),
      call('pdf:pick-attachment-file'),
      call('pdf:pick-attachment-file'),
      call('pdf:export-attachment', DOC, 'note.txt', 'aGk='),
      call('pdf:export-attachment', DOC, 'note.txt', 'aGk='),
      call('pdf:export-attachment', DOC, 1, 'aGk='),
    ],
  }),
  c({
    note: "engine reads of the view's document",
    pdf: {
      engine: {
        listPageImages: [{ pageIndex: 0, rect: [0, 0, 1, 1], aboveText: false }],
        readAnnotSubjects: [{ subject: 'Key' }],
        readStaticFormFills: [{ id: 'f' }],
        renderImagePng: 'iVBOR',
        renderPagePreviewPng: { png: 'iVBOR', width: 2 },
        validateTextEdits: [{ ok: true }],
      },
    },
    calls: [
      open(),
      call('pdf:list-page-images', DOC),
      call('pdf:annot-subjects', DOC),
      call('pdf:list-static-form-fills', DOC),
      call('pdf:page-image-png', { path: DOC, pageIndex: 0, rect: [0, 0, 1, 1], scale: 2 }),
      call('pdf:page-image-png', { path: DOC, pageIndex: '0', rect: [0, 0, 1, 1] }),
      call('pdf:page-preview-png', {
        path: DOC,
        pageIndex: 0,
        excludeRects: [],
        clip: null,
        pxWidth: 100,
        rotate: 0,
      }),
      call('pdf:page-preview-png', {
        path: DOC,
        pageIndex: 0,
        excludeRects: [],
        clip: 1,
        pxWidth: 1,
        rotate: 0,
      }),
      call('pdf:validate-text-edits', { path: DOC, edits: [{ id: 1 }] }),
      call('pdf:validate-text-edits', { path: DOC, edits: 'all' }),
    ],
  }),
  c({
    note: 'an engine read that fails rejects',
    pdf: { engine: { listPageImages: { error: 'pdfium: bad page' } } },
    calls: [open(), call('pdf:list-page-images', DOC)],
  }),
  c({
    note: 'compare: the open document and a picked one, by text',
    files: { ...files, 'b.pdf': 'BBB' },
    shared: { dialogs: { open: [null, ['$DIR/b.pdf']] } },
    pdf: { engine: { readPdfText: [{ pages: ['one', 'two'] }, { error: 'pdf: locked' }] } },
    calls: [
      open(),
      call('pdf:compare-read-open', DOC, 'pw'),
      call('pdf:compare-read-open', DOC),
      call('pdf:compare-read-pdf'),
      call('pdf:compare-read-pdf'),
    ],
  }),
  c({
    note: 'digital signatures of the document',
    pdf: { engine: { readPdfSignatures: [{ signer: 'Kim', valid: true }] } },
    calls: [
      open(),
      call('pdf:list-digital-signatures', DOC),
      call('pdf:list-digital-signatures', 3),
    ],
  }),
  // ---- signing ----
  c({
    note: 'signing needs a clean view and writes a new file',
    files: { ...files, 'me.p12': 'p12' },
    shared: { dialogs: { open: [['$DIR/me.p12']], save: [null, '$DIR/doc-signed.pdf', DOC] } },
    calls: [
      open(),
      call('pdf:pick-certificate'),
      call('pdf:sign-with-certificate', { path: DOC, certId: 'x', password: 'pw' }),
      call('pdf:sign-with-certificate', {
        path: DOC,
        certId: '00000000-0000-4000-8000-000000000001',
        password: 'pw',
        certifyLevel: 4,
      }),
      send('pdf:dirty-changed', true),
      call('pdf:sign-with-certificate', {
        path: DOC,
        certId: '00000000-0000-4000-8000-000000000001',
        password: 'pw',
      }),
      send('pdf:dirty-changed', false),
      call('pdf:sign-with-certificate', {
        path: DOC,
        certId: '00000000-0000-4000-8000-000000000001',
        password: 'pw',
      }),
      call('pdf:sign-with-certificate', {
        path: DOC,
        certId: '00000000-0000-4000-8000-000000000001',
        password: 'pw',
        reason: '  approved  ',
        certifyLevel: 2,
      }),
      call('pdf:read-file', '$DIR/doc-signed.pdf'),
    ],
  }),
  c({
    note: 'the signer refuses the document',
    files: { ...files, 'me.p12': 'p12' },
    shared: { dialogs: { open: [['$DIR/me.p12']], save: ['$DIR/s1.pdf', '$DIR/s2.pdf'] } },
    pdf: { engine: { signPdf: [{ code: 'pdf-encrypted' }, { error: 'boom' }] } },
    calls: [
      open(),
      call('pdf:pick-certificate'),
      call('pdf:sign-with-certificate', {
        path: DOC,
        certId: '00000000-0000-4000-8000-000000000001',
        password: 'pw',
      }),
      call('pdf:sign-with-certificate', {
        path: DOC,
        certId: '00000000-0000-4000-8000-000000000001',
        password: 'pw',
      }),
    ],
  }),
  // ---- the shell waits on the renderer ----
  c({
    note: 'a dirty view is flushed: the renderer answers',
    calls: [
      open(),
      trigger('flush-pdf-save', true),
      send('pdf:dirty-changed', true),
      trigger('pdf-is-dirty'),
      waits('flush-pdf-save', false),
      send('pdf:close-save-result', true),
      awaitStep(4),
    ],
  }),
  c({
    note: "closing a dirty view: save, cancel, don't save",
    shared: { dialogs: { message: [{ response: 0 }, { response: 2 }, { response: 1 }] } },
    calls: [
      open(),
      send('pdf:dirty-changed', true),
      waits('request-pdf-close', 1),
      send('pdf:close-save-result', 'yes'),
      awaitStep(2),
      trigger('request-pdf-close'),
      trigger('request-pdf-close', 1),
      trigger('pdf-close-cancelled'),
      call('pdf:recovery-resume'),
    ],
  }),
  // ---- recovery ----
  c({
    note: 'recovery copies wait for the view to resolve its file; a failed serialization',
    pdf: { engine: { pdfBytesWithEditsOf: { error: 'pdf: bad edit' } } },
    calls: [
      open(),
      call('pdf:recovery-write-copy', { path: DOC }),
      call('pdf:consume-pending'),
      call('pdf:recovery-write-copy', { path: DOC, targetPath: '$DIR/x.pdf' }),
      call('pdf:recovery-write-copy', { path: DOC, encryption: {} }),
      call('pdf:recovery-write-copy', { path: DOC }),
    ],
  }),
  c({
    note: 'an encrypted source gets no copy and one notice',
    files: { 'doc.pdf': 'trailer << /Encrypt 3 0 R >>' },
    calls: [
      open(),
      call('pdf:consume-pending'),
      call('pdf:recovery-write-copy', { path: DOC }),
      call('pdf:recovery-unprotectable', false),
      call('pdf:recovery-unprotectable', true),
    ],
  }),
  c({
    note: "Don't Save drops the copies until the close is cancelled",
    calls: [
      open(),
      call('pdf:consume-pending'),
      trigger('discard-pdf-recovery'),
      call('pdf:recovery-write-copy', { path: DOC }),
      trigger('pdf-close-cancelled'),
    ],
  }),
  c({
    note: 'the OS session ends: dirty views write their copy now',
    calls: [
      open(),
      trigger('write-pdf-copies-now'),
      send('pdf:dirty-changed', true),
      waits('write-pdf-copies-now'),
      send('pdf:recovery-flush-done'),
      awaitStep(3),
    ],
  }),
  c({
    note: 'an untitled copy written into is unsaved without pending edits',
    calls: [
      open(),
      trigger('mark-pdf-untitled-copy', DOC),
      call('pdf:recovery-state', DOC),
      call('pdf:insert-blank-page', { path: DOC }),
      call('pdf:recovery-state', DOC),
      trigger('pdf-is-dirty'),
      trigger('clear-pdf-dirty'),
    ],
  }),
  c({
    note: 'a launch decision for a view that read its file reloads it',
    calls: [
      open(),
      call('pdf:consume-pending'),
      send('pdf:dirty-changed', true),
      trigger('open-file-with-decision', { filePath: DOC, decision: 'original' }),
      trigger('pdf-is-dirty'),
      trigger('render-process-gone'),
      trigger('window-open', 'https://example.com/a'),
      trigger('window-open', 'javascript:alert(1)'),
    ],
  }),
]

export const group: Group = {
  batch: 'D2',
  load,
  cases,
  triggers,
  single: {
    'pdf:dirty-changed': 'a send answers nothing; the flag shows in later calls',
    'pdf:close-save-result': 'a send answers nothing; the waiting flush shows the result',
    'pdf:save-as-result': 'a send answers nothing; the waiting Save As shows the result',
    'pdf:recovery-flush-done': 'a send answers nothing; the waiting session end shows it',
    'pdf:release-certificate': 'a send answers nothing',
    'pdf:list-system-certificates':
      'the platform decides the listing (macOS has no supported store); the store password only reaches an NSS store',
  },
}
