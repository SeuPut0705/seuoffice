/**
 * The Docs editor plugged into the co-editing engine.
 *
 * Body edits travel as ProseMirror steps, one op per local transaction
 * (plugin-appended transactions included, each its own op). Everything else
 * the saved file holds (page setup, headers, comments, notes, styles...)
 * travels as keyed last-writer-wins entries (`side` ops) kept in an ordered
 * map: a write to a known key keeps its place, a new key goes last, a null
 * value deletes it. Server order decides every conflict, so all clients that
 * applied the same log hold the same map.
 *
 * `tail` is every step applied on top of the confirmed document, oldest
 * first; it is always a suffix of the editor's step history, which is what
 * the history plugin's `rebased` meta relies on. Integrating remote steps is
 * prosemirror-collab's `rebaseSteps`: undo the tail, apply the remote steps,
 * re-apply the tail mapped through them, all in one transaction.
 */
import type { CollabAdapter, Json } from '@seuoffice/collab/client'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Step, Transform } from '@tiptap/pm/transform'
import * as pmCollab from 'prosemirror-collab'
import { TABLE_TRAILING_SKIP } from '../renderer/editor/extensions'
import { TRACK_IGNORE } from '../renderer/editor/revisions'

export type DocsOp = { kind: 'steps'; steps: Step[] } | { kind: 'side'; key: string; value: Json }

type StepsOp = Extract<DocsOp, { kind: 'steps' }>
type SideOp = Extract<DocsOp, { kind: 'side' }>

/** How the page's synced entries change after a peer's edit */
export interface SideChange {
  /**
   * Own new comments or notes whose id a peer took first, `kind:old` to the
   * new id; applied before `entries`, to the page's lists as they are now
   * (an item added since the last read included).
   */
  renames: ReadonlyMap<string, string>
  /** entries that changed, null for a removed one */
  entries: ReadonlyMap<string, Json | null>
}

/** The synced state outside the ProseMirror document, as the page shows it */
export interface SideStore {
  /** every synced entry the page holds now, in order */
  read(): Map<string, Json>
  /**
   * Show `change` without dropping what the page changed since the last read;
   * must not report it back through `observe`.
   */
  write(change: SideChange): void
  /** call `changed` whenever the page may have changed an entry; returns the unsubscribe */
  observe(changed: () => void): () => void
}

export interface DocsAdapterOptions {
  editor: Editor
  side: SideStore
  /** the file of exactly this body and these entries, without touching the editor */
  produce(side: ReadonlyMap<string, Json>): Promise<{ fileName: string; bytes: Uint8Array }>
  /**
   * An edit the editor holds outside the document (a table cell being typed
   * in place): the position of its node and how to commit it, synchronously.
   */
  pendingEdit?(): { pos: number; commit(): void } | null
  /** encoded bytes one op may have: the engine's change limit less the frame around it */
  maxOpBytes: number
  /**
   * Finish every edit the editor holds outside the document (table cells,
   * text boxes typed in place), synchronously.
   */
  commitDrafts?(): void
  /** a local edit was refused instead of ending the session: too large, or made while a file is made */
  refused?(reason: 'too_large' | 'frozen'): void
}

/** What `rebaseSteps` handles; prosemirror-collab's own class has exactly these fields */
interface Rebaseable {
  readonly step: Step
  readonly inverted: Step
  readonly origin: Transform
}

// prosemirror-collab exports `rebaseSteps` at runtime and marks it internal in its typings
const { rebaseSteps } = pmCollab as unknown as {
  rebaseSteps(
    steps: readonly Rebaseable[],
    over: readonly Step[],
    transform: Transform,
  ): Rebaseable[]
}

/**
 * Transactions that write layout every client derives on its own (pagination
 * results such as TOC page numbers). They stay local: no op, no fingerprint.
 * Upstream code marks them with this meta; each such step only rewrites node
 * attributes, so it never moves a position the log refers to.
 */
export const LAYOUT_DERIVED = 'layoutDerived'

const remoteKey = new PluginKey<{ records: Recorded[] }>('seuCollab')

/**
 * The track-changes recorder must see remote transactions: it maps the IME
 * range it keeps across transactions (they carry TRACK_IGNORE, so it records
 * nothing). Its key is `trackChangesRecorder$`, numbered after the first editor.
 */
