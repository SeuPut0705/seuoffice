import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
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
