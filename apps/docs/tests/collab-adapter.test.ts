import { parseDocx } from '@seuoffice/docx-engine'
import { MAX_CHANGE_BYTES, type Json } from '@seuoffice/collab/client'
import { simulate, type SimulatedEditor } from '@seuoffice/collab/conformance'
import { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { canJoin } from '@tiptap/pm/transform'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  createDocsAdapter,
  type DocsAdapterOptions,
  type DocsOp,
  type SideChange,
  type SideStore,
} from '../src/web/collab-adapter'

const FORMAT = { name: 'docx', schema: 1 }

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const cell = (text: string) => `<w:tc>${para(text)}</w:tc>`
const BODY =
  para('alpha beta gamma') +
  para('delta epsilon') +
  '<w:tbl><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
  `<w:tr>${cell('A1')}${cell('B1')}</w:tr><w:tr>${cell('A2')}${cell('B2')}</w:tr></w:tbl>` +
  para('zeta eta theta')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
// jsdom's Uint8Array is not TextEncoder's: the server tells frames apart with `instanceof`
const bytesOf = (text: string): Uint8Array => new Uint8Array(encoder.encode(text))

/**
 * The file the simulated clients open and save: the body as ProseMirror JSON
 * and the synced outside entries. The real save goes through the docx
 * builder; that path is covered by the browser test.
 */
interface TestFile {
  doc: unknown
  side: [string, Json][]
}

let base: Uint8Array
let baseText = ''
const editors: Editor[] = []

beforeAll(async () => {
  const parsed = await parseDocx(await buildDocx({ bodyXml: BODY }))
  const file: TestFile = {
    doc: blocksToPmDoc(parsed.blocks),
    side: [
      ['section', { pageColor: null, dirty: false }],
      ['comment:1', { id: '1', text: 'first' }],
    ],
  }
  base = bytesOf(JSON.stringify(file))
  const probe = new Editor({ extensions: editorExtensions, content: file.doc as never })
  baseText = probe.state.doc.textContent
  probe.destroy()
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

/** Side entries held in memory, changed by the simulated user */
function memorySide(initial: [string, Json][]): SideStore & {
  set(key: string, value: Json): void
  readonly all: Map<string, Json>
} {
  let entries = new Map(initial)
  let changed: (() => void) | null = null
  return {
    get all() {
      return entries
    },
    read: () => new Map(entries),
    write({ renames, entries: changes }) {
      const renamed = new Map<string, Json>()
      for (const [key, value] of entries) {
        const to = renames.get(key)
        if (to === undefined) renamed.set(key, value)
        else
          renamed.set(`${key.slice(0, key.indexOf(':'))}:${to}`, { ...(value as object), id: to })
      }
      entries = renamed
      for (const [key, value] of changes) {
        if (value === null) entries.delete(key)
        else entries.set(key, value)
      }
    },
    observe(handler) {
      changed = handler
      return () => (changed = null)
    },
    set(key, value) {
      if (value === null) entries.delete(key)
      else entries.set(key, value)
      changed?.()
    },
  }
}

interface TaggedOp {
  id: string
  ops: DocsOp[]
}

const textblocks = (doc: PmNode): { pos: number; node: PmNode }[] => {
  const found: { pos: number; node: PmNode }[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) found.push({ pos, node })
  })
  return found
}

/**
 * The real editor and adapter, with the kit's bookkeeping: everything one
 * simulated edit reports (the user's transaction and whatever plugins append)
 * travels as one tagged op, so every op the kit counts is one user action.
 */
type Kind =
  | 'typeFirst'
  | 'removeFirst'
  | 'insert'
  | 'remove'
  | 'split'
  | 'join'
  | 'span'
  | 'row'
  | 'side'
  | 'comment'
  | 'footnote'
  | 'picture'

/** text every simulated insert put in, by tag */
const typed = new Set<string>()
/** `kind <tag>` of every comment and footnote a simulated user added */
const added = new Set<string>()
let last: Editor | null = null
let lastSide: { readonly all: Map<string, Json> } | null = null

