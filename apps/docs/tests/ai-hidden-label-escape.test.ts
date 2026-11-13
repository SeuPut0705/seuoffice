import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx, type SaveBlock } from '@seuoffice/docx-engine'
import { sanitizeLabel } from '@seuoffice/agent-core/redact-core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { buildDocumentContext, serializeRangeToHtml } from '../src/renderer/ai/protocol'
import { redactLabelsOf, redactNode, type RedactableNode } from '../src/renderer/ai/redact-view'
import { safeNode, safeStep } from '../src/web/collab-safety'
import {
  hiddenStoriesDocx,
  OWN_REDACT_NS,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

const NASTY = 'a;b\\c /* url( x'

/** the stories document with the label of every mark written as `label` */
async function labelled(label: string) {
  const dir = mkdtempSync(join(tmpdir(), 'label-escape-'))
  const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'l.docx', 'go', { pictures: true })
  const zip = await JSZip.loadAsync(readFileSync(file))
  const xml = (await zip.file('word/document.xml')!.async('string')).replaceAll(
    'w:label="client phone"',
    `w:label="${label}"`,
  )
  zip.file('word/document.xml', xml)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('a hidden picture block whose label no co-editing token may hold', () => {
  it('passes the safety rules unchanged and reads as its placeholder', async () => {
    const bytes = await labelled(NASTY)
    const parsed = await parseDocx(bytes)
    const hiddenBlocks = parsed.blocks.filter((b) => b.redact !== undefined)
    expect(hiddenBlocks.length).toBeGreaterThan(0)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    editors.add(editor)
    const doc = editor.state.doc.toJSON()
    const protectedBlocks = (
      doc.content as Array<{ type: string; attrs: { redact?: string } }>
    ).filter((n) => n.type === 'docProtected' && n.attrs.redact !== null)
    expect(protectedBlocks.length).toBe(hiddenBlocks.length)
    for (const node of protectedBlocks) {
      // the rules keep it as it is, as a node and as an attribute step
      expect(safeNode(node as never)).toBe(node)
      const step = { stepType: 'attr', pos: 0, attr: 'redact', value: node.attrs.redact }
      expect(safeStep(step as never)).toBe(step)
    }
    // the model sees the label as sanitizeLabel gives it
    const want = `{{${sanitizeLabel(NASTY)}}}`
    expect(want).toContain('a;b\\c')
    expect(buildDocumentContext(editor)).toContain(want)
    expect(serializeRangeToHtml(editor, 0, editor.state.doc.childCount - 1)).toContain(want)
    expect(redactLabelsOf(doc as unknown as RedactableNode)).toContain(sanitizeLabel(NASTY))
    const view = redactNode(doc as unknown as RedactableNode)
    expect(JSON.stringify(view)).not.toContain('13800138000')
    // and what it passes along again still decodes to the same label
    expect(redactLabelsOf(view)).toContain(sanitizeLabel(NASTY))
  })

  it('keeps the original label in the saved file', async () => {
    const parsed = await parseDocx(await labelled(NASTY))
    const blocks = parsed.blocks
      .filter((b) => !b.hidden)
      .map((b): SaveBlock => ({ kind: 'original', docxIndex: b.docxIndex! }))
    const saved = await saveDocx(parsed, blocks)
    const xml = await (await JSZip.loadAsync(saved)).file('word/document.xml')!.async('string')
    expect(xml).toContain(`w:label="${NASTY}"`)
  })

  it('treats every label alike, whatever pattern the rules refuse', async () => {
    for (const label of [
      'plain label',
      '客户电话',
      'a%b',
      'javascript:x',
      'image-set(x)',
      '@import x',
      'expression(1)',
      'p%3b.q',
    ]) {
      const parsed = await parseDocx(await labelled(label))
      const editor = new Editor({
        element: document.createElement('div'),
        extensions: editorExtensions,
        content: blocksToPmDoc(parsed.blocks) as never,
      })
      editors.add(editor)
      const doc = editor.state.doc.toJSON() as { content: Array<{ type: string; attrs: never }> }
      for (const node of doc.content.filter((n) => n.type === 'docProtected'))
        expect(safeNode(node as never)).toBe(node)
      expect(buildDocumentContext(editor)).toContain(`{{${sanitizeLabel(label)}}}`)
    }
  })
})
