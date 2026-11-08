/**
 * What the sheets AI panel does about the subscription connection, as plain
 * data: which failed run gets the blocked notice, and which message "continue
 * with …" sends again. Whether a message may be sent, and what is shown when it
 * may not, is the send gate every editor shares (`useAiSendGate` in
 * @genoffice/ui). The panel and App.tsx only lay these answers out, so the
 * rules are testable without a browser.
 */
import type { IpcStreamError } from '@genoffice/agent-core'
import type { AiRunErrorKind, AiSubscriptionProviderId } from '@genoffice/ai-provider/browser'
import { isAiBlockedRunKind } from '@genoffice/ui'

/** Why a run stopped, kept on its chat message so the blocked notice can be drawn */
export interface AiBlockedRun {
  readonly kind: AiRunErrorKind
  readonly provider?: AiSubscriptionProviderId | undefined
  /** epoch milliseconds: when a used-up limit resets */
  readonly resetsAt?: number | undefined
}

/**
 * The blocked-run details of a failed run, or undefined when it keeps the
 * plain error line: a transient failure (timeout, network …), or a failure
 * the loop reported itself. `error` is the transport's record of its last
 * failed turn and `message` the text the run ended with; they belong together
 * only when the texts match (the loop retries some failed turns on its own).
 */
export function aiBlockedRunOf(
  error: IpcStreamError | null | undefined,
  message: string,
): AiBlockedRun | undefined {
  if (!error || error.message !== message || !isAiBlockedRunKind(error.kind)) return undefined
  return {
    kind: error.kind,
    ...(error.provider !== undefined ? { provider: error.provider } : {}),
    ...(error.resetsAt !== undefined ? { resetsAt: error.resetsAt } : {}),
  }
}

/** The part of a chat message the rerun needs */
interface ChatEntryLike {
  readonly role: 'user' | 'assistant'
  readonly undelivered?: boolean | undefined
}

/**
 * The index of the user message a blocked reply answers: the nearest earlier
 * user message, and only while it is still marked as not delivered (-1 when
 * there is nothing to rerun).
 */
export function blockedRunSourceIndex(chat: readonly ChatEntryLike[], replyIndex: number): number {
  for (let i = Math.min(replyIndex, chat.length) - 1; i >= 0; i--) {
    const entry = chat[i]
    if (entry?.role === 'user') return entry.undelivered ? i : -1
  }
  return -1
}

/** Whether generate_image is offered, from the main process's tool capabilities */
export function imageGenerationOffered(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false
  const image = (capabilities as { imageGeneration?: unknown }).imageGeneration
  return (
    !!image && typeof image === 'object' && (image as { available?: unknown }).available === true
  )
}
