import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@seuoffice/i18n'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { DocTheme, UiTheme } from '../shared/ipc'
import '@seuoffice/ui/tokens.css'
import '@seuoffice/ui/screentip.css'
import '@seuoffice/ui/ai-model-picker.css'
import '@seuoffice/ui/ai-queue-strip.css'
import '@seuoffice/ui/ai-usage.css'
import '@seuoffice/ui/dropdown.css'
import '@seuoffice/ui/find-panel.css'
import '@seuoffice/ui/ribbon-collapse.css'
import '@seuoffice/ui/markdown.css'
import '@seuoffice/ui/ai-panel-prefs.css'
import '@seuoffice/ui/ai-scope-quote.css'
import '@seuoffice/ui/image-viewer.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import './markdown-themes.css'
import { applyAiPanelPrefs, installScreenTips } from '@seuoffice/ui'
import type { MarkdownTheme } from '../shared/markdown-theme'
import { applyEditorFont, storedEditorFont } from './editor-font'

installScreenTips()
applyEditorFont(storedEditorFont())

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function applyMarkdownTheme(theme: MarkdownTheme): void {
  // a picked paper theme overrides the light/dark document theme for the paper
  if (theme === 'default') document.documentElement.removeAttribute('data-markdown-theme')
  else document.documentElement.setAttribute('data-markdown-theme', theme)
}

function applyDocumentTheme(theme: DocTheme): void {
  // data-doc-theme drives the preview paper (genoffice#1811); absent means 'follow' the UI theme
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme')
  else document.documentElement.setAttribute('data-doc-theme', theme)
}

void (async () => {
  const [lang, theme, docTheme, mdTheme] = await Promise.all([
    window.markdownApi.getLanguage().catch(() => 'en' as const),
    window.markdownApi.getTheme().catch(() => 'system' as const),
    window.markdownApi.getDocumentTheme?.().catch(() => 'follow' as const),
    window.markdownApi.getMarkdownTheme?.().catch(() => 'default' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  applyDocumentTheme(docTheme ?? 'follow')
  applyMarkdownTheme(mdTheme)
  window.markdownApi.onThemeChanged(applyTheme)
  window.markdownApi.onDocumentThemeChanged?.(applyDocumentTheme)
  await window.markdownApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.markdownApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
