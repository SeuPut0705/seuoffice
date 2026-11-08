import { useEffect, useState } from 'react'
import {
  DEFAULT_QUICK_LOOK_SETTINGS,
  type QuickLookHomeApi,
  type QuickLookSettings,
} from '../../shared/quick-look-home'
import { quickLookText } from './i18n/strings-quick-look'
import { useI18n } from './locale'

declare global {
  interface Window {
    aiOfficeQuickLookHome?: QuickLookHomeApi
  }
}

function isWindowsUserAgent(): boolean {
  if (typeof navigator === 'undefined') return true
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform)
}

export function QuickLookField() {
  const { lang } = useI18n()
  const [settings, setSettings] = useState<QuickLookSettings>(DEFAULT_QUICK_LOOK_SETTINGS)
  const isWindows = isWindowsUserAgent()

  useEffect(() => {
    let alive = true
    void window.aiOfficeQuickLookHome
      ?.getSettings()
      .then((s) => {
        if (alive && s) setSettings(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const update = (patch: Partial<QuickLookSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    void window.aiOfficeQuickLookHome
      ?.setSettings(patch)
      .then((next) => {
        if (next) setSettings(next)
      })
      .catch(() => undefined)
  }

  return (
    <>
      <div className="set-field" data-testid="quick-look-in-app">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{quickLookText(lang, 'setQuickLookTitle')}</div>
            <div className="set-field-desc">{quickLookText(lang, 'setQuickLookHint')}</div>
          </div>
        </div>
      </div>
      {isWindows && (
        <>
          <div className="set-field" data-testid="quick-look-explorer">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{quickLookText(lang, 'setExplorerSpace')}</div>
                <div className="set-field-desc">{quickLookText(lang, 'setExplorerSpaceDesc')}</div>
              </div>
            </div>
            <button
              className="set-switch"
              role="switch"
              aria-checked={settings.explorerSpacePreview}
              aria-label={quickLookText(lang, 'setExplorerSpace')}
              onClick={() => update({ explorerSpacePreview: !settings.explorerSpacePreview })}
            />
          </div>
          <div className="set-field" data-testid="quick-look-tray">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{quickLookText(lang, 'setKeepInTray')}</div>
                <div className="set-field-desc">{quickLookText(lang, 'setKeepInTrayDesc')}</div>
              </div>
            </div>
            <button
              className="set-switch"
              role="switch"
              disabled={!settings.explorerSpacePreview}
              aria-checked={settings.keepInTray}
              aria-label={quickLookText(lang, 'setKeepInTray')}
              onClick={() => update({ keepInTray: !settings.keepInTray })}
            />
          </div>
        </>
      )}
    </>
  )
}
