/**
 * Which provider answers a file-naming request.
 *
 * The same rule as every other AI request in this app (selectAiProvider): the
 * stored `ai-settings.json`, sanitized and normalized, and the process-wide
 * subscription statuses. `auto` lands only on a ready subscription; a selected
 * provider runs only when it can, and nothing falls back to another provider,
 * so naming never starts a paid run the reader did not choose.
 */
import type { AiProviderConfig, AiProviderId, AiSubscriptionStatuses } from '@genoffice/ai-provider'
import { normalizeAiSettings, sanitizeAiSettings, selectAiProvider } from '@genoffice/ai-provider'

/** The provider to call, and the credentials to call it with. */
export interface NamingProvider {
  provider: AiProviderId
  config: AiProviderConfig
}

/**
 * The provider a naming request goes to, or null when no provider can answer.
 *
 * `stored` is the parsed `ai-settings.json`. Null rather than a broken
 * provider: a request with no usable provider is declined, and the caller
 * keeps the name the document already has.
 */
export function resolveNamingProvider(
  stored: unknown,
  statuses: AiSubscriptionStatuses,
): NamingProvider | null {
  const sanitized = sanitizeAiSettings(stored)
  if (!sanitized) return null
  const settings = normalizeAiSettings(sanitized)
  const choice = selectAiProvider(settings, statuses)
  if (!choice.connected) return null
  // a subscription provider needs no stored entry: an empty model is the CLI's default
  return {
    provider: choice.provider,
    config: settings.providers[choice.provider] ?? { apiKey: '', model: '' },
  }
}
