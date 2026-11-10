import { describe, expect, it } from 'vitest'
import { CollabError } from '../src/client/api'
import { MAX_CHANGE_BYTES } from '../src/client/index'
import { oldest, SimNetwork, type SimClient } from '../src/conformance/network'
import { deferred } from '../src/deferred'
import {
  toyLines,
  toyMap,
  type LineOp,
  type MapOp,
  type Toy,
  type ToyEditor,
} from '../src/conformance/toys'
import type { Change, Format, Json } from '../src/model'

const DOC = 'doc'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface JoinOptions<Op> {
  bytes?: Uint8Array
  canEdit?: boolean
  format?: Format
  factory?: (bytes: Uint8Array) => ToyEditor<Op>
}

function join<Op>(net: SimNetwork, toy: Toy<Op>, user: string, options: JoinOptions<Op> = {}) {
  return net.client<Op, ToyEditor<Op>>(
    { documentId: DOC, userId: user, name: user, canEdit: options.canEdit ?? true },
    { format: options.format ?? toy.format, bytes: options.bytes ?? toy.file() },
    options.factory ?? toy.open,
  )
}

async function shown<Op>(client: SimClient<Op, ToyEditor<Op>>): Promise<unknown> {
  return JSON.parse(decoder.decode((await client.editor!.produceFile()).bytes))
}

async function log(net: SimNetwork): Promise<Change[]> {
  const epoch = await net.store.load(DOC)
  return epoch ? net.store.read(DOC, epoch.id, 0, epoch.head) : []
}

/** op ids per version, in log order */
async function opIds(net: SimNetwork): Promise<string[][]> {
  const id = (op: Json) =>
    typeof op === 'object' && op !== null && !Array.isArray(op) ? op.id : null
  return (await log(net)).map((change) => change.ops.map((op) => String(id(op))))
}

const ins = (id: string, at: number): LineOp => ({ id, t: 'ins', at, text: id })

describe('two clients', () => {
  it('both keep their edit when they submit against the same version at once', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()

    a.editor!.perform(ins('A', 0))
    b.editor!.perform(ins('B', 0))
    await net.run()

    expect(await opIds(net)).toEqual([['A'], ['B']])
    expect(await shown(a)).toEqual(['A', 'B', 'one', 'two', 'three'])
    expect(await shown(b)).toEqual(['A', 'B', 'one', 'two', 'three'])
    expect(a.session!.status()).toMatchObject({ phase: 'live', version: 2, unconfirmed: 0 })
    expect(b.session!.status()).toMatchObject({ phase: 'live', version: 2, unconfirmed: 0 })
  })

  it('see each other join and leave', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    expect(
      a
        .session!.status()
        .peers.map((peer) => peer.name)
        .sort(),
    ).toEqual(['a', 'b'])

    b.session!.close()
    await net.run()
    expect(a.session!.status().peers.map((peer) => peer.name)).toEqual(['a'])
  })

  it('each know who they are: their own client id and display name, and both are peers', async () => {
    const net = new SimNetwork()
    const [ada, bo] = await Promise.all(
      [
        { userId: 'u-ada', name: 'Ada Lovelace' },
        { userId: 'u-bo', name: 'Bo Kim' },
      ].map((who) =>
        net.client<LineOp, ToyEditor<LineOp>>(
          { documentId: DOC, canEdit: true, ...who },
          { format: toyLines.format, bytes: toyLines.file() },
          toyLines.open,
        ),
      ),
    )
    expect(ada!.join).toBeNull()
    await net.run()

    const peers = ada!.session!.status().peers
    expect(peers).toHaveLength(2)
    for (const [client, name] of [
      [ada!, 'Ada Lovelace'],
      [bo!, 'Bo Kim'],
    ] as const) {
      const self = client.session!.status().self
      expect(self?.name).toBe(name)
      expect(peers).toContainEqual(self)
      expect(client.session!.status().peers).toEqual(expect.arrayContaining(peers))
    }
    expect(ada!.session!.status().self?.client).not.toBe(bo!.session!.status().self?.client)
  })

  it('still know who they are while offline', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await net.run()
    const self = a.session!.status().self
    expect(self).toEqual({ client: expect.any(String), name: 'a' })
    net.break(a.link.current!)
    expect(a.session!.status()).toMatchObject({ phase: 'offline', self })
  })
})

