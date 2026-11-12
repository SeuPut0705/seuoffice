import { parseDocx, type SectionInfo } from '@seuoffice/docx-engine'
import { MAX_CHANGE_BYTES, type CollabAdapter } from '@seuoffice/collab/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import type { PendingNumbering } from '../src/renderer/doc-state'
import { allocateListNumId, type NumberingContext } from '../src/renderer/numbering-actions'
import { createDocsAdapter, type DocsOp } from '../src/web/collab-adapter'
import { docsSide } from '../src/web/collab-side'
import { fakeApp, type FakeApp } from './helpers/collab-app'

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

let content: unknown
const editors: Editor[] = []

beforeAll(async () => {
  const parsed = await parseDocx(
    await buildDocx({ bodyXml: para('alpha beta') + para('delta epsilon') + para('zeta eta') }),
  )
  content = blocksToPmDoc(parsed.blocks)
})

// the side store polls the App's fields on an interval: the tests move that clock
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  })
})

afterEach(() => {
  vi.useRealTimers()
  for (const editor of editors.splice(0)) editor.destroy()
})

/** one poll of the App by the side store, and the marker redraw that may follow it */
async function nextPoll(): Promise<void> {
  vi.advanceTimersByTime(250)
  await Promise.resolve()
}

interface Page {
  editor: Editor
  app: FakeApp
  adapter: CollabAdapter<DocsOp>
  /** the ops this page handed the engine, oldest first */
  sent: DocsOp[]
  numIdFloor: { current: number }
}

/** One person's page: a real editor, the App's state and the co-editing adapter over both */
function page(fields: Parameters<typeof fakeApp>[0] = {}): Page {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: content as never,
  })
  editors.push(editor)
  const app = fakeApp(fields)
  const adapter = createDocsAdapter({
    editor,
    side: docsSide({ editor, context: app.context }),
    produce: async () => ({ fileName: 'memo.docx', bytes: new Uint8Array() }),
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
  })
  const sent: DocsOp[] = []
  adapter.listen((ops) => sent.push(...ops))
  return { editor, app, adapter, sent, numIdFloor: { current: 0 } }
}

/** `to` takes `ops` from `from` over the wire, as confirmed changes it did not make */
const carry = (ops: DocsOp[], from: Page, to: Page, local: DocsOp[] = []): DocsOp[] =>
  to.adapter.integrate(
    ops.map((op) => to.adapter.decode(from.adapter.encode(op))),
    local,
  )

/**
 * Both pages made edits at the same moment; the server takes `first`'s, then
 * `second`'s rebased onto it, and each page hears the other's.
 */
async function exchange(first: Page, second: Page): Promise<void> {
  first.app.render()
  second.app.render()
  await nextPoll()
  const a = first.sent.splice(0)
  const b = second.sent.splice(0)
  const rebased = carry(a, first, second, b)
  first.adapter.confirmed?.(a)
  carry(rebased, second, first)
  second.adapter.confirmed?.(rebased)
  first.app.render()
  second.app.render()
  await nextPoll()
  expect(first.sent).toEqual([])
  expect(second.sent).toEqual([])
}

const sameState = async (a: Page, b: Page) =>
  expect(await a.adapter.fingerprint()).toBe(await b.adapter.fingerprint())

const numbering = (p: Page): NumberingContext => ({
  editor: p.editor,
  doc: p.app.context.current.doc,
  pendingNumbering: p.app.context.current.pendingNumbering,
  setPendingNumbering: p.app.context.current.setPendingNumbering as never,
  numIdFloorRef: p.numIdFloor,
  setStatus: () => {},
})

/** the paragraph holding `text` becomes a new list of `kind`, as the ribbon's list buttons make one */
function startList(p: Page, kind: 'bullet' | 'ordered', text: string): string {
  const numId = allocateListNumId(numbering(p), kind)!
  let pos = -1
  p.editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isTextblock && node.textContent.includes(text)) pos = at + 1
    return pos < 0
  })
  p.editor.chain().setTextSelection(pos).setNode('docListItem', { kind, numId, ilvl: 0 }).run()
  return numId
}

