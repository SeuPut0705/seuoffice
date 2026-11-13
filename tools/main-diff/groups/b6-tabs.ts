/**
 * Group `b6-tabs`: `apps/shell/src/main/tab-manager.ts` and
 * `detached-windows.ts` (batch B6 of decision 0030). Electron is the fake of
 * electron-fake.ts; the editor modules both files import (`docs-main`,
 * `sheets-main`, ... `renderer-disposal`, `update-restart`) are replaced by a
 * stub module through a resolve hook that applies to those two importers only:
 * each stub function logs its call and answers from the scenario. The real
 * `split-layout`, `tab-drag-geometry`, `renderer-scheme` and `safe-external-url`
 * stay. A scenario is a list of operations over one `TabManager` and the
 * detached windows of one shell window; every call of a fake is one log line,
 * and the Rust plays the adapter that carries out what it decides on the same
 * fakes (calls/b6_tabs.rs).
 *
 * World (`{ shell, untitled, splitListener, closedListener, noSpare, devUrl,
 * platform, ops }`):
 * - views get webContents ids 100, 101, ... in the order they are made (every
 *   `create*View`, opener, manual and spare view); windows get numbers 1, 2,
 *   ...; timers (`setTimeout`) numbers 1, 2, ...; openers numbers 1, 2, ...
 * - `setTimeout`/`clearTimeout`/`setImmediate` are captured and logged
 *   (`setTimeout` with its delay and number); `fireTimer` runs a pending
 *   timer, `settle` runs the pending immediates in order
 * - `destroy()` of a window queues its `closed` event; it is delivered when the
 *   operation ends (after the dock callback's work), as an adapter that calls
 *   the Rust after the Electron call returned does
 * - the answer of a scenario is the result of each operation, then
 *   `{ list, split, session, paths }` of the tab manager
 */
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Rectangle } from 'electron'
import type { DockHost } from '../../../apps/shell/src/main/detached-windows.ts'
import type { DetachedTab } from '../../../apps/shell/src/main/tab-manager.ts'
import { useElectron } from '../electron-fake.ts'
import type { Case, Group, TsContext } from '../types.ts'

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
]

const BOX = Symbol.for('main-diff.b6-tabs')
const STUB_PREFIX = 'main-diff:b6-tabs-stub?real='
// Node caches a CommonJS resolve per folder and specifier, so any other module of
// apps/shell/src/main that asks for the same specifier is handed the stub too. A
// stub is therefore the real module behind a proxy: the names of STUB_NAMES answer
// from the scenario's world while a scenario runs and call the real function at
// any other time; everything else is the real module, loaded on first use.
const stubSource = (real: string): string =>
  [
    `const names = new Set(${JSON.stringify(STUB_NAMES)})`,
    `let loaded`,
    `const real = () => (loaded ??= require(${JSON.stringify(fileURLToPath(real))}))`,
    `const value = (key) => names.has(key)`,
    `  ? (...args) => { const world = globalThis[Symbol.for('main-diff.b6-tabs')]; return world ? world.call(key, args) : real()[key](...args) }`,
    `  : real()[key]`,
    `module.exports = new Proxy({}, {`,
    `  get: (_, key) => (key === '__esModule' ? true : typeof key === 'symbol' ? undefined : value(key)),`,
    `  has: (_, key) => names.has(key) || key in real(),`,
    `  ownKeys: () => [...new Set([...Reflect.ownKeys(real()), ...names])],`,
    `  getOwnPropertyDescriptor: (_, key) =>`,
    `    names.has(key) || key in real() ? { configurable: true, enumerable: true, value: value(key) } : undefined,`,
    `})`,
  ].join('\n')

const IMPORTERS = /\/apps\/shell\/src\/main\/(tab-manager|detached-windows)\.ts/
const STUBBED_MODULE =
  /^(@seuoffice\/electron-utils|(.*\/)?(docs-main|markdown-main|html-main|seed-main|seed-queue|hwp-main|mindmap-main|epub-main|diagram-main|pdf-main|sheets-main|slides-main|handoff|converted-tab|renderer-disposal|update-restart))$/

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && IMPORTERS.test(context.parentURL) && STUBBED_MODULE.test(specifier)) {
      const real = next(specifier, context)
      return { url: STUB_PREFIX + encodeURIComponent(real.url), shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith(STUB_PREFIX)) return next(url, context)
    const real = decodeURIComponent(url.slice(STUB_PREFIX.length))
    return { format: 'commonjs', source: stubSource(real), shortCircuit: true }
  },
})

// loaded after electron-fake.ts and the hooks above have been registered: a
// static import would be resolved before them
const tabManagerModule = await import('../../../apps/shell/src/main/tab-manager.ts')
const detachedModule = await import('../../../apps/shell/src/main/detached-windows.ts')
const { TabManager, canonicalPath, helpTopicParam, helpViewUrl, plainTabOpener } = tabManagerModule
const detached = detachedModule

// ---------------------------------------------------------------------------
// the world a scenario runs in
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
interface Op extends Json {
  op: string
}

interface Scenario {
  shell?: { width?: number; height?: number; scale?: number; focused?: boolean }
  /** the strip's placeholder titles by kind; no `untitled` = no function */
  untitled?: Record<string, string>
  splitListener?: boolean
  closedListener?: boolean
  noSpare?: boolean
  devUrl?: string
  platform?: string
  ops: Op[]
}

interface WcState {
  dirty?: boolean
  pending?: number
  memo?: boolean
  destroyed?: boolean
  identity?: { imported?: boolean; title: string; sourcePath?: string }
}

interface Listener {
  fn: (...args: unknown[]) => unknown
  once: boolean
}

interface FakeView {
  webContents: {
    id: number
    isDestroyed(): boolean
    focus(): void
    close(): void
    reload(): void
    loadURL(url: string): Promise<void>
    on(name: string, fn: () => unknown): void
    once(name: string, fn: () => unknown): void
    setWindowOpenHandler(fn: (details: { url: string }) => unknown): void
  }
  listeners: Record<string, Listener[]>
  setVisible(visible: boolean): void
  setBounds(bounds: unknown): void
}