describe('a lost connection', () => {
  async function editedPair() {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    a.editor!.perform(ins('X', 0))
    return { net, a, b }
  }

  async function expectAppendedOnce(
    net: SimNetwork,
    a: SimClient<LineOp, ToyEditor<LineOp>>,
    b: SimClient<LineOp, ToyEditor<LineOp>>,
  ) {
    expect(await opIds(net)).toEqual([['X']])
    expect(a.session!.status()).toMatchObject({ phase: 'live', version: 1, unconfirmed: 0 })
    expect(await shown(a)).toEqual(['X', 'one', 'two', 'three'])
    expect(await shown(b)).toEqual(['X', 'one', 'two', 'three'])
  }

  it('after the server appended the submit but its ack was lost confirms it from the catch-up', async () => {
    const { net, a, b } = await editedPair()
    const first = a.link.current!
    await net.deliverUp(first)
    net.break(first)
    expect(a.session!.status()).toMatchObject({ phase: 'offline', unconfirmed: 1 })

    await net.run()
    await expectAppendedOnce(net, a, b)
  })

  it('in the middle of the append, before the server answered, confirms it from the catch-up', async () => {
    const { net, a, b } = await editedPair()
    net.afterAppend = () => {
      net.afterAppend = null
      net.break(a.link.current!)
    }
    await net.run()
    await expectAppendedOnce(net, a, b)
  })

  it('whose submit reaches the server only after the new hello appends it once', async () => {
    const { net, a, b } = await editedPair()
    net.break(a.link.current!, { hold: true })
    await net.run()
    await expectAppendedOnce(net, a, b)
  })

  it('whose submit reaches the server after the reconnect but before the new hello appends it once', async () => {
    const { net, a, b } = await editedPair()
    const first = a.link.current!
    net.break(first)
    net.clock.fire()
    await net.settle()
    const second = a.link.current!
    expect(second).not.toBe(first)
    await net.deliverUp(second)
    await net.deliverDown(second)
    await net.deliverUp(first)
    expect(net.stats.lateFrames).toBe(1)

    await net.run()
    await expectAppendedOnce(net, a, b)
  })

  it('catches up on 50 missed changes and rebases the edits made offline', async () => {
    const net = new SimNetwork({ limits: { catchUpPage: 7 } })
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()

    net.break(a.link.current!)
    for (let i = 0; i < 50; i++) {
      b.editor!.perform(ins(`b${i}`, 0))
      await net.run({ timers: false })
    }
    a.editor!.perform(ins('a0', 1))
    a.editor!.perform({ id: 'a1', t: 'del', at: 0 })
    a.editor!.perform(ins('a2', 2))
    expect(a.session!.status()).toMatchObject({ phase: 'offline', version: 0, unconfirmed: 3 })

    await net.run()
    const missed = Array.from({ length: 50 }, (_, i) => `b${49 - i}`)
    expect(await shown(a)).toEqual([...missed, 'a0', 'two', 'a2', 'three'])
    expect(await shown(b)).toEqual(await shown(a))
    const ids = (await opIds(net)).flat()
    for (const id of ['a0', 'a1', 'a2']) expect(ids.filter((each) => each === id)).toHaveLength(1)
    expect(a.session!.status()).toMatchObject({
      phase: 'live',
      unconfirmed: 0,
      version: (await log(net)).length,
    })
  })
})

