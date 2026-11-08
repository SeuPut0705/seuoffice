import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  captureRollbackSnapshot,
  restoreRollbackSnapshot,
} from '../src/renderer/ai/rollback-snapshot'

/**
 * The roll-back point of an AI run is the document node itself. It must bring
 * the document back exactly, share the untouched blocks with later documents
 * instead of copying them, and still restore after the editor was rebuilt.
 */

function para(index: number, text: string) {
  return {
    type: 'docParagraph',
    attrs: { docxIndex: index },
    content: [{ type: 'text', text }],
  }
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [para(0, 'First block'), para(1, 'Second block'), para(2, 'Third block')],
    },
  })
}

describe('AI roll-back snapshot', () => {
  it('restores the document as it was before the run', () => {
    const editor = createEditor()
    const before = editor.getJSON()
    const snapshot = captureRollbackSnapshot(editor)
    editor.commands.insertContentAt(editor.state.doc.content.size, para(3, 'Added by the AI'))
    editor.commands.insertContentAt(1, 'Edited ')
    expect(editor.getJSON()).not.toEqual(before)
    restoreRollbackSnapshot(editor, snapshot)
    expect(editor.getJSON()).toEqual(before)
    expect(editor.state.doc.eq(snapshot)).toBe(true)
    editor.destroy()
  })

  it('shares the blocks the run left alone instead of copying them', () => {
    const editor = createEditor()
    const snapshot = captureRollbackSnapshot(editor)
    editor.commands.insertContentAt(1, 'Edited ')
    const live = editor.state.doc
    expect(live.child(0)).not.toBe(snapshot.child(0))
    expect(live.child(1)).toBe(snapshot.child(1))
    expect(live.child(2)).toBe(snapshot.child(2))
    editor.destroy()
  })

  it('restores a snapshot taken in an editor that has since been replaced', () => {
    const first = createEditor()
    const snapshot = captureRollbackSnapshot(first)
    const before = first.getJSON()
    first.destroy()
    const second = createEditor()
    second.commands.insertContentAt(1, 'Changed ')
    expect(second.schema).not.toBe(snapshot.type.schema)
    restoreRollbackSnapshot(second, snapshot)
    expect(second.getJSON()).toEqual(before)
    second.destroy()
  })
})