const opener =
  (only: readonly Kind[]) =>
  (bytes: Uint8Array): SimulatedEditor<TaggedOp> =>
    openHeadless(bytes, only)

function openHeadless(bytes: Uint8Array, only: readonly Kind[]): SimulatedEditor<TaggedOp> {
  const file = JSON.parse(decoder.decode(bytes)) as TestFile
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: file.doc as never,
  })
  editors.push(editor)
  last = editor
  const side = memorySide(file.side)
  lastSide = side
  const inner = createDocsAdapter({
    editor,
    side,
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
    produce: async (entries) => ({
      fileName: 'memo.json',
      bytes: bytesOf(JSON.stringify({ doc: editor.getJSON(), side: [...entries] })),
    }),
  })
  /** ops the adapter reported during the current simulated edit */
  let held: DocsOp[] | null = null
  let emit: ((ops: TaggedOp[]) => void) | null = null
  let editable = true

  const flatten = (ops: TaggedOp[]) => ops.flatMap((op) => op.ops)
  const regroup = (ops: TaggedOp[], inner: DocsOp[]): TaggedOp[] => {
    let at = 0
    return ops.map((op) => ({ id: op.id, ops: inner.slice(at, (at += op.ops.length)) }))
  }

  const first = (): { pos: number; node: PmNode } => textblocks(editor.state.doc)[0]
  const typeAt = (pos: number, id: string): boolean => {
    editor.view.dispatch(editor.state.tr.insertText(`<${id}>`, pos))
    typed.add(`<${id}>`)
    return true
  }
  const removeIn = ({ pos, node }: { pos: number; node: PmNode }, r: () => number): boolean => {
    if (node.content.size < 2) return false
    const from = pos + 1 + Math.floor(r() * node.content.size)
    const to = Math.min(pos + 1 + node.content.size, from + 1 + Math.floor(r() * 6))
    editor.view.dispatch(editor.state.tr.delete(from, to))
    return true
  }

  const random: Record<Kind, (r: () => number, id: string) => boolean> = {
    typeFirst(r, id) {
      const { pos, node } = first()
      return typeAt(pos + 1 + Math.floor(r() * (node.content.size + 1)), id)
    },
    removeFirst: (r) => removeIn(first(), r),
    insert(r, id) {
      const blocks = textblocks(editor.state.doc)
      const { pos, node } = blocks[Math.floor(r() * blocks.length)]
      return typeAt(pos + 1 + Math.floor(r() * (node.content.size + 1)), id)
    },
    remove(r) {
      const blocks = textblocks(editor.state.doc)
      return removeIn(blocks[Math.floor(r() * blocks.length)], r)
    },
    split(r: () => number): boolean {
      const blocks = textblocks(editor.state.doc).filter(({ node }) => node.content.size > 0)
      const { pos, node } = blocks[Math.floor(r() * blocks.length)]
      editor.view.dispatch(editor.state.tr.split(pos + 1 + Math.floor(r() * node.content.size)))
      return true
    },
    join(r: () => number): boolean {
      const doc = editor.state.doc
      const joints: number[] = []
      doc.forEach((node, offset, index) => {
        const before = index > 0 ? doc.child(index - 1) : null
        if (before?.type === node.type && node.isTextblock && canJoin(doc, offset))
          joints.push(offset)
      })
      if (joints.length === 0) return false
      editor.view.dispatch(editor.state.tr.join(joints[Math.floor(r() * joints.length)]))
      return true
    },
    span(r: () => number): boolean {
      // a delete across paragraph ends, overlapping whatever peers do there
      const blocks = textblocks(editor.state.doc).filter(({ node }) => node.content.size > 0)
      if (blocks.length < 2) return false
      const first = Math.floor(r() * (blocks.length - 1))
      const a = blocks[first]
      const b = blocks[first + 1]
      if (a.node.type !== b.node.type || editor.state.doc.resolve(a.pos).depth !== 0) return false
      if (editor.state.doc.resolve(b.pos).depth !== 0) return false
      const from = a.pos + 1 + Math.floor(r() * a.node.content.size)
      const to = b.pos + 1 + Math.floor(r() * b.node.content.size)
      editor.view.dispatch(editor.state.tr.delete(from, to))
      return true
    },
    row(r: () => number): boolean {
      const rows: { pos: number; node: PmNode; count: number }[] = []
      editor.state.doc.descendants((node, pos, parent) => {
        if (node.type.name === 'docTableRow')
          rows.push({ pos, node, count: parent?.childCount ?? 0 })
      })
      if (rows.length === 0) return false
      const { pos, node, count } = rows[Math.floor(r() * rows.length)]
      const tr = editor.state.tr
      if (r() < 0.5 || count < 2) tr.insert(pos + node.nodeSize, node.copy(node.content))
      else tr.delete(pos, pos + node.nodeSize)
      editor.view.dispatch(tr)
      return true
    },
    side(r: () => number): boolean {
      const key = r() < 0.5 ? 'section' : `comment:${1 + Math.floor(r() * 3)}`
      side.set(key, r() < 0.15 && key !== 'section' ? null : { value: Math.floor(r() * 100) })
      return true
    },
    comment(r, id) {
      // a new comment takes the largest id plus one, as the App's nextCommentId does
      const ids = [...side.all.keys()]
        .filter((key) => key.startsWith('comment:'))
        .map((key) => parseInt(key.slice('comment:'.length), 10) || 0)
      const n = String(Math.max(0, ...ids) + 1)
      // the commented text is new, so no two comments' ranges replace each other's mark
      const blocks = textblocks(editor.state.doc)
      const { pos, node } = blocks[Math.floor(r() * blocks.length)]
      const at = pos + 1 + Math.floor(r() * (node.content.size + 1))
      const mark = editor.schema.marks.comment.create({ ids: n })
      editor.view.dispatch(editor.state.tr.insert(at, editor.schema.text('c', [mark])))
      side.set(`comment:${n}`, { id: n, text: `<${id}>` })
      added.add(`comment <${id}>`)
      return true
    },
    footnote(r, id) {
      const ids = [...side.all.keys()]
        .filter((key) => key.startsWith('footnote:'))
        .map((key) => parseInt(key.slice('footnote:'.length), 10) || 0)
      const n = String(Math.max(0, ...ids) + 1)
      const blocks = textblocks(editor.state.doc)
      const { pos, node } = blocks[Math.floor(r() * blocks.length)]
      const at = pos + 1 + Math.floor(r() * (node.content.size + 1))
      const ref = editor.schema.nodes.docNoteRef.create({ kind: 'footnote', id: n })
      editor.view.dispatch(editor.state.tr.insert(at, ref))
      side.set(`footnote:${n}`, { id: n, text: `<${id}>` })
      added.add(`footnote <${id}>`)
      return true
    },
    picture(r, id) {
      // one step well over the old 256 KiB limit on a change, like a pasted picture
      const blocks = textblocks(editor.state.doc)
      const { pos } = blocks[Math.floor(r() * blocks.length)]
      editor.view.dispatch(editor.state.tr.insertText(`<${id}>${'p'.repeat(300 * 1024)}`, pos + 1))
      return true
    },
  }
  const kinds = only.map((kind) => random[kind])

  return {
    encode: (op) => ({ id: op.id, ops: op.ops.map((one) => inner.encode(one)) }),
    decode(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not tagged')
      if (typeof json.id !== 'string' || !Array.isArray(json.ops)) throw new Error('not tagged')
      return { id: json.id, ops: json.ops.map((one) => inner.decode(one)) }
    },
    listen(handler) {
      emit = handler
      return inner.listen((ops) => {
        if (!held) throw new Error(`an op outside any user edit: ${JSON.stringify(ops)}`)
        held.push(...ops)
      })
    },
    integrate: (remote, local) => {
      const rebased = inner.integrate(flatten(remote), flatten(local))
      expect(rebased).toHaveLength(flatten(local).length)
      return regroup(local, rebased)
    },
    confirmed: (ops) => inner.confirmed?.(flatten(ops)),
    fingerprint: () => inner.fingerprint(),
    setEditable(value) {
      editable = value
      inner.setEditable(value)
    },
    produceFile: () => inner.produceFile(),
    edit(r, id) {
      if (!editable || !emit) return false
      const ops: DocsOp[] = []
      held = ops
      try {
        kinds[Math.floor(r() * kinds.length)](r, id)
      } finally {
        held = null
      }
      if (ops.length > 0) emit([{ id, ops }])
      return ops.length > 0
    },
    opKey(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.id !== 'string')
        throw new Error('not tagged')
      return json.id
    },
  }
}

