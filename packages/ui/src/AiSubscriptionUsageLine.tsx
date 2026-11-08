import React from 'react'
import type { Lang } from '@genoffice/i18n'
import type { AiSubscriptionUsage } from '@genoffice/ai-provider/browser'
import {
  AI_SUBSCRIPTION_USAGE_THRESHOLD,
  aiSubscriptionUsageAlerts,
  aiSubscriptionUsageLabel,
  aiSubscriptionUsageText,
} from './ai-subscription'
import './ai-usage.css'

/**
 * "83% used · resets at 5:10 PM" for each subscription usage window at or
 * above the threshold. Renders nothing below it, and nothing for a provider
 * that reports no usage — the line is a heads-up, not a meter.
 */
export function AiSubscriptionUsageLine({
  usage,
  lang,
  threshold = AI_SUBSCRIPTION_USAGE_THRESHOLD,
  now,
}: {
  /** the windows the subscription CLI reported, e.g. from the transport's onSubscriptionUsage */
  readonly usage: readonly AiSubscriptionUsage[]
  readonly lang: Lang
  /** share of a window (0..1) from which it is shown */
  readonly threshold?: number | undefined
  /** epoch milliseconds standing in for the current time (tests) */
  readonly now?: number | undefined
}): React.JSX.Element | null {
  const alerts = aiSubscriptionUsageAlerts(usage, threshold)
  if (alerts.length === 0) return null
  return (
    <span className="ai-subscription-usage" role="status">
      {alerts.map((entry) => (
        <span
          key={`${entry.provider}:${entry.window}`}
          className="ai-usage-chip ai-subscription-usage-item"
          data-provider={entry.provider}
          data-window={entry.window}
          title={aiSubscriptionUsageLabel(lang, entry)}
        >
          {aiSubscriptionUsageText(lang, entry, now)}
        </span>
      ))}
    </span>
  )
}
