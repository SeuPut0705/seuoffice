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
 *
 * `ready` says whether this page can co-edit (`registerCollabCapable`). When
 * `open` says the host relays co-editing, `collab_*` messages carry the
 * frames of the host's socket (see collab-link.ts).
 */

export const EMBED_SOURCE = 'seuoffice'
export const EMBED_VERSION = 1

export type EmbedOpenErrorCode = 'unsupported_format' | 'too_large' | 'open_failed'

export interface EmbedOpen {
  fileName: string
  bytes: ArrayBuffer
  /** the host relays AI requests to its gateway (`ai_request`) */
  ai: boolean
  /** the host relays co-editing frames (`collab_connect`) */
  collab: boolean
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
let collabCapable = false
let collabMessageHandler: ((data: Record<string, unknown>) => void) | undefined
let collabOffered = false

/** One piece of a host's answer, read by the response body in arrival order */
type AiAnswerPart =
  { kind: 'bytes'; bytes: Uint8Array } | { kind: 'end' } | { kind: 'error'; error: Error }

/**
 * One AI request to the host. `settle` answers the fetch-shaped promise with
 * the first message and is gone after that; `parts` feed the response body.
 * The request stays in `aiRequests` until its body is read to the end, so an
 * abort still drops bytes not read yet; `wireDone` marks that the host sent
 * its last message, after which nothing more from the host counts.
 */
interface AiRequest {
  settle: { resolve: (response: Response) => void; reject: (error: Error) => void } | undefined
  parts: AiAnswerPart[]
  wake: (() => void) | undefined
  body: ReadableStream<Uint8Array>
  wireDone: boolean
}
const aiRequests = new Map<string, AiRequest>()

/** The response headers the protocol code reads; the host sends no others */
const AI_HEADER_NAMES = ['content-type', 'retry-after']

function aiHeaders(value: unknown): Headers {
  const headers = new Headers()
  if (!value || typeof value !== 'object') return headers
  for (const name of AI_HEADER_NAMES) {
    const header: unknown = Reflect.get(value, name)
    if (typeof header === 'string') headers.set(name, header)
  }
  return headers
}

function pushAiPart(request: AiRequest, part: AiAnswerPart): void {
  request.parts.push(part)
  request.wake?.()
}

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
    // a page that goes away stops reading: the host should stop paying for the answers
    window.addEventListener('pagehide', cancelAllAiRequests)
    collabOffered = data.collab === true
    resolve({
      fileName: data.fileName,
      bytes: data.bytes,
      ai: data.ai === true,
      collab: collabOffered,
    })
  }
  window.addEventListener('message', onOpen)
  // ready carries only whether this page co-edits, so any parent may hear it
  window.parent.postMessage(
    { source: EMBED_SOURCE, version: EMBED_VERSION, type: 'ready', collab: collabCapable },
    '*',
  )
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
  } else if (typeof data.type === 'string' && data.type.startsWith('collab_')) {
    collabMessageHandler?.(data)
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
  const request = aiRequests.get(requestId)
  if (!request || request.wireDone) return
  const settle = request.settle
  request.settle = undefined
  if (data.type === 'ai_error') {
    request.wireDone = true
    const message = String(data.message ?? 'the host could not reach the AI gateway')
    if (!settle) {
      // after the bytes already sent: the protocol reads those first, then fails
      pushAiPart(request, { kind: 'error', error: new Error(message) })
    } else {
      // the body is never read: the request ends here
      aiRequests.delete(requestId)
      if (typeof data.status === 'number' && data.status >= 400 && data.status <= 599) {
        // the gateway's refusal reaches the protocol as that HTTP answer, as on the desktop
        settle.resolve(
          new Response(message, { status: data.status, headers: aiHeaders(data.headers) }),
        )
      } else {
        // the host's request failed before an answer: what a failed fetch looks like
        settle.reject(new TypeError(message))
      }
    }
    return
  }
  if (data.type !== 'ai_chunk' && data.type !== 'ai_end') return
  settle?.resolve(new Response(request.body, { status: 200, headers: aiHeaders(data.headers) }))
  if (data.type === 'ai_chunk' && ArrayBuffer.isView(data.data)) {
    // isView, not instanceof: the bytes may come from another realm's Uint8Array
    const { buffer, byteOffset, byteLength } = data.data
    pushAiPart(request, { kind: 'bytes', bytes: new Uint8Array(buffer, byteOffset, byteLength) })
  } else if (data.type === 'ai_end') {
    request.wireDone = true
    pushAiPart(request, { kind: 'end' })
  }
}

