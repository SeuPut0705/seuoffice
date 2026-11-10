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
  BLOCKED_BUCKETS,
  canonical,
  diff,
  emptySnapshot,
  fold,
  foldOps,
  foldPeer,
  mapPictures,
  newRound,
  pictureKey,
  pictureRef,
  pictureRefKey,
  rebase,
  renumbered,
  same,
  type BlockedBucket,
  type PdfOp,
} from './collab-model'
import { decodeOp, unshareable, type WireFault } from './collab-wire'

/** Changes the session cannot carry */
export type Feature =
  | 'text'
  | 'image'
  | 'savedAnnotation'
  | 'outline'
  | 'attachments'
  | 'protection'
  | 'redaction'
  /** what works on the stored file after a flush (export, merge, split): a co-edited page has no such file */
  | 'fileOps'

export type Refusal =
  | { kind: 'feature'; feature: Feature }
  /** the session is saving, or this person may only view */
  | { kind: 'frozen' }
  | { kind: 'tooLarge'; bytes: number }
  /** the change would leave the document without a page */
  | { kind: 'lastPage' }
  /** peers would not take the change (collab-wire.ts): a link they do not open, or too long */
  | { kind: 'unshareable'; why: WireFault }

/** What the App consults while co-editing (its `collabRef`) */
export interface PdfCollabLink {
  /** a failed plan for `applyEditOps` to return instead of applying `ops`; null lets them through */
  refuse(ops: Op[]): PlanResult | null
  /** true, after telling the person, when `what` must not happen now */
  blocks(what: Feature | 'history'): boolean
  /** the App changed its edits to `state` (an undo or redo passes the snapshot it restored) */
  changed(state: EditSnapshot): void
  /** the file of the document as this page shows it, unconfirmed edits included; nothing is stored */
  shownFile(): Promise<Uint8Array>
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

const BLOCKED: Record<BlockedBucket, Feature> = {
  textEdits: 'text',
  textInserts: 'text',
  imageEdits: 'image',
  annotDeletes: 'savedAnnotation',
}
const blockedFeature = (bucket: keyof EditSnapshot): Feature | undefined =>
  (BLOCKED as Partial<Record<keyof EditSnapshot, Feature>>)[bucket]

const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

const idOf = (item: unknown): unknown =>
  typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined

/**
 * Buckets equal in content. The fold keeps the App's own items, so identity mostly decides; what
 * differs is told apart by size and by item id before anything is read whole (a stamp is megabytes).
 */
function sameBucket(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((x, i) => x === b[i] || (idOf(x) === idOf(b[i]) && same(x, b[i])))
    )
  }
  if (a instanceof Map && b instanceof Map) {
    return (
      a.size === b.size &&
      [...a].every(([k, v]) => b.has(k) && (b.get(k) === v || same(b.get(k), v)))
    )
  }
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every((x) => b.has(x))
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

  /**
   * Picture stamps are megabytes, and every put of a stamp holds the whole item. On the wire a
   * stamp's bytes go once: a change names them by key when an earlier change of the log carries
   * them. Only the log counts: a change this page sent but has not had confirmed may still be
   * rewritten to nothing, and a change naming its bytes would then name bytes nobody has.
   */
  const pictures = new Map<string, string>()
  const inLog = new Set<string>()
  const keys = new Map<string, string>()
  const keyOf = (image: string): string => {
    let key = keys.get(image)
    if (key === undefined) keys.set(image, (key = pictureKey(image)))
    return key
  }
  const encode = (op: PdfOp): PdfOp =>
    mapPictures(op, (image) => (inLog.has(keyOf(image)) ? pictureRef(keyOf(image)) : image))
  const decode = (json: Json): PdfOp =>
    mapPictures(decodeOp(json), (image) => {
      const named = pictureRefKey(image)
      if (named === null) {
        pictures.set(keyOf(image), image)
        inLog.add(keyOf(image))
        return image
      }
      const bytes = pictures.get(named)
      if (bytes === undefined) throw new Error('a picture no earlier change carried')
      return bytes
    })
  /** The pictures of this person's own confirmed changes are in the log from then on */
  const logged = (ops: readonly PdfOp[]): void => {
    for (const op of ops)
      mapPictures(op, (image) => {
        pictures.set(keyOf(image), image)
        inLog.add(keyOf(image))
        return image
      })
  }

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
          const feature = blockedFeature(bucket)
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
      // as it goes over the wire: pictures the log holds are named, not sent again
      const wire = encode(op)
      const fault = unshareable(wire)
      if (fault) return revert({ kind: 'unshareable', why: fault })
      const bytes = sizeOf(wire)
      if (bytes > options.maxOpBytes) return revert({ kind: 'tooLarge', bytes })
      view = rebased.state
      if (round.renum.size > 0) host.mapHistory((s) => renumbered(s, round.renum))
      if (!matches(view, state)) host.show(view)
      if (op.puts.length > 0) deliver(op)
    },

    shownFile: async () => (await options.produce(view)).bytes,
  }

  const opened = host.snapshot()
  for (const bucket of BLOCKED_BUCKETS) {
    if (opened[bucket].length > 0) {
      throw new Error(`the document holds ${bucket} the session cannot carry`)
    }
  }
  host.link.current = link
  link.changed(opened)

  return {
    encode: (op) => encode(op) as unknown as Json,

    decode,

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
      // throws on a change that does not fit the document: nothing of it is kept
      confirmed = remote.reduce((state, op) => foldPeer(state, op.puts, basePages), confirmed)
      const round = newRound(before, confirmed, basePages)
      // what the screen showed after each unconfirmed op, and what it shows there now
      const was = [before]
      const now = [confirmed]
      const rebased = local.map((op): PdfOp => {
        was.push(fold(was.at(-1)!, op.puts))
        const next = rebase(op.puts, now.at(-1)!, round)
        now.push(next ? next.state : now.at(-1)!)
        return { id: op.id, puts: next ? next.puts : [] }
      })
      view = now.at(-1)!
      host.show(view)
      // The App's undo and redo restore snapshots it took earlier. One taken among the
      // unconfirmed edits becomes what the screen would show there with the peers' change made
      // first: taking the peers' puts on top of it instead would let them overrule the edits it
      // holds (bring back what this person deleted, set a turn this person added to). An older
      // one holds none of them, and takes the peers' change as it is.
      const theirs = remote.flatMap((op) => op.puts)
      host.mapHistory((s) => {
        const at = was.findIndex((state) => matches(state, s))
        return at >= 0 ? now[at]! : fold(renumbered(s, round.renum), theirs)
      })
      return rebased
    },

    confirmed(ops) {
      confirmed = foldOps(confirmed, ops)
      logged(ops)
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
