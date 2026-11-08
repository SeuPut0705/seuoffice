import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent, NativeImage } from 'electron'
import { productName, type Lang } from '@genoffice/i18n'
import { safeExternalUrl } from '@genoffice/electron-utils'
import {
  QUICK_LOOK_WINDOW_CHANNELS,
  isQuickLookSupportedPath,
  type QuickLookInit,
  type QuickLookPayload,
  type QuickLookTheme,
} from '../../shared/quick-look-api'
import {
  QUICK_LOOK_HOME_CHANNELS,
  normalizeQuickLookSettings,
  type QuickLookSettings,
} from '../../shared/quick-look-home'
import { quickLookText } from '../../renderer/src/i18n/strings-quick-look'
import { clearQuickLookCache, extractQuickLook } from './extract'
import { WinExplorerQuickLookHook } from './win-explorer-hook'

export interface QuickLookWindowDeps {
  parentWindow(): BrowserWindow | null
  lang(): Lang
  theme(): QuickLookTheme
  trayIcon(): NativeImage | null
  readSettings(): QuickLookSettings
  writeSettings(next: QuickLookSettings): void
  openInEditor(filePath: string): void
  showShellWindow(): void
  quitApp(): void
}

let deps: QuickLookWindowDeps | null = null
let win: BrowserWindow | null = null
let tray: Tray | null = null
let ipcRegistered = false
let currentFilePath: string | null = null
let currentPayload: QuickLookPayload | null = null
let explorerHook: WinExplorerQuickLookHook | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

const EXIT_ANIMATION_MS = 155

function clearHideTimer(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function destroyQuickLookWindow(): void {
  clearHideTimer()
  currentFilePath = null
  currentPayload = null
  if (win && !win.isDestroyed()) {
    win.destroy()
  }
  win = null
}

function fromQuickLookWindow(event: IpcMainInvokeEvent): boolean {
  return win !== null && !win.isDestroyed() && event.sender === win.webContents
}

function fromParentOrAnyShellWindow(event: IpcMainInvokeEvent): boolean {
  const parent = deps?.parentWindow()
  if (parent && !parent.isDestroyed() && event.sender === parent.webContents) {
    return true
  }
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  return senderWin !== null && !senderWin.isDestroyed()
}

function isPreviewableRegularFile(filePath: string): boolean {
  if (!filePath || !isQuickLookSupportedPath(filePath)) return false
  try {
    const st = statSync(filePath)
    return st.isFile()
  } catch {
    return false
  }
}

function syncTrayMenu(): void {
  if (!tray || !deps) return
  const lang = deps.lang()
  const appTitle = productName(lang)
  tray.setToolTip(`${appTitle} — ${quickLookText(lang, 'windowTitle')}`)
  const menu = Menu.buildFromTemplate([
    {
      label: quickLookText(lang, 'trayOpen'),
      click: () => deps?.showShellWindow(),
    },
    { type: 'separator' },
    {
      label: quickLookText(lang, 'trayQuit'),
      click: () => deps?.quitApp(),
    },
  ])
  tray.setContextMenu(menu)
}

export function syncQuickLookRuntime(): void {
  if (!deps) return
  const settings = deps.readSettings()

  if (process.platform === 'win32') {
    if (!explorerHook) {
      explorerHook = new WinExplorerQuickLookHook({
        onSpace: (filePath) => {
          void handleExplorerSpace(filePath)
        },
        onNavigate: (filePath) => {
          void handleExplorerNavigate(filePath)
        },
        onEscape: () => {
          closeQuickLookWindow()
        },
      })
    }
    explorerHook.setEnabled(settings.explorerSpacePreview)
    if (!settings.explorerSpacePreview) {
      destroyQuickLookWindow()
    }

    const wantTray = settings.explorerSpacePreview && settings.keepInTray
    if (wantTray && !tray) {
      const icon = deps.trayIcon()
      if (icon) {
        try {
          tray = new Tray(icon)
          tray.on('click', () => deps?.showShellWindow())
          tray.on('double-click', () => deps?.showShellWindow())
          syncTrayMenu()
        } catch {
          tray = null
        }
      }
    } else if (!wantTray && tray) {
      tray.destroy()
      tray = null
    } else if (tray) {
      syncTrayMenu()
    }
  }
}

export function shouldKeepQuickLookInTray(): boolean {
  if (process.platform !== 'win32' || !deps) return false
  const settings = deps.readSettings()
  return settings.explorerSpacePreview && settings.keepInTray
}

export function stopQuickLookRuntime(): void {
  explorerHook?.stop()
  explorerHook = null
  if (tray) {
    tray.destroy()
    tray = null
  }
  destroyQuickLookWindow()
  clearQuickLookCache()
}

export function closeQuickLookWindow(): void {
  clearHideTimer()
  currentFilePath = null
  currentPayload = null
  if (!win || win.isDestroyed()) {
    win = null
    return
  }
  if (!win.isVisible()) return
  win.webContents.send(QUICK_LOOK_WINDOW_CHANNELS.willHide)
  const targetWin = win
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (currentFilePath === null && targetWin && !targetWin.isDestroyed()) {
      targetWin.hide()
    }
  }, EXIT_ANIMATION_MS)
}

async function handleExplorerSpace(rawPath: string): Promise<void> {
  if (!deps) return
  const resolved = resolve(rawPath)
  if (!isPreviewableRegularFile(resolved)) return

  if (
    win &&
    !win.isDestroyed() &&
    win.isVisible() &&
    hideTimer === null &&
    currentFilePath === resolved
  ) {
    closeQuickLookWindow()
    return
  }

  await showQuickLookWindowForPath(resolved)
}

