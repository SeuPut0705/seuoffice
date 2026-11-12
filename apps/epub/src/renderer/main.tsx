import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@seuoffice/i18n'
import { installScreenTips } from '@seuoffice/ui'
import '@seuoffice/ui/tokens.css'
import '@seuoffice/ui/screentip.css'
import '@seuoffice/ui/dropdown.css'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import './styles.css'

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.epubApi.getLanguage().catch(() => 'en' as const),
    window.epubApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  window.epubApi.onThemeChanged(applyTheme)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
