import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type CommentInfo } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { executeTool, type AiCommentsAccess } from '../src/renderer/ai/tools'
import type { AiNotesAccess } from '../src/renderer/ai/note-ops'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  hiddenStoriesDocx,
  LABEL,
  OWN_REDACT_NS,
  SECRET,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

/**
 * A model may not remove what a person hid from it: no tool deletes a note,
 * a comment, a block, a table row or column, a tracked change or the mark
 * itself when that would take hidden content with it. A refused call leaves
 * the editor and the notes and comments beside it exactly as they were.
 */

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

const NUM_IDS = { bullet: null, ordered: null }
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const REV = 'w:author="Ann" w:date="2026-09-29T12:23:00Z"'
const hiddenRun = (text: string) =>
  `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${LABEL}"/></w:rPr><w:t>${text}</w:t></w:r>`
const plainRun = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const cell = (runs: string) => `<w:tc><w:p>${runs}</w:p></w:tc>`

function editorOf(blocks: Parameters<typeof blocksToPmDoc>[0]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(blocks),
  })
  editors.add(editor)
  return editor
}

async function openStories() {
  const file = await hiddenStoriesDocx(
    mkdtempSync(join(tmpdir(), 'ai-destructive-')),
    OWN_REDACT_NS,
  )
  const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
  return { parsed, editor: editorOf(parsed.blocks) }
}

async function openBody(
  bodyXml: string,
  extraParts: Parameters<typeof buildDocx>[0]['extraParts'] = [],
  extraRels = '',
) {
  const parsed = await parseDocx(await buildDocx({ bodyXml, extraParts, extraRels }))
  return { parsed, editor: editorOf(parsed.blocks) }
}

/** the notes beside the editor, recording every change asked of them */
function notesOf(parsed: Awaited<ReturnType<typeof openStories>>['parsed']) {
  const removed: string[] = []
  const replaced: string[] = []
  const access: AiNotesAccess = {
    list: (kind) => (kind === 'footnote' ? parsed.footnotes : parsed.endnotes),
    add: () => '',
    remove: (_kind, id) => (removed.push(id), true),
    replace: (_kind, id) => (replaced.push(id), true),
  }
  return { access, removed, replaced }
}

function commentsOf(list: CommentInfo[]) {
  const removed: string[] = []
  const access: AiCommentsAccess = {
    list: () => list,
    reply: () => false,
    resolve: () => false,
    remove: (id) => (removed.push(id), true),
  }
  return { access, removed }
}

const run = (
  editor: Editor,
  name: string,
  input: Record<string, unknown>,
  more: { comments?: AiCommentsAccess; notes?: AiNotesAccess } = {},
) =>
  Promise.resolve(
    executeTool(
      editor,
      { id: name, name, input },
      NUM_IDS,
      undefined,
      undefined,
      undefined,
      more.comments,
      undefined,
      undefined,
      undefined,
      undefined,
      more.notes,
    ),
  )

describe('a note that holds hidden content', () => {
  it('is not deleted, and the refusal reads as an edit refusal does', async () => {
    const { parsed, editor } = await openStories()
    const before = editor.getJSON()
    const notes = notesOf(parsed)
    const edit = await run(
      editor,
      'edit_note',
      { id: '1', kind: 'footnote', find: 'See', replace: 'x' },
      { notes: notes.access },
    )
    const del = await run(
      editor,
      'delete_note',
      { id: '1', kind: 'footnote' },
      { notes: notes.access },
    )
    expect(del.isError).toBe(true)
    expect(del.output).toBe(edit.output)
    expect(notes.removed).toEqual([])
    expect(editor.getJSON()).toEqual(before)
  })
})

