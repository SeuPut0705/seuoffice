/// Localized replacements for Electron role menus, whose built-in labels are
/// English-only and (for role:'windowMenu' on Windows/Linux) follow macOS
/// conventions (Zoom, Ctrl+M minimize, Bring All to Front).
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import { getUiLang, PRODUCT_NAME, productName } from '@seuoffice/i18n'
import { baseLang, contextMenuLabels, type ContextMenuLabels } from './context-menu'

export interface AppMenuLabels extends ContextMenuLabels {
  window: string
  minimize: string
  closeWindow: string
  edit: string
  undo: string
  redo: string
  delete: string
  view: string
  reload: string
  forceReload: string
  toggleDevTools: string
  actualSize: string
  zoomIn: string
  zoomOut: string
  fullscreen: string
  help: string
  about: string
  checkUpdates: string
  version: string
  settings: string
  nameWithAi: string
}

type Labels = Omit<AppMenuLabels, keyof ContextMenuLabels>

const EN: Labels = {
  window: 'Window',
  minimize: 'Minimize',
  closeWindow: 'Close Window',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  delete: 'Delete',
  view: 'View',
  reload: 'Reload',
  forceReload: 'Force Reload',
  toggleDevTools: 'Developer Tools',
  actualSize: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  fullscreen: 'Full Screen',
  help: 'Help',
  about: 'About SeuOffice',
  checkUpdates: 'Check for Updates…',
  version: 'Version',
  settings: 'Settings…',
  nameWithAi: 'Name with AI…',
}

// Shared table, same rationale as context-menu.ts: one copy instead of
// 15 keys × 20 languages per app dictionary.
const LABELS: Record<string, Labels> = {
  en: EN,
  ko: {
    window: '창',
    minimize: '최소화',
    closeWindow: '창 닫기',
    edit: '편집',
    undo: '실행 취소',
    redo: '다시 실행',
    delete: '삭제',
    view: '보기',
    reload: '새로고침',
    forceReload: '강제 새로고침',
    toggleDevTools: '개발자 도구',
    actualSize: '실제 크기',
    zoomIn: '확대',
    zoomOut: '축소',
    fullscreen: '전체 화면',
    help: '도움말',
    about: 'SeuOffice 정보',
    checkUpdates: '업데이트 확인…',
    version: '버전',
    nameWithAi: 'AI로 이름 지정…',
    settings: '설정…',
  },
}

export function appMenuLabels(lang: string): AppMenuLabels {
  const labels = { ...contextMenuLabels(lang), ...(LABELS[lang] ?? LABELS[baseLang(lang)] ?? EN) }
  // the table spells the product name as upstream does; show this product's
  return { ...labels, about: labels.about }
}

/** macOS keeps the native role (Minimize/Zoom/Front, window list); Windows/Linux
 * gets only conventional items — no Zoom/Front, and no Ctrl+M accelerator since
 * Windows has no menu shortcut for minimize. */
export function windowMenuTemplate(
  platform: NodeJS.Platform,
  labels: AppMenuLabels,
): MenuItemConstructorOptions {
  if (platform === 'darwin') return { role: 'windowMenu', label: labels.window }
  return {
    label: labels.window,
    submenu: [
      { label: labels.minimize, click: (_item, win) => win?.minimize() },
      { type: 'separator' },
      { label: labels.closeWindow, click: (_item, win) => win?.close() },
    ],
  }
}

/** macOS keeps role:'editMenu' (Speech/Substitutions submenus etc.); elsewhere
 * the same items Electron would generate, with localized labels. */
export function editMenuTemplate(
  platform: NodeJS.Platform,
  labels: AppMenuLabels,
): MenuItemConstructorOptions {
  if (platform === 'darwin') return { role: 'editMenu', label: labels.edit }
  return {
    label: labels.edit,
    submenu: [
      { role: 'undo', label: labels.undo },
      { role: 'redo', label: labels.redo },
      { type: 'separator' },
      { role: 'cut', label: labels.cut },
      { role: 'copy', label: labels.copy },
      { role: 'paste', label: labels.paste },
      { role: 'delete', label: labels.delete },
      { type: 'separator' },
      { role: 'selectAll', label: labels.selectAll },
    ],
  }
}

let lastDetachedDevToolsTarget: WebContents | undefined

/** role:'toggleDevTools' docks DevTools into the window, where the shell's
 * WebContentsView tabs are stacked above it and occlude it — open detached
 * instead, keeping the role's accelerator and toggle semantics. */
export function toggleDevToolsItem(labels: AppMenuLabels): MenuItemConstructorOptions {
  return {
    label: labels.toggleDevTools,
    accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
    click: async () => {
      const { webContents } = await import('electron')
      const focused = webContents.getFocusedWebContents()
      const previous =
        lastDetachedDevToolsTarget && !lastDetachedDevToolsTarget.isDestroyed()
          ? lastDetachedDevToolsTarget
          : undefined
      const wc = !focused || focused === previous?.devToolsWebContents ? previous : focused
      if (!wc) return
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools()
        if (wc === lastDetachedDevToolsTarget) lastDetachedDevToolsTarget = undefined
      } else {
        wc.openDevTools({ mode: 'detach' })
        lastDetachedDevToolsTarget = wc
      }
    },
  }
}

export interface ViewMenuOptions {
  /** Reload / Force Reload / DevTools (default on) */
  readonly devItems?: boolean
  /** Actual Size / Zoom In / Zoom Out page-zoom roles (default on) */
  readonly pageZoom?: boolean
}

