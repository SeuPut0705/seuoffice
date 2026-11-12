import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import JSZip from 'jszip'
import { parseDocx, saveDocx } from '@seuoffice/docx-engine'
import { OLD_REDACT_NS } from '../../../packages/agent-core/src/old-names'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { DocRedaction } from '../src/renderer/editor/redaction'
import { modelTextOf, type RedactableNode } from '../src/renderer/ai/redact-view'

/**
 * The "withheld from the model" label is saved inside the .docx under a
 * namespace. Files marked so far carry the old one for good, files saved by a
 * later release may carry this product's own, and both must keep the span away
 * from the model.
 */

const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
const SECRET = '13800138000'
const LABEL = 'client phone'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

const editors = new Set<Editor>()
afterEach(() => {
  for (const e of editors) e.destroy()
  editors.clear()
})

async function open(bytes: Uint8Array): Promise<Editor> {
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...editorExtensions, DocRedaction],
    content: { type: 'doc', content: blocksToPmDoc(parsed.blocks).content as PmNode[] },
  })
  editors.add(editor)
  return editor
}

const modelView = (editor: Editor) => modelTextOf(editor.getJSON() as RedactableNode)

describe('a .docx withheld span under either namespace', () => {
  it.each([
    ['the old namespace', OLD_REDACT_NS],
    ['this product’s own namespace', OWN_REDACT_NS],
  ])('is withheld from the model when the label is under %s', async (_name, ns) => {
    const editor = await open(
      await buildDocx({
        docRootExtraAttrs: `xmlns:mc="${MC}" xmlns:go="${ns}" mc:Ignorable="go"`,
        bodyXml:
          '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>' +
          '<w:r><w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>' +
          `<go:redact w:label="${LABEL}"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
          '<w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p>',
      }),
    )
    expect(editor.state.doc.textContent).toContain(SECRET)
    expect(modelView(editor)).toBe(`Call {{${LABEL}}} now`)
  })
})

describe('a span marked now', () => {
  it('is still withheld after a save and reopen, under the namespace installed versions read', async () => {
    const from = await buildDocx({
      bodyXml: `<w:p><w:r><w:t xml:space="preserve">Call ${SECRET} now</w:t></w:r></w:p>`,
    })
    const editor = await open(from)
    let start = -1
    editor.state.doc.descendants((node, pos) => {
      const at = node.textContent.indexOf(SECRET)
      if (start < 0 && node.isText && at >= 0) start = pos + at
    })
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, start, start + SECRET.length),
      ),
    )
    expect(editor.commands.setRedaction(LABEL)).toBe(true)

    const parsed = await parseDocx(from)
    const saved = await saveDocx(
      parsed,
      pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks).saveBlocks,
    )
    const reopened = await open(saved)
    expect(modelView(reopened)).toBe(`Call {{${LABEL}}} now`)

    const xml = await (await JSZip.loadAsync(saved)).file('word/document.xml')!.async('string')
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.getElementsByTagNameNS(OLD_REDACT_NS, 'redact')).toHaveLength(1)
    // the value spelled out: what versions from before the rename look for, whatever the code says later
    expect(xml).toContain('xmlns:go="https://genspark.ai/genoffice/redaction/2026"')
    expect(xml).not.toContain(OWN_REDACT_NS)
  })
})
