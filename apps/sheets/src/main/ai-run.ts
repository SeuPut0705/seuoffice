/**
 * The parts of an AI request the sheets main process decides without Electron:
 * which provider a request runs on, and the stream chunks that carry what the
 * subscription providers report (a blocked run and its cause, usage windows, a
 * cut input). Kept apart from sheets-main.ts so the rules are testable.
 */
import {
  aiStreamErrorFields,
  isSubscriptionProvider,
  normalizeAiSettings,
  selectAiProvider,
  type AiProviderConfig,
  type AiProviderId,
  type AiRunErrorKind,
  type AiSettings,
  type AiStreamChunk,
  type AiSubscriptionProviderId,
  type AiSubscriptionStatuses,
  type StreamCallbacks,
} from '@genoffice/ai-provider'

/** The error fields of a request that was not started because no provider can run */
export interface AiRunBlock {
  /** English fallback; the renderer words the cause from `errorCode` */
  error: string
  errorCode: AiRunErrorKind
  /** the selected subscription provider that cannot run */
  errorProvider?: AiSubscriptionProviderId
}

export type AiRunTarget =
  | { ok: true; settings: AiSettings; provider: AiProviderId; config: AiProviderConfig }
  | { ok: false; settings: AiSettings; block: AiRunBlock }

/** The settings to work with, from whatever the settings file or a renderer held */
export function aiSettingsFromStored(stored: unknown): AiSettings {
  return normalizeAiSettings(stored)
}

/**
 * The provider a request runs on, from the settings it carries and the
 * connection statuses of this process. `auto` only lands on a ready
 * subscription; a selected provider that cannot run is reported, never
 * replaced by another one.
 */
export function resolveAiRunTarget(stored: unknown, statuses: AiSubscriptionStatuses): AiRunTarget {
  const settings = aiSettingsFromStored(stored)
  const choice = selectAiProvider(settings, statuses)
  if (choice.connected) {
    const config = settings.providers[choice.provider]
    if (config) return { ok: true, settings, provider: choice.provider, config }
    return {
      ok: false,
      settings,
      block: { error: 'AI is not connected (not-configured)', errorCode: 'not-connected' },
    }
  }
  return {
    ok: false,
    settings,
    block: {
      error: `AI is not connected (${choice.reason})`,
      errorCode: choice.errorKind,
      ...(isSubscriptionProvider(choice.provider) ? { errorProvider: choice.provider } : {}),
    },
  }
}

/** The chunk that answers a request no provider can run */
export function aiRunBlockChunk(requestId: string, block: AiRunBlock): AiStreamChunk {
  return { requestId, type: 'error', ...block }
}

/** The chunk for a run that failed: its message plus the machine-readable cause, when it has one */
export function aiStreamErrorChunk(requestId: string, err: unknown): AiStreamChunk {
  return {
    requestId,
    type: 'error',
    error: err instanceof Error ? err.message : String(err),
    ...aiStreamErrorFields(err),
  }
}

/** Forwards what a subscription provider reports during a turn as stream chunks */
export function subscriptionStreamCallbacks(
  requestId: string,
  send: (chunk: AiStreamChunk) => void,
): Required<Pick<StreamCallbacks, 'onSubscriptionUsage' | 'onInputTruncated'>> {
  return {
    onSubscriptionUsage: (usage) =>
      send({ requestId, type: 'subscription-usage', subscriptionUsage: usage }),
    onInputTruncated: () => send({ requestId, type: 'input-truncated' }),
  }
}

/**
 * The settings to write after the user accepted (or took back) a metered
 * login. Written as complete settings: a file without its provider table
 * reads back as defaults, which would drop the flag again.
 */
export function withMeteredAccepted(
  stored: unknown,
  provider: AiSubscriptionProviderId,
  accepted: boolean,
): AiSettings {
  const settings = aiSettingsFromStored(stored)
  return { ...settings, meteredAccepted: { ...settings.meteredAccepted, [provider]: accepted } }
}