/**
 * role:'viewMenu' expands identically on every platform, so no branch. Menu
 * accelerators beat renderer key handlers on macOS, so apps whose document
 * shortcuts collide with ⌘R / ⌘0 / ⌘+ / ⌘- opt those groups out.
 */
export function viewMenuTemplate(
  labels: AppMenuLabels,
  { devItems = true, pageZoom = true }: ViewMenuOptions = {},
): MenuItemConstructorOptions {
  const groups: MenuItemConstructorOptions[][] = []
  if (devItems) {
    groups.push([
      { role: 'reload', label: labels.reload },
      { role: 'forceReload', label: labels.forceReload },
      toggleDevToolsItem(labels),
    ])
  }
  if (pageZoom) {
    groups.push([
      { role: 'resetZoom', label: labels.actualSize },
      { role: 'zoomIn', label: labels.zoomIn },
      { role: 'zoomOut', label: labels.zoomOut },
    ])
  }
  groups.push([{ role: 'togglefullscreen', label: labels.fullscreen }])
  return {
    label: labels.view,
    submenu: groups.flatMap((group, index) =>
      index === 0 ? group : [{ type: 'separator' }, ...group],
    ),
  }
}

/** The manual update check lives in the shell (electron-updater and its
 * result dialogs), while the menus that expose it are built here — the shell
 * injects the check at startup. Read at click time, so registration order
 * relative to menu construction doesn't matter; until registered the menu
 * entry no-ops and the About dialog doesn't offer the button. */
let updateCheckInvoker: (() => void) | null = null

export function setUpdateCheckInvoker(invoke: (() => void) | null): void {
  updateCheckInvoker = invoke
}

/** Check for Updates…: user-triggered update check (the ☰ popup on Windows and
 * Linux, right above About in Help on macOS). The shell-injected check owns all feedback: the update
 * window when newer exists, "you're up to date (version x)" otherwise. */
export function checkUpdatesMenuItem(labels: AppMenuLabels): MenuItemConstructorOptions {
  return {
    label: labels.checkUpdates,
    click: () => updateCheckInvoker?.(),
  }
}

/** Help > About: a native dialog with the app version — every window's menu
 * gets one, so users can report the exact build they run. */
export function aboutMenuItem(labels: AppMenuLabels): MenuItemConstructorOptions {
  return {
    label: labels.about,
    click: async () => {
      const { app, dialog, clipboard } = await import('electron')
      const version = app.getVersion()
      const canCheck = updateCheckInvoker !== null
      const name = productName(getUiLang())
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: name,
        message: name,
        detail: `${labels.version} ${version}`,
        buttons: ['OK', labels.copy, ...(canCheck ? [labels.checkUpdates] : [])],
        defaultId: 0,
        cancelId: 0,
      })
      if (response === 1) clipboard.writeText(`${PRODUCT_NAME} ${version}`)
      if (response === 2) updateCheckInvoker?.()
    },
  }
}

/** Check for Updates… inside Help on macOS only, where the menu bar is the
 * app's menu. Windows and Linux open the menus from the tab bar's ☰ button,
 * which shows the check as an item of its own (appMenuPopupTemplate). */
export function helpCheckUpdatesItems(
  labels: AppMenuLabels,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  return platform === 'darwin' ? [checkUpdatesMenuItem(labels)] : []
}

/** The tab bar's ☰ popup: the window's menus, then Check for Updates… on its own. */
export function appMenuPopupTemplate(
  menus: MenuItemConstructorOptions[],
  labels: AppMenuLabels,
): MenuItemConstructorOptions[] {
  return [...menus, { type: 'separator' }, checkUpdatesMenuItem(labels)]
}

/** The Settings entry, shared by every app: one label, one accelerator
 * (⌘, on macOS and Ctrl+, elsewhere), one action. The shell owns the
 * Settings view, so it registers the action; an app running on its own
 * falls back to its own preferences entry. */
let settingsInvoker: (() => void) | null = null

export function setSettingsInvoker(invoke: (() => void) | null): void {
  settingsInvoker = invoke
}

export function settingsMenuItem(
  labels: AppMenuLabels,
  fallback?: () => void,
): MenuItemConstructorOptions {
  return {
    label: labels.settings,
    accelerator: 'CmdOrCtrl+,',
    click: () => (settingsInvoker ?? fallback)?.(),
  }
}

/** macOS application menu — the one under the app name. Electron's
 * role:'appMenu' is a fixed template, so an entry of our own means spelling
 * the menu out; the native roles keep the standard order and labels. Only
 * macOS has this menu, so every other platform gets undefined. */
export function appMenuTemplate(
  platform: NodeJS.Platform,
  labels: AppMenuLabels,
  {
    extra = [],
    appLabel = PRODUCT_NAME,
  }: { extra?: MenuItemConstructorOptions[]; appLabel?: string } = {},
): MenuItemConstructorOptions | undefined {
  if (platform !== 'darwin') return undefined
  return {
    // Electron rejects a menu item that has neither label, role nor type
    label: appLabel,
    submenu: [
      { role: 'about', label: labels.about },
      ...extra,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
}

/** Help menu with Check for Updates… (macOS) + About; extra app-specific items
 * go before the separator. */
export function helpMenuTemplate(
  labels: AppMenuLabels,
  extraItems: MenuItemConstructorOptions[] = [],
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions {
  return {
    role: 'help',
    label: labels.help,
    submenu: [
      ...extraItems,
      ...(extraItems.length > 0 ? [{ type: 'separator' } as const] : []),
      ...helpCheckUpdatesItems(labels, platform),
      aboutMenuItem(labels),
    ],
  }
}
