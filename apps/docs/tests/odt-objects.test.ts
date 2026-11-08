import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import type { Block } from '@genoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  captureRenderedObjects,
  classifyObjectXml,
  exportObjectSlots,
} from '../src/renderer/odt-objects'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

const OMML =
  '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>'
const TEXTBOX_XML =
  '<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent/></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing>'

function editorWith(content: JSONContent[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content },
  })
  editors.push(editor)
  return editor
}

describe('docx → ODT rendered objects', () => {
  it('classifies like the engine', () => {
    expect(classifyObjectXml(TEXTBOX_XML)).toBe('textbox')
    expect(classifyObjectXml('<w:drawing><pic:pic/><a:blip r:embed="r1"/></w:drawing>')).toBe(
      'picture',
    )
    expect(
      classifyObjectXml('<c:chart r:id="r2"/><a:graphicData uri="http://x/chart"></a:graphicData>'),
    ).toBe('chart')
  })

  it('keys objects per body element in document order', () => {
    const blocks = [
      { type: 'paragraph', docxIndex: 0, runs: [{ text: 'a' }] },
      {
        type: 'paragraph',
        docxIndex: 1,
        runs: [
          { text: '', math: { omml: OMML } },
          { text: '', image: { xml: TEXTBOX_XML, dataUrl: '' } },
          { text: '', math: { omml: OMML }, del: { author: 'x' } },
        ],
      },
      { type: 'passthrough', docxIndex: 2, originalXml: '<w:p/>' },
    ] as unknown as Block[]
    expect(exportObjectSlots({ blocks })).toEqual([
      { key: '1:0', kind: 'equation' },
      { key: '1:1', kind: 'textbox' },
    ])
  })

  it('captures each editor object under the key of the built docx', async () => {
    const editor = editorWith([
      {
        type: 'docParagraph',
        attrs: { docxIndex: null },
        content: [
          { type: 'text', text: 'before ' },
          { type: 'docInlineMath', attrs: { omml: OMML, mathml: '', text: 'x' } },
        ],
      },
    ])
    const blocks = [
      { type: 'paragraph', docxIndex: 4, runs: [{ text: '', math: { omml: OMML } }] },
    ] as unknown as Block[]
    const png = new Uint8Array([137, 80, 78, 71])
    const rasterize = vi.fn(async () => ({ png, widthEmu: 9525, heightEmu: 9525 }))
    const rendered = await captureRenderedObjects(editor, { blocks }, rasterize)
    expect(rasterize).toHaveBeenCalledTimes(1)
    expect(rendered).toEqual({ '4:0': { png, widthEmu: 9525, heightEmu: 9525 } })
  })

  it('passes no pictures when the editor and the docx do not line up', async () => {
    const editor = editorWith([
      {
        type: 'docParagraph',
        attrs: { docxIndex: null },
        content: [{ type: 'docInlineMath', attrs: { omml: OMML, mathml: '', text: 'x' } }],
      },
    ])
    const blocks = [
      {
        type: 'paragraph',
        docxIndex: 0,
        runs: [{ text: '', image: { xml: TEXTBOX_XML, dataUrl: '' } }],
      },
    ] as unknown as Block[]
    const rasterize = vi.fn()
    expect(await captureRenderedObjects(editor, { blocks }, rasterize)).toEqual({})
    expect(rasterize).not.toHaveBeenCalled()
  })
})