interface FakeWin {
  label: string
  n: number
  state: {
    destroyed: boolean
    minimized: boolean
    focused: boolean
    title: string
    bounds: { x: number; y: number; width: number; height: number }
    position: [number, number]
  }
  listeners: Record<string, ((...args: unknown[]) => unknown)[]>
  [key: string]: unknown
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const unhex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'))

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
const DIRTY_METHOD: Record<string, string> = {
  sheets: 'dirtySheetsTabs',
  pdf: 'dirtyPdfTabs',
  markdown: 'dirtyMarkdownTabs',
  html: 'dirtyHtmlTabs',
  mindmap: 'dirtyMindmapTabs',
  hwp: 'dirtyHwpTabs',
  epub: 'dirtyEpubTabs',
  diagram: 'dirtyDiagramTabs',
  slides: 'dirtySlidesTabs',
}
const LIVE_METHOD: Record<string, string> = {
  docs: 'docsTabs',
  slides: 'slidesTabs',
  sheets: 'sheetsTabs',
}
const FIND_METHOD: Record<string, string> = {
  docs: 'findDocsTabByPath',
  sheets: 'findSheetsTabByPath',
  slides: 'findSlidesTabByPath',
  pdf: 'findPdfTabByPath',
  markdown: 'findMarkdownTabByPath',
  html: 'findHtmlTabByPath',
  mindmap: 'findMindmapTabByPath',
  epub: 'findEpubTabByPath',
  hwp: 'findHwpTabByPath',
}
const ACTIVE_METHOD: Record<string, string> = {
  mindmap: 'activeMindmapTab',
  epub: 'activeEpubTab',
  diagram: 'activeDiagramTab',
  hwp: 'activeHwpTab',
  html: 'activeHtmlTab',
  markdown: 'activeMarkdownTab',
  pdf: 'activePdfTab',
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function runScenario(spec: Scenario, cx: TsContext): Promise<unknown> {
  let muted = false
  const log = (...line: unknown[]): void => {
    if (!muted) cx.log(...line)
  }
  const results: unknown[] = []
  let nextWc = 100
  let nextWin = 1
  let nextTimer = 1
  let nextOpener = 1
  const shellState = {
    destroyed: false,
    minimized: false,
    focused: spec.shell?.focused ?? true,
    width: spec.shell?.width ?? 1200,
    height: spec.shell?.height ?? 800,
  }
  const scale = spec.shell?.scale ?? 1
  const wcs = new Map<number, WcState>()
  const stateOf = (id: number): WcState => {
    let state = wcs.get(id)
    if (!state) {
      state = {}
      wcs.set(id, state)
    }
    return state
  }
  const views = new Map<number, FakeView>()
  const windows: FakeWin[] = []
  const timers = new Map<number, () => void>()
  const immediates: (() => void)[] = []
  const closedQueue: FakeWin[] = []
  // a window's `closed` fires once, whoever destroyed it
  const closedFired = new Set<FakeWin>()
  const emitClosed = (win: FakeWin): void => {
    if (closedFired.has(win)) return
    closedFired.add(win)
    for (const fn of win.listeners.closed ?? []) fn()
  }
  const failures = new Set<string>()
  const closeAnswers: unknown[] = []
  const held: (DetachedTab | null)[] = []
  const openerReady = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()
  const windowOpen = new Map<number, (details: { url: string }) => unknown>()
  let cursor = { x: 0, y: 0 }
  let workArea = { x: 0, y: 0, width: 1920, height: 1080 }
  let band: { x: number; y: number; width: number; height: number } | null = null
  let dockOn = false
  let dockAttach = true
  let dockIndex: number | undefined

  const makeView = (): FakeView => {
    const id = nextWc++
    const view: FakeView = {
      listeners: {},
      webContents: {
        id,
        isDestroyed: () => !!stateOf(id).destroyed,
        focus: () => log('focus', id),
        close: () => log('close', id),
        reload: () => log('reload', id),
        loadURL: (url) => {
          log('loadURL', id, url)
          return Promise.resolve()
        },
        on: (name, fn) => {
          log('on', id, name)
          ;(view.listeners[name] ??= []).push({ fn, once: false })
        },
        once: (name, fn) => {
          log('once', id, name)
          ;(view.listeners[name] ??= []).push({ fn, once: true })
        },
        setWindowOpenHandler: (fn) => {
          log('setWindowOpenHandler', id)
          windowOpen.set(id, fn)
        },
      },
      setVisible: (visible) => log('setVisible', id, visible),
      setBounds: (bounds) => log('setBounds', id, bounds),
    }
    views.set(id, view)
    return view
  }

  const emitView = (wc: number, event: string): void => {
    const view = views.get(wc)
    const listeners = view?.listeners[event] ?? []
    if (!view || listeners.length === 0) return
    view.listeners[event] = listeners.filter((l) => !l.once)
    for (const l of listeners) l.fn()
  }

  const shellWin = {
    isDestroyed: () => shellState.destroyed,
    isMinimized: () => shellState.minimized,
    isFocused: () => shellState.focused,
    getContentBounds: () => ({ x: 0, y: 0, width: shellState.width, height: shellState.height }),
    on: (event: string, fn: () => void) => {
      shellListeners[event] = fn
    },
    contentView: {
      addChildView: (v: FakeView) => log('addChildView', v.webContents.id),
      removeChildView: (v: FakeView) => log('removeChildView', v.webContents.id),
    },
    webContents: { focus: () => log('focusShell') },
  }
  const shellListeners: Record<string, () => void> = {}
  const labelOf = (win: unknown): string => (win === shellWin ? 'shell' : (win as FakeWin).label)

  const makeWindow = (opts: Record<string, unknown>): FakeWin => {
    const n = nextWin++
    log('newBrowserWindow', opts)
    const state: FakeWin['state'] = {
      destroyed: false,
      minimized: false,
      focused: false,
      title: String(opts.title),
      bounds: { x: 0, y: 0, width: Number(opts.width), height: Number(opts.height) },
      position: [Number(opts.x ?? 0), Number(opts.y ?? 0)],
    }
    const win: FakeWin = {
      label: `window:${n}`,
      n,
      state,
      listeners: {},
      isDestroyed: () => state.destroyed,
      isMinimized: () => state.minimized,
      isFocused: () => state.focused,
      getTitle: () => state.title,
      getContentBounds: () => ({ ...state.bounds }),
      getPosition: () => [...state.position],
      setTitle: (title: string) => {
        log('win', n, 'setTitle', title)
        state.title = title
      },
      setPosition: (x: number, y: number) => {
        log('win', n, 'setPosition', x, y)
        state.position = [x, y]
      },
      restore: () => log('win', n, 'restore'),
      show: () => log('win', n, 'show'),
      showInactive: () => log('win', n, 'showInactive'),
      focus: () => log('win', n, 'focus'),
      destroy: () => {
        log('win', n, 'destroy')
        state.destroyed = true
        closedQueue.push(win)
      },
      on: (event: string, fn: (...args: unknown[]) => unknown) => {
        ;(win.listeners[event] ??= []).push(fn)
      },
      contentView: {
        addChildView: (v: FakeView) => log('win', n, 'addChildView', v.webContents.id),
        removeChildView: (v: FakeView) => log('win', n, 'removeChildView', v.webContents.id),
      },
    }
    windows.push(win)
    return win
  }

  const creator = (name: string, ...args: unknown[]): FakeView => {
    log(name, ...args)
    if (failures.has(name)) throw new Error('create failed')
    return makeView()
  }
  const answer = (): Promise<boolean> => {
    const next = closeAnswers.length > 0 ? closeAnswers.shift() : true
    if (next === 'throws') return Promise.reject(new Error('prompt failed'))
    return Promise.resolve(next as boolean)
  }
  const app: Record<string, (...a: never[]) => unknown> = {
    createDocsView: (path) => creator('createDocsView', path ?? null),
    createSheetsView: (opts) => creator('createSheetsView', opts),
    createSlidesView: (path) => creator('createSlidesView', path ?? null),
    createPdfView: (path) => creator('createPdfView', path),
    createMarkdownView: (path) => creator('createMarkdownView', path ?? null),
    createHtmlView: (path) => creator('createHtmlView', path ?? null),
    createHtmlPresentView: (owner: { id: number }, title) =>
      creator('createHtmlPresentView', owner.id, title),
    createMindmapView: (path) => creator('createMindmapView', path ?? null),
    createEpubView: (path) => creator('createEpubView', path),
    createDiagramView: (path) => creator('createDiagramView', path ?? null),
    createHwpView: (path, opts) => creator('createHwpView', path ?? null, opts),
    markDocsNewBlank: (id) => log('markDocsNewBlank', id),
    queueDocsAiContent: (id, content) => log('queueDocsAiContent', id, content),
    queueDocsCopy: (id, copy: { path: string; name: string }) =>
      log('queueDocsCopy', id, copy.path, copy.name),
    setSheetsNewBlank: () => log('setSheetsNewBlank'),
    queueWorkbookForView: (wc: { id: number }, path) => log('queueWorkbookForView', wc.id, path),
    nudgeQueuedWorkbook: (wc: { id: number }) => log('nudgeQueuedWorkbook', wc.id),
    markPdfUntitledCopy: (path) => log('markPdfUntitledCopy', path),
    clearPdfDirty: (id) => log('clearPdfDirty', id),
    queueMarkdownSeedFor: (wc: { id: number }, text) => log('queueMarkdownSeedFor', wc.id, text),
    queueHtmlSeedFor: (wc: { id: number }, text) => log('queueHtmlSeedFor', wc.id, text),
    queueMindmapSeedFor: (wc: { id: number }, seed: { bytes: Uint8Array }) =>
      log('queueMindmapSeedFor', wc.id, hex(seed.bytes)),
    queueSlidesSeedFor: (wc: { id: number }, bytes: Uint8Array, opts) =>
      log('queueSlidesSeedFor', wc.id, hex(bytes), opts),
    queueGenerateHandoffFor: (wc: { id: number }, handoff) =>
      log('queueGenerateHandoffFor', wc.id, handoff),
    queueConvertedContent: (wc: { id: number }, doc) => log('queueConvertedContent', wc.id, doc),
    dropGenerateHandoff: (id) => log('dropGenerateHandoff', id),
    diagramTabIdentity: (id: number) => {
      log('diagramTabIdentity', id)
      return stateOf(id).identity
    },
    docsQueryDirty: (wc: { id: number }) => {
      log('docsQueryDirty', wc.id)
      return Promise.resolve(!!stateOf(wc.id).dirty)
    },
    sheetsPendingEditCount: (id: number) => {
      log('sheetsPendingEditCount', id)
      return stateOf(id).pending ?? 0
    },
    hwpMemoModalOpen: (id: number) => {
      log('hwpMemoModalOpen', id)
      return !!stateOf(id).memo
    },
    setActiveDocsResolver: (resolver: () => { id: number } | null) => {
      const wc = resolver()
      log('setActiveDocsResolver', wc ? wc.id : null)
    },
    setActiveSheetsWebContents: (wc: { id: number } | null) =>
      log('setActiveSheetsWebContents', wc ? wc.id : null),
    setActiveSlidesWebContents: (wc: { id: number }) => log('setActiveSlidesWebContents', wc.id),
    teardownDocsRenderer: (wc: { id: number }) => log('teardownDocsRenderer', wc.id),
    releaseClosedRenderer: (wc: { id: number }) => log('releaseClosedRenderer', wc.id),
    resetSheetsShuttingDown: () => log('resetSheetsShuttingDown'),
    cancelUpdateRestart: () => log('cancelUpdateRestart'),
    resumeDiscardedCopies: () => log('resumeDiscardedCopies'),
    pdfCloseCancelled: (wc: { id: number }) => log('pdfCloseCancelled', wc.id),
  }
  for (const [kind, name] of Object.entries(FAMILY_DIRTY)) {
    app[name] = (id: number) => {
      log('isDirty', kind, id)
      return !!stateOf(id).dirty
    }
  }
  for (const [kind, name] of Object.entries(REQUEST_CLOSE)) {
    app[name] = (wc: { id: number }, win: unknown) => {
      log('requestClose', kind, wc.id, labelOf(win))
      return answer()
    }
  }
  // the Electron objects the two modules use themselves
  useElectron({
    WebContentsView: class {
      constructor(opts: { webPreferences: Record<string, unknown> }) {
        const view = makeView()
        const prefs = opts.webPreferences
        log('newWebContentsView', view.webContents.id, {
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          sandbox: prefs.sandbox,
          backgroundThrottling: prefs.backgroundThrottling,
        })
        return view as never
      }
    },
    BrowserWindow: class {
      constructor(opts: Record<string, unknown>) {
        return makeWindow(opts) as never
      }
    },
    shell: {
      openExternal: (url: string) => {
        log('openExternal', url)
        return Promise.resolve()
      },
    },
    screen: {
      getCursorScreenPoint: () => ({ ...cursor }),
      getDisplayNearestPoint: () => ({ workArea: { ...workArea } }),
    },
  })
  ;(globalThis as Record<symbol, unknown>)[BOX] = {
    call: (name: string, args: never[]) => app[name](...args),
  }

  // the timers, the console and the environment of the call
  const saved = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setImmediate: globalThis.setImmediate,
    warn: console.warn,
    error: console.error,
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    noSpare: process.env.SEUOFFICE_NO_SPARE_VIEW,
    devUrl: process.env.ELECTRON_RENDERER_URL,
  }
  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const n = nextTimer++
    timers.set(n, fn)
    log('setTimeout', ms, n)
    return n
  }) as never
  globalThis.clearTimeout = ((n: number) => {
    log('clearTimeout', n)
    timers.delete(n)
  }) as never
  globalThis.setImmediate = ((fn: () => void) => {
    immediates.push(fn)
    log('setImmediate')
  }) as never
  console.warn = (text: string, err: unknown) => log('warn', text, message(err))
  console.error = (text: string, err: unknown) => log('error', text, message(err))
  if (spec.platform) Object.defineProperty(process, 'platform', { value: spec.platform })
  restoreEnv('SEUOFFICE_NO_SPARE_VIEW', spec.noSpare ? '1' : undefined)
  restoreEnv('ELECTRON_RENDERER_URL', spec.devUrl)

  try {
    detached.setDetachedChangedListener(() => log('detachedChanged'))
    const untitled = spec.untitled
    const tm = new TabManager(
      shellWin as never,
      () => log('onChanged'),
      (kind: string) => log('applyMenuFor', kind),
      untitled ? (kind: string) => untitled[kind] : undefined,
      () => scale,
      spec.splitListener === false
        ? undefined
        : (state: unknown) => log('onSplitChanged', JSON.parse(JSON.stringify(state))),
    )
    tm.setClosedListener(
      spec.closedListener === false ? null : (tab) => log('onTabClosed', tab.kind, tab.filePath),
    )

    const wcOf = (id: string): number | null => tm.webContentsForTab(id)?.id ?? null
    const tabLike = (t: { id: string; kind: string; webContents: { id: number } } | undefined) =>
      t ? { id: t.id, kind: t.kind, wc: t.webContents.id } : null
    const pairs = (list: { id: string; webContents: { id: number } }[]) =>
      list.map((t) => ({ id: t.id, wc: t.webContents.id }))

    const makeOpener = (o: Json) => {
      const n = nextOpener++
      const opener: Record<string, unknown> = {
        open: (ctx: unknown) => {
          log('opener.open', n, ctx)
          if (o.kind === 'plain') return plainTabOpener.open(ctx as never)
          if (o.fails) throw new Error('opener failed')
          const view = makeView()
          if (o.ready === undefined || o.ready === 'none') return { view }
          let resolve: () => void = () => {}
          let reject: (error: Error) => void = () => {}
          const promise = new Promise<void>((res, rej) => {
            resolve = res
            reject = rej
          })
          openerReady.set(n, { resolve, reject })
          if (o.ready === 'resolved') resolve()
          if (o.ready === 'rejected') reject(new Error('document failed'))
          return { view, ready: promise }
        },
      }
      if (o.needsUser !== undefined) {
        opener.needsUser = (ctx: unknown) => {
          log('opener.needsUser', n, ctx)
          return Promise.resolve(o.needsUser)
        }
      }
      return opener
    }
    const unloadedSpec = (s: Json) => ({
      kind: s.kind,
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...(s.filePath !== undefined ? { filePath: s.filePath } : {}),
      opener: makeOpener(s.opener as Json),
    })

    const dockHost: DockHost = {
      band: () => band as Rectangle | null,
      preview: (x: number | null) => log('preview', x),
      dock: (tab: DetachedTab) => {
        log('dock', {
          kind: tab.kind,
          title: tab.title,
          ...(tab.filePath !== undefined ? { filePath: tab.filePath } : {}),
          view: tab.view.webContents.id,
        })
        if (dockAttach) tm.attachTab(tab, dockIndex)
      },
    }

    const winOf = (n: unknown): FakeWin => windows[Number(n) - 1]
    const tabOut = (
      t: { kind: string; title: string; filePath?: string; view: FakeView } | null,
    ) =>
      t
        ? {
            kind: t.kind,
            title: t.title,
            ...(t.filePath !== undefined ? { filePath: t.filePath } : {}),
            wc: t.view.webContents.id,
          }
        : null

    const run = async (o: Op): Promise<unknown> => {
      switch (o.op) {
        // ---- the world ----
        case 'window':
          for (const key of ['destroyed', 'minimized', 'focused', 'width', 'height'] as const) {
            if (o[key] !== undefined) (shellState as Record<string, unknown>)[key] = o[key]
          }
          return null
        case 'state': {
          const s = stateOf(o.wc as number)
          for (const key of ['dirty', 'pending', 'memo', 'destroyed', 'identity'] as const) {
            if (o[key] !== undefined) (s as Record<string, unknown>)[key] = o[key]
          }
          return null
        }
        case 'closeAnswers':
          closeAnswers.push(...(o.answers as unknown[]))
          return null
        case 'fail':
          if (o.on === false) failures.delete(o.create as string)
          else failures.add(o.create as string)
          return null
        case 'screen':
          if (o.cursor) cursor = o.cursor as typeof cursor
          if (o.workArea) workArea = o.workArea as typeof workArea
          return null
        case 'band':
          band = o.rect as typeof band
          return null
        case 'dockHost':
          dockOn = o.on as boolean
          dockAttach = o.attach !== false
          dockIndex = o.index as number | undefined
          detached.setDockHost(dockOn ? dockHost : null)
          return null
        case 'settle': {
          const pending = immediates.splice(0)
          for (const fn of pending) fn()
          return pending.length
        }
        case 'fireTimer': {
          const fn = timers.get(o.n as number)
          if (!fn) return false
          timers.delete(o.n as number)
          await fn()
          return true
        }
        case 'viewEvent':
          emitView(o.wc as number, o.event as string)
          return null
        case 'ready': {
          const r = openerReady.get(o.opener as number)
          if (o.settle === 'reject') r?.reject(new Error('document failed'))
          else r?.resolve()
          return null
        }
        case 'helpOpen': {
          const handler = windowOpen.get(o.wc as number)
          return handler ? handler({ url: o.url as string }) : null
        }
        // ---- opening ----
        case 'open':
          return openTab(o)
        case 'generate':
          return tm.openGenerateTargetTab({ target: o.target, ...(o.handoff as Json) } as never)
        case 'convert':
          return tm.openConversionResult({
            content: { target: o.target },
            ...(o.doc as Json),
          } as never)
        case 'template': {
          const c = o.copy as Json
          const out = tm.openTemplateCopy({
            editor: c.editor,
            path: c.path,
            bytes: unhex(c.hex as string),
            fileName: c.fileName,
            title: c.title,
          } as never)
          return out ? { tabId: out.tabId, wc: out.contents.id } : null
        }
        case 'plainView': {
          const view = tabManagerModule.createPlainEditorView(o.kind as never, o.path as never)
          return view.webContents.id
        }
        case 'home':
          tm.openHomeTab()
          return null
        case 'activate':
          tm.activateTab(o.id as string)
          return null
        case 'cycle':
          tm.cycleTab(o.dir as 1 | -1)
          return null
        case 'reload':
          tm.reloadTab(o.id as string)
          return null
        case 'refresh':
          tm.refreshActiveTargets()
          return null
        case 'focusActive':
          tm.focusActiveView()
          return null
        case 'reorder':
          tm.reorderTab(o.id as string, o.to as number)
          return null
        // ---- layout ----
        case 'layout':
          tm.layout()
          return null
        case 'resize':
          shellListeners.resize?.()
          return null
        case 'restore':
          shellListeners.restore?.()
          return null
        case 'reconcile':
          tm.reconcileAfterWindowRestore()
          return null
        case 'bleed':
          tm.setContentBleed({ id: o.wc } as never, o.on as boolean)
          return null
        // ---- unloaded tabs ----
        case 'addUnloaded':
          return tm.addUnloadedTab(unloadedSpec(o.spec as Json) as never)
        case 'hydrate': {
          const s = o.session as Json
          return tm.hydrateSession({
            tabs: (s.tabs as Json[]).map(unloadedSpec),
            ...(s.active !== undefined ? { active: s.active } : {}),
            ...(s.split !== undefined ? { split: s.split } : {}),
          } as never)
        }
        case 'ensure': {
          const out = await settled(tm.ensureTabLoaded(o.id as string))
          if ('ok' in out) {
            const value = out.ok as { status: string; webContents?: { id: number } }
            return value.status === 'ready'
              ? { status: 'ready', wc: value.webContents?.id }
              : { status: value.status }
          }
          return out
        }
        case 'unloaded':
          return tm.isTabUnloaded(o.id as string)
        // ---- the split ----
        case 'splitWith':
          tm.splitWith(o.tab as string, o.intent as never)
          return null
        case 'beginSplit':
          tm.beginSplit(
            o.a as string,
            o.b as string,
            o.orientation as never,
            o.ratio as number,
            o.focus as never,
          )
          return null
        case 'ratio':
          tm.setSplitRatio(o.value as number)
          return null
        case 'unsplit':
          tm.unsplit()
          return null
        case 'focusPane':
          tm.focusPaneByWebContents(o.wc as number)
          return null
        case 'role':
          return tm.splitRoleOf(o.wc as number)
        case 'isPane':
          return tm.isPaneTab(o.tab as string)
        case 'promptBegin':
          tm.beginExclusivePrompt()
          return null
        case 'promptEnd':
          tm.endExclusivePrompt()
          return null
        case 'duplicate':
          return tm.openDuplicatePaneTab(o.tab as string)
        // ---- closing, detaching ----
        case 'closeTab':
          await tm.closeTab(o.id as string)
          return null
        case 'closeActive':
          tm.closeActiveTab()
          await flush()
          return null
        case 'closeNoPrompt':
          return tm.closeTabWithoutPrompt(o.id as string)
        case 'detach': {
          const tab = tm.detachTab(o.id as string)
          held.push(tab)
          return { held: held.length - 1, tab: tabOut(tab as never) }
        }
        case 'attach': {
          const tab = held[o.held as number]
          return tm.attachTab(tab as never, o.index as number | undefined, o.activate as boolean)
        }
        case 'canDetach':
          return tm.canDetachTab(o.id as string)
        // ---- queries ----
        case 'list':
          return tm.list()
        case 'split':
          return tm.splitState()
        case 'session':
          return tm.sessionTabs()
        case 'paths':
          return tm.openFilePaths()
        case 'openDocuments':
          return tm.openDocuments()
        case 'describe': {
          const d = tm.describeWebContents(o.wc as number)
          return d
        }
        case 'tabId':
          return tm.tabIdForWebContents(o.wc as number) ?? null
        case 'setFile':
          tm.setTabFileFor(o.wc as number, o.path as string)
          return null
        case 'setTitle':
          tm.setTabTitleFor(o.wc as number, o.title as string)
          return null
        case 'rename':
          return tm
            .renameTabFile(o.from as string, o.to as string)
            .map((a) => ({ kind: a.kind, wc: a.webContents.id }))
        case 'dirty':
          return pairs(
            (tm as unknown as Record<string, () => never>)[DIRTY_METHOD[o.kind as string]](),
          )
        case 'dirtyMemo':
          return pairs(tm.dirtyOrMemoHwpTabs())
        case 'live':
          return pairs(
            (tm as unknown as Record<string, () => never>)[LIVE_METHOD[o.kind as string]](),
          )
        case 'find':
          return tabLike(tm.findTabByPath(o.path as string | undefined))
        case 'findKind':
          return (
            (tm as unknown as Record<string, (p?: string) => string | undefined>)[
              FIND_METHOD[o.kind as string]
            ](o.path as string | undefined) ?? null
          )
        case 'findDiagram':
          return tm.findDiagramTabByPath(o.path as string | undefined) ?? null
        case 'findSheets':
          return tm.findSheetsTab() ?? null
        case 'active': {
          const t = (
            tm as unknown as Record<
              string,
              () => { id: string; webContents: { id: number }; filePath?: string } | undefined
            >
          )[ACTIVE_METHOD[o.kind as string]]()
          return t
            ? {
                id: t.id,
                wc: t.webContents.id,
                ...(t.filePath !== undefined ? { filePath: t.filePath } : {}),
              }
            : null
        }
        case 'viewFor':
          return wcOf(o.id as string)
        // ---- detached windows ----
        case 'newWindow': {
          const tab = tm.detachTab(o.tab as string)
          if (!tab) return null
          const win = detached.createDetachedEditorWindow({
            view: tab.view,
            kind: tab.kind,
            title: tab.title,
            filePath: tab.filePath,
            applyMenuFor: (kind: string) => log('applyMenuFor', kind),
            ...(o.tearOffAt ? { tearOffAt: o.tearOffAt as never } : {}),
          })
          return { window: (win as unknown as FakeWin).n }
        }
        case 'win': {
          const win = winOf(o.window)
          const event = o.event as string
          if (event === 'close') {
            const e = {
              prevented: false,
              preventDefault() {
                this.prevented = true
              },
            }
            for (const fn of win.listeners.close ?? []) fn(e)
            await flush()
            if (!e.prevented && !win.state.destroyed) {
              win.state.destroyed = true
              closedQueue.push(win)
            }
            return { prevented: e.prevented }
          }
          if (event === 'closed') {
            emitClosed(win)
            return null
          }
          for (const fn of win.listeners[event] ?? []) fn({ preventDefault() {} })
          return null
        }
        case 'winState': {
          const win = winOf(o.window)
          // a window destroyed from outside closes, as Electron's does
          if (o.destroyed === true && !win.state.destroyed) closedQueue.push(win)
          for (const key of ['destroyed', 'minimized', 'focused', 'title'] as const) {
            if (o[key] !== undefined) (win.state as Record<string, unknown>)[key] = o[key]
          }
          if (o.bounds) win.state.bounds = { ...win.state.bounds, ...(o.bounds as object) }
          return null
        }
        case 'drag':
          detached.dragTornWindow(o.x as number, o.y as number)
          return null
        case 'endTear':
          detached.endTornDrag()
          return null
        case 'takeTear': {
          const tab = detached.takeTornTab()
          if (!tab) return null
          return tm.attachTab(tab, o.index as number | undefined)
        }
        case 'isTearing':
          return detached.isTearingOff()
        case 'closeDetached':
          return detached.closeDetachedWithoutPrompt(o.id as string)
        case 'activateDetached':
          return detached.activateDetached(o.id as string)
        case 'isDetachedId':
          return detached.isDetachedTabId(o.id as string)
        case 'isDetachedWindow':
          return detached.isDetachedEditorWindow(winOf(o.window) as never)
        case 'focusDetachedByPath':
          return detached.focusDetachedByPath(o.path as string)
        case 'findDetachedByPath':
          return tabLike(detached.findDetachedTabByPath(o.path as string))
        case 'detachedDoc':
          return detached.detachedDocumentFor(o.wc as number) ?? null
        case 'windowForWc': {
          const win = detached.detachedWindowForWebContents(o.wc as number)
          return win ? (win as unknown as FakeWin).n : null
        }
        case 'focusedDetached': {
          const t = detached.focusedDetachedTab()
          return t
            ? {
                id: t.id,
                kind: t.kind,
                wc: t.webContents.id,
                ...(t.filePath !== undefined ? { filePath: t.filePath } : {}),
                window: (t.window as unknown as FakeWin).n,
              }
            : null
        }
        case 'focusedKind':
          return detached.focusedDetachedKind() ?? null
        case 'detachedWc':
          return detached.detachedWebContentsFor(o.id as string)?.id ?? null
        case 'detachedOpenDocuments':
          return detached.detachedOpenDocuments()
        case 'detachedSessionTabs':
          return detached.detachedSessionTabs()
        case 'detachedFilePaths':
          return detached.detachedFilePaths()
        case 'detachedSetFile':
          detached.detachedSetFileFor(o.wc as number, o.path as string)
          return null
        case 'detachedSetTitle':
          detached.detachedSetTitleFor(o.wc as number, o.title as string)
          return null
        case 'detachedRename': {
          const r = detached.detachedRenameFile(o.from as string, o.to as string)
          return r ? { kind: r.kind, wc: r.webContents.id } : null
        }
        case 'dockBandFor': {
          const s = o.shell as Json | null
          const shell = s
            ? {
                isDestroyed: () => !!s.destroyed,
                isVisible: () => s.visible !== false,
                isMinimized: () => !!s.minimized,
                getContentBounds: () => s.bounds,
              }
            : null
          return detached.dockBandFor(shell as never, o.scale as number | undefined) ?? null
        }
        default:
          throw new Error(`unknown operation ${o.op}`)
      }
    }

    const openTab = (o: Json): unknown => {
      const path = o.path as string | undefined
      switch (o.kind) {
        case 'docs':
          return tm.openDocsTab(
            path,
            o.newBlank !== undefined || o.aiContent !== undefined
              ? {
                  ...(o.newBlank !== undefined ? { newBlank: o.newBlank as boolean } : {}),
                  ...(o.aiContent !== undefined ? { aiContent: o.aiContent as never } : {}),
                }
              : undefined,
          )
        case 'sheets':
          return tm.openSheetsTab(
            path,
            o.newBlank !== undefined ? { newBlank: o.newBlank as boolean } : undefined,
          )
        case 'slides':
          return tm.openSlidesTab(path)
        case 'pdf':
          return tm.openPdfTab(path as string)
        case 'markdown':
          return tm.openMarkdownTab(path)
        case 'html':
          return tm.openHtmlTab(path)
        case 'mindmap':
          return tm.openMindmapTab(path)
        case 'epub':
          return tm.openEpubTab(path as string)
        case 'diagram':
          return tm.openDiagramTab(path)
        case 'hwp':
          return tm.openHwpTab(
            path,
            o.copy
              ? { untitledCopy: o.copy as { title: string; importedPdf?: boolean } }
              : undefined,
          )
        case 'help':
          return tm.openHelpTab(o.topic as string | undefined)
        case 'present':
          return tm.openHtmlPresentTab({ id: o.owner } as never, o.title as string)
        default:
          throw new Error(`unknown kind ${o.kind}`)
      }
    }

    /** an async call that may never settle (a document that never gets ready) */
    async function settled<T>(promise: Promise<T>): Promise<{ ok: T } | { error: string }> {
      let out: { ok: T } | { error: string } = { error: 'ready pending' }
      promise.then(
        (value) => {
          out = { ok: value }
        },
        (err) => {
          out = { error: message(err) }
        },
      )
      await flush()
      return out
    }

    // the TabManager's own settlement of ready promises runs in microtasks
    for (const o of spec.ops) {
      let value: unknown
      try {
        value = await run(o)
      } catch (err) {
        value = { error: message(err) }
      }
      await flush()
      // the closed events of the windows destroyed during the operation
      while (closedQueue.length > 0) {
        emitClosed(closedQueue.shift() as FakeWin)
      }
      results.push([o.op, value === undefined ? null : value])
    }
    results.push([
      'final',
      {
        list: tm.list(),
        split: tm.splitState(),
        session: tm.sessionTabs(),
        paths: tm.openFilePaths(),
      },
    ])
    return results
  } finally {
    // the module-level registry must not carry a window into the next case
    muted = true
    for (const win of windows) {
      win.state.destroyed = true
      emitClosed(win)
    }
    globalThis.setTimeout = saved.setTimeout
    globalThis.clearTimeout = saved.clearTimeout
    globalThis.setImmediate = saved.setImmediate
    console.warn = saved.warn
    console.error = saved.error
    if (saved.platform) Object.defineProperty(process, 'platform', saved.platform)
    restoreEnv('SEUOFFICE_NO_SPARE_VIEW', saved.noSpare)
    restoreEnv('ELECTRON_RENDERER_URL', saved.devUrl)
    detached.setDockHost(null)
    detached.setDetachedChangedListener(() => {})
    ;(globalThis as Record<symbol, unknown>)[BOX] = undefined
  }
}

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------

