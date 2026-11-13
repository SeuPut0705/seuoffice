import './engine-init'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@seuoffice/i18n'
import { App } from './App'
import { AudienceView } from './components/AudienceView'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
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
import './styles.css'
import { applyAiPanelPrefs, installScreenTips } from '@seuoffice/ui'

installScreenTips()

// Canvas fillText never triggers @font-face downloads, so the bundled document fonts
// (Carlito ↔ Calibri) must be loaded explicitly or Konva silently draws the fallback face.
for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
  document.fonts?.load?.(`${variant}16px Carlito`).catch(() => {})
  document.fonts?.load?.(`${variant}16px 'SeuOffice Sans GO'`).catch(() => {})
}

// ?mode=audience: the presenter view's external-screen audience show window (created by the main process)
const mode = new URLSearchParams(window.location.search).get('mode')

// macOS windows are created with vibrancy; let the thumbnail pane show it
// (the audience show window stays fully opaque)
if (mode !== 'audience' && navigator.platform.toLowerCase().includes('mac'))
  document.body.classList.add('vib')

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

async function bootstrap(): Promise<void> {
  let lang: Lang = 'en'
  let theme: UiTheme = 'system'
  try {
    // per-promise catch: standalone runs have no app:get-theme handler, and
    // that rejection must not drop a resolved language
    ;[lang, theme] = await Promise.all([
      window.slidesApi.getLanguage().catch(() => 'en' as const),
      window.slidesApi.getTheme().catch(() => 'system' as const),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  // the audience show window renders slide content only — it never themes
  if (mode !== 'audience') {
    applyTheme(theme)
    window.slidesApi?.onThemeChanged(applyTheme)
    await window.slidesApi
      ?.getAiPanelPrefs?.()
      .then(applyAiPanelPrefs)
      .catch(() => {})
    window.slidesApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        {mode === 'audience' ? <AudienceView /> : <App />}
      </LocaleProvider>
    </React.StrictMode>,
  )
}

void bootstrap()
