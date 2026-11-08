/**
 * "Add to note" from the PDF editor (reading-assist spec 4.9), the editor
 * side: the text goes at the end of the document as new blocks (a blank line
 * apart from what was there when saved) through an ordinary, undoable edit, so
 * the tab shows it as changed. The file is not written; the person saves.
 */
import type { Editor } from '@tiptap/core'

/** append Markdown text after the last block; false when there is nothing to add */
export function appendMarkdownAtEnd(editor: Editor, text: string): boolean {
  const markdown = text.trim()
  if (!markdown) return false
  const { doc } = editor.state
  const end = doc.content.size
  const last = doc.lastChild
  // an empty last paragraph (an empty document, a trailing blank line) is replaced
  const emptyTail = !!last && last.type.name === 'paragraph' && last.content.size === 0
  const from = emptyTail && last ? end - last.nodeSize : end
  return editor
    .chain()
    .insertContentAt({ from, to: end }, markdown, { contentType: 'markdown' })
    .run()
}

/** the texts one take hands over, as one insert in their order */
export function joinNoteAppends(texts: readonly string[]): string {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n')
}
