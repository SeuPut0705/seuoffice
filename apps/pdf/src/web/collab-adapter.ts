/**
 * The PDF editor plugged into the co-editing engine.
 *
 * The App keeps every pending edit in one EditSnapshot and changes it in two
 * ways only: an edit batch through `applyEditOps`, and undo or redo restoring a
 * whole snapshot. After either, it hands the new snapshot to `changed`, which
 * turns the difference into one op of puts (collab-model.ts). The adapter
 * holds the confirmed snapshot and the one on screen (`view`); after a peer's
 * change it rewrites the local ops on top of it and shows the result.
 *
 * Undo and redo restore snapshots the App took earlier. After a peer's change
 * the adapter folds that change into every snapshot of the App's history, so
 * undo takes back only this person's own edits.
 *
 * What the web cannot save (text, image and saved-annotation edits) and what
 * lives outside the snapshot (outline, attachments, protection, redaction
 * marks) is refused where the App would start it, with a message.
 */
import type { CollabAdapter, Json } from '@seuoffice/collab/client'
import { lookup, type Op, type PlanResult } from '../renderer/edit-ops'
import type { EditSnapshot } from '../renderer/edit-state'
import {
  LIST_BUCKETS,
  canonical,
  decodeOp,
  diff,
  emptySnapshot,
  fold,
  foldOps,
  newRound,
  rebase,
  renumbered,
  same,
  type PdfOp,
} from './collab-model'

/** Changes the session cannot carry */
export type Feature =
  'text' | 'image' | 'savedAnnotation' | 'outline' | 'attachments' | 'protection' | 'redaction'

export type Refusal =
  | { kind: 'feature'; feature: Feature }
  /** the session is saving, or this person may only view */
  | { kind: 'frozen' }
  | { kind: 'tooLarge'; bytes: number }
  /** the change would leave the document without a page */
  | { kind: 'lastPage' }

/** What the App consults while co-editing (its `collabRef`) */
export interface PdfCollabLink {
  /** a failed plan for `applyEditOps` to return instead of applying `ops`; null lets them through */
  refuse(ops: Op[]): PlanResult | null
  /** true, after telling the person, when `what` must not happen now */
  blocks(what: Feature | 'history'): boolean
  /** the App changed its edits to `state` (an undo or redo passes the snapshot it restored) */
  changed(state: EditSnapshot): void
}

/** The App, as the renderer hands it over */
export interface PdfHost {
  link: { current: PdfCollabLink | null }
  snapshot(): EditSnapshot
  /** put `state` on screen, keeping open drafts */
  show(state: EditSnapshot): void
  /** rewrite every snapshot in the undo and redo history */
  mapHistory(map: (s: EditSnapshot) => EditSnapshot): void
}

export interface PdfAdapterOptions {
  host: PdfHost
  /** pages of the opened file */
  basePages: number
  /** edits the opened file already holds pending; the App opens a file with none */
  base?: EditSnapshot
  produce(state: EditSnapshot): Promise<{ fileName: string; bytes: Uint8Array }>
  /** tell the person why their change did not happen; the text goes into the failed plan */
  refused(reason: Refusal): string
  maxOpBytes: number
  newId(): string
}

const BLOCKED_BUCKETS: Partial<Record<keyof EditSnapshot, Feature>> = {
  textEdits: 'text',
  textInserts: 'text',
  imageEdits: 'image',
  annotDeletes: 'savedAnnotation',
}

const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

/** Buckets equal in content; the fold keeps the App's own items, so identity mostly decides */
function sameBucket(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((x, i) => x === b[i])
  )
    return true
  if (a instanceof Map && b instanceof Map && a.size === b.size) {
    if ([...a].every(([k, v]) => b.get(k) === v)) return true
  }
  return same(a, b)
}

const matches = (a: EditSnapshot, b: EditSnapshot): boolean =>
  (Object.keys(a) as (keyof EditSnapshot)[]).every((bucket) => sameBucket(a[bucket], b[bucket]))

