import React from 'react'
import type { Lang } from '@genoffice/i18n'
import { aiSubscriptionText } from './strings-ai-subscription'
import './ai-subscription.css'

/**
 * Shown once when a subscription provider first becomes usable, and again
 * from Settings: what leaves the PC and who decides how it is used.
 */
export function AiFirstConnectionNotice({
  lang,
  codexKeepsHistory = false,
  sendsWholeDocument = false,
  onAcknowledge,
}: {
  readonly lang: Lang
  /** add the sentence that Codex may keep conversation content on this PC */
  readonly codexKeepsHistory?: boolean | undefined
  /** add the sentence that page images and the whole document text may be sent (the PDF editor) */
  readonly sendsWholeDocument?: boolean | undefined
  /** adds the acknowledge button; omit where the notice is only re-read */
  readonly onAcknowledge?: (() => void) | undefined
}): React.JSX.Element {
  return (
    <section className="ai-sub-notice ai-sub-first" role="note">
      <h3 className="ai-sub-first-title">{aiSubscriptionText(lang, 'noticeTitle')}</h3>
      <ul className="ai-sub-first-list">
        <li>{aiSubscriptionText(lang, 'noticeSend')}</li>
        <li>{aiSubscriptionText(lang, 'noticeTraining')}</li>
        {sendsWholeDocument && <li>{aiSubscriptionText(lang, 'noticePdfWholeDocument')}</li>}
        {codexKeepsHistory && <li>{aiSubscriptionText(lang, 'noticeCodexHistory')}</li>}
      </ul>
      {onAcknowledge && (
        <div className="ai-sub-actions">
          <button type="button" className="ai-sub-btn primary" onClick={onAcknowledge}>
            {aiSubscriptionText(lang, 'noticeAck')}
          </button>
        </div>
      )}
    </section>
  )
}

/** The one line shown wherever Codex is chosen */
export function AiCodexNotice({
  lang,
  compact = false,
}: {
  readonly lang: Lang
  /** plain small print for a tight place such as the model picker's Codex group */
  readonly compact?: boolean | undefined
}): React.JSX.Element {
  return (
    <p className={`ai-sub-notice ai-sub-codex${compact ? ' compact' : ''}`} role="note">
      {aiSubscriptionText(lang, 'codexNotice')}
    </p>
  )
}

/** The cost warning of a metered login: charged by usage, not a subscription */
export function AiMeteredWarning({
  lang,
  explain = false,
}: {
  readonly lang: Lang
  /** add what accepting such a login means */
  readonly explain?: boolean | undefined
}): React.JSX.Element {
  return (
    <div className="ai-sub-notice warning ai-sub-metered" role="note">
      <p className="ai-sub-notice-text">
        {aiSubscriptionText(lang, 'meteredWarning')}
        {explain && ` ${aiSubscriptionText(lang, 'meteredMeaning')}`}
      </p>
    </div>
  )
}

/** Told to the user whenever the input was cut to fit a limit: it is never cut silently */
export function AiInputTruncatedNotice({
  lang,
  onDismiss,
}: {
  readonly lang: Lang
  readonly onDismiss?: (() => void) | undefined
}): React.JSX.Element {
  return (
    <div className="ai-sub-notice warning ai-sub-truncated" role="status">
      <p className="ai-sub-notice-text">{aiSubscriptionText(lang, 'truncatedNotice')}</p>
      {onDismiss && (
        <button type="button" className="ai-sub-link" onClick={onDismiss}>
          {aiSubscriptionText(lang, 'actionDismiss')}
        </button>
      )}
    </div>
  )
}
