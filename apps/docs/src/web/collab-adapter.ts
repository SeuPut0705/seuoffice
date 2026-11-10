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
import { Step, type Transform } from '@tiptap/pm/transform'
import * as pmCollab from 'prosemirror-collab'
import { TABLE_TRAILING_SKIP } from '../renderer/editor/extensions'
import { TRACK_IGNORE } from '../renderer/editor/revisions'

export type DocsOp =
  { kind: 'steps'; steps: Step[] } | { kind: 'side'; key: string; value: Json }

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
  /** a local edit was refused instead of ending the session */
  refused?(reason: 'too_large'): void
}

/** What `rebaseSteps` handles; prosemirror-collab's own class has exactly these fields */
interface Rebaseable {
  readonly step: Step
  readonly inverted: Step
  readonly origin: Transform
}

// prosemirror-collab exports `rebaseSteps` at runtime and marks it internal in its typings
const { rebaseSteps } = pmCollab as unknown as {
  rebaseSteps(steps: readonly Rebaseable[], over: readonly Step[], transform: Transform): Rebaseable[]
}

/**
 * Transactions that write layout every client derives on its own (pagination
 * results such as TOC page numbers). They stay local: no op, no fingerprint.
 * Upstream code marks them with this meta; each such step only rewrites node
 * attributes, so it never moves a position the log refers to.
 */
export const LAYOUT_DERIVED = 'layoutDerived'

const remoteKey = new PluginKey<{ records: Recorded[] }>('seuCollab')

/** plugins that must see remote transactions: they map positions they keep across transactions */
const SEES_REMOTE = new Set(['trackChangesRecorder$'])

interface Recorded {
  serial: number
  tr: Transaction
}

