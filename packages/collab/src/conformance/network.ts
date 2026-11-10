/**
 * An in-memory network between engines and the real server, stepped one
 * delivery at a time. Each connection has a queue toward the server and one
 * toward the client; frames inside a queue keep their order, queues of
 * different connections interleave as the caller chooses. A broken
 * connection loses what was travelling to the client at once, while what the
 * client had sent may still reach the server later, followed by the close.
 * After every step `settle` waits until the server and every engine have
 * finished the work it started, so a schedule replays exactly.
 */

import type {
  CollabAdapter,
  CollabFile,
  CollabJoin,
  CollabLink,
  CollabLinkEvent,
  CollabSession,
} from '../client/api.js'
import { startEngine, type Engine } from '../client/join.js'
import type { Clock } from '../clock.js'
import type { Json } from '../model.js'
import {
  createServerCore,
  type Limits,
  type Principal,
  type ServerCore,
  type ServerSocket,
} from '../server/server.js'
import {
  memoryStore,
  type AppendRequest,
  type AppendResult,
  type CollabStore,
} from '../server/store.js'
import { parseClientFrame } from '../wire.js'

/** An adapter the kit can drive without a person */
export interface SimulatedEditor<Op> extends CollabAdapter<Op> {
  /** make one random local edit tagged `id` and report it through `listen`; false when it made none */
  edit(random: () => number, id: string): boolean
  /** the `id` an encoded op was tagged with by `edit`; `integrate` must keep it */
  opKey(op: Json): string
}

export class VirtualClock implements Clock {
  #now = 0
  #next = 1
  readonly #timers = new Map<number, { at: number; run: () => void }>()

  now(): number {
    return this.#now
  }

  setTimeout(run: () => void, ms: number): number {
    const id = this.#next++
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), run })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number)
  }

  get pending(): number {
    return this.#timers.size
  }

  /** jump to the earliest timer and run it; false when none is set */
  fire(): boolean {
    let first: [number, { at: number; run: () => void }] | undefined
    for (const entry of this.#timers) if (!first || entry[1].at < first[1].at) first = entry
    if (!first) return false
    this.#timers.delete(first[0])
    this.#now = Math.max(this.#now, first[1].at)
    first[1].run()
    return true
  }
}

type Frame = string | Uint8Array

type Toward<Start extends string> =
  { kind: Start } | { kind: 'frame'; frame: Frame } | { kind: 'close' }
type UpItem = Toward<'connect'> & { stamp: number }
type DownItem = Toward<'open'> & { stamp: number }

export class SimConnection {
  readonly up: UpItem[] = []
  readonly down: DownItem[] = []
  /** the client still treats this connection as its own */
  clientOpen = true
  /** the client got its `open` event */
  opened = false
  accepted = false
  /** accepted and not closed as far as the server knows */
  serverOpen = false
  closeNotified = false
  /** frames toward the server wait until the link's next hello has reached it */
  held = false
  onMessage: ((frame: Frame) => void) | null = null
  onClose: (() => void) | null = null

  constructor(readonly link: SimLink) {}
}

export class SimLink implements CollabLink {
  current: SimConnection | null = null
  readonly connections: SimConnection[] = []
  readonly #handlers = new Set<(event: CollabLinkEvent) => void>()

  constructor(
    readonly net: SimNetwork,
    readonly principal: Principal,
  ) {}

  open(): void {
    if (this.current?.clientOpen) return
    const connection = new SimConnection(this)
    this.connections.push(connection)
    this.current = connection
    this.net.push(connection, 'up', { kind: 'connect' })
  }

  send(frame: Frame): void {
    const connection = this.current
    if (!connection?.clientOpen || !connection.opened)
      throw new Error('the engine sent outside an open connection')
    this.net.push(connection, 'up', { kind: 'frame', frame })
  }

  close(): void {
    const connection = this.current
    if (!connection?.clientOpen) return
    connection.clientOpen = false
    connection.down.length = 0
    this.net.push(connection, 'up', { kind: 'close' })
  }

