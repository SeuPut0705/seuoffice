/**
 * Group `m/settings`: the language, UI and document themes, author name,
 * auto-save default, CSV limit, system locale and the slides font entries.
 *
 * The handlers are inline in apps/shell/src/main/index.ts, which cannot be
 * loaded on the fake Electron, so their bodies are copied verbatim:
 *  - helpers `currentLang`/`persistLang`/`currentTheme`/`currentDocTheme`/
 *    `currentCsvImportLimitMb`/`currentAutoSaveDefault`: index.ts:1072-1149
 *  - `registerHomeIpc` language/theme/doc-theme/author/auto-save/csv getters
 *    and setters: index.ts:3605-3616, 3640-3688, 3698-3699, 3713-3714
 *  - `slides:open-font-settings`: index.ts:6520-6528
 *  - `app:get-language`, `app:get-document-locale`: docs-main.ts:2463-2467
 *  - `docs:system-locale`: docs-main.ts:2475
 *  - `user:display-name`: sheets-main.ts:2320-2323 with `sessionFor`
 *    (sheets-main.ts:773) over an empty `sheetsTabs` (ipc-probe has no
 *    document batch, so no sheets tab is ever registered)
 *  - `notifyQuickLookLangOrThemeChanged`: quick-look-window.ts:292, sending
 *    to every quick-look view (the Rust sends to every ShellQuickLook view)
 * `slides:open-template-fonts-folder`: apps/slides/src/main/template-fonts.ts:13-36
 * with the real `templateFontsDir`. Faked: nativeTheme, the title bar
 * overlay, the menus (one log line for buildHomeMenu + installDockMenu +
 * installBackToHomeItems), the tray, the shell window reveal, os.userInfo.
 */
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import {
  AUTHOR_NAME_KEY,
  configuredAuthorName,
  readAuthorNameSetting,
  sanitizeAuthorName,
  systemAuthorName,
} from '@seuoffice/electron-utils'
import { templateFontsDir } from '@seuoffice/electron-utils/template-fonts-dir'
import {
  documentLocale,
  getUiLang,
  installLang,
  isLang,
  normalizeLang,
  requestedLanguage,
  setUiLang,
  type Lang,
} from '@seuoffice/i18n'
import {
  readAppSettings,
  writeAppSetting,
  writeAppSettingThen,
} from '../../../../apps/shell/src/main/app-settings.ts'
import { csvImportLimitMb } from '../../../../apps/shell/src/main/csv-import-limit.ts'
import type { Case, Group } from '../../types.ts'

type Hosts = Record<string, unknown>
type Handler = (...args: never[]) => unknown

