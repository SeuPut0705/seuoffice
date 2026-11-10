import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChannelModule from '../src/embed-channel'
import type * as LinkModule from '../src/collab-link'

const HOST = location.origin

let host: Window
let sent: { message: Record<string, unknown>; transfer: unknown[] | undefined }[]
let channel: typeof ChannelModule
let links: typeof LinkModule

function fromHost(data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: host,
      origin: HOST,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

const messages = () => sent.map((entry) => entry.message)

beforeEach(async () => {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  host = frame.contentWindow!
  sent = []
  vi.spyOn(host, 'postMessage').mockImplementation((message: unknown, options?: unknown) => {
    const transfer =
      options && typeof options === 'object' && 'transfer' in options
        ? (options.transfer as unknown[])
        : undefined
    sent.push({ message: message as Record<string, unknown>, transfer })
  })
  Object.defineProperty(window, 'parent', { value: host, configurable: true })
  // the channel keeps one host per page load, so each test loads a fresh copy
  vi.resetModules()
  channel = await import('../src/embed-channel')
  links = await import('../src/collab-link')
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  document.body.replaceChildren()
})

async function open(collab: boolean): Promise<void> {
  const opening = channel.receiveOpen()
  fromHost({ type: 'open', fileName: 'memo.hwpx', bytes: new ArrayBuffer(1), collab })
  await opening
}

describe('declaring co-editing', () => {
  it('reports collab: false in ready when the app declares nothing', () => {
    void channel.receiveOpen()
    expect(messages()[0]).toMatchObject({ type: 'ready', collab: false })
  })

  it('reports collab: true when the app declares it before ready', () => {
    channel.registerCollabCapable()
    void channel.receiveOpen()
    expect(messages()[0]).toMatchObject({ type: 'ready', collab: true })
  })

  it('refuses a declaration that comes after ready', () => {
    void channel.receiveOpen()
    expect(() => channel.registerCollabCapable()).toThrow()
  })
})

describe('without co-editing from the host', () => {
  it('has no link and sends nothing co-editing', async () => {
    await open(false)
    sent = []
    expect(links.collabLink()).toBeNull()
    links.reportCollabStatus({
      phase: 'live',
      canEdit: true,
      version: 1,
      saved: 0,
      unconfirmed: 0,
      peers: [],
      self: null,
    })
    void channel.saveToHost('memo.hwpx', new Uint8Array([1]))
    expect(messages().map((message) => message.type)).toEqual(['save'])
    expect(messages()[0]).not.toHaveProperty('collabVersion')
  })
})

describe('the co-editing link', () => {
  beforeEach(async () => {
    await open(true)
    sent = []
  })

  it('relays frames verbatim both ways, binary as a transferred copy', () => {
    const link = links.collabLink()!
    const events: unknown[] = []
    link.subscribe((event) => events.push(event))
    link.open()
    expect(messages()).toEqual([expect.objectContaining({ type: 'collab_connect', connectId: 1 })])
    fromHost({ type: 'collab_open', connectId: 1 })

    link.send('{"t":"hello"}')
    const bytes = new Uint8Array([4, 5, 6])
    link.send(bytes)
    const [text, binary] = sent.slice(1)
    expect(text!.message).toMatchObject({
      type: 'collab_frame',
      connectId: 1,
      frame: '{"t":"hello"}',
    })
    const buffer = binary!.message.frame as ArrayBuffer
    expect(Array.from(new Uint8Array(buffer))).toEqual([4, 5, 6])
    expect(binary!.transfer).toEqual([buffer])
    expect(Array.from(bytes)).toEqual([4, 5, 6])

    fromHost({ type: 'collab_frame', connectId: 1, frame: '{"t":"welcome"}' })
    fromHost({ type: 'collab_frame', connectId: 1, frame: new Uint8Array([9]).buffer })
    expect(events).toEqual([
      { type: 'open' },
      { type: 'frame', frame: '{"t":"welcome"}' },
      { type: 'frame', frame: new Uint8Array([9]) },
    ])
  })

  it('reconnects under a new id and ignores what the host says for the old one', () => {
    const link = links.collabLink()!
    const events: unknown[] = []
    link.subscribe((event) => events.push(event))
    link.open()
    fromHost({ type: 'collab_open', connectId: 1 })
    link.close()
    link.open()
    fromHost({ type: 'collab_frame', connectId: 1, frame: 'old' })
    fromHost({ type: 'collab_close', connectId: 1 })
    link.send('dropped before open')
    fromHost({ type: 'collab_open', connectId: 2 })
    expect(messages().map((message) => [message.type, message.connectId])).toEqual([
      ['collab_connect', 1],
      ['collab_disconnect', 1],
      ['collab_connect', 2],
    ])
    expect(events).toEqual([{ type: 'open' }, { type: 'open' }])
  })

  it('reports a host close and opens again after it', () => {
    const link = links.collabLink()!
    const events: unknown[] = []
    link.subscribe((event) => events.push(event))
    link.open()
    link.open()
    fromHost({ type: 'collab_close', connectId: 1 })
    link.open()
    expect(events).toEqual([{ type: 'close' }])
    expect(messages().map((message) => [message.type, message.connectId])).toEqual([
      ['collab_connect', 1],
      ['collab_connect', 2],
    ])
  })

  it('puts the version on a save and sends the status', () => {
    void channel.saveToHost('memo.hwpx', new Uint8Array([1]), { version: 7 })
    links.reportCollabStatus({
      phase: 'live',
      canEdit: true,
      version: 7,
      saved: 7,
      unconfirmed: 0,
      peers: [],
      self: null,
    })
    expect(messages()[0]).toMatchObject({ type: 'save', collabVersion: 7 })
    expect(messages()[1]).toMatchObject({
      type: 'collab_status',
      status: { phase: 'live', version: 7 },
    })
  })
})
