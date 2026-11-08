/**
 * What the AI panel does under the subscription contract, as a plain function:
 * which run errors get the blocked notice. Whether a send may start is the
 * send gate every editor shares (`useAiSendGate` in @genoffice/ui). The panel
 * only lays these answers out, so the rules are testable without a DOM.
 */
import type { IpcStreamError } from '@genoffice/agent-core'
import type { AiProviderId } from '@genoffice/ai-provider/browser'
import { isAiBlockedRunKind, type AiBlockedRunKind } from '@genoffice/ui'

/** A run that stopped because its connection cannot go on (rendered as the blocked notice) */
export interface AiBlockedRun {
  kind: AiBlockedRunKind
  /** the provider the run was blocked on, when the error named one */
  provider?: AiProviderId
  /** epoch milliseconds: when a used-up limit resets */
  resetsAt?: number
}

/**
 * The blocked-run cause behind an error message, or undefined for every other
 * failure. `error` is the transport's structured copy of its last failure; it
 * counts only when it is the failure this message came from.
 */
export function blockedRunOf(
  error: IpcStreamError | null | undefined,
  message: string,
): AiBlockedRun | undefined {
  if (!error || error.message !== message || !isAiBlockedRunKind(error.kind)) return undefined
  return {
    kind: error.kind,
    ...(error.provider ? { provider: error.provider } : {}),
    ...(typeof error.resetsAt === 'number' ? { resetsAt: error.resetsAt } : {}),
  }
}
