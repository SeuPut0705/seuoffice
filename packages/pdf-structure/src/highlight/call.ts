/**
 * The model call of the AI highlight job (reading-assist spec 4.6): one batch
 * in, the checked suggestions of each block out, in order.
 *
 * An answer that holds no highlight JSON is asked again once, like a
 * translation batch whose answer could not be read; when the second answer
 * cannot be read either, the call throws JobUnitFailure: nothing is stored,
 * the batch stays pending and resuming sends it again. An answer that can be
 * read is checked (check.ts): what is not usable is dropped and counted, and
 * a block the answer leaves out simply has no suggestions. Run errors from
 * `send` go to the job engine untouched; it retries or stops.
 */
import { JobUnitFailure } from '../jobs/errors'
import { checkHighlightAnswer, type CheckedSuggestion } from './check'
import { buildHighlightRequest, parseHighlightOutput, type HighlightLabelRef } from './prompt'

/** times a batch whose answer could not be read is asked again (spec 4.6: like translation) */
export const HIGHLIGHT_MAX_RESENDS = 1

export interface HighlightModelRequest {
  system: string
  prompt: string
  /** 0 for the first send, then 1 for the resend */
  attempt: number
}

/** one model call: the answer text, or a thrown run error */
export type HighlightSend = (request: HighlightModelRequest, signal: AbortSignal) => Promise<string>

export interface HighlightModelCallOptions {
  labels: readonly HighlightLabelRef[]
  send: HighlightSend
  /** default HIGHLIGHT_MAX_RESENDS */
  maxResends?: number
}

/** the checked answer for one batch */
export interface HighlightBatchResult {
  /** one entry per block of the batch, in order */
  blocks: { suggestions: CheckedSuggestion[] }[]
  /** entries in the answer that was used */
  received: number
  /** entries of it that were dropped */
  dropped: number
}

/** the `callModel` of startHighlightJob */
export function createHighlightModelCall<I extends { text: string }>(
  o: HighlightModelCallOptions,
): (batch: readonly I[], signal: AbortSignal) => Promise<HighlightBatchResult> {
  const maxResends = o.maxResends ?? HIGHLIGHT_MAX_RESENDS
  if (!Number.isInteger(maxResends) || maxResends < 0) {
    throw new RangeError(`highlight: invalid resend count ${maxResends}`)
  }
  return async (batch, signal) => {
    const blocks = batch.map((item, i) => ({ id: String(i + 1), text: item.text }))
    const request = buildHighlightRequest(o.labels, blocks)
    for (let attempt = 0; attempt <= maxResends; attempt++) {
      if (signal.aborted) throw signal.reason
      const answer = await o.send({ ...request, attempt }, signal)
      const items = parseHighlightOutput(answer)
      if (!items) continue
      const checked = checkHighlightAnswer(items, blocks, o.labels)
      return {
        blocks: blocks.map((b) => ({ suggestions: checked.byBlock.get(b.id) ?? [] })),
        received: checked.received,
        dropped: checked.dropped,
      }
    }
    throw new JobUnitFailure('unparseable-response')
  }
}