async function handleExplorerNavigate(rawPath: string): Promise<void> {
  if (!deps || !win || win.isDestroyed() || !win.isVisible() || hideTimer !== null) return
  const resolved = resolve(rawPath)
  if (currentFilePath === resolved || !isPreviewableRegularFile(resolved)) return

  currentFilePath = resolved
  const payload = await extractQuickLook(resolved)
  if (currentFilePath !== resolved) return
  currentPayload = payload
  if (win && !win.isDestroyed()) {
    win.setTitle(`${payload.name} — ${quickLookText(deps.lang(), 'windowTitle')}`)
    win.webContents.send(QUICK_LOOK_WINDOW_CHANNELS.update, payload)
  }
}

export async function showQuickLookWindowForPath(filePath: string): Promise<void> {
  if (!deps) return
  clearHideTimer()
  const resolved = resolve(filePath)
  currentFilePath = resolved
  const payload = await extractQuickLook(resolved)
  if (currentFilePath !== resolved) return
  currentPayload = payload

  const lang = deps.lang()
  if (win && !win.isDestroyed()) {
    win.setTitle(`${payload.name} — ${quickLookText(lang, 'windowTitle')}`)
    win.webContents.send(QUICK_LOOK_WINDOW_CHANNELS.willShow)
    win.webContents.send(QUICK_LOOK_WINDOW_CHANNELS.update, payload)
    if (!win.isVisible()) {
      win.showInactive()
    }
    return
  }

  const next = new BrowserWindow({
    width: 812,
    height: 652,
    minWidth: 500,
    minHeight: 400,
    show: false,
    center: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: `${payload.name} — ${quickLookText(lang, 'windowTitle')} - ${productName(lang)}`,
    webPreferences: {
      preload: join(__dirname, '../preload/quick-look.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win = next
  next.removeMenu()
  next.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  next.once('ready-to-show', () => {
    if (win === next && !next.isDestroyed() && currentFilePath !== null) {
      next.showInactive()
    }
  })
  next.on('closed', () => {
    if (win === next) {
      clearHideTimer()
      win = null
      currentFilePath = null
      currentPayload = null
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void next.loadURL(`${process.env.ELECTRON_RENDERER_URL}/quick-look.html`)
  } else {
    void next.loadFile(join(__dirname, '../renderer/quick-look.html'))
  }
}

export function notifyQuickLookLangOrThemeChanged(): void {
  syncTrayMenu()
  if (!deps || !win || win.isDestroyed()) return
  win.webContents.send(QUICK_LOOK_WINDOW_CHANNELS.langChanged, deps.lang())
  win.webContents.send(QUICK_LOOK_WINDOW_CHANNELS.themeChanged, deps.theme())
}

function registerIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(QUICK_LOOK_HOME_CHANNELS.preview, async (event, filePath: unknown) => {
    if (!fromParentOrAnyShellWindow(event) || typeof filePath !== 'string' || !filePath.trim()) {
      return null
    }
    return extractQuickLook(filePath)
  })

  ipcMain.handle(QUICK_LOOK_HOME_CHANNELS.getSettings, (event) => {
    if (!fromParentOrAnyShellWindow(event) || !deps) {
      return normalizeQuickLookSettings(undefined)
    }
    return deps.readSettings()
  })

  ipcMain.handle(QUICK_LOOK_HOME_CHANNELS.setSettings, (event, partial: unknown) => {
    if (!fromParentOrAnyShellWindow(event) || !deps) {
      return normalizeQuickLookSettings(undefined)
    }
    const current = deps.readSettings()
    const rec =
      partial && typeof partial === 'object' ? (partial as Partial<QuickLookSettings>) : {}
    const next = normalizeQuickLookSettings({
      explorerSpacePreview:
        typeof rec.explorerSpacePreview === 'boolean'
          ? rec.explorerSpacePreview
          : current.explorerSpacePreview,
      keepInTray: typeof rec.keepInTray === 'boolean' ? rec.keepInTray : current.keepInTray,
    })
    deps.writeSettings(next)
    syncQuickLookRuntime()
    return next
  })

  ipcMain.handle(QUICK_LOOK_WINDOW_CHANNELS.getInit, (event): QuickLookInit | null => {
    if (!fromQuickLookWindow(event) || !deps) return null
    return {
      lang: deps.lang(),
      theme: deps.theme(),
      payload: currentPayload,
    }
  })

  ipcMain.handle(QUICK_LOOK_WINDOW_CHANNELS.openInEditor, (event) => {
    if (!fromQuickLookWindow(event) || !deps) return
    const target = currentFilePath
    closeQuickLookWindow()
    if (target && existsSync(target)) {
      deps.openInEditor(target)
    }
  })

  ipcMain.handle(QUICK_LOOK_WINDOW_CHANNELS.revealInFolder, (event) => {
    if (!fromQuickLookWindow(event)) return
    const target = currentFilePath
    if (target && existsSync(target)) {
      shell.showItemInFolder(target)
    }
  })

  ipcMain.handle(QUICK_LOOK_WINDOW_CHANNELS.close, (event) => {
    if (!fromQuickLookWindow(event)) return
    closeQuickLookWindow()
  })
}

export function configureQuickLookWindow(nextDeps: QuickLookWindowDeps): void {
  deps = nextDeps
  registerIpc()
  syncQuickLookRuntime()
}
