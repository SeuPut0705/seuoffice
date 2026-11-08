import { useEffect, useState } from 'react'
import { AiMark } from '@genoffice/ui'
import { FREE_AI_PROVIDERS, freeAiConnected } from '@genoffice/ai-provider/browser'
import type { AiSettings, FreeAiProviderId, FreeAiQuota } from '@genoffice/ai-provider/browser'
import type { TFunc } from './locale'
import { FREE_AI_IDLE, FREE_AI_PROVIDER_NAMES, freeAiCardView } from './free-ai-cards'
import type { FreeAiAttempt, FreeAiCardAction } from './free-ai-cards'
import { changeAiSettings, readAiSettings } from './settings-ai'
import './free-ai.css'

// ── free connections: OpenRouter and Gemini, for people without a subscription ──
// Settings and the first-run guide show the same cards. Connecting is the
// user's choice of that provider, so a made connection becomes the AI in use;
// the main process stores it (the OpenRouter key never reaches this window).

const ACTION_LABELS: Record<Exclude<FreeAiCardAction, 'cancel'>, Parameters<TFunc>[0]> = {
  'connect-browser': 'freeConnectBrowser',
  'get-key': 'freeGetKey',
  use: 'freeUse',
  disconnect: 'freeDisconnect',
}

/** the settings file, re-read whenever any window writes it */
export function useAiSettings(): AiSettings | null {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      void readAiSettings().then((next) => {
        if (alive && next) setSettings(next)
      })
    }
    load()
    const off = window.aiOffice?.onAiSettingsChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return settings
}

function FreeAiCard({
  provider,
  settings,
  t,
  compact,
}: {
  provider: FreeAiProviderId
  settings: AiSettings
  t: TFunc
  compact: boolean
}) {
  const [attempt, setAttempt] = useState<FreeAiAttempt>(FREE_AI_IDLE)
  const [key, setKey] = useState('')
  const [quota, setQuota] = useState<FreeAiQuota | null>(null)
  const connected = freeAiConnected(settings, provider)

  // the remaining free requests, read once each time the card becomes connected
  useEffect(() => {
    if (!connected || provider !== 'openrouter') {
      setQuota(null)
      return
    }
    let alive = true
    void window.aiOffice
      .getFreeAiQuota(provider)
      .then((next) => {
        if (alive) setQuota(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [connected, provider])

  const view = freeAiCardView(provider, settings, attempt, quota)

  const connect = (input: Parameters<typeof window.aiOffice.connectFreeAi>[0]) => {
    setAttempt({ phase: input.provider === 'openrouter' ? 'waiting' : 'checking' })
    void window.aiOffice
      .connectFreeAi(input)
      .catch(() => ({ ok: false as const, reason: 'network' as const }))
      .then((result) => {
        if (result.ok) {
          setKey('')
          setAttempt(FREE_AI_IDLE)
        } else {
          setAttempt({ phase: 'failed', reason: result.reason })
        }
      })
  }

  const run = (action: FreeAiCardAction) => {
    if (action === 'connect-browser') connect({ provider: 'openrouter' })
    else if (action === 'cancel') void window.aiOffice.cancelFreeAiConnect()
    else if (action === 'get-key') void window.aiOffice.openFreeAiKeyPage(provider)
    else if (action === 'use') void changeAiSettings((current) => ({ ...current, provider }))
    else {
      setAttempt(FREE_AI_IDLE)
      void window.aiOffice.disconnectFreeAi(provider)
    }
  }

  const submitKey = () => {
    if (key.trim()) connect({ provider: 'gemini', apiKey: key.trim() })
  }

  const showMessage =
    view.messageKey && (!compact || view.tone === 'error' || view.state === 'waiting')
  return (
    <div
      className={`ai-sub-card free-ai-card${compact ? ' compact' : ''}`}
      data-provider={provider}
      data-state={view.state}
      data-tone={view.tone}
    >
      <div className="ai-sub-card-head">
        <span className="ai-sub-card-mark">
          <AiMark size={compact ? 14 : 16} />
        </span>
        <span className="ai-sub-card-name">{FREE_AI_PROVIDER_NAMES[provider]}</span>
        <span className="free-ai-badge">{t('freeBadge')}</span>
        <span className="ai-sub-card-status" role="status">
          {t(view.statusKey)}
        </span>
      </div>
      {view.quota && (
        <p className="ai-sub-note" data-note="quota">
          {t('freeQuota', { remaining: view.quota.remaining, limit: view.quota.limit })}
        </p>
      )}
      {showMessage && (
        <p
          className={view.tone === 'error' ? 'ai-sub-detail' : 'ai-sub-note'}
          data-message={view.messageKey}
          role={view.tone === 'error' ? 'alert' : undefined}
        >
          {t(view.messageKey!)}
        </p>
      )}
      {/* the steps in the order they are taken: make a key, then paste it */}
      {view.actions.length > 0 && (
        <div className="ai-sub-actions">
          {view.actions.map((action, index) => (
            <button
              key={action}
              type="button"
              className={
                action === 'get-key'
                  ? 'ai-sub-link'
                  : `ai-sub-btn${index === 0 && action !== 'disconnect' ? ' primary' : ''}`
              }
              data-action={action}
              onClick={() => run(action)}
            >
              {action === 'cancel' ? t('cancel') : t(ACTION_LABELS[action])}
            </button>
          ))}
        </div>
      )}
      {view.keyInput && (
        <form
          className="free-ai-key-row"
          onSubmit={(event) => {
            event.preventDefault()
            submitKey()
          }}
        >
          <input
            className="set-input free-ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={t('freeKeyPlaceholder')}
            aria-label={t('freeKeyPlaceholder')}
            disabled={view.state === 'checking'}
            onChange={(event) => setKey(event.target.value)}
          />
          <button
            type="submit"
            className="ai-sub-btn primary"
            data-action="connect-key"
            disabled={view.state === 'checking' || !key.trim()}
          >
            {t(view.state === 'checking' ? 'freeStatusChecking' : 'freeKeyConnect')}
          </button>
        </form>
      )}
      {!compact && provider === 'gemini' && view.state === 'idle' && (
        <p className="ai-sub-note" data-note="billing">
          {t('freeGeminiBilling')}
        </p>
      )}
    </div>
  )
}

/** The free connection cards with their privacy note; `compact` for the first-run guide */
export function FreeAiCards({ t, compact = false }: { t: TFunc; compact?: boolean }) {
  const settings = useAiSettings()
  if (!settings) return null
  return (
    <div className={`free-ai-cards${compact ? ' compact' : ''}`}>
      {FREE_AI_PROVIDERS.map((provider) => (
        <FreeAiCard
          key={provider}
          provider={provider}
          settings={settings}
          t={t}
          compact={compact}
        />
      ))}
      <p className="free-ai-privacy">{t('freePrivacy')}</p>
    </div>
  )
}
