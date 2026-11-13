/**
 * Group `a/shell-ai-prefs`: the AI channels `apps/shell/src/main/index.ts`
 * answers itself: the AI panel preferences every window shares, the slides
 * AI fonts and opening Settings at the AI model page.
 *
 * The shell entry starts the whole app when it is imported, so it cannot be
 * loaded on the fake Electron. These handlers are its handler bodies as they
 * stand there (`currentAiPanelPrefs` near line 1167, `setAiPanelPrefs` and its
 * two channels near 3772, the slides AI fonts near 4025,
 * `ai:open-model-settings` near 6509), over the same helpers the entry
 * imports. `tabManager.openHomeTab()` with the shell window brought forward is
 * one host line, `shellWindow.showHomeTab`, as in the Rust fake.
 */
import { join } from 'node:path'
import {
  readAppSettings,
  writeAppSetting,
  writeAppSettings,
} from '../../../../apps/shell/src/main/app-settings.ts'
import {
  normalizeAiPanelPrefs,
  sameAiPanelPrefs,
  type AiPanelPrefs,
} from '../../../../packages/ui/src/ai-panel-prefs.ts'
import {
  normalizeSlidesAiFonts,
  SLIDES_AI_FONTS_KEY,
} from '../../../../packages/ui/src/slides-ai-fonts.ts'
import type { Call, Case, Group, View } from '../../types.ts'

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
]
const docs = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
const undef = { $: 'u' }
const settings = (value: unknown) => ({ 'userData/app-settings.json': JSON.stringify(value) })
const folder = { userData: { dir: true } }

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
    calls: [docs('app:set-ai-panel-prefs', { side: 'up', spellcheck: undef, openInNewDocs: false })],
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
    calls: [
      docs('app:set-ai-panel-prefs', { fontSize: 'large' }),
      docs('app:get-ai-panel-prefs'),
    ],
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
    const handle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      cx.electron.handlers.invoke.set(channel, fn)
    const caseViews = cx.case.views ?? [{ view: 1, surface: 'Shell' }]
    const APP_SETTINGS_PATH = () => join(cx.dir, 'userData', 'app-settings.json')
    const hostsA = (cx.case.hosts?.a ?? {}) as { documentLocale?: string }
    const currentDocumentLocale = () => hostsA.documentLocale ?? 'ko'
    const shellView = caseViews.find(
      (v) => (v.surface ?? 'Shell') === 'Shell',
    )

    let cachedAiPanelPrefs: AiPanelPrefs | null = null
    function currentAiPanelPrefs(): AiPanelPrefs {
      if (cachedAiPanelPrefs) return cachedAiPanelPrefs
      const saved = readAppSettings(APP_SETTINGS_PATH())
      cachedAiPanelPrefs = normalizeAiPanelPrefs({
        side: saved.aiPanelSide,
        fontSize: saved.aiPanelFontSize,
        customFontSize: saved.aiPanelCustomFontSize,
        spellcheck: saved.aiPanelSpellcheck,
        openInNewDocs: saved.aiPanelOpenInNewDocs,
        showAiSidebar: saved.aiPanelShowSidebar,
      })
      return cachedAiPanelPrefs
    }

    handle('home:get-ai-panel-prefs', (): AiPanelPrefs => currentAiPanelPrefs())
    handle('app:get-ai-panel-prefs', (): AiPanelPrefs => currentAiPanelPrefs())

    const setAiPanelPrefs = (patch: unknown): AiPanelPrefs => {
      const prev = currentAiPanelPrefs()
      const raw =
        patch !== null && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
      const next = normalizeAiPanelPrefs({
        side: raw.side === 'left' || raw.side === 'right' ? raw.side : prev.side,
        fontSize: 'fontSize' in raw ? raw.fontSize : prev.fontSize,
        customFontSize: 'customFontSize' in raw ? raw.customFontSize : prev.customFontSize,
        spellcheck: 'spellcheck' in raw ? raw.spellcheck : prev.spellcheck,
        openInNewDocs: 'openInNewDocs' in raw ? raw.openInNewDocs : prev.openInNewDocs,
        showAiSidebar: 'showAiSidebar' in raw ? raw.showAiSidebar : prev.showAiSidebar,
      })
      if (sameAiPanelPrefs(next, prev)) return prev
      cachedAiPanelPrefs = next
      writeAppSettings(APP_SETTINGS_PATH(), {
        aiPanelSide: next.side,
        aiPanelFontSize: next.fontSize,
        aiPanelCustomFontSize: next.customFontSize,
        aiPanelSpellcheck: next.spellcheck,
        aiPanelOpenInNewDocs: next.openInNewDocs,
        aiPanelShowSidebar: next.showAiSidebar,
      })
      for (const v of caseViews) cx.electron.contents(v.view).send('app:ai-panel-prefs-changed', next)
      return next
    }
    handle('home:set-ai-panel-prefs', (_event: unknown, patch: unknown) =>
      setAiPanelPrefs(patch),
    )
    handle('app:set-ai-panel-prefs', (_event: unknown, patch: unknown) =>
      setAiPanelPrefs(patch),
    )

    handle('home:get-slides-ai-fonts', () =>
      normalizeSlidesAiFonts(
        readAppSettings(APP_SETTINGS_PATH())[SLIDES_AI_FONTS_KEY],
        currentDocumentLocale(),
      ),
    )
    handle('home:set-slides-ai-fonts', (_event: unknown, fonts: unknown) => {
      const next = normalizeSlidesAiFonts(fonts, currentDocumentLocale())
      writeAppSetting(APP_SETTINGS_PATH(), SLIDES_AI_FONTS_KEY, next)
      return next
    })

    handle('ai:open-model-settings', () => {
      if (!shellView) return
      cx.electron.log.push(['shellWindow.showHomeTab'])
      cx.electron.contents(shellView.view).send('home:open-settings', { section: 'aiModel' })
    })
  },
  cases,
}
