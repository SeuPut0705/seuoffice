/**
 * One model call of a document job over the shared `ai:stream` channel (the
 * AI panel's IPC transport): a system prompt and user turns (page images
 * allowed), never a tool. The answer is plain text for the job to check; it is
 * document data and nothing in it is executed. A tool call the model makes
 * anyway is ignored.
 *
 * A failed call rejects with a `ModelCallError` carrying the run error kind
 * and `resetsAt`, which the job engine reads to retry ('timeout', 'network',
 * …) or to stop at once ('rate-limit', 'signed-out', …). Aborting the signal
 * cancels the stream; the shell then ends the subscription program it started.
 * The cancel names this request only, so it leaves the image and media calls
 * of the AI window in the same tab alone.
 */
import type {
  AgentStreamHandle,
  AgentStreamRequest,
  IpcContextGate,
  IpcStreamError,
  IpcStreamErrorKind,
} from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'
import { createElectronTransport } from '../ai/transport'

/** longest answer one call may return (a dense page is well under it) */
export const MODEL_CALL_MAX_CHARS = 200_000

export class ModelCallError extends Error {
  /** run error kind (IpcStreamErrorKind), when the failure has one */
  readonly kind?: string
  /** epoch ms when a rate limit lifts */
  readonly resetsAt?: number
  readonly provider?: string

  constructor(
    message: string,
    cause?: Partial<Pick<IpcStreamError, 'kind' | 'resetsAt' | 'provider'>>,
  ) {
    super(message)
    this.name = 'ModelCallError'
    if (cause?.kind !== undefined) this.kind = cause.kind
    if (cause?.resetsAt !== undefined) this.resetsAt = cause.resetsAt
    if (cause?.provider !== undefined) this.provider = cause.provider
  }
}

export interface ModelCallOptions {
  /** the settings the job was confirmed with (selection pinned to one provider) */
  settings: () => AiSettings
  /** the language run-error texts are worded in */
  lang: () => Lang
  /**
   * One id for the whole job: every call of this factory shares it, so the
   * context gate asks once per job and a decline stops the rest. Absent: a
   * fresh id per factory, which keeps that rule for callers that pass none.
   */
  runId?: string
  /**
   * Asked before each call: the run error kind to fail with when the route
   * the user confirmed no longer holds, else null.
   */
  guard?: () => Promise<IpcStreamErrorKind | null>
  /** default MODEL_CALL_MAX_CHARS */
  maxChars?: number
}

export type ModelCall = (request: AgentStreamRequest, signal: AbortSignal) => Promise<string>

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The call was stopped', 'AbortError')

/** a fresh transport per call: calls run side by side and share no CLI session */
export function createModelCall(o: ModelCallOptions): ModelCall {
  const maxChars = o.maxChars ?? MODEL_CALL_MAX_CHARS
  // one run id and one confirmation memory per job, shared by every call below
  const runId = o.runId ?? crypto.randomUUID()
  const confirmedRuns = new Set<string>()
  /** the person declined this job's prompt: no later call of it may ask again */
  let declined = false
  const contextGate: IpcContextGate = {
    isConfirmed: (id) => confirmedRuns.has(id),
    markConfirmed: (id) => {
      confirmedRuns.add(id)
    },
  }
  return async (request, signal) => {
    if (signal.aborted) throw abortError(signal)
    const refused = (await o.guard?.()) ?? null
    if (refused)
      throw new ModelCallError(`the confirmed AI connection changed (${refused})`, {
        kind: refused,
      })
    if (declined)
      throw new ModelCallError('the request was not confirmed for this job', {
        kind: 'context-limit',
      })
    if (signal.aborted) throw abortError(signal)
    return new Promise<string>((resolve, reject) => {
      let cause: IpcStreamError | null = null
      let raw = ''
      let settled = false
      let handle: AgentStreamHandle | null = null
      const finish = (end: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        end()
      }
      const onAbort = () => {
        handle?.cancel()
        finish(() => reject(abortError(signal)))
      }
      const transport = createElectronTransport(o.settings, {
        lang: o.lang,
        // Stop on a job ends its own calls, not what the AI window runs in this tab
        cancelScope: 'request',
        // the job's one confirmation memory, shared by its calls
        contextGate,
        onStreamError: (error) => {
          // the person said no: the job stops, and no later call asks again
          if (error.kind === 'context-limit') declined = true
          cause = error
        },
      })
      handle = transport.stream(
        { system: request.system, messages: request.messages, tools: [], runId },
        {
          onDelta: (text) => {
            if (settled) return
            raw += text
            if (raw.length > maxChars) {
              handle?.cancel()
              finish(() => reject(new ModelCallError(`the answer exceeded ${maxChars} characters`)))
            }
          },
          // the request offers no tool; whatever the model asks for is not run
          onToolCall: () => undefined,
          onDone: () => finish(() => (signal.aborted ? reject(abortError(signal)) : resolve(raw))),
          onError: (message) =>
            finish(() => reject(new ModelCallError(message, cause ?? undefined))),
        },
      )
      if (settled) return
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
