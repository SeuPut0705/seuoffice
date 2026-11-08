/**
 * The provider side of an `ai:stream` request, kept free of Electron so the
 * rules can be unit-tested: which provider a request runs on, and how the
 * provider's callbacks and failures become stream chunks.
 */
import {
  aiStreamErrorFields,
  isSubscriptionProvider,
  maxOutputTokensOf,
  normalizeAiSettings,
  selectAiProvider,
  streamForProvider,
  type AiProviderConfig,
  type AiProviderId,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type AiSubscriptionProviderId,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider'

/** What ai-settings.json holds, as the app reads it: removed and unknown selections fall to their defaults */
export function storedAiSettings(stored: unknown): AiSettings {
  return normalizeAiSettings(stored)
}

/** The settings to persist after "use anyway" on a metered login (or taking it back) */
export function withMeteredAccepted(
  settings: AiSettings,
  provider: AiSubscriptionProviderId,
  accepted: boolean,
): AiSettings {
  return { ...settings, meteredAccepted: { ...settings.meteredAccepted, [provider]: accepted } }
}

export type AiStreamTarget =
  | { connected: true; provider: AiProviderId; config: AiProviderConfig }
  | {
      connected: false
      /** the fields of the error chunk that answers the request */
      error: Pick<AiStreamChunk, 'error' | 'errorCode' | 'errorProvider'>
    }

/**
 * The provider a request runs on. A selection that cannot run is answered
 * with its cause; nothing else is tried in its place, so a request never
 * lands on a provider the user did not choose.
 */
export function resolveStreamTarget(
  settings: AiSettings,
  statuses: AiSubscriptionStatuses,
): AiStreamTarget {
  const choice = selectAiProvider(settings, statuses)
  if (!choice.connected) {
    return {
      connected: false,
      error: {
        // English fallback only: the renderer words the message from errorCode
        error: 'No AI provider is connected',
        errorCode: choice.errorKind,
        ...(isSubscriptionProvider(choice.provider) ? { errorProvider: choice.provider } : {}),
      },
    }
  }
  return {
    connected: true,
    provider: choice.provider,
    config: settings.providers[choice.provider] ?? { apiKey: '', model: '' },
  }
}

export interface AiStreamRun {
  request: AiStreamRequest
  /** the request's settings after the IPC schema check */
  settings: AiSettings
  statuses: AiSubscriptionStatuses
  signal: AbortSignal
  send(chunk: AiStreamChunk): void
  /** test seam; the provider router by default */
  stream?: typeof streamForProvider
}

/** Run one streaming turn and report everything about it as chunks; never throws. */
export async function runAiStream(run: AiStreamRun): Promise<void> {
  const { request, signal, send } = run
  const { requestId, system, messages } = request
  const settings = normalizeAiSettings(run.settings)
  const target = resolveStreamTarget(settings, run.statuses)
  if (!target.connected) {
    send({ requestId, type: 'error', ...target.error })
    return
  }
  const { provider, config } = target
  const tools = request.tools ?? []
  const maxTokens = request.maxTokens ?? maxOutputTokensOf(settings)
  // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
  let lastPing = 0
  const ping = () => {
    const now = Date.now()
    if (now - lastPing < 5_000) return
    lastPing = now
    send({ requestId, type: 'ping' })
  }
  try {
    let stopReason: string | undefined
    await (run.stream ?? streamForProvider)(provider, config, system, messages, tools, maxTokens, {
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      signal,
      onDelta: (text) => send({ requestId, type: 'delta', text }),
      onReasoningDelta: (text) => send({ requestId, type: 'reasoning', text }),
      onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
      onActivity: ping,
      onStopReason: (reason) => {
        stopReason = reason
      },
      onUsage: (usage) => send({ requestId, type: 'usage', usage }),
      onSubscriptionUsage: (subscriptionUsage) =>
        send({ requestId, type: 'subscription-usage', subscriptionUsage }),
      onInputTruncated: () => send({ requestId, type: 'input-truncated' }),
    })
    send(
      stopReason === undefined
        ? { requestId, type: 'done' }
        : { requestId, type: 'done', stopReason },
    )
  } catch (err) {
    if (signal.aborted) {
      send({ requestId, type: 'done' })
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ai-stream] ${requestId} (${provider}/${config.model}) failed:`, msg)
      send({ requestId, type: 'error', error: msg, ...aiStreamErrorFields(err) })
    }
  }
}
