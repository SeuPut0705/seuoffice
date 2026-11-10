import { describe, expect, it } from 'vitest'
import { VirtualClock } from '../src/conformance/network'
import { sha256 } from '../src/sha256'
import { createServerCore, type Principal, type ServerSocket } from '../src/server/server'
import { memoryStore } from '../src/server/store'

const FORMAT = { name: 'toy', schema: 1 }
const BASE = new TextEncoder().encode('base file')

class FakeSocket implements ServerSocket {
  readonly sent: (string | Uint8Array)[] = []
  closed = false
  #message: (frame: string | Uint8Array) => void = () => {}
  #close: () => void = () => {}

  send(frame: string | Uint8Array): void {
    this.sent.push(frame)
  }

  close(): void {
    this.closed = true
  }

  onMessage(handler: (frame: string | Uint8Array) => void): void {
    this.#message = handler
  }

  onClose(handler: () => void): void {
    this.#close = handler
  }

  receive(frame: string | Uint8Array | object): void {
    this.#message(
      typeof frame === 'string' || frame instanceof Uint8Array ? frame : JSON.stringify(frame),
    )
  }

  hangUp(): void {
    this.#close()
  }

  frames(): Record<string, unknown>[] {
    return this.sent.filter((frame) => typeof frame === 'string').map((frame) => JSON.parse(frame))
  }

  /** the client and epoch this socket was welcomed with */
  welcomed(): { client: string; epoch: string } {
    const welcome = this.frames().find((frame) => frame.t === 'welcome')
    if (typeof welcome?.client !== 'string' || typeof welcome.epoch !== 'string')
      throw new Error('not welcomed')
    return { client: welcome.client, epoch: welcome.epoch }
  }
}

function principal(userId: string, canEdit = true): Principal {
  return { documentId: 'doc', userId, name: userId, canEdit }
}

async function setup(limits = {}) {
  const store = memoryStore()
  const clock = new VirtualClock()
  const server = createServerCore({ store, limits, clock })
  const fileHash = await sha256(BASE)
  const hello = { t: 'hello', p: 1, format: FORMAT, fileHash }

  async function open(user = 'a', canEdit = true): Promise<FakeSocket> {
    const socket = new FakeSocket()
    server.accept(socket, principal(user, canEdit))
    socket.receive(hello)
    await server.idle()
    if (socket.frames().at(-1)?.t === 'need_base') {
      socket.receive(BASE)
      await server.idle()
    }
    return socket
  }

  return { server, store, clock, hello, open }
}

