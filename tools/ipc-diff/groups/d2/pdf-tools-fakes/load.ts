/**
 * The TypeScript side of the PDF tools groups (`d2/pdf-tools-*`): the four
 * shell modules registered as apps/shell/src/main/index.ts registers them
 * (`registerPdfStructureIpc()`, `registerPdfConvertUiIpc(tabs)`,
 * `configurePdfToolsWindow(deps)`, the password dialog on its first prompt),
 * with what crates/shell-ipc/d2's `pdf::tools` puts behind its host traits
 * answering from the same case (`hosts.d2.pdf.tools`, state.cts):
 *
 * - the structure-job process (`utilityProcess.fork`) and `ResultStore`
 *   (store.cts), pdf-lib's tool functions (tools.cts), the job set-up's wasm
 *   paths (wasm-path.cts), the tools window's `randomUUID` (crypto.cts), and
 *   the pdf editor's grant table (pdf-main.cts) replace the real modules
 *   through a module hook;
 * - the shell's hooks (tab manager, open result, language, theme) are the
 *   deps the module is configured with; the tools and password windows are a
 *   fake `BrowserWindow` whose web contents are the case's `ShellPdfTools`
 *   (900 by default) and `ShellPdfPassword` (901) views.
 *
 * `triggers` are the shell's calls into the tools outside a channel
 * (`d2/pdf-tools:<what>`, crates/shell-ipc/d2's `pdf::tools::probe_trigger`).
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setOpenFilesSource } from '../../../../../packages/electron-utils/src/unsaved-files.ts'
import type { Call, Group, LoadContext } from '../../../types.ts'
import { answer, ipc, log, startCase, state } from './state.cts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../../..')
const url = (path: string): string => pathToFileURL(resolve(root, path)).href
const fake = (name: string): string => pathToFileURL(resolve(here, name)).href

const WINDOW_URL = url('apps/shell/src/main/pdf-tools/pdf-tools-window.ts')
const STRUCTURE_URL = url('apps/shell/src/main/pdf-structure-ipc.ts')
const CONVERT_URL = url('apps/shell/src/main/pdf-convert-ui.ts')
const INDEX_URL = url('apps/shell/src/main/index.ts')
const FAKES = pathToFileURL(here).href

/**
 * real module -> its fake, for the importers named (every importer but the
 * fakes themselves when none are): the editor's grant table only for the
 * tools, so the shell entry still loads the real pdf editor
 */
const REPLACED = new Map<string, { fake: string; parents?: string[] }>([
  [url('packages/pdf-structure/src/store/index.ts'), { fake: fake('store.cts') }],
  [
    url('apps/pdf/src/main/pdf-main.ts'),
    { fake: fake('pdf-main.cts'), parents: [STRUCTURE_URL, CONVERT_URL] },
  ],
  [url('apps/pdf/src/main/wasm-path.ts'), { fake: fake('wasm-path.cts') }],
  [url('apps/shell/src/main/pdf-tools/tools.ts'), { fake: fake('tools.cts') }],
  // the shell entry's active pdf tab, its converter and the Hangul editor's
  // Import PDF (group d2/pdf-tools-office)
  [
    url('apps/shell/src/main/detached-windows.ts'),
    { fake: fake('detached-windows.cts'), parents: [INDEX_URL] },
  ],
  [
    url('apps/shell/src/main/pdf2docx-local.ts'),
    { fake: fake('pdf2docx-local.cts'), parents: [INDEX_URL] },
  ],
  [url('apps/hwp/src/main/hwp-main.ts'), { fake: fake('hwp-main.cts'), parents: [INDEX_URL] }],
])

registerHooks({
  resolve(specifier, context, next) {
    // a CommonJS parent loaded with `?case=N` (cx.fresh) names it `%3Fcase=N`
    const parent = context.parentURL?.split(/\?|%3F/)[0]
    if (specifier === 'node:crypto' && parent === WINDOW_URL) {
      return { url: fake('crypto.cts'), shortCircuit: true }
    }
    if (specifier === 'electron' && parent === STRUCTURE_URL) {
      return { url: fake('electron.cts'), shortCircuit: true }
    }
    const resolved = next(specifier, context)
    if (parent?.startsWith(FAKES)) return resolved
    const target = REPLACED.get(resolved.url.split(/\?|%3F/)[0])
    if (!target || (target.parents && !target.parents.includes(parent ?? ''))) return resolved
    return { url: target.fake, shortCircuit: true }
  },
})

