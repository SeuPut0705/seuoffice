/**
 * The iframe side of the @seuoffice/embed protocol. The page announces
 * `ready` to its parent, takes the first `open` from an allowed origin and
 * answers `opened` or `error` to that origin. In edit mode the page sends
 * `save` with the document's bytes and waits for `saved` or `save_failed`;
 * it reports `dirty` changes, and answers the host's `request_save` with
 * `request_save_done` after running its own save.
 *
 * When `open` says the host offers AI, `requestAiFromHost` sends one
 * gateway-complete request body as `ai_request`; the host answers with raw
 * SSE bytes in `ai_chunk`, then `ai_end`, or `ai_error`, and the page sends
 * `ai_cancel` when it stops reading.
 */

export const EMBED_SOURCE = 'seuoffice'
export const EMBED_VERSION = 1

export type EmbedOpenErrorCode = 'unsupported_format' | 'too_large' | 'open_failed'

export interface EmbedOpen {
  fileName: string
  bytes: ArrayBuffer
  /** the host relays AI requests to its gateway (`ai_request`) */
  ai: boolean
}

interface Peer {
  target: Window
  origin: string
}

let started: Promise<EmbedOpen | null> | undefined
let peer: Peer | undefined
let opened = false
let lastDirty: boolean | undefined
let nextSaveId = 1
const pendingSaves = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
let saveRequestHandler: (() => Promise<void>) | undefined

/**
 * One AI request to the host: `waiting` until the first answer settles the
 * fetch-shaped promise, then `streaming` into the response body.
 */
type AiRequestState =
  | {
      phase: 'waiting'
      resolve: (response: Response) => void
      reject: (error: Error) => void
      body: ReadableStreamDefaultController<Uint8Array>
      response: Response
    }
  | { phase: 'streaming'; body: ReadableStreamDefaultController<Uint8Array> }
const aiRequests = new Map<string, AiRequestState>()

/** Origins allowed to send `open`: this page's own and the build-time list */
export function allowedOrigins(): Set<string> {
  const configured = String(import.meta.env?.VITE_SEUOFFICE_EMBED_ORIGINS ?? '')
  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  return new Set([location.origin, ...origins])
}

/** First accepted `open`, or null when the page is not framed */
export function receiveOpen(): Promise<EmbedOpen | null> {
  started ??= listen()
  return started
}

function listen(): Promise<EmbedOpen | null> {
  if (window.parent === window) return Promise.resolve(null)
  // the suite apps compile this file against ES2022, which has no Promise.withResolvers
  let resolve!: (open: EmbedOpen | null) => void
  const promise = new Promise<EmbedOpen | null>((settle) => (resolve = settle))
  const allowed = allowedOrigins()
  const onOpen = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | null
    if (!data || data.source !== EMBED_SOURCE || data.version !== EMBED_VERSION) return
    if (data.type !== 'open' || !allowed.has(event.origin)) return
    if (typeof data.fileName !== 'string' || !(data.bytes instanceof ArrayBuffer)) return
    window.removeEventListener('message', onOpen)
    peer = { target: event.source as Window, origin: event.origin }
    window.addEventListener('message', onHostMessage)
    resolve({ fileName: data.fileName, bytes: data.bytes, ai: data.ai === true })
  }
  window.addEventListener('message', onOpen)
  // ready carries no data, so any parent may hear it
  window.parent.postMessage({ source: EMBED_SOURCE, version: EMBED_VERSION, type: 'ready' }, '*')
  return promise
}

/** Messages after `open`: only from the window and origin that sent it */
function onHostMessage(event: MessageEvent): void {
  if (!peer || event.source !== peer.target || event.origin !== peer.origin) return
  const data = event.data as Record<string, unknown> | null
  if (!data || data.source !== EMBED_SOURCE || data.version !== EMBED_VERSION) return
  if (data.type === 'saved' || data.type === 'save_failed') {
    const id = data.saveId
    const pending = typeof id === 'number' ? pendingSaves.get(id) : undefined
    if (!pending) return
    pendingSaves.delete(id as number)
    if (data.type === 'saved') pending.resolve()
    else pending.reject(new Error(String(data.message ?? 'the host did not save the document')))
  } else if (data.type === 'request_save' && typeof data.requestId === 'number') {
    void answerSaveRequest(data.requestId)
  } else if (
    (data.type === 'ai_chunk' || data.type === 'ai_end' || data.type === 'ai_error') &&
    typeof data.requestId === 'string'
  ) {
    onAiAnswer(data.requestId, data)
  }
}

