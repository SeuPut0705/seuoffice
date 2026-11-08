/**
 * Open a document in a seuoffice iframe from its bytes and file name.
 *
 * The iframe page announces `ready`; this side answers with `open` carrying
 * the bytes, and the page reports `opened` or `error`. Messages are accepted
 * only from the iframe's own window at the seuoffice origin.
 */

export type SeuofficeApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'hwp'

const APP_BY_EXTENSION: Record<string, SeuofficeApp> = {
  pdf: 'pdf',
  docx: 'docs',
  xlsx: 'sheets',
  pptx: 'slides',
  hwp: 'hwp',
  hwpx: 'hwp',
}

/** The suite app that opens this file, by extension; null when none does */
export function appForFileName(fileName: string): SeuofficeApp | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return null
  return APP_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null
}

export const MAX_EMBED_BYTES = 50 * 1024 * 1024

export type EmbedErrorCode = 'unsupported_format' | 'too_large' | 'open_failed' | 'timeout'

export class SeuofficeEmbedError extends Error {
  readonly code: EmbedErrorCode

  constructor(code: EmbedErrorCode, message: string) {
    super(message)
    this.name = 'SeuofficeEmbedError'
    this.code = code
  }
}

export interface OpenOptions {
  /** where the seuoffice web build is served, e.g. https://office.example/ */
  baseUrl: string
  bytes: ArrayBuffer | Uint8Array
  fileName: string
  mode?: 'view'
  lang?: string
  /** how long to wait for the page to announce itself; default 30000 */
  readyTimeoutMs?: number
}

export interface EmbeddedDocument {
  readonly iframe: HTMLIFrameElement
  /** settles once the document is on screen, or rejects with SeuofficeEmbedError */
  readonly opened: Promise<void>
  destroy(): void
}

const SOURCE = 'seuoffice'
const VERSION = 1

export function openDocument(container: HTMLElement, options: OpenOptions): EmbeddedDocument {
  const iframe = container.ownerDocument.createElement('iframe')
  const app = appForFileName(options.fileName)
  const refusal = !app
    ? new SeuofficeEmbedError('unsupported_format', `no seuoffice app opens ${options.fileName}`)
    : options.bytes.byteLength > MAX_EMBED_BYTES
      ? new SeuofficeEmbedError(
          'too_large',
          `${options.fileName} is ${options.bytes.byteLength} bytes; the limit is ${MAX_EMBED_BYTES}`,
        )
      : null
  if (refusal) {
    const opened = Promise.reject(refusal)
    // a rejection the host never awaits must not surface as unhandled
    opened.catch(() => {})
    return { iframe, opened, destroy: () => iframe.remove() }
  }

  // hosts may compile against ES2022, which has no Promise.withResolvers
  let resolve!: () => void
  let reject!: (error: SeuofficeEmbedError) => void
  const opened = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  opened.catch(() => {})
  const view = container.ownerDocument.defaultView ?? window
  const base = new URL(options.baseUrl)
  const query = new URLSearchParams({ mode: options.mode ?? 'view', lang: options.lang ?? 'ko' })
  iframe.src = new URL(`${app}/index.html?${query}`, base).href
  iframe.style.width = '100%'
  iframe.style.height = '100%'
  iframe.style.border = '0'

  let settled = false
  let sent = false
  const settle = (error?: SeuofficeEmbedError): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) reject(error)
    else resolve()
  }

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow || event.origin !== base.origin) return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.source !== SOURCE || data.version !== VERSION) return
    if (data.type === 'ready' && !sent) {
      sent = true
      clearTimeout(timer)
      // an exact fresh copy: a view's slice() may share its backing buffer (Buffer#slice does)
      const source =
        options.bytes instanceof ArrayBuffer
          ? new Uint8Array(options.bytes)
          : new Uint8Array(options.bytes.buffer, options.bytes.byteOffset, options.bytes.byteLength)
      const copy = new Uint8Array(source.byteLength)
      copy.set(source)
      const bytes = copy.buffer
      iframe.contentWindow!.postMessage(
        { source: SOURCE, version: VERSION, type: 'open', fileName: options.fileName, bytes },
        base.origin,
        [bytes],
      )
    } else if (data.type === 'opened') {
      settle()
    } else if (data.type === 'error') {
      const code = isPageErrorCode(data.code) ? data.code : 'open_failed'
      settle(new SeuofficeEmbedError(code, String(data.message ?? code)))
    }
  }

  view.addEventListener('message', onMessage)
  const timer = setTimeout(
    () => settle(new SeuofficeEmbedError('timeout', 'the seuoffice page did not answer in time')),
    options.readyTimeoutMs ?? 30000,
  )
  container.appendChild(iframe)
  return {
    iframe,
    opened,
    destroy: () => {
      view.removeEventListener('message', onMessage)
      clearTimeout(timer)
      iframe.remove()
    },
  }
}

function isPageErrorCode(code: unknown): code is EmbedErrorCode {
  return code === 'unsupported_format' || code === 'too_large' || code === 'open_failed'
}