export function createPdfAdapter(options: PdfAdapterOptions): CollabAdapter<PdfOp> {
  const { host, basePages } = options
  let confirmed = options.base ?? emptySnapshot()
  let view = confirmed
  let editable = true
  let emit: ((ops: PdfOp[]) => void) | null = null
  let unready: PdfOp[] = []

  const deliver = (op: PdfOp): void => {
    if (emit) emit([op])
    else unready.push(op)
  }

  /** The App shows `view` again: a change that cannot travel never stays on one screen */
  const revert = (reason: Refusal): void => {
    host.show(view)
    options.refused(reason)
  }

  const link: PdfCollabLink = {
    refuse(ops) {
      const failed = (index: number, reason: Refusal): PlanResult => ({
        ops: [],
        records: [],
        touched: new Set(),
        failures: [{ index, op: ops[index]!, error: options.refused(reason) }],
      })
      if (ops.length === 0) return null
      if (!editable) return failed(0, { kind: 'frozen' })
      for (const [index, op] of ops.entries()) {
        let touches: readonly (keyof EditSnapshot)[]
        try {
          touches = lookup(op.op).touches
        } catch {
          continue // the App's own plan reports an unknown op
        }
        for (const bucket of touches) {
          const feature = BLOCKED_BUCKETS[bucket]
          if (feature) return failed(index, { kind: 'feature', feature })
        }
      }
      const bytes = sizeOf(ops)
      return bytes > options.maxOpBytes ? failed(0, { kind: 'tooLarge', bytes }) : null
    },

    blocks(what) {
      if (what !== 'history') {
        options.refused({ kind: 'feature', feature: what })
        return true
      }
      if (editable) return false
      options.refused({ kind: 'frozen' })
      return true
    },

    changed(state) {
      const puts = diff(view, state, basePages)
      if (puts.length === 0) {
        if (!matches(view, state)) host.show(view)
        return
      }
      if (!editable) return revert({ kind: 'frozen' })
      const round = { basePages, removed: new Set<string>(), renum: new Map<number, number>() }
      const rebased = rebase(puts, view, round)
      if (!rebased) return revert({ kind: 'lastPage' })
      const op: PdfOp = { id: options.newId(), puts: rebased.puts }
      const bytes = sizeOf(op)
      if (bytes > options.maxOpBytes) return revert({ kind: 'tooLarge', bytes })
      view = rebased.state
      if (round.renum.size > 0) host.mapHistory((s) => renumbered(s, round.renum))
      if (!matches(view, state)) host.show(view)
      if (op.puts.length > 0) deliver(op)
    },
  }

  const opened = host.snapshot()
  for (const bucket of LIST_BUCKETS) {
    const feature = BLOCKED_BUCKETS[bucket]
    if (feature && opened[bucket].length > 0) {
      throw new Error(`the document holds ${bucket} the session cannot carry`)
    }
  }
  host.link.current = link
  link.changed(opened)

  return {
    encode: (op) => op as unknown as Json,

    decode: decodeOp,

    listen(handler) {
      emit = handler
      const early = unready
      unready = []
      if (early.length > 0) handler(early)
      return () => {
        if (emit === handler) emit = null
        if (host.link.current === link) host.link.current = null
      }
    },

    integrate(remote, local) {
      const before = confirmed
      confirmed = foldOps(confirmed, remote)
      const round = newRound(before, confirmed, basePages)
      let cur = confirmed
      const rebased = local.map((op): PdfOp => {
        const next = rebase(op.puts, cur, round)
        if (!next) return { id: op.id, puts: [] }
        cur = next.state
        return { id: op.id, puts: next.puts }
      })
      view = cur
      host.show(view)
      const theirs = remote.flatMap((op) => op.puts)
      host.mapHistory((s) => fold(renumbered(s, round.renum), theirs))
      return rebased
    },

    confirmed(ops) {
      confirmed = foldOps(confirmed, ops)
    },

    fingerprint() {
      return sha256(canonical(view))
    },

    setEditable(value) {
      editable = value
    },

    produceFile: () => options.produce(view),
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
