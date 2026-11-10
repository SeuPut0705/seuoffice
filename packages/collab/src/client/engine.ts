/**
 * The client engine as a pure reducer (design section 5): `(state, event) =>
 * { state, effects }`. join.ts is the shell that feeds it link, adapter and
 * timer events and carries out its effects. The reducer never mutates its
 * input state.
 *
 * Local ops wait in `pending`; at most one submit is in flight. A foreign
 * change at `confirmed + 1` proves the in-flight submit can never be appended
 * (it names the same base), so it becomes `doomed`: its ops move into the
 * rewritten `pending` and the next submit reuses its seq. `integrate` is the
 * one effect whose result the reducer needs; it is always the last effect of
 * a step, and its result comes back as the `integrated` event before anything
 * else happens.
 *
 * Any adapter call may make the editor emit an edit, and that edit reaches
 * the reducer only as a later `local` event. So whatever must see the editor
 * with nothing unconfirmed (a fingerprint, producing a file) is decided in a
 * step of its own, reached through a `then` effect that queues its event
 * behind every edit the earlier effects caused.
 */

import { MAX_CHANGE_BYTES, SUBMIT_CHUNK_BYTES, SUBMIT_FRAME_BYTES } from '../limits.js'
import type { Change, Format, Json, Peer } from '../model.js'
import {
  utf8Length,
  type BytesFrame,
  type ClientFrame,
  type ErrorCode,
  type ServerFrame,
} from '../wire.js'
import type { CollabFailure, CollabStatus } from './api.js'

const RECONNECT_FIRST_MS = 500
const RECONNECT_LAST_MS = 15_000
const FINGERPRINT_EVERY_MS = 10_000
/** Connections in a row that broke the protocol before any change came through */
const PROTOCOL_STRIKES = 3

/** `hello`: sent, waiting for welcome; `catching_up`: welcomed, changes up to its head still coming */
type Connection = 'down' | 'connecting' | 'hello' | 'catching_up' | 'live'

export type TimerName = 'reconnect' | 'fingerprint' | 'save'

export type Purpose = 'save' | 'export'

export interface ProducedFile {
  fileName: string
  bytes: Uint8Array
}

interface Inflight<Op> {
  seq: number
  base: number
  ops: Op[]
  /** what was sent, so a resend after a reconnect is byte for byte the same submit */
  json: Json[]
  doomed: boolean
}

export interface EngineState<Op> {
  format: Format
  fileHash: string
  saveTimeoutMs: number
  connection: Connection
  everLive: boolean
  joined: boolean
  failure: CollabFailure | null
  /** a sentence for people about the failure, carried by the `CollabError` of saves and joins */
  detail: string | null
  closed: boolean
  attempts: number
  /** connections in a row that ended in a protocol violation without a change getting through */
  strikes: number
  /** this connection received or confirmed a change */
  progressed: boolean
  epoch: string | null
  client: string | null
  canEdit: boolean
  saved: number
  peers: Peer[]
  /** the head named by the last welcome */
  target: number
  /** the version the editor shows */
  confirmed: number
  /** received after `confirmed` but not applied: before attach, and while a file is produced */
  held: Change[]
  attached: boolean
  inflight: Inflight<Op> | null
  pending: Op[]
  nextSeq: number
  /** after a stale answer, no submit until `confirmed` reaches its head */
  waitFor: number
  expectBase: number | null
  serverBase: Uint8Array | null
  /**
   * `draining`: input frozen, local ops being confirmed; `settling`: nothing
   * was local, one more step checks no edit came out of the freeze;
   * `producing`: the file of `confirmed` is being made
   */
  save: 'draining' | 'settling' | 'producing' | null
  /** `freezing`: input frozen, one more step until the file is made; `producing`: being made */
  exporting: 'freezing' | 'producing' | null
  /** the highest version the host reported stored */
  reported: number
  fingerprinted: { at: number; v: number }
}