const run = (only: readonly Kind[], seed: number, clients = 3) =>
  simulate({
    seed,
    clients,
    steps: 400,
    file: { format: FORMAT, bytes: base },
    adapterFactory: opener(only),
  })

const SEEDS = [1, 2, 4, 5]

describe('the docs adapter under the conformance kit, with real editors', () => {
  for (const seed of SEEDS) {
    it(`keeps every user's typing in one paragraph (seed ${seed})`, async () => {
      typed.clear()
      const report = await run(['typeFirst'], seed)
      expect(report.ops).toBeGreaterThan(20)
      // nobody deleted anything: the late joiner holds the base text plus every insert, though
      // inserts typed into each other interleave their characters
      const chars = (text: string) => [...text].sort().join('')
      const expected = baseText + [...typed].join('')
      expect(chars(last!.state.doc.textContent)).toBe(chars(expected))
    }, 120_000)

    it(`converges on overlapping deletes and inserts in one paragraph (seed ${seed})`, async () => {
      expect((await run(['typeFirst', 'removeFirst'], seed)).ops).toBeGreaterThan(20)
    }, 120_000)

    it(`converges on paragraphs split, joined and deleted across (seed ${seed})`, async () => {
      expect((await run(['insert', 'split', 'join', 'span'], seed)).ops).toBeGreaterThan(20)
    }, 120_000)

    it(`converges on table rows added and removed while cells are typed in (seed ${seed})`, async () => {
      expect((await run(['row', 'insert', 'remove'], seed)).ops).toBeGreaterThan(20)
    }, 120_000)

    it(`converges on outside-state writes (seed ${seed})`, async () => {
      expect((await run(['side', 'insert'], seed)).ops).toBeGreaterThan(20)
    }, 120_000)
  }

  // the kit's scheduler barely lets four clients edit under seeds 13 and 15, whatever the adapter
  for (const seed of [11, 12, 14, 16, 17, 18, 19, 21]) {
    it(`converges on every edit kind at once (seed ${seed})`, async () => {
      const all: Kind[] = [
        'typeFirst',
        'removeFirst',
        'insert',
        'remove',
        'split',
        'join',
        'span',
        'row',
        'side',
      ]
      expect((await run(all, seed, 4)).ops).toBeGreaterThan(20)
    }, 120_000)
  }
})

