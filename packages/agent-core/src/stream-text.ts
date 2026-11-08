import type { AgentStreamHandle, AgentTransport } from './types'

/**
 * One tool-less streaming request whose reply body IS the artifact (a page, a
 * document fragment). Text deltas arrive immediately, so the caller can mirror
 * the draft as it grows and no gateway sees a silent connection — tool
 * arguments are buffered server-side until the JSON is complete, and an
 * artifact-sized argument exceeds gateway idle cutoffs.
 */
export interface StreamTextOptions {
  transport: AgentTransport
  system: string
  user: string
  signal?: AbortSignal
  /** the stream is cancelled and reported as partial once the raw reply exceeds this */
  maxChars: number
  /**
   * Maps the raw reply so far to the artifact. `complete` says the format's own
   * terminator arrived (e.g. `</html>`); omit it for formats without one, and
   * the stop reason decides (a natural end is complete, `max_tokens` is not).
   */
  extract(raw: string): { text: string; complete?: boolean }
  /**
   * Cumulative extracted text. Sent for the first delta, then at most once per
   * `progressIntervalMs`; whatever is still due is sent before the promise
   * settles, so the last call always carries everything that arrived.
   */
  onProgress?(text: string): void
  /** minimum gap between two progress calls (default 120 ms; 0 = every delta) */
  progressIntervalMs?: number
}

/**
 * Extracting runs over the whole reply so far. Per delta that is quadratic in
 * the reply length (a 200,000-character document arrives in thousands of
 * deltas); per interval it is bounded by time instead.
 */
const DEFAULT_PROGRESS_INTERVAL_MS = 120

export type StreamTextOutcome =
  | { status: 'complete'; text: string }
  | { status: 'partial'; text: string; reason: 'error' | 'stopped' | 'max_tokens'; error?: string }
  | { status: 'empty'; error: string }

/** Resolves with what arrived, never throws. */
export function streamText(opts: StreamTextOptions): Promise<StreamTextOutcome> {
  return new Promise((resolve) => {
    let raw = ''
    let stopReason: string | undefined
    let settled = false
    let handle: AgentStreamHandle | null = null
    let onAbort: () => void = () => undefined
    let cancelRequested = false
    // Fallback cap when the caller passes NaN, Infinity, zero, or a negative limit.
    const FALLBACK_MAX_CHARS = 200000
    const maxChars =
      Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : FALLBACK_MAX_CHARS
    // Extract never throws; on failure the raw reply is kept so the promise settles.
    const safeExtract = (input: string): { text: string; complete?: boolean; error?: string } => {
      try {
        return opts.extract(input)
      } catch (err) {
        return { text: input, error: err instanceof Error ? err.message : String(err) }
      }
    }
    const progressIntervalMs =
      Number.isFinite(opts.progressIntervalMs) && (opts.progressIntervalMs ?? 0) >= 0
        ? (opts.progressIntervalMs as number)
        : DEFAULT_PROGRESS_INTERVAL_MS
    /** the reply as of the last delta accepted under the cap */
    let progressRaw = ''
    let lastProgressAt = -Infinity
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    const sendProgress = () => {
      if (progressTimer !== null) clearTimeout(progressTimer)
      progressTimer = null
      lastProgressAt = Date.now()
      try {
        opts.onProgress?.(safeExtract(progressRaw).text)
      } catch {
        // Ignore progress listener failures so the stream can still settle.
      }
    }
    const scheduleProgress = () => {
      if (!opts.onProgress || progressTimer !== null) return
      const wait = lastProgressAt + progressIntervalMs - Date.now()
      if (wait <= 0) sendProgress()
      else progressTimer = setTimeout(sendProgress, wait)
    }
    const finish = (outcome: StreamTextOutcome) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      // the listener sees everything that arrived before it learns the outcome
      if (progressTimer !== null) sendProgress()
      resolve(outcome)
    }
    const partialOrEmpty = (
      reason: 'error' | 'stopped' | 'max_tokens',
      error?: string,
    ): StreamTextOutcome => {
      const extracted = safeExtract(raw)
      const resolvedError = error ?? extracted.error
      if (!extracted.text.trim()) return { status: 'empty', error: resolvedError ?? reason }
      return resolvedError === undefined
        ? { status: 'partial', text: extracted.text, reason }
        : { status: 'partial', text: extracted.text, reason, error: resolvedError }
    }
    const cancelTransport = () => {
      cancelRequested = true
      handle?.cancel()
    }
    onAbort = () => {
      if (settled) return
      finish(partialOrEmpty('stopped'))
      cancelTransport()
    }
    if (opts.signal?.aborted) {
      onAbort()
      return
    }
    handle = opts.transport.stream(
      { system: opts.system, messages: [{ role: 'user', text: opts.user }], tools: [] },
      {
        onDelta: (delta) => {
          if (settled) return
          raw += delta
          if (raw.length > maxChars) {
            finish(partialOrEmpty('max_tokens', `output exceeded ${maxChars} chars`))
            cancelTransport()
            return
          }
          progressRaw = raw
          scheduleProgress()
        },
        onToolCall: () => undefined,
        onStopReason: (reason) => {
          stopReason = reason
        },
        onDone: () => {
          if (settled) return
          const { text, complete, error: extractError } = safeExtract(raw)
          const finished =
            extractError === undefined &&
            (complete ?? (stopReason !== 'max_tokens' && text.trim() !== ''))
          if (finished) finish({ status: 'complete', text })
          else if (stopReason === 'max_tokens') finish(partialOrEmpty('max_tokens', extractError))
          else
            finish(
              partialOrEmpty(
                'error',
                extractError ?? (complete === undefined ? 'empty reply' : undefined),
              ),
            )
        },
        onError: (error) => finish(partialOrEmpty('error', error)),
      },
    )
    if (settled) {
      if (cancelRequested) handle.cancel()
    } else if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