export type EngineEvent<Op> =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'frame'; frame: ServerFrame | BytesFrame }
  | { type: 'bad_frame' }
  | { type: 'attach' }
  | { type: 'local'; ops: Op[] }
  | { type: 'integrated'; local: Op[] }
  | { type: 'fingerprint_now'; v: number }
  | { type: 'fingerprinted'; v: number; fp: string }
  | { type: 'save' }
  | { type: 'settled' }
  | { type: 'export' }
  | { type: 'export_ready' }
  | { type: 'produced'; purpose: Purpose; file: ProducedFile }
  | { type: 'report_saved'; v: number }
  | { type: 'timer'; name: TimerName }
  | { type: 'adapter_failed' }
  | { type: 'shutdown' }

export type EngineEffect<Op> =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'send'; frame: ClientFrame }
  | { type: 'send_file' }
  | { type: 'timer'; name: TimerName; delay: number }
  | { type: 'cancel_timers' }
  /** queue `event` behind everything the effects before it cause */
  | { type: 'then'; event: EngineEvent<Op> }
  /** `baseBytes` null: the host's own bytes are the base */
  | { type: 'joined'; baseBytes: Uint8Array | null }
  | { type: 'join_failed'; code: CollabFailure }
  | { type: 'editable'; value: boolean }
  | { type: 'integrate'; remote: Json[][]; local: Op[] }
  | { type: 'confirmed'; ops: Op[] }
  | { type: 'fingerprint'; v: number }
  | { type: 'produce'; purpose: Purpose }
  | { type: 'save_done'; file: ProducedFile; version: number }
  | { type: 'save_failed'; code: CollabFailure | 'closed' | 'offline' }
  | { type: 'export_done'; file: ProducedFile }
  | { type: 'export_failed'; code: 'closed' }

/** `encode` may throw; the shell turns that into an adapter failure */
export interface EngineEnv<Op> {
  now: number
  encode(op: Op): Json
}

export interface Step<Op> {
  state: EngineState<Op>
  effects: EngineEffect<Op>[]
}

interface Ctx<Op> {
  s: EngineState<Op>
  fx: EngineEffect<Op>[]
  env: EngineEnv<Op>
  integrate: { remote: Json[][]; local: Op[] } | null
}

export function initialState<Op>(
  format: Format,
  fileHash: string,
  saveTimeoutMs: number,
): EngineState<Op> {
  return {
    format,
    fileHash,
    saveTimeoutMs,
    connection: 'connecting',
    everLive: false,
    joined: false,
    failure: null,
    detail: null,
    closed: false,
    attempts: 0,
    strikes: 0,
    progressed: false,
    epoch: null,
    client: null,
    canEdit: false,
    saved: 0,
    peers: [],
    target: 0,
    confirmed: 0,
    held: [],
    attached: false,
    inflight: null,
    pending: [],
    nextSeq: 1,
    waitFor: 0,
    expectBase: null,
    serverBase: null,
    save: null,
    exporting: null,
    reported: 0,
    fingerprinted: { at: -Infinity, v: -1 },
  }
}

export function statusOf<Op>(s: EngineState<Op>): CollabStatus {
  const status: CollabStatus = {
    phase: s.failure
      ? 'failed'
      : s.connection === 'live'
        ? 'live'
        : s.everLive
          ? 'offline'
          : 'joining',
    canEdit: s.canEdit,
    version: s.confirmed,
    saved: s.saved,
    unconfirmed: (s.inflight && !s.inflight.doomed ? s.inflight.ops.length : 0) + s.pending.length,
    peers: s.peers,
  }
  if (s.failure) status.failure = s.failure
  return status
}

export function reduce<Op>(
  state: EngineState<Op>,
  event: EngineEvent<Op>,
  env: EngineEnv<Op>,
): Step<Op> {
  if (state.closed) {
    if (event.type === 'save') return { state, effects: [{ type: 'save_failed', code: 'closed' }] }
    if (event.type === 'export') {
      return { state, effects: [{ type: 'export_failed', code: 'closed' }] }
    }
    return { state, effects: [] }
  }
  const c: Ctx<Op> = { s: { ...state }, fx: [], env, integrate: null }
  if (state.failure) afterFailure(c, event)
  else handle(c, event)
  if (c.integrate) c.fx.push({ type: 'integrate', ...c.integrate })
  else if (!c.s.failure && !c.s.closed) settle(c)
  return { state: c.s, effects: c.fx }
}