describe('schedules found by the protocol model (formal/collab-protocol)', () => {
  it('F2: a submit cut off with its connection and doomed during catch-up goes out again with its seq', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()

    a.editor!.perform(ins('A', 0))
    const first = a.link.current!
    // Cut at once; the submit {seq 1, base 0} still travels to the server
    net.break(first)
    b.editor!.perform(ins('B', 0))
    await net.deliverUp(b.link.current!)
    expect(await opIds(net)).toEqual([['B']])
    // The old submit is stale now, and the answer goes to the dead connection
    await net.deliverUp(first)
    await net.deliverUp(first)
    expect(first.up).toEqual([])

    expect(net.clock.fire()).toBe(true)
    await net.settle()
    const second = a.link.current!
    await net.deliverUp(second)
    await net.deliverDown(second)
    await net.deliverUp(second)
    await net.deliverDown(second)
    expect(a.session!.status()).toMatchObject({ phase: 'offline', version: 0, unconfirmed: 1 })
    // B arrives during catch-up as a foreign change: the in-flight submit is doomed
    await net.deliverDown(second)

    await net.run()
    expect(await opIds(net)).toEqual([['B'], ['A']])
    expect(a.session!.status()).toMatchObject({ phase: 'live', version: 2, unconfirmed: 0 })
    expect(await shown(a)).toEqual(await shown(b))
  })

  it('F1: a late hello from a connection the client gave up does not evict its newer connection', async () => {
    // Behind a proxy the server may accept a later connection first
    const net = new SimNetwork({ proxied: true })
    await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()

    b.editor!.perform(ins('B', 0))
    net.break(b.link.current!, { drop: true })
    async function reopen() {
      expect(net.clock.fire()).toBe(true)
      await net.settle()
      const connection = b.link.current!
      // The proxy opens it at once, and the engine says hello with resume
      await net.deliverDown(connection)
      return connection
    }
    const second = await reopen()
    // Cut before the server reads its hello
    net.break(second)
    const third = await reopen()
    await net.deliverUp(third)
    await net.deliverUp(third)
    // Only now does the server see connection 2, and then its hello
    await net.deliverUp(second)
    await net.deliverUp(second)

    await net.run()
    expect(b.link.current).toBe(third)
    expect(third.serverOpen).toBe(true)
    expect(second.serverOpen).toBe(false)
    expect(b.session!.status()).toMatchObject({ phase: 'live', version: 1, unconfirmed: 0 })
    expect(await opIds(net)).toEqual([['B']])
  })
})

describe('reconnecting', () => {
  it('waits 0.5 s, doubling up to 15 s, and starts over only once a change got through', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()

    async function nextAttempt(): Promise<number> {
      const from = net.clock.now()
      const before = a.link.current
      net.break(before!)
      while (a.link.current === before) {
        expect(net.clock.fire()).toBe(true)
        await net.settle()
      }
      return net.clock.now() - from
    }

    const waits: number[] = []
    for (let i = 0; i < 7; i++) waits.push(await nextAttempt())
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000])

    // A welcome alone proves little: a server that accepts and then drops gets no fast retries
    await net.run()
    expect(a.session!.status().phase).toBe('live')
    expect(await nextAttempt()).toBe(15000)

    await net.run()
    b.editor!.perform(ins('b', 0))
    await net.run()
    expect(a.session!.status().version).toBe(1)
    expect(await nextAttempt()).toBe(500)
  })
})

