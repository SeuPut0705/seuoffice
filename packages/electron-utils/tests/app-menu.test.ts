import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  getFocusedWebContents: vi.fn(),
  showMessageBox: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  webContents: {
    getFocusedWebContents: electronMock.getFocusedWebContents,
  },
  app: {
    getVersion: () => '1.2.3',
  },
  dialog: {
    showMessageBox: electronMock.showMessageBox,
  },
  clipboard: {
    writeText: electronMock.writeText,
  },
}))

import { PRODUCT_NAME, setUiLang } from '@genoffice/i18n'
import {
  aboutMenuItem,
  appMenuLabels,
  appMenuPopupTemplate,
  appMenuTemplate,
  checkUpdatesMenuItem,
  contextMenuLabels,
  editMenuTemplate,
  helpCheckUpdatesItems,
  helpMenuTemplate,
  setSettingsInvoker,
  setUpdateCheckInvoker,
  settingsMenuItem,
  viewMenuTemplate,
  windowMenuTemplate,
  type AppMenuLabels,
} from '../src/index'

const LANGS = ['en', 'ko'] as const

const en = appMenuLabels('en')

type Item = { role?: string; type?: string; label?: string; accelerator?: string }
const submenuOf = (tpl: { submenu?: unknown }): Item[] => tpl.submenu as Item[]

beforeEach(() => {
  vi.clearAllMocks()
  setUpdateCheckInvoker(null)
  setSettingsInvoker(null)
})

describe('appMenuLabels', () => {
  it('covers every ui language with every key non-empty', () => {
    const keys = Object.keys(en) as (keyof AppMenuLabels)[]
    for (const lang of LANGS) {
      const labels = appMenuLabels(lang)
      for (const key of keys) expect(labels[key], `${lang}.${key}`).toBeTruthy()
    }
  })

  it('carries the AI naming label', () => {
    expect(en.nameWithAi).toBe('Name with AI…')
  })

  it('falls back to English for unknown languages', () => {
    expect(appMenuLabels('xx')).toEqual(en)
  })

  it('merges the context-menu clipboard labels', () => {
    const ko = appMenuLabels('ko')
    expect(ko.copy).toBe(contextMenuLabels('ko').copy)
    expect(ko.selectAll).toBe(contextMenuLabels('ko').selectAll)
    expect(ko.copy).not.toBe(en.copy)
  })
})

describe('windowMenuTemplate', () => {
  it('keeps the native role on macOS', () => {
    expect(windowMenuTemplate('darwin', en)).toEqual({ role: 'windowMenu', label: 'Window' })
  })

  it.each(['win32', 'linux'] as const)('builds Minimize/Close only on %s', (platform) => {
    const tpl = windowMenuTemplate(platform, en)
    expect(tpl.role).toBeUndefined()
    expect(tpl.label).toBe('Window')
    const items = submenuOf(tpl)
    expect(items.map((i) => i.label ?? i.type)).toEqual(['Minimize', 'separator', 'Close Window'])
    // no mac-only entries, no roles, no Ctrl+M
    for (const item of items) {
      expect(item.role).toBeUndefined()
      expect(item.accelerator).toBeUndefined()
      expect(item.label ?? '').not.toMatch(/zoom|front/i)
    }
  })

  it('localizes the Windows submenu', () => {
    const ko = appMenuLabels('ko')
    const items = submenuOf(windowMenuTemplate('win32', ko))
    expect(items[0]!.label).toBe(ko.minimize)
    expect(items[2]!.label).toBe(ko.closeWindow)
    expect(ko.minimize).not.toBe(en.minimize)
  })
})

describe('editMenuTemplate', () => {
  it('keeps the native role on macOS', () => {
    expect(editMenuTemplate('darwin', en)).toEqual({ role: 'editMenu', label: 'Edit' })
  })

  it('mirrors the non-mac role expansion with labeled roles on Windows', () => {
    const tpl = editMenuTemplate('win32', en)
    expect(tpl.label).toBe('Edit')
    expect(submenuOf(tpl).map((i) => i.role ?? i.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll',
    ])
    for (const item of submenuOf(tpl)) if (item.role) expect(item.label).toBeTruthy()
  })
})

