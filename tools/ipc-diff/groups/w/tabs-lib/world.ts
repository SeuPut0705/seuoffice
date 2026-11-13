/**
 * The world the `w/tabs*` groups run `apps/shell/src/main/index.ts` in: the
 * TypeScript half of `crates/shell-ipc/w/src/tabs/probe.rs`, which writes the
 * same log lines for the Rust handlers.
 *
 * The real entry module registers its handlers and, through its own
 * `second-instance` listener, makes the real shell window with the real
 * `TabManager` (and the real detached-window module). What they call is faked
 * at the edge:
 *
 * - Electron: `BrowserWindow`, `WebContentsView`, `screen`, `Menu`,
 *   `nativeImage` and the case's contents (so `webContents.send` to a tab view
 *   is recorded when the case declares that view). Every call a Rust
 *   `WindowsHost` method stands for is one log line.
 * - The editor modules the tab manager and the entry module call (`docs-main`,
 *   `sheets-main`, ...): a resolve hook turns the names of `STUB_NAMES` into
 *   calls on the case's world while a case runs, as tools/main-diff's b6-tabs
 *   group does for the same two modules.
 * - Timers and the console, for calls from the app's own modules: logged, and
 *   never fired (the Rust fakes do not fire them either).
 *
 * The world's answers come from `hosts.w` of the case (the list is in
 * probe.rs).
 */
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { LoadContext } from '../../../types.ts'
import { inert, loadShellIndex, withInert } from '../shell-index.ts'
import { koStrings } from './strings.ts'

/** the timers and console of the process, before any case replaced them */
const original = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setImmediate: globalThis.setImmediate,
  warn: console.warn,
  error: console.error,
}

const STUB_NAMES = [
  'createDocsView',
  'docsQueryDirty',
  'markDocsNewBlank',
  'queueDocsAiContent',
  'queueDocsCopy',
  'requestDocsClose',
  'setActiveDocsResolver',
  'teardownDocsRenderer',
  'createMarkdownView',
  'markdownIsDirty',
  'requestMarkdownClose',
  'createHtmlPresentView',
  'createHtmlView',
  'htmlIsDirty',
  'requestHtmlClose',
  'queueHtmlSeedFor',
  'queueMarkdownSeedFor',
  'queueMindmapSeedFor',
  'queueSlidesSeedFor',
  'createHwpView',
  'hwpIsDirty',
  'hwpMemoModalOpen',
  'requestHwpClose',
  'createMindmapView',
  'mindmapIsDirty',
  'requestMindmapClose',
  'createEpubView',
  'epubIsDirty',
  'requestEpubClose',
  'createDiagramView',
  'diagramIsDirty',
  'diagramTabIdentity',
  'requestDiagramClose',
  'createPdfView',
  'clearPdfDirty',
  'markPdfUntitledCopy',
  'pdfIsDirty',
  'requestPdfClose',
  'pdfCloseCancelled',
  'createSheetsView',
  'nudgeQueuedWorkbook',
  'queueWorkbookForView',
  'requestSheetsClose',
  'setActiveSheetsWebContents',
  'setSheetsNewBlank',
  'sheetsPendingEditCount',
  'resetSheetsShuttingDown',
  'createSlidesView',
  'requestSlidesClose',
  'setActiveSlidesWebContents',
  'slidesIsDirty',
  'dropGenerateHandoff',
  'queueGenerateHandoffFor',
  'queueConvertedContent',
  'releaseClosedRenderer',
  'cancelUpdateRestart',
  'resumeDiscardedCopies',
  // the entry module's own calls
  'recordRecentFile',
  'showErrorDialog',
  'defaultSaveDir',
  'blankXlsxBuffer',
  'blankPdfBuffer',
]

