import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDocument, type CollabRelay, type WebSocketLike } from '../src/index'

const BASE = 'https://office.example/'
const ORIGIN = 'https://office.example'

type Listener = (event: { data?: unknown }) => void

class FakeSocket implements WebSocketLike {
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  sent: (string | ArrayBuffer)[] = []
  closed = false
  private listeners = new Map<string, Listener[]>()
  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

// a browser WebSocket must fit the shape the host passes in
export const browserSocketFits = (url: string): WebSocketLike => new WebSocket(url)

function post(source: Window | null, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin: ORIGIN,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

function openWith(options: { collab?: CollabRelay; onSave?: (file: unknown) => Promise<void> }) {
  const onSave = options.onSave ?? (async () => {})
  const doc = options.collab
    ? openDocument(document.body, {
        baseUrl: BASE,
        fileName: 'memo.docx',
        bytes: new Uint8Array([1]),
        mode: 'edit',
        collab: options.collab,
        onSave,
      })
    : openDocument(document.body, {
        baseUrl: BASE,
        fileName: 'memo.docx',
        bytes: new Uint8Array([1]),
        mode: 'edit',
        onSave,
      })
  const spy = vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
  const page = (data: Record<string, unknown>) => post(doc.iframe.contentWindow, data)
  const calls = () =>
    spy.mock.calls.map(
      (call) =>
        ({ message: call[0], transfer: (call[1] as { transfer?: unknown[] }).transfer }) as {
          message: Record<string, unknown>
          transfer: unknown[] | undefined
        },
    )
  const messages = () => calls().map((call) => call.message)
  const collabMessages = () =>
    messages().filter((message) => String(message.type).startsWith('collab_'))
  return { doc, page, calls, messages, collabMessages }
}

/** A relay whose `connect` hands out fresh fake sockets, in order */
function relay() {
  const sockets: FakeSocket[] = []
  const statuses: unknown[] = []
  const collab: CollabRelay = {
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onStatus: (status) => statuses.push(status),
  }
  return { collab, sockets, statuses }
}

// one macrotask: every microtask the pipe chains after connect() has run by then
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  document.body.replaceChildren()
})

