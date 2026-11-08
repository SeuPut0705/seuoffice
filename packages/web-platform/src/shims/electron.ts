import { WebUnsupportedError } from '../errors'

/** An Electron module object: importing it is safe, touching it throws */
function absent(name: string): never {
  const fail = (): never => {
    throw new WebUnsupportedError(`electron.${name}`)
  }
  return new Proxy<() => void>(function electronStub() {}, {
    get: fail,
    set: fail,
    has: fail,
    apply: fail,
    construct: fail,
  }) as never
}

export const app = absent('app')
export const BrowserWindow = absent('BrowserWindow')
export const webContents = absent('webContents')
export const ipcMain = absent('ipcMain')
export const ipcRenderer = absent('ipcRenderer')
export const contextBridge = absent('contextBridge')
export const dialog = absent('dialog')
export const protocol = absent('protocol')
export const shell = absent('shell')
export const clipboard = absent('clipboard')
export const nativeImage = absent('nativeImage')
export const Menu = absent('Menu')
export const session = absent('session')
export const screen = absent('screen')
export const net = absent('net')
export const webUtils = absent('webUtils')
export const desktopCapturer = absent('desktopCapturer')
export const WebContentsView = absent('WebContentsView')
export const safeStorage = absent('safeStorage')

export default {
  app,
  BrowserWindow,
  webContents,
  ipcMain,
  ipcRenderer,
  contextBridge,
  dialog,
  protocol,
  shell,
  clipboard,
  nativeImage,
  Menu,
  session,
  screen,
  net,
  webUtils,
  desktopCapturer,
  WebContentsView,
  safeStorage,
}
