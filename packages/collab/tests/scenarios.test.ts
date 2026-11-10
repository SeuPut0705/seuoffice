import { describe, expect, it } from 'vitest'
import { CollabError } from '../src/client/api'
import { oldest, SimNetwork, type SimClient } from '../src/conformance/network'
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

describe('reconnecting', () => {
  it('waits 0.5 s, doubling up to 15 s, and starts over once welcomed again', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyLines, 'a')
    await join(net, toyLines, 'b')
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

    await net.run()
    expect(a.session!.status().phase).toBe('live')
    expect(await nextAttempt()).toBe(500)
  })
})

describe('joining', () => {
  it('a late joiner after 500 changes reaches the same state', async () => {
    const net = new SimNetwork()
    const a = await join(net, toyMap, 'a')
    await net.run()
    for (let i = 0; i < 500; i++) {
      a.editor!.perform({ id: `a${i}`, key: 'abcde'[i % 5], value: i })
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
    const gate = Promise.withResolvers<void>()
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
