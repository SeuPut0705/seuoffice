import type { Change, Format, Json } from '../model.js'

/** What the server needs to know about a document's epoch without reading its base or log */
export interface EpochHead {
  id: string
  format: Format
  baseHash: string
  head: number
  saved: number
}

export interface NewEpoch {
  id: string
  format: Format
  baseHash: string
  base: Uint8Array
}

/** A submit to append at `base + 1` */
export interface AppendRequest {
  base: number
  client: string
  seq: number
  author: string
  ops: Json[]
}

export type AppendResult =
  | { kind: 'appended'; v: number }
  | { kind: 'duplicate'; v: number }
  | { kind: 'stale'; head: number }
  | { kind: 'gone' }

/**
 * Where epochs live; a durable implementation is the host's. Every method is
 * atomic per document. `append` is the one compare-and-append that keeps the
 * log's invariants: it answers `duplicate` with the earlier version when the
 * epoch already holds `(client, seq)` (checked before the base), appends only
 * when `base` equals the head, and never reuses a version. `gone` means the
 * epoch no longer exists. `read` returns the changes after version `after`,
 * at most `limit` of them, in order. `markSaved` keeps the highest version
 * reported and returns it. `readBase` and `read` reject for an epoch that is gone.
 */
export interface CollabStore {
  load(documentId: string): Promise<EpochHead | null>
  create(documentId: string, epoch: NewEpoch): Promise<'created' | 'exists'>
  readBase(documentId: string, epochId: string): Promise<Uint8Array>
  append(documentId: string, epochId: string, change: AppendRequest): Promise<AppendResult>
  read(documentId: string, epochId: string, after: number, limit: number): Promise<Change[]>
  markSaved(documentId: string, epochId: string, v: number): Promise<number>
  drop(documentId: string, epochId: string): Promise<void>
}

interface StoredEpoch {
  id: string
  format: Format
  baseHash: string
  base: Uint8Array
  log: Change[]
  saved: number
  /** `${client}\n${seq}` to the version it was appended at */
  submits: Map<string, number>
}

/** Epochs in this process's memory; everything is lost when it exits */
export function memoryStore(): CollabStore {
  const epochs = new Map<string, StoredEpoch>()

  function current(documentId: string, epochId: string): StoredEpoch | undefined {
    const epoch = epochs.get(documentId)
    return epoch?.id === epochId ? epoch : undefined
  }

  function existing(documentId: string, epochId: string): StoredEpoch {
    const epoch = current(documentId, epochId)
    if (!epoch) throw new Error(`epoch ${epochId} of ${documentId} is gone`)
    return epoch
  }

  return {
    async load(documentId) {
      const epoch = epochs.get(documentId)
      if (!epoch) return null
      const { id, format, baseHash, saved } = epoch
      return { id, format, baseHash, head: epoch.log.length, saved }
    },
    async create(documentId, epoch) {
      if (epochs.has(documentId)) return 'exists'
      epochs.set(documentId, { ...epoch, log: [], saved: 0, submits: new Map() })
      return 'created'
    },
    async readBase(documentId, epochId) {
      return existing(documentId, epochId).base
    },
    async append(documentId, epochId, change) {
      const epoch = current(documentId, epochId)
      if (!epoch) return { kind: 'gone' }
      const key = `${change.client}\n${change.seq}`
      const earlier = epoch.submits.get(key)
      if (earlier !== undefined) return { kind: 'duplicate', v: earlier }
      if (change.base !== epoch.log.length) return { kind: 'stale', head: epoch.log.length }
      const v = epoch.log.length + 1
      const { client, seq, author, ops } = change
      epoch.log.push({ v, client, seq, author, ops })
      epoch.submits.set(key, v)
      return { kind: 'appended', v }
    },
    async read(documentId, epochId, after, limit) {
      return existing(documentId, epochId).log.slice(after, after + limit)
    },
    async markSaved(documentId, epochId, v) {
      const epoch = existing(documentId, epochId)
      epoch.saved = Math.max(epoch.saved, Math.min(v, epoch.log.length))
      return epoch.saved
    },
    async drop(documentId, epochId) {
      if (current(documentId, epochId)) epochs.delete(documentId)
    },
  }
}