/** A failed session keeps the editor frozen, refuses saves, still exports, and shuts down */
function afterFailure<Op>(c: Ctx<Op>, event: EngineEvent<Op>): void {
  const s = c.s
  switch (event.type) {
    case 'attach':
      s.attached = true
      c.fx.push({ type: 'editable', value: false })
      return
    case 'save':
      c.fx.push({ type: 'save_failed', code: s.failure! })
      return
    case 'export':
      // Input is frozen for good, so the file can be made at once
      s.exporting = 'producing'
      c.fx.push({ type: 'produce', purpose: 'export' })
      return
    case 'produced':
      if (event.purpose === 'export') exported(c, event.file)
      return
    case 'shutdown':
      shutdown(c)
      return
  }
}

function handle<Op>(c: Ctx<Op>, event: EngineEvent<Op>): void {
  const s = c.s
  switch (event.type) {
    case 'open':
      if (s.connection !== 'connecting') return
      s.connection = 'hello'
      s.progressed = false
      c.fx.push({
        type: 'send',
        frame: {
          t: 'hello',
          p: 1,
          format: s.format,
          fileHash: s.fileHash,
          ...(s.joined ? { resume: { epoch: s.epoch!, client: s.client!, v: top(s) } } : {}),
        },
      })
      return
    case 'close':
      if (s.connection !== 'down') lose(c)
      return
    case 'bad_frame':
      return drop(c)
    case 'frame':
      return frame(c, event.frame)
    case 'timer':
      if (event.name === 'reconnect' && s.connection === 'down') {
        s.connection = 'connecting'
        c.fx.push({ type: 'open' })
      } else if (event.name === 'save' && (s.save === 'draining' || s.save === 'settling')) {
        // The edits stay pending and go out once the connection is back
        s.save = null
        c.fx.push({ type: 'editable', value: editable(s) })
        c.fx.push({ type: 'save_failed', code: 'offline' })
      }
      return
    case 'attach':
      s.attached = true
      c.fx.push({ type: 'editable', value: editable(s) })
      if (s.held.length > 0) release(c)
      return
    case 'local':
      // The editor no longer shows the document, and the server would refuse the edit
      if (!s.canEdit) return fail(c, 'forbidden')
      // The file being produced must be the state it is labelled with
      if (s.save === 'producing' || s.exporting === 'producing') return fail(c, 'adapter')
      s.pending = s.pending.concat(event.ops)
      return
    case 'integrated':
      s.pending = event.local
      return
    case 'fingerprint_now':
      if (fingerprintable(s) && s.confirmed === event.v) {
        c.fx.push({ type: 'fingerprint', v: event.v })
      }
      return
    case 'fingerprinted':
      if (s.connection === 'live')
        c.fx.push({ type: 'send', frame: { t: 'fingerprint', v: event.v, fp: event.fp } })
      return
    case 'save':
      if (s.save) return
      s.save = 'draining'
      c.fx.push({ type: 'editable', value: false })
      c.fx.push({ type: 'timer', name: 'save', delay: s.saveTimeoutMs })
      return
    case 'settled':
      if (s.save !== 'settling') return
      if (!s.inflight && s.pending.length === 0) {
        s.save = 'producing'
        c.fx.push({ type: 'produce', purpose: 'save' })
      } else s.save = 'draining'
      return
    case 'export':
      if (s.exporting) return
      s.exporting = 'freezing'
      c.fx.push({ type: 'editable', value: false })
      c.fx.push({ type: 'then', event: { type: 'export_ready' } })
      return
    case 'export_ready':
      if (s.exporting !== 'freezing') return
      s.exporting = 'producing'
      c.fx.push({ type: 'produce', purpose: 'export' })
      return
    case 'produced':
      if (event.purpose === 'save') return saved(c, event.file)
      return exported(c, event.file)
    case 'report_saved':
      if (event.v <= s.reported) return
      s.reported = event.v
      if (s.connection === 'live' && s.canEdit)
        c.fx.push({ type: 'send', frame: { t: 'saved', v: event.v } })
      return
    case 'adapter_failed':
      return fail(c, 'adapter')
    case 'shutdown':
      if (s.connection !== 'down') c.fx.push({ type: 'close' })
      s.connection = 'down'
      c.fx.push({ type: 'cancel_timers' })
      if (s.save) c.fx.push({ type: 'save_failed', code: 'closed' })
      s.save = null
      return shutdown(c)
  }
}

