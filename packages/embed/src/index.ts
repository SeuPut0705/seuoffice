/**
 * Open a document in a seuoffice iframe from its bytes and file name.
 *
 * The iframe page announces `ready`; this side answers with `open` carrying
 * the bytes, and the page reports `opened` or `error`. Messages are accepted
 * only from the iframe's own window at the seuoffice origin.
 *
 * In edit mode the host has taken the document's edit lock before calling
 * `openDocument`; the page sends `save` with new bytes, this side runs
 * `onSave` and answers `saved` or `save_failed`. `dirty` reports unsaved
 * changes, and `save()` asks the page to save (`request_save`).
 *
 * With `ai`, the `open` message says the host offers AI. The page sends
 * `ai_request` with a gateway-complete request body (decision 0009); this
 * side hands it to `ai.request`, which adds the host's own token and calls
 * the gateway, and streams the answer back as `ai_chunk` bytes, then
 * `ai_end`, or `ai_error` (with the HTTP status for a non-2xx answer).
 * `ai_cancel` aborts that request; `destroy()` aborts every request.
 */

export type SeuofficeApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'hwp'

const APP_BY_EXTENSION: ReadonlyMap<string, SeuofficeApp> = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docs'],
  ['xlsx', 'sheets'],
  ['pptx', 'slides'],
  ['hwp', 'hwp'],
  ['hwpx', 'hwp'],
])

/** The suite app that opens this file, by extension; null when none does */
export function appForFileName(fileName: string): SeuofficeApp | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return null
  return APP_BY_EXTENSION.get(fileName.slice(dot + 1).toLowerCase()) ?? null
}

export const MAX_EMBED_BYTES = 50 * 1024 * 1024

export type EmbedErrorCode =
  'unsupported_format' | 'too_large' | 'open_failed' | 'timeout' | 'save_failed'

export class SeuofficeEmbedError extends Error {
  readonly code: EmbedErrorCode

  constructor(code: EmbedErrorCode, message: string) {
    super(message)
    this.name = 'SeuofficeEmbedError'
    this.code = code
  }
}

interface BaseOpenOptions {
  /** where the seuoffice web build is served, e.g. https://office.example/ */
  baseUrl: string
  bytes: ArrayBuffer | Uint8Array
  fileName: string
  lang?: string
  /** how long to wait for the page to announce itself; default 30000 */
  readyTimeoutMs?: number
  /** offer AI to the page; without it the page shows AI as not connected */
  ai?: AiRelay
}

/**
 * The host's call to its AI gateway. `body` is the page's gateway-complete
 * request body (OpenAI chat completions); the host adds its own token, posts
 * it, and returns the gateway's response. Abort the request when `signal`
 * aborts. The page never sees the token.
 */
export interface AiRelay {
  request(body: unknown, signal: AbortSignal): Promise<Response>
}

/** A document the page saved: same format and file name it was opened with */
export interface SavedFile {
  fileName: string
  bytes: Uint8Array
}

export interface ViewOptions extends BaseOpenOptions {
  mode?: 'view'
}

export interface EditOptions extends BaseOpenOptions {
  /** open for editing; the host holds the edit lock for this document */
  mode: 'edit'
  /** store the saved bytes; resolve when stored, reject with the reason it was not */
  onSave: (file: SavedFile) => Promise<void>
  /** called when the page gains or loses unsaved changes */
  onDirtyChange?: (dirty: boolean) => void
}

export type OpenOptions = ViewOptions | EditOptions

export interface EmbeddedDocument {
  readonly iframe: HTMLIFrameElement
  /** settles once the document is on screen, or rejects with SeuofficeEmbedError */
  readonly opened: Promise<void>
  /**
   * Ask the page to save now; settles after `onSave` stored the bytes.
   * Rejects with `save_failed` in view mode, before the document opened, or
   * when the page or `onSave` failed.
   */
  save(): Promise<void>
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
    return {
      iframe,
      opened,
      save: () => Promise.reject(notSaved('the document did not open')),
      destroy: () => iframe.remove(),
    }
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
  const mode = options.mode ?? 'view'
  const editing = options.mode === 'edit' ? options : undefined
  const query = new URLSearchParams({ mode, lang: options.lang ?? 'ko' })
  iframe.src = new URL(`${app}/index.html?${query}`, base).href
  iframe.style.width = '100%'
  iframe.style.height = '100%'
  iframe.style.border = '0'

