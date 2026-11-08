import React from 'react'
import type { Lang } from '@genoffice/i18n'
import type {
  AiProviderId,
  AiRunErrorKind,
  AiSettings,
  AiSubscriptionProviderId,
  AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import {
  aiContinueOption,
  aiRunErrorText,
  aiSubscriptionProviderName,
  isAiBlockedRunKind,
} from './ai-subscription'
import { aiSubscriptionText } from './strings-ai-subscription'
import './ai-subscription.css'

/**
 * Shown where a run stopped because its connection cannot go on: the reason,
 * and — when another subscription connection can run — a button to continue
 * on it. Nothing switches on its own, and a key provider is never offered.
 */
export function AiBlockedNotice({
  kind,
  provider,
  resetsAt,
  message,
  settings,
  statuses,
  lang,
  onContinueWith,
}: {
  readonly kind: AiRunErrorKind
  /** the provider the run was blocked on, when known */
  readonly provider?: AiProviderId | undefined
  /** epoch milliseconds: when a used-up limit resets */
  readonly resetsAt?: number | undefined
  /** the text to show for a kind this package has no wording for */
  readonly message?: string | undefined
  readonly settings: Pick<AiSettings, 'meteredAccepted'>
  readonly statuses: AiSubscriptionStatuses
  readonly lang: Lang
  /** the user pressed "continue with …": store that provider as the selection and rerun */
  readonly onContinueWith: (provider: AiSubscriptionProviderId) => void
}): React.JSX.Element | null {
  const reason = aiRunErrorText(lang, { kind, provider, resetsAt }) ?? message
  // only Claude can start with tools of its own, and that error names no provider
  const blocked = provider ?? (kind === 'unsafe-tools' ? 'claude-code' : undefined)
  const option = isAiBlockedRunKind(kind) ? aiContinueOption(settings, statuses, blocked) : null
  if (!reason && !option) return null
  const name = option ? aiSubscriptionProviderName(option.provider) : ''
  return (
    <div className="ai-sub-blocked" role="alert" data-kind={kind}>
      {reason && <p className="ai-sub-blocked-reason">{reason}</p>}
      {option && (
        <>
          {option.metered && (
            <p className="ai-sub-note" data-note="continueMeteredNote">
              {aiSubscriptionText(lang, 'continueMeteredNote', { provider: name })}
            </p>
          )}
          <button
            type="button"
            className="ai-sub-btn primary"
            data-action="continue-with"
            data-provider={option.provider}
            onClick={() => onContinueWith(option.provider)}
          >
            {aiSubscriptionText(lang, 'continueWith', { provider: name })}
          </button>
        </>
      )}
    </div>
  )
}
