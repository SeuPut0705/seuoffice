/**
 * The shell's {@link Transport} over Tauri 3's webview IPC (the stage 3 shell
 * contract, section 2):
 *
 * - `invoke` and `send` are the commands `ipc_invoke` and `ipc_send`, with the
 *   frame of wire.ts as the raw request body;
 * - `listen` hands the view's output stream, a Tauri `Channel`, to the command
 *   `ipc_listen`; replies and events arrive on it in the order the shell sent
 *   them, as `ArrayBuffer` frames;
 * - `sendSync` and the drop paths are synchronous XHRs to the scheme
 *   `seuoffice-ipc` (the shell answers them on its core thread).
 *
 * Tauri's own scripts run first, so `window.__TAURI_INTERNALS__` is there.
 * Every call here goes through the reference captured at load.
 */
import type { Transport } from './electron'
import { Encoder, decode, frame as buildFrame, unframe } from './wire'

interface RawChannelMessage {
  index: number
  message?: ArrayBuffer
  end?: boolean
}

interface TauriInternals {
  invoke(cmd: string, args?: unknown, options?: unknown): Promise<unknown>
  transformCallback(callback: (data: RawChannelMessage) => void, once?: boolean): number
  unregisterCallback(id: number): void
  convertFileSrc(path: string, protocol?: string): string
}

/** The scheme of the synchronous requests (crates/shell/src/ipc/sync.rs) */
const SYNC_SCHEME = 'seuoffice-ipc'

/**
 * Takes the Tauri internals for the bridge and takes them off the page's
 * enumerable globals. They cannot be deleted: Tauri's own `invoke` reads
 * `window.__TAURI_INTERNALS__` on every call (scripts/core.js), so the
 * property stays, only no longer listed. The shell's webviews hold no
 * capability, so the page could call no Tauri plugin command through it
 * anyway; it can call the shell's three commands, which the surface check
 * of the dispatch guards in any case.
 */
function takeInternals(): TauriInternals {
  const holder = window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  const internals = holder.__TAURI_INTERNALS__
  if (!internals) throw new Error('the shell bridge found no __TAURI_INTERNALS__')
  try {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: internals,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  } catch {
    // already fixed by Tauri's script: nothing more to hide
  }
  return internals
}

/** A Tauri `Channel` as the JavaScript side of `@tauri-apps/api` builds it: messages carry their index and are handed on in order */
function orderedChannel(
  internals: TauriInternals,
  onMessage: (data: ArrayBuffer) => void,
): { toJSON(): string } {
  let next = 0
  let endIndex: number | undefined
  const pending = new Map<number, ArrayBuffer>()
  const id = internals.transformCallback((raw) => {
    if (raw.end) {
      if (raw.index === next) internals.unregisterCallback(id)
      else endIndex = raw.index
      return
    }
    if (raw.message === undefined) return
    if (raw.index !== next) {
      pending.set(raw.index, raw.message)
      return
    }
    onMessage(raw.message)
    next += 1
    for (let queued = pending.get(next); queued !== undefined; queued = pending.get(next)) {
      pending.delete(next)
      onMessage(queued)
      next += 1
    }
    if (next === endIndex) internals.unregisterCallback(id)
  })
  return { toJSON: () => `__CHANNEL__:${id}` }
}

/** A synchronous POST of `frame` to the shell's sync scheme; the answer's bytes */
function syncRequest(internals: TauriInternals, channel: string, frame: Uint8Array): Uint8Array {
  const xhr = new XMLHttpRequest()
  xhr.open('POST', internals.convertFileSrc(channel, SYNC_SCHEME), false)
  // a synchronous request in a window cannot set responseType: read the
  // bytes as text one char per byte instead
  xhr.overrideMimeType('text/plain; charset=x-user-defined')
  xhr.send(frame as unknown as XMLHttpRequestBodyInit)
  if (xhr.status !== 200) {
    throw new Error(`the shell refused '${channel}' (HTTP ${xhr.status})`)
  }
  const text = xhr.responseText
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

export function tauriTransport(): Transport & {
  /** `webFrame.setZoomFactor`, answered on the shell's core thread */
  setZoomFactor(factor: number): void
  zoomFactor(): number
} {
  const internals = takeInternals()
  let onFrame: ((frame: Uint8Array) => void) | undefined
  const channel = orderedChannel(internals, (data) => onFrame?.(new Uint8Array(data)))
  // commands go out one after another: the shell handles the messages of a
  // view in the order they were sent, and concurrent requests would not keep
  // it. The queue never rejects, so one failed command does not stop the rest.
  let queue: Promise<void> = Promise.resolve()
  const post = (cmd: string, args: unknown): void => {
    queue = queue
      .then(() => internals.invoke(cmd, args))
      .then(
        () => undefined,
        (error: unknown) => {
          console.error(`[shell bridge] ${cmd} failed`, error)
        },
      )
  }
  const request = (channelName: string, args: readonly unknown[]): unknown => {
    const answer = unframe(syncRequest(internals, channelName, frameOf(args)))
    const body = answer.header as { value?: unknown; error?: string }
    if (body.error !== undefined) throw new Error(body.error)
    return decode(body.value, answer.buffers)
  }

  return {
    invoke: (frame) => post('ipc_invoke', frame),
    send: (frame) => post('ipc_send', frame),
    sendSync: (channelName, frame) => syncRequest(internals, channelName, frame),
    listen(handler) {
      onFrame = handler
      // the first command: every later one waits behind it, so no reply can
      // come before the stream is open
      post('ipc_listen', { onFrame: channel })
    },
    droppedPaths: () => {
      const paths = request('webutils:dropped-paths', [])
      return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    },
    setZoomFactor: (factor) => void request('webframe:set-zoom-factor', [factor]),
    zoomFactor: () => {
      const factor = request('webframe:get-zoom-factor', [])
      return typeof factor === 'number' ? factor : 1
    },
  }
}

/** The frame of `{args}`: what the sync scheme takes */
function frameOf(args: readonly unknown[]): Uint8Array {
  const e = new Encoder()
  return buildFrame({ args: e.values(args) }, e.buffers)
}
