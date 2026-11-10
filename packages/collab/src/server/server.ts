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
import { deferred } from '../deferred.js'
import { MAX_CHANGE_BYTES } from '../limits.js'
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
import type { AppendResult, CollabStore, EpochHead } from './store.js'

/** Who is on the other end of a socket; the host authenticated the upgrade and decides it */
export interface Principal {
  documentId: string
  userId: string
  name: string
  canEdit: boolean
  /**
   * The sha-256 hex of the file the host holds as current. When given, a socket may seed a new
   * epoch only from exactly that file; others get `error forbidden`.
   */
  fileHash?: string | undefined
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
  /** how long a socket asked for the base may take to send it before the next editor is asked */
  seedTimeoutMs: number
  /** frames of one socket waiting to be handled; past it the socket is closed */
  maxQueuedFrames: number
  /**
   * Size of the frames of one socket waiting to be handled; past it the socket is closed. The
   * socket's first binary frame (its base upload) is not counted; `maxBaseBytes` bounds it.
   * Keep it at least `maxChangeBytes`, or one large change can never be received.
   */
  maxQueuedBytes: number
}

const DEFAULT_LIMITS: Limits = {
  maxChangeBytes: MAX_CHANGE_BYTES,
  maxBaseBytes: 50 * 1024 * 1024,
  catchUpPage: 200,
  idleEpochMs: 10 * 60 * 1000,
  seedTimeoutMs: 30_000,
  maxQueuedFrames: 256,
  maxQueuedBytes: 32 * 1024 * 1024,
}

/** setTimeout fires at once for longer delays */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface CollabServerOptions {
  store: CollabStore
  limits?: Partial<Limits> | undefined
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
  clock?: Clock | undefined
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
  /** frames received and not yet handled */
  inbox: number
  /** size of those frames, in string length or bytes */
  inboxBytes: number
  /** the socket sent its one binary frame, the base upload */
  sentBinary: boolean
  /** the socket is being closed for a frame it should not have sent; its later frames are ignored */
  refused: boolean
  /** while seeding: the timer that hands seeding on */
  seedTimer: unknown
}

/** What this process remembers about an epoch beyond what the store holds */
interface EpochState {
  id: string
  saved: number
  /** per version, the fingerprint each editing client last reported */
  fingerprints: Map<number, Map<string, string>>
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

  /**
   * Work for one socket inside a loop over several: when the store fails, only that socket is
   * closed (its client reconnects and resumes) and the loop goes on with the others.
   */
  async function forSocket(doc: Doc, conn: Conn, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch {
      await abort(doc, conn)
    }
  }

  async function remove(doc: Doc, conn: Conn): Promise<void> {
    if (conn.stage === 'closed') return
    const wasLive = conn.stage === 'live'
    conn.stage = 'closed'
    doc.conns.delete(conn)
    doc.waiting = doc.waiting.filter((other) => other !== conn)
    if (wasLive) broadcast(doc, { t: 'peers', peers: peersOf(doc) })
    if (doc.seeder === conn) {
      endSeeding(doc)
      await answerWaiting(doc)
    }
    if (doc.conns.size === 0) armIdle(doc)
  }

  function endSeeding(doc: Doc): void {
    clock.clearTimeout(doc.seeder?.seedTimer)
    doc.seeder = null
  }

  /** answer every waiting hello again, in order: the epoch now exists, or the next editor seeds */
  async function answerWaiting(doc: Doc): Promise<void> {
    const waiting = doc.waiting
    doc.waiting = []
    for (const other of waiting) {
      if (other.stage === 'waiting') await forSocket(doc, other, () => answerHello(doc, other))
    }
  }