const seesRemote = (plugin: Plugin): boolean =>
  /^trackChangesRecorder\$\d*$/.test(pluginKeyOf(plugin))

/** how long a new comment or note waits for the App to list it before it goes out anyway */
export const ENTRY_WAIT_MS = 1000

interface Recorded {
  serial: number
  tr: Transaction
}

/**
 * A local op made but not yet given to the engine. `minted` are the comment
 * and note keys its steps add a reference to; `existing` those of them the
 * document referenced already (another person's, or a copy).
 */
interface Outgoing {
  op: DocsOp
  minted: Set<string>
  existing: Set<string>
  /** a side op: the entry's value before it */
  prev?: Json
}

export function createDocsAdapter(options: DocsAdapterOptions): CollabAdapter<DocsOp> {
  const { editor, side } = options
  const schema = editor.schema
  /** each local steps op's origin transaction, which tags its entries in `tail` */
  const origins = new WeakMap<StepsOp, Transform>()
  /**
   * Every local step on top of the confirmed document, oldest first: the
   * engine's unconfirmed ops, then the outbox's.
   */
  let tail: Rebaseable[] = []
  let sideConfirmed = new Map(side.read())
  let sideView = new Map(sideConfirmed)
  let frozen = false
  let serial = 0
  let committed = 0
  let emit: ((ops: DocsOp[]) => void) | null = null
  /**
   * Ops on screen the engine does not have yet, in order: a new comment or
   * note waits for the App to list its entry, so both travel in one change,
   * and ops made inside `integrate` wait until it returned. The fingerprint
   * leaves them out, since the engine counts nothing of them.
   */
  let outbox: Outgoing[] = []
  let outboxTimer: ReturnType<typeof setTimeout> | null = null
  let integrating = false
  const wrapped = new WeakSet<object>()

  /**
   * Fix-ups that `appendTransaction` makes (directions, list renumbering,
   * trailing paragraphs, caret formatting) already travel inside the
   * originator's steps: on a remote transaction they would run twice.
   */
  const skipRemoteFixups = (): void => {
    for (const plugin of editor.state.plugins) {
      const spec = plugin.spec as {
        appendTransaction?: (trs: readonly Transaction[], ...rest: never[]) => unknown
      }
      const own = spec.appendTransaction
      if (!own || wrapped.has(plugin) || seesRemote(plugin)) continue
      wrapped.add(plugin)
      spec.appendTransaction = (trs, ...rest) =>
        trs.some((tr) => tr.getMeta(remoteKey)) ? null : own.call(plugin, trs, ...rest)
    }
  }

  const outboxOrigins = (): Set<Transform> =>
    new Set(outbox.flatMap((item) => (item.op.kind === 'steps' ? [origins.get(item.op)!] : [])))

  /** `op` with the steps its transaction has in `tail` now */
  const rebuilt = (op: StepsOp): StepsOp => {
    const origin = origins.get(op)!
    const next: StepsOp = {
      kind: 'steps',
      steps: tail.filter((entry) => entry.origin === origin).map((entry) => entry.step),
    }
    origins.set(next, origin)
    return next
  }

  /** undo the whole tail and apply it again with `over` in front, in one transaction */
  const rewriteTail = (over: Step[]): void => {
    const state = editor.state
    const tr = state.tr
    // the history plugin remaps its last `undone` items: rebaseSteps undoes the tail first
    const undone = tail.length
    tail = rebaseSteps(tail, over, tr)
    // the user's caret stays in front of text a peer inserted right at it
    const selection = state.selection
    if (selection instanceof TextSelection) {
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(tr.mapping.map(selection.anchor, -1)),
          tr.doc.resolve(tr.mapping.map(selection.head, -1)),
          -1,
        ),
      )
    }
    if (state.storedMarks) tr.setStoredMarks(state.storedMarks)
    tr.setMeta(remoteKey, true)
      .setMeta('rebased', undone)
      .setMeta('addToHistory', false)
      // a peer's edit is not this user's tracked change, nor a fresh table to pad
      .setMeta(TRACK_IGNORE, true)
      .setMeta(TABLE_TRAILING_SKIP, true)
    editor.view.dispatch(tr)
    if (editor.state.doc !== tr.doc) throw new Error('a plugin refused a peer edit')
  }

  /** rename ids in the tail steps of `only` (all when absent); `inverted` still undoes what is on screen */
  const renameInTail = (renames: Renames, only?: Set<Transform>): void => {
    tail = tail.map((entry) => {
      if (only && !only.has(entry.origin)) return entry
      const json = entry.step.toJSON()
      const renamed = renameIds(json, renames)
      return renamed === json ? entry : { ...entry, step: Step.fromJSON(schema, renamed) }
    })
  }

  /** the next id of `kind` no entry and no reference in the body uses */
  const freeId = (kind: IdKind, taken: Set<string>): string => {
    let next = 1
    const consider = (key: string) => {
      if (idKindOf(key) === kind)
        next = Math.max(next, (parseInt(key.slice(kind.length + 1), 10) || 0) + 1)
    }
    for (const key of [...sideConfirmed.keys(), ...sideView.keys(), ...taken]) consider(key)
    idsIn(editor.state.doc.toJSON(), (found, id) => consider(`${found}:${id}`))
    const id = String(next)
    taken.add(`${kind}:${id}`)
    return id
  }

  /** a steps op may go once the App listed the entry of every id it references anew */
  const ready = (at: number): boolean => {
    const item = outbox[at]
    const later = new Set(
      outbox.slice(at + 1).flatMap((next) => (next.op.kind === 'side' ? [next.op.key] : [])),
    )
    for (const key of item.minted) {
      if (item.existing.has(key) ? !later.has(key) : !sideView.has(key) && !later.has(key))
        return false
    }
    return true
  }

  /**
   * A new comment or note whose id the document already held (the App counted
   * from a list that did not show a peer's entry yet) gets the next free id,
   * in its steps, in the document and in the App's list; the peer's entry is
   * put back.
   */
  const settleCollisions = (released: Outgoing[]): void => {
    const renames: Renames = new Map()
    const taken = new Set<string>()
    for (const item of released) {
      for (const key of item.existing) {
        const entry = released.find((other) => other.op.kind === 'side' && other.op.key === key)
        if (!entry || entry.op.kind !== 'side' || !sideConfirmed.has(key)) continue
        if (sameJson(sideConfirmed.get(key), entry.op.value)) continue
        renames.set(key, freeId(idKindOf(key)!, taken))
      }
    }
    if (renames.size === 0) return
    const owners = new Set(
      released.flatMap((item) =>
        item.op.kind === 'steps' && [...item.minted].some((key) => renames.has(key))
          ? [origins.get(item.op)!]
          : [],
      ),
    )
    renameInTail(renames, owners)
    rewriteTail([])
    const entries = new Map<string, Json | null>()
    for (const item of released) {
      if (item.op.kind === 'steps') {
        if (owners.has(origins.get(item.op)!)) item.op = rebuilt(item.op)
        continue
      }
      const to = renames.get(item.op.key)
      if (to === undefined) continue
      const kind = idKindOf(item.op.key)!
      const own = { ...(item.op.value as Record<string, Json>), id: to }
      const restored = sideConfirmed.get(item.op.key) ?? null
      entries.set(item.op.key, restored)
      entries.set(`${kind}:${to}`, own)
      if (restored === null) sideView.delete(item.op.key)
      else sideView.set(item.op.key, restored)
      sideView.set(`${kind}:${to}`, own)
      item.op = { kind: 'side', key: `${kind}:${to}`, value: own }
    }
    side.write({ renames: new Map(), entries })
  }

  const flush = (force: boolean): void => {
    if (integrating || !emit || outbox.length === 0) return
    let count = 0
    while (count < outbox.length && (force || ready(count))) count++
    const released = outbox.slice(0, count)
    outbox = outbox.slice(count)
    clearTimeout(outboxTimer ?? undefined)
    outboxTimer = outbox.length > 0 ? setTimeout(() => flush(true), ENTRY_WAIT_MS) : null
    if (released.length === 0) return
    settleCollisions(released)
    emit(released.map((item) => item.op))
  }

  const queue = (items: Outgoing[]): void => {
    if (items.length === 0) return
    outbox.push(...items)
    if (integrating) queueMicrotask(() => flush(false))
    else flush(false)
  }

  const commit = (records: readonly Recorded[]): void => {
    const items: Outgoing[] = []
    for (const { serial: at, tr } of records) {
      if (at <= committed) continue
      committed = at
      // layout passes only while nothing local is on top (the filter), and join this client's base
      if (tr.getMeta(LAYOUT_DERIVED)) continue
      const op: StepsOp = { kind: 'steps', steps: tr.steps.slice() }
      origins.set(op, tr)
      tail.push(
        ...tr.steps.map((step, i) => ({ step, inverted: step.invert(tr.docs[i]), origin: tr })),
      )
      items.push({ op, ...mintedBy(tr) })
    }
    queue(items)
  }

  editor.registerPlugin(
    new Plugin<{ records: Recorded[] }>({
      key: remoteKey,
      // the history plugin keeps one item per step, which its `rebased` handling relies on
      historyPreserveItems: true,
      state: {
        init: () => ({ records: [] }),
        // every transaction that reaches a state, appended ones included, in order;
        // committed once that state is on screen, so a state that is never shown sends nothing
        apply(tr, value) {
          const kept = value.records.filter((record) => record.serial > committed)
          if (!tr.docChanged || tr.getMeta(remoteKey)) {
            return kept.length === value.records.length ? value : { records: kept }
          }
          return { records: [...kept, { serial: ++serial, tr }] }
        },
      },
      filterTransaction: (tr) => {
        if (!tr.docChanged || tr.getMeta(remoteKey)) return true
        // layout written on top of unconfirmed steps would be rebased as a stale attribute
        // set over a peer's change; the next pagination pass writes it again
        if (tr.getMeta(LAYOUT_DERIVED)) return tail.length === 0
        if (frozen) {
          options.refused?.('frozen')
          return false
        }
        // an edit too large for one change is refused here, so the session outlives it
        if (
          !tooLarge(
            tr.steps.map((step) => step.toJSON()),
            options.maxOpBytes,
          )
        )
          return true
        options.refused?.('too_large')
        return false
      },
      // Input is refused at the event, not through the view's `editable` prop: TipTap's React
      // binding copies `editor.isEditable` back into its options on render, so a freeze seen
      // there would outlive the session's own unfreeze.
      props: {
        handleDOMEvents: {
          beforeinput: (_view, event) => {
            if (frozen) event.preventDefault()
            return frozen
          },
        },
        handleKeyDown: () => frozen,
        handleTextInput: () => frozen,
        handlePaste: () => frozen,
        handleDrop: () => frozen,
      },
      view: () => ({
        update: (view) => {
          skipRemoteFixups()
          commit(remoteKey.getState(view.state)?.records ?? [])
        },
      }),
    }),
  )
  skipRemoteFixups()

  // in-place islands (table cells, text boxes) stop ProseMirror from seeing their events
  const refuseWhileFrozen = (event: Event): void => {
    if (!frozen) return
    event.preventDefault()
    event.stopPropagation()
  }
  const ISLAND_EVENTS = ['beforeinput', 'paste', 'drop', 'cut']
  for (const type of ISLAND_EVENTS) editor.view.dom.addEventListener(type, refuseWhileFrozen, true)

  /** what the App changed outside the document since the last look, as side ops */
  const pullSide = (): void => {
    const now = side.read()
    const items: Outgoing[] = []
    const refused = new Map<string, Json | null>()
    const change = (key: string, value: Json): void => {
      if (value !== null && tooLarge(value, options.maxOpBytes)) {
        refused.set(key, sideView.get(key) ?? null)
        return
      }
      const prev = sideView.get(key)
      const op: SideOp = { kind: 'side', key, value }
      applySide(sideView, op)
      items.push({ op, minted: new Set(), existing: new Set(), prev })
    }
    for (const [key, value] of now) if (!sameJson(sideView.get(key), value)) change(key, value)
    for (const key of [...sideView.keys()]) if (!now.has(key)) change(key, null)
    if (refused.size > 0) {
      side.write({ renames: new Map(), entries: refused })
      options.refused?.('too_large')
    }
    queue(items)
  }
  // while frozen (a file is being made, or a viewer) changes wait; unfreezing reads them
  const unobserve = side.observe(() => {
    if (!frozen && !integrating) pullSide()
  })

  /**
   * Comment and note ids are minted as the largest id plus one, so two people
   * adding one at the same moment both take N. The one whose addition the
   * server ordered later renumbers its own, still unconfirmed, to the next
   * free id: in its steps, its side entries and the App's lists.
   */
  const renumber = (remote: DocsOp[], local: DocsOp[], before: ReadonlySet<string>): Renames => {
    const minted = (into: Set<string>) => (kind: IdKind, id: string) => {
      if (!before.has(`${kind}:${id}`)) into.add(`${kind}:${id}`)
    }
    const theirs = new Set<string>()
    for (const op of remote) {
      if (op.kind === 'steps') for (const step of op.steps) idsIn(step.toJSON(), minted(theirs))
      else if (op.value !== null && idKindOf(op.key)) theirs.add(op.key)
    }
    if (theirs.size === 0) return new Map()
    const mine = new Set<string>()
    for (const entry of tail) idsIn(entry.step.toJSON(), minted(mine))
    for (const op of [...local, ...outbox.map((item) => item.op)]) {
      if (op.kind === 'side' && op.value !== null && idKindOf(op.key) && !before.has(op.key))
        mine.add(op.key)
    }
    const renames: Renames = new Map()
    const taken = new Set([...theirs, ...mine])
    for (const key of mine) if (theirs.has(key)) renames.set(key, freeId(idKindOf(key)!, taken))
    if (renames.size > 0) renameInTail(renames)
    return renames
  }

  /**
   * An in-place table edit lives in the DOM until it commits; a peer's change
   * to that table redraws it from the document. Commit it first, so it is a
   * local op the peer's change is rebased against.
   */
  const commitPendingEdit = (over: Step[]): void => {
    const pending = options.pendingEdit?.()
    if (!pending) return
    const probe = editor.state.tr
    rebaseSteps(tail, over, probe)
    const node = editor.state.doc.nodeAt(pending.pos)
    const mapped = probe.mapping.mapResult(pending.pos)
    if (node && !mapped.deleted && probe.doc.nodeAt(mapped.pos)?.eq(node)) return
    pending.commit()
  }

  return {
    encode(op): Json {
      if (op.kind === 'side') return { kind: 'side', key: op.key, value: op.value }
      const steps: Json[] = op.steps.map((step) => step.toJSON() as Json)
      return { kind: 'steps', steps }
    },

    decode(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a docs op')
      if (json.kind === 'side') {
        if (typeof json.key !== 'string' || !('value' in json)) throw new Error('not a side op')
        return { kind: 'side', key: json.key, value: json.value }
      }
      if (json.kind === 'steps' && Array.isArray(json.steps)) {
        return { kind: 'steps', steps: json.steps.map((step) => Step.fromJSON(schema, step)) }
      }
      throw new Error('not a docs op')
    },

    listen(handler) {
      emit = handler
      flush(false)
      return () => {
        if (emit === handler) emit = null
        clearTimeout(outboxTimer ?? undefined)
        unobserve()
        for (const type of ISLAND_EVENTS)
          editor.view.dom.removeEventListener(type, refuseWhileFrozen, true)
      }
    },

    integrate(remote, local) {
      integrating = true
      try {
        const before = new Set(sideConfirmed.keys())
        for (const op of remote) if (op.kind === 'side') applySide(sideConfirmed, op)
        const known = outboxOrigins()
        for (const op of local) {
          if (op.kind !== 'steps') continue
          const origin = origins.get(op)
          if (!origin) throw new Error('an unconfirmed op this editor never made')
          known.add(origin)
        }
        for (const entry of tail) {
          if (!known.has(entry.origin))
            throw new Error('the editor holds steps the engine does not count as unconfirmed')
        }

        const over = remote.flatMap((op) => (op.kind === 'steps' ? op.steps : []))
        if (over.length > 0) commitPendingEdit(over)
        const renames = renumber(remote, local, before)
        if (over.length > 0 || renames.size > 0) rewriteTail(over)

        const rebased = local.map((op) =>
          op.kind === 'side' ? renamedSide(op, renames) : rebuilt(op),
        )
        for (const item of outbox) {
          item.op = item.op.kind === 'side' ? renamedSide(item.op, renames) : rebuilt(item.op)
        }
        const shown = sideView
        sideView = new Map(sideConfirmed)
        for (const op of [...rebased, ...outbox.map((item) => item.op)])
          if (op.kind === 'side') applySide(sideView, op)
        const entries = new Map<string, Json | null>()
        for (const [key, value] of sideView)
          if (!sameJson(shown.get(key), value)) entries.set(key, value)
        for (const key of shown.keys()) if (!sideView.has(key)) entries.set(key, null)
        side.write({ renames, entries })
        return rebased
      } finally {
        integrating = false
      }
    },

    confirmed(ops) {
      for (const op of ops) {
        if (op.kind === 'side') {
          applySide(sideConfirmed, op)
          continue
        }
        const origin = origins.get(op)
        let last = -1
        tail.forEach((entry, i) => {
          if (entry.origin === origin) last = i
        })
        if (last < 0) continue
        if (tail.slice(0, last + 1).some((entry) => entry.origin !== origin))
          throw new Error('ops were confirmed out of order')
        tail = tail.slice(last + 1)
      }
    },

    fingerprint() {
      // the outbox is on screen but not in the engine's count: the state it vouches for is without it
      let doc = editor.state.doc
      const pending = outboxOrigins()
      if (pending.size > 0) {
        const undo = new Transform(doc)
        for (let i = tail.length - 1; i >= 0 && pending.has(tail[i].origin); i--)
          undo.step(tail[i].inverted)
        doc = undo.doc
      }
      const entries = new Map(sideView)
      for (const item of [...outbox].reverse()) {
        if (item.op.kind !== 'side') continue
        if (item.prev === undefined) entries.delete(item.op.key)
        else entries.set(item.op.key, item.prev)
      }
      const text = canonical({ doc: withoutLayout(doc.toJSON() as Json), side: [...entries] })
      return sha256(text)
    },

    setEditable(editable) {
      if (editable) {
        frozen = false
        pullSide()
        return
      }
      // The engine takes ops made in here before it makes a file: finish the drafts the editor
      // holds outside the document, read the App's outside state, and hand over the outbox
      if (!frozen) {
        options.commitDrafts?.()
        pullSide()
      }
      flush(true)
      frozen = true
    },

    produceFile: () => options.produce(new Map(sideView)),
  }
}

