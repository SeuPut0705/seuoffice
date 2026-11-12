import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang } from '@seuoffice/i18n'
import '@seuoffice/ui/tokens.css'
import './quick-look.css'
import './globals'
import { QuickLookWindow } from './QuickLookWindow'
import type { QuickLookTheme } from '../../../shared/quick-look-api'

function applyTheme(theme: QuickLookTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

const api = window.aiOfficeQuickLook
if (api) {
  void api.getInit().then(({ lang, theme, payload }) => {
    applyTheme(theme)
    api.onThemeChanged(applyTheme)
    document.documentElement.lang = htmlLang(lang)
    document.documentElement.dir = htmlDir(lang)
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <QuickLookWindow initialLang={lang} initialPayload={payload} />
      </React.StrictMode>,
    )
  })
}