describe('a note whose reference the editor refuses to remove', () => {
  it('stays in the notes when the reference stays in the text', async () => {
    const locked =
      '<w:sdt><w:sdtPr><w:lock w:val="contentLocked"/><w:tag w:val="ref"/></w:sdtPr><w:sdtContent>' +
      plainRun('Cited') +
      '<w:r><w:footnoteReference w:id="2"/></w:r></w:sdtContent></w:sdt>'
    const { parsed, editor } = await openBody(
      `<w:p>${plainRun('Body ')}${locked}</w:p>`,
      [
        {
          path: 'word/footnotes.xml',
          xml:
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}>` +
            '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
            '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
            `<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r>${plainRun(' Plain note')}</w:p></w:footnote></w:footnotes>`,
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        },
      ],
      '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
    )
    const before = editor.getJSON()
    const notes = notesOf(parsed)
    const del = await run(
      editor,
      'delete_note',
      { id: '2', kind: 'footnote' },
      { notes: notes.access },
    )
    expect(del.isError).toBe(true)
    expect(notes.removed).toEqual([])
    expect(editor.getJSON()).toEqual(before)
  })
})

describe('a comment that holds hidden content', () => {
  it('is not deleted', async () => {
    const { parsed, editor } = await openStories()
    const comments = commentsOf(parsed.comments)
    const del = await run(editor, 'delete_comment', { id: '1' }, { comments: comments.access })
    expect(del.isError).toBe(true)
    expect(comments.removed).toEqual([])
  })

  it('is not deleted as a reply in a thread deleted whole', async () => {
    const { parsed, editor } = await openStories()
    const hidden = parsed.comments[0]!
    const list: CommentInfo[] = [
      { ...hidden, id: '5', text: 'Plain', modelText: undefined, parentId: undefined },
      { ...hidden, id: '6', parentId: '5' },
    ]
    const comments = commentsOf(list)
    const del = await run(
      editor,
      'delete_comment',
      { id: '5', withReplies: true },
      { comments: comments.access },
    )
    expect(del.isError).toBe(true)
    expect(comments.removed).toEqual([])
  })
})

describe('body edits that would remove hidden content', () => {
  const hiddenPara = `<w:p>${plainRun('Call ')}${hiddenRun(SECRET)}${plainRun(' now')}</w:p>`
  const plainPara = `<w:p>${plainRun('Plain paragraph')}</w:p>`
  const table =
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
    `<w:tr>${cell(plainRun('A1'))}${cell(plainRun('B1'))}</w:tr>` +
    `<w:tr>${cell(plainRun('A2'))}${cell(hiddenRun(SECRET))}</w:tr></w:tbl>`

  const cases: Array<{ name: string; tool: string; input: Record<string, unknown> }> = [
    {
      name: 'deleteBlocks',
      tool: 'apply_ops',
      input: { ops: [{ op: 'deleteBlocks', target: { blockIndexes: [0] } }] },
    },
    {
      name: 'replace_blocks',
      tool: 'replace_blocks',
      input: { startBlockIndex: 0, endBlockIndex: 0, html: '<p>New text</p>' },
    },
    {
      name: 'findReplace over the whole paragraph',
      tool: 'apply_ops',
      input: {
        ops: [{ op: 'findReplace', target: { blockIndexes: [0] }, find: 'Call', replace: '' }],
      },
    },
    {
      name: 'deleteTableRow',
      tool: 'apply_ops',
      input: { ops: [{ op: 'deleteTableRow', target: { blockIndexes: [2] }, row: 1 }] },
    },
    {
      name: 'deleteTableColumn',
      tool: 'apply_ops',
      input: { ops: [{ op: 'deleteTableColumn', target: { blockIndexes: [2] }, col: 1 }] },
    },
    {
      name: 'setFont clearing every field',
      tool: 'apply_ops',
      input: {
        ops: [
          {
            op: 'setFont',
            target: { blockIndexes: [0] },
            bold: null,
            italic: null,
            underline: null,
            color: null,
            highlight: null,
            fontSize: null,
            fontFamily: null,
          },
        ],
      },
    },
  ]

  it.each(cases)('$name keeps the hidden words and their mark', async ({ tool, input }) => {
    const { editor } = await openBody(`${hiddenPara}${plainPara}${table}<w:p/>`)
    const marked = () => {
      const hidden: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === 'redaction'))
          hidden.push(node.text!)
      })
      return hidden.join('|')
    }
    expect(marked()).toBe(`${SECRET}|${SECRET}`)
    await run(editor, tool, input)
    expect(marked()).toBe(`${SECRET}|${SECRET}`)
  })

  it('accepting every change leaves a hidden deletion in place', async () => {
    const { editor } = await openBody(
      `<w:p>${plainRun('Call ')}<w:del w:id="3" ${REV}><w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${LABEL}"/></w:rPr><w:delText>${SECRET}</w:delText></w:r></w:del>` +
        `<w:ins w:id="4" ${REV}>${plainRun(' later')}</w:ins></w:p>`,
    )
    await run(editor, 'accept_changes', { all: true })
    expect(editor.state.doc.textContent).toContain(SECRET)
    await run(editor, 'reject_changes', { all: true })
    expect(editor.state.doc.textContent).toContain(SECRET)
  })

  it('clear formatting keeps the mark', async () => {
    const { editor } = await openBody(hiddenPara)
    editor.commands.selectAll()
    editor.commands.unsetAllMarks()
    let marked = false
    editor.state.doc.descendants((node) => {
      if (node.marks.some((m) => m.type.name === 'redaction')) marked = true
    })
    expect(marked).toBe(true)
  })

  it('a plain block is still deleted', async () => {
    const { editor } = await openBody(`${hiddenPara}${plainPara}`)
    const done = await run(editor, 'apply_ops', {
      ops: [{ op: 'deleteBlocks', target: { blockIndexes: [1] } }],
    })
    expect(done.isError).toBeFalsy()
    expect(editor.state.doc.textContent).not.toContain('Plain paragraph')
  })
})

describe('a chart block hidden from AI', () => {
  it('is not edited, and the answer quotes none of its data', async () => {
    const chartDisplay = {
      partPath: 'word/charts/chart1.xml',
      kind: 'bar',
      title: `Calls to ${SECRET}`,
      categories: ['Q1', 'Q2'],
      series: [{ name: 'Calls', values: [3, 4] }],
    }
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docProtected',
            attrs: { blockType: 'passthrough', label: 'Chart', chartDisplay, redact: LABEL },
          },
          { type: 'docParagraph', content: [{ type: 'text', text: 'After' }] },
        ],
      },
    })
    editors.add(editor)
    const before = editor.getJSON()
    const done = await run(editor, 'edit_chart', {
      blockIndex: 0,
      series: [{ index: 0, values: [5, 6] }],
    })
    expect(done.isError).toBe(true)
    expect(done.output).not.toContain(SECRET)
    expect(done.output).not.toContain('Calls')
    expect(editor.getJSON()).toEqual(before)
  })
})