const scenario = (ops: Op[], rest: Omit<Scenario, 'ops'> = {}, note?: string): Case => ({
  args: [{ ...rest, ops }],
  ...(note ? { note } : {}),
})

const open = (kind: string, rest: Json = {}): Op => ({ op: 'open', kind, ...rest })
const act = (id: string): Op => ({ op: 'activate', id })
const L: Op = { op: 'list' }
const S: Op = { op: 'split' }

/** a window with the strip's titles in a language, so `untitled` is exercised */
const KO = { docs: '새 문서', sheets: '새 시트', help: '도움말' }

// ---- open ----

const openCases: Case[] = [
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('docs', { newBlank: true }),
      open('docs', { aiContent: { text: 'hi' } }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('sheets', { newBlank: true }),
      open('slides', { path: '/w/c.pptx' }),
      open('slides'),
      open('pdf', { path: '/w/d.pdf' }),
      open('markdown', { path: '/w/e.md' }),
      open('markdown'),
      open('html', { path: '/w/f.html' }),
      open('mindmap', { path: '/w/g.mm' }),
      open('mindmap'),
      open('epub', { path: '/w/h.epub' }),
      { op: 'paths' },
      L,
    ],
    {},
    'every family, with and without a file, fallback titles',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      open('slides'),
      open('markdown'),
      open('html'),
      open('mindmap'),
      open('diagram'),
      open('hwp'),
      L,
    ],
    { untitled: KO },
    'the strip names untitled tabs by kind, a kind it does not know falls back',
  ),
  scenario(
    [
      open('docs', { path: '' }),
      open('sheets', { path: '' }),
      open('markdown', { path: '' }),
      open('hwp', { path: '' }),
      { op: 'session' },
      { op: 'paths' },
      L,
    ],
    {},
    'an empty path is a path that is not there',
  ),
  scenario(
    [
      open('hwp', { path: '/w/a.hwp' }),
      open('hwp', { path: '/tmp/x.hwpx', copy: { title: 'Copy of a' } }),
      open('hwp', { path: '/tmp/y.pdf', copy: { title: 'Imported', importedPdf: true } }),
      open('hwp', { copy: { title: 'No path' } }),
      { op: 'session' },
      L,
    ],
    {},
    'hwp untitled copies: temp file never becomes the tab file',
  ),
  scenario(
    [
      open('diagram', { path: '/w/a.drawio' }),
      {
        op: 'state',
        wc: 101,
        identity: { imported: true, title: 'From Visio', sourcePath: '/w/v.vsdx' },
      },
      open('diagram', { path: '/w/v.vsdx' }),
      open('diagram'),
      { op: 'findDiagram', path: '/w/v.vsdx' },
      { op: 'findDiagram', path: '/w/a.drawio' },
      { op: 'findDiagram', path: '/w/none.vsdx' },
      L,
    ],
    {},
    'an imported Visio drawing keeps no file and is found through its source',
  ),
  scenario(
    [
      open('help'),
      open('help', { topic: 'file-menu' }),
      open('help', { topic: 'Bad Topic!' }),
      open('docs'),
      open('help', { topic: 'ai-keys' }),
      { op: 'helpOpen', wc: 100, url: 'https://example.com/page' },
      { op: 'helpOpen', wc: 100, url: 'file:///etc/passwd' },
      { op: 'helpOpen', wc: 100, url: 'nonsense' },
      L,
    ],
    { untitled: KO, devUrl: 'http://localhost:5173/' },
    'one manual: asking again focuses it, at the topic when given; its links open outside',
  ),
  scenario(
    [open('help'), open('help', { topic: 'x' }), L],
    { devUrl: 'not a url' },
    'an invalid dev URL',
  ),
  scenario(
    [
      { op: 'fail', create: 'createPdfView' },
      open('pdf', { path: '/w/a.pdf' }),
      { op: 'fail', create: 'createPdfView', on: false },
      open('pdf', { path: '/w/a.pdf' }),
      { op: 'fail', create: 'createDocsView' },
      open('docs'),
      { op: 'fail', create: 'createSheetsView' },
      open('sheets', { path: '/w/a.xlsx' }),
      open('slides'),
      L,
    ],
    {},
    'a view that cannot be made leaves no tab and spends no id',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'generate', target: 'slides', handoff: { prompt: 'make slides' } },
      { op: 'generate', target: 'html', handoff: { prompt: 'make a page' } },
      { op: 'generate', target: 'mindmap', handoff: { prompt: 'map' } },
      { op: 'convert', target: 'markdown', doc: { name: 'x' } },
      { op: 'convert', target: 'slides', doc: { name: 'y' } },
      { op: 'convert', target: 'mindmap', doc: { name: 'z' } },
      { op: 'fail', create: 'createHtmlView' },
      { op: 'generate', target: 'html', handoff: { prompt: 'again' } },
      L,
    ],
    {},
    'generate and conversion make an untitled tab and queue for its webContents',
  ),
  scenario(
    [
      {
        op: 'template',
        copy: {
          editor: 'docs',
          path: '/t/a.docx',
          hex: '504b0304',
          fileName: 'a.docx',
          title: 'Report',
        },
      },
      {
        op: 'template',
        copy: {
          editor: 'markdown',
          path: '/t/a.md',
          hex: 'efbbbf23205469',
          fileName: 'a.md',
          title: 'Notes',
        },
      },
      {
        op: 'template',
        copy: {
          editor: 'html',
          path: '/t/a.html',
          hex: '3c68313e',
          fileName: 'a.html',
          title: 'Page',
        },
      },
      {
        op: 'template',
        copy: { editor: 'mindmap', path: '/t/a.mm', hex: '7b7d', fileName: 'a.mm', title: 'Map' },
      },
      {
        op: 'template',
        copy: {
          editor: 'slides',
          path: '/t/a.pptx',
          hex: '504b',
          fileName: 'a.pptx',
          title: 'Deck',
        },
      },
      {
        op: 'template',
        copy: { editor: 'hwp', path: '/t/a.hwpx', hex: '00', fileName: 'a.hwpx', title: 'Hangul' },
      },
      {
        op: 'template',
        copy: {
          editor: 'pdf',
          path: '/t/a.pdf',
          hex: '25504446',
          fileName: 'a.pdf',
          title: 'Form',
        },
      },
      {
        op: 'template',
        copy: { editor: 'sheets', path: '/t/a.xlsx', hex: '00', fileName: 'a.xlsx', title: 'Grid' },
      },
      {
        op: 'template',
        copy: { editor: 'epub', path: '/t/a.epub', hex: '00', fileName: 'a.epub', title: 'Book' },
      },
      L,
    ],
    {},
    'a template copy: bytes queued per editor, the title set on a tab with no file',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'duplicate', tab: 't1' },
      open('sheets'),
      { op: 'duplicate', tab: 't3' },
      open('pdf', { path: '/w/a.pdf' }),
      { op: 'duplicate', tab: 't4' },
      open('epub', { path: '/w/a.epub' }),
      { op: 'duplicate', tab: 't5' },
      open('diagram'),
      { op: 'duplicate', tab: 't6' },
      open('present', { owner: 100, title: '' }),
      { op: 'duplicate', tab: 't7' },
      { op: 'duplicate', tab: 'home' },
      { op: 'duplicate', tab: 'nope' },
      L,
    ],
    {},
    'a second view of the same document, a blank one for a file-less tab, none for a Present tab',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('present', { owner: 100, title: 'Live preview' }),
      open('present', { owner: 100, title: '' }),
      { op: 'session' },
      { op: 'openDocuments' },
      { op: 'paths' },
      L,
    ],
    { untitled: { html: 'Präsentation' } },
    'a Present tab: no file, never restored, never an agent target',
  ),
  scenario(
    [
      {
        op: 'plainView',
        kind: 'docs',
        path: '/w/a.docx',
      },
      { op: 'plainView', kind: 'sheets', path: '/w/a.xlsx' },
      { op: 'plainView', kind: 'sheets' },
      { op: 'plainView', kind: 'hwp', path: '/w/a.hwp' },
      { op: 'plainView', kind: 'pdf', path: '/w/a.pdf' },
      { op: 'plainView', kind: 'pdf' },
      { op: 'plainView', kind: 'epub' },
      { op: 'plainView', kind: 'epub', path: '' },
      { op: 'plainView', kind: 'diagram' },
    ],
    {},
    'the plain opener: a PDF and an EPUB need their file',
  ),
]