/** the comment and note keys `tr` references more often than before it, and which of them were referenced already */
function mintedBy(tr: Transaction): { minted: Set<string>; existing: Set<string> } {
  const ids = new Set<string>()
  for (const step of tr.steps) idsIn(step.toJSON(), (kind, id) => ids.add(`${kind}:${id}`))
  const minted = new Set<string>()
  const existing = new Set<string>()
  if (ids.size === 0) return { minted, existing }
  const count = (doc: PmNode): Map<string, number> => {
    const counts = new Map<string, number>()
    doc.descendants((node) => {
      const keys: string[] = []
      for (const mark of node.marks) {
        if (mark.type.name === 'comment')
          for (const id of String(mark.attrs.ids).split(/\s+/)) if (id) keys.push(`comment:${id}`)
      }
      if (node.type.name === 'docNoteRef')
        keys.push(
          `${node.attrs.kind === 'endnote' ? 'endnote' : 'footnote'}:${String(node.attrs.id)}`,
        )
      for (const key of keys) if (ids.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return counts
  }
  const before = count(tr.docs[0] ?? tr.before)
  const after = count(tr.doc)
  for (const key of ids) {
    if ((after.get(key) ?? 0) <= (before.get(key) ?? 0)) continue
    minted.add(key)
    if ((before.get(key) ?? 0) > 0) existing.add(key)
  }
  return { minted, existing }
}

type IdKind = 'comment' | 'footnote' | 'endnote'

/** side entry key `kind:id` to the old id's replacement */
type Renames = Map<string, string>

function idKindOf(key: string): IdKind | null {
  const kind = key.slice(0, key.indexOf(':'))
  return kind === 'comment' || kind === 'footnote' || kind === 'endnote' ? kind : null
}

/** Every comment and note id a step's JSON carries (comment marks, note references) */
function idsIn(json: unknown, found: (kind: IdKind, id: string) => void): void {
  if (Array.isArray(json)) {
    for (const item of json) idsIn(item, found)
    return
  }
  if (!json || typeof json !== 'object') return
  const node = json as Record<string, unknown>
  const attrs = node.attrs as Record<string, unknown> | undefined
  if (node.type === 'comment' && typeof attrs?.ids === 'string') {
    for (const id of attrs.ids.split(/\s+/)) if (id) found('comment', id)
  } else if (node.type === 'docNoteRef' && attrs && attrs.id !== '' && attrs.id != null) {
    found(attrs.kind === 'endnote' ? 'endnote' : 'footnote', String(attrs.id))
  }
  for (const value of Object.values(node)) idsIn(value, found)
}

/** `json` with the renamed ids; the same object when it holds none of them */
function renameIds<T>(json: T, renames: Renames): T {
  if (Array.isArray(json)) {
    const items = json.map((item) => renameIds(item, renames))
    return (items.some((item, i) => item !== json[i]) ? items : json) as T
  }
  if (!json || typeof json !== 'object') return json
  const node = json as Record<string, unknown>
  let out: Record<string, unknown> = node
  for (const [key, value] of Object.entries(node)) {
    const next = renameIds(value, renames)
    if (next !== value) out = { ...out, [key]: next }
  }
  const attrs = out.attrs as Record<string, unknown> | undefined
  if (node.type === 'comment' && typeof attrs?.ids === 'string') {
    const ids = attrs.ids
      .split(/\s+/)
      .map((id) => renames.get(`comment:${id}`) ?? id)
      .join(' ')
    if (ids !== attrs.ids) out = { ...out, attrs: { ...attrs, ids } }
  } else if (node.type === 'docNoteRef' && attrs && attrs.id != null) {
    const kind = attrs.kind === 'endnote' ? 'endnote' : 'footnote'
    const id = renames.get(`${kind}:${String(attrs.id)}`)
    if (id !== undefined) {
      out = { ...out, attrs: { ...attrs, id: typeof attrs.id === 'number' ? Number(id) : id } }
    }
  }
  return out as T
}

/** A side op for a renamed item: its new key, and the item (and a reply's parent) renumbered */
function renamedSide(op: SideOp, renames: Renames): SideOp {
  const kind = idKindOf(op.key)
  if (!kind) return op
  const to = renames.get(op.key)
  let value = op.value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (to !== undefined) value = { ...value, id: to }
    const parent =
      typeof value.parentId === 'string' ? renames.get(`${kind}:${value.parentId}`) : undefined
    if (parent !== undefined) value = { ...value, parentId: parent }
  }
  const key = to === undefined ? op.key : `${kind}:${to}`
  return key === op.key && value === op.value ? op : { kind: 'side', key, value }
}

function tooLarge(json: unknown, limit: number): boolean {
  const text = JSON.stringify(json)
  // a UTF-16 unit is at most three UTF-8 bytes: most edits are cleared without encoding
  return text.length * 3 > limit && new TextEncoder().encode(text).length > limit
}

/** Plugin's `key` string is public at runtime but missing from its typings */
function pluginKeyOf(plugin: Plugin): string {
  const typed = plugin as unknown as { key: string }
  return typed.key
}

function applySide(map: Map<string, Json>, op: SideOp): void {
  if (op.value === null) map.delete(op.key)
  else map.set(op.key, op.value)
}

function sameJson(a: Json | undefined, b: Json): boolean {
  return a !== undefined && canonical(a) === canonical(b)
}

/** JSON with object keys sorted, so equal values read the same whatever built them */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key]
    return sorted
  })
}

/**
 * The body as every client must hold it: a TOC line's page number is the one
 * value layout writes into the document (App's pagination pass), and each
 * client derives it on its own.
 */
function withoutLayout(node: Json): Json {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const out: Record<string, Json> = { ...node }
  const attrs = out.attrs
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const field = attrs.fieldDisplay
    if (field && typeof field === 'object' && !Array.isArray(field) && field.kind === 'tocLine') {
      const { right: _pageNumber, ...rest } = field
      out.attrs = { ...attrs, fieldDisplay: rest }
    }
  }
  if (Array.isArray(out.content)) out.content = out.content.map(withoutLayout)
  return out
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
