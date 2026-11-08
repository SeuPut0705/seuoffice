/**
 * Reading one page with the AI (spec §7): send the page image and the
 * instruction, check the answer, ask once more when it is malformed, and give
 * the page up as failed when the second answer is malformed too. Errors of
 * the call itself (network, rate limit, …) are not answers: they propagate
 * so the job engine retries or stops by its own rules.
 *
 * `createAiReadCallModel` is the `callModel` of `startAiReadJob`.
 */
import { JobUnitFailure } from '../jobs/errors'
import type { AiReadJobUnit, AiReadPageRef } from '../jobs/ai-read'
import type { AiPageReading, AiReadPagePayload } from './content'
import { buildAiReadRequest, type AiReadRequest } from './instruction'
import { parseAiPageResponse } from './parse'
import type { AiReadRepetitionTuning } from './repetition'

/** the JobUnitFailure reason of a page whose answers stayed malformed */
export const AI_READ_MALFORMED_REASON = 'malformed-response'

/**
 * One model call: send the request (system, one user turn with the image,
 * no tools) and resolve with the answer text. The caller routes it through
 * `ai:stream` / `streamForProvider`; it must give up when the signal aborts.
 */
export type AiReadAsk = (request: AiReadRequest, signal: AbortSignal) => Promise<string>

export interface ReadAiPageOptions {
  page: number
  pageFingerprint: string
  /** the rendered page image */
  image: Uint8Array
  /** default 'image/png' */
  mime?: 'image/png' | 'image/jpeg'
  ask: AiReadAsk
  signal?: AbortSignal
  repetition?: Partial<AiReadRepetitionTuning>
}

const never = new AbortController().signal

/** read one page; throws JobUnitFailure(AI_READ_MALFORMED_REASON) after two malformed answers */
export async function readAiPage(o: ReadAiPageOptions): Promise<AiPageReading> {
  const signal = o.signal ?? never
  const image = { image: o.image, ...(o.mime ? { mime: o.mime } : {}) }
  const at = { page: o.page, pageFingerprint: o.pageFingerprint, repetition: o.repetition }

  const first = parseAiPageResponse(await o.ask(buildAiReadRequest(image), signal), at)
  if (first.ok) return first.reading
  signal.throwIfAborted()

  const again = buildAiReadRequest({ ...image, problems: first.problems })
  const second = parseAiPageResponse(await o.ask(again, signal), { ...at, reasked: true })
  if (second.ok) return second.reading
  throw new JobUnitFailure(
    AI_READ_MALFORMED_REASON,
    `page ${o.page}: the AI answer stayed malformed (${second.problems.join(', ')})`,
  )
}

/** a rendered page: bytes (PNG) or bytes with their type */
export type AiReadRenderedPage = Uint8Array | { data: Uint8Array; mime: 'image/png' | 'image/jpeg' }

export interface AiReadCallModelOptions<P extends AiReadPageRef> {
  /** render the page image (150–200 dpi); the caller owns rendering */
  renderPage: (page: P, signal: AbortSignal) => Promise<AiReadRenderedPage>
  ask: AiReadAsk
  repetition?: Partial<AiReadRepetitionTuning>
}

/**
 * `callModel` for `startAiReadJob`: reads the unit's first page (pages in a
 * unit share their content) and returns the payload the store keeps.
 */
export function createAiReadCallModel<P extends AiReadPageRef>(
  o: AiReadCallModelOptions<P>,
): (unit: AiReadJobUnit<P>, signal: AbortSignal) => Promise<AiReadPagePayload> {
  return async (unit, signal) => {
    const page = unit.pages[0]
    if (!page) throw new JobUnitFailure('no-page', 'an AI-read unit without pages')
    const rendered = await o.renderPage(page, signal)
    const image =
      rendered instanceof Uint8Array
        ? { image: rendered }
        : { image: rendered.data, mime: rendered.mime }
    const reading = await readAiPage({
      ...image,
      page: page.page,
      pageFingerprint: unit.pageFingerprint,
      ask: o.ask,
      signal,
      ...(o.repetition ? { repetition: o.repetition } : {}),
    })
    return reading.payload
  }
}