describe('joining', () => {
  it('a late joiner after 500 changes reaches the same state', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyMap, 'a')
    await net.run()
    for (let i = 0; i < 500; i++) {
      a.editor!.perform({ id: `a${i}`, key: 'abcde'.charAt(i % 5), value: i })
      await net.run()
    }

    const late = await join(net, toyMap, 'late')
    await net.run()
    expect(late.join!.baseBytes).toEqual(toyMap.file())
    expect(late.session!.status()).toMatchObject({ phase: 'live', version: 500 })
    expect(await late.editor!.fingerprint()).toBe(await a.editor!.fingerprint())
    expect(await shown(late)).toEqual([
      ['a', 495],
      ['b', 496],
      ['c', 497],
      ['d', 498],
      ['e', 499],
    ])
  })

  it('a joiner whose bytes differ from the epoch base opens the base instead', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await net.run()
    a.editor!.perform(ins('x', 0))
    await net.run()

    const stale = encoder.encode(JSON.stringify(['an', 'older', 'copy']))
    const c = await join(net, toyLines, 'c', { bytes: stale })
    await net.run()
    expect(c.join!.baseBytes).toEqual(toyLines.file())
    expect(await shown(c)).toEqual(['x', 'one', 'two', 'three'])
  })

  it('with another schema than the epoch fails with schema_mismatch', async () => {
    const net = new SimNetwork()
    await join(net, toyLines, 'a')
    await net.run()

    const c = await join(net, toyLines, 'c', { format: { name: 'toy-lines', schema: 2 } })
    await net.run()
    expect(c.joinError).toBeInstanceOf(CollabError)
    expect((c.joinError as CollabError).code).toBe('schema_mismatch')
  })

  it('when the seeder disconnects before sending the base, the next waiting client seeds', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const theirs = encoder.encode(JSON.stringify(['from', 'b']))
    const b = await join(net, toyLines, 'b', { bytes: theirs })

    const first = a.link.current!
    await net.deliverUp(first)
    await net.deliverDown(first)
    await net.deliverUp(first)
    const other = b.link.current!
    await net.deliverUp(other)
    await net.deliverDown(other)
    await net.deliverUp(other)
    expect(first.down.map((item) => item.kind)).toEqual(['frame'])
    net.break(first, { drop: true })

    await net.run()
    expect(b.join!.baseBytes).toEqual(theirs)
    expect(a.join!.baseBytes).toEqual(theirs)
    a.editor!.perform(ins('a', 2))
    await net.run()
    expect(await shown(b)).toEqual(['from', 'b', 'a'])
    expect(await shown(a)).toEqual(['from', 'b', 'a'])
  })
})

describe('saving', () => {
  it('returns the file of one exact version while remote changes keep arriving', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    b.editor!.perform(ins('b1', 0))
    await net.run()

    let producing = false
    const gate = deferred<void>()
    const produce = a.editor!.produceFile
    a.editor!.produceFile = async () => {
      producing = true
      const file = produce()
      await gate.promise
      return file
    }
    // Deliveries that do not wait for `a`, whose file is held back by the gate
    async function pump() {
      for (;;) {
        const next = oldest(net.upReady(), 'up', oldest(net.downReady(), 'down'))
        if (!next) return
        void (next.direction === 'up'
          ? net.deliverUp(next.connection)
          : net.deliverDown(next.connection))
        await net.server.idle()
        await b.engine.settled()
      }
    }

    a.editor!.perform(ins('a1', 0))
    const saving = a.session!.save()
    expect(a.editor!.editable).toBe(false)
    await pump()
    expect(producing).toBe(true)

    b.editor!.perform(ins('b2', 0))
    await pump()
    b.editor!.perform(ins('b3', 0))
    await pump()
    expect(a.session!.status().version).toBe(2)

    gate.resolve()
    const saved = await saving
    expect(saved.version).toBe(2)
    expect(JSON.parse(decoder.decode(saved.bytes))).toEqual(['a1', 'b1', 'one', 'two', 'three'])

    await net.run()
    expect(a.editor!.editable).toBe(true)
    expect(a.session!.status()).toMatchObject({ version: 4, unconfirmed: 0 })
    expect(await shown(a)).toEqual(['b3', 'b2', 'a1', 'b1', 'one', 'two', 'three'])
    expect(await shown(b)).toEqual(await shown(a))
  })

  it('reported by the host reaches every client', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    a.editor!.perform(ins('x', 0))
    await net.run()

    const { version } = await a.session!.save()
    a.session!.reportSaved(version)
    await net.run()
    expect(b.session!.status().saved).toBe(1)
  })
})

