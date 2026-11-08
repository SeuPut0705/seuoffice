/**
 * "Add to note" (reading-assist spec 4.9), the editor side: the text lands
 * at the end of the document as new blocks after a blank line, the blocks
 * that were there save byte for byte, and an empty document takes the text
 * without a stray empty paragraph in front.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { buildSourceMap, spliceMarkdown } from '../src/renderer/markdown/sourceSplice'
import { appendMarkdownAtEnd } from '../src/renderer/note-append'

const editors: Editor[] = []
afterAll(() => {
  for (const e of editors) e.destroy()
})

function createEditor(): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return editor
}

const INSERT = '> The key line ([p.3](a%20b.pdf#page=3))\n\nMy memo'

describe('appendMarkdownAtEnd', () => {
  it('puts the text after the last block, separated by a blank line, and changes the document', () => {
    const editor = createEditor()
    const source = '# Paper\n\nSome *old* notes\n'
    editor.commands.setContent(source, { contentType: 'markdown' })
    const map = buildSourceMap(editor, editor.state.doc, source)
    expect(map).not.toBeNull()
    let updates = 0
    editor.on('update', () => updates++)
    expect(appendMarkdownAtEnd(editor, INSERT)).toBe(true)
    expect(updates).toBeGreaterThan(0)
    const saved = spliceMarkdown(editor, editor.state.doc, map!)
    expect(saved.startsWith('# Paper\n\nSome *old* notes\n\n')).toBe(true)
    expect(saved).toContain('> The key line ([p.3](a%20b.pdf#page=3))\n\nMy memo')
    const types: string[] = []
    editor.state.doc.forEach((node) => types.push(node.type.name))
    expect(types).toEqual(['heading', 'paragraph', 'blockquote', 'paragraph'])
  })

  it('fills an empty document without a leading empty paragraph', () => {
    const editor = createEditor()
    expect(appendMarkdownAtEnd(editor, INSERT)).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe('blockquote')
  })

  it('takes nothing for blank text', () => {
    const editor = createEditor()
    editor.commands.setContent('# A\n', { contentType: 'markdown' })
    const before = editor.state.doc.toJSON()
    expect(appendMarkdownAtEnd(editor, '  \n')).toBe(false)
    expect(editor.state.doc.toJSON()).toEqual(before)
  })
})