/** Every comment or footnote a simulated user added is there once, referenced from the body */
function expectEveryAddition(kind: 'comment' | 'footnote'): void {
  const entries = [...lastSide!.all].filter(([key]) => key.startsWith(`${kind}:`))
  const texts = entries.map(([, value]) => (value as { text?: string }).text ?? '')
  const wanted = [...added]
    .filter((item) => item.startsWith(`${kind} `))
    .map((item) => item.slice(kind.length + 1))
  expect(texts.filter((text) => text.startsWith('<')).sort()).toEqual(wanted.sort())
  const referenced = new Set<string>()
  last!.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment')
        for (const id of String(mark.attrs.ids).split(/\s+/)) referenced.add(`comment:${id}`)
    }
    if (node.type.name === 'docNoteRef') referenced.add(`footnote:${String(node.attrs.id)}`)
  })
  for (const [key, value] of entries) {
    if ((value as { text?: string }).text?.startsWith('<')) expect(referenced).toContain(key)
  }
}

describe('ids two people mint at the same moment', () => {
  for (const seed of SEEDS) {
    it(`keeps both of two comments added at once (seed ${seed})`, async () => {
      added.clear()
      expect((await run(['comment', 'insert'], seed)).ops).toBeGreaterThan(20)
      expectEveryAddition('comment')
    }, 120_000)

    it(`keeps both of two footnotes added at once (seed ${seed})`, async () => {
      added.clear()
      expect((await run(['footnote', 'insert'], seed)).ops).toBeGreaterThan(20)
      expectEveryAddition('footnote')
    }, 120_000)
  }
})