describe('the epoch', () => {
  async function savedAlone() {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await net.run()
    a.editor!.perform(ins('x', 0))
    await net.run()
    const saved = await a.session!.save()
    a.session!.reportSaved(saved.version)
    await net.run()
    return { net, a, saved }
  }

  it('saved, disconnected, typed offline, a colleague opened meanwhile, reconnected: both see the offline edits', async () => {
    const { net, a, saved } = await savedAlone()
    net.break(a.link.current!)
    await net.run({ timers: false })
    a.editor!.perform(ins('offline', 1))

    // The colleague opens the file the host stored while the document has no socket at all
    const colleague = await join(net, toyLines, 'colleague', { bytes: saved.bytes })
    await net.run()
    expect(colleague.join!.baseBytes).toEqual(toyLines.file())
    const expected = ['x', 'offline', 'one', 'two', 'three']
    expect(a.session!.status()).toMatchObject({ phase: 'live', version: 2, unconfirmed: 0 })
    expect(await shown(a)).toEqual(expected)
    expect(await shown(colleague)).toEqual(expected)
    expect(await opIds(net)).toEqual([['x'], ['offline']])
  })

  it('ends after ten minutes without sockets when every version is saved; the next opener starts from its own file', async () => {
    const { net, a, saved } = await savedAlone()
    a.session!.close()
    await net.run({ timers: false })
    expect(await net.store.load(DOC)).not.toBeNull()

    const left = net.clock.now()
    expect(net.clock.fire()).toBe(true)
    await net.settle()
    expect(net.clock.now() - left).toBe(10 * 60 * 1000)
    expect(await net.store.load(DOC)).toBeNull()

    const next = await join(net, toyLines, 'next', { bytes: saved.bytes })
    await net.run()
    expect(next.join!.baseBytes).toEqual(saved.bytes)
    expect(await shown(next)).toEqual(['x', 'one', 'two', 'three'])
    expect(await log(net)).toEqual([])
  })

  it('stays while a socket arrives within the ten minutes, and the wait starts over when it leaves', async () => {
    const { net, a } = await savedAlone()
    a.session!.close()
    await net.run({ timers: false })
    const epoch = await net.store.load(DOC)
    net.clock.setTimeout(() => {}, 5 * 60 * 1000)
    expect(net.clock.fire()).toBe(true)

    const c = await join(net, toyLines, 'c')
    await net.run({ timers: false })
    expect((await net.store.load(DOC))?.id).toBe(epoch!.id)
    expect(await shown(c)).toEqual(['x', 'one', 'two', 'three'])

    c.session!.close()
    await net.run({ timers: false })
    const left = net.clock.now()
    expect(net.clock.fire()).toBe(true)
    await net.settle()
    expect(net.clock.now() - left).toBe(10 * 60 * 1000)
    expect(await net.store.load(DOC)).toBeNull()
  })

  it('with unsaved changes outlives its sockets and the ten minutes: the next opener gets the base and the whole log', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await net.run()
    a.editor!.perform(ins('x', 0))
    await net.run()
    a.session!.close()
    await net.run()
    expect(await net.store.load(DOC)).not.toBeNull()

    const c = await join(net, toyLines, 'c')
    await net.run()
    expect(await shown(c)).toEqual(['x', 'one', 'two', 'three'])
  })

  it('reset by the host ends it for everyone; the next opener starts from the replaced file', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    a.editor!.perform(ins('x', 0))
    await net.run()

    await net.server.reset(DOC)
    await net.run()
    for (const client of [a, b]) {
      expect(client.session!.status()).toMatchObject({ phase: 'failed', failure: 'reset' })
    }
    expect(await net.store.load(DOC)).toBeNull()

    const replaced = encoder.encode(JSON.stringify(['replaced']))
    const c = await join(net, toyLines, 'c', { bytes: replaced })
    await net.run()
    expect(c.join!.baseBytes).toEqual(replaced)
    expect(await shown(c)).toEqual(['replaced'])
  })
})