describe('the server', () => {
  it('answers a malformed frame and a frame before hello with bad_frame and closes', async () => {
    const { server } = await setup()
    for (const frame of [
      'not json',
      { t: 'submit', seq: 1, base: 0, ops: [] },
      { t: 'hello', p: 2 },
    ]) {
      const socket = new FakeSocket()
      server.accept(socket, principal('a'))
      socket.receive(frame)
      await server.idle()
      expect(socket.frames()).toEqual([{ t: 'error', code: 'bad_frame' }])
      expect(socket.closed).toBe(true)
    }
  })

  it('refuses a base whose hash is not the announced one', async () => {
    const { server, hello } = await setup()
    const socket = new FakeSocket()
    server.accept(socket, principal('a'))
    socket.receive(hello)
    await server.idle()
    socket.receive(new TextEncoder().encode('other bytes'))
    await server.idle()
    expect(socket.frames()).toEqual([{ t: 'need_base' }, { t: 'error', code: 'bad_frame' }])
  })

  it('answers too_large for a base past its limit', async () => {
    const { server, hello } = await setup({ maxBaseBytes: 4 })
    const seeder = new FakeSocket()
    server.accept(seeder, principal('a'))
    seeder.receive(hello)
    await server.idle()
    seeder.receive(BASE)
    await server.idle()
    expect(seeder.frames()).toEqual([{ t: 'need_base' }, { t: 'error', code: 'too_large' }])
    expect(seeder.closed).toBe(true)
  })

  it('answers too_large for a text frame past its limit', async () => {
    const { server, open } = await setup({ maxChangeBytes: 100 })
    const socket = await open()
    socket.receive({ t: 'submit', seq: 1, base: 0, ops: ['x'.repeat(100)] })
    await server.idle()
    expect(socket.frames().at(-1)).toEqual({ t: 'error', code: 'too_large' })
    expect(socket.closed).toBe(true)
  })

  it('forbids a submit from a principal that cannot edit and leaves the log alone', async () => {
    const { server, open } = await setup()
    const editor = await open('editor')
    const viewer = await open('viewer', false)
    expect(viewer.frames().find((frame) => frame.t === 'welcome')).toMatchObject({ canEdit: false })

    viewer.receive({ t: 'submit', seq: 1, base: 0, ops: [1] })
    await server.idle()
    expect(viewer.frames().at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    expect(editor.frames().some((frame) => frame.t === 'change')).toBe(false)
  })

  it('sends a joiner every change after its start, in order, across catch-up pages', async () => {
    const { server, open } = await setup({ catchUpPage: 2 })
    const writer = await open('writer')
    for (let seq = 1; seq <= 5; seq++) {
      writer.receive({ t: 'submit', seq, base: seq - 1, ops: [seq] })
      await server.idle()
    }
    expect(
      writer
        .frames()
        .filter((frame) => frame.t === 'ack')
        .map((frame) => frame.v),
    ).toEqual([1, 2, 3, 4, 5])

    const reader = await open('reader')
    const welcome = reader.frames().find((frame) => frame.t === 'welcome')
    expect(welcome).toMatchObject({ start: 0, head: 5 })
    const changes = reader.frames().filter((frame) => frame.t === 'change')
    expect(changes.map((frame) => frame.v)).toEqual([1, 2, 3, 4, 5])
    expect(changes.map((frame) => frame.ops)).toEqual([[1], [2], [3], [4], [5]])
  })

  it('acks a submit already in the log without appending it again, and answers a stale base with stale', async () => {
    const { server, open } = await setup()
    const a = await open('a')
    const b = await open('b')
    a.receive({ t: 'submit', seq: 1, base: 0, ops: ['first'] })
    await server.idle()
    a.receive({ t: 'submit', seq: 1, base: 0, ops: ['first'] })
    b.receive({ t: 'submit', seq: 1, base: 0, ops: ['late'] })
    await server.idle()
    expect(a.frames().filter((frame) => frame.t === 'ack')).toEqual([
      { t: 'ack', v: 1, seq: 1 },
      { t: 'ack', v: 1, seq: 1 },
    ])
    expect(b.frames().slice(-2)).toMatchObject([
      { t: 'change', v: 1, ops: ['first'] },
      { t: 'stale', seq: 1, base: 0, head: 1 },
    ])
  })

  it('closes the older socket of a client when the client says hello again, whichever hello arrives first', async () => {
    const { server, hello, open } = await setup()
    const first = await open('a')
    const { client, epoch } = first.welcomed()
    const resume = { ...hello, resume: { epoch, client, v: 0 } }

    const second = new FakeSocket()
    server.accept(second, principal('a'))
    const third = new FakeSocket()
    server.accept(third, principal('a'))
    third.receive(resume)
    await server.idle()
    expect(first.frames().at(-1)).toEqual({ t: 'error', code: 'superseded' })

    second.receive(resume)
    await server.idle()
    expect(second.frames()).toEqual([{ t: 'error', code: 'superseded' }])
    expect(third.closed).toBe(false)
  })

  it('keeps an epoch its last socket left, so a resume continues it, until it idled out saved', async () => {
    const { server, store, clock, hello, open } = await setup()
    const socket = await open('a')
    const { client, epoch } = socket.welcomed()
    const resume = { ...hello, resume: { epoch, client, v: 0 } }
    socket.hangUp()
    await server.idle()

    const back = new FakeSocket()
    server.accept(back, principal('a'))
    back.receive(resume)
    await server.idle()
    expect(back.welcomed()).toEqual({ client, epoch })
    back.hangUp()
    await server.idle()

    expect(clock.fire()).toBe(true)
    await server.idle()
    expect(await store.load('doc')).toBeNull()
    const late = new FakeSocket()
    server.accept(late, principal('a'))
    late.receive(resume)
    await server.idle()
    expect(late.frames()).toEqual([{ t: 'error', code: 'reset' }])
  })

  it('keeps an idle epoch with unsaved versions however long it waits', async () => {
    const { server, store, clock, open } = await setup({ idleEpochMs: 1000 })
    const socket = await open('a')
    socket.receive({ t: 'submit', seq: 1, base: 0, ops: ['x'] })
    await server.idle()
    socket.hangUp()
    await server.idle()
    while (clock.fire()) await server.idle()
    expect(await store.load('doc')).toMatchObject({ head: 1, saved: 0 })
  })

  it("treats a resume of another user's client id as a fresh hello", async () => {
    const { server, hello, open } = await setup()
    const owner = await open('owner')
    const { client, epoch } = owner.welcomed()

    const other = new FakeSocket()
    server.accept(other, principal('other'))
    other.receive({ ...hello, resume: { epoch, client, v: 0 } })
    await server.idle()
    expect(other.welcomed().client).not.toBe(client)
    expect(owner.closed).toBe(false)
    expect(owner.frames().some((frame) => frame.t === 'error')).toBe(false)
  })

  it('ends a document on reset: its sockets get reset and its epoch is dropped', async () => {
    const { server, store, open } = await setup()
    const a = await open('a')
    a.receive({ t: 'submit', seq: 1, base: 0, ops: ['x'] })
    await server.idle()
    await server.reset('doc')
    expect(a.frames().at(-1)).toEqual({ t: 'error', code: 'reset' })
    expect(a.closed).toBe(true)
    expect(await store.load('doc')).toBeNull()
  })

  it('closes every socket on close(), keeps the epochs for a later start, and turns later sockets away', async () => {
    const { server, store, open } = await setup()
    const a = await open('a')
    const b = await open('b')
    await server.close()
    expect([a.closed, b.closed]).toEqual([true, true])
    expect(await store.load('doc')).not.toBeNull()

    const late = new FakeSocket()
    server.accept(late, principal('c'))
    expect(late.closed).toBe(true)
  })
})
