/**
 * Group `a/shell-ai-prefs`: the AI channels `apps/shell/src/main/index.ts`
 * answers itself: the AI panel preferences every window shares, the slides
 * AI fonts and opening Settings at the AI model page.
 *
 * The shell entry starts the whole app when it is imported, so it is not
 * loaded. Its statements that answer these channels are taken from its source
 * with the TypeScript parser (each must be found exactly once), stripped of
 * types, and run over the names they use: the fake Electron, the same helpers
 * the entry imports, and the shell window and tab manager as one host line
 * (`shellWindow.showHomeTab`, as the Rust fake logs it).
 */
import { join } from 'node:path'
import {
  readAppSettings,
  writeAppSetting,
  writeAppSettings,
} from '../../../../apps/shell/src/main/app-settings.ts'
import { HOME_CHANNELS } from '../../../../apps/shell/src/shared/home-api.ts'
import {
  normalizeAiPanelPrefs,
  sameAiPanelPrefs,
} from '../../../../packages/ui/src/ai-panel-prefs.ts'
import {
  normalizeSlidesAiFonts,
  SLIDES_AI_FONTS_KEY,
} from '../../../../packages/ui/src/slides-ai-fonts.ts'
import type { Call, Case, Group, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

/** The entry's statements that answer the group's channels, in its order */
const entryCode = entryStatements('apps/shell/src/main/index.ts', [
  'let cachedAiPanelPrefs',
  'function currentAiPanelPrefs(',
  'ipcMain.handle(HOME_CHANNELS.getAiPanelPrefs,',
  "ipcMain.handle('app:get-ai-panel-prefs',",
  'const setAiPanelPrefs =',
  'ipcMain.handle(HOME_CHANNELS.setAiPanelPrefs,',
  "ipcMain.handle('app:set-ai-panel-prefs',",
  'ipcMain.handle(HOME_CHANNELS.getSlidesAiFonts,',
  'ipcMain.handle(HOME_CHANNELS.setSlidesAiFonts,',
  "ipcMain.handle('ai:open-model-settings',",
])

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
]
const docs = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
const undef = { $: 'u' }
const settings = (value: unknown) => ({ 'userData/app-settings.json': JSON.stringify(value) })
const folder = { userData: { dir: true as const } }

const cases: Case[] = [
  {
    note: 'no settings file: the defaults, from both channel names',
    views,
    calls: [docs('app:get-ai-panel-prefs'), shell('home:get-ai-panel-prefs')],
  },
  {
    note: 'stored values are normalized: a bad size, a tiny custom size, a non-boolean',
    views,
    files: settings({
      aiPanelSide: 'right',
      aiPanelFontSize: 'huge',
      aiPanelCustomFontSize: 3,
      aiPanelSpellcheck: 'no',
      aiPanelShowSidebar: false,
    }),
    calls: [docs('app:get-ai-panel-prefs')],
  },
  {
    note: 'a patch is merged, clamped, written and sent to every view',
    views,
    files: settings({ lang: 'ko' }),
    calls: [
      shell('home:set-ai-panel-prefs', {
        side: 'right',
        fontSize: 'custom',
        customFontSize: '99.4',
        spellcheck: false,
      }),
      docs('app:get-ai-panel-prefs'),
    ],
  },
  {
    note: 'an unchanged patch writes and sends nothing',
    views,
    files: folder,
    calls: [docs('app:set-ai-panel-prefs', { side: 'left' })],
  },
  {
    note: 'a key sent as undefined falls back to the default; a bad side keeps the old one',
    views,
    files: settings({ aiPanelSide: 'right', aiPanelSpellcheck: false }),
    calls: [
      docs('app:set-ai-panel-prefs', { side: 'up', spellcheck: undef, openInNewDocs: false }),
    ],
  },
  {
    note: 'null, a string and no argument are no patch at all',
    views,
    files: settings({ aiPanelSide: 'right' }),
    calls: [
      docs('app:set-ai-panel-prefs', null),
      docs('app:set-ai-panel-prefs', 'x'),
      shell('home:set-ai-panel-prefs'),
    ],
  },
  {
    note: 'the folder is missing: the write fails after the cache took the value',
    views,
    calls: [docs('app:set-ai-panel-prefs', { fontSize: 'large' }), docs('app:get-ai-panel-prefs')],
  },
  {
    note: 'slides AI fonts: the default of the document language, then a stored value',
    views,
    hosts: { a: { documentLocale: 'ja' } },
    files: folder,
    calls: [
      shell('home:get-slides-ai-fonts'),
      shell('home:set-slides-ai-fonts', { mode: 'serif', sans: '  Arial"  ', serif: 7 }),
      shell('home:get-slides-ai-fonts'),
    ],
  },
  {
    note: 'slides AI fonts in Korean from a hand-edited file',
    views,
    files: settings({ slidesAiFonts: { mode: 'odd', serif: 'Batang' } }),
    calls: [shell('home:get-slides-ai-fonts'), shell('home:set-slides-ai-fonts', 'nope')],
  },
  {
    note: 'slides AI fonts cannot be written without the folder',
    views,
    calls: [shell('home:set-slides-ai-fonts', { mode: 'sans' })],
  },
  {
    note: 'model settings open on the shell window',
    views,
    calls: [docs('ai:open-model-settings')],
  },
  {
    note: 'model settings with no shell window do nothing',
    views: [{ view: 2, window: 2, surface: 'Docs' }],
    calls: [docs('ai:open-model-settings')],
  },
  {
    note: 'the shell view may not ask for the model settings page',
    views,
    calls: [shell('ai:open-model-settings')],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const caseViews = cx.case.views ?? [{ view: 1, surface: 'Shell' }]
    const shellView = caseViews.find((v) => (v.surface ?? 'Shell') === 'Shell')
    const hostsA = (cx.case.hosts?.a ?? {}) as { documentLocale?: string }
    runWith(entryCode, {
      ipcMain: cx.electron.ipcMain,
      webContents: cx.electron.webContents,
      HOME_CHANNELS,
      APP_SETTINGS_PATH: () => join(cx.dir, 'userData', 'app-settings.json'),
      readAppSettings,
      writeAppSettings,
      writeAppSetting,
      normalizeAiPanelPrefs,
      sameAiPanelPrefs,
      normalizeSlidesAiFonts,
      SLIDES_AI_FONTS_KEY,
      currentDocumentLocale: () => hostsA.documentLocale ?? 'ko',
      shellWindow: shellView && {
        isDestroyed: () => false,
        isMinimized: () => false,
        restore() {},
        show() {},
        focus() {},
        webContents: cx.electron.contents(shellView.view),
      },
      tabManager: { openHomeTab: () => cx.electron.log.push(['shellWindow.showHomeTab']) },
    })
  },
  cases,
}
