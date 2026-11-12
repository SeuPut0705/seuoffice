import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type HeaderFooter } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { buildCommentsContext } from '../src/renderer/ai/protocol'
import { executeTool } from '../src/renderer/ai/tools'
import { hfModelText } from '../src/renderer/editor/hf-text'
import {
  hiddenStoriesDocx,
  MARK_SPELLINGS,
  NAMESPACES,
  PLACEHOLDER,
  SECRET,
} from '../../../packages/cli/tests/hidden-text-fixtures'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

function createEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text: 'Body text' }],
        },
      ],
    },
  })
  editors.add(editor)
  return editor
}

const NUM_IDS = { bullet: null, ordered: null }

describe("the app's AI readers: header, footer, comment and note text hidden from AI", () => {
  it.each(
    NAMESPACES.flatMap(([name, ns]) => MARK_SPELLINGS.map((spelling) => [name, ns, spelling])),
  )('read as the placeholder under %s (%s), the mark spelled %s', async (_n, ns, spelling) => {
    const file = await hiddenStoriesDocx(
      mkdtempSync(join(tmpdir(), 'ai-hidden-stories-')),
      ns!,
      'stories.docx',
      spelling as (typeof MARK_SPELLINGS)[number],
    )
    const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
    const editor = createEditor()

    const header: HeaderFooter = { text: parsed.headerText ?? '', paras: parsed.headerParas! }
    const footer: HeaderFooter = { text: parsed.footerText ?? '', paras: parsed.footerParas! }
    expect(hfModelText(header)).toBe(`Head ${PLACEHOLDER}`)
    expect(hfModelText(footer)).toBe(`Foot ${PLACEHOLDER}`)

    const context = buildCommentsContext(editor, parsed.comments)
    expect(context).toContain(`Note: ${PLACEHOLDER}`)
    expect(context).not.toContain(SECRET)

    const comments = await executeTool(
      editor,
      { id: 'c', name: 'read_comments', input: {} },
      NUM_IDS,
      undefined,
      undefined,
      undefined,
      { list: () => parsed.comments, reply: () => false, resolve: () => false },
    )
    expect(comments.output).toContain(`Note: ${PLACEHOLDER}`)
    expect(comments.output).not.toContain(SECRET)

    const notes = await executeTool(
      editor,
      { id: 'n', name: 'read_notes', input: {} },
      NUM_IDS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        list: (kind) => (kind === 'footnote' ? parsed.footnotes : parsed.endnotes),
        add: () => '',
        remove: () => false,
        replace: () => false,
      },
    )
    expect(notes.output).toContain(`See ${PLACEHOLDER}`)
    expect(notes.output).not.toContain(SECRET)
  })
})