describe('viewMenuTemplate', () => {
  it('mirrors the viewMenu role expansion with labeled roles', () => {
    const tpl = viewMenuTemplate(en)
    expect(tpl.label).toBe('View')
    expect(submenuOf(tpl).map((i) => i.role ?? i.type ?? i.label)).toEqual([
      'reload',
      'forceReload',
      'Developer Tools',
      'separator',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ])
    for (const item of submenuOf(tpl)) if (item.role) expect(item.label).toBeTruthy()
  })

  it('opens DevTools via an explicit click item, not the docking role', () => {
    const item = submenuOf(viewMenuTemplate(en))[2] as Item & { click?: unknown }
    expect(item.role).toBeUndefined()
    expect(typeof item.click).toBe('function')
    expect(item.accelerator).toBe(process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I')
  })

  it('drops the dev and page-zoom groups on request, keeping fullscreen', () => {
    const tpl = viewMenuTemplate(en, { devItems: false, pageZoom: false })
    expect(submenuOf(tpl).map((i) => i.role ?? i.type)).toEqual(['togglefullscreen'])
    const devOnly = viewMenuTemplate(en, { pageZoom: false })
    expect(submenuOf(devOnly).map((i) => i.role ?? i.type ?? i.label)).toEqual([
      'reload',
      'forceReload',
      'Developer Tools',
      'separator',
      'togglefullscreen',
    ])
  })

  it('closes detached DevTools when they have focus', async () => {
    const target = {
      devToolsWebContents: {},
      isDestroyed: vi.fn(() => false),
      isDevToolsOpened: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn(),
    }
    electronMock.getFocusedWebContents.mockReturnValueOnce(target).mockReturnValueOnce(null)
    const item = submenuOf(viewMenuTemplate(en))[2] as Item & {
      click: () => Promise<void>
    }

    await item.click()
    await item.click()

    expect(target.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
    expect(target.closeDevTools).toHaveBeenCalledOnce()
  })
})

describe('checkUpdatesMenuItem / manual update check wiring', () => {
  it('sits directly above About in the macOS help menu', () => {
    const items = submenuOf(helpMenuTemplate(en, [], 'darwin'))
    expect(items.at(-2)!.label).toBe(en.checkUpdates)
    expect(items.at(-1)!.label).toBe(en.about)
  })

  it('is not in the Windows or Linux help menu, which the ☰ popup replaces', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const labels = submenuOf(helpMenuTemplate(en, [], platform)).map((i) => i.label)
      expect(labels).not.toContain(en.checkUpdates)
      expect(labels.at(-1)).toBe(en.about)
      expect(helpCheckUpdatesItems(en, platform)).toEqual([])
    }
    expect(helpCheckUpdatesItems(en, 'darwin').map((i) => i.label)).toEqual([en.checkUpdates])
  })

  it('ends the ☰ popup with the check on its own, after the window menus', () => {
    const menus = [{ label: 'File', submenu: [] }, helpMenuTemplate(en, [], 'win32')]
    const popup = appMenuPopupTemplate(menus, en)
    expect(popup.slice(0, 2)).toEqual(menus)
    expect(popup[2]).toEqual({ type: 'separator' })
    expect(popup[3]!.label).toBe(en.checkUpdates)
    expect(popup).toHaveLength(4)

    const invoke = vi.fn()
    setUpdateCheckInvoker(invoke)
    ;(popup[3] as { click: () => void }).click()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('invokes the shell-registered check on click, and no-ops unregistered', () => {
    const item = checkUpdatesMenuItem(en) as { label: string; click: () => void }
    expect(item.label).toBe(en.checkUpdates)
    expect(() => item.click()).not.toThrow()

    const invoke = vi.fn()
    setUpdateCheckInvoker(invoke)
    item.click()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('About dialog offers the check button only when a check is registered', async () => {
    electronMock.showMessageBox.mockResolvedValue({ response: 0 })
    const about = aboutMenuItem(en) as { click: () => Promise<void> }

    await about.click()
    expect(electronMock.showMessageBox.mock.calls.at(-1)![0].buttons).toEqual(['OK', en.copy])

    setUpdateCheckInvoker(() => {})
    await about.click()
    expect(electronMock.showMessageBox.mock.calls.at(-1)![0].buttons).toEqual([
      'OK',
      en.copy,
      en.checkUpdates,
    ])
  })

  it('About dialog third button triggers the registered check', async () => {
    const invoke = vi.fn()
    setUpdateCheckInvoker(invoke)
    electronMock.showMessageBox.mockResolvedValue({ response: 2 })
    await (aboutMenuItem(en) as { click: () => Promise<void> }).click()
    expect(invoke).toHaveBeenCalledOnce()
    expect(electronMock.writeText).not.toHaveBeenCalled()
  })

  it('About dialog copy button still copies name + version', async () => {
    electronMock.showMessageBox.mockResolvedValue({ response: 1 })
    await (aboutMenuItem(en) as { click: () => Promise<void> }).click()
    expect(electronMock.writeText).toHaveBeenCalledWith('SeuOffice 1.2.3')
  })

  it('names the product in the About entry of every language', () => {
    expect(en.about).toBe('About SeuOffice')
    expect(appMenuLabels('ko').about).toBe('SeuOffice 정보')
    for (const lang of [...LANGS, 'vi']) {
      const about = appMenuLabels(lang).about
      expect(about, lang).not.toContain('GenOffice')
      expect(about, lang).toContain(PRODUCT_NAME)
    }
  })

  it('About dialog shows the product name of the current UI language', async () => {
    electronMock.showMessageBox.mockResolvedValue({ response: 0 })
    const about = aboutMenuItem(en) as { click: () => Promise<void> }
    try {
      setUiLang('en')
      await about.click()
      expect(electronMock.showMessageBox.mock.calls.at(-1)![0]).toMatchObject({
        title: PRODUCT_NAME,
        message: PRODUCT_NAME,
      })
      setUiLang('ko')
      await about.click()
      expect(electronMock.showMessageBox.mock.calls.at(-1)![0]).toMatchObject({
        title: PRODUCT_NAME,
        message: PRODUCT_NAME,
      })
    } finally {
      setUiLang('en')
    }
  })
})

describe('settingsMenuItem', () => {
  it('carries the Settings label and the ⌘, accelerator', () => {
    const item = settingsMenuItem(en) as Item & { click: () => void }
    expect(item.label).toBe('Settings…')
    expect(item.accelerator).toBe('CmdOrCtrl+,')
  })

  it('routes the click to the registered action', () => {
    const invoke = vi.fn()
    setSettingsInvoker(invoke)
    ;(settingsMenuItem(en) as { click: () => void }).click()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('falls back to the app own preferences when nothing is registered', () => {
    const fallback = vi.fn()
    ;(settingsMenuItem(en, fallback) as { click: () => void }).click()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('prefers the registered action over the fallback', () => {
    const invoke = vi.fn()
    const fallback = vi.fn()
    setSettingsInvoker(invoke)
    ;(settingsMenuItem(en, fallback) as { click: () => void }).click()
    expect(invoke).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('no-ops without an action, and does not throw', () => {
    expect(() => (settingsMenuItem(en) as { click: () => void }).click()).not.toThrow()
  })

  it('is localized', () => {
    const ko = appMenuLabels('ko')
    expect((settingsMenuItem(ko) as Item).label).toBe(ko.settings)
    expect(ko.settings).not.toBe(en.settings)
  })
})

describe('appMenuTemplate', () => {
  it('puts the Settings entry right after About on macOS', () => {
    const tpl = appMenuTemplate('darwin', en, { extra: [settingsMenuItem(en)] })!
    const items = submenuOf(tpl)
    expect(items[0]!.role).toBe('about')
    expect(items[1]!.label).toBe(en.settings)
    expect(items[1]!.accelerator).toBe('CmdOrCtrl+,')
  })

  it('keeps the native macOS roles around it', () => {
    const tpl = appMenuTemplate('darwin', en, { extra: [settingsMenuItem(en)] })!
    expect(submenuOf(tpl).map((i) => i.role ?? i.type)).toEqual([
      'about',
      undefined,
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ])
  })

  it('always carries a label — Electron rejects an item with neither label, role nor type', () => {
    expect(appMenuTemplate('darwin', en)!.label).toBeTruthy()
    expect(appMenuTemplate('darwin', en, { appLabel: 'Other' })!.label).toBe('Other')
  })

  it('has no application menu off macOS', () => {
    expect(appMenuTemplate('win32', en)).toBeUndefined()
    expect(appMenuTemplate('linux', en)).toBeUndefined()
  })
})