// ---- layout ----

const layoutCases: Case[] = [
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      act('t1'),
      act('home'),
      { op: 'window', width: 800, height: 600 },
      { op: 'resize' },
      { op: 'settle' },
      { op: 'window', width: 0, height: 0 },
      { op: 'resize' },
      { op: 'settle' },
      { op: 'window', minimized: true, width: 900, height: 700 },
      { op: 'restore' },
      { op: 'settle' },
      { op: 'window', minimized: false },
      { op: 'restore' },
      { op: 'settle' },
      { op: 'window', destroyed: true },
      { op: 'resize' },
      { op: 'settle' },
      { op: 'reconcile' },
    ],
    {},
    'resize and restore lay out now and once more on the next tick; a degenerate or destroyed window is left alone',
  ),
  scenario(
    [open('docs'), open('sheets'), { op: 'layout' }],
    { shell: { scale: 1.5 } },
    'the strip grows with the interface scale',
  ),
  scenario(
    [
      open('docs'),
      open('markdown'),
      { op: 'window', height: 30 },
      { op: 'layout' },
      { op: 'window', height: 40 },
      { op: 'layout' },
    ],
    {},
    'a window as tall as the strip leaves no room',
  ),
  scenario(
    [
      open('slides', { path: '/w/a.pptx' }),
      open('docs', { path: '/w/b.docx' }),
      { op: 'viewEvent', wc: 100, event: 'enter-html-full-screen' },
      { op: 'viewEvent', wc: 100, event: 'enter-html-full-screen' },
      { op: 'resize' },
      { op: 'settle' },
      act('home'),
      { op: 'viewEvent', wc: 100, event: 'leave-html-full-screen' },
      { op: 'viewEvent', wc: 101, event: 'leave-html-full-screen' },
      { op: 'closeNoPrompt', id: 't1' },
      L,
    ],
    {},
    'an HTML fullscreen view covers the window until it leaves; closing it clears the cover',
  ),
  scenario(
    [
      open('slides', { path: '/w/a.pptx' }),
      open('docs'),
      { op: 'bleed', wc: 100, on: true },
      act('t1'),
      { op: 'bleed', wc: 100, on: false },
      { op: 'bleed', wc: 100, on: false },
      act('t2'),
      { op: 'bleed', wc: 101, on: true },
      act('home'),
    ],
    {},
    'a slide show bleeds over the strip only while its tab is the active one',
  ),
  scenario(
    [
      open('docs'),
      open('markdown'),
      open('slides'),
      { op: 'splitWith', tab: 't3', intent: { kind: 'create', orientation: 'side' } },
      { op: 'bleed', wc: 102, on: true },
      { op: 'viewEvent', wc: 102, event: 'enter-html-full-screen' },
      { op: 'viewEvent', wc: 102, event: 'leave-html-full-screen' },
      { op: 'bleed', wc: 102, on: false },
      S,
    ],
    {},
    'a covering pane hides its neighbour; leaving restores both panes',
  ),
  scenario(
    [
      open('help'),
      { op: 'viewEvent', wc: 100, event: 'enter-html-full-screen' },
      { op: 'viewEvent', wc: 100, event: 'focus' },
      open('docs'),
      { op: 'viewEvent', wc: 101, event: 'focus' },
      { op: 'layout' },
    ],
    {},
    'the manual installs no full-screen or pane-focus listener',
  ),
  scenario(
    [
      open('sheets', { path: '/w/a.xlsx' }),
      { op: 'fireTimer', n: 1 },
      open('sheets', { path: '/w/b.xlsx' }),
      act('home'),
      act('t1'),
      { op: 'fireTimer', n: 3 },
      open('sheets', { path: '/w/c.xlsx' }),
      L,
    ],
    {},
    'the spare Sheets view is mounted after three seconds on a Sheets tab, and taken by the next Sheets tab',
  ),
  scenario(
    [
      open('sheets', { path: '/w/a.xlsx' }),
      { op: 'fireTimer', n: 1 },
      { op: 'viewEvent', wc: 101, event: 'render-process-gone' },
      open('sheets', { path: '/w/b.xlsx' }),
      L,
    ],
    {},
    'a spare view whose renderer died is closed and never handed out',
  ),
  scenario(
    [
      open('sheets', { path: '/w/a.xlsx' }),
      { op: 'fireTimer', n: 1 },
      { op: 'state', wc: 101, destroyed: true },
      open('sheets', { path: '/w/b.xlsx' }),
      L,
    ],
    {},
    'a destroyed spare view is not reused',
  ),
  scenario(
    [
      open('sheets', { path: '/w/a.xlsx' }),
      act('home'),
      { op: 'fireTimer', n: 1 },
      open('sheets'),
      { op: 'window', destroyed: true },
      { op: 'fireTimer', n: 2 },
    ],
    {},
    'leaving the Sheets tab cancels the timer; a destroyed window spawns no spare',
  ),
  scenario(
    [open('sheets', { path: '/w/a.xlsx' }), open('docs'), act('t1'), { op: 'fireTimer', n: 3 }],
    { noSpare: true },
    'SEUOFFICE_NO_SPARE_VIEW arms no timer',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      { op: 'fireTimer', n: 1 },
      { op: 'window', minimized: true, width: 0, height: 0 },
      { op: 'fireTimer', n: 1 },
    ],
    {},
    'no spare view while a split is live; a spare spawned in a degenerate window gets no bounds',
  ),
  scenario(
    [
      open('sheets', { path: '/w/a.xlsx' }),
      { op: 'window', width: 0, height: 0 },
      { op: 'fireTimer', n: 1 },
      L,
    ],
    {},
    'a degenerate window gives the spare view no bounds',
  ),
]