/** the marker each list item shows on screen, by its text */
function markers(p: Page): Record<string, string | null> {
  const shown: Record<string, string | null> = {}
  p.editor.state.doc.descendants((node, at) => {
    if (node.type.name !== 'docListItem') return true
    const dom = p.editor.view.nodeDOM(at) as HTMLElement | null
    shown[node.textContent] = dom?.getAttribute('data-marker') ?? null
    return false
  })
  return shown
}

const kinds = (p: Page) => {
  const pending = p.app.context.current.pendingNumbering as PendingNumbering
  return Object.fromEntries(pending.newDefs.map((def) => [def.numId, def.kind]))
}

describe('two people starting a list at the same moment', () => {
  it('keeps each list its own kind on both pages', async () => {
    const alice = page()
    const bob = page()
    const bullet = startList(alice, 'bullet', 'alpha')
    const numbered = startList(bob, 'ordered', 'zeta')
    // both counted the same definitions, so both took the same id
    expect(numbered).toBe(bullet)
    alice.app.render()
    await nextPoll()
    // the definition goes out in the same change as the step that starts the list
    expect(alice.sent.map((op) => op.kind)).toEqual(['steps', 'side'])

    await exchange(alice, bob)
    for (const p of [alice, bob]) {
      const shown = markers(p)
      expect(shown['alpha beta']).toBe('•')
      expect(shown['zeta eta']).toBe('1.')
      expect(Object.values(kinds(p)).sort()).toEqual(['bullet', 'ordered'])
    }
    expect(kinds(alice)).toEqual(kinds(bob))
    await sameState(alice, bob)
  })

  it('renumbers a list whose step still waits for its definition when the peer’s arrives', async () => {
    const alice = page()
    const bob = page()
    startList(alice, 'bullet', 'alpha')
    alice.app.render()
    await nextPoll()
    const fromAlice = alice.sent.splice(0)
    // Bob's App has not listed his definition yet: his step waits for it
    startList(bob, 'ordered', 'zeta')
    expect(bob.sent).toEqual([])
    carry(fromAlice, alice, bob)
    alice.adapter.confirmed?.(fromAlice)
    bob.app.render()
    await nextPoll()
    const fromBob = bob.sent.splice(0)
    expect(fromBob.map((op) => op.kind)).toEqual(['steps', 'side'])
    carry(fromBob, bob, alice)
    bob.adapter.confirmed?.(fromBob)
    alice.app.render()
    bob.app.render()
    await nextPoll()
    for (const p of [alice, bob]) {
      expect(markers(p)).toEqual({ 'alpha beta': '•', 'zeta eta': '1.' })
    }
    expect(kinds(alice)).toEqual(kinds(bob))
    await sameState(alice, bob)
  })

  it('shows the marker of a list a peer started', async () => {
    const alice = page()
    const bob = page()
    startList(alice, 'ordered', 'delta')
    await exchange(alice, bob)
    expect(markers(bob)).toEqual({ 'delta epsilon': '1.' })
    await sameState(alice, bob)
  })
})

const style = (name: string, size: number) => ({ styleId: name, rPr: { sizeHalfPoints: size } })
const hf = (text: string) => ({ text, hasPageNumber: false, paras: [] })