describe('large edits', () => {
  it('carries steps larger than 256 KiB', async () => {
    const report = await simulate({
      seed: 9,
      clients: 2,
      steps: 120,
      file: { format: FORMAT, bytes: base },
      adapterFactory: opener(['picture', 'insert']),
    })
    expect(report.ops).toBeGreaterThan(5)
    expect(last!.state.doc.textContent.length).toBeGreaterThan(256 * 1024)
  }, 120_000)

  it('refuses an edit larger than one change may be and keeps editing', () => {
    const { editor, adapter, refused } = headlessPair()
    const emitted: DocsOp[] = []
    adapter.listen((ops) => emitted.push(...ops))
    const before = editor.state.doc
    editor.view.dispatch(editor.state.tr.insertText('x'.repeat(MAX_CHANGE_BYTES), 1))
    expect(editor.state.doc).toBe(before)
    expect(refused).toEqual(['too_large'])
    editor.view.dispatch(editor.state.tr.insertText('small', 1))
    expect(editor.state.doc.textContent).toContain('small')
    expect(emitted).toHaveLength(1)
  })
})

/** One editor on the base file with its adapter, outside any network */
function headlessPair(extra: Partial<DocsAdapterOptions> & { side?: SideStore } = {}) {
  const file = JSON.parse(decoder.decode(base)) as TestFile
  const editor = new Editor({ extensions: editorExtensions, content: file.doc as never })
  editors.push(editor)
  const refused: string[] = []
  const side = extra.side ?? memorySide(file.side)
  const adapter = createDocsAdapter({
    produce: async () => ({ fileName: 'memo.json', bytes: new Uint8Array() }),
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
    refused: (reason) => refused.push(reason),
    ...extra,
    editor,
    side,
  })
  return { editor, adapter, refused, side }
}

const firstCell = (editor: Editor): { table: number; text: number } => {
  let table = -1
  let text = -1
  editor.state.doc.descendants((node, pos) => {
    if (table < 0 && node.type.name === 'docTable') table = pos
    if (table >= 0 && text < 0 && node.isTextblock) text = pos + 1
    return text < 0
  })
  return { table, text }
}

describe('a table edited in place', () => {
  it('commits the cell being typed in before a peer’s change to that table redraws it', async () => {
    let draft: string | null = 'draft'
    const alice = headlessPair({
      pendingEdit: () => {
        if (draft === null) return null
        return {
          pos: firstCell(alice.editor).table,
          commit: () => {
            const text = draft!
            draft = null
            alice.editor.view.dispatch(
              alice.editor.state.tr.insertText(text, firstCell(alice.editor).text),
            )
          },
        }
      },
    })
    const bob = headlessPair()
    const fromAlice: DocsOp[] = []
    const fromBob: DocsOp[] = []
    alice.adapter.listen((ops) => fromAlice.push(...ops))
    bob.adapter.listen((ops) => fromBob.push(...ops))

    bob.editor.view.dispatch(bob.editor.state.tr.insertText('peer', firstCell(bob.editor).text))
    const wire = (op: DocsOp, from = bob.adapter, to = alice.adapter) => to.decode(from.encode(op))
    expect(
      alice.adapter.integrate(
        fromBob.map((op) => wire(op)),
        [],
      ),
    ).toEqual([])
    // the committed cell text went out after integrate returned, rebased past the peer's
    expect(fromAlice).toHaveLength(0)
    await Promise.resolve()
    expect(fromAlice).toHaveLength(1)
    expect(alice.editor.state.doc.textContent).toContain('draft')
    expect(alice.editor.state.doc.textContent).toContain('peer')

    bob.adapter.confirmed?.(fromBob)
    bob.adapter.integrate(
      fromAlice.map((op) => wire(op, alice.adapter, bob.adapter)),
      [],
    )
    alice.adapter.confirmed?.(fromAlice)
    expect(await bob.adapter.fingerprint()).toBe(await alice.adapter.fingerprint())
  })
})