  let settled = false
  let sent = false
  let shown = false
  let nextRequestId = 1
  // one store at a time, in arrival order: a slow older save must never land after a newer one
  let storing = Promise.resolve()
  const saveRequests = new Map<
    number,
    { resolve: () => void; reject: (error: SeuofficeEmbedError) => void }
  >()
  // in-flight AI requests by the page's request id; aborting one ends its host fetch
  const aiRequests = new Map<string, AbortController>()
  const post = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    iframe.contentWindow?.postMessage(
      { source: SOURCE, version: VERSION, ...message },
      { targetOrigin: base.origin, transfer },
    )
  }
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
        {
          source: SOURCE,
          version: VERSION,
          type: 'open',
          fileName: options.fileName,
          bytes,
          ai: options.ai !== undefined,
        },
        base.origin,
        [bytes],
      )
    } else if (data.type === 'opened') {
      shown = true
      settle()
    } else if (data.type === 'error') {
      const code = isPageErrorCode(data.code) ? data.code : 'open_failed'
      settle(new SeuofficeEmbedError(code, String(data.message ?? code)))
    } else if (data.type === 'save' && editing) {
      storing = storing.then(() => store(editing, data, post))
    } else if (data.type === 'dirty' && editing && typeof data.dirty === 'boolean') {
      editing.onDirtyChange?.(data.dirty)
    } else if (data.type === 'request_save_done' && typeof data.requestId === 'number') {
      const request = saveRequests.get(data.requestId)
      if (!request) return
      saveRequests.delete(data.requestId)
      if (data.ok === true) request.resolve()
      else request.reject(notSaved(String(data.message ?? 'the page did not save')))
    } else if (data.type === 'ai_request' && sent && typeof data.requestId === 'string') {
      const requestId = data.requestId
      if (aiRequests.has(requestId)) return
      if (!options.ai) {
        post({ type: 'ai_error', requestId, message: 'this host does not offer AI' })
        return
      }
      const controller = new AbortController()
      aiRequests.set(requestId, controller)
      void relayAi(options.ai, requestId, data.body, controller.signal, post).finally(() => {
        if (aiRequests.get(requestId) === controller) aiRequests.delete(requestId)
      })
    } else if (data.type === 'ai_cancel' && typeof data.requestId === 'string') {
      aiRequests.get(data.requestId)?.abort()
      aiRequests.delete(data.requestId)
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
    save: () => {
      if (mode !== 'edit') return Promise.reject(notSaved('the document was opened for viewing'))
      if (!shown) return Promise.reject(notSaved('the document is not open yet'))
      const requestId = nextRequestId++
      const done = new Promise<void>((resolve, reject) =>
        saveRequests.set(requestId, { resolve, reject }),
      )
      post({ type: 'request_save', requestId })
      return done
    },
    destroy: () => {
      view.removeEventListener('message', onMessage)
      clearTimeout(timer)
      for (const request of saveRequests.values())
        request.reject(notSaved('the document was closed'))
      saveRequests.clear()
      for (const controller of aiRequests.values()) controller.abort()
      aiRequests.clear()
      iframe.remove()
    },
  }
}

async function store(
  options: EditOptions,
  data: Record<string, unknown>,
  post: (message: Record<string, unknown>) => void,
): Promise<void> {
  const saveId = data.saveId
  if (typeof saveId !== 'number' || !(data.bytes instanceof ArrayBuffer)) return
  try {
    // the page saves under the name it opened; a different name is not this document
    await options.onSave({ fileName: options.fileName, bytes: new Uint8Array(data.bytes) })
    post({ type: 'saved', saveId })
  } catch (error) {
    post({
      type: 'save_failed',
      saveId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** an error answer's body is cut to this many characters before it goes to the page */
const MAX_AI_ERROR_CHARS = 64 * 1024

/**
 * One AI request: the host's response streamed to the page as raw bytes.
 * Nothing is posted after an abort: the page cancelled, or the frame is gone.
 */
async function relayAi(
  ai: AiRelay,
  requestId: string,
  body: unknown,
  signal: AbortSignal,
  post: (message: Record<string, unknown>, transfer?: Transferable[]) => void,
): Promise<void> {
  try {
    const response = await ai.request(body, signal)
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {})
      return
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (!signal.aborted) {
        post({
          type: 'ai_error',
          requestId,
          status: response.status,
          message: text.slice(0, MAX_AI_ERROR_CHARS),
        })
      }
      return
    }
    if (response.body) {
      const reader = response.body.getReader()
      // a cancel stops the read even when the host's fetch ignored the signal
      const stop = (): void => void reader.cancel().catch(() => {})
      signal.addEventListener('abort', stop, { once: true })
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done || signal.aborted) break
          // a fresh copy the page owns: the reader may reuse or share its buffer
          const data = new Uint8Array(value)
          post({ type: 'ai_chunk', requestId, data }, [data.buffer])
        }
      } finally {
        signal.removeEventListener('abort', stop)
      }
    }
    if (!signal.aborted) post({ type: 'ai_end', requestId })
  } catch (error) {
    if (signal.aborted) return
    post({
      type: 'ai_error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function notSaved(message: string): SeuofficeEmbedError {
  return new SeuofficeEmbedError('save_failed', message)
}

function isPageErrorCode(code: unknown): code is EmbedErrorCode {
  return code === 'unsupported_format' || code === 'too_large' || code === 'open_failed'
}
