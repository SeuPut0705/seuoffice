import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDocument, type CollabRelay, type WebSocketLike } from '../src/index'

const BASE = 'https://office.example/'
const ORIGIN = 'https://office.example'

type Listener = (event: { data?: unknown }) => void

class FakeSocket implements WebSocketLike {
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  readyState = 0
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
function relay(make: () => FakeSocket = () => new FakeSocket()) {
  const sockets: FakeSocket[] = []
  const statuses: unknown[] = []
  const collab: CollabRelay = {
    connect: () => {
      const socket = make()
      sockets.push(socket)
      return socket
    },
    onStatus: (status) => statuses.push(status),
  }
  return { collab, sockets, statuses }
}

/** Run every timer due within `ms` and every microtask the pipe chains after connect() */
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
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

  it('refuses to open in collab mode when the page cannot co-edit', async () => {
    const { collab, sockets } = relay()
    const { doc, page, messages } = openWith({ collab })
    page({ type: 'ready' })
    await expect(doc.opened).rejects.toMatchObject({ code: 'collab_unavailable' })
    await expect(doc.collabCapable).resolves.toBe(false)
    page({ type: 'collab_connect', connectId: 1 })
    await flush(1000)
    expect(messages().map((message) => message.type)).not.toContain('open')
    expect(sockets).toEqual([])
  })

  it('settles collabCapable false when the page never announces itself', async () => {
    const { collab } = relay()
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'memo.docx',
      bytes: new Uint8Array([1]),
      collab,
      readyTimeoutMs: 100,
    })
    let capable: boolean | undefined
    void doc.collabCapable.then((value) => (capable = value))
    await flush(100)
    await expect(doc.opened).rejects.toMatchObject({ code: 'timeout' })
    expect(capable).toBe(false)
  })

  it('announces a socket that connect() returns already open', async () => {
    const { collab, sockets } = relay(() => Object.assign(new FakeSocket(), { readyState: 1 }))
    const { page, collabMessages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush()
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_open', connectId: 1 }),
    ])
    sockets[0]!.fire('message', 'first')
    expect(collabMessages()[1]).toMatchObject({ type: 'collab_frame', frame: 'first' })
  })

  it('answers a socket that connect() returns already closed with collab_close', async () => {
    const { collab, sockets } = relay(() => Object.assign(new FakeSocket(), { readyState: 3 }))
    const { page, collabMessages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush()
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_close', connectId: 1 }),
    ])
    expect(sockets[0]!.closed).toBe(true)
  })

  it('gives up on a socket that does not open within 15 seconds', async () => {
    const { collab, sockets } = relay()
    const { page, collabMessages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush(14_999)
    expect(collabMessages()).toEqual([])
    await flush(1)
    expect(sockets[0]!.closed).toBe(true)
    sockets[0]!.fire('open')
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_close', connectId: 1 }),
    ])
  })

  it('gives up on a connect() that never settles, and closes its socket if it comes later', async () => {
    let hand!: (socket: WebSocketLike) => void
    const { page, collabMessages } = openWith({
      collab: {
        connect: () => new Promise<WebSocketLike>((resolve) => (hand = resolve)),
        connectTimeoutMs: 500,
      },
    })
    page({ type: 'ready', collab: true })
    page({ type: 'collab_connect', connectId: 1 })
    await flush(500)
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_close', connectId: 1 }),
    ])
    const late = new FakeSocket()
    hand(late)
    await flush()
    expect(late.closed).toBe(true)
  })

  it('calls connect() at most once per 250 ms and keeps only the latest request', async () => {
    const { collab, sockets } = relay()
    const { page, collabMessages } = openWith({ collab })
    page({ type: 'ready', collab: true })
    for (let id = 1; id <= 5; id++) page({ type: 'collab_connect', connectId: id })
    await flush()
    expect(sockets).toHaveLength(1)
    await flush(249)
    expect(sockets).toHaveLength(1)
    await flush(1)
    expect(sockets).toHaveLength(2)
    expect(sockets[0]!.closed).toBe(true)
    sockets[1]!.fire('open')
    expect(collabMessages()).toEqual([
      expect.objectContaining({ type: 'collab_open', connectId: 5 }),
    ])
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
    await flush(250)
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
    await flush(250)
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