function shutdown<Op>(c: Ctx<Op>): void {
  const s = c.s
  s.closed = true
  if (s.exporting) c.fx.push({ type: 'export_failed', code: 'closed' })
  s.exporting = null
}

function frame<Op>(c: Ctx<Op>, f: ServerFrame | BytesFrame): void {
  const s = c.s
  switch (f.t) {
    case 'need_base':
      if (s.connection !== 'hello' || s.joined) return drop(c)
      c.fx.push({ type: 'send_file' })
      return
    case 'base':
      if (s.connection !== 'hello' || s.joined || s.expectBase !== null) return drop(c)
      s.expectBase = f.bytes
      return
    case 'bytes':
      if (s.expectBase === null || f.bytes.byteLength !== s.expectBase) return drop(c)
      s.serverBase = f.bytes
      s.expectBase = null
      return
    case 'welcome':
      return welcome(c, f)
    case 'change':
      if (s.connection !== 'catching_up' && s.connection !== 'live') return drop(c)
      return change(c, f)
    case 'ack':
      if (s.connection !== 'catching_up' && s.connection !== 'live') return drop(c)
      return ack(c, f.v, f.seq)
    case 'stale':
      if (s.connection !== 'catching_up' && s.connection !== 'live') return drop(c)
      return stale(c, f.seq, f.base, f.head)
    case 'saved':
      s.saved = Math.max(s.saved, f.v)
      return
    case 'peers':
      s.peers = f.peers
      return
    case 'diverged':
      return fail(c, 'diverged')
    case 'error':
      return fail(c, failureOf(f.code))
  }
}

/**
 * The status type has no codes for the server refusing a frame the engine
 * built: an op too large to send is the adapter's, a malformed frame means
 * this page must reopen the document.
 */
function failureOf(code: ErrorCode): CollabFailure {
  if (code === 'too_large') return 'adapter'
  if (code === 'bad_frame') return 'reset'
  return code
}

function welcome<Op>(c: Ctx<Op>, w: Extract<ServerFrame, { t: 'welcome' }>): void {
  const s = c.s
  if (s.connection !== 'hello' || s.expectBase !== null) return drop(c)
  if (s.joined) {
    if (w.epoch !== s.epoch || w.client !== s.client || w.start !== top(s)) return drop(c)
  } else {
    s.epoch = w.epoch
    s.client = w.client
    s.confirmed = w.start
    s.joined = true
    c.fx.push({ type: 'joined', baseBytes: s.serverBase })
  }
  s.canEdit = w.canEdit
  s.saved = Math.max(s.saved, w.saved)
  s.peers = w.peers
  s.target = w.head
  s.connection = 'catching_up'
  if (s.attached) c.fx.push({ type: 'editable', value: editable(s) })
  caughtUp(c)
}

function caughtUp<Op>(c: Ctx<Op>): void {
  const s = c.s
  if (s.connection !== 'catching_up' || top(s) < s.target) return
  s.connection = 'live'
  s.everLive = true
  const inflight = s.inflight
  if (inflight?.doomed) s.inflight = null
  else if (inflight) {
    c.fx.push({
      type: 'send',
      frame: { t: 'submit', seq: inflight.seq, base: inflight.base, ops: inflight.json },
    })
  }
  if (s.canEdit && s.reported > s.saved)
    c.fx.push({ type: 'send', frame: { t: 'saved', v: s.reported } })
}

