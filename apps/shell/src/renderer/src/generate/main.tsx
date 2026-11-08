import React from 'react'
import { createRoot } from 'react-dom/client'
import '@genoffice/ui/tokens.css'
import './generate.css'
import { GenerateWindow } from './GenerateWindow'

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

const api = window.aiOfficeGenerateWindow
// the theme lands before first paint so the window never flashes the other one
void api.getTheme().then((theme) => {
  applyTheme(theme)
  api.onThemeChanged(applyTheme)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <GenerateWindow />
    </React.StrictMode>,
  )
})