// ---- activation ----

const activateCases: Case[] = [
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      open('pdf', { path: '/w/d.pdf' }),
      open('help'),
      act('t1'),
      act('t2'),
      act('t3'),
      act('t4'),
      act('t5'),
      act('home'),
      act('nope'),
      { op: 'refresh' },
      L,
    ],
    {},
    'activating each family re-points the active targets and the app menu',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      open('markdown'),
      { op: 'cycle', dir: 1 },
      { op: 'cycle', dir: 1 },
      { op: 'cycle', dir: 1 },
      { op: 'cycle', dir: -1 },
      { op: 'cycle', dir: -1 },
      { op: 'cycle', dir: -1 },
      { op: 'cycle', dir: -1 },
      L,
    ],
    {},
    'Ctrl+Tab wraps through Home',
  ),
  scenario(
    [{ op: 'cycle', dir: 1 }, { op: 'cycle', dir: -1 }, L],
    {},
    'a strip of one does not cycle',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      open('slides'),
      open('pdf', { path: '/w/a.pdf' }),
      { op: 'reorder', id: 't4', to: 1 },
      { op: 'reorder', id: 't4', to: 99 },
      { op: 'reorder', id: 't1', to: 2.7 },
      { op: 'reorder', id: 't2', to: -5 },
      { op: 'reorder', id: 't3', to: 0 },
      { op: 'reorder', id: 'home', to: 2 },
      { op: 'reorder', id: 'nope', to: 2 },
      { op: 'reorder', id: 't3', to: 3 },
      L,
    ],
    {},
    'reorder clamps to the strip; Home stays pinned',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'focusActive' },
      { op: 'window', focused: false },
      { op: 'focusActive' },
      act('home'),
      { op: 'window', focused: true },
      { op: 'focusActive' },
      { op: 'window', destroyed: true },
      { op: 'focusActive' },
    ],
    {},
    'keyboard focus goes to the active view, or the shell for Home; none while the window is unfocused',
  ),
  scenario(
    [
      open('docs'),
      { op: 'state', wc: 100, dirty: true },
      open('sheets', { path: '/w/b.xlsx' }),
      { op: 'state', wc: 101, pending: 2 },
      open('pdf', { path: '/w/c.pdf' }),
      { op: 'state', wc: 102, dirty: true },
      open('hwp'),
      open('mindmap'),
      { op: 'state', wc: 104, destroyed: true },
      { op: 'openDocuments' },
      { op: 'reload', id: 't3' },
      { op: 'reload', id: 't1' },
      { op: 'reload', id: 't5' },
      { op: 'reload', id: 'home' },
    ],
    {},
    'open documents resolve their dirty state per family; a destroyed view is clean; reload clears PDF markup',
  ),
]

// ---- split ----

const splitCases: Case[] = [
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      S,
      { op: 'role', wc: 100 },
      { op: 'role', wc: 101 },
      { op: 'role', wc: 999 },
      { op: 'isPane', tab: 't1' },
      { op: 'isPane', tab: 'home' },
      { op: 'focusPane', wc: 100 },
      { op: 'focusPane', wc: 100 },
      { op: 'viewEvent', wc: 101, event: 'focus' },
      { op: 'ratio', value: 0.3 },
      { op: 'ratio', value: 0.3 },
      { op: 'ratio', value: 0.01 },
      { op: 'ratio', value: null },
      { op: 'window', width: 400 },
      { op: 'resize' },
      { op: 'settle' },
      { op: 'unsplit' },
      S,
      L,
    ],
    {},
    'a split of two documents: roles, pane focus, divider drags clamped, unsplit keeps the focused one',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'splitWith', tab: 't1', intent: { kind: 'create', orientation: 'stack' } },
      S,
      L,
      { op: 'splitWith', tab: 't1', intent: { kind: 'noop' } },
      { op: 'splitWith', tab: 't1', intent: null },
    ],
    {},
    'the only document: the split opens a second view of it',
  ),
  scenario(
    [
      open('help'),
      open('pdf', { path: '/w/a.pdf' }),
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      S,
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      L,
    ],
    {},
    'the manual is no pane document: a duplicate takes its place',
  ),
  scenario(
    [
      open('help'),
      open('epub', { path: '' }),
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      S,
      L,
    ],
    {},
    'a document that cannot be duplicated makes no split',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      { op: 'splitWith', tab: 't3', intent: { kind: 'replace' } },
      S,
      { op: 'ratio', value: 0.3 },
      { op: 'splitWith', tab: 't1', intent: { kind: 'reorient', orientation: 'stack' } },
      S,
      { op: 'splitWith', tab: 't1', intent: { kind: 'flip', orientation: 'side' } },
      S,
      { op: 'splitWith', tab: 't2', intent: { kind: 'focus' } },
      S,
      { op: 'splitWith', tab: 't3', intent: { kind: 'focus' } },
      S,
      L,
    ],
    {},
    'drop intents: replace, reorient, flip and focus',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'splitWith', tab: 't1', intent: { kind: 'replace' } },
      { op: 'splitWith', tab: 't1', intent: { kind: 'reorient', orientation: 'side' } },
      { op: 'splitWith', tab: 't1', intent: { kind: 'flip', orientation: 'side' } },
      { op: 'splitWith', tab: 't1', intent: { kind: 'focus' } },
      { op: 'splitWith', tab: 'home', intent: { kind: 'create', orientation: 'side' } },
      { op: 'splitWith', tab: 'nope', intent: { kind: 'create', orientation: 'side' } },
      open('present', { owner: 100, title: 'live' }),
      { op: 'splitWith', tab: 't2', intent: { kind: 'create', orientation: 'side' } },
      S,
    ],
    {},
    'intents with no split, an unknown tab, Home or a Present tab do nothing',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      open('pdf', { path: '/w/d.pdf' }),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.4, focus: 'a' },
      S,
      act('t3'),
      S,
      act('home'),
      S,
      act('t4'),
      S,
      act('t2'),
      S,
      { op: 'activate', id: 't1' },
      S,
      L,
    ],
    {},
    'activating inside a split: a pane focuses, a strip document replaces the focused pane, Home covers',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'beginSplit', a: 't1', b: 't1', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'beginSplit', a: 't1', b: 'nope', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'beginSplit', a: 'home', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      S,
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'stack', ratio: null, focus: 'b' },
      S,
      { op: 'unsplit' },
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 7, focus: 'a' },
      S,
      { op: 'unsplit' },
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: -1, focus: 'a' },
      S,
      { op: 'unsplit' },
      { op: 'unsplit' },
      S,
    ],
    {},
    'begin split refuses bad panes and bounds the ratio',
  ),
  scenario(
    [
      open('help'),
      open('docs'),
      open('present', { owner: 101, title: 'p' }),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'beginSplit', a: 't2', b: 't3', orientation: 'side', ratio: 0.5, focus: 'a' },
      S,
    ],
    {},
    'the manual and a Present tab cannot be panes',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'ratio', value: 0 },
      S,
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'ratio', value: 1 },
      S,
      { op: 'ratio', value: 0.5 },
      L,
    ],
    {},
    'a divider dragged to either end closes that pane',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      open('slides'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'b' },
      { op: 'closeNoPrompt', id: 't2' },
      S,
      L,
      { op: 'beginSplit', a: 't1', b: 't3', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'closeNoPrompt', id: 't3' },
      S,
      L,
    ],
    {},
    'closing a pane document drops the split and the other pane takes the window',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      open('slides'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      act('home'),
      { op: 'closeNoPrompt', id: 't2' },
      S,
      L,
    ],
    {},
    'closing a pane while Home is in front keeps Home',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'unsplit' },
      { op: 'unsplit' },
      { op: 'ratio', value: 0.5 },
      { op: 'focusPane', wc: 100 },
      { op: 'role', wc: 100 },
      S,
    ],
    {},
    'no split: nothing to unsplit, drag, focus or name',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('docs', { path: '/w/b.docx' }),
      open('docs', { path: '/w/./a.docx' }),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'splitWith', tab: 't3', intent: { kind: 'focus' } },
      S,
      { op: 'splitWith', tab: 't2', intent: { kind: 'focus' } },
      S,
    ],
    {},
    'a drop of a document already in a pane focuses that pane (same tab or same file)',
  ),
  scenario(
    [
      open('docs'),
      { op: 'state', wc: 100, dirty: true },
      open('sheets'),
      open('slides'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'promptBegin' },
      act('t3'),
      S,
      { op: 'promptBegin' },
      act('home'),
      { op: 'promptEnd' },
      S,
      { op: 'promptEnd' },
      S,
      { op: 'promptEnd' },
      L,
    ],
    {},
    'prompts snapshot the arrangement and bring it back after the outermost end',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'promptBegin' },
      act('t1'),
      { op: 'promptEnd' },
      L,
      { op: 'promptBegin' },
      { op: 'promptEnd' },
      { op: 'promptEnd' },
    ],
    {},
    'without a live split the tab a prompt showed stays in front',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'promptBegin' },
      { op: 'promptEnd' },
      { op: 'promptBegin' },
      { op: 'ratio', value: 0.4 },
      { op: 'promptEnd' },
      S,
    ],
    {},
    'an unchanged arrangement is not rebuilt; a changed one is',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
    ],
    { splitListener: false },
    'a window that was given no split listener',
  ),
  scenario(
    [
      open('docs'),
      open('sheets'),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.02, focus: 'a' },
      S,
      { op: 'ratio', value: 0.99 },
      S,
      { op: 'window', width: 300 },
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'stack', ratio: 0.5, focus: 'a' },
      S,
    ],
    {},
    'the ratio is clamped so no pane gets narrower than its minimum, on either axis',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      open('pdf', { path: '/w/d.pdf' }),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'b' },
      act('t3'),
      S,
      act('t4'),
      S,
      act('t1'),
      S,
      L,
    ],
    {},
    'a strip document replaces the pane that holds the focus',
  ),
]

// ---- unloaded tabs ----

const plain = { kind: 'plain' }

