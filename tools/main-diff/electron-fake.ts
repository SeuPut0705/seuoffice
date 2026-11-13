/**
 * `electron` for the TypeScript side of the comparison. Outside Electron the
 * package exports nothing a main-process module imports, so a resolve hook
 * answers `electron` with a module of live bindings: `useElectron` sets each
 * name to the case's fake, and a module that imported it, statically or with
 * `await import`, sees the new object on its next use. Each case gets its own
 * objects, so state a module keys by them (the dialog memory) starts afresh.
 * A name the case did not fake is undefined, and its use throws.
 *
 * Import this file, then load the module under test with `await import`: the
 * hooks are registered when this file runs, and a static import of the module
 * would be resolved before that. `ipcMain` is a fake whose methods do nothing
 * unless a case replaces it (a module that registers handlers on load
 * reaches it).
 */
import { registerHooks } from 'node:module'

type Fake = Record<string, unknown>

/** every name a main-process module (or a preload module it reaches) imports from 'electron' */
const NAMES = [
  'app',
  'BrowserWindow',
  'clipboard',
  'contextBridge',
  'desktopCapturer',
  'dialog',
  'ipcMain',
  'ipcRenderer',
  'Menu',
  'nativeImage',
  'nativeTheme',
  'net',
  'powerMonitor',
  'protocol',
  'screen',
  'safeStorage',
  'session',
  'shell',
  'systemPreferences',
  'Tray',
  'utilityProcess',
  'webContents',
  'WebContentsView',
  'webFrame',
  'webUtils',
]

const BASE: Fake = { ipcMain: { handle() {}, removeHandler() {}, on() {} } }

interface Box {
  fake: Fake
  /** the setter of each instance of the stub: `require` and `import` load it
   *  as two modules, and both must follow `useElectron` */
  setters: ((fake: Fake) => void)[]
}
const box: Box = { fake: BASE, setters: [] }
;(globalThis as Record<symbol, unknown>)[Symbol.for('main-diff.electron')] = box

const source = [
  `const box = globalThis[Symbol.for('main-diff.electron')]`,
  ...NAMES.map((name) => `export let ${name} = box.fake.${name}`),
  `box.setters.push((fake) => { ${NAMES.map((name) => `${name} = fake.${name}`).join('; ')} })`,
  `export default new Proxy({}, { get: (_, key) => box.fake[key] })`,
].join('\n')
const URL = 'main-diff:electron'

// synchronous hooks: they answer `require('electron')` of the CommonJS that
// apps/* compile to as well as `import`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: URL, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === URL) return { format: 'module', source, shortCircuit: true }
    return next(url, context)
  },
})

/** the Electron the next calls see: these names, over the do-nothing `ipcMain` */
export function useElectron(fake: Fake): void {
  box.fake = { ...BASE, ...fake }
  for (const set of box.setters) set(box.fake)
}