const BOX = Symbol.for('ipc-diff.w-tabs')
const STUB_PREFIX = 'ipc-diff:w-tabs-stub?real='
// Node caches a CommonJS resolve per folder and specifier, so any other module
// of apps/shell/src/main that asks for the same specifier is handed the stub
// too. A stub is therefore the real module behind a proxy: the names of
// STUB_NAMES answer from the case's world while a case runs and call the real
// function at any other time; everything else is the real module.
const stubSource = (real: string): string =>
  [
    `const names = new Set(${JSON.stringify(STUB_NAMES)})`,
    `let loaded`,
    `const real = () => (loaded ??= require(${JSON.stringify(fileURLToPath(real))}))`,
    `const value = (key) => names.has(key) && key in real()`,
    `  ? (...args) => { const world = globalThis[Symbol.for('ipc-diff.w-tabs')]; return world ? world.call(key, args) : real()[key](...args) }`,
    `  : real()[key]`,
    `module.exports = new Proxy({}, {`,
    `  get: (_, key) => (key === '__esModule' ? true : typeof key === 'symbol' ? undefined : value(key)),`,
    `  has: (_, key) => key in real(),`,
    `  ownKeys: () => Reflect.ownKeys(real()),`,
    `  getOwnPropertyDescriptor: (_, key) =>`,
    `    key in real() ? { configurable: true, enumerable: true, value: value(key) } : undefined,`,
    `})`,
  ].join('\n')

// a module is stubbed by the file it resolves to, whoever asks: the resolve of
// a specifier is cached per folder, so the first importer decides for the rest
const STUBBED_FILE =
  /\/(docs-main|markdown-main|html-main|seed-main|seed-queue|hwp-main|mindmap-main|epub-main|diagram-main|pdf-main|sheets-main|slides-main|handoff|converted-tab|renderer-disposal|update-restart|error-dialog|blank-pdf|csv-import-xlsx)\.(ts|js)$/
const IMPORTERS = /\/apps\/shell\/src\/main\/(tab-manager|detached-windows|index)\.ts/

const CRYPTO_URL = 'ipc-diff:w-tabs-crypto'
// the entry module's temp folder is named by `randomUUID`: the world counts instead
const cryptoSource = [
  `const real = require('node:crypto')`,
  `module.exports = new Proxy(real, { get: (t, key) => key === 'randomUUID'`,
  `  ? () => { const world = globalThis[Symbol.for('ipc-diff.w-tabs')]; return world ? world.uuid() : t.randomUUID() }`,
  `  : t[key] })`,
].join('\n')

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(STUB_PREFIX)) return next(specifier, context)
    const resolved = next(specifier, context)
    if (STUBBED_FILE.test(resolved.url.split('?')[0])) {
      return { url: STUB_PREFIX + encodeURIComponent(resolved.url), shortCircuit: true }
    }
    if (
      context.parentURL &&
      IMPORTERS.test(context.parentURL) &&
      specifier === '@seuoffice/electron-utils'
    ) {
      return { url: STUB_PREFIX + encodeURIComponent(resolved.url), shortCircuit: true }
    }
    if (
      /\/apps\/shell\/src\/main\/index\.ts/.test(context.parentURL ?? '') &&
      /^(node:)?crypto$/.test(specifier)
    ) {
      return { url: CRYPTO_URL, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === CRYPTO_URL) return { format: 'commonjs', source: cryptoSource, shortCircuit: true }
    if (!url.startsWith(STUB_PREFIX)) return next(url, context)
    const real = decodeURIComponent(url.slice(STUB_PREFIX.length))
    return { format: 'commonjs', source: stubSource(real), shortCircuit: true }
  },
})

type Json = Record<string, unknown>

interface ViewState {
  dirty?: boolean
  pending?: number
  memo?: boolean
  destroyed?: boolean
  queryFails?: boolean
}

