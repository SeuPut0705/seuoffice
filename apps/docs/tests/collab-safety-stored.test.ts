import type { Json } from '@seuoffice/collab/client'
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { afterEach, describe, expect, it } from 'vitest'
import { carry, collabPage, openedBody, type CollabPage } from './helpers/collab-page'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

async function pages(bodyXml: string): Promise<[CollabPage, CollabPage]> {
  const content = await openedBody(bodyXml)
  const alice = collabPage(content)
  const bob = collabPage(content)
  editors.push(alice.editor, bob.editor)
  return [alice, bob]
}

/** the first node of `type`, and where it starts */
function first(editor: Editor, type: string): { node: PmNode; pos: number } {
  let found: { node: PmNode; pos: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === type) found = { node, pos }
    return !found
  })
  if (!found) throw new Error(`no ${type} in the document`)
  return found
}

/** the whole body pasted over itself */
function pasteBody({ editor }: CollabPage): void {
  const { doc, tr } = editor.state
  editor.view.dispatch(tr.replaceWith(0, doc.content.size, doc.content))
}

/** both pages hold the same document after `from`'s edits reach `to` */
function agree(from: CollabPage, to: CollabPage): void {
  carry(from.sent.splice(0), from, to)
  expect(to.editor.state.doc.toJSON()).toEqual(from.editor.state.doc.toJSON())
}

/** a table whose only cell holds `inner` in a table of its own */
const nestedTable = (inner: string): string =>
  '<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid>' +
  '<w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr><w:tblW w:w="3000" w:type="dxa"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
  `<w:tr><w:tc>${inner}</w:tc></w:tr>` +
  '</w:tbl><w:p/></w:tc></w:tr>' +
  '</w:tbl><w:p><w:r><w:t>after</w:t></w:r></w:p>'

describe('text whose formatting change is tracked', () => {
  // the reviewer's case: the run was italic and red before a tracked change made it bold
  const OLD_FORMAT = '<w:i/><w:color w:val="FF0000"/>'
  const TRACKED_FORMAT =
    '<w:p><w:r><w:rPr><w:b/>' +
    '<w:rPrChange w:id="7" w:author="Kim" w:date="2026-01-05T09:00:00Z">' +
    `<w:rPr>${OLD_FORMAT}</w:rPr></w:rPrChange></w:rPr>` +
    '<w:t xml:space="preserve">alpha beta</w:t></w:r></w:p>'

  it('takes a typed letter and a paste of the body, and the peer gets both', async () => {
    const [alice, bob] = await pages(TRACKED_FORMAT)
    const mark = first(alice.editor, 'text').node.marks.find((m) => m.type.name === 'rprChange')
    // the document really carries the old formatting's XML
    expect(mark?.attrs.oldRPr).toBe(OLD_FORMAT)

    alice.editor.view.dispatch(alice.editor.state.tr.insertText('x', 3))
    expect(alice.refused).toEqual([])
    expect(alice.sent).toHaveLength(1)
    agree(alice, bob)

    pasteBody(alice)
    expect(alice.refused).toEqual([])
    expect(alice.sent).toHaveLength(1)
    agree(alice, bob)
    expect(bob.editor.state.doc.textContent).toBe('alxpha beta')
  })

  it('inside a nested table can be pasted with its table', async () => {
    const [alice, bob] = await pages(nestedTable(TRACKED_FORMAT))
    const model = JSON.stringify(first(alice.editor, 'docNestedTable').node.attrs.model)
    expect(model).toContain(JSON.stringify({ oldRPr: OLD_FORMAT }).slice(1, -1))

    pasteBody(alice)
    expect(alice.refused).toEqual([])
    expect(alice.sent).toHaveLength(1)
    agree(alice, bob)
  })

  it('in a header does not stop the header from being edited', async () => {
    const [alice, bob] = await pages('<w:p><w:r><w:t>body</w:t></w:r></w:p>')
    // a header paragraph as the engine reads one: its run keeps the record of the change
    const header = {
      header: {
        text: 'Title',
        paras: [
          {
            runs: [
              {
                text: 'Title',
                bold: true,
                rPrChange: { author: 'Kim', old: { italic: true }, oldRPr: OLD_FORMAT },
              },
            ],
          },
        ],
      },
      headerDirty: true,
    }
    alice.set('header', header)
    expect(alice.refused).toEqual([])
    expect(alice.sent).toEqual([{ kind: 'side', key: 'header', value: header }])
    carry(alice.sent.splice(0), alice, bob)
    expect(bob.entries().get('header')).toEqual(header)
  })
})