  async function answerHello(doc: Doc, conn: Conn): Promise<void> {
    const hello = conn.hello!
    const epoch = await store.load(doc.id)
    const known = epoch ? epochState(doc, epoch) : null
    const decision = decideHello(epoch, hello, {
      seeding: doc.seeder !== null,
      owner: hello.resume ? known?.clients.get(hello.resume.client) : undefined,
      user: conn.principal.userId,
      canEdit: conn.principal.canEdit,
      currentHash: conn.principal.fileHash,
    })
    switch (decision.kind) {
      case 'need_base':
        conn.stage = 'seeding'
        doc.seeder = conn
        conn.seedTimer = clock.setTimeout(
          () =>
            void enqueue(doc, null, async () => {
              if (doc.seeder !== conn) return
              conn.socket.close(4000, 'no base')
              await remove(doc, conn)
            }),
          limits.seedTimeoutMs,
        )
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
    endSeeding(doc)
    await forSocket(doc, conn, () => answerHello(doc, conn))
    await answerWaiting(doc)
  }

  async function onSubmit(doc: Doc, conn: Conn, submit: SubmitFrame): Promise<void> {
    const sender = {
      client: conn.stage === 'live' ? conn.client : null,
      canEdit: conn.principal.canEdit,
      author: conn.principal.userId,
    }
    const decision = decideSubmit(sender, submit)
    if (decision.kind === 'reject') return reject(doc, conn, decision.code)
    let result: AppendResult
    try {
      result = await store.append(doc.id, conn.epoch!, decision.change)
    } catch {
      // Appended or not, the client finds out when it resumes: a duplicate submit is acked
      return abort(doc, conn)
    }
    switch (result.kind) {
      case 'appended': {
        const { client, seq, author, ops } = decision.change
        const change: Change = { v: result.v, client, seq, author, ops }
        await forSocket(doc, conn, async () => {
          if (conn.sent < change.v - 1) await catchUp(doc, conn, change.v - 1)
          send(conn, { t: 'ack', v: change.v, seq })
          conn.sent = change.v
        })
        const frame = changeFrame(change)
        for (const other of live(doc)) {
          if (other === conn) continue
          if (other.sent === change.v - 1) {
            send(other, frame)
            other.sent = change.v
          } else await forSocket(doc, other, () => catchUp(doc, other, change.v))
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
    // A view-only editor cannot be fixed by its user, and must not end everyone's epoch
    if (!conn.principal.canEdit) return
    const fingerprints = doc.epoch.fingerprints
    let atV = fingerprints.get(v)
    if (!atV) {
      atV = new Map()
      fingerprints.set(v, atV)
      if (fingerprints.size > FINGERPRINTS_KEPT)
        fingerprints.delete(fingerprints.keys().next().value!)
    }
    // A client's later report at one version replaces its earlier one
    atV.set(conn.client!, fp)
    if ([...atV.values()].every((other) => other === fp)) return
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
    if (conn.stage === 'closed' || conn.refused) return
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
        return answerHello(doc, conn)
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
        inbox: 0,
        inboxBytes: 0,
        sentBinary: false,
        refused: false,
        seedTimer: null,
      }
      doc.conns.add(conn)
      // Checked before queueing, so a socket cannot make the server hold what it will refuse
      socket.onMessage((frame) => {
        if (conn.stage === 'closed' || conn.refused) return
        if (tooLarge(frame)) {
          conn.refused = true
          void enqueue(doc, conn, () => reject(doc, conn, 'too_large'))
        } else {
          // A string's length bounds its memory to within a factor of two; no need to encode it
          const counted =
            typeof frame === 'string' ? frame.length : conn.sentBinary ? frame.byteLength : 0
          if (typeof frame !== 'string') conn.sentBinary = true
          if (
            conn.inbox >= limits.maxQueuedFrames ||
            conn.inboxBytes + counted > limits.maxQueuedBytes
          ) {
            conn.refused = true
            conn.socket.close(1008, 'too many frames')
            void enqueue(doc, conn, () => remove(doc, conn))
            return
          }
          conn.inbox += 1
          conn.inboxBytes += counted
          void enqueue(doc, conn, () => {
            conn.inbox -= 1
            conn.inboxBytes -= counted
            return onFrame(doc, conn, frame)
          })
        }
      })
      socket.onClose(() => void enqueue(doc, conn, () => remove(doc, conn)))
    },
    async reset(documentId) {
      const doc = docFor(documentId)
      cancelIdle(doc)
      const outcome: { failed: boolean; error?: unknown } = { failed: false }
      await enqueue(doc, null, async () => {
        try {
          evict(doc, [...doc.conns], { t: 'error', code: 'reset' }, 'reset')
          endSeeding(doc)
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
      const { promise, resolve } = deferred<void>()
      idleWaiters.push(resolve)
      return promise
    },
  }
}
