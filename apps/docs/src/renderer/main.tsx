import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@seuoffice/i18n'
import { App } from './App'
import { setAuthorName } from './author-name'
import { setDocumentLocale } from './document-locale'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { DocTheme, UiTheme } from '../shared/ipc'
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
import '@seuoffice/ui/image-viewer.css'
import './styles.css'
import './fonts/fonts.css'
import { applyAiPanelPrefs, installScreenTips } from '@seuoffice/ui'
import { setAltChunkHtmlConverter } from '@seuoffice/docx-engine'
import { registerTemplateFonts } from './template-fonts'

installScreenTips()
// before any layout: the editor, print and PDF export (also headless) all draw in this page
registerTemplateFonts()
if (window.desktop?.convertAltChunkHtml) {
  setAltChunkHtmlConverter((html) => window.desktop.convertAltChunkHtml(html))
}

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function applyDocumentTheme(theme: DocTheme): void {
  // data-doc-theme drives the canvas/paper (genoffice#1811); absent means 'follow' the UI theme
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme')
  else document.documentElement.setAttribute('data-doc-theme', theme)
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
      window.desktop.getLanguage().catch(() => 'en' as const),
      window.desktop.getTheme().catch(() => 'system' as const),
      window.desktop.getDocumentTheme?.().catch(() => 'follow' as const),
      window.desktop.getDocumentLocale?.().catch(() => undefined),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  // without an answer, documents are read for the UI language
  setDocumentLocale(documentLocale ?? lang)
  // a language chosen in Settings is the language documents are read for from then on
  window.desktop?.onLanguageChanged(setDocumentLocale)
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  applyDocumentTheme(docTheme ?? 'follow')
  window.desktop?.onThemeChanged(applyTheme)
  window.desktop?.onDocumentThemeChanged?.(applyDocumentTheme)
  await window.desktop
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.desktop?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  await window.desktop
    ?.getAuthorName?.()
    .then(setAuthorName)
    .catch(() => {})
  window.desktop?.onAuthorNameChanged?.(setAuthorName)
  const root = createRoot(document.getElementById('root')!)
  flushSync(() =>
    root.render(
      <LocaleProvider initial={lang}>
        <App />
      </LocaleProvider>,
    ),
  )
}

void bootstrap()
