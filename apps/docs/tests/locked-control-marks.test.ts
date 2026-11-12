import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@seuoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { takeOdtRefusal } from '../src/renderer/odt-gate'

/**
 * A control locked against editing covers the text it covers. Its mark is the
 * control: a step of this page that stretches it over other text, or takes it
 * off part of its text, changes what the lock holds and is refused, and the
 * file keeps its bytes. A peer's step was admitted where it was made and is
 * applied as it comes.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const LOCKED =
  '<w:sdt><w:sdtPr><w:id w:val="7"/><w:lock w:val="contentLocked"/></w:sdtPr>' +
  `<w:sdtContent>${run('Hong')}</w:sdtContent></w:sdt>`
const BODY = `<w:p>${run('Name: ')}${LOCKED}${run(' end')}</w:p>`

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  takeOdtRefusal()
})

async function open() {
  const source = await buildDocx({ bodyXml: BODY })
  const parsed = await parseDocx(source)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  // 'Name: ' is six characters: the control's text runs from 7 to 11
  const mark = editor.state.doc.nodeAt(7)!.marks.find((m) => m.type.name === 'inlineWrap')!
  const save = async () =>
    saveDocx(parsed, pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks).saveBlocks)
  return { editor, mark, source, save }
}

/** the text the control's mark stands on */
function controlText(editor: Editor): string {
  let text = ''
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === 'inlineWrap')) text += node.text
  })
  return text
}

describe('the mark of a locked control', () => {
  it('stretched over the text behind it: refused, and the file keeps its bytes', async () => {
    const { editor, mark, source, save } = await open()
    editor.view.dispatch(editor.state.tr.addMark(11, 13, mark))
    expect(controlText(editor)).toBe('Hong')
    expect(takeOdtRefusal()).not.toBeNull()
    expect(await save()).toEqual(source)
  })

  it('stretched over the text in front of it: refused', async () => {
    const { editor, mark } = await open()
    editor.view.dispatch(editor.state.tr.addMark(3, 7, mark))
    expect(controlText(editor)).toBe('Hong')
  })

  it('taken off part of its text: refused', async () => {
    const { editor, mark } = await open()
    editor.view.dispatch(editor.state.tr.removeMark(9, 11, mark))
    expect(controlText(editor)).toBe('Hong')
  })

  it('from a peer, stretched over the text behind it: applied as it comes', async () => {
    const { editor, mark } = await open()
    editor.view.dispatch(editor.state.tr.addMark(11, 13, mark).setMeta('rebased', 0))
    expect(controlText(editor)).toBe('Hong e')
  })
})