function change<Op>(c: Ctx<Op>, ch: Change): void {
  const s = c.s
  if (ch.v <= top(s)) return
  if (ch.v > top(s) + 1) return drop(c)
  const inflight = s.inflight
  if (ch.client === s.client) {
    // Our own change on this socket is the in-flight submit whose ack was lost
    if (!inflight || inflight.doomed || ch.seq !== inflight.seq || s.held.length > 0) return drop(c)
    confirm(c, ch.v)
  } else if (holding(s) || s.held.length > 0) s.held = s.held.concat(ch)
  else integrateForeign(c, [ch])
  progress(s)
  caughtUp(c)
}

function ack<Op>(c: Ctx<Op>, v: number, seq: number): void {
  const s = c.s
  const inflight = s.inflight
  if (!inflight || seq !== inflight.seq || v <= top(s)) return
  if (v !== top(s) + 1 || inflight.doomed || s.held.length > 0) return drop(c)
  confirm(c, v)
  progress(s)
}

function stale<Op>(c: Ctx<Op>, seq: number, base: number, head: number): void {
  const s = c.s
  const inflight = s.inflight
  if (!inflight || seq !== inflight.seq || base !== inflight.base) return
  if (!inflight.doomed) s.pending = inflight.ops.concat(s.pending)
  s.inflight = null
  s.waitFor = head
}

function confirm<Op>(c: Ctx<Op>, v: number): void {
  const s = c.s
  c.fx.push({ type: 'confirmed', ops: s.inflight!.ops })
  s.confirmed = v
  s.inflight = null
  s.nextSeq += 1
}

/** Foreign changes, in order, from `confirmed + 1` on */
function integrateForeign<Op>(c: Ctx<Op>, changes: Change[]): void {
  const s = c.s
  const local = (s.inflight && !s.inflight.doomed ? s.inflight.ops : []).concat(s.pending)
  if (s.inflight) s.inflight = { ...s.inflight, ops: [], json: [], doomed: true }
  s.pending = []
  s.confirmed = changes[changes.length - 1].v
  c.integrate = { remote: changes.map((change) => change.ops), local }
}

function release<Op>(c: Ctx<Op>): void {
  const held = c.s.held
  c.s.held = []
  integrateForeign(c, held)
}

function saved<Op>(c: Ctx<Op>, file: ProducedFile): void {
  const s = c.s
  if (s.save !== 'producing') return
  const version = s.confirmed
  s.save = null
  // Input is frozen and remote changes are held, so the editor still shows `version`
  if (s.fingerprinted.v !== version) {
    s.fingerprinted = { at: c.env.now, v: version }
    c.fx.push({ type: 'fingerprint', v: version })
  }
  c.fx.push({ type: 'editable', value: editable(s) })
  c.fx.push({ type: 'save_done', file, version })
  if (s.held.length > 0 && !holding(s)) release(c)
}

function exported<Op>(c: Ctx<Op>, file: ProducedFile): void {
  const s = c.s
  if (!s.exporting) return
  s.exporting = null
  if (s.attached) c.fx.push({ type: 'editable', value: editable(s) })
  c.fx.push({ type: 'export_done', file })
  if (!s.failure && s.held.length > 0 && !holding(s)) release(c)
}

function settle<Op>(c: Ctx<Op>): void {
  submit(c)
  const s = c.s
  if (s.failure) return
  if (s.save === 'draining' && !s.inflight && s.pending.length === 0) {
    s.save = 'settling'
    c.fx.push({ type: 'then', event: { type: 'settled' } })
  }
  fingerprint(c)
}