describe('failures', () => {
  it('a view-only principal follows along, and an edit it sends anyway is forbidden', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const viewer = await join(net, toyLines, 'viewer', { canEdit: false })
    await net.run()
    expect(viewer.session!.status().canEdit).toBe(false)
    expect(viewer.editor!.editable).toBe(false)

    a.editor!.perform(ins('x', 0))
    await net.run()
    expect(await shown(viewer)).toEqual(['x', 'one', 'two', 'three'])

    viewer.session!.reportSaved(1)
    await net.run()
    expect(a.session!.status().saved).toBe(0)

    viewer.editor!.perform(ins('sneaky', 0))
    // The editor now differs from the document; nothing goes to the server
    expect(viewer.session!.status()).toMatchObject({ phase: 'failed', failure: 'forbidden' })
    await net.run()
    expect(viewer.session!.status()).toMatchObject({ phase: 'failed', failure: 'forbidden' })
    expect(await opIds(net)).toEqual([['x']])
    expect(a.session!.status()).toMatchObject({ phase: 'live', version: 1 })
  })

  it('a client whose adapter drops remote edits trips the divergence alarm for everyone', async () => {
    const net = new SimNetwork()
    const broken = (bytes: Uint8Array): ToyEditor<MapOp> => {
      const editor = toyMap.open(bytes)
      const integrate = editor.integrate
      editor.integrate = (remote, local) =>
        integrate(
          remote.filter((op) => op.key !== 'a'),
          local,
        )
      return editor
    }
    const a = await join(net, toyMap, 'a')
    const b = await join(net, toyMap, 'b', { factory: broken })
    await net.run()

    a.editor!.perform({ id: 'a1', key: 'a', value: 1 })
    await net.run()
    for (const client of [a, b]) {
      expect(client.session!.status()).toMatchObject({ phase: 'failed', failure: 'diverged' })
      expect(client.editor!.editable).toBe(false)
    }
    // Nothing was saved, and still the epoch is gone: the next opener starts from the stored file
    expect(await net.store.load(DOC)).toBeNull()
    const stored = encoder.encode(JSON.stringify([['z', 9]]))
    const next = await join(net, toyMap, 'next', { bytes: stored })
    await net.run()
    expect(next.join!.baseBytes).toEqual(stored)
    expect(await shown(next)).toEqual([['z', 9]])
  })

  it('an adapter that emits from inside integrate fails with adapter', async () => {
    const net = new SimNetwork()
    let echo: ((ops: LineOp[]) => void) | null = null
    const echoing = (bytes: Uint8Array): ToyEditor<LineOp> => {
      const editor = toyLines.open(bytes)
      const listen = editor.listen
      const integrate = editor.integrate
      editor.listen = (emit) => {
        echo = emit
        return listen(emit)
      }
      editor.integrate = (remote, local) => {
        echo?.([ins('echo', 0)])
        return integrate(remote, local)
      }
      return editor
    }
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b', { factory: echoing })
    await net.run()

    a.editor!.perform(ins('x', 0))
    await net.run()
    expect(b.session!.status()).toMatchObject({ phase: 'failed', failure: 'adapter' })
    expect(await opIds(net)).toEqual([['x']])
  })
})

/** what a promise settled with by now: the value, the error, or 'pending' */
function track<T>(promise: Promise<T>): { outcome: T | unknown | 'pending' } {
  const box: { outcome: T | unknown | 'pending' } = { outcome: 'pending' }
  promise.then(
    (value) => (box.outcome = value),
    (error: unknown) => (box.outcome = error),
  )
  return box
}

function codeOf(outcome: unknown): string | null {
  return outcome instanceof CollabError ? outcome.code : null
}