type Pair = ReturnType<typeof headlessPair>

/** `to` takes `ops` from `from` over the wire, as confirmed changes it did not make */
const carry = (ops: DocsOp[], from: Pair, to: Pair, local: DocsOp[] = []): DocsOp[] =>
  to.adapter.integrate(
    ops.map((op) => to.adapter.decode(from.adapter.encode(op))),
    local,
  )

function listening(pair: Pair): DocsOp[] {
  const sent: DocsOp[] = []
  pair.adapter.listen((ops) => sent.push(...ops))
  return sent
}

/** a position just inside the textblock that holds `text` */
const at = (editor: Editor, text: string): number => {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent.includes(text)) found = pos + 1
    return found < 0
  })
  return found
}

describe('undo after a peer’s edit', () => {
  it('takes back exactly this user’s own typing, and the peer applies the same', async () => {
    const alice = headlessPair()
    const bob = headlessPair()
    const fromAlice = listening(alice)
    const fromBob = listening(bob)
    const type = (text: string, pos: number, close: boolean) => {
      const tr = alice.editor.state.tr.insertText(text, pos)
      alice.editor.view.dispatch(close ? closeHistory(tr) : tr)
    }
    // two confirmed edits, each its own undo step
    type('X', at(alice.editor, 'delta'), true)
    type('Y', at(alice.editor, 'delta'), true)
    const first = fromAlice.splice(0)
    carry(first, alice, bob)
    alice.adapter.confirmed?.(first)
    // three quick characters: one undo step, three unconfirmed steps
    const end = at(alice.editor, 'zeta') + 'zeta eta theta'.length
    type('a', end, true)
    type('b', end + 1, false)
    type('c', end + 2, false)
    const unconfirmed = fromAlice.splice(0)
    expect(unconfirmed).toHaveLength(3)

    bob.editor.view.dispatch(bob.editor.state.tr.insertText('BOB', at(bob.editor, 'alpha')))
    const peer = fromBob.splice(0)
    const rebased = carry(peer, bob, alice, unconfirmed)
    bob.adapter.confirmed?.(peer)

    for (let i = 0; i < 10 && alice.editor.commands.undo(); i++);
    const text = alice.editor.state.doc.textContent
    expect(text).toContain('BOB')
    expect(text).toBe(baseText.replace('alpha', 'BOBalpha'))

    carry([...rebased, ...fromAlice.splice(0)], alice, bob)
    expect(bob.editor.state.doc.textContent).toBe(text)
    expect(await bob.adapter.fingerprint()).toBe(await alice.adapter.fingerprint())
  })
})

describe('a fingerprint right after a peer’s change', () => {
  it('leaves out a table draft committed inside integrate until the engine has it', async () => {
    let draft: string | null = 'draft'
    const alice: Pair = headlessPair({
      pendingEdit: () =>
        draft === null
          ? null
          : {
              pos: firstCell(alice.editor).table,
              commit: () => {
                const text = draft!
                draft = null
                alice.editor.view.dispatch(
                  alice.editor.state.tr.insertText(text, firstCell(alice.editor).text),
                )
              },
            },
    })
    const bob = headlessPair()
    const carol = headlessPair()
    listening(alice)
    const fromBob = listening(bob)
    bob.editor.view.dispatch(bob.editor.state.tr.insertText('peer', firstCell(bob.editor).text))
    const ops = fromBob.splice(0)
    carry(ops, bob, alice)
    carry(ops, bob, carol)
    // the engine may ask in the same turn: alice vouches for the version, not for her draft
    const fp = await alice.adapter.fingerprint()
    expect(alice.editor.state.doc.textContent).toContain('draft')
    expect(fp).toBe(await carol.adapter.fingerprint())
  })
})