type Structure = typeof import('../../../../../apps/shell/src/main/pdf-structure-ipc.ts')
type ConvertUi = typeof import('../../../../../apps/shell/src/main/pdf-convert-ui.ts')
type PasswordDialog = typeof import('../../../../../apps/shell/src/main/pdf-password-dialog.ts')
type ToolsWindow = typeof import('../../../../../apps/shell/src/main/pdf-tools/pdf-tools-window.ts')

interface Loaded {
  cx: LoadContext
  structure: Structure
  convert: ConvertUi
  password: PasswordDialog
  window: ToolsWindow
  quit: (() => unknown)[]
}
let loaded: Loaded | null = null

const field = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' && key in v ? (v as Record<string, unknown>)[key] : undefined

/** `utilityProcess.fork(pdf-structure-process)`: the child answers from `run_job` */
function fork() {
  const listeners: Record<string, (message: unknown) => void> = {}
  return {
    on(event: string, listener: (message: unknown) => void) {
      listeners[event] = listener
    },
    kill: () => true,
    postMessage(message: { job: unknown }) {
      log(['runStructureJob', message.job])
      const a = answer('run_job')
      const send = (m: unknown) => listeners.message?.(m)
      if (a === undefined) {
        send({ type: 'error', error: 'not-available', message: 'no job process' })
        return
      }
      const progress = field(a, 'progress')
      for (const [done, total] of Array.isArray(progress) ? progress : []) {
        send({ type: 'progress', done, total })
      }
      const error = field(a, 'error')
      if (error !== undefined) send({ type: 'error', error, message: field(a, 'message') })
      else send({ type: 'result', value: ipc(field(a, 'value')) })
    },
  }
}

/** the case's `hosts.d2.pdf.tools` for the fakes the shell entry reaches (group d2/pdf-tools-office) */
export function startToolsCase(cx: LoadContext): void {
  startCase(field(field(field(cx.case.hosts, 'd2'), 'pdf'), 'tools'), cx.electron.log)
}

export async function loadPdfTools(cx: LoadContext): Promise<void> {
  const tools = field(field(field(cx.case.hosts, 'd2'), 'pdf'), 'tools')
  startCase(tools, cx.electron.log)
  const views = (cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]).map((v) => ({
    view: v.view,
    window: v.window ?? v.view,
    surface: v.surface ?? 'Shell',
  }))
  const windowOfView = (view: number) => views.find((v) => v.view === view)?.window ?? view
  const { electron } = cx
  const cases = electron.BrowserWindow as Record<string, (...a: unknown[]) => unknown>
  const quit: (() => unknown)[] = []

  class FakeBrowserWindow {
    static getAllWindows = cases.getAllWindows
    static fromWebContents = cases.fromWebContents
    static fromId = cases.fromId
    static getFocusedWindow = cases.getFocusedWindow
    id: number
    webContents: Record<string, unknown>
    private readonly kind: 'tools' | 'password'
    constructor(options: {
      parent?: { id: number }
      title?: string
      webPreferences?: { preload?: string }
    }) {
      this.kind = String(options.webPreferences?.preload).includes('pdf-password')
        ? 'password'
        : 'tools'
      const parent = options.parent?.id ?? null
      const asked = this.kind === 'tools' ? 'open_tools_window' : 'open_password_window'
      log([
        this.kind === 'tools' ? 'openPdfToolsWindow' : 'promptPdfPassword.window',
        parent,
        options.title,
      ])
      const a = answer(asked)
      const view = typeof a === 'number' ? a : this.kind === 'tools' ? 900 : 901
      this.id = windowOfView(view)
      const contents = (electron.contents(view) ?? {
        id: view,
        send() {},
        isDestroyed: () => true,
      }) as unknown as Record<string, unknown>
      contents.setWindowOpenHandler ??= () => {}
      this.webContents = contents
    }
    removeMenu() {}
    once() {}
    on() {}
    loadURL = async () => {}
    loadFile = async () => {}
    isDestroyed = () => false
    isMinimized = () => false
    restore() {}
    show() {
      if (this.kind === 'tools') log(['pdfToolsWindow.show', this.webContents.id])
    }
    focus() {
      if (this.kind === 'password') log(['webContents.focus', this.webContents.id])
    }
    close() {
      log(['BrowserWindow.close', this.id])
    }
  }

  cx.install({
    app: {
      ...(electron.app as object),
      on: (event: string, listener: () => unknown) => {
        if (event === 'will-quit') quit.push(listener)
      },
    },
    utilityProcess: { fork },
    // the blank-page thumbnails: the Rust `png_data_url` fake's answer
    nativeImage: {
      ...(electron.nativeImage as object),
      createFromBitmap: (_bgra: Buffer, size: { width: number; height: number }) => ({
        toDataURL: () => `data:image/png;base64,${size.width}x${size.height}`,
      }),
    },
    BrowserWindow: FakeBrowserWindow,
  })
  const unsaved = field(tools, 'unsavedFiles')
  setOpenFilesSource(
    Array.isArray(unsaved)
      ? () => unsaved.map((filePath: string) => ({ filePath, dirty: true }))
      : null,
  )

  const structure = await cx.fresh<Structure>('apps/shell/src/main/pdf-structure-ipc.ts')
  structure.registerPdfStructureIpc()
  const convert = await cx.fresh<ConvertUi>('apps/shell/src/main/pdf-convert-ui.ts')
  convert.registerPdfConvertUiIpc({
    findMarkdownTab: (path) => {
      log(['tabManager.findMarkdownTabByPath', path])
      const a = answer('find_tab')
      return typeof a === 'string' ? a : undefined
    },
    closeTab: async (tabId) => {
      log(['tabManager.closeTab', tabId])
      const a = answer('close_tab')
      if (typeof a === 'string') throw new Error(a)
    },
    activateView: (viewId) => log(['activateView', viewId]),
    openDocument: (path) => {
      log(['openDocumentPath', path])
      return answer('open_document_path') !== false
    },
  })
  const password = await cx.fresh<PasswordDialog>('apps/shell/src/main/pdf-password-dialog.ts')
  const window = await cx.fresh<ToolsWindow>('apps/shell/src/main/pdf-tools/pdf-tools-window.ts')
  const shellView = views.find((v) => v.surface === 'Shell')
  const lang = field(tools, 'lang')
  const theme = field(tools, 'theme')
  window.configurePdfToolsWindow({
    // the case's shell window object (fakes.ts), standing for Electron's BrowserWindow
    parentWindow: () => (shellView ? cases.fromId(shellView.window) : null) as never,
    lang: () => (typeof lang === 'string' ? lang : 'en') as never,
    theme: () => (typeof theme === 'string' ? theme : 'system') as never,
    openResult: (path) => {
      log(['openResult', path])
      return answer('open_result') !== false
    },
    openForEditing: (path) => {
      log(['openForEditing', path])
      return answer('open_for_editing') !== false
    },
    runJob: structure.runWindowJob,
    cancelJob: structure.cancelWindowJob,
  })
  loaded = { cx, structure, convert, password, window, quit }
}