function submit<Op>(c: Ctx<Op>): void {
  const s = c.s
  if (s.connection !== 'live' || !s.attached || s.inflight || s.pending.length === 0) return
  if (s.save === 'producing' || s.held.length > 0 || s.confirmed < s.waitFor) return
  const ops: Op[] = []
  const json: Json[] = []
  let size = 0
  for (const op of s.pending) {
    const encoded = c.env.encode(op)
    const bytes = utf8Length(JSON.stringify(encoded))
    if (bytes + SUBMIT_FRAME_BYTES > MAX_CHANGE_BYTES) {
      return fail(
        c,
        'adapter',
        `an edit of ${bytes} bytes is larger than one change may be (${MAX_CHANGE_BYTES} bytes)`,
      )
    }
    if (ops.length > 0 && size + bytes + 1 > SUBMIT_CHUNK_BYTES) break
    ops.push(op)
    json.push(encoded)
    size += bytes + 1
  }
  s.inflight = { seq: s.nextSeq, base: s.confirmed, ops, json, doomed: false }
  s.pending = s.pending.slice(ops.length)
  c.fx.push({ type: 'send', frame: { t: 'submit', seq: s.nextSeq, base: s.confirmed, ops: json } })
}

/** The editor shows exactly version `confirmed`, and nothing will move it while a step runs */
function fingerprintable<Op>(s: EngineState<Op>): boolean {
  return (
    s.attached &&
    s.connection === 'live' &&
    !s.save &&
    !s.exporting &&
    !s.inflight &&
    s.pending.length === 0 &&
    s.held.length === 0
  )
}

/** At most once every 10 s, at a version not yet fingerprinted, with nothing local or held */
function fingerprint<Op>(c: Ctx<Op>): void {
  const s = c.s
  if (!fingerprintable(s) || s.fingerprinted.v === s.confirmed) return
  const due = s.fingerprinted.at + FINGERPRINT_EVERY_MS
  if (c.env.now < due) {
    c.fx.push({ type: 'timer', name: 'fingerprint', delay: due - c.env.now })
    return
  }
  s.fingerprinted = { at: c.env.now, v: s.confirmed }
  c.fx.push({ type: 'then', event: { type: 'fingerprint_now', v: s.confirmed } })
}

function fail<Op>(c: Ctx<Op>, code: CollabFailure, detail?: string): void {
  const s = c.s
  s.failure = code
  s.detail = detail ?? null
  c.integrate = null
  if (s.connection !== 'down') c.fx.push({ type: 'close' })
  s.connection = 'down'
  c.fx.push({ type: 'cancel_timers' })
  if (s.attached) c.fx.push({ type: 'editable', value: false })
  if (!s.joined) c.fx.push({ type: 'join_failed', code })
  if (s.save) c.fx.push({ type: 'save_failed', code })
  s.save = null
}

/**
 * A frame that breaks the protocol: end this connection and resume on a new
 * one, unless connection after connection does it before any change gets
 * through. Then the server or what sits between is broken for this page.
 */
function drop<Op>(c: Ctx<Op>): void {
  const s = c.s
  if (!s.progressed) s.strikes += 1
  if (s.strikes >= PROTOCOL_STRIKES) return fail(c, 'reset')
  c.fx.push({ type: 'close' })
  lose(c)
}

/** A change got through on this connection: it works, so retries start fast again */
function progress<Op>(s: EngineState<Op>): void {
  s.progressed = true
  s.strikes = 0
  s.attempts = 0
}

function lose<Op>(c: Ctx<Op>): void {
  const s = c.s
  s.connection = 'down'
  s.expectBase = null
  if (!s.joined) s.serverBase = null
  c.fx.push({
    type: 'timer',
    name: 'reconnect',
    delay: Math.min(RECONNECT_LAST_MS, RECONNECT_FIRST_MS * 2 ** s.attempts),
  })
  s.attempts += 1
}

function top<Op>(s: EngineState<Op>): number {
  return s.confirmed + s.held.length
}

/** Remote changes wait: the editor is not there yet, or a file of what it shows is being made */
function holding<Op>(s: EngineState<Op>): boolean {
  return !s.attached || s.save === 'producing' || s.exporting === 'producing'
}

function editable<Op>(s: EngineState<Op>): boolean {
  return s.canEdit && !s.save && !s.exporting && !s.failure
}