const FAMILY_DIRTY: Record<string, string> = {
  pdf: 'pdfIsDirty',
  markdown: 'markdownIsDirty',
  html: 'htmlIsDirty',
  hwp: 'hwpIsDirty',
  slides: 'slidesIsDirty',
  mindmap: 'mindmapIsDirty',
  epub: 'epubIsDirty',
  diagram: 'diagramIsDirty',
}
const REQUEST_CLOSE: Record<string, string> = {
  docs: 'requestDocsClose',
  sheets: 'requestSheetsClose',
  slides: 'requestSlidesClose',
  pdf: 'requestPdfClose',
  markdown: 'requestMarkdownClose',
  html: 'requestHtmlClose',
  mindmap: 'requestMindmapClose',
  hwp: 'requestHwpClose',
  epub: 'requestEpubClose',
  diagram: 'requestDiagramClose',
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** the function that called the faked timer or console method is a module of the app */
const calledByApp = (): boolean =>
  /\/apps\/[a-z]+\/src\//.test((new Error().stack ?? '').split('\n')[3] ?? '')

/** The `hosts.w` of a case: the options of the world, `strings` filled in */
export function world(config: Json = {}): { w: Json } {
  return { w: { strings: koStrings(), ...config } }
}

/** `loadShellIndex` over this world: the shell window and its tab manager are made */
export async function loadWorld(cx: LoadContext): Promise<void> {
  const config = (cx.case.hosts?.w ?? {}) as Json
  const electron = cx.electron
  const log = electron.log
  const views = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
  const shellView = views[0]
  const shellId = shellView.window ?? shellView.view
  const states = new Map<number, ViewState>()
  for (const [id, state] of Object.entries((config.views ?? {}) as Record<string, ViewState>)) {
    states.set(Number(id), state)
  }
  const stateOf = (id: number): ViewState => {
    let s = states.get(id)
    if (!s) states.set(id, (s = {}))
    return s
  }
  let muted = false
  const push = (...line: unknown[]): void => {
    if (!muted) log.push(line)
  }
  let nextWc = 100
  let nextWin = (config.firstWindow as number | undefined) ?? 2
  let nextUuid = 1
  const closeAnswers = [...((config.closeAnswers as unknown[] | undefined) ?? [])]
  const menuPicks = [...((config.menus as unknown[] | undefined) ?? [])]
  const suggested = new Set<string>()
  const failures = new Set<string>((config.fail as string[] | undefined) ?? [])
  const kindOf = new Map<number, string>()
  const shellBox = (config.shell ?? {}) as Json
  const workArea = (config.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }) as Json
  const cursor = (config.cursor ?? { x: 0, y: 0 }) as Json

  // ---- views ----
  const makeView = (): Record<string, unknown> => {
    const id = nextWc++
    const wc = (
      views.some((v) => v.view === id)
        ? electron.contents(id)
        : { id, send: () => {}, focus: () => push('webContents.focus', id) }
    ) as Record<string, unknown>
    Object.assign(wc, {
      id,
      isDestroyed: () => !!stateOf(id).destroyed,
      close: () => push('close', id),
      reload: () => push('reload', id),
      loadURL: (url: string) => {
        push('loadURL', id, url)
        return Promise.resolve()
      },
      on: (name: string) => push('on', id, name),
      once: (name: string) => push('once', id, name),
      setWindowOpenHandler: () => push('setWindowOpenHandler', id),
    })
    return {
      webContents: wc,
      setVisible: (visible: boolean) => push('setVisible', id, visible),
      setBounds: (bounds: unknown) => push('setBounds', id, bounds),
    }
  }
  const viewId = (v: unknown): number => (v as { webContents: { id: number } }).webContents.id

  // ---- windows ----
  const winLog = (id: number, op: string, ...args: unknown[]) => push('win', id, op, ...args)
  const makeWindow = (id: number, opts: Json, first: boolean) => {
    const state = {
      destroyed: false,
      minimized: first ? !!shellBox.minimized : false,
      focused: first ? (shellBox.focused ?? true) : false,
      title: String(opts.title ?? ''),
      bounds: first
        ? {
            x: 0,
            y: 0,
            width: (shellBox.width as number) ?? 1200,
            height: (shellBox.height as number) ?? 800,
          }
        : { x: 0, y: 0, width: Number(opts.width), height: Number(opts.height) },
      position: [Number(opts.x ?? 0), Number(opts.y ?? 0)] as [number, number],
    }
    const listeners: Record<string, ((...a: unknown[]) => unknown)[]> = {}
    const fire = (event: string) =>
      queueMicrotask(() => (listeners[event] ?? []).forEach((fn) => fn()))
    const win: Record<string, unknown> = withInert({
      id,
      webContents: first ? electron.contents(shellView.view) : undefined,
      isDestroyed: () => state.destroyed,
      isMinimized: () => state.minimized,
      isFocused: () => state.focused,
      isVisible: () => true,
      isMaximized: () => false,
      isFullScreen: () => false,
      getTitle: () => state.title,
      getContentBounds: () => ({ ...state.bounds }),
      getBounds: () => ({ ...state.bounds }),
      getPosition: () => [...state.position],
      setContentBounds: () => {},
      setTitle: (title: string) => {
        winLog(id, 'setTitle', title)
        state.title = title
      },
      setPosition: (x: number, y: number) => {
        winLog(id, 'setPosition', x, y)
        state.position = [x, y]
        fire('move')
      },
      setBounds: (rect: unknown) => {
        winLog(id, 'setBounds', rect)
        // Electron reports a new frame as a move and a resize; the shell window's
        // geometry listeners are not part of this comparison
        if (!first) {
          fire('move')
          fire('resize')
        }
      },
      restore: () => winLog(id, 'restore'),
      show: () => winLog(id, 'show'),
      showInactive: () => winLog(id, 'showInactive'),
      focus: () => winLog(id, 'focus'),
      destroy: () => {
        winLog(id, 'destroy')
        state.destroyed = true
        fire('closed')
      },
      on: (event: string, fn: (...a: unknown[]) => unknown) => {
        ;(listeners[event] ??= []).push(fn)
      },
      once: (event: string, fn: (...a: unknown[]) => unknown) => {
        ;(listeners[event] ??= []).push(fn)
      },
      off: () => {},
      contentView: {
        addChildView: (v: unknown) => winLog(id, 'addChildView', viewId(v)),
        removeChildView: (v: unknown) => winLog(id, 'removeChildView', viewId(v)),
      },
    })
    return win
  }
  let firstWindow = true
  class FakeBrowserWindow {
    constructor(opts: Json) {
      if (firstWindow) {
        firstWindow = false
        return makeWindow(shellId, opts, true) as never
      }
      const id = nextWin++
      push('newBrowserWindow', opts)
      return makeWindow(id, opts, false) as never
    }
  }
  Object.assign(FakeBrowserWindow, electron.BrowserWindow)

  // ---- menus ----
  const iconName = (icon: unknown): string => {
    const path = String((icon as { __path?: string } | null)?.__path ?? '')
    return /menu-([a-z]+)[^/]*\.png$/.exec(path)?.[1] ?? path
  }
  const itemsOf = (menu: unknown): Json[] =>
    Array.isArray(menu) ? menu : (((menu ?? {}) as { items?: Json[] }).items ?? [])
  const normalize = (items: Json[]): Json[] =>
    items.map((it) => {
      const o: Json = {}
      if (it.type === 'separator') o.type = 'separator'
      else {
        o.label = it.label
        if (it.type) o.type = it.type
      }
      if (it.enabled === false) o.enabled = false
      if (it.checked === true) o.checked = true
      if (it.icon) o.icon = iconName(it.icon)
      const sub = itemsOf(it.submenu)
      if (sub.length > 0) o.submenu = normalize(sub)
      return o
    })
  const find = (items: Json[], label: string): Json | undefined => {
    for (const it of items) {
      if (it.type !== 'separator' && it.label === label) return it
      const hit = find(itemsOf(it.submenu), label)
      if (hit) return hit
    }
    return undefined
  }
  const appMenu = (config.appMenu as Json[] | undefined) ?? null
  const toMenuItem = (spec: Json): Json => ({
    label: spec.label,
    enabled: (spec.enabled as boolean | undefined) ?? true,
    ...(spec.type ? { type: spec.type } : {}),
    ...(spec.submenu ? { submenu: { items: (spec.submenu as Json[]).map(toMenuItem) } } : {}),
    click: () => push('appMenu.click', spec.label),
  })
  const Menu = {
    buildFromTemplate: (template: Json[]) => {
      const items = template.map((t) => ({ ...t }))
      return {
        items,
        insert: () => {},
        popup: (opts: { window?: { id: number }; x?: number; y?: number }) => {
          push(
            'menu.popup',
            {
              window: opts.window?.id,
              ...(opts.x !== undefined ? { x: opts.x, y: opts.y } : {}),
            },
            normalize(items),
          )
          const pick = menuPicks.shift()
          const hit = typeof pick === 'string' ? find(items, pick) : undefined
          ;(hit?.click as (() => void) | undefined)?.()
        },
      }
    },
    getApplicationMenu: () => (appMenu ? { items: appMenu.map(toMenuItem) } : null),
    setApplicationMenu: () => {},
  }

  // ---- the editor modules and the entry module's own calls ----
  const creator = (name: string, kind: string, ...args: unknown[]) => {
    push(name, ...args)
    if (failures.has(name)) throw new Error('create failed')
    const view = makeView()
    kindOf.set(viewId(view), kind)
    return view
  }
  const labelOf = (win: unknown): string => {
    const id = (win as { id?: number } | null)?.id
    return id === shellId ? 'shell' : `window:${id}`
  }
  const answer = (): Promise<boolean> => {
    const next = closeAnswers.length > 0 ? closeAnswers.shift() : true
    return next === 'throws'
      ? Promise.reject(new Error('prompt failed'))
      : Promise.resolve(next as boolean)
  }
  const wcid = (wc: { id: number }): number => wc.id
  const app: Record<string, (...a: never[]) => unknown> = {
    createDocsView: (path) => creator('createDocsView', 'docs', path ?? null),
    createSheetsView: (opts) => creator('createSheetsView', 'sheets', opts),
    createSlidesView: (path) => creator('createSlidesView', 'slides', path ?? null),
    createPdfView: (path) => creator('createPdfView', 'pdf', path),
    createMarkdownView: (path) => creator('createMarkdownView', 'markdown', path ?? null),
    createHtmlView: (path) => creator('createHtmlView', 'html', path ?? null),
    createHtmlPresentView: (owner: { id: number }, title) =>
      creator('createHtmlPresentView', 'html', owner.id, title),
    createMindmapView: (path) => creator('createMindmapView', 'mindmap', path ?? null),
    createEpubView: (path) => creator('createEpubView', 'epub', path),
    createDiagramView: (path) => creator('createDiagramView', 'diagram', path ?? null),
    createHwpView: (path, opts) => creator('createHwpView', 'hwp', path ?? null, opts),
    markDocsNewBlank: (id) => push('markDocsNewBlank', id),
    queueDocsAiContent: (id, content) => push('queueDocsAiContent', id, content),
    queueDocsCopy: (id, copy: { path: string; name: string }) =>
      push('queueDocsCopy', id, copy.path, copy.name),
    setSheetsNewBlank: () => push('setSheetsNewBlank'),
    queueWorkbookForView: (wc: { id: number }, path) => push('queueWorkbookForView', wc.id, path),
    nudgeQueuedWorkbook: (wc: { id: number }) => push('nudgeQueuedWorkbook', wc.id),
    markPdfUntitledCopy: (path) => push('markPdfUntitledCopy', path),
    clearPdfDirty: (id) => push('clearPdfDirty', id),
    queueMarkdownSeedFor: (wc: { id: number }, text) => push('queueMarkdownSeedFor', wc.id, text),
    queueHtmlSeedFor: (wc: { id: number }, text) => push('queueHtmlSeedFor', wc.id, text),
    queueMindmapSeedFor: (wc: { id: number }, seed: { bytes: Uint8Array }) =>
      push('queueMindmapSeedFor', wc.id, hex(seed.bytes)),
    queueSlidesSeedFor: (wc: { id: number }, bytes: Uint8Array, opts) =>
      push('queueSlidesSeedFor', wc.id, hex(bytes), opts),
    queueGenerateHandoffFor: (wc: { id: number }, handoff) =>
      push('queueGenerateHandoffFor', wc.id, handoff),
    queueConvertedContent: (wc: { id: number }, doc) => push('queueConvertedContent', wc.id, doc),
    dropGenerateHandoff: (id) => push('dropGenerateHandoff', id),
    diagramTabIdentity: (id: number) => (push('diagramTabIdentity', id), undefined),
    docsQueryDirty: (wc: { id: number }) => {
      push('docsQueryDirty', wc.id)
      return stateOf(wc.id).queryFails
        ? Promise.reject(new Error('query failed'))
        : Promise.resolve(!!stateOf(wc.id).dirty)
    },
    sheetsPendingEditCount: (id: number) => (
      push('sheetsPendingEditCount', id),
      stateOf(id).pending ?? 0
    ),
    hwpMemoModalOpen: (id: number) => (push('hwpMemoModalOpen', id), !!stateOf(id).memo),
    setActiveDocsResolver: (resolver: () => { id: number } | null) => {
      const wc = resolver()
      push('setActiveDocsResolver', wc ? wc.id : null)
    },
    setActiveSheetsWebContents: (wc: { id: number } | null) =>
      push('setActiveSheetsWebContents', wc ? wc.id : null),
    setActiveSlidesWebContents: (wc: { id: number }) => push('setActiveSlidesWebContents', wc.id),
    teardownDocsRenderer: (wc: { id: number }) => push('teardownDocsRenderer', wc.id),
    releaseClosedRenderer: (wc: { id: number }) => push('releaseClosedRenderer', wc.id),
    resetSheetsShuttingDown: () => push('resetSheetsShuttingDown'),
    cancelUpdateRestart: () => push('cancelUpdateRestart'),
    resumeDiscardedCopies: () => push('resumeDiscardedCopies'),
    pdfCloseCancelled: (wc: { id: number }) => push('pdfCloseCancelled', wc.id),
    recordRecentFile: (path) => push('recordRecentFile', path),
    showErrorDialog: (_win, title, err) => push('showErrorDialog', title, message(err)),
    defaultSaveDir: () => (config.defaultSaveDir as string | undefined) ?? '',
    blankXlsxBuffer: () => Promise.resolve(Buffer.from(String(config.blankXlsx ?? ''), 'hex')),
    blankPdfBuffer: () => Promise.resolve(Buffer.from(String(config.blankPdf ?? ''), 'hex')),
  }
  for (const [kind, name] of Object.entries(FAMILY_DIRTY)) {
    app[name] = (id: number) => {
      push('isDirty', kind, id)
      return !!stateOf(id).dirty
    }
  }
  for (const [kind, name] of Object.entries(REQUEST_CLOSE)) {
    app[name] = (wc: { id: number }, win: unknown) => {
      push('requestClose', kind, wcid(wc), labelOf(win))
      return answer()
    }
  }
  void suggested
  ;(globalThis as Record<symbol, unknown>)[BOX] = {
    uuid: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`,
    call: (name: string, args: never[]) => {
      if (process.env.WDEBUG) process.stderr.write('call ' + name + '\n')
      return app[name](...args)
    },
  }

  // ---- install and load the entry module ----
  const baseApp = electron.app as Json
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const fakeApp = withInert({
    ...baseApp,
    getVersion: () => '0.13.0',
    getAppPath: () => `${process.cwd()}/apps/shell`,
    getLocale: () => 'ko',
    getPreferredSystemLanguages: () => ['ko-KR'],
    isReady: () => false,
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    setPath: () => {},
    setName: () => {},
    dock: undefined,
    on: (name: string, fn: (...args: unknown[]) => unknown) => void listeners.set(name, fn),
    once: (name: string, fn: (...args: unknown[]) => unknown) => void listeners.set(name, fn),
  })
  // the detached-window module keeps its registry and the torn-off window in
  // module variables: the windows of the case before are closed first. Imported
  // here because it needs the case's Electron, which a static import precedes.
  const detachedModule = (await import(
    pathToFileURL(
      resolve(
        fileURLToPath(import.meta.url),
        '../../../../../../apps/shell/src/main/detached-windows.ts',
      ),
    ).href
  )) as { detachedSessionTabs(): { id: string }[]; closeDetachedWithoutPrompt(id: string): boolean }
  muted = true
  for (const tab of detachedModule.detachedSessionTabs())
    detachedModule.closeDetachedWithoutPrompt(tab.id)
  muted = false
  await loadShellIndex(cx, {
    electron: {
      app: fakeApp,
      BrowserWindow: FakeBrowserWindow,
      WebContentsView: class {
        constructor(opts: { webPreferences: Json }) {
          const view = makeView()
          const prefs = opts.webPreferences
          push('newWebContentsView', viewId(view), {
            contextIsolation: prefs.contextIsolation,
            nodeIntegration: prefs.nodeIntegration,
            sandbox: prefs.sandbox,
            backgroundThrottling: prefs.backgroundThrottling,
          })
          return view as never
        }
      },
      screen: {
        getCursorScreenPoint: () => ({ x: cursor.x, y: cursor.y }),
        getDisplayNearestPoint: () => ({ workArea: { ...workArea } }),
        getDisplayMatching: () => ({ workArea: { ...workArea } }),
        getAllDisplays: () => [],
      },
      Menu,
      nativeImage: {
        ...(electron.nativeImage as Json),
        createFromPath: (path: string) => ({ __path: path, addRepresentation: () => {} }),
      },
    },
  })

  // timers and the console, for the app's own calls
  const real = original
  let nextTimer = 1
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    calledByApp()
      ? (push('setTimeout', ms), nextTimer++)
      : real.setTimeout(fn, ms, ...rest)) as never
  globalThis.clearTimeout = ((timer: never) =>
    calledByApp()
      ? (process.env.WDEBUG && process.stderr.write(new Error().stack + '\n'), push('clearTimeout'))
      : real.clearTimeout(timer)) as never
  globalThis.setImmediate = ((fn: () => void, ...rest: unknown[]) =>
    calledByApp()
      ? (push('setImmediate'), 0)
      : real.setImmediate(() => fn(...(rest as [])))) as never
  console.warn = (text: unknown, err?: unknown) =>
    calledByApp() ? push('console', text, message(err)) : real.warn(text, err)
  console.error = (text: unknown, err?: unknown) =>
    calledByApp() ? push('console', text, message(err)) : real.error(text, err)

  // handlers that start file work they do not wait for (the copy of a duplicated
  // file, a new blank file) are given the time it takes before the next call
  const later =
    (fn: (...a: unknown[]) => unknown) =>
    async (...a: unknown[]) => {
      const out = await fn(...a)
      // a plain Promise: the harness compiles to ES2022, without Promise.withResolvers
      await new Promise<void>((resolve) => real.setTimeout(resolve, 40))
      return out
    }
  for (const channel of ['tabs:show-tab-menu', 'home:new-sheet', 'home:new-pdf']) {
    const fn = electron.handlers.invoke.get(channel)
    if (fn) electron.handlers.invoke.set(channel, later(fn))
  }
  const dropped = electron.handlers.on.get('app:open-dropped-files')
  if (dropped) electron.handlers.on.set('app:open-dropped-files', dropped.map(later))

  // the shell window and its tab manager, as the app makes them for a second instance
  if (config.noShell !== true) {
    muted = true
    const secondInstance = listeners.get('second-instance')
    if (!secondInstance) throw new Error('index.ts did not listen for second-instance')
    secondInstance({}, [], process.cwd(), undefined)
    muted = false
  }
  void inert
  void kindOf
  void (cx.electron.nativeImage as unknown)
}