  subscribe(handler: (event: CollabLinkEvent) => void): () => void {
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  emit(event: CollabLinkEvent): void {
    for (const handler of [...this.#handlers]) handler(event)
  }
}

export class SimClient<Op, E extends SimulatedEditor<Op> = SimulatedEditor<Op>> {
  readonly link: SimLink
  readonly engine: Engine
  join: CollabJoin | null = null
  joinError: unknown = null
  editor: E | null = null
  session: CollabSession | null = null
  /** ids of every op this client's editor emitted through `edit` */
  readonly emitted: string[] = []

  constructor(
    readonly net: SimNetwork,
    readonly principal: Principal,
    readonly file: CollabFile,
    readonly factory: (bytes: Uint8Array) => E,
  ) {
    this.link = new SimLink(net, principal)
    this.engine = startEngine(this.link, file, net.clock)
    this.engine.join.then(
      (join) => (this.join = join),
      (error: unknown) => (this.joinError = error),
    )
  }

  /** open the bytes the join named and plug the editor in */
  attach(): E {
    const editor = this.factory(this.join!.baseBytes)
    this.editor = editor
    this.session = this.join!.attach(editor)
    return editor
  }

  edit(random: () => number): boolean {
    const id = `${this.principal.userId}.${this.emitted.length}`
    if (!this.editor!.edit(random, id)) return false
    this.emitted.push(id)
    return true
  }
}

export interface SimNetworkOptions {
  limits?: Partial<Limits> | undefined
}

export class SimNetwork {
  readonly clock = new VirtualClock()
  readonly store: CollabStore
  readonly server: ServerCore
  readonly clients: SimClient<unknown>[] = []
  /** runs after the store appended a change and before the server answers it */
  afterAppend: ((change: AppendRequest, result: AppendResult) => void) | null = null
  /** sees every frame the moment a client receives it */
  onDeliver: ((connection: SimConnection, frame: Frame) => void) | null = null
  readonly stats = { breaks: 0, lateFrames: 0 }
  #stamp = 0

  constructor(options: SimNetworkOptions = {}) {
    const inner = memoryStore()
    this.store = {
      load: (documentId) => inner.load(documentId),
      create: (documentId, epoch) => inner.create(documentId, epoch),
      readBase: (documentId, epochId) => inner.readBase(documentId, epochId),
      append: async (documentId, epochId, change) => {
        const result = await inner.append(documentId, epochId, change)
        this.afterAppend?.(change, result)
        return result
      },
      read: (documentId, epochId, after, limit) => inner.read(documentId, epochId, after, limit),
      markSaved: (documentId, epochId, v) => inner.markSaved(documentId, epochId, v),
      drop: (documentId, epochId) => inner.drop(documentId, epochId),
    }
    this.server = createServerCore({ store: this.store, limits: options.limits, clock: this.clock })
  }

  /** a client whose engine has hashed its file and asked to connect */
  async client<Op, E extends SimulatedEditor<Op>>(
    principal: Principal,
    file: CollabFile,
    factory: (bytes: Uint8Array) => E,
  ): Promise<SimClient<Op, E>> {
    const client = new SimClient<Op, E>(this, principal, file, factory)
    this.clients.push(client as unknown as SimClient<unknown>)
    await client.engine.settled()
    return client
  }

  push(connection: SimConnection, direction: 'up', item: Toward<'connect'>): void
  push(connection: SimConnection, direction: 'down', item: Toward<'open'>): void
  push(
    connection: SimConnection,
    direction: 'up' | 'down',
    item: Toward<'connect' | 'open'>,
  ): void {
    // Nothing reaches a client that has let go of the connection
    if (direction === 'down' && !connection.clientOpen) return
    ;(connection[direction] as (UpItem | DownItem)[]).push({ ...item, stamp: ++this.#stamp } as
      UpItem | DownItem)
  }

  connections(): SimConnection[] {
    return this.clients.flatMap((client) => client.link.connections)
  }

  upReady(): SimConnection[] {
    return this.connections().filter((connection) => connection.up.length > 0 && !connection.held)
  }

  downReady(): SimConnection[] {
    return this.connections().filter((connection) => connection.down.length > 0)
  }

  async deliverUp(connection: SimConnection): Promise<void> {
    const item = connection.up.shift()!
    switch (item.kind) {
      case 'connect':
        connection.accepted = true
        connection.serverOpen = true
        this.server.accept(this.#socket(connection), connection.link.principal)
        this.push(connection, 'down', { kind: 'open' })
        break
      case 'frame':
        if (!connection.serverOpen) break
        if (!connection.clientOpen) this.stats.lateFrames += 1
        if (isHello(item.frame)) {
          for (const older of connection.link.connections)
            if (older !== connection) older.held = false
        }
        connection.onMessage?.(item.frame)
        break
      case 'close':
        if (!connection.accepted || connection.closeNotified) break
        connection.closeNotified = true
        connection.serverOpen = false
        connection.onClose?.()
        break
    }
    await this.settle()
  }

  async deliverDown(connection: SimConnection): Promise<void> {
    const item = connection.down.shift()!
    if (connection.clientOpen) {
      switch (item.kind) {
        case 'open':
          connection.opened = true
          connection.link.emit({ type: 'open' })
          break
        case 'frame':
          this.onDeliver?.(connection, item.frame)
          connection.link.emit({ type: 'frame', frame: item.frame })
          break
        case 'close':
          connection.clientOpen = false
          connection.link.emit({ type: 'close' })
          break
      }
    }
    await this.settle()
  }

  /**
   * The network ends `connection`: its client hears `close` now. Unless
   * `drop`, what the client already sent still reaches the server, ahead of
   * the close; `hold` keeps it back until the client's next hello arrived.
   */
  break(connection: SimConnection, options: { drop?: boolean; hold?: boolean } = {}): void {
    this.stats.breaks += 1
    if (connection.clientOpen) {
      connection.clientOpen = false
      connection.down.length = 0
      connection.link.emit({ type: 'close' })
    }
    if (options.drop) connection.up.length = 0
    connection.held = options.hold ?? false
    this.push(connection, 'up', { kind: 'close' })
  }

  async settle(): Promise<void> {
    await this.server.idle()
    for (const client of this.clients) await client.engine.settled()
  }

  /**
   * Deliver everything in send order, attach every joined client, and fire
   * timers when nothing else is left, until the network is quiet.
   */
  async run(options: { timers?: boolean } = {}): Promise<void> {
    for (let turn = 0; turn < 100_000; turn++) {
      const next = oldest(this.upReady(), 'up', oldest(this.downReady(), 'down'))
      if (next) {
        await (next.direction === 'up'
          ? this.deliverUp(next.connection)
          : this.deliverDown(next.connection))
        continue
      }
      const joined = this.clients.find((client) => client.join && !client.session)
      if (joined) {
        joined.attach()
        await this.settle()
        continue
      }
      if (options.timers !== false && this.clock.fire()) {
        await this.settle()
        continue
      }
      return
    }
    throw new Error('the network did not go quiet')
  }

  #socket(connection: SimConnection): ServerSocket {
    return {
      send: (frame) => {
        if (connection.serverOpen) this.push(connection, 'down', { kind: 'frame', frame })
      },
      close: () => {
        if (!connection.serverOpen) return
        connection.serverOpen = false
        this.push(connection, 'down', { kind: 'close' })
        // The socket library reports the close back to the server later
        this.push(connection, 'up', { kind: 'close' })
      },
      onMessage: (handler) => {
        connection.onMessage = handler
      },
      onClose: (handler) => {
        connection.onClose = handler
      },
    }
  }
}

type Next = { connection: SimConnection; direction: 'up' | 'down'; stamp: number }

/** the connection whose next item in `direction` was queued first, or `than` when that is older */
export function oldest(
  connections: SimConnection[],
  direction: 'up' | 'down',
  than?: Next,
): Next | undefined {
  let best = than
  for (const connection of connections) {
    const stamp = connection[direction][0]?.stamp
    if (stamp === undefined) continue
    if (!best || stamp < best.stamp) best = { connection, direction, stamp }
  }
  return best
}

function isHello(frame: Frame): boolean {
  try {
    return parseClientFrame(frame).t === 'hello'
  } catch {
    return false
  }
}