const unloadedCases: Case[] = [
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'docs', filePath: '/w/a.docx', opener: plain } },
      {
        op: 'addUnloaded',
        spec: { kind: 'sheets', title: 'Budget', filePath: '/w/b.xlsx', opener: plain },
      },
      { op: 'addUnloaded', spec: { kind: 'markdown', opener: plain } },
      { op: 'unloaded', id: 't1' },
      { op: 'unloaded', id: 'home' },
      { op: 'openDocuments' },
      { op: 'session' },
      { op: 'paths' },
      { op: 'canDetach', id: 't1' },
      L,
    ],
    { untitled: KO },
    'an unloaded tab is listed, clean and a document, but holds no view',
  ),
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'docs', filePath: '/w/a.docx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'pdf', filePath: '/w/c.pdf', opener: plain } },
      act('t1'),
      act('t1'),
      act('t2'),
      act('t3'),
      { op: 'unloaded', id: 't1' },
      L,
    ],
    {},
    'the first activation runs the opener once and makes the editor',
  ),
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'pdf', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'epub', filePath: '', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'docs', opener: { kind: 'custom', fails: true } } },
      act('t1'),
      act('t2'),
      act('t3'),
      act('t3'),
      { op: 'unloaded', id: 't3' },
      L,
    ],
    {},
    'an opener that fails leaves the window as it was and the tab unloaded',
  ),
  scenario(
    [
      {
        op: 'hydrate',
        session: {
          tabs: [
            { kind: 'docs', filePath: '/w/a.docx', opener: plain },
            { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain },
            { kind: 'slides', filePath: '/w/c.pptx', opener: plain },
          ],
          active: 1,
        },
      },
      L,
    ],
    {},
    'a restored session loads only its front tab',
  ),
  scenario(
    [
      {
        op: 'hydrate',
        session: {
          tabs: [
            { kind: 'docs', filePath: '/w/a.docx', opener: plain },
            { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain },
            { kind: 'slides', filePath: '/w/c.pptx', opener: plain },
          ],
          active: 2,
          split: { a: 0, b: 1, orientation: 'side', ratio: 0.6, focus: 'a' },
        },
      },
      S,
      L,
    ],
    {},
    'a restored split loads both panes; the front tab picks the focus only inside the pair',
  ),
  scenario(
    [
      {
        op: 'hydrate',
        session: {
          tabs: [
            { kind: 'docs', filePath: '/w/a.docx', opener: plain },
            { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain },
          ],
          active: 1,
          split: { a: 0, b: 1, orientation: 'stack', ratio: 0.5, focus: 'a' },
        },
      },
      S,
    ],
    {},
    'the front tab of a restored split is its focused pane',
  ),
  scenario(
    [
      {
        op: 'hydrate',
        session: {
          tabs: [
            { kind: 'docs', filePath: '/w/a.docx', opener: plain },
            { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain },
          ],
          active: 1.5,
          split: { a: 0, b: 0, orientation: 'side', ratio: 0.5, focus: 'a' },
        },
      },
      S,
      L,
    ],
    {},
    'an index that is not an integer in range, or two equal panes, restores nothing in front',
  ),
  scenario(
    [
      {
        op: 'hydrate',
        session: {
          tabs: [
            { kind: 'docs', filePath: '/w/a.docx', opener: { kind: 'custom', fails: true } },
            { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain },
          ],
          active: 0,
          split: { a: 0, b: 1, orientation: 'side', ratio: 0.5, focus: 'a' },
        },
      },
      S,
      L,
    ],
    {},
    'a pane whose opener fails makes no split and no front tab',
  ),
  scenario(
    [
      {
        op: 'hydrate',
        session: {
          tabs: [{ kind: 'docs', filePath: '/w/a.docx', opener: plain }],
          active: -1,
          split: { a: 5, b: 0, orientation: 'side', ratio: 0.5, focus: 'a' },
        },
      },
      { op: 'hydrate', session: { tabs: [] } },
      L,
    ],
    {},
    'out-of-range and negative indices',
  ),
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'docs', filePath: '/w/a.docx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain } },
      { op: 'splitWith', tab: 't1', intent: { kind: 'create', orientation: 'side' } },
      S,
      L,
    ],
    {},
    'a dropped unloaded tab loads before it is placed',
  ),
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'docs', filePath: '/w/a.docx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'slides', filePath: '/w/c.pptx', opener: plain } },
      { op: 'beginSplit', a: 't1', b: 't3', orientation: 'side', ratio: 0.5, focus: 'a' },
      S,
      { op: 'splitWith', tab: 't2', intent: { kind: 'replace' } },
      S,
      L,
    ],
    {},
    'unloaded tabs can be panes and are loaded when they enter one',
  ),
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'docs', filePath: '/w/a.docx', opener: plain } },
      { op: 'ensure', id: 't1' },
      { op: 'ensure', id: 't1' },
      { op: 'ensure', id: 'home' },
      { op: 'ensure', id: 'nope' },
      L,
    ],
    {},
    'ensure loads without activating; a normal tab is ready at once; Home and unknown are missing',
  ),
  scenario(
    [
      {
        op: 'addUnloaded',
        spec: {
          kind: 'docs',
          filePath: '/w/a.docx',
          opener: { kind: 'custom', ready: 'resolved' },
        },
      },
      {
        op: 'addUnloaded',
        spec: {
          kind: 'docs',
          filePath: '/w/b.docx',
          opener: { kind: 'custom', ready: 'rejected' },
        },
      },
      {
        op: 'addUnloaded',
        spec: { kind: 'docs', filePath: '/w/c.docx', opener: { kind: 'custom', ready: 'pending' } },
      },
      {
        op: 'addUnloaded',
        spec: { kind: 'docs', filePath: '/w/d.docx', opener: { kind: 'custom' } },
      },
      { op: 'ensure', id: 't1' },
      { op: 'ensure', id: 't1' },
      { op: 'ensure', id: 't2' },
      { op: 'ensure', id: 't2' },
      { op: 'ensure', id: 't3' },
      { op: 'ready', opener: 3, settle: 'resolve' },
      { op: 'ensure', id: 't3' },
      { op: 'ensure', id: 't4' },
      { op: 'viewEvent', wc: 103, event: 'did-finish-load' },
      { op: 'ensure', id: 't4' },
    ],
    {},
    "ensure waits for the opener's ready, or the page load when it gave none; a settled one is not awaited again",
  ),
  scenario(
    [
      {
        op: 'addUnloaded',
        spec: { kind: 'docs', filePath: '/w/a.docx', opener: { kind: 'custom' } },
      },
      { op: 'ensure', id: 't1' },
      { op: 'viewEvent', wc: 100, event: 'destroyed' },
      { op: 'ensure', id: 't1' },
    ],
    {},
    'a view that goes away before its page loaded rejects',
  ),
  scenario(
    [
      {
        op: 'addUnloaded',
        spec: { kind: 'docs', filePath: '/w/a.docx', opener: { kind: 'custom', needsUser: true } },
      },
      {
        op: 'addUnloaded',
        spec: {
          kind: 'sheets',
          filePath: '/w/b.xlsx',
          opener: { kind: 'custom', needsUser: false, ready: 'pending' },
        },
      },
      { op: 'ensure', id: 't1' },
      { op: 'unloaded', id: 't1' },
      act('t1'),
      { op: 'ensure', id: 't1' },
      { op: 'ensure', id: 't2' },
      { op: 'ready', opener: 2, settle: 'resolve' },
      { op: 'ensure', id: 't2' },
    ],
    {},
    'a document that must ask the user first is not loaded for a caller that cannot wait; a click loads it',
  ),
  scenario(
    [
      {
        op: 'addUnloaded',
        spec: { kind: 'docs', filePath: '/w/a.docx', opener: { kind: 'custom', fails: true } },
      },
      { op: 'ensure', id: 't1' },
    ],
    {},
    'an opener that throws rejects the ensure',
  ),
  scenario(
    [
      { op: 'addUnloaded', spec: { kind: 'docs', filePath: '/w/a.docx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain } },
      { op: 'addUnloaded', spec: { kind: 'pdf', opener: plain } },
      { op: 'find', path: '/w/b.xlsx' },
      { op: 'unloaded', id: 't2' },
      { op: 'findKind', kind: 'docs', path: '/w/a.docx' },
      { op: 'findKind', kind: 'sheets', path: '/w/a.docx' },
      { op: 'find', path: '/w/none' },
      { op: 'find' },
      { op: 'detach', id: 't1' },
      { op: 'unloaded', id: 't1' },
      L,
    ],
    {},
    'a path lookup loads an unloaded tab; detach takes a live document, so it loads first',
  ),
  scenario(
    [
      {
        op: 'addUnloaded',
        spec: { kind: 'docs', filePath: '/w/a.docx', opener: { kind: 'custom', fails: true } },
      },
      { op: 'find', path: '/w/a.docx' },
      { op: 'detach', id: 't1' },
      { op: 'closeNoPrompt', id: 't1' },
      { op: 'closeTab', id: 'home' },
      L,
    ],
    {},
    'a failing opener answers none to a lookup and a detach; closing it just drops it',
  ),
]

// ---- closing ----

const closeCases: Case[] = [
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      { op: 'closeTab', id: 't2' },
      { op: 'closeTab', id: 't3' },
      { op: 'closeTab', id: 't1' },
      { op: 'closeTab', id: 'home' },
      { op: 'closeTab', id: 'nope' },
      L,
    ],
    {},
    'clean tabs close with no prompt; a closed file is reported; the neighbour takes over',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'state', wc: 100, dirty: true },
      open('sheets', { path: '/w/b.xlsx' }),
      { op: 'state', wc: 101, pending: 1 },
      { op: 'closeAnswers', answers: [false, true, true] },
      act('home'),
      { op: 'closeTab', id: 't1' },
      L,
      { op: 'closeTab', id: 't1' },
      L,
      { op: 'closeTab', id: 't2' },
      L,
    ],
    {},
    'a dirty tab is brought forward for its prompt; a cancel leaves it open and in front',
  ),
  scenario(
    [
      open('pdf', { path: '/w/a.pdf' }),
      { op: 'state', wc: 100, dirty: true },
      open('markdown', { path: '/w/b.md' }),
      { op: 'state', wc: 101, dirty: true },
      open('html', { path: '/w/c.html' }),
      { op: 'state', wc: 102, dirty: true },
      open('hwp', { path: '/w/d.hwp' }),
      { op: 'state', wc: 103, dirty: true },
      open('mindmap', { path: '/w/e.mm' }),
      { op: 'state', wc: 104, dirty: true },
      open('epub', { path: '/w/f.epub' }),
      { op: 'state', wc: 105, dirty: true },
      open('diagram', { path: '/w/g.drawio' }),
      { op: 'state', wc: 106, dirty: true },
      open('slides', { path: '/w/h.pptx' }),
      { op: 'state', wc: 107, dirty: true },
      { op: 'closeAnswers', answers: [true, true, true, true, true, true, true, true] },
      { op: 'closeTab', id: 't1' },
      { op: 'closeTab', id: 't2' },
      { op: 'closeTab', id: 't3' },
      { op: 'closeTab', id: 't4' },
      { op: 'closeTab', id: 't5' },
      { op: 'closeTab', id: 't6' },
      { op: 'closeTab', id: 't7' },
      { op: 'closeTab', id: 't8' },
      L,
    ],
    {},
    'each family asks its own prompt',
  ),
  scenario(
    [
      open('pdf', { path: '/w/a.pdf' }),
      open('markdown', { path: '/w/b.md' }),
      open('html', { path: '/w/c.html' }),
      open('hwp', { path: '/w/d.hwp' }),
      open('mindmap', { path: '/w/e.mm' }),
      open('epub', { path: '/w/f.epub' }),
      open('diagram', { path: '/w/g.drawio' }),
      open('slides', { path: '/w/h.pptx' }),
      open('sheets', { path: '/w/i.xlsx' }),
      open('docs', { path: '/w/j.docx' }),
      { op: 'closeTab', id: 't1' },
      { op: 'closeTab', id: 't2' },
      { op: 'closeTab', id: 't3' },
      { op: 'closeTab', id: 't4' },
      { op: 'closeTab', id: 't5' },
      { op: 'closeTab', id: 't6' },
      { op: 'closeTab', id: 't7' },
      { op: 'closeTab', id: 't8' },
      { op: 'closeTab', id: 't9' },
      { op: 'closeTab', id: 't10' },
      L,
    ],
    {},
    'clean documents ask their own family one question and close',
  ),
  scenario(
    [
      open('hwp', { path: '/w/a.hwp' }),
      { op: 'state', wc: 100, memo: true },
      open('hwp', { path: '/w/b.hwp' }),
      { op: 'closeAnswers', answers: [true, false] },
      { op: 'closeTab', id: 't1' },
      { op: 'closeNoPrompt', id: 't1' },
      { op: 'closeNoPrompt', id: 't2' },
      { op: 'dirtyMemo' },
      { op: 'dirty', kind: 'hwp' },
      L,
    ],
    {},
    'an open memo editor is a prompt and blocks a promptless close',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('docs', { path: '/w/b.docx' }),
      { op: 'state', wc: 101, dirty: true },
      { op: 'state', wc: 100, destroyed: true },
      { op: 'closeAnswers', answers: [true] },
      { op: 'closeTab', id: 't1' },
      { op: 'closeTab', id: 't2' },
      L,
    ],
    {},
    'docs ask the renderer whether it is dirty',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('markdown', { path: '/w/c.md' }),
      { op: 'closeActive' },
      { op: 'closeActive' },
      act('home'),
      { op: 'closeActive' },
      L,
    ],
    {},
    'Cmd+W closes the active tab, never Home',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets'),
      open('present', { owner: 100, title: 'live' }),
      { op: 'closeNoPrompt', id: 't3' },
      { op: 'closeNoPrompt', id: 't2' },
      { op: 'closeNoPrompt', id: 't2' },
      { op: 'closeNoPrompt', id: 'home' },
      { op: 'closeNoPrompt', id: 't1' },
      L,
    ],
    {},
    'a promptless close of a present tab reports no file; Home and unknown refuse',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('markdown', { path: '/w/b.md' }),
      { op: 'closeTab', id: 't1' },
      { op: 'canDetach', id: 't2' },
      L,
    ],
    { closedListener: false },
    'no closed listener',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('markdown', { path: '/w/c.md' }),
      { op: 'state', wc: 101, pending: 3 },
      { op: 'state', wc: 102, dirty: true },
      { op: 'dirty', kind: 'sheets' },
      { op: 'dirty', kind: 'markdown' },
      { op: 'dirty', kind: 'pdf' },
      { op: 'live', kind: 'docs' },
      { op: 'live', kind: 'sheets' },
      { op: 'live', kind: 'slides' },
      { op: 'state', wc: 101, pending: 0 },
      { op: 'dirty', kind: 'sheets' },
    ],
    {},
    'the shell-close guard lists tabs by family and dirty state',
  ),
]

