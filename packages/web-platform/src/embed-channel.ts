/**
 * The iframe side of the @seuoffice/embed protocol. The page announces
 * `ready` to its parent, takes the first `open` from an allowed origin and
 * answers `opened` or `error` to that origin. In edit mode the page sends
 * `save` with the document's bytes and waits for `saved` or `save_failed`;
 * it reports `dirty` changes, and answers the host's `request_save` with
 * `request_save_done` after running its own save.
 */

export const EMBED_SOURCE = 'seuoffice'
export const EMBED_VERSION = 1

export type EmbedOpenErrorCode = 'unsupported_format' | 'too_large' | 'open_failed'

export interface EmbedOpen {
  fileName: string
  bytes: ArrayBuffer
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
    resolve({ fileName: data.fileName, bytes: data.bytes })
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