describe('edits the editor makes on its own', () => {
  it('one committed when input freezes for a save is submitted, confirmed and saved', async () => {
    const net = new SimNetwork()
    let composing: LineOp | null = null
    const composer = (bytes: Uint8Array): ToyEditor<LineOp> => {
      const editor = toyLines.open(bytes)
      const setEditable = editor.setEditable
      editor.setEditable = (value) => {
        if (!value && composing) {
          const op = composing
          composing = null
          editor.perform(op)
        }
        setEditable(value)
      }
      return editor
    }
    const a = await join(net, toyLines, 'a', { factory: composer })
    const b = await join(net, toyLines, 'b')
    await net.run()

    composing = ins('typed', 0)
    const saving = a.session!.save()
    await net.run()
    const saved = await saving
    expect(saved.version).toBe(1)
    expect(JSON.parse(decoder.decode(saved.bytes))).toEqual(['typed', 'one', 'two', 'three'])
    expect(a.session!.status()).toMatchObject({ phase: 'live', unconfirmed: 0 })
    expect(await shown(b)).toEqual(['typed', 'one', 'two', 'three'])
  })

  it('one made when its own edit is confirmed is ordinary, and no fingerprint catches it unconfirmed', async () => {
    const net = new SimNetwork()
    let follow = true
    const follower = (bytes: Uint8Array): ToyEditor<LineOp> => {
      const editor = toyLines.open(bytes)
      const confirmed = editor.confirmed!
      editor.confirmed = (ops) => {
        confirmed(ops)
        if (follow) {
          follow = false
          editor.perform(ins('auto', 0))
        }
      }
      return editor
    }
    const a = await join(net, toyLines, 'a', { factory: follower })
    const b = await join(net, toyLines, 'b')
    await net.run()
    // Ten minutes on, both clients are due a fingerprint the moment their version moves
    net.clock.setTimeout(() => {}, 10 * 60 * 1000)
    net.clock.fire()

    a.editor!.perform(ins('x', 0))
    await net.run()
    for (const client of [a, b]) {
      expect(client.session!.status()).toMatchObject({ phase: 'live', version: 2, unconfirmed: 0 })
    }
    expect(await opIds(net)).toEqual([['x'], ['auto']])
    expect(await shown(b)).toEqual(await shown(a))
  })
})

