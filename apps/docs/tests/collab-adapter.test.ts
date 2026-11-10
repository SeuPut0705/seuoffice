import { parseDocx } from '@genoffice/docx-engine'
import type { Json } from '@seuoffice/collab/client'
import { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { canJoin } from '@tiptap/pm/transform'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
// the kit from its source: this package's vitest config has no seuoffice-source condition
import { simulate, type SimulatedEditor } from '../../../packages/collab/src/conformance/index'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsAdapter, type DocsOp, type SideStore } from '../src/web/collab-adapter'

const FORMAT = { name: 'docx', schema: 1 }

const para = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
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
function memorySide(initial: [string, Json][]): SideStore & { set(key: string, value: Json): void } {
  let entries = new Map(initial)
  let changed: (() => void) | null = null
  return {
    read: () => new Map(entries),
    write: (next) => {
      entries = new Map(next)
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
type Kind = 'typeFirst' | 'removeFirst' | 'insert' | 'remove' | 'split' | 'join' | 'span' | 'row' | 'side'

/** text every simulated insert put in, by tag */
const typed = new Set<string>()
let last: Editor | null = null

const opener =
  (only: readonly Kind[]) =>
  (bytes: Uint8Array): SimulatedEditor<TaggedOp> => openHeadless(bytes, only)

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
  const inner = createDocsAdapter({
    editor,
    side,
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
        if (node.type.name === 'docTableRow') rows.push({ pos, node, count: parent?.childCount ?? 0 })
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

const SEEDS = [1, 2, 3, 4]

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
  for (const seed of [11, 12, 14, 16, 17, 18, 19, 20]) {
    it(`converges on every edit kind at once (seed ${seed})`, async () => {
      const all: Kind[] = ['typeFirst', 'removeFirst', 'insert', 'remove', 'split', 'join', 'span', 'row', 'side']
      expect((await run(all, seed, 4)).ops).toBeGreaterThan(20)
    }, 120_000)
  }
})
