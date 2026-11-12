import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx } from '@seuoffice/docx-engine'
import { editorExtensions } from '../../docs/src/renderer/editor/extensions'
import { blocksToPmDoc } from '../../docs/src/renderer/editor/convert'
import { buildDocumentContext } from '../../docs/src/renderer/ai/protocol'
import { modelTextOf } from '../../docs/src/renderer/ai/redact-view'
import { exportDocxBytes } from '../src/renderer/export/docxExport'

/**
 * A .docx exported by the Markdown app holds each hidden span under the mark the
 * Docs app writes: opened in Docs, the model reads its placeholder, the person
 * keeps the words, and the label is the one that was given.
 */

const SECRET = '13800138000'
const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

describe('a Word export of a Markdown document with a hidden span, opened in Docs', () => {
  it('reads as its placeholder to the model, and keeps the words and the label', async () => {
    const bytes = await exportDocxBytes(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Call ' },
              {
                type: 'text',
                text: SECRET,
                marks: [{ type: 'redaction', attrs: { label: 'client phone' } }],
              },
            ],
          },
        ],
      },
      async () => null,
    )
    const parsed = await parseDocx(bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editors.add(editor)
    expect(modelTextOf(editor.state.doc.toJSON())).toContain('Call {{client phone}}')
    expect(modelTextOf(editor.state.doc.toJSON())).not.toContain(SECRET)
    expect(buildDocumentContext(editor)).not.toContain(SECRET)
    expect(buildDocumentContext(editor)).toContain('{{client phone}}')
    // the person's own view still has the words
    expect(editor.state.doc.textContent).toContain(SECRET)
    const marks: string[] = []
    editor.state.doc.descendants((node) => {
      for (const m of node.marks) if (m.type.name === 'redaction') marks.push(String(m.attrs.label))
    })
    expect(marks).toEqual(['client phone'])
  })
})
