/**
 * The ask panel's decisions under the subscription contract, kept free of React
 * so they can be tested on their own: what pressing send does, when a failed
 * run is shown as a blocked notice, and the settings "continue with" writes.
 * The editors' AI panels follow the same rules.
 */
import type {
  AiProviderId,
  AiSettings,
  AiSubscriptionProviderId,
  AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import type { IpcStreamError } from '@genoffice/agent-core'
import {
  aiHoldReason,
  aiSendGate,
  isAiBlockedRunKind,
  withAiProviderSelection,
  type AiBlockedRunKind,
} from '@genoffice/ui'

/**
 * What a send does right now.
 * `checking`: the settings or a status check have not answered yet — the question is held
 * and starts by itself once a provider can run.
 * `connect`: no provider can run — the connect prompt is shown and nothing is sent.
 * `notice`: the first-connection notice is up and not acknowledged yet — nothing is sent.
 * `run`: the question goes out.
 */
export type AskSendGate = 'checking' | 'connect' | 'notice' | 'run'

/**
 * The send gate every editor's AI panel uses (`aiSendGate`), read for this
 * panel: whether a provider can run, cannot, or is not known yet is decided
 * there and nowhere else. The one thing the panel adds is who shows the
 * first-connection notice: the home screen does, over this panel, so
 * `noticeDue` is its answer and the panel holds back exactly as long as that
 * dialog is owed.
 */
export function askSendGate(
  settings: AiSettings | null,
  statuses: AiSubscriptionStatuses,
  noticeDue: boolean,
): AskSendGate {
  const gate = aiSendGate(settings, statuses)
  if (gate.kind === 'connect') return 'connect'
  if (aiHoldReason(gate) === 'checking') return 'checking'
  return noticeDue ? 'notice' : 'run'
}

/**
 * What becomes of a question that was held for a status check, each time the
 * gate is looked at again: it starts once a provider can run and stays held
 * while the check is still out. When the answer is "not connected", or the
 * notice comes first, it is dropped: the composer still has the text, and the
 * question is asked again after the sign-in or the notice (neither starts a
 * run by itself).
 */
export function askHeldStep(gate: AskSendGate): 'start' | 'keep' | 'drop' {
  if (gate === 'run') return 'start'
  return gate === 'checking' ? 'keep' : 'drop'
}

/** Why a run stopped, when its connection cannot go on (shown as the blocked notice) */
export interface AskBlockedRun {
  kind: AiBlockedRunKind
  /** the provider the run was blocked on, when the error names one */
  provider?: AiProviderId
  /** epoch milliseconds: when a used-up limit resets */
  resetsAt?: number
}

/**
 * The blocked-run view of a stream failure, or null for a failure that keeps
 * the plain error line (timeouts, network, overload, provider messages).
 */
export function askBlockedRunOf(error: IpcStreamError | null | undefined): AskBlockedRun | null {
  if (!error || !isAiBlockedRunKind(error.kind)) return null
  return {
    kind: error.kind,
    ...(error.provider ? { provider: error.provider } : {}),
    ...(typeof error.resetsAt === 'number' && Number.isFinite(error.resetsAt)
      ? { resetsAt: error.resetsAt }
      : {}),
  }
}

/**
 * Settings after "continue with <provider>": that provider becomes the stored
 * selection (so Settings shows it as the AI in use), keeping the model it last used.
 */
export function withContinuedProvider(
  settings: AiSettings,
  provider: AiSubscriptionProviderId,
): AiSettings {
  return withAiProviderSelection(settings, {
    provider,
    model: settings.providers?.[provider]?.model ?? '',
  })
}