// ---- detach and attach ----

const detachCases: Case[] = [
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      { op: 'detach', id: 't2' },
      L,
      { op: 'attach', held: 0 },
      L,
      { op: 'detach', id: 'home' },
      { op: 'detach', id: 'nope' },
      L,
    ],
    {},
    'a tab leaves with its live view and comes back as a new tab; Home never leaves',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      { op: 'detach', id: 't2' },
      { op: 'attach', held: 0, index: 1 },
      { op: 'detach', id: 't1' },
      { op: 'attach', held: 1, index: 0 },
      { op: 'detach', id: 't3' },
      { op: 'attach', held: 2, index: 99 },
      { op: 'detach', id: 't4' },
      { op: 'attach', held: 3, index: 1.9, activate: false },
      { op: 'detach', id: 't5' },
      { op: 'attach', held: 4, index: -4 },
      L,
    ],
    {},
    'attach puts the tab at a slot: Home stays at 0, out of range appends, quietly when not activated',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('present', { owner: 100, title: 'live' }),
      { op: 'canDetach', id: 't1' },
      { op: 'canDetach', id: 't2' },
      { op: 'canDetach', id: 'home' },
      { op: 'detach', id: 't2' },
      L,
    ],
    {},
    'a Present tab cannot leave the strip',
  ),
  scenario(
    [
      open('slides', { path: '/w/a.pptx' }),
      { op: 'viewEvent', wc: 100, event: 'enter-html-full-screen' },
      { op: 'detach', id: 't1' },
      { op: 'attach', held: 0 },
      { op: 'viewEvent', wc: 100, event: 'enter-html-full-screen' },
      { op: 'viewEvent', wc: 100, event: 'focus' },
      L,
    ],
    {},
    'a view that docks back gets no second pair of listeners',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      { op: 'detach', id: 't1' },
      S,
      L,
      { op: 'attach', held: 0 },
      S,
    ],
    {},
    'a pane document that leaves drops the split',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/b.xlsx' }),
      open('slides', { path: '/w/c.pptx' }),
      { op: 'beginSplit', a: 't1', b: 't2', orientation: 'side', ratio: 0.5, focus: 'a' },
      act('home'),
      { op: 'detach', id: 't2' },
      S,
      { op: 'attach', held: 0, activate: false },
      L,
    ],
    {},
    'a pane leaving while Home is in front keeps Home; a quiet attach only tells the strip',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      { op: 'splitWith', tab: 't1', intent: { kind: 'create', orientation: 'side' } },
      { op: 'detach', id: 't2' },
      S,
      { op: 'attach', held: 0, activate: false },
      { op: 'beginSplit', a: 't1', b: 't3', orientation: 'stack', ratio: 0.5, focus: 'b' },
      S,
    ],
    {},
    'a quiet attach lets the caller set the split itself',
  ),
]

// ---- lookups and names ----

const lookupCases: Case[] = [
  scenario(
    [
      open('docs', { path: '$DIR/a.docx' }),
      open('markdown', { path: '$DIR/sub/../b.md' }),
      open('sheets', { path: '$DIR/c.xlsx' }),
      open('docs', { path: '' }),
      { op: 'find', path: '$DIR/a.docx' },
      { op: 'find', path: '$DIR/./a.docx' },
      { op: 'find', path: '$DIR/b.md' },
      { op: 'find', path: '$DIR/missing.docx' },
      { op: 'find' },
      { op: 'findKind', kind: 'docs', path: '$DIR/a.docx' },
      { op: 'findKind', kind: 'markdown', path: '$DIR/a.docx' },
      { op: 'findKind', kind: 'markdown', path: '$DIR/b.md' },
      { op: 'findKind', kind: 'sheets', path: '$DIR/c.xlsx' },
      { op: 'findKind', kind: 'docs', path: '' },
      { op: 'findSheets' },
      { op: 'viewFor', id: 't1' },
      { op: 'viewFor', id: 'home' },
    ],
    {},
    'paths compare after resolving links and dots; the empty path matches nothing',
  ),
  Object.assign(
    scenario(
      [
        open('docs', { path: '$DIR/a.docx' }),
        open('markdown', { path: '$DIR/sub/../b.md' }),
        { op: 'find', path: '$DIR/b.md' },
        { op: 'find', path: '$DIR/sub/../a.docx' },
        { op: 'findKind', kind: 'markdown', path: '$DIR/b.md' },
      ],
      {},
      'a path with a dot segment found through the file system',
    ),
    { files: { 'a.docx': 'x', 'b.md': 'y', sub: { dir: true } } },
  ),
  scenario(
    [
      open('mindmap', { path: '/w/a.mm' }),
      open('epub', { path: '/w/b.epub' }),
      open('diagram', { path: '/w/c.drawio' }),
      open('hwp', { path: '/w/d.hwp' }),
      open('html', { path: '/w/e.html' }),
      open('markdown', { path: '/w/f.md' }),
      open('pdf', { path: '/w/g.pdf' }),
      open('present', { owner: 100, title: 'live' }),
      { op: 'active', kind: 'mindmap' },
      act('t1'),
      { op: 'active', kind: 'mindmap' },
      act('t2'),
      { op: 'active', kind: 'epub' },
      act('t3'),
      { op: 'active', kind: 'diagram' },
      act('t4'),
      { op: 'active', kind: 'hwp' },
      act('t5'),
      { op: 'active', kind: 'html' },
      act('t6'),
      { op: 'active', kind: 'markdown' },
      act('t7'),
      { op: 'active', kind: 'pdf' },
      { op: 'active', kind: 'html' },
      act('t8'),
      { op: 'active', kind: 'html' },
      act('home'),
      { op: 'active', kind: 'pdf' },
    ],
    {},
    'each menu target answers only while the active tab is of its kind; a Present tab is no html target',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('docs'),
      open('help'),
      { op: 'describe', wc: 100 },
      { op: 'describe', wc: 101 },
      { op: 'describe', wc: 102 },
      { op: 'describe', wc: 999 },
      { op: 'tabId', wc: 101 },
      { op: 'tabId', wc: 999 },
      { op: 'setTitle', wc: 101, title: 'Named' },
      { op: 'setTitle', wc: 101, title: 'Named' },
      { op: 'setTitle', wc: 100, title: 'Ignored' },
      { op: 'setTitle', wc: 999, title: 'None' },
      { op: 'setFile', wc: 101, path: '/w/saved.docx' },
      { op: 'setFile', wc: 999, path: '/w/none.docx' },
      { op: 'describe', wc: 101 },
      { op: 'paths' },
      L,
    ],
    {},
    'a tab named by its document: a title only while it has no file, a file renames the tab',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('sheets', { path: '/w/a.docx' }),
      open('markdown', { path: '/w/b.md' }),
      open('docs'),
      { op: 'rename', from: '/w/a.docx', to: '/w/z.docx' },
      { op: 'rename', from: '/w/none.docx', to: '/w/y.docx' },
      { op: 'rename', from: '/w/b.md', to: '/other/b renamed.md' },
      L,
      { op: 'session' },
    ],
    {},
    'a rename on disk follows every tab with the file and answers the affected views',
  ),
  scenario(
    [
      open('docs', { path: '/w/a.docx' }),
      open('present', { owner: 100, title: 'live' }),
      { op: 'addUnloaded', spec: { kind: 'sheets', filePath: '/w/b.xlsx', opener: plain } },
      open('help'),
      { op: 'session' },
      { op: 'openDocuments' },
      { op: 'paths' },
      act('t4'),
      { op: 'session' },
      act('t3'),
      { op: 'session' },
    ],
    {},
    'the session strip leaves out Home, the manual and Present tabs; the front tab is by id',
  ),
]

// ---- detached windows ----

const T = (kind: string, path: string): Op[] => [open(kind, { path })]

const registryCases: Case[] = [
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      ...T('slides', '/w/c.pptx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 'home' },
      { op: 'newWindow', tab: 'nope' },
      { op: 'detachedSessionTabs' },
      { op: 'detachedFilePaths' },
      { op: 'detachedOpenDocuments' },
      { op: 'isDetachedId', id: 'detached:101' },
      { op: 'isDetachedId', id: 'detached:100' },
      { op: 'isDetachedId', id: 'detached:0x65' },
      { op: 'isDetachedId', id: 'detached: 101 ' },
      { op: 'isDetachedId', id: 'detached:101abc' },
      { op: 'isDetachedId', id: 'detached:' },
      { op: 'isDetachedId', id: 't3' },
      { op: 'isDetachedWindow', window: 1 },
      { op: 'detachedWc', id: 'detached:100' },
      { op: 'detachedWc', id: 'detached:7' },
      { op: 'windowForWc', wc: 100 },
      { op: 'windowForWc', wc: 105 },
      { op: 'detachedDoc', wc: 101 },
      { op: 'detachedDoc', wc: 7 },
      L,
    ],
    {},
    'the registry: ids by webContents number, sizes by kind, the documents of the session',
  ),
  scenario(
    [
      ...T('docs', '$DIR/a.docx'),
      ...T('markdown', '$DIR/b.md'),
      open('docs'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'findDetachedByPath', path: '$DIR/a.docx' },
      { op: 'findDetachedByPath', path: '$DIR/./b.md' },
      { op: 'findDetachedByPath', path: '$DIR/c.md' },
      { op: 'focusDetachedByPath', path: '$DIR/a.docx' },
      { op: 'winState', window: 2, minimized: true },
      { op: 'focusDetachedByPath', path: '$DIR/b.md' },
      { op: 'focusDetachedByPath', path: '$DIR/c.md' },
      { op: 'winState', window: 1, destroyed: true },
      { op: 'focusDetachedByPath', path: '$DIR/a.docx' },
      { op: 'findDetachedByPath', path: '$DIR/a.docx' },
      { op: 'detachedFilePaths' },
    ],
    {},
    'a path finds its window, restores a minimized one, and ignores a destroyed one',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('pdf', '/w/b.pdf'),
      open('html'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'focusedDetached' },
      { op: 'focusedKind' },
      { op: 'winState', window: 2, focused: true },
      { op: 'focusedDetached' },
      { op: 'focusedKind' },
      { op: 'winState', window: 2, destroyed: true },
      { op: 'focusedDetached' },
      { op: 'activateDetached', id: 'detached:100' },
      { op: 'winState', window: 1, minimized: true },
      { op: 'activateDetached', id: 'detached:100' },
      { op: 'activateDetached', id: 'detached:101' },
      { op: 'activateDetached', id: 't1' },
      { op: 'detachedOpenDocuments' },
      { op: 'detachedSessionTabs' },
    ],
    {},
    'the focused detached window answers the menu targets; a destroyed one answers nothing',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      open('markdown'),
      ...T('mindmap', '/w/c.mm'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'detachedSetTitle', wc: 101, title: 'Named' },
      { op: 'detachedSetTitle', wc: 100, title: 'Ignored' },
      { op: 'detachedSetTitle', wc: 7, title: 'None' },
      { op: 'detachedSetFile', wc: 101, path: '/w/saved.md' },
      { op: 'detachedSetTitle', wc: 101, title: 'Later' },
      { op: 'detachedSetFile', wc: 7, path: '/w/x.md' },
      { op: 'detachedRename', from: '/w/a.docx', to: '/w/renamed doc.docx' },
      { op: 'detachedRename', from: '/w/none', to: '/w/other' },
      { op: 'winState', window: 3, destroyed: true },
      { op: 'detachedRename', from: '/w/c.mm', to: '/w/d.mm' },
      { op: 'detachedSessionTabs' },
      { op: 'detachedFilePaths' },
    ],
    {},
    'a Save As or rename retitles the window and follows the registry; an untitled window takes a title once',
  ),
  scenario(
    [
      { op: 'dockBandFor', shell: null },
      { op: 'dockBandFor', shell: { bounds: { x: 100, y: 50, width: 1200, height: 800 } } },
      {
        op: 'dockBandFor',
        shell: { bounds: { x: 100, y: 50, width: 1200, height: 800 } },
        scale: 1.5,
      },
      {
        op: 'dockBandFor',
        shell: { destroyed: true, bounds: { x: 0, y: 0, width: 10, height: 10 } },
      },
      {
        op: 'dockBandFor',
        shell: { visible: false, bounds: { x: 0, y: 0, width: 10, height: 10 } },
      },
      {
        op: 'dockBandFor',
        shell: { minimized: true, bounds: { x: 0, y: 0, width: 10, height: 10 } },
      },
    ],
    {},
    'the dock band covers the strip as it is rendered, with slack; none for a hidden shell',
  ),
]