describe('a vertically merged table whose hidden cell holds text', () => {
  // the merged-away cell of row 2 keeps its own words: a quote, a semicolon and a line break
  const MERGED_TABLE =
    '<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
    '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>' +
    '<w:p><w:r><w:t xml:space="preserve">it\'s here; </w:t><w:br/><w:t>next line</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>' +
    '</w:tbl><w:p><w:r><w:t>after</w:t></w:r></w:p>'

  it('can be pasted and have its properties changed, and the peer gets both', async () => {
    const [alice, bob] = await pages(MERGED_TABLE)
    const table = first(alice.editor, 'docTable')
    // the hidden cell's words ride on the table for the save
    const hidden = String(table.node.attrs.continuationCells)
    expect(hidden).toContain("it's here; ")
    expect(hidden).toContain('\\n')

    // a copy of the table pasted after it
    alice.editor.view.dispatch(
      alice.editor.state.tr.insert(table.pos + table.node.nodeSize, table.node),
    )
    expect(alice.refused).toEqual([])
    expect(alice.sent).toHaveLength(1)
    agree(alice, bob)

    // Table Properties: centre the table
    alice.editor.view.dispatch(
      alice.editor.state.tr.setNodeMarkup(table.pos, undefined, {
        ...table.node.attrs,
        tblAlign: 'center',
      }),
    )
    expect(alice.refused).toEqual([])
    expect(alice.sent).toHaveLength(1)
    agree(alice, bob)
    expect(first(bob.editor, 'docTable').node.attrs.tblAlign).toBe('center')
  })
})

describe('a table inside a table cell whose text holds a quote and a semicolon', () => {
  const NESTED_TABLE = nestedTable(
    '<w:p><w:r><w:t xml:space="preserve">O\'Brien; "Q3" &lt;draft&gt;</w:t></w:r></w:p>',
  )

  it('can be pasted with its outer table, and the peer gets it', async () => {
    const [alice, bob] = await pages(NESTED_TABLE)
    const nested = first(alice.editor, 'docNestedTable')
    expect(JSON.stringify(nested.node.attrs.model)).toContain("O'Brien; ")

    pasteBody(alice)
    expect(alice.refused).toEqual([])
    expect(alice.sent).toHaveLength(1)
    agree(alice, bob)
    // the receiver draws the inner cell's words as the sender does
    expect(bob.editor.view.dom.textContent).toContain('O\'Brien; "Q3" <draft>')
    expect(bob.editor.view.dom.querySelector('draft')).toBeNull()
  })

  it('shows markup a peer puts in a cell’s text as the letters it is made of', async () => {
    const [alice, bob] = await pages(NESTED_TABLE)
    const nested = first(alice.editor, 'docNestedTable')
    const markup = '<img src="x" onerror="alert(1)"><style>body{display:none}</style>'
    // a forged step: the cell holds only plain paragraph texts, one of them markup
    const model = JSON.parse(JSON.stringify(nested.node.attrs.model)) as {
      rows: { paras: string[]; richParas?: unknown }[][]
    }
    model.rows[0][0] = { paras: [markup] }
    const forged = new Transform(alice.editor.state.doc).setNodeAttribute(
      nested.pos,
      'model',
      model,
    ).steps[0]
    bob.adapter.integrate(
      [bob.adapter.decode({ kind: 'steps', steps: [forged.toJSON() as Json] })],
      [],
    )
    const dom = bob.editor.view.dom
    expect(dom.textContent).toContain(markup)
    expect(dom.querySelector('img, style')).toBeNull()
  })
})