describe('the co-editing pipe', () => {
  it('asks for co-editing in open and reports the page capability', async () => {
    const { collab } = relay()
    const { doc, page, messages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    expect(messages()[0]).toMatchObject({ type: 'open', collab: true })
    await expect(doc.collabCapable).resolves.toBe(true)
  })

  it('reports a page that declares nothing as not capable', async () => {
    const { collab } = relay()
    const { doc, page } = openWith({ collab })
    page({ type: 'ready' })
    await expect(doc.collabCapable).resolves.toBe(false)
  })

  it('relays frames verbatim both ways, binary as a transferred ArrayBuffer', async () => {
    const { collab, sockets } = relay()
    const { page, calls, collabMessages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush()
    const [socket] = sockets
    expect(socket!.binaryType).toBe('arraybuffer')
    socket!.fire('open')
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_open', connectId: 1 }),
    ])

    const binary = new Uint8Array([7, 8, 9]).buffer
    socket!.fire('message', '{"t":"welcome"}')
    socket!.fire('message', binary)
    const frames = calls().filter((call) => call.message.type === 'collab_frame')
    expect(frames[0]!.message.frame).toBe('{"t":"welcome"}')
    expect(frames[1]!.message.frame).toBe(binary)
    expect(frames[1]!.transfer).toEqual([binary])

    const upBinary = new Uint8Array([1, 2]).buffer
    page({ type: 'collab_frame', connectId: 1, frame: '{"t":"hello"}' })
    page({ type: 'collab_frame', connectId: 1, frame: upBinary })
    expect(socket!.sent).toEqual(['{"t":"hello"}', upBinary])
  })

  it('closes the first socket on a second connect and drops everything it still says', async () => {
    const { collab, sockets } = relay()
    const { page, collabMessages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush()
    sockets[0]!.fire('open')
    page({ type: 'collab_connect', connectId: 2 })
    await flush()
    expect(sockets[0]!.closed).toBe(true)
    sockets[0]!.fire('message', 'old')
    sockets[0]!.fire('close')
    page({ type: 'collab_frame', connectId: 1, frame: 'late' })
    sockets[1]!.fire('open')
    page({ type: 'collab_frame', connectId: 2, frame: 'new' })
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_open', connectId: 1 }),
      expect.objectContaining({ type: 'collab_open', connectId: 2 }),
    ])
    expect(sockets[0]!.sent).toEqual([])
    expect(sockets[1]!.sent).toEqual(['new'])
  })

  it('answers a rejecting connect() and a socket error with collab_close', async () => {
    const { page, collabMessages } = openWith({
      collab: { connect: () => Promise.reject(new Error('no ticket')) },
    })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush()
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_close', connectId: 1 }),
    ])

    const { collab, sockets } = relay()
    const second = openWith({ collab })
    second.page({ type: 'ready', collab: true })
    second.page({ type: 'collab_connect', connectId: 1 })
    await flush()
    sockets[0]!.fire('open')
    sockets[0]!.fire('error')
    sockets[0]!.fire('close')
    expect(sockets[0]!.closed).toBe(true)
    expect(second.collabMessages().map((message) => message.type)).toEqual([
      'collab_open',
      'collab_close',
    ])
  })

  it('closes the socket on collab_disconnect and on destroy()', async () => {
    const { collab, sockets } = relay()
    const { doc, page } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush()
    page({ type: 'collab_disconnect', connectId: 1 })
    expect(sockets[0]!.closed).toBe(true)
    page({ type: 'collab_connect', connectId: 2 })
    await flush()
    doc.destroy()
    expect(sockets[1]!.closed).toBe(true)
  })

  it('closes a socket that connect() hands over after destroy()', async () => {
    const socket = new FakeSocket()
    let hand!: (socket: WebSocketLike) => void
    const { doc, page } = openWith({
      collab: { connect: () => new Promise<WebSocketLike>((resolve) => (hand = resolve)) },
    })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    doc.destroy()
    hand(socket)
    await flush()
    expect(socket.closed).toBe(true)
  })

  it('forwards the page status to onStatus', () => {
    const { collab, statuses } = relay()
    const { page } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_status', status: { phase: 'live', version: 3 } })
    expect(statuses).toEqual([{ phase: 'live', version: 3 }])
  })

  it('hands onSave the version the page saved', async () => {
    const { collab } = relay()
    const saved: unknown[] = []
    const { page, messages } = openWith({ collab, onSave: async (file) => void saved.push(file) })
    page({ type: 'ready', collab: true })
    page({ type: 'save', saveId: 1, bytes: new Uint8Array([5]).buffer, collabVersion: 12 })
    await vi.waitFor(() =>
      expect(messages()).toContainEqual(expect.objectContaining({ type: 'saved' })),
    )
    expect(saved).toEqual([{ fileName: 'memo.docx', bytes: new Uint8Array([5]), version: 12 }])
  })

  it('refuses a co-edited save that names no version', async () => {
    const { collab } = relay()
    const onSave = vi.fn(async () => {})
    const { page, messages } = openWith({ collab, onSave })
    page({ type: 'ready', collab: true })
    page({ type: 'save', saveId: 1, bytes: new Uint8Array([5]).buffer })
    await vi.waitFor(() =>
      expect(messages()).toContainEqual(expect.objectContaining({ type: 'save_failed' })),
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does nothing co-editing without the option', async () => {
    const onSave = vi.fn(async () => {})
    const { doc, page, messages } = openWith({ onSave })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    page({ type: 'save', saveId: 1, bytes: new Uint8Array([5]).buffer, collabVersion: 4 })
    await vi.waitFor(() =>
      expect(messages()).toContainEqual(expect.objectContaining({ type: 'saved' })),
    )
    expect(messages()[0]).toMatchObject({ type: 'open', collab: false })
    expect(messages().filter((message) => String(message.type).startsWith('collab_'))).toEqual([])
    expect(onSave).toHaveBeenCalledWith({ fileName: 'memo.docx', bytes: new Uint8Array([5]) })
    await expect(doc.collabCapable).resolves.toBe(true)
  })
})
