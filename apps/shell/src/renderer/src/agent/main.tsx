import React from 'react'
import { createRoot } from 'react-dom/client'
import '@genoffice/ui/tokens.css'
import './agent.css'
import { AgentWindow } from './AgentWindow'

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

const api = window.aiOfficeAgentWindow
// the theme lands before first paint so the window never flashes the other one
void api.getTheme().then((theme) => {
  applyTheme(theme)
  api.onThemeChanged(applyTheme)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AgentWindow />
    </React.StrictMode>,
  )
})