/**
 * An App-like outside store: its own additions and the adapter's writes are
 * queued, as React state updates are, and show only after `render`; a list
 * may then hold two items with one id, and the later one is what a read sees.
 */
function laggingSide(initial: [string, Json][]) {
  let shown: [string, Json][] = [...initial]
  const queued: Array<(items: [string, Json][]) => [string, Json][]> = []
  let changed: (() => void) | null = null
  return {
    read: () => new Map(shown),
    write({ renames, entries }: SideChange) {
      queued.push((items) => {
        let next = items.map(([key, value]): [string, Json] => {
          const to = renames.get(key)
          return to === undefined
            ? [key, value]
            : [`${key.slice(0, key.indexOf(':'))}:${to}`, { ...(value as object), id: to }]
        })
        for (const [key, value] of entries) {
          next = next.filter(([other]) => other !== key)
          if (value !== null) next.push([key, value])
        }
        return next
      })
    },
    observe(handler: () => void) {
      changed = handler
      return () => (changed = null)
    },
    add(key: string, value: Json) {
      queued.push((items) => [...items, [key, value]])
    },
    render() {
      for (const update of queued.splice(0)) shown = update(shown)
      changed?.()
    },
    ids(kind: string): number[] {
      return shown
        .filter(([key]) => key.startsWith(`${kind}:`))
        .map(([key]) => Number(key.split(':')[1]))
    },
  }
}

const noteRefs = (editor: Editor): string[] => {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'docNoteRef') ids.push(String(node.attrs.id))
  })
  return ids.sort()
}

describe('a note added while a peer’s note is still on its way into the list', () => {
  it('sends the reference and its entry together, and renumbers a colliding id', async () => {
    const file = JSON.parse(decoder.decode(base)) as TestFile
    const bob = headlessPair()
    const lag = laggingSide(file.side)
    const carol = headlessPair({ side: lag })
    const batches: DocsOp[][] = []
    bob.adapter.listen((ops) => batches.push(ops))
    const fromCarol = listening(carol)

    const ref = (editor: Editor, id: string) =>
      editor.schema.nodes.docNoteRef.create({ kind: 'footnote', id })
    bob.editor.view.dispatch(
      bob.editor.state.tr.insert(at(bob.editor, 'alpha'), ref(bob.editor, '1')),
    )
    expect(batches).toHaveLength(0)
    ;(bob.side as ReturnType<typeof memorySide>).set('footnote:1', { id: '1', text: 'bob' })
    // the reference and its entry are one batch for the engine
    expect(batches).toHaveLength(1)
    expect(batches[0].map((op) => op.kind)).toEqual(['steps', 'side'])

    carry(batches[0], bob, carol)
    bob.adapter.confirmed?.(batches[0])
    // Carol's list does not show Bob's note yet: her App counts 1 again
    const id = String(Math.max(0, ...lag.ids('footnote')) + 1)
    expect(id).toBe('1')
    carol.editor.view.dispatch(
      carol.editor.state.tr.insert(at(carol.editor, 'zeta'), ref(carol.editor, id)),
    )
    lag.add(`footnote:${id}`, { id, text: 'carol' })
    lag.render()
    lag.render()

    carry(fromCarol.splice(0), carol, bob)
    expect(noteRefs(bob.editor)).toEqual(['1', '2'])
    expect(noteRefs(carol.editor)).toEqual(['1', '2'])
    const notes = (entries: Map<string, Json>) =>
      [...entries].filter(([key]) => key.startsWith('footnote:')).sort()
    expect(notes(lag.read())).toEqual([
      ['footnote:1', { id: '1', text: 'bob' }],
      ['footnote:2', { id: '2', text: 'carol' }],
    ])
    expect(notes((bob.side as ReturnType<typeof memorySide>).all)).toEqual(notes(lag.read()))
    expect(await bob.adapter.fingerprint()).toBe(await carol.adapter.fingerprint())
  })
})