/** the shell's calls into the tools outside a channel, by the name after `d2/pdf-tools:` */
const byWhat: Record<string, (view: number, args: unknown[]) => unknown> = {
  'open-view': (view, [path]) => {
    const allowed = new Set<string>()
    if (typeof path === 'string' && path && existsSync(path)) allowed.add(path)
    state().grants.set(view, allowed)
  },
  'request-convert-dialog': (view, [format, outPath]) => {
    const l = loaded!
    l.convert.requestPdfConvertDialog(
      l.cx.electron.contents(view) as never,
      format as never,
      outPath as string | undefined,
    )
  },
  'prompt-password': (view, [uiState]) => {
    const l = loaded!
    const parent = (
      l.cx.electron.BrowserWindow as { fromWebContents(c: unknown): unknown }
    ).fromWebContents(l.cx.electron.contents(view))
    void l.password
      .promptPdfPassword(parent as never, uiState as never)
      .then((password) => log(['promptPdfPassword.settled', password]))
  },
  'close-password-dialog': () => loaded!.password.closePdfPasswordDialog(),
  'grant-structure-target': (view, [source, out, kind]) =>
    loaded!.structure.grantPdfStructureTarget(
      loaded!.cx.electron.contents(view) as never,
      source as string,
      out as string,
      kind as never,
    ),
  'open-with-file': async (_view, [path, tool]) => {
    const opened = loaded!.window.openPdfToolsWithFile(path as string, tool)
    // the picked file is read before the window is told: let it finish
    await sleep(50)
    return opened
  },
  'open-window': () => loaded!.window.openPdfToolsWindow(),
  'cancel-all': () => loaded!.quit.reduce<number>((n, f) => n + Number(f()), 0),
}

/** `Group.triggers`: `d2/pdf-tools:<what>` (crates/shell-ipc/d2's `pdf::tools::probe_trigger`) */
export const triggers: NonNullable<Group['triggers']> = Object.fromEntries(
  Object.entries(byWhat).map(([what, run]) => [
    `d2/pdf-tools:${what}`,
    (_cx: unknown, view: number, args: unknown[]) => run(view, args),
  ]),
)

/** A `trigger` step of a case */
export function trigger(what: string, view: number, args: unknown[] = []): Call {
  const name = `d2/pdf-tools:${what}`
  return { channel: name, kind: 'trigger', name, view, args }
}
