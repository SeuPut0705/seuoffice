import { describe, expect, it } from 'vitest'
import { CollabError, type CollabLink, type CollabLinkEvent } from '../src/client/api'
import { startEngine } from '../src/client/join'
import { VirtualClock } from '../src/conformance/network'
import { toyLines } from '../src/conformance/toys'

/** The page's side of a connection to a broken server that says whatever the test makes it say */
class StubLink implements CollabLink {
  opens = 0
  readonly sent: (string | Uint8Array)[] = []
  readonly #handlers = new Set<(event: CollabLinkEvent) => void>()
  #state: 'idle' | 'connecting' | 'open' = 'idle'

  open(): void {
    if (this.#state !== 'idle') return
    this.#state = 'connecting'
    this.opens += 1
  }

  send(frame: string | Uint8Array): void {
    if (this.#state !== 'open') throw new Error('sent outside an open connection')
    this.sent.push(frame)
  }

  close(): void {
    this.#state = 'idle'
  }

  subscribe(handler: (event: CollabLinkEvent) => void): () => void {
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  accept(): void {
    this.#state = 'open'
    this.#emit({ type: 'open' })
  }

  deliver(frame: object | string): void {
    this.#emit({ type: 'frame', frame: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  /** the host or the network ended the connection */
  hangUp(): void {
    this.#state = 'idle'
    this.#emit({ type: 'close' })
  }

  lastSent(): unknown {
    const text = this.sent.filter((frame) => typeof frame === 'string').at(-1)
    return text === undefined ? undefined : JSON.parse(text)
  }

  #emit(event: CollabLinkEvent): void {
    for (const handler of [...this.#handlers]) handler(event)
  }
}

const welcome = (start: number, head = start) => ({
  t: 'welcome',
  epoch: 'e1',
  client: 'c1',
  start,
  head,
  saved: 0,
  canEdit: true,
  peers: [],
})

const change = (v: number) => ({
  t: 'change',
  v,
  client: 'other',
  seq: v,
  author: 'other',
  ops: [{ id: `o${v}`, t: 'ins', at: 0, text: `o${v}` }],
})

/** a change past the next version: a gap no correct server leaves */
const gap = change(99)

async function started() {
  const link = new StubLink()
  const clock = new VirtualClock()
  const engine = startEngine(link, { format: toyLines.format, bytes: toyLines.file() }, clock)
  await engine.settled()
  return { link, clock, engine }
}

/** fire timers until the engine opens its next connection; false when it never does */
function reconnected(link: StubLink, clock: VirtualClock): boolean {
  const opens = link.opens
  while (link.opens === opens) if (!clock.fire()) return false
  return true
}

async function joined() {
  const { link, clock, engine } = await started()
  link.accept()
  link.deliver(welcome(0))
  const session = (await engine.join).attach(toyLines.open(toyLines.file()))
  expect(session.status().phase).toBe('live')
  return { link, clock, session }
}

describe('a server that keeps breaking the protocol', () => {
  it('before any welcome: the third broken connection rejects the join with reset', async () => {
    const { link, clock, engine } = await started()
    const outcome = engine.join.then(
      () => null,
      (error: unknown) => error,
    )
    for (let i = 0; i < 3; i++) {
      if (i > 0) expect(reconnected(link, clock)).toBe(true)
      link.accept()
      expect(link.lastSent()).toMatchObject({ t: 'hello' })
      link.deliver('not a frame')
    }
    const error = await outcome
    expect(error).toBeInstanceOf(CollabError)
    expect((error as CollabError).code).toBe('reset')
    expect(reconnected(link, clock)).toBe(false)
  })

  it('after joining: the third broken connection in a row fails the session with reset', async () => {
    const { link, clock, session } = await joined()
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        expect(reconnected(link, clock)).toBe(true)
        link.accept()
        link.deliver(welcome(0))
      }
      link.deliver(gap)
    }
    expect(session.status()).toMatchObject({ phase: 'failed', failure: 'reset' })
    expect(reconnected(link, clock)).toBe(false)
  })

  it('a change that gets through starts the count over', async () => {
    const { link, clock, session } = await joined()
    link.deliver(gap)
    expect(reconnected(link, clock)).toBe(true)
    link.accept()
    link.deliver(welcome(0))
    link.deliver(gap)

    expect(reconnected(link, clock)).toBe(true)
    link.accept()
    link.deliver(welcome(0, 1))
    link.deliver(change(1))
    link.deliver(gap)
    for (let i = 0; i < 2; i++) {
      expect(reconnected(link, clock)).toBe(true)
      link.accept()
      link.deliver(welcome(1))
      link.deliver(gap)
    }
    expect(session.status()).toMatchObject({ phase: 'offline', version: 1 })

    expect(reconnected(link, clock)).toBe(true)
    link.accept()
    link.deliver(welcome(1))
    link.deliver(gap)
    expect(session.status()).toMatchObject({ phase: 'failed', failure: 'reset' })
  })
})

describe('a frame from a socket the engine gave up', () => {
  it('is nothing, a superseded included, and the next hello names a newer attempt', async () => {
    const { link, clock, session } = await joined()
    link.hangUp()
    link.deliver({ t: 'error', code: 'superseded' })
    link.deliver('not a frame')
    expect(session.status()).toMatchObject({ phase: 'offline' })

    expect(reconnected(link, clock)).toBe(true)
    link.accept()
    expect(link.lastSent()).toMatchObject({
      t: 'hello',
      resume: { epoch: 'e1', client: 'c1', v: 0, attempt: 2 },
    })
    link.deliver(welcome(0))
    expect(session.status().phase).toBe('live')
  })
})
