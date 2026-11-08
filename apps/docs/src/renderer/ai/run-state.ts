/**
 * What the AI panel decides from the subscription contract, kept apart from
 * the component so it can be tested without a browser: how a failed run is
 * shown and which usage reports are kept. What stands between the user and a
 * run (connect first, read the first-connection notice) is the send gate every
 * editor shares (`useAiSendGate` in @genoffice/ui).
 */
import type {
  AiRunErrorKind,
  AiSubscriptionProviderId,
  AiSubscriptionUsage,
} from '@genoffice/ai-provider/browser'
import type { IpcStreamError } from '@genoffice/agent-core'
import { isAiBlockedRunKind } from '@genoffice/ui'

/** The machine-readable cause of a failed run, as the error chunk carried it */
export interface RunErrorCause {
  kind: AiRunErrorKind
  provider?: AiSubscriptionProviderId
  /** epoch milliseconds */
  resetsAt?: number
}

/**
 * The cause of the failure the loop just reported. The transport hands over
 * the structured copy right before the message, so the two are matched by
 * text: a failure that did not come from the transport has no cause.
 */
export function runErrorCauseOf(
  failure: IpcStreamError | null,
  message: string,
): RunErrorCause | undefined {
  if (!failure?.kind || failure.message !== message) return undefined
  return {
    kind: failure.kind,
    ...(failure.provider ? { provider: failure.provider } : {}),
    ...(failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {}),
  }
}

/** Causes that may rest on an out-of-date connection status: worth looking again */
const RECHECK_KINDS: readonly AiRunErrorKind[] = [
  'not-connected',
  'not-installed',
  'signed-out',
  'metered-not-accepted',
  'needs-update',
]

export function shouldRecheckAfter(cause: RunErrorCause | undefined): boolean {
  return !!cause && RECHECK_KINDS.includes(cause.kind)
}

/**
 * A cause that means "this connection cannot go on" (limit used up, signed
 * out, program gone, nothing connected): its reply gets the blocked notice
 * instead of the plain error line, and the message queue waits. Every other
 * failure, and one that did not come from the transport, keeps the error line.
 */
export function isBlockedRunCause(cause: RunErrorCause | undefined): cause is RunErrorCause {
  return !!cause && isAiBlockedRunKind(cause.kind)
}

/** The usage reports with the newest one per provider and window */
export function mergeSubscriptionUsage(
  known: readonly AiSubscriptionUsage[],
  reported: readonly AiSubscriptionUsage[],
): AiSubscriptionUsage[] {
  const latest = new Map<string, AiSubscriptionUsage>()
  for (const entry of [...known, ...reported])
    latest.set(`${entry.provider}:${entry.window}`, entry)
  return [...latest.values()]
}
