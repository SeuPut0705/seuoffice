/**
 * A failed one-shot model call as the reading assistant shows it (spec 6):
 * a run its connection cannot go on with (used-up limit, signed out, …) is
 * the standard blocked notice (`aiBlockedRunOf`), and its subscription
 * provider's status is looked at again so the connect cards follow when it is
 * unusable; any other failure keeps its plain message. Nothing moves to
 * another provider by itself. Shared by the passage cards and the overview.
 */
import type { IpcStreamError } from '@genoffice/agent-core'
import {
  isSubscriptionProvider,
  type AiSubscriptionProviderId,
} from '@genoffice/ai-provider/browser'
import { ModelCallError } from '../doc-jobs/model-call'
import { aiBlockedRunOf, type AiBlockedRun } from './ai-connection'

export interface ModelCallFailure {
  /** the failure's own text (shown when there is no standard wording) */
  message: string
  /** the blocked-run view, or null for a plain failure */
  blocked: AiBlockedRun | null
}

export function modelCallFailure(
  err: unknown,
  recheck: (provider: AiSubscriptionProviderId) => void,
): ModelCallFailure {
  const message = err instanceof Error ? err.message : String(err)
  const blocked =
    err instanceof ModelCallError
      ? aiBlockedRunOf({
          message,
          ...(err.kind !== undefined ? { kind: err.kind as IpcStreamError['kind'] } : {}),
          ...(err.provider !== undefined
            ? { provider: err.provider as IpcStreamError['provider'] }
            : {}),
          ...(err.resetsAt !== undefined ? { resetsAt: err.resetsAt } : {}),
        })
      : null
  // the shown status may be stale: look again; the connect cards follow if it is unusable
  if (blocked?.provider && isSubscriptionProvider(blocked.provider)) recheck(blocked.provider)
  return { message, blocked }
}
