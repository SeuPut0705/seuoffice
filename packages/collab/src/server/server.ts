/**
 * The authority for the order of every edit (design section 3). Per document
 * it handles one event at a time on a promise chain, so a decision sees the
 * effects of every earlier frame, close and store call of that document. The
 * decisions themselves are the pure functions in decide.ts; this file is the
 * shell around sockets, timers and the store.
 *
 * An epoch ends in exactly three ways: it stayed without sockets for
 * `idleEpochMs` with every version saved, the host called `reset`, or two
 * fingerprints differed. A socket leaving never ends it by itself, so a
 * client that lost its connection can always resume.
 */

import { systemClock, type Clock } from '../clock.js'
import type { Change, Peer } from '../model.js'
import { sha256 } from '../sha256.js'
import {
  parseClientFrame,
  utf8Length,
  type BytesFrame,
  type ClientFrame,
  type ErrorCode,
  type HelloFrame,
  type ServerFrame,
  type SubmitFrame,
} from '../wire.js'
import { decideHello, decideSubmit, type HelloDecision } from './decide.js'
import type { CollabStore, EpochHead } from './store.js'

/** Who is on the other end of a socket; the host authenticated the upgrade and decides it */
export interface Principal {
  documentId: string
  userId: string
  name: string
  canEdit: boolean
}