export function createDocsAdapter(options: DocsAdapterOptions): CollabAdapter<DocsOp> {
  const { editor, side } = options
  const schema = editor.schema
  /** each local steps op's origin transaction, which tags its entries in `tail` */
  const origins = new WeakMap<StepsOp, Transform>()
  const layoutOnly = new WeakSet<Transform>()
  let tail: Rebaseable[] = []
  let sideConfirmed = new Map(side.read())
  let sideView = new Map(sideConfirmed)
  let frozen = false
  let serial = 0
  let committed = 0
  let emit: ((ops: DocsOp[]) => void) | null = null
  let unready: DocsOp[] = []
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
      if (!own || wrapped.has(plugin) || SEES_REMOTE.has(pluginKeyOf(plugin))) continue
      wrapped.add(plugin)
      spec.appendTransaction = (trs, ...rest) =>
        trs.some((tr) => tr.getMeta(remoteKey)) ? null : own.call(plugin, trs, ...rest)
    }
  }

  /**
   * Ops made while `integrate` runs (an in-place table edit committed before a
   * peer's change redraws it, App state read before it is overwritten) wait
   * here and go out once it returned: the engine forbids an emit inside it.
   * Their steps live in `tail` like any other local op's until then.
   */
  let integrating = false
  let held: DocsOp[] = []

  const deliver = (ops: DocsOp[]): void => {
    if (ops.length === 0) return
    if (integrating) {
      if (held.length === 0) queueMicrotask(releaseHeld)
      held.push(...ops)
    } else if (emit) emit(ops)
    else unready.push(...ops)
  }

  const releaseHeld = (): void => {
    const ops = held.map((op) => (op.kind === 'side' ? op : rebuilt(op)))
    held = []
    deliver(ops)
  }

  const commit = (records: readonly Recorded[]): void => {
    const ops: DocsOp[] = []
    for (const { serial: at, tr } of records) {
      if (at <= committed) continue
      committed = at
      const entries = tr.steps.map((step, i) => ({ step, inverted: step.invert(tr.docs[i]), origin: tr }))
      if (tr.getMeta(LAYOUT_DERIVED)) {
        // with nothing unconfirmed before it, it simply becomes part of this client's base
        if (tail.length === 0) continue
        layoutOnly.add(tr)
      } else {
        const op: StepsOp = { kind: 'steps', steps: tr.steps.slice() }
        origins.set(op, tr)
        ops.push(op)
      }
      tail.push(...entries)
    }
    deliver(ops)
  }

  editor.registerPlugin(
    new Plugin<{ records: Recorded[] }>({
      key: remoteKey,
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
      // While frozen no local change reaches the document, whatever command or input made it.
      // An edit too large for one change is refused here, so the session outlives it.
      filterTransaction: (tr) => {
        if (!tr.docChanged || tr.getMeta(remoteKey) || tr.getMeta(LAYOUT_DERIVED)) return true
        if (frozen) return false
        if (!tooLarge(tr.steps, options.maxOpBytes)) return true
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

  const unobserve = side.observe(() => {
    const now = side.read()
    const ops: SideOp[] = []
    for (const [key, value] of now) {
      if (!sameJson(sideView.get(key), value)) ops.push({ kind: 'side', key, value })
    }
    for (const key of sideView.keys()) {
      if (!now.has(key)) ops.push({ kind: 'side', key, value: null })
    }
    for (const op of ops) applySide(sideView, op)
    deliver(ops)
  })

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
    const ownSteps = tail.filter((entry) => !layoutOnly.has(entry.origin))
    for (const entry of ownSteps) idsIn(entry.step.toJSON(), minted(mine))
    for (const op of [...local, ...held]) {
      if (op.kind === 'side' && op.value !== null && idKindOf(op.key) && !before.has(op.key))
        mine.add(op.key)
    }
    const renames: Renames = new Map()
    const taken = new Set([...sideConfirmed.keys(), ...sideView.keys(), ...theirs, ...mine])
    for (const key of mine) {
      if (!theirs.has(key)) continue
      const kind = idKindOf(key)!
      let next = 1
      for (const other of taken) {
        if (idKindOf(other) === kind) next = Math.max(next, (parseInt(other.slice(kind.length + 1), 10) || 0) + 1)
      }
      taken.add(`${kind}:${next}`)
      renames.set(key, String(next))
    }
    if (renames.size === 0) return renames
    tail = tail.map((entry) => {
      if (layoutOnly.has(entry.origin)) return entry
      const json = entry.step.toJSON()
      const renamed = renameIds(json, renames)
      return renamed === json ? entry : { ...entry, step: Step.fromJSON(schema, renamed) }
    })
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
      const early = unready
      unready = []
      deliver(early)
      return () => {
        if (emit === handler) emit = null
        unobserve()
      }
    },

    integrate(remote, local) {
      integrating = true
      try {
        const before = new Set(sideConfirmed.keys())
        for (const op of remote) if (op.kind === 'side') applySide(sideConfirmed, op)
        const localOrigins = new Set<Transform>()
        for (const op of [...local, ...held]) {
          if (op.kind !== 'steps') continue
          const origin = origins.get(op)
          if (!origin) throw new Error('an unconfirmed op this editor never made')
          localOrigins.add(origin)
        }
        for (const entry of tail) {
          if (!layoutOnly.has(entry.origin) && !localOrigins.has(entry.origin))
            throw new Error('the editor holds steps the engine does not count as unconfirmed')
        }

        const over = remote.flatMap((op) => (op.kind === 'steps' ? op.steps : []))
        if (over.length > 0) commitPendingEdit(over)
        const renames = renumber(remote, local, before)
        if (over.length > 0 || renames.size > 0) {
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

        const rebased = local.map((op) => (op.kind === 'side' ? renamedSide(op, renames) : rebuilt(op)))
        held = held.map((op) => (op.kind === 'side' ? renamedSide(op, renames) : op))
        const shown = sideView
        sideView = new Map(sideConfirmed)
        for (const op of [...rebased, ...held]) if (op.kind === 'side') applySide(sideView, op)
        const entries = new Map<string, Json | null>()
        for (const [key, value] of sideView) if (!sameJson(shown.get(key), value)) entries.set(key, value)
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
        for (const entry of tail.slice(0, last + 1)) {
          if (entry.origin !== origin && !layoutOnly.has(entry.origin))
            throw new Error('ops were confirmed out of order')
        }
        tail = tail.slice(last + 1)
      }
      // layout steps nothing unconfirmed precedes join this client's base
      while (tail.length > 0 && layoutOnly.has(tail[0].origin)) tail.shift()
    },

    fingerprint() {
      const text = canonical({
        doc: withoutLayout(editor.state.doc.toJSON() as Json),
        side: [...sideView],
      })
      return sha256(text)
    },

    setEditable(editable) {
      frozen = !editable
    },

    produceFile: () => options.produce(new Map(sideView)),
  }
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

function tooLarge(steps: readonly Step[], limit: number): boolean {
  const text = JSON.stringify(steps.map((step) => step.toJSON()))
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
