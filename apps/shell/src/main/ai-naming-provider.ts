/**
 * Which provider answers a file-naming request.
 *
 * The same rule as every other AI request in this app (selectAiProvider): the
 * stored `ai-settings.json` as every reader gets it (normalizeAiSettings), and
 * the process-wide subscription statuses. `auto` lands only on a ready
 * subscription; a selected provider runs only when it can, and nothing falls
 * back to another provider, so naming never starts a paid run the reader did
 * not choose.
 *
 * And the same gate as every AI panel (`aiSendGate` in @genoffice/ui): nothing
 * goes to a subscription provider before the first-connection notice was
 * acknowledged in its current wording. Naming has no notice of its own, so it
 * refuses and the editor points the reader at the AI panel, which shows it.
 */
import type { AiProviderConfig, AiProviderId, AiSubscriptionStatuses } from '@genoffice/ai-provider'
import {
  AI_SUBSCRIPTION_NOTICE_VERSION,
  isSubscriptionProvider,
  normalizeAiSettings,
  selectAiProvider,
  withMigratedSubscriptionNoticeVersion,
} from '@genoffice/ai-provider'

/** Why no naming request goes out */
export type NamingRefusal =
  /** no provider can run: none connected, signed out, half configured */
  | 'not-connected'
  /** a subscription would run, and its first-connection notice is still unread */
  | 'notice'

/** The provider to call and the credentials to call it with, or why none is called */
export type NamingTarget =
  | { ok: true; provider: AiProviderId; config: AiProviderConfig }
  | { ok: false; reason: NamingRefusal }

/**
 * The provider a naming request goes to, or the reason it goes nowhere.
 *
 * `stored` is the parsed `ai-settings.json`, or anything else when there is no
 * readable file: what the file does not say is the default, as on every other
 * AI path. Sealed keys are opened by the same read. A refusal rather than a
 * broken provider: the caller keeps the name the document already has.
 */
export function resolveNamingProvider(
  stored: unknown,
  statuses: AiSubscriptionStatuses,
): NamingTarget {
  // not sanitizeAiSettings: that checks what a renderer sent, and answers null
  // for a file that only lacks its selection.
  // A file from before the notice had versions acknowledged its first wording;
  // normalizing it as it is would read the bare flag as the current one. The
  // AI settings reader writes that version back; this read only applies it.
  const settings = normalizeAiSettings(withMigratedSubscriptionNoticeVersion(stored) ?? stored)
  const choice = selectAiProvider(settings, statuses)
  if (!choice.connected) return { ok: false, reason: 'not-connected' }
  if (
    isSubscriptionProvider(choice.provider) &&
    (settings.subscriptionNoticeVersion ?? 0) < AI_SUBSCRIPTION_NOTICE_VERSION
  ) {
    return { ok: false, reason: 'notice' }
  }
  // a subscription provider needs no stored entry: an empty model is the CLI's default
  return {
    ok: true,
    provider: choice.provider,
    config: settings.providers[choice.provider] ?? { apiKey: '', model: '' },
  }
}
