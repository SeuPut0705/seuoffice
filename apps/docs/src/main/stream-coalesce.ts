/**
 * Text and reasoning deltas of an AI stream, gathered for a short window and
 * sent to the renderer as one chunk. A provider can emit a delta per token;
 * one IPC message per token meant one chat re-render per token in every
 * editor's panel. Any other chunk (a tool call, usage, a ping, done, an error)
 * first sends what is gathered, so the renderer sees the same order. A switch
 * between text and reasoning sends too, so the two never merge.
 */

export interface CoalescedChunk {
  requestId: string
  type: string
  text?: string
}

export interface ChunkCoalescer<T extends CoalescedChunk> {
  /** pass a chunk on: deltas are gathered, anything else goes out after them */
  push(chunk: T): void
  /** send what is gathered now (end of the stream) */
  flush(): void
}

/** gather window; two frames at 60 Hz */
export const STREAM_COALESCE_MS = 32

const MERGED_TYPES = new Set(['delta', 'reasoning'])

export function createChunkCoalescer<T extends CoalescedChunk>(
  send: (chunk: T) => void,
  windowMs: number = STREAM_COALESCE_MS,
): ChunkCoalescer<T> {
  let pending: T | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const out = pending
    pending = null
    if (out) send(out)
  }
  return {
    push(chunk) {
      if (!MERGED_TYPES.has(chunk.type) || typeof chunk.text !== 'string') {
        flush()
        send(chunk)
        return
      }
      if (pending && pending.type === chunk.type) {
        pending = { ...pending, text: `${pending.text ?? ''}${chunk.text}` }
        return
      }
      flush()
      pending = { ...chunk }
      timer = setTimeout(flush, windowMs)
    },
    flush,
  }
}
