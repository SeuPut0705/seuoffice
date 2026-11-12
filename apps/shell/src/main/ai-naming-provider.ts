/**
 * Which provider answers a file-naming request.
 *
 * The same rule as every other AI request in this app (selectAiProvider): the
 * stored `ai-settings.json` as every reader gets it (normalizeAiSettings), and
 * the process-wide subscription statuses. `auto` lands only on a ready
 * subscription; a selected provider runs only when it can, and nothing falls
 * back to another provider, so naming never starts a paid run the reader did
 * not choose.
 */
import type { AiProviderConfig, AiProviderId, AiSubscriptionStatuses } from '@genoffice/ai-provider'
import { normalizeAiSettings, selectAiProvider } from '@genoffice/ai-provider'

/** The provider to call, and the credentials to call it with. */
export interface NamingProvider {
  provider: AiProviderId
  config: AiProviderConfig
}

/**
 * The provider a naming request goes to, or null when no provider can answer.
 *
 * `stored` is the parsed `ai-settings.json`, or anything else when there is no
 * readable file: what the file does not say is the default, as on every other
 * AI path. Sealed keys are opened by the same read. Null rather than a broken
 * provider: a request with no usable provider is declined, and the caller
 * keeps the name the document already has.
 */
export function resolveNamingProvider(
  stored: unknown,
  statuses: AiSubscriptionStatuses,
): NamingProvider | null {
  // not sanitizeAiSettings: that checks what a renderer sent, and answers null
  // for a file that only lacks its selection
  const settings = normalizeAiSettings(stored)
  const choice = selectAiProvider(settings, statuses)
  if (!choice.connected) return null
  // a subscription provider needs no stored entry: an empty model is the CLI's default
  return {
    provider: choice.provider,
    config: settings.providers[choice.provider] ?? { apiKey: '', model: '' },
  }
}