const createCases: Case[] = [
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      ...T('slides', '/w/c.pptx'),
      ...T('pdf', '/w/d.pdf'),
      ...T('markdown', '/w/e.md'),
      ...T('html', '/w/f.html'),
      ...T('mindmap', '/w/g.mm'),
      ...T('hwp', '/w/h.hwp'),
      ...T('epub', '/w/i.epub'),
      ...T('diagram', '/w/j.drawio'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'newWindow', tab: 't4' },
      { op: 'newWindow', tab: 't5' },
      { op: 'newWindow', tab: 't6' },
      { op: 'newWindow', tab: 't7' },
      { op: 'newWindow', tab: 't8' },
      { op: 'newWindow', tab: 't9' },
      { op: 'newWindow', tab: 't10' },
      L,
    ],
    {},
    'each family opens its own default window size',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      ...T('slides', '/w/c.pptx'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'win', window: 1, event: 'focus' },
      { op: 'win', window: 2, event: 'focus' },
      { op: 'win', window: 3, event: 'focus' },
      { op: 'state', wc: 100, destroyed: true },
      { op: 'win', window: 1, event: 'focus' },
    ],
    {},
    'a focused window claims the active-editor targets and the menu of its kind',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      { op: 'newWindow', tab: 't1' },
      { op: 'win', window: 1, event: 'resize' },
      { op: 'settle' },
      { op: 'winState', window: 1, bounds: { width: 640, height: 480 } },
      { op: 'win', window: 1, event: 'resize' },
      { op: 'win', window: 1, event: 'restore' },
      { op: 'settle' },
      { op: 'winState', window: 1, bounds: { width: 0, height: 0 } },
      { op: 'win', window: 1, event: 'resize' },
      { op: 'settle' },
      { op: 'winState', window: 1, bounds: { width: 800, height: 600 }, destroyed: true },
      { op: 'win', window: 1, event: 'restore' },
      { op: 'settle' },
    ],
    {},
    'a detached window fits its view to its content, now and on the next tick; not when degenerate or destroyed',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't1', tearOffAt: { x: 500, y: 300 } },
      { op: 'isTearing' },
      { op: 'drag', x: 700, y: 350 },
      { op: 'drag', x: -50.2, y: -20.4 },
      { op: 'drag', x: 100.5, y: 99.5 },
      { op: 'endTear' },
      { op: 'isTearing' },
      { op: 'drag', x: 1, y: 1 },
      { op: 'endTear' },
      { op: 'newWindow', tab: 't2', tearOffAt: { x: 10, y: 5 } },
      { op: 'screen', workArea: { x: 0, y: 25, width: 1000, height: 700 } },
      { op: 'newWindow', tab: 't1', tearOffAt: { x: 5000, y: 5000 } },
    ],
    {},
    'a tear-off window is placed under the pointer, kept on the display, steered, then an ordinary window',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't1', tearOffAt: { x: 5000, y: 5000 } },
      { op: 'endTear' },
      { op: 'screen', workArea: { x: 0, y: 25, width: 1000, height: 700 } },
      { op: 'newWindow', tab: 't2', tearOffAt: { x: 5000, y: 5000 } },
      { op: 'endTear' },
      { op: 'screen', workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
      { op: 'newWindow', tab: 't1', tearOffAt: { x: -2500, y: 100 } },
    ],
    {},
    'the tear-off origin is kept inside the work area on every side',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't1', tearOffAt: { x: 500, y: 300 } },
      { op: 'newWindow', tab: 't2', tearOffAt: { x: 600, y: 300 } },
      { op: 'drag', x: 700, y: 400 },
      { op: 'winState', window: 2, destroyed: true },
      { op: 'drag', x: 800, y: 500 },
      { op: 'isTearing' },
      { op: 'endTear' },
    ],
    {},
    'only the latest tear-off is steered; a destroyed one is not',
  ),
]

const dockCases: Case[] = [
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'screen', cursor: { x: 500, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'screen', cursor: { x: 400, y: 500 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'win', window: 1, event: 'move' },
      L,
    ],
    {},
    'a window dragged over the strip shows the indicator and arms a dwell timer; leaving clears both',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true, index: 1 },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'fireTimer', n: 1 },
      L,
      { op: 'isDetachedId', id: 'detached:101' },
      { op: 'detachedOpenDocuments' },
    ],
    {},
    'resting over the strip docks the document back at the slot the strip reported',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'screen', cursor: { x: 400, y: 600 } },
      { op: 'fireTimer', n: 1 },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'band', rect: null },
      { op: 'fireTimer', n: 2 },
      L,
    ],
    {},
    'a cursor that left the strip before the dwell ended does not dock',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'dockHost', on: true },
      { op: 'win', window: 1, event: 'move' },
      { op: 'dockHost', on: false },
      { op: 'fireTimer', n: 1 },
      L,
    ],
    {},
    'no dock host (no shell window): nothing is tracked, and a late timer does not dock',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 100, y: 42 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'screen', cursor: { x: 1300, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'screen', cursor: { x: 1299.9, y: 97.9 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'screen', cursor: { x: 99, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
    ],
    {},
    'the band holds its left and top edges and not its right and bottom ones',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'moved' },
      L,
    ],
    {},
    'macOS and Linux have no moved listener: the dwell decides',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 500 } },
      { op: 'win', window: 1, event: 'moved' },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'win', window: 1, event: 'moved' },
      L,
    ],
    { platform: 'win32' },
    'on Windows the end of a native drag docks at once, only after the cursor hovered the strip',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'newWindow', tab: 't2', tearOffAt: { x: 500, y: 300 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'takeTear' },
      { op: 'isTearing' },
      { op: 'takeTear' },
      L,
    ],
    {},
    "while a tear-off follows the pointer the window's own moves are ignored; the held pointer over the strip takes the tab back",
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2', tearOffAt: { x: 500, y: 300 } },
      { op: 'winState', window: 1, destroyed: true },
      { op: 'takeTear' },
      { op: 'endTear' },
      { op: 'isTearing' },
      L,
    ],
    {},
    'a torn-off window destroyed meanwhile cannot be taken',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true, attach: false },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'win', window: 1, event: 'close' },
      { op: 'fireTimer', n: 1 },
      L,
    ],
    {},
    'closing a window that is hovering the strip clears the indicator',
  ),
]

const detachedCloseCases: Case[] = [
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 2, event: 'close' },
      { op: 'detachedOpenDocuments' },
      { op: 'detachedSessionTabs' },
    ],
    {},
    'a clean document closes its window with no prompt, docs tear down their renderer',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      ...T('pdf', '/w/c.pdf'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'state', wc: 100, dirty: true },
      { op: 'state', wc: 101, pending: 2 },
      { op: 'state', wc: 102, dirty: true },
      { op: 'detachedOpenDocuments' },
      { op: 'closeAnswers', answers: [false, false, false, true, true, true] },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 2, event: 'close' },
      { op: 'win', window: 3, event: 'close' },
      { op: 'detachedOpenDocuments' },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 2, event: 'close' },
      { op: 'win', window: 3, event: 'close' },
      { op: 'detachedOpenDocuments' },
    ],
    {},
    'a denied close keeps the window and undoes the quit in flight; the PDF family is told',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      { op: 'newWindow', tab: 't1' },
      { op: 'state', wc: 100, dirty: true },
      { op: 'closeAnswers', answers: ['throws', true] },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 1, event: 'close' },
      { op: 'detachedOpenDocuments' },
    ],
    {},
    'a prompt that fails keeps the window and clears the guards; the next close prompts again',
  ),
  scenario(
    [
      ...T('hwp', '/w/a.hwp'),
      ...T('hwp', '/w/b.hwp'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'state', wc: 100, memo: true },
      { op: 'closeAnswers', answers: [false, true] },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 2, event: 'close' },
      { op: 'closeDetached', id: 'detached:100' },
    ],
    {},
    "an open memo editor asks even a clean document, and blocks the agent's promptless close",
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      ...T('markdown', '/w/c.md'),
      { op: 'newWindow', tab: 't1' },
      { op: 'newWindow', tab: 't2' },
      { op: 'newWindow', tab: 't3' },
      { op: 'closeDetached', id: 'detached:100' },
      { op: 'closeDetached', id: 'detached:100' },
      { op: 'closeDetached', id: 'detached:101' },
      { op: 'closeDetached', id: 't1' },
      { op: 'winState', window: 3, destroyed: true },
      { op: 'closeDetached', id: 'detached:102' },
      { op: 'detachedSessionTabs' },
    ],
    {},
    'a promptless close tears the window down; a second one, a destroyed window or a tab id answers false',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      { op: 'newWindow', tab: 't1' },
      { op: 'win', window: 1, event: 'closed' },
      { op: 'isDetachedId', id: 'detached:100' },
      { op: 'detachedFilePaths' },
    ],
    {},
    'a closed window leaves the registry',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      { op: 'newWindow', tab: 't1' },
      { op: 'dockHost', on: true, attach: false },
      { op: 'band', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { op: 'screen', cursor: { x: 5, y: 5 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'winState', window: 1, title: 'Moved' },
      { op: 'win', window: 1, event: 'closed' },
      { op: 'fireTimer', n: 1 },
    ],
    {},
    'a window closed while hovering clears its dwell timer and the indicator',
  ),
  scenario(
    [
      ...T('docs', '/w/a.docx'),
      ...T('sheets', '/w/b.xlsx'),
      { op: 'newWindow', tab: 't2' },
      { op: 'dockHost', on: true },
      { op: 'band', rect: { x: 100, y: 42, width: 1200, height: 56 } },
      { op: 'screen', cursor: { x: 400, y: 70 } },
      { op: 'win', window: 1, event: 'move' },
      { op: 'fireTimer', n: 1 },
      { op: 'win', window: 1, event: 'close' },
      { op: 'win', window: 1, event: 'closed' },
      L,
    ],
    {},
    "a docked window's close handler lets the close through (its view left)",
  ),
]

// ---------------------------------------------------------------------------
// plain functions
// ---------------------------------------------------------------------------

const TOPICS = [
  'file-menu',
  'a',
  '',
  'UPPER',
  'with space',
  'x'.repeat(64),
  'x'.repeat(65),
  'a-b-9',
  'trailing\n',
  '한글',
  'a.b',
]

const group: Group = {
  'tab-manager.canonicalPath': {
    ts: (a) => canonicalPath(a[0] as string | undefined) ?? null,
    cases: [
      { args: ['$DIR/a.txt'], files: { 'a.txt': 'x' } },
      { args: ['$DIR/sub/../a.txt'], files: { 'a.txt': 'x', sub: { dir: true } } },
      { args: ['$DIR/missing.txt'] },
      { args: ['$DIR/nope/../a.txt'], files: { 'a.txt': 'x' } },
      { args: [''] },
      { args: ['relative/none.txt'] },
      { args: [null] },
    ],
  },
  'tab-manager.helpTopicParam': {
    ts: (a) => helpTopicParam(a[0]) ?? null,
    cases: [...TOPICS.map((t): Case => ({ args: [t] })), { args: [null] }, { args: [7] }],
  },
  'tab-manager.helpViewUrl': {
    ts: (a) => {
      const saved = process.env.ELECTRON_RENDERER_URL
      if (a[0] === null) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = a[0] as string
      try {
        return helpViewUrl((a[1] ?? undefined) as string | undefined)
      } finally {
        if (saved === undefined) delete process.env.ELECTRON_RENDERER_URL
        else process.env.ELECTRON_RENDERER_URL = saved
      }
    },
    cases: [
      { args: [null, null] },
      { args: [null, 'file-menu'] },
      { args: [null, 'Bad Topic'] },
      { args: ['http://localhost:5173/', null] },
      { args: ['http://localhost:5173/', 'ai-keys'] },
      { args: ['http://localhost:5173/index.html?x=1', 'ai-keys'] },
      { args: ['http://localhost:5173/?mode=other&topic=old', 'new-topic'] },
      { args: ['not a url', null] },
    ],
  },
  'tab-manager.open': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: openCases },
  'tab-manager.layout': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: layoutCases },
  'tab-manager.activate': {
    ts: (a, cx) => runScenario(a[0] as Scenario, cx),
    cases: activateCases,
  },
  'tab-manager.split': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: splitCases },
  'tab-manager.unloaded': {
    ts: (a, cx) => runScenario(a[0] as Scenario, cx),
    cases: unloadedCases,
  },
  'tab-manager.close': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: closeCases },
  'tab-manager.detach': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: detachCases },
  'tab-manager.lookup': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: lookupCases },
  'detached-windows.registry': {
    ts: (a, cx) => runScenario(a[0] as Scenario, cx),
    cases: registryCases,
  },
  'detached-windows.create': {
    ts: (a, cx) => runScenario(a[0] as Scenario, cx),
    cases: createCases,
  },
  'detached-windows.dock': { ts: (a, cx) => runScenario(a[0] as Scenario, cx), cases: dockCases },
  'detached-windows.close': {
    ts: (a, cx) => runScenario(a[0] as Scenario, cx),
    cases: detachedCloseCases,
  },
}

export { group }