describe('getting work out', () => {
  it('exportLocal returns what is on screen, unconfirmed edits included, while offline', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await join(net, toyLines, 'b')
    await net.run()
    net.break(a.link.current!)
    a.editor!.perform(ins('offline', 0))

    const file = await a.session!.exportLocal()
    expect(JSON.parse(decoder.decode(file.bytes))).toEqual(['offline', 'one', 'two', 'three'])
    expect(file).not.toHaveProperty('version')
    expect(a.session!.status()).toMatchObject({ phase: 'offline', unconfirmed: 1 })
    expect(a.editor!.editable).toBe(true)
    expect(await opIds(net)).toEqual([])
  })

  it('exportLocal works on a failed session', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await net.run()
    net.break(a.link.current!)
    a.editor!.perform(ins('lost', 0))
    await net.server.reset(DOC)
    await net.run()
    expect(a.session!.status().phase).toBe('failed')

    const file = await a.session!.exportLocal()
    expect(JSON.parse(decoder.decode(file.bytes))).toEqual(['lost', 'one', 'two', 'three'])
    expect(a.editor!.editable).toBe(false)
  })

  it('exportLocal holds remote changes until its file is made', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()

    // An editor that reads its document only after some asynchronous work
    const gate = deferred<void>()
    const produce = a.editor!.produceFile
    a.editor!.produceFile = async () => {
      await gate.promise
      return produce()
    }
    const exporting = a.session!.exportLocal()
    b.editor!.perform(ins('remote', 0))
    for (;;) {
      const next = oldest(net.upReady(), 'up', oldest(net.downReady(), 'down'))
      if (!next) break
      void (next.direction === 'up'
        ? net.deliverUp(next.connection)
        : net.deliverDown(next.connection))
      await net.server.idle()
      await b.engine.settled()
    }
    gate.resolve()
    const file = await exporting
    expect(JSON.parse(decoder.decode(file.bytes))).toEqual(['one', 'two', 'three'])

    await net.run()
    expect(await shown(a)).toEqual(['remote', 'one', 'two', 'three'])
    expect(a.session!.status()).toMatchObject({ phase: 'live', version: 1 })
  })

  it('exportLocal includes an edit committed when input freezes, and the edit goes out as usual', async () => {
    const net = new SimNetwork()
    let composing: LineOp | null = null
    const composer = (bytes: Uint8Array): ToyEditor<LineOp> => {
      const editor = toyLines.open(bytes)
      const setEditable = editor.setEditable
      editor.setEditable = (value) => {
        if (!value && composing) {
          const op = composing
          composing = null
          editor.perform(op)
        }
        setEditable(value)
      }
      return editor
    }
    const a = await join(net, toyLines, 'a')
    await net.run()
    const b = await join(net, toyLines, 'b', { factory: composer })
    await net.run()
    composing = ins('typed', 0)

    const file = await b.session!.exportLocal()
    expect(JSON.parse(decoder.decode(file.bytes))).toEqual(['typed', 'one', 'two', 'three'])
    await net.run()
    expect(b.session!.status()).toMatchObject({ phase: 'live', unconfirmed: 0, version: 1 })
    expect(await shown(a)).toEqual(['typed', 'one', 'two', 'three'])
  })

  it('a save that cannot confirm within 30 s rejects with offline, unfreezes input and keeps the edits', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await join(net, toyLines, 'b')
    await net.run()
    net.break(a.link.current!)
    a.editor!.perform(ins('offline', 0))

    const start = net.clock.now()
    const saving = track(a.session!.save())
    expect(a.editor!.editable).toBe(false)
    while (saving.outcome === 'pending' && net.clock.fire()) await net.settle()
    expect(codeOf(saving.outcome)).toBe('offline')
    expect(net.clock.now() - start).toBe(30_000)
    expect(a.editor!.editable).toBe(true)
    expect(a.session!.status().unconfirmed).toBe(1)

    await net.run()
    expect(await opIds(net)).toEqual([['offline']])
    const saved = await a.session!.save()
    expect(saved.version).toBe(1)
  })

  it('a save on a closed session rejects with closed', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await net.run()
    a.session!.close()
    const saving = track(a.session!.save())
    await net.settle()
    expect(codeOf(saving.outcome)).toBe('closed')
  })
})

describe('a large edit', () => {
  it('such as a pasted picture of 1 MiB goes out alone as one change, between small ones', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    net.break(a.link.current!)
    a.editor!.perform(ins('before', 0))
    a.editor!.perform(ins('x'.repeat(1024 * 1024), 0))
    a.editor!.perform(ins('after', 0))
    await net.run()

    expect(a.session!.status()).toMatchObject({ phase: 'live', unconfirmed: 0 })
    const versions = await opIds(net)
    expect(versions.map((ids) => ids.length)).toEqual([1, 1, 1])
    expect(versions[1]?.[0]).toBe('x'.repeat(1024 * 1024))
    expect(await shown(b)).toEqual(await shown(a))
  })
})

describe('an edit too large for one change', () => {
  it('fails the session with its size named, and is never sent', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    const b = await join(net, toyLines, 'b')
    await net.run()
    const op = ins('x'.repeat(MAX_CHANGE_BYTES), 0)
    a.editor!.perform(op)
    await net.run()
    expect(a.session!.status()).toMatchObject({ phase: 'failed', failure: 'adapter' })
    const error = await a.session!.save().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CollabError)
    expect((error as CollabError).code).toBe('adapter')
    expect((error as CollabError).message).toContain(`${JSON.stringify(op).length} bytes`)
    expect(await opIds(net)).toEqual([])
    expect(b.session!.status().phase).toBe('live')
  })
})
