/**
 * The iframe side of the @seuoffice/embed protocol. The page announces
 * `ready` to its parent, takes the first `open` from an allowed origin and
 * answers `opened` or `error` to that origin.
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
  const { promise, resolve } = Promise.withResolvers<EmbedOpen | null>()
  const allowed = allowedOrigins()
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | null
    if (!data || data.source !== EMBED_SOURCE || data.version !== EMBED_VERSION) return
    if (data.type !== 'open' || !allowed.has(event.origin)) return
    if (typeof data.fileName !== 'string' || !(data.bytes instanceof ArrayBuffer)) return
    window.removeEventListener('message', onMessage)
    peer = { target: event.source as Window, origin: event.origin }
    resolve({ fileName: data.fileName, bytes: data.bytes })
  }
  window.addEventListener('message', onMessage)
  // ready carries no data, so any parent may hear it
  window.parent.postMessage({ source: EMBED_SOURCE, version: EMBED_VERSION, type: 'ready' }, '*')
  return promise
}

function reply(message: Record<string, unknown>): void {
  if (!peer) return
  peer.target.postMessage({ source: EMBED_SOURCE, version: EMBED_VERSION, ...message }, peer.origin)
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