const VIEWS = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'ShellQuickLook' },
  { view: 3, window: 3, surface: 'Docs' },
  { view: 4, window: 4, surface: 'Sheets' },
  { view: 5, window: 5, surface: 'Slides' },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    const hosts = ((cx.case.hosts ?? {}).m ?? {}) as Hosts
    const shared = ((cx.case.hosts ?? {}).shared ?? {}) as Record<string, Hosts>
    const { electron } = cx
    const ipcMain = electron.ipcMain as {
      handle(channel: string, fn: Handler): void
      removeHandler(channel: string): void
    }
    const log = electron.log
    const views = (cx.case.views ?? [{ view: 1, surface: 'Shell' }]).map((v) => ({
      view: v.view,
      surface: v.surface ?? 'Shell',
    }))
    const allWebContents = () => views.map((v) => electron.contents(v.view))

    const app = electron.app as Record<string, unknown>
    app.getLocale = () => String(hosts.appLocale ?? 'en-US')
    app.getSystemLocale = () => String(hosts.systemLocale ?? 'en-US')
    app.isPackaged = hosts.isPackaged === true
    app.getAppPath = () => String(hosts.appPath ?? '/app/apps/shell/out')
    ;(process as unknown as { resourcesPath: string }).resourcesPath = String(
      hosts.resourcesPath ?? '/app/resources',
    )
    if (typeof hosts.envLang === 'string') process.env.SEUOFFICE_LANG = hosts.envLang
    else delete process.env.SEUOFFICE_LANG

    // os.userInfo: `username: null` is a platform that refuses to say
    ;(os as unknown as { userInfo: () => { username: string } }).userInfo = () => {
      if (hosts.username === null) throw new Error('no user')
      return { username: typeof hosts.username === 'string' ? hosts.username : 'tester' }
    }
    syncBuiltinESMExports()

    const nativeTheme = {
      set themeSource(theme: string) {
        log.push(['nativeTheme.themeSource', theme])
      },
      shouldUseDarkColors: false,
    }
    Object.assign(electron, { nativeTheme })

    const getPath = (name: string) => (app.getPath as (n: string) => string)(name)
    const APP_SETTINGS_PATH = () => join(getPath('userData'), 'app-settings.json')

    // ---- index.ts:1072-1149 ----
    let uiLang: Lang | null = null
    function currentLang(): Lang {
      if (uiLang) return uiLang
      if (process.env.SEUOFFICE_LANG) {
        uiLang = normalizeLang(process.env.SEUOFFICE_LANG)
        setUiLang(uiLang, process.env.SEUOFFICE_LANG)
        return uiLang
      }
      const stored = readAppSettings(APP_SETTINGS_PATH()).language
      uiLang = installLang(stored, (app.getLocale as () => string)())
      setUiLang(uiLang, requestedLanguage(stored, (app.getLocale as () => string)()))
      return uiLang
    }
    function persistLang(lang: Lang): void {
      writeAppSettingThen(APP_SETTINGS_PATH(), 'language', lang, (persisted) => {
        uiLang = persisted
        setUiLang(persisted)
      })
    }
    let cachedTheme: 'light' | 'dark' | 'system' | null = null
    function currentTheme(): 'light' | 'dark' | 'system' {
      if (cachedTheme) return cachedTheme
      const saved = readAppSettings(APP_SETTINGS_PATH()).theme
      cachedTheme = saved === 'light' || saved === 'dark' ? saved : 'system'
      return cachedTheme
    }
    let cachedDocTheme: 'follow' | 'light' | 'dark' | null = null
    function currentDocTheme(): 'follow' | 'light' | 'dark' {
      if (cachedDocTheme) return cachedDocTheme
      const saved = readAppSettings(APP_SETTINGS_PATH()).documentTheme
      cachedDocTheme = saved === 'light' || saved === 'dark' ? saved : 'follow'
      return cachedDocTheme
    }
    function currentCsvImportLimitMb(): number {
      return csvImportLimitMb(readAppSettings(APP_SETTINGS_PATH()))
    }
    let cachedAutoSaveDefault: { on: boolean; updatedAt: number } | null = null
    function currentAutoSaveDefault(): { on: boolean; updatedAt: number } {
      if (cachedAutoSaveDefault) return cachedAutoSaveDefault
      const saved = readAppSettings(APP_SETTINGS_PATH())
      const updatedAt = saved.autoSaveDefaultUpdatedAt
      cachedAutoSaveDefault = {
        on: saved.autoSaveDefault === true,
        updatedAt: typeof updatedAt === 'number' && updatedAt > 0 ? updatedAt : 0,
      }
      return cachedAutoSaveDefault
    }

    // the shell's boot settles the language before any tab loads (index.ts:6838)
    currentLang()

    // ---- the host effects the Rust logs ----
    const buildMenusForLanguage = () => log.push(['rebuildMenusForLanguage'])
    const refreshTitleBarOverlay = () => log.push(['refreshTitleBarOverlay'])
    // quick-look-window.ts:292, to every quick-look view
    const notifyQuickLookLangOrThemeChanged = () => {
      log.push(['syncTrayMenu'])
      const quickLook = views.filter((v) => v.surface === 'ShellQuickLook')
      for (const v of quickLook)
        electron.contents(v.view).send('quick-look:lang-changed', currentLang())
      for (const v of quickLook)
        electron.contents(v.view).send('quick-look:theme-changed', currentTheme())
    }

    // ---- index.ts:3605-3716 ----
    ipcMain.handle('home:get-language', (): Lang => currentLang())
    ipcMain.handle('home:set-language', (_event: unknown, lang: unknown) => {
      if (!isLang(lang) || lang === currentLang()) return
      persistLang(lang)
      buildMenusForLanguage()
      notifyQuickLookLangOrThemeChanged()
      for (const wc of allWebContents()) wc.send('app:language-changed', lang)
    })
    ipcMain.handle('home:get-theme', () => currentTheme())
    ipcMain.handle('app:get-theme', () => currentTheme())
    ipcMain.handle('home:set-theme', (_event: unknown, theme: unknown) => {
      if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
      if (theme === currentTheme()) return
      cachedTheme = theme
      writeAppSetting(APP_SETTINGS_PATH(), 'theme', theme)
      nativeTheme.themeSource = theme
      refreshTitleBarOverlay()
      notifyQuickLookLangOrThemeChanged()
      for (const wc of allWebContents()) wc.send('app:theme-changed', theme)
    })
    ipcMain.handle('home:get-document-theme', () => currentDocTheme())
    ipcMain.handle('app:get-document-theme', () => currentDocTheme())
    ipcMain.handle('home:set-document-theme', (_event: unknown, theme: unknown) => {
      if (theme !== 'light' && theme !== 'dark' && theme !== 'follow') return
      if (theme === currentDocTheme()) return
      cachedDocTheme = theme
      writeAppSetting(APP_SETTINGS_PATH(), 'documentTheme', theme)
      for (const wc of allWebContents()) wc.send('app:document-theme-changed', theme)
    })
    const authorNameSetting = () => ({
      value: readAuthorNameSetting(APP_SETTINGS_PATH()),
      fallback: systemAuthorName(),
    })
    ipcMain.handle('home:get-author-name', () => authorNameSetting())
    ipcMain.handle('app:get-author-name', (): string => {
      const { value, fallback } = authorNameSetting()
      return value || fallback
    })
    ipcMain.handle('home:set-author-name', (_event: unknown, raw: unknown) => {
      const value = sanitizeAuthorName(raw)
      if (value !== readAuthorNameSetting(APP_SETTINGS_PATH())) {
        writeAppSetting(APP_SETTINGS_PATH(), AUTHOR_NAME_KEY, value)
        const effective = value || systemAuthorName()
        for (const wc of allWebContents()) wc.send('app:author-name-changed', effective)
      }
      return authorNameSetting()
    })
    ipcMain.handle('app:get-auto-save-default', () => currentAutoSaveDefault())
    ipcMain.handle('app:get-csv-import-limit', () => currentCsvImportLimitMb())

    // ---- the editor mains' shared handlers ----
    ipcMain.removeHandler('app:get-language')
    ipcMain.handle('app:get-language', () => getUiLang())
    ipcMain.removeHandler('app:get-document-locale')
    ipcMain.handle('app:get-document-locale', () => documentLocale())
    ipcMain.handle('docs:system-locale', () => (app.getSystemLocale as () => string)())

    // sheets-main.ts:2320 over sheetsTabs, which is empty in the probe
    const sheetsTabs = new Map<number, unknown>()
    ipcMain.handle('user:display-name', (event: { sender: { id: number } }): string => {
      const entry = sheetsTabs.get(event.sender.id)
      if (!entry) throw new Error('Untrusted IPC sender.')
      return configuredAuthorName(app as { getPath(name: 'userData'): string })
    })

    // ---- index.ts:6520: the shell window is the host's `revealHome` ----
    const mainWindow = (shared.mainWindow ?? {}) as { view?: number }
    const shellView =
      mainWindow.view ?? views.find((v) => v.surface === 'Shell')?.view ?? views[0].view
    const shellWindow = () => {
      // one host call: show + focus + openHomeTab
      log.push(['revealHome'])
      return hosts.revealHome === false
        ? null
        : { isDestroyed: () => false, webContents: electron.contents(shellView) }
    }
    ipcMain.handle('slides:open-font-settings', () => {
      const win = shellWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send('home:open-settings', { section: 'general', field: 'slidesAiFonts' })
    })

    // apps/slides/src/main/template-fonts.ts:13-36 (the module itself imports
    // the slides font registry, whose harfbuzz wasm does not load here)
    const templateFontFolder = (): string =>
      templateFontsDir({
        isPackaged: app.isPackaged as boolean,
        getAppPath: () => (app.getAppPath as () => string)(),
        resourcesPath: (process as unknown as { resourcesPath: string }).resourcesPath,
      })
    ipcMain.handle('slides:open-template-fonts-folder', async (): Promise<boolean> => {
      try {
        return (
          (await (electron.shell as { openPath(p: string): Promise<string> }).openPath(
            templateFontFolder(),
          )) === ''
        )
      } catch {
        return false
      }
    })
  },
  cases: [],
  single: {},
}

