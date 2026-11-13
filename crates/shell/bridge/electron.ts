/**
 * `electron` for the preloads in the stage 3 shell (the stage 3 shell
 * contract, sections 2 and 4). Each preload is bundled with `electron`
 * replaced by this module, unchanged otherwise; what it imports
 * (`ipcRenderer`, `contextBridge`, `webUtils`) behaves as Electron's did.
 *
 * Messages go out as frames of wire.ts over a {@link Transport}: the shell's
 * is the Tauri commands `ipc_invoke` and `ipc_send`, a synchronous request
 * to `seuoffice-ipc://sync/<channel>` for `sendSync`, and one output stream
 * per view that carries both the replies and the events, in order.
 *
 * Out:   invoke `{id, channel, args}` · send `{channel, args}` · sendSync `{args}`
 * In:    `{reply: id, value}` · `{reply: id, error: text}` · `{event: channel, args}`
 */
import { Encoder, WireError, decode, frame, unframe } from './wire'

export interface Transport {
  invoke(frame: Uint8Array): void
  send(frame: Uint8Array): void
  /** blocks until the shell answers: the frame of `{value}` or `{error}` */
  sendSync(channel: string, frame: Uint8Array): Uint8Array
  /** the view's output stream; called once */
  listen(onFrame: (frame: Uint8Array) => void): void
  /** the file paths of the latest drop on this view, in the drop's order */
  droppedPaths(): readonly string[]
}

type Listener = (event: IpcRendererEvent, ...args: unknown[]) => void
export interface IpcRendererEvent {
  sender: IpcRenderer
  senderId: number
}

/** Electron's text when a value cannot be cloned */
const UNCLONABLE = 'An object could not be cloned.'

function encodeFrame(head: Record<string, unknown>, args: readonly unknown[]): Uint8Array {
  const e = new Encoder()
  try {
    return frame({ ...head, args: e.values(args) }, e.buffers)
  } catch (err) {
    if (err instanceof WireError) throw new Error(UNCLONABLE)
    throw err
  }
}

export class IpcRenderer {
  private next = 1
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >()
  private readonly listeners = new Map<string, Listener[]>()

  constructor(private readonly transport: Transport) {
    transport.listen((bytes) => this.receive(bytes))
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const id = this.next++
    let bytes: Uint8Array
    try {
      bytes = encodeFrame({ id, channel }, args)
    } catch (err) {
      return Promise.reject(err)
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.invoke(bytes)
    })
  }

  send(channel: string, ...args: unknown[]): void {
    this.transport.send(encodeFrame({ channel }, args))
  }

  sendSync(channel: string, ...args: unknown[]): unknown {
    const { header, buffers } = unframe(this.transport.sendSync(channel, encodeFrame({}, args)))
    const answer = header as { value?: unknown; error?: string }
    if (answer.error !== undefined) throw new Error(answer.error)
    return decode(answer.value, buffers)
  }

  on(channel: string, listener: Listener): this {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener])
    return this
  }

  once(channel: string, listener: Listener): this {
    const once: Listener = (event, ...args) => {
      this.removeListener(channel, once)
      listener(event, ...args)
    }
    return this.on(channel, once)
  }

  removeListener(channel: string, listener: Listener): this {
    const list = this.listeners.get(channel)
    if (!list) return this
    const at = list.lastIndexOf(listener)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) this.listeners.delete(channel)
    return this
  }

  off(channel: string, listener: Listener): this {
    return this.removeListener(channel, listener)
  }

  removeAllListeners(channel?: string): this {
    if (channel === undefined) this.listeners.clear()
    else this.listeners.delete(channel)
    return this
  }

  private receive(bytes: Uint8Array): void {
    const { header, buffers } = unframe(bytes)
    const m = header as {
      reply?: number
      value?: unknown
      error?: string
      event?: string
      args?: unknown
    }
    if (typeof m.reply === 'number') {
      const waiting = this.pending.get(m.reply)
      if (!waiting) return
      this.pending.delete(m.reply)
      if (m.error !== undefined) waiting.reject(new Error(m.error))
      else waiting.resolve(decode(m.value, buffers))
      return
    }
    if (typeof m.event !== 'string') return
    const args = decode(m.args, buffers) as unknown[]
    const event: IpcRendererEvent = { sender: this, senderId: 0 }
    // a copy: a listener may remove itself (once) while the event runs
    for (const listener of [...(this.listeners.get(m.event) ?? [])]) {
      try {
        listener(event, ...args)
      } catch (err) {
        queueMicrotask(() => {
          throw err
        })
      }
    }
  }
}

/**
 * `contextBridge.exposeInMainWorld`: there is no isolated world in the
 * shell's webviews, so the API is fixed on `window` directly. Every page the
 * shell loads is one of ours (the contract, section 2, "permissions").
 */
export function makeContextBridge(target: object) {
  return {
    exposeInMainWorld(name: string, api: unknown): void {
      Object.defineProperty(target, name, {
        value: api,
        enumerable: true,
        writable: false,
        configurable: false,
      })
    },
  }
}

/**
 * `webUtils.getPathForFile`: a CEF `File` has no path. The shell hands the
 * paths of a drop in the order the OS gave them, which is also the order of
 * the drop's `dataTransfer.files`; this pairs them up.
 */
export function makeWebUtils(transport: Transport, target: EventTarget) {
  let dropped: readonly File[] = []
  target.addEventListener(
    'drop',
    (event) => {
      dropped = Array.from((event as DragEvent).dataTransfer?.files ?? [])
    },
    true,
  )
  return {
    getPathForFile(file: File): string {
      const at = dropped.indexOf(file)
      return at >= 0 ? (transport.droppedPaths()[at] ?? '') : ''
    },
  }
}