function abortError(): Error {
  return new DOMException('The AI request was cancelled', 'AbortError')
}

/** Stop one request here and tell the host: nothing it sends for it counts any more */
function cancelAiRequest(requestId: string): void {
  const request = aiRequests.get(requestId)
  if (!request) return
  aiRequests.delete(requestId)
  // a host that already finished has nothing left to stop
  if (!request.wireDone) reply({ type: 'ai_cancel', requestId })
  request.settle?.reject(abortError())
  request.settle = undefined
  // bytes not read yet are dropped: the reader sees the cancel next
  request.parts.length = 0
  pushAiPart(request, { kind: 'error', error: abortError() })
}

function cancelAllAiRequests(): void {
  for (const requestId of [...aiRequests.keys()]) cancelAiRequest(requestId)
}

/**
 * Send one gateway-complete request body to the host and read its answer as
 * a fetch Response: the SSE bytes stream into the body as they arrive, with
 * the content type and Retry-After the gateway sent. A non-2xx gateway answer
 * resolves with that status and the gateway's text; a host that could not
 * call the gateway rejects like a failed fetch. Aborting `signal`, cancelling
 * the body or leaving the page tells the host to stop (`ai_cancel`), and
 * drops bytes not read yet even when the host already finished sending.
 */
export function requestAiFromHost(body: unknown, signal?: AbortSignal | null): Promise<Response> {
  if (!peer) return Promise.reject(new TypeError('no host to ask: the page is not embedded'))
  if (signal?.aborted) return Promise.reject(abortError())
  const requestId = crypto.randomUUID()
  const request: AiRequest = {
    settle: undefined,
    parts: [],
    wake: undefined,
    wireDone: false,
    // pulled one part per read, so an error after some bytes lets the reader take those first
    body: new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (request.parts.length === 0) {
            await new Promise<void>((resolve) => (request.wake = resolve))
          }
          request.wake = undefined
          const part = request.parts.shift()!
          if (part.kind === 'bytes') {
            controller.enqueue(part.bytes)
            return
          }
          // the last part is read: nothing can cancel this request any more
          aiRequests.delete(requestId)
          if (part.kind === 'end') controller.close()
          else controller.error(part.error)
        },
        cancel: () => cancelAiRequest(requestId),
      },
      { highWaterMark: 0 },
    ),
  }
  const settled = new Promise<Response>((resolve, reject) => {
    request.settle = { resolve, reject }
  })
  aiRequests.set(requestId, request)
  signal?.addEventListener('abort', () => cancelAiRequest(requestId), { once: true })
  reply({ type: 'ai_request', requestId, body })
  return settled
}

export function reply(message: Record<string, unknown>, transfer: Transferable[] = []): void {
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
 * host answers: resolves on `saved`, rejects with the host's message. A
 * co-edited save names the exact version the bytes hold.
 */
export function saveToHost(
  fileName: string,
  bytes: Uint8Array,
  collab?: { version: number },
): Promise<void> {
  if (!peer) return Promise.reject(new Error('no host to save to: the page is not embedded'))
  const saveId = nextSaveId++
  // an exact fresh copy the page can transfer without losing its own
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const settled = new Promise<void>((resolve, reject) =>
    pendingSaves.set(saveId, { resolve, reject }),
  )
  const message: Record<string, unknown> = { type: 'save', saveId, fileName, bytes: copy.buffer }
  if (collab) message.collabVersion = collab.version
  reply(message, [copy.buffer])
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

/**
 * Declare that this app co-edits. Call it before anything asks for the
 * document: `ready` carries the answer, and the host decides from it.
 */
export function registerCollabCapable(): void {
  if (started) throw new Error('registerCollabCapable must run before the page announces ready')
  collabCapable = true
}

/** The host's `collab_*` messages, already checked to come from the host */
export function onCollabMessage(handler: (data: Record<string, unknown>) => void): void {
  collabMessageHandler = handler
}

/** Whether the host's `open` asked for co-editing; false before `open` */
export function hostRelaysCollab(): boolean {
  return collabOffered
}