const file = (settings: unknown) => ({ 'userData/app-settings.json': JSON.stringify(settings) })
const call = (channel: string, view: number, ...args: unknown[]) => ({ channel, view, args })
const shell = (channel: string, ...args: unknown[]) => call(channel, 1, ...args)
const withViews = (c: Case): Case => ({ views: VIEWS, ...c })

group.cases = (
  [
    // ---- language ----
    {
      note: 'no settings: language and document locale from the system locale',
      calls: [
        shell('home:get-language'),
        call('app:get-language', 3),
        call('app:get-document-locale', 3),
      ],
    },
    {
      note: 'stored ko',
      files: file({ language: 'ko' }),
      hosts: { m: { appLocale: 'en-US' } },
      calls: [shell('home:get-language'), call('app:get-document-locale', 4)],
    },
    {
      note: 'Korean system locale, nothing stored',
      hosts: { m: { appLocale: 'ko-KR' } },
      calls: [shell('home:get-language'), call('app:get-document-locale', 3)],
    },
    {
      note: 'Traditional Chinese locale',
      hosts: { m: { appLocale: 'zh_HK' } },
      calls: [shell('home:get-language'), call('app:get-document-locale', 3)],
    },
    {
      note: 'Japanese locale: a document locale the UI language does not have',
      hosts: { m: { appLocale: 'ja-JP' } },
      calls: [shell('home:get-language'), call('app:get-document-locale', 3)],
    },
    {
      note: 'SEUOFFICE_LANG wins over the stored setting',
      files: file({ language: 'en' }),
      hosts: { m: { envLang: 'ko-KR' } },
      calls: [shell('home:get-language'), call('app:get-document-locale', 3)],
    },
    {
      note: 'stored value that is not a language falls back to the locale',
      files: file({ language: 'fr' }),
      hosts: { m: { appLocale: 'ko' } },
      calls: [shell('home:get-language'), call('app:get-document-locale', 3)],
    },
    withViews({
      note: 'set-language: menus, tray, quick-look and every view hear it; the locale follows',
      files: file({ theme: 'dark' }),
      calls: [
        shell('home:set-language', 'ko'),
        shell('home:get-language'),
        call('app:get-language', 3),
        call('app:get-document-locale', 3),
        shell('home:set-language', 'ko'),
        shell('home:set-language', 'en'),
        call('app:get-document-locale', 4),
      ],
    }),
    withViews({
      note: 'set-language refusals: not a language, not a string, unchanged, undefined',
      files: file({ language: 'ko' }),
      calls: [
        shell('home:set-language', 'fr'),
        shell('home:set-language', 'KO'),
        shell('home:set-language', 5),
        shell('home:set-language', { $: 'u' }),
        shell('home:set-language', 'ko'),
        shell('home:get-language'),
      ],
    }),
    withViews({
      note: 'set-language with a folder that cannot be written: rejects, language stays',
      calls: [shell('home:set-language', 'ko'), shell('home:get-language')],
    }),
    // ---- theme ----
    withViews({
      note: 'theme: defaults',
      calls: [shell('home:get-theme'), call('app:get-theme', 3), shell('home:get-document-theme')],
    }),
    withViews({
      note: 'theme: stored dark / odd value / doc theme stored',
      files: file({ theme: 'dark', documentTheme: 'light' }),
      calls: [shell('home:get-theme'), call('app:get-theme', 4), call('app:get-document-theme', 3)],
    }),
    withViews({
      note: 'theme: a stored value that is not a theme',
      files: file({ theme: 'blue', documentTheme: 'system' }),
      calls: [shell('home:get-theme'), call('app:get-document-theme', 4)],
    }),
    withViews({
      note: 'set-theme: native theme, title bar, tray, quick-look, every view; then unchanged and refused values',
      files: file({ language: 'ko' }),
      calls: [
        shell('home:set-theme', 'dark'),
        shell('home:get-theme'),
        shell('home:set-theme', 'dark'),
        shell('home:set-theme', 'purple'),
        shell('home:set-theme', 7),
        shell('home:set-theme', 'light'),
        call('app:get-theme', 3),
        shell('home:set-theme', 'system'),
      ],
    }),
    withViews({
      note: 'set-theme on an unwritable folder: the cache moved before the write',
      calls: [shell('home:set-theme', 'dark'), shell('home:get-theme')],
    }),
    withViews({
      note: 'set-document-theme: only the views hear it; the quick-look window does not need to',
      files: file({ theme: 'dark' }),
      calls: [
        shell('home:set-document-theme', 'dark'),
        call('app:get-document-theme', 3),
        shell('home:set-document-theme', 'dark'),
        shell('home:set-document-theme', 'sepia'),
        shell('home:set-document-theme', 'follow'),
        shell('home:set-document-theme', 'light'),
        shell('home:get-document-theme'),
      ],
    }),
    withViews({
      note: 'set-document-theme on an unwritable folder',
      calls: [shell('home:set-document-theme', 'light'), shell('home:get-document-theme')],
    }),
    // ---- author name ----
    withViews({
      note: 'author name: nothing stored, the account name is the fallback',
      calls: [
        shell('home:get-author-name'),
        call('app:get-author-name', 3),
        call('home:get-author-name', 1),
      ],
    }),
    withViews({
      note: 'author name: stored, with blanks collapsed',
      files: file({ authorName: '  Alice   Smith ' }),
      calls: [shell('home:get-author-name'), call('app:get-author-name', 3)],
    }),
    withViews({
      note: 'author name: no account name at all',
      files: file({ authorName: 7 }),
      hosts: { m: { username: null } },
      calls: [shell('home:get-author-name'), call('app:get-author-name', 3)],
    }),
    withViews({
      note: 'author name: a blank account name',
      hosts: { m: { username: '   ' } },
      calls: [shell('home:get-author-name'), call('app:get-author-name', 3)],
    }),
    withViews({
      note: 'set-author-name: changes, unchanged, cleared, not a string, long',
      files: file({ language: 'en' }),
      hosts: { m: { username: 'carol' } },
      calls: [
        shell('home:set-author-name', ' Bob   Jones '),
        shell('home:set-author-name', 'Bob Jones'),
        shell('home:set-author-name', ''),
        shell('home:set-author-name', 'Dan'),
        shell('home:set-author-name', 12),
        shell('home:set-author-name', 'x'.repeat(130)),
        shell('home:set-author-name', { $: 'u' }),
        call('app:get-author-name', 3),
      ],
    }),
    withViews({
      note: 'set-author-name cutting a surrogate pair at 120 units (Rust text cannot hold the lone surrogate)',
      files: file({ language: 'en' }),
      calls: [shell('home:set-author-name', `${'y'.repeat(119)}😀tail`)],
    }),
    withViews({
      note: 'set-author-name on an unwritable folder: rejects, nobody hears it',
      calls: [shell('home:set-author-name', 'Eve'), shell('home:get-author-name')],
    }),
    withViews({
      note: 'user:display-name from a sender that is no sheets tab',
      files: file({ authorName: 'Zed' }),
      calls: [call('user:display-name', 4)],
    }),
    // ---- auto-save and CSV ----
    {
      note: 'auto-save default: unset',
      calls: [call('app:get-auto-save-default', 3)],
    },
    {
      note: 'auto-save default: on with a time',
      files: file({ autoSaveDefault: true, autoSaveDefaultUpdatedAt: 1234 }),
      calls: [call('app:get-auto-save-default', 3)],
    },
    {
      note: 'auto-save default: off, odd time',
      files: file({ autoSaveDefault: 'yes', autoSaveDefaultUpdatedAt: -5 }),
      calls: [call('app:get-auto-save-default', 3)],
    },
    {
      note: 'csv limit: default, a choice, a number that is no choice, a string',
      files: file({ csvImportLimitMb: 128 }),
      calls: [call('app:get-csv-import-limit', 4)],
    },
    {
      note: 'csv limit: unset',
      calls: [call('app:get-csv-import-limit', 4)],
    },
    {
      note: 'csv limit: not an offered step',
      files: file({ csvImportLimitMb: 100 }),
      calls: [call('app:get-csv-import-limit', 4)],
    },
    {
      note: 'csv limit: a string',
      files: file({ csvImportLimitMb: '64' }),
      calls: [call('app:get-csv-import-limit', 4)],
    },
    // ---- system locale ----
    {
      note: 'system locale',
      hosts: { m: { systemLocale: 'ko-KR' } },
      calls: [call('docs:system-locale', 3)],
    },
    {
      note: 'system locale default',
      calls: [call('docs:system-locale', 3)],
    },
    // ---- slides entries ----
    withViews({
      note: 'open-font-settings reveals home and asks it for the setting',
      calls: [call('slides:open-font-settings', 5)],
    }),
    withViews({
      note: 'open-font-settings with no shell window',
      hosts: { m: { revealHome: false } },
      calls: [call('slides:open-font-settings', 5)],
    }),
    withViews({
      note: 'open-font-settings: the main window is the second view',
      views: [
        { view: 1, window: 1, surface: 'Slides' },
        { view: 2, window: 2, surface: 'Shell' },
        { view: 3, window: 3, surface: 'Shell' },
      ],
      hosts: { shared: { mainWindow: { view: 3, window: 3 } } },
      calls: [{ channel: 'slides:open-font-settings', view: 1, args: [] }],
    }),
    {
      note: 'template fonts folder: development tree, opened',
      views: [{ view: 1, window: 1, surface: 'Slides' }],
      calls: [{ channel: 'slides:open-template-fonts-folder', args: [] }],
    },
    {
      note: 'template fonts folder: packaged, the OS cannot open it',
      views: [{ view: 1, window: 1, surface: 'Slides' }],
      hosts: {
        m: { isPackaged: true, resourcesPath: '/Applications/Seu/Resources' },
        shared: { osShell: { openPath: 'no such folder' } },
      },
      calls: [{ channel: 'slides:open-template-fonts-folder', args: [] }],
    },
  ] as Case[]
).map((c) => ({ views: VIEWS, ...c }))

group.single = {
  'slides:open-font-settings':
    'takes no argument; its answer is undefined and the event is the substance',
}
