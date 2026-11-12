import { Editor } from '@tiptap/core'
import { parseDocx } from '@genoffice/docx-engine'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { takeOdtRefusal } from '../src/renderer/odt-gate'

/**
 * Where the caret is after an edit a locked control refused. The browser
 * reports a click's caret a moment after the click, so a key typed at once
 * reaches the editor as one change: the caret moved into the control and a
 * character typed there. Refusing the character must not refuse the move:
 * otherwise the caret falls back to where it was before the click, and the
 * next text typed lands there as a real edit (found on Windows: the document
 * then asked to be saved on close).
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const LOCKED =
  '<w:sdt><w:sdtPr><w:tag w:val="Code"/><w:id w:val="7"/><w:lock w:val="contentLocked"/></w:sdtPr>' +
  `<w:sdtContent>${run('A-1')}</w:sdtContent></w:sdt>`

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  takeOdtRefusal()
})

async function load(): Promise<Editor> {
  const parsed = await parseDocx(
    await buildDocx({ bodyXml: `<w:p>${run('Code: ')}${LOCKED}${run(' end')}</w:p>` }),
  )
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  return editor
}

/**
 * `text` typed at `at` as the editor reads it from the page: handed to the
 * text-input handlers first, then, if none takes it, applied with the caret
 * after it (ProseMirror's own reading of a typed character)
 */
function typedOnThePage(editor: Editor, at: number, text: string): void {
  const { view } = editor
  const deflt = () => {
    const tr = view.state.tr.insertText(text, at)
    return tr.setSelection(TextSelection.create(tr.doc, at + text.length))
  }
  const handled = view.someProp('handleTextInput', (f) => f(view, at, at, text, deflt))
  if (!handled) view.dispatch(deflt())
}

describe('a character a locked control refused', () => {
  it('leaves the caret where it was typed, so the next text is refused there too', async () => {
    const editor = await load()
    editor.commands.setTextSelection(1)
    // 'Code: ' is six characters: 8 is after the A of the control
    typedOnThePage(editor, 8, 'x')
    expect(editor.state.doc.textContent).toBe('Code: A-1 end')
    expect(editor.state.selection.head).toBe(8)
    // the next text, typed where the caret is, is refused as well
    const { from } = editor.state.selection
    typedOnThePage(editor, from, 'y')
    expect(editor.state.doc.textContent).toBe('Code: A-1 end')
    expect(editor.can().undo()).toBe(false)
  })

  it('a command the lock refused leaves the caret where it was', async () => {
    const editor = await load()
    editor.commands.setTextSelection(2)
    editor.commands.insertContentAt(8, 'x')
    expect(editor.state.doc.textContent).toBe('Code: A-1 end')
    expect(editor.state.selection.head).toBe(2)
  })
})
