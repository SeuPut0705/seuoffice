import type { Format, Json } from '../model.js'

/** What the engine needs from the network; web-platform implements it over the embed channel */
export interface CollabLink {
  /** (re)connect; a no-op while connecting or open */
  open(): void
  /** only between an `open` event and the end of that connection */
  send(frame: string | Uint8Array): void
  /** end the connection; no `close` event follows a close the engine asked for */
  close(): void
  /** `close` arrives only when the host or the network ended the connection */
  subscribe(handler: (event: CollabLinkEvent) => void): () => void
}

export type CollabLinkEvent =
  { type: 'open' } | { type: 'close' } | { type: 'frame'; frame: string | Uint8Array }

/** One editor plugged into the engine */
export interface CollabAdapter<Op> {
  /** ops as JSON; decode validates and throws on anything it does not know */
  encode(op: Op): Json
  decode(json: Json): Op
  /** report every local edit, in order, already applied to the editor. Returns unsubscribe. */
  listen(emit: (ops: Op[]) => void): () => void
  /**
   * Apply `remote` (confirmed, in server order) to the editor, which currently shows the confirmed
   * state plus `local` (this client's unconfirmed ops, in order). Return `local` rewritten so that
   * it applies on top of `remote`. Synchronous; must not call `emit`.
   */
  integrate(remote: Op[], local: Op[]): Op[]
  /** this client's ops became confirmed (for adapters that keep a confirmed copy) */
  confirmed?(ops: Op[]): void
  /**
   * A stable hash of the document state; equal on every client at one version with nothing local.
   * It must read the state when called; only the hashing may finish later.
   */
  fingerprint(): string | Promise<string>
  setEditable(editable: boolean): void
  /** bytes of exactly the state on screen; no side effects on the editor */
  produceFile(): Promise<{ fileName: string; bytes: Uint8Array }>
}

/** The file the host opened: its format and its bytes */
export interface CollabFile {
  format: Format
  bytes: Uint8Array
}

export interface CollabJoin {
  /** the bytes the editor must open: the host's when they are the epoch base, else the server's */
  baseBytes: Uint8Array
  /** plug the editor in once it shows `baseBytes`; once per join */
  attach<Op>(adapter: CollabAdapter<Op>): CollabSession
}

export interface SavedVersion {
  fileName: string
  bytes: Uint8Array
  version: number
}

export interface CollabSession {
  /**
   * Freeze input, confirm everything local, hold remote changes, produce the file at one exact
   * version. Rejects with `offline` when the local edits cannot be confirmed within the save
   * timeout; input is unfrozen and the edits stay pending.
   */
  save(): Promise<SavedVersion>
  /** tell the server the host stored the file of `version`; ignored for a principal that cannot edit */
  reportSaved(version: number): void
  /**
   * The file of exactly what the editor shows, unconfirmed edits included, in any phase. It has no
   * version and the server never hears of it: a way to keep work a failed or offline session holds.
   */
  exportLocal(): Promise<{ fileName: string; bytes: Uint8Array }>
  status(): CollabStatus
  subscribe(handler: (status: CollabStatus) => void): () => void
  close(): void
}

export interface CollabOptions {
  /** how long `save()` waits for local edits to be confirmed; default 30000 */
  saveTimeoutMs?: number | undefined
}

export type CollabStatus = {
  phase: 'joining' | 'live' | 'offline' | 'failed'
  failure?: 'schema_mismatch' | 'reset' | 'diverged' | 'superseded' | 'forbidden' | 'adapter'
  canEdit: boolean
  version: number
  saved: number
  unconfirmed: number
  peers: { client: string; name: string }[]
  /** this page as the others see it among `peers`; null before the first welcome */
  self: { client: string; name: string } | null
}

export type CollabFailure = NonNullable<CollabStatus['failure']>

/**
 * Why a join, a save or an export did not happen: the session's failure, `closed`, or `offline`
 * for a save whose edits could not be confirmed in time
 */
export class CollabError extends Error {
  readonly code: CollabFailure | 'closed' | 'offline'

  constructor(code: CollabFailure | 'closed' | 'offline', detail?: string) {
    super(detail ? `co-editing stopped: ${code}: ${detail}` : `co-editing stopped: ${code}`)
    this.name = 'CollabError'
    this.code = code
  }
}