describe('records two people change entry by entry', () => {
  it('keeps both of two styles changed at once, and one value for a style both changed', async () => {
    const alice = page()
    const bob = page()
    alice.app.set('styleUpserts', (prev: object) => ({ ...prev, Heading1: style('Heading1', 40) }))
    bob.app.set('styleUpserts', (prev: object) => ({ ...prev, Heading2: style('Heading2', 32) }))
    await exchange(alice, bob)
    for (const p of [alice, bob]) {
      expect(p.app.context.current.styleUpserts).toEqual({
        Heading1: style('Heading1', 40),
        Heading2: style('Heading2', 32),
      })
    }
    await sameState(alice, bob)

    alice.app.set('styleUpserts', (prev: object) => ({ ...prev, Heading1: style('Heading1', 44) }))
    bob.app.set('styleUpserts', (prev: object) => ({ ...prev, Heading1: style('Heading1', 48) }))
    await exchange(alice, bob)
    expect(alice.app.context.current.styleUpserts).toEqual(bob.app.context.current.styleUpserts)
    expect(bob.app.context.current.styleUpserts.Heading1).toEqual(style('Heading1', 48))
    await sameState(alice, bob)
  })

  it('keeps both of two section headers changed at once, and one value for a header both changed', async () => {
    const alice = page()
    const bob = page()
    alice.app.set('sectionHfEdits', (prev: object) => ({ ...prev, '4:header': hf('alice') }))
    bob.app.set('sectionHfEdits', (prev: object) => ({ ...prev, '9:footer': hf('bob') }))
    await exchange(alice, bob)
    for (const p of [alice, bob]) {
      expect(p.app.context.current.sectionHfEdits).toEqual({
        '4:header': hf('alice'),
        '9:footer': hf('bob'),
      })
    }
    await sameState(alice, bob)

    alice.app.set('sectionHfEdits', (prev: object) => ({ ...prev, '4:header': hf('alice 2') }))
    bob.app.set('sectionHfEdits', (prev: object) => ({ ...prev, '4:header': hf('bob 2') }))
    await exchange(alice, bob)
    expect(alice.app.context.current.sectionHfEdits).toEqual(bob.app.context.current.sectionHfEdits)
    expect(bob.app.context.current.sectionHfEdits['4:header']).toEqual(hf('bob 2'))
    await sameState(alice, bob)
  })
})

const section = (lastBlockIndex: number, firstBlockIndex: number): SectionInfo =>
  ({
    settings: { orientation: 'portrait', pageWidth: 11906, pageHeight: 16838 },
    startType: 'nextPage',
    firstBlockIndex,
    lastBlockIndex,
    sectPrXml: `<w:sectPr w:id="${lastBlockIndex}"/>`,
    titlePg: false,
    headerRefs: {},
    footerRefs: {},
  }) as unknown as SectionInfo

/** three sections: blocks 0, 1 and 2, each ending in its own break */
const threeSections = () => ({ sections: [section(0, 0), section(1, 1), section(2, 2)] })

/** turn section `index` landscape, as the Layout tab does for a section that is not the last */
function landscape(p: Page, index: number, width = 16838): void {
  p.app.set('sections', (prev: SectionInfo[]) =>
    prev.map((s, i) =>
      i === index
        ? { ...s, settings: { ...s.settings, orientation: 'landscape', pageWidth: width } }
        : s,
    ),
  )
  p.app.set('sectionsDirty', (prev: number[]) => (prev.includes(index) ? prev : [...prev, index]))
}

const orientations = (p: Page) =>
  (p.app.context.current.sections as SectionInfo[]).map((s) => s.settings.orientation)

describe('page setup of different sections changed at once', () => {
  it('keeps both changes', async () => {
    const alice = page(threeSections())
    const bob = page(threeSections())
    landscape(alice, 0)
    landscape(bob, 1)
    await exchange(alice, bob)
    for (const p of [alice, bob]) {
      expect(orientations(p)).toEqual(['landscape', 'landscape', 'portrait'])
      expect([...p.app.context.current.sectionsDirty].sort()).toEqual([0, 1])
    }
    await sameState(alice, bob)
  })

  it('keeps one value for a section both changed', async () => {
    const alice = page(threeSections())
    const bob = page(threeSections())
    landscape(alice, 1, 15000)
    landscape(bob, 1, 16000)
    await exchange(alice, bob)
    for (const p of [alice, bob]) {
      const sections = p.app.context.current.sections as SectionInfo[]
      expect(sections.map((s) => s.settings.pageWidth)).toEqual([11906, 16000, 11906])
    }
    await sameState(alice, bob)
  })

  it('drops a change to a section a peer removed', async () => {
    const alice = page(threeSections())
    const bob = page(threeSections())
    alice.app.set('sections', (prev: SectionInfo[]) => prev.filter((_, i) => i !== 1))
    landscape(bob, 1)
    await exchange(alice, bob)
    for (const p of [alice, bob]) {
      expect(
        (p.app.context.current.sections as SectionInfo[]).map((s) => s.lastBlockIndex),
      ).toEqual([0, 2])
      expect(orientations(p)).toEqual(['portrait', 'portrait'])
      expect(p.app.context.current.sectionsDirty).toEqual([])
    }
    await sameState(alice, bob)
  })
})
