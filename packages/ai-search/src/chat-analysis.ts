/**
 * Image analysis by showing the image to the AI provider the chat runs on:
 * one turn, no tools, the answer collected from the stream. The one-shot
 * chat call of @genoffice/ai-provider takes text only, so this goes through
 * the streaming router, which carries images for every provider.
 */

import {
  AiRunError,
  streamForProvider,
  type AiProviderConfig,
  type AiProviderId,
  type MediaBlob,
} from '@genoffice/ai-provider'

/** Images of one request, as sent inline to a chat model; larger sets belong to a key analysis provider. */
export const CHAT_ANALYSIS_MAX_BYTES = 20 * 1024 * 1024
/** Same budget as a key analysis provider gets. */
export const CHAT_ANALYSIS_TIMEOUT_MS = 300_000

const SYSTEM_PROMPT =
  'You are shown one or more images from an office document or from the user. Answer the request about them directly and completely, in plain text. You have no tools: do not try to call any.'

export async function analyzeImagesWithChatProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  input: { media: MediaBlob[]; requirements: string },
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const total = input.media.reduce((n, blob) => n + blob.bytes.byteLength, 0)
  if (total > CHAT_ANALYSIS_MAX_BYTES) {
    // refused whole: nothing is dropped or downscaled behind the user's back
    throw new Error(
      `The images are too large to show to the AI provider (${total} bytes, limit ${CHAT_ANALYSIS_MAX_BYTES}); analyze fewer or smaller images`,
    )
  }
  const images = input.media.map((blob) => ({
    base64: Buffer.from(blob.bytes).toString('base64'),
    mime: blob.mime,
  }))
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, CHAT_ANALYSIS_TIMEOUT_MS)
  let text = ''
  try {
    await streamForProvider(
      provider,
      config,
      SYSTEM_PROMPT,
      [{ role: 'user', text: input.requirements, images }],
      [],
      maxTokens,
      {
        signal: controller.signal,
        onDelta: (delta) => {
          text += delta
        },
        // no tools were offered; a call the model invents anyway has nothing to run
        onToolCall: () => {},
      },
    )
  } catch (err) {
    if (timedOut) throw new AiRunError('timeout', 'Image analysis timed out')
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (timedOut) throw new AiRunError('timeout', 'Image analysis timed out')
  if (signal?.aborted) throw new Error('Image analysis was cancelled')
  if (!text.trim()) throw new Error('The AI provider returned no analysis')
  return text
}