async function answerSaveRequest(requestId: number): Promise<void> {
  try {
    if (!saveRequestHandler) throw new Error('this document cannot be saved here')
    await saveRequestHandler()
    reply({ type: 'request_save_done', requestId, ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    reply({ type: 'request_save_done', requestId, ok: false, message })
  }
}

/** The host's answer to one AI request, in arrival order */
function onAiAnswer(requestId: string, data: Record<string, unknown>): void {
  const state = aiRequests.get(requestId)
  if (!state) return
  if (data.type === 'ai_error') {
    aiRequests.delete(requestId)
    const message = String(data.message ?? 'the host could not reach the AI gateway')
    if (state.phase === 'streaming') {
      state.body.error(new Error(message))
    } else if (typeof data.status === 'number' && data.status >= 200 && data.status <= 599) {
      // the gateway's refusal reaches the protocol as that HTTP answer, as on the desktop
      state.body.close()
      state.resolve(new Response(message, { status: data.status }))
    } else {
      // the host's request failed before an answer: what a failed fetch looks like
      state.body.close()
      state.reject(new TypeError(message))
    }
    return
  }
  if (state.phase === 'waiting') {
    aiRequests.set(requestId, { phase: 'streaming', body: state.body })
    state.resolve(state.response)
  }
  if (data.type === 'ai_chunk' && ArrayBuffer.isView(data.data)) {
    // isView, not instanceof: the bytes may come from another realm's Uint8Array
    const { buffer, byteOffset, byteLength } = data.data
    state.body.enqueue(new Uint8Array(buffer, byteOffset, byteLength))
  } else if (data.type === 'ai_end') {
    aiRequests.delete(requestId)
    state.body.close()
  }
}

function abortError(): Error {
  return new DOMException('The AI request was cancelled', 'AbortError')
}

/**
 * Send one gateway-complete request body to the host and read its answer as
 * a fetch Response: the SSE bytes stream into the body as they arrive. A
 * non-2xx gateway answer resolves with that status and the gateway's text; a
 * host that could not call the gateway rejects like a failed fetch. Aborting
 * `signal` or cancelling the body tells the host to stop (`ai_cancel`).
 */
export function requestAiFromHost(body: unknown, signal?: AbortSignal | null): Promise<Response> {
  if (!peer) return Promise.reject(new TypeError('no host to ask: the page is not embedded'))
  if (signal?.aborted) return Promise.reject(abortError())
  const requestId = crypto.randomUUID()
  const cancel = (): void => {
    if (!aiRequests.delete(requestId)) return
    reply({ type: 'ai_cancel', requestId })
  }
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel,
  })
  const response = new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  const settled = new Promise<Response>((resolve, reject) =>
    aiRequests.set(requestId, { phase: 'waiting', resolve, reject, body: controller, response }),
  )
  signal?.addEventListener(
    'abort',
    () => {
      const state = aiRequests.get(requestId)
      if (!state) return
      cancel()
      if (state.phase === 'waiting') state.reject(abortError())
      state.body.error(abortError())
    },
    { once: true },
  )
  reply({ type: 'ai_request', requestId, body })
  return settled
}

function reply(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  if (!peer) return
  peer.target.postMessage(
    { source: EMBED_SOURCE, version: EMBED_VERSION, ...message },
    { targetOrigin: peer.origin, transfer },
  )
}

/** Tell the host the document is on screen; later calls do nothing */
export function reportOpened(): void {
  if (opened) return
  opened = true
  reply({ type: 'opened' })
}

/** Tell the host the document could not be shown */
export function reportError(code: EmbedOpenErrorCode, message: string): void {
  reply({ type: 'error', code, message })
}

/**
 * Hand the document's bytes to the host, which stores them. Settles when the
 * host answers: resolves on `saved`, rejects with the host's message.
 */
export function saveToHost(fileName: string, bytes: Uint8Array): Promise<void> {
  if (!peer) return Promise.reject(new Error('no host to save to: the page is not embedded'))
  const saveId = nextSaveId++
  // an exact fresh copy the page can transfer without losing its own
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const settled = new Promise<void>((resolve, reject) =>
    pendingSaves.set(saveId, { resolve, reject }),
  )
  reply({ type: 'save', saveId, fileName, bytes: copy.buffer }, [copy.buffer])
  return settled
}

/** Tell the host whether the document has unsaved changes; repeats are dropped */
export function reportDirty(dirty: boolean): void {
  if (dirty === lastDirty) return
  lastDirty = dirty
  reply({ type: 'dirty', dirty })
}

/** The app's own save, run when the host asks for one (`request_save`) */
export function onHostSaveRequest(handler: () => Promise<void>): void {
  saveRequestHandler = handler
}