describe('outside state and a frozen editor', () => {
  it('holds outside-state changes made while frozen and sends them once released', () => {
    const alice = headlessPair()
    const sent = listening(alice)
    alice.adapter.setEditable(false)
    ;(alice.side as ReturnType<typeof memorySide>).set('section', { value: 7 })
    expect(sent).toHaveLength(0)
    alice.adapter.setEditable(true)
    expect(sent).toEqual([{ kind: 'side', key: 'section', value: { value: 7 } }])
  })

  it('finishes open drafts before it freezes, and reports an edit refused while frozen', () => {
    const alice: Pair = headlessPair({
      commitDrafts: () =>
        alice.editor.view.dispatch(
          alice.editor.state.tr.insertText('draft', at(alice.editor, 'alpha')),
        ),
    })
    const sent = listening(alice)
    alice.adapter.setEditable(false)
    expect(sent).toHaveLength(1)
    expect(alice.editor.state.doc.textContent).toContain('draft')
    const before = alice.editor.state.doc
    alice.editor.view.dispatch(alice.editor.state.tr.insertText('late', 1))
    expect(alice.editor.state.doc).toBe(before)
    expect(alice.refused).toEqual(['frozen'])
  })

  it('refuses an outside-state entry larger than one change may be', () => {
    const alice = headlessPair({ maxOpBytes: 1024 })
    const sent = listening(alice)
    const side = alice.side as ReturnType<typeof memorySide>
    side.set('watermark', { picture: 'x'.repeat(4096) })
    expect(sent).toHaveLength(0)
    expect(alice.refused).toEqual(['too_large'])
    // the App shows what it showed before the refused change
    expect(side.all.has('watermark')).toBe(false)
  })
})

describe('layout written over unconfirmed steps', () => {
  it('never re-applies a stale attribute set over a peer’s attribute change', async () => {
    const alice = headlessPair()
    const bob = headlessPair()
    const fromAlice = listening(alice)
    const fromBob = listening(bob)
    alice.editor.view.dispatch(alice.editor.state.tr.insertText('mine', at(alice.editor, 'zeta')))
    const local = fromAlice.splice(0)
    const pos = at(alice.editor, 'alpha') - 1
    const node = alice.editor.state.doc.nodeAt(pos)!
    // a pagination pass rewrites the whole attribute set, as applyTocPageDisplays does
    alice.editor.view.dispatch(
      alice.editor.state.tr
        .setNodeMarkup(pos, undefined, { ...node.attrs })
        .setMeta('layoutDerived', true),
    )
    const bobPos = at(bob.editor, 'alpha') - 1
    const bobNode = bob.editor.state.doc.nodeAt(bobPos)!
    bob.editor.view.dispatch(
      bob.editor.state.tr.setNodeMarkup(bobPos, undefined, { ...bobNode.attrs, caretMarks: '[]' }),
    )
    const peer = fromBob.splice(0)
    const rebased = carry(peer, bob, alice, local)
    bob.adapter.confirmed?.(peer)
    carry(rebased, alice, bob)
    alice.adapter.confirmed?.(rebased)
    expect(fromAlice).toHaveLength(0)
    expect(await bob.adapter.fingerprint()).toBe(await alice.adapter.fingerprint())
  })
})

describe('the track-changes recorder on a later editor', () => {
  it('records this user’s typing and never a peer’s, whatever editor number it has', () => {
    headlessPair()
    const alice = headlessPair()
    const bob = headlessPair()
    const fromBob = listening(bob)
    listening(alice)
    alice.editor.storage.trackChanges.enabled = true
    bob.editor.view.dispatch(bob.editor.state.tr.insertText('peer', at(bob.editor, 'alpha')))
    carry(fromBob.splice(0), bob, alice)
    alice.editor.view.dispatch(alice.editor.state.tr.insertText('mine', at(alice.editor, 'zeta')))
    const inserted: string[] = []
    alice.editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'ins'))
        inserted.push(node.text!)
    })
    expect(inserted.join('')).toContain('mine')
    expect(inserted.join('')).not.toContain('peer')
  })
})
