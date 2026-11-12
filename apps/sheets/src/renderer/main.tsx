import ReactDOM from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@seuoffice/i18n'
import { applyAiPanelPrefs, installScreenTips } from '@seuoffice/ui'

import '@seuoffice/ui/tokens.css'
import '@seuoffice/ui/screentip.css'
import '@seuoffice/ui/ai-model-picker.css'
import '@seuoffice/ui/ai-queue-strip.css'
import '@seuoffice/ui/ai-usage.css'
import '@seuoffice/ui/color-picker.css'
import '@seuoffice/ui/dropdown.css'
import '@seuoffice/ui/ribbon-collapse.css'
import '@seuoffice/ui/markdown.css'
import '@seuoffice/ui/ai-panel-prefs.css'
import '@seuoffice/ui/ai-scope-quote.css'
import '@univerjs/preset-sheets-core/lib/index.css'

import { App } from './App'
import {
  installCanvasFontFallback,
  registerTextDingbatsFace,
  untilCellFontsLoaded,
} from './cell-font-fallback'
import { setDocumentLocale } from './document-locale'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import { registerTemplateFonts } from './template-fonts'
import type { DocTheme, UiTheme } from '../shared/desktop-api'
import './styles.css'

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const replacesUniverRuntime = updates.some(
      ({ path }) => path.endsWith('/App.tsx') || path.endsWith('/univer-sync.ts'),
    )
    if (replacesUniverRuntime) window.location.reload()
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root.')

installScreenTips()
installCanvasFontFallback()
// URL-backed faces: no file is read until text first uses its family
registerTemplateFonts()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function applyDocumentTheme(theme: DocTheme): void {
  // data-doc-theme drives the canvas/paper (genoffice#1811); absent means 'follow' the UI theme
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme')
  else document.documentElement.setAttribute('data-doc-theme', theme)
}

// Canvas fillText never triggers @font-face downloads, so the bundled Carlito
// faces (Calibri/Aptos aliases in styles.css) must be loaded before Univer's
// first skeleton — MDW, wrap points, and #### overflow all measure with them.
// The Office-font aliases load with each workbook (openLazyWorkbook).
async function loadCellFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [registerTextDingbatsFace()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
    for (const family of ['Calibri', 'Aptos', "'Aptos Narrow'", 'Carlito']) {
      loads.push(document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? [])
    }
  }
  await untilCellFontsLoaded(Promise.all(loads))
}

async function bootstrap(): Promise<void> {
  let lang: Lang = 'en'
  let theme: UiTheme = 'system'
  let docTheme: DocTheme = 'follow'
  let documentLocale: string | undefined
  try {
    // per-promise catch: standalone runs have no app:get-theme handler, and
    // that rejection must not drop a resolved language
    ;[lang, theme, docTheme, documentLocale] = await Promise.all([
      window.desktopApi.getLanguage().catch(() => 'en' as const),
      window.desktopApi.getTheme().catch(() => 'system' as const),
      window.desktopApi.getDocumentTheme?.().catch(() => 'follow' as const),
      window.desktopApi.getDocumentLocale().catch(() => undefined),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  // without an answer, documents are read for the UI language
  setDocumentLocale(documentLocale ?? lang)
  // Registered before anything renders, so it runs ahead of every later
  // listener of the same event: a language chosen in Settings is the language
  // documents are read for from then on, and those listeners redraw with it.
  window.desktopApi?.onLanguageChanged(setDocumentLocale)
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  applyDocumentTheme(docTheme ?? 'follow')
  await loadCellFonts()
  // A spare view can receive a file while its renderer is still booting.
  // Check the queued path before the first React paint so it never looks Ready.
  const queuedWorkbookAtBoot = await window.desktopApi?.hasQueuedWorkbook?.().catch(() => false)
  window.desktopApi?.onThemeChanged(applyTheme)
  window.desktopApi?.onDocumentThemeChanged?.(applyDocumentTheme)
  await window.desktopApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.desktopApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  ReactDOM.createRoot(root!).render(
    <LocaleProvider initial={lang}>
      <App queuedWorkbookAtBoot={queuedWorkbookAtBoot === true} />
    </LocaleProvider>,
  )
}

void bootstrap()
