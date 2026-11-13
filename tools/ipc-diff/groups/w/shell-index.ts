/**
 * Loads `apps/shell/src/main/index.ts` afresh for one case, so its
 * `ipcMain.handle` calls (made at module scope: `registerHomeIpc()`,
 * `registerTabsIpc()`, ...) land on the case's fake `ipcMain`. Not a group:
 * the W groups whose handlers live in the shell's entry module call it from
 * their `load`.
 *
 * The case's Electron (fakes.ts) is extended with every other name the entry
 * imports; a name the case does not fake is inert: any property read, call or
 * `new` on it gives another inert value, so start-up wiring (menus, the tray,
 * `nativeTheme`, `screen`, sessions) runs without effect. `app.whenReady()`
 * never settles unless `ready` is set, so the window, the tab manager and the
 * file index stay as they are before the app is ready.
 */
import type { LoadContext } from '../../types.ts'

const ENTRY = 'apps/shell/src/main/index.ts'

/** A value that absorbs every use */
export function inert(): unknown {
  const target = function () {}
  return new Proxy(target, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => ''
      if (key === 'then') return undefined
      if (key === Symbol.iterator) return function* () {}
      return inert()
    },
    apply: () => inert(),
    construct: () => inert() as object,
  })
}

/** An object whose missing members are inert */
export function withInert<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (t, key) => (key in t ? (t as Record<PropertyKey, unknown>)[key] : inert()),
  })
}

const NAMES = [
  'autoUpdater',
  'BaseWindow',
  'contextBridge',
  'crashReporter',
  'desktopCapturer',
  'globalShortcut',
  'ipcRenderer',
  'Menu',
  'MenuItem',
  'MessageChannelMain',
  'nativeTheme',
  'net',
  'Notification',
  'powerMonitor',
  'powerSaveBlocker',
  'protocol',
  'safeStorage',
  'screen',
  'session',
  'systemPreferences',
  'TouchBar',
  'Tray',
  'utilityProcess',
  'WebContentsView',
  'webFrameMain',
  'webUtils',
]

export interface ShellIndexOptions {
  /** `app.getVersion()` */
  version?: string
  /** names to fake beyond the case's Electron (they win) */
  electron?: Record<string, unknown>
}

/** Registers the shell entry's handlers for this case; returns the module */
export async function loadShellIndex(
  cx: LoadContext,
  options: ShellIndexOptions = {},
): Promise<unknown> {
  const app = cx.electron.app as Record<string, unknown>
  const names: Record<string, unknown> = Object.fromEntries(NAMES.map((n) => [n, inert()]))
  names.app = withInert({
    ...app,
    getVersion: () => options.version ?? '0.13.0',
    getAppPath: () => `${process.cwd()}/apps/shell`,
    getLocale: () => 'ko',
    getPreferredSystemLanguages: () => ['ko-KR'],
    isReady: () => false,
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
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
  cx.install({ ...names, ...options.electron })
  return cx.fresh(ENTRY)
}
