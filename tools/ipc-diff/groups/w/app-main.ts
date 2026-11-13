/**
 * Loads the docs and sheets main modules afresh for one case, configured as
 * `apps/shell/src/main/index.ts` configures them, so the `ipcMain.handle/on`
 * calls of `registerDocsIpc()` and `registerSheetsIpc()` land on the case's
 * fake `ipcMain`. Not a group: W groups whose handlers live in an app's main
 * module call it from their `load`.
 *
 * Electron names the case does not fake are inert (shell-index.ts), so the
 * start-up wiring of the modules runs without effect.
 */
import { join } from 'node:path'
import type * as DocsMain from '../../../../apps/docs/src/main/docs-main.ts'
import type * as SheetsMain from '../../../../apps/sheets/src/main/sheets-main.ts'
import type { FakeContents } from '../../fakes.ts'
import type { LoadContext } from '../../types.ts'
import { inert, withInert } from './shell-index.ts'

const DOCS = 'apps/docs/src/main/docs-main.ts'
const SHEETS = 'apps/sheets/src/main/sheets-main.ts'

const INERT_NAMES = [
  'contextBridge',
  'desktopCapturer',
  'ipcRenderer',
  'Menu',
  'MenuItem',
  'nativeTheme',
  'net',
  'powerMonitor',
  'protocol',
  'screen',
  'session',
  'systemPreferences',
  'webUtils',
  'WebContentsView',
]

/** the window of the case that stands for the shell window (`mainWindow` of the shared hosts, else the first shell view) */
export function shellWindowId(cx: LoadContext): number | undefined {
  const views = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
  const shared = cx.case.hosts?.shared
  const given =
    typeof shared === 'object' && shared !== null && 'mainWindow' in shared
      ? (shared.mainWindow as { view: number; window: number })
      : undefined
  if (given) {
    const hit = views.find((v) => v.view === given.view && (v.window ?? v.view) === given.window)
    return hit ? given.window : undefined
  }
  const first = views.find((v) => (v.surface ?? 'Shell') === 'Shell')
  return first ? (first.window ?? first.view) : undefined
}

function install(cx: LoadContext, extra: Record<string, unknown> = {}): void {
  const names: Record<string, unknown> = Object.fromEntries(INERT_NAMES.map((n) => [n, inert()]))
  names.app = withInert({
    ...(cx.electron.app as object),
    getVersion: () => '0.13.0',
    getAppPath: () => `${process.cwd()}/apps/shell`,
    getLocale: () => 'ko',
    getSystemLocale: () => 'ko-KR',
    isReady: () => false,
    whenReady: () => new Promise(() => {}),
    setPath: () => {},
    setName: () => {},
    dock: undefined,
  })
  for (const key of [
    'dialog',
    'shell',
    'clipboard',
    'nativeImage',
    'webContents',
    'BrowserWindow',
  ]) {
    names[key] = withInert(cx.electron[key] as object)
  }
  cx.install({ ...names, ...extra })
}

export interface DocsHooks {
  openTab(openPath?: string, options?: { newBlank?: boolean }): void
  listTabs(): { id: string; title: string; focused: boolean }[]
  focusTab(id: string): void
}

/** `registerDocsIpc()` with the shell's runtime, window and tab hooks */
export async function loadDocsMain(cx: LoadContext, hooks: DocsHooks): Promise<typeof DocsMain> {
  install(cx)
  const docs = await cx.fresh<typeof DocsMain>(DOCS)
  const out = join(cx.dir, 'docs-out')
  docs.configureDocsRuntime({
    preloadPath: join(out, 'preload', 'index.js'),
    rendererUrl: undefined,
    rendererFile: join(out, 'renderer', 'index.html'),
  })
  const windows = cx.electron.BrowserWindow as { fromId(id: number): never }
  const windowId = shellWindowId(cx)
  docs.setDocsShellWindow(windowId === undefined ? null : windows.fromId(windowId))
  docs.setDocsHostWindowHook(() => undefined)
  docs.setDocsShellHooks({
    openTab: hooks.openTab,
    listTabs: hooks.listTabs,
    focusTab: hooks.focusTab,
    closeActiveTab: () => {},
  })
  docs.registerDocsIpc()
  return docs
}

/**
 * `registerSheetsIpc()` with the shell's runtime, and one sheets tab per
 * view of `tabViews` (`createSheetsView`: the tab's webContents is the case's
 * view), so those views are senders the module trusts
 */
export async function loadSheetsMain(
  cx: LoadContext,
  tabViews: number[],
): Promise<typeof SheetsMain> {
  const queue = [...tabViews]
  class TabView {
    webContents: FakeContents & Record<string, unknown>
    constructor() {
      const id = queue.shift()
      if (id === undefined) throw new Error('more sheets tabs than the case lists')
      this.webContents = {
        ...cx.electron.contents(id),
        setWindowOpenHandler: () => {},
        loadURL: () => Promise.resolve(),
      }
    }
  }
  install(cx, { WebContentsView: TabView })
  const sheets = await cx.fresh<typeof SheetsMain>(SHEETS)
  const out = join(cx.dir, 'sheets-out')
  sheets.configureSheetsRuntime({
    preloadPath: join(out, 'preload', 'index.js'),
    rendererUrl: undefined,
    rendererFile: join(out, 'renderer', 'index.html'),
    // a process that idles on its stdin: a sidecar that never exits leaves the tabs alone
    sidecarPath: process.execPath,
  })
  sheets.registerSheetsIpc()
  for (let i = 0; i < tabViews.length; i++) sheets.createSheetsView({ includeAiHandlers: false })
  return sheets
}