/** One accepted WebSocket, adapted by the host from its WebSocket library */
export interface ServerSocket {
  send(frame: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage(handler: (frame: string | Uint8Array) => void): void
  onClose(handler: () => void): void
}

export interface Limits {
  /** the largest text frame, which bounds one submit with its ops */
  maxChangeBytes: number
  /** the largest base file a seeding socket may send */
  maxBaseBytes: number
  /** changes read from the store at a time while a socket catches up */
  catchUpPage: number
  /** how long a document stays without sockets before its saved epoch ends; Infinity keeps it */
  idleEpochMs: number
}

const DEFAULT_LIMITS: Limits = {
  maxChangeBytes: 256 * 1024,
  maxBaseBytes: 50 * 1024 * 1024,
  catchUpPage: 200,
  idleEpochMs: 10 * 60 * 1000,
}

/** setTimeout fires at once for longer delays */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface CollabServerOptions {
  store: CollabStore
  limits?: Partial<Limits>
}

export interface CollabServer {
  /** take a socket the host authenticated for `principal.documentId` */
  accept(socket: ServerSocket, principal: Principal): void
  /**
   * End the document's epoch now: every socket of it gets `error reset` and
   * closes. Call it after replacing the stored file outside co-editing; the
   * next opener starts a new epoch from that file.
   */
  reset(documentId: string): Promise<void>
  /** close every socket and wait until every document has settled; epochs stay in the store */
  close(): Promise<void>
}

export interface ServerCoreOptions extends CollabServerOptions {
  clock?: Clock
}

/** The server plus what the conformance kit needs to step it deterministically */
export interface ServerCore extends CollabServer {
  /** resolves once no document has queued work */
  idle(): Promise<void>
}

/** `new` until its hello; `closed` sockets are forgotten and their frames ignored */
type Stage = 'new' | 'seeding' | 'waiting' | 'live' | 'closed'

interface Conn {
  readonly socket: ServerSocket
  readonly principal: Principal
  /** acceptance order: a client opens a new socket only after giving up the old one */
  readonly accepted: number
  stage: Stage
  hello: HelloFrame | null
  client: string | null
  epoch: string | null
  /** the highest version this socket received; a change goes out only as `sent + 1` (invariant 4) */
  sent: number
}

/** What this process remembers about an epoch beyond what the store holds */
interface EpochState {
  id: string
  saved: number
  fingerprints: Map<number, string>
  /** client id to the user it was issued to */
  clients: Map<string, string>
}

interface Doc {
  readonly id: string
  readonly conns: Set<Conn>
  /** the socket asked for the base; the others wait in `waiting` */
  seeder: Conn | null
  waiting: Conn[]
  tail: Promise<void>
  queued: number
  /** the timer that ends a saved epoch nobody came back to */
  idle: unknown
  epoch: EpochState | null
}

type Welcome = Extract<HelloDecision, { kind: 'welcome' }>

const FINGERPRINTS_KEPT = 64

export function createCollabServer(options: CollabServerOptions): CollabServer {
  const { accept, reset, close } = createServerCore(options)
  return { accept, reset, close }
}

export function createServerCore({
  store,
  limits: overrides,
  clock = systemClock,
}: ServerCoreOptions): ServerCore {
  const limits: Limits = { ...DEFAULT_LIMITS, ...overrides }
  const docs = new Map<string, Doc>()
  let closing = false
  let busy = 0
  let idleWaiters: (() => void)[] = []
  let accepted = 0

  function docFor(id: string): Doc {
    let doc = docs.get(id)
    if (!doc) {
      doc = {
        id,
        conns: new Set(),
        seeder: null,
        waiting: [],
        tail: Promise.resolve(),
        queued: 0,
        idle: null,
        epoch: null,
      }
      docs.set(id, doc)
    }
    return doc
  }

  /** run `task` after everything queued for `doc`; resolves when it is done */
  function enqueue(doc: Doc, conn: Conn | null, task: () => Promise<void>): Promise<void> {
    doc.queued += 1
    busy += 1
    doc.tail = doc.tail
      .then(task)
      .catch(async () => {
        // The store failed: drop the socket so its client reconnects and resumes
        if (conn) await abort(doc, conn)
      })
      .catch(() => {})
      .then(() => {
        doc.queued -= 1
        busy -= 1
        // A document whose epoch this process knows stays, so client ids stay bound to users
        const forgettable = doc.conns.size === 0 && doc.idle === null && doc.epoch === null
        if (doc.queued === 0 && forgettable && docs.get(doc.id) === doc) docs.delete(doc.id)
        if (busy === 0) {
          const waiters = idleWaiters
          idleWaiters = []
          for (const resolve of waiters) resolve()
        }
      })
    return doc.tail
  }

  function send(conn: Conn, frame: ServerFrame | string | Uint8Array): void {
    if (conn.stage === 'closed') return
    try {
      conn.socket.send(
        typeof frame === 'string' || frame instanceof Uint8Array ? frame : JSON.stringify(frame),
      )
    } catch {
      // A socket that cannot take a frame is closing; its onClose removes it
    }
  }

  function live(doc: Doc): Conn[] {
    return [...doc.conns].filter((conn) => conn.stage === 'live')
  }

  function peersOf(doc: Doc): Peer[] {
    return live(doc).map((conn) => ({ client: conn.client!, name: conn.principal.name }))
  }

  function broadcast(doc: Doc, frame: ServerFrame, except?: Conn): void {
    const text = JSON.stringify(frame)
    for (const conn of live(doc)) if (conn !== except) send(conn, text)
  }

  function changeFrame({ v, client, seq, author, ops }: Change): string {
    return JSON.stringify({ t: 'change', v, client, seq, author, ops })
  }

  function epochState(doc: Doc, epoch: EpochHead): EpochState {
    if (doc.epoch?.id !== epoch.id) {
      doc.epoch = { id: epoch.id, saved: 0, fingerprints: new Map(), clients: new Map() }
    }
    doc.epoch.saved = Math.max(doc.epoch.saved, epoch.saved)
    return doc.epoch
  }

  async function dropEpoch(doc: Doc, epochId: string): Promise<void> {
    await store.drop(doc.id, epochId)
    if (doc.epoch?.id === epochId) doc.epoch = null
  }

  function cancelIdle(doc: Doc): void {
    if (doc.idle === null) return
    clock.clearTimeout(doc.idle)
    doc.idle = null
  }

  /** started when the last socket leaves; any accepted socket cancels it */
  function armIdle(doc: Doc): void {
    if (closing || doc.idle !== null || !Number.isFinite(limits.idleEpochMs)) return
    doc.idle = clock.setTimeout(
      () => {
        doc.idle = null
        void enqueue(doc, null, async () => {
          if (doc.conns.size > 0) return
          const epoch = await store.load(doc.id)
          if (epoch && epoch.saved === epoch.head) await dropEpoch(doc, epoch.id)
        })
      },
      Math.min(limits.idleEpochMs, MAX_TIMER_MS),
    )
  }

  /** close `conns` after one last frame, without the leave bookkeeping of `remove` */
  function evict(doc: Doc, conns: Conn[], frame: ServerFrame, reason: string): void {
    const text = JSON.stringify(frame)
    for (const conn of conns) {
      send(conn, text)
      conn.socket.close(4000, reason)
      conn.stage = 'closed'
      doc.conns.delete(conn)
    }
  }

  async function reject(doc: Doc, conn: Conn, code: ErrorCode): Promise<void> {
    send(conn, { t: 'error', code })
    conn.socket.close(4000, code)
    await remove(doc, conn)
  }

  async function abort(doc: Doc, conn: Conn): Promise<void> {
    if (conn.stage === 'closed') return
    conn.socket.close(1011, 'internal error')
    await remove(doc, conn)
  }

  async function remove(doc: Doc, conn: Conn): Promise<void> {
    if (conn.stage === 'closed') return
    const wasLive = conn.stage === 'live'
    conn.stage = 'closed'
    doc.conns.delete(conn)
    doc.waiting = doc.waiting.filter((other) => other !== conn)
    if (wasLive) broadcast(doc, { t: 'peers', peers: peersOf(doc) })
    if (doc.seeder === conn) {
      doc.seeder = null
      const next = doc.waiting.shift()
      if (next) await answerHello(doc, next, next.hello!)
    }
    if (doc.conns.size === 0) armIdle(doc)
  }

  async function answerHello(doc: Doc, conn: Conn, hello: HelloFrame): Promise<void> {
    const epoch = await store.load(doc.id)
    const known = epoch ? epochState(doc, epoch) : null
    const decision = decideHello(epoch, hello, {
      seeding: doc.seeder !== null,
      owner: hello.resume ? known?.clients.get(hello.resume.client) : undefined,
      user: conn.principal.userId,
    })
    switch (decision.kind) {
      case 'need_base':
        conn.stage = 'seeding'
        doc.seeder = conn
        send(conn, { t: 'need_base' })
        return
      case 'wait':
        conn.stage = 'waiting'
        doc.waiting.push(conn)
        return
      case 'reject':
        return reject(doc, conn, decision.code)
      case 'welcome':
        return welcome(doc, conn, decision)
    }
  }

  async function welcome(
    doc: Doc,
    conn: Conn,
    { epoch, client: resumed, start, sendBase }: Welcome,
  ): Promise<void> {
    const client = resumed ?? crypto.randomUUID()
    for (const other of live(doc)) {
      if (other.client !== client) continue
      // The older socket of one client goes, even when its hello is the one that arrived late
      if (other.accepted > conn.accepted) return reject(doc, conn, 'superseded')
      await reject(doc, other, 'superseded')
    }
    const state = epochState(doc, epoch)
    state.clients.set(client, conn.principal.userId)
    if (sendBase) {
      const base = await store.readBase(doc.id, epoch.id)
      send(conn, { t: 'base', bytes: base.byteLength })
      send(conn, base)
    }
    conn.stage = 'live'
    conn.client = client
    conn.epoch = epoch.id
    conn.sent = start
    send(conn, {
      t: 'welcome',
      epoch: epoch.id,
      client,
      start,
      head: epoch.head,
      saved: state.saved,
      canEdit: conn.principal.canEdit,
      peers: peersOf(doc),
    })
    await catchUp(doc, conn, epoch.head)
    broadcast(doc, { t: 'peers', peers: peersOf(doc) }, conn)
  }

  /** send `conn` every change after the ones it has, up to `to`, in pages */
  async function catchUp(doc: Doc, conn: Conn, to: number): Promise<void> {
    while (conn.stage === 'live' && conn.sent < to) {
      const page = await store.read(
        doc.id,
        conn.epoch!,
        conn.sent,
        Math.min(limits.catchUpPage, to - conn.sent),
      )
      if (page.length === 0) throw new Error('the log is shorter than its head')
      for (const change of page) {
        if (change.v !== conn.sent + 1) throw new Error('the log has a gap')
        send(conn, changeFrame(change))
        conn.sent = change.v
      }
    }
  }

  async function onBase(doc: Doc, conn: Conn, bytes: Uint8Array): Promise<void> {
    if (conn.stage !== 'seeding') return reject(doc, conn, 'bad_frame')
    const hello = conn.hello!
    if ((await sha256(bytes)) !== hello.fileHash) return reject(doc, conn, 'bad_frame')
    // A copy: the socket library may reuse the buffer it handed over
    const base = new Uint8Array(bytes)
    await store.create(doc.id, {
      id: crypto.randomUUID(),
      format: hello.format,
      baseHash: hello.fileHash,
      base,
    })
    doc.seeder = null
    await answerHello(doc, conn, hello)
    const waiting = doc.waiting
    doc.waiting = []
    for (const other of waiting)
      if (other.stage === 'waiting') await answerHello(doc, other, other.hello!)
  }

  async function onSubmit(doc: Doc, conn: Conn, submit: SubmitFrame): Promise<void> {
    const sender = {
      client: conn.stage === 'live' ? conn.client : null,
      canEdit: conn.principal.canEdit,
      author: conn.principal.userId,
    }
    const decision = decideSubmit(sender, submit)
    if (decision.kind === 'reject') return reject(doc, conn, decision.code)
    const result = await store.append(doc.id, conn.epoch!, decision.change)
    switch (result.kind) {
      case 'appended': {
        const { client, seq, author, ops } = decision.change
        const change: Change = { v: result.v, client, seq, author, ops }
        if (conn.sent < result.v - 1) await catchUp(doc, conn, result.v - 1)
        send(conn, { t: 'ack', v: result.v, seq })
        conn.sent = result.v
        const frame = changeFrame(change)
        for (const other of live(doc)) {
          if (other === conn) continue
          if (other.sent === change.v - 1) {
            send(other, frame)
            other.sent = change.v
          } else await catchUp(doc, other, change.v)
        }
        return
      }
      case 'duplicate':
        send(conn, { t: 'ack', v: result.v, seq: submit.seq })
        return
      case 'stale':
        await catchUp(doc, conn, result.head)
        send(conn, { t: 'stale', seq: submit.seq, base: submit.base, head: result.head })
        return
      case 'gone':
        return reject(doc, conn, 'reset')
    }
  }

  async function onFingerprint(doc: Doc, conn: Conn, v: number, fp: string): Promise<void> {
    if (conn.stage !== 'live' || v > conn.sent || !doc.epoch) return reject(doc, conn, 'bad_frame')
    const fingerprints = doc.epoch.fingerprints
    const known = fingerprints.get(v)
    if (known === undefined) {
      fingerprints.set(v, fp)
      if (fingerprints.size > FINGERPRINTS_KEPT)
        fingerprints.delete(fingerprints.keys().next().value!)
      return
    }
    if (known === fp) return
    // No file of this epoch can be trusted any more: its sockets go now, and with the last
    // of them the epoch, saved or not; the next opener starts from the host's stored file
    evict(doc, live(doc), { t: 'diverged', v }, 'diverged')
    await dropEpoch(doc, doc.epoch.id)
  }

  async function onSaved(doc: Doc, conn: Conn, v: number): Promise<void> {
    if (conn.stage !== 'live' || v > conn.sent) return reject(doc, conn, 'bad_frame')
    // Only an editor's host may declare the log stored: it lets the epoch end
    if (!conn.principal.canEdit) return reject(doc, conn, 'forbidden')
    const saved = await store.markSaved(doc.id, conn.epoch!, v)
    if (doc.epoch && saved > doc.epoch.saved) {
      doc.epoch.saved = saved
      broadcast(doc, { t: 'saved', v: saved })
    }
  }

  function tooLarge(raw: string | Uint8Array): boolean {
    if (raw instanceof Uint8Array) return raw.byteLength > limits.maxBaseBytes
    const max = limits.maxChangeBytes
    if (raw.length > max) return true
    return raw.length * 3 > max && utf8Length(raw) > max
  }

  async function onFrame(doc: Doc, conn: Conn, raw: string | Uint8Array): Promise<void> {
    if (conn.stage === 'closed') return
    if (tooLarge(raw)) return reject(doc, conn, 'too_large')
    let frame: ClientFrame | BytesFrame
    try {
      frame = parseClientFrame(raw)
    } catch {
      return reject(doc, conn, 'bad_frame')
    }
    switch (frame.t) {
      case 'hello':
        if (conn.stage !== 'new') return reject(doc, conn, 'bad_frame')
        conn.hello = frame
        return answerHello(doc, conn, frame)
      case 'bytes':
        return onBase(doc, conn, frame.bytes)
      case 'submit':
        return onSubmit(doc, conn, frame)
      case 'fingerprint':
        return onFingerprint(doc, conn, frame.v, frame.fp)
      case 'saved':
        return onSaved(doc, conn, frame.v)
    }
  }

  return {
    accept(socket, principal) {
      if (closing) {
        socket.close(1001, 'server closing')
        return
      }
      const doc = docFor(principal.documentId)
      cancelIdle(doc)
      const conn: Conn = {
        socket,
        principal,
        accepted: ++accepted,
        stage: 'new',
        hello: null,
        client: null,
        epoch: null,
        sent: 0,
      }
      doc.conns.add(conn)
      socket.onMessage((frame) => void enqueue(doc, conn, () => onFrame(doc, conn, frame)))
      socket.onClose(() => void enqueue(doc, conn, () => remove(doc, conn)))
    },
    async reset(documentId) {
      const doc = docFor(documentId)
      cancelIdle(doc)
      const outcome: { failed: boolean; error?: unknown } = { failed: false }
      await enqueue(doc, null, async () => {
        try {
          evict(doc, [...doc.conns], { t: 'error', code: 'reset' }, 'reset')
          doc.seeder = null
          doc.waiting = []
          const epoch = await store.load(doc.id)
          if (epoch) await dropEpoch(doc, epoch.id)
          doc.epoch = null
        } catch (error) {
          outcome.failed = true
          outcome.error = error
        }
      })
      if (outcome.failed) throw outcome.error
    },
    async close() {
      closing = true
      const tails = [...docs.values()].map((doc) => {
        cancelIdle(doc)
        return enqueue(doc, null, async () => {
          for (const conn of [...doc.conns]) {
            conn.socket.close(1001, 'server closing')
            await remove(doc, conn)
          }
        })
      })
      await Promise.all(tails)
    },
    idle() {
      if (busy === 0) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers<void>()
      idleWaiters.push(resolve)
      return promise
    },
  }
}
