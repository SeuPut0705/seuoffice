import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { executeTool } from '../src/renderer/ai/tools'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { acceptAllRevisions, rejectAllRevisions } from '../src/renderer/editor/revisions'
import { takeOdtRefusal } from '../src/renderer/odt-gate'
import { createDocsAdapter, type DocsOp } from '../src/web/collab-adapter'

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
;(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {}
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const control = (locked = false) =>
  `<w:sdt><w:sdtPr><w:id w:val="1234567"/>${locked ? '<w:lock w:val="contentLocked"/>' : ''}</w:sdtPr><w:sdtContent>${run('5/6/2024')}</w:sdtContent></w:sdt>`
const PS = '<w:permStart w:id="77" w:edGrp="everyone"/>'
const PE = '<w:permEnd w:id="77"/>'
const smart = `<w:smartTag w:uri="urn:place" w:element="city">${run('Paris')}</w:smartTag>`
const body = (inside: string) =>
  `<w:p>${run('Due on ')}${inside}${run(' at noon')}</w:p><w:p>${run('tail')}</w:p>`
const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  takeOdtRefusal()
})
async function open(xml: string) {
  const parsed = await parseDocx(await buildDocx({ bodyXml: xml }))
  const make = () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    editors.push(editor)
    return editor
  }
  const editor = make()
  const save = async (e = editor) =>
    (
      await parseDocx(
        await saveDocx(parsed, pmDocToSavePlan(e.getJSON() as PmNode, parsed.blocks).saveBlocks),
      )
    ).internal.documentXml
  return { editor, parsed, make, save }
}
const rewrite = (editor: Editor, html: string, tracked = false, name = 'replace_blocks') =>
  executeTool(
    editor,
    {
      id: 'probe',
      name,
      input:
        name === 'write_document'
          ? { plan: 'Rewrite', replaceDocument: true }
          : { startBlockIndex: 0, endBlockIndex: 0, html },
    },
    { bullet: null, ordered: null },
    tracked ? { author: 'Probe' } : undefined,
    undefined,
    null,
    undefined,
    undefined,
    {
      write: async (_spec, onProgress) => {
        onProgress(html)
        return { ok: true, html, truncated: false }
      },
    },
  )
const count = (xml: string, tag: string) => xml.split(`<w:${tag}`).length - 1
function posOf(editor: Editor, text: string) {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    const at = node.isText ? node.text!.indexOf(text) : -1
    if (found < 0 && at >= 0) found = pos + at
  })
  if (found < 0) throw new Error(`Missing ${text}`)
  return found
}

describe('AI rewrites preserve untouched inline structure', () => {
  for (const name of ['replace_blocks', 'write_document']) {
    it(`${name}: refuses changing a locked date into a table with and without tracking`, async () => {
      const { editor, save } = await open(body(control(true)))
      const before = await save()
      for (const tracked of [true, false]) {
        const result = await rewrite(
          editor,
          '<table><tr><td>Due on 5/6/2025</td></tr></table>',
          tracked,
          name,
        )
        expect(result.isError).toBe(true)
        expect(result.mutated).not.toBe(true)
        acceptAllRevisions(editor)
        expect(await save()).toBe(before)
      }
    })
  }
  for (const tracked of [false, true]) {
    for (const [label, inside, html, tags] of [
      ['unlocked date', control(), '<p>Due on 5/6/2024 at night</p>', ['sdt>']],
      [
        'permission range',
        `${PS}${run('5/6/2024')}${PE}`,
        '<p>Due on 5/6/2024 at night</p>',
        ['permStart', 'permEnd'],
      ],
      ['smart tag', smart, '<p>Due on Paris at night</p>', ['smartTag ']],
      [
        'locked date and neighbouring range',
        `${control(true)}${PS}${run(' Paris')}${PE}`,
        '<p>Due on 5/6/2024 Paris at night</p>',
        ['sdt>', 'permStart', 'permEnd'],
      ],
    ] as const) {
      it(`tracked=${tracked}: keeps ${label} when only outside text changes`, async () => {
        const { editor, save } = await open(body(inside))
        const result = await rewrite(editor, html, tracked)
        expect(result.isError).toBeFalsy()
        if (tracked) acceptAllRevisions(editor)
        const xml = await save()
        for (const tag of tags) expect(count(xml, tag)).toBe(1)
        if (label === 'permission range') {
          const flat = xml.replace(
            /<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g,
            '[$1]',
          )
          expect(flat).toContain(`${PS}[5/6/2024]${PE}`)
        }
        expect(editor.state.doc.textContent).toContain('at night')
        expect(xml).not.toContain('at noon')
        if (!tracked && (label === 'unlocked date' || label === 'permission range')) {
          await rewrite(editor, '<p>Due on 5/6/2025 at night</p>')
          const changed = await save()
          for (const tag of tags) expect(count(changed, tag)).toBe(0)
          expect(editor.state.doc.textContent).toContain('5/6/2025')
        }
      })
    }
  }
  for (const mode of ['accept', 'reject'] as const) {
    it(`${mode} all leaves a pre-existing whole-block locked-content deletion pending`, async () => {
      const { editor, save } = await open(body(control(true)))
      const node = editor.state.doc.firstChild!
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(0, undefined, {
          ...node.attrs,
          blockRevision: { kind: mode === 'accept' ? 'del' : 'ins', author: 'Probe' },
        }),
      )
      const before = await save()
      const skipped = mode === 'accept' ? acceptAllRevisions(editor) : rejectAllRevisions(editor)
      expect(skipped).toHaveLength(1)
      expect(await save()).toBe(before)
    })
  }
  it('accept and reject all preserve the locked control in a valid tracked rewrite', async () => {
    for (const mode of ['accept', 'reject'] as const) {
      const { editor, save } = await open(body(control(true)))
      const result = await rewrite(
        editor,
        '<table><tr><td>Due on 5/6/2024 at night</td></tr></table>',
        true,
      )
      expect(result.isError).toBeFalsy()
      const skipped = mode === 'accept' ? acceptAllRevisions(editor) : rejectAllRevisions(editor)
      expect(skipped).toHaveLength(0)
      expect(count(await save(), 'sdt>')).toBe(1)
      expect(editor.state.doc.textContent).toContain(mode === 'accept' ? 'night' : 'noon')
    }
  })
})

describe('rebased wrappers have one saved content-control identity', () => {
  // This bounded two-peer schedule directly exercises the reported race; a
  // separate model would abstract away the ProseMirror mark rebasing at fault.
  for (const bobEdit of ['type', 'Shift-Enter'] as const) {
    it(`Alice splits first while Bob does ${bobEdit} in the second half`, async () => {
      const { editor: alice, make, save } = await open(body(control()))
      const bob = make()
      const peer = (editor: Editor) => {
        const sent: DocsOp[] = []
        const refused: string[] = []
        const adapter = createDocsAdapter({
          editor,
          side: { read: () => new Map(), write() {}, observe: () => () => {} } as never,
          produce: async () => ({ fileName: 'x.docx', bytes: new Uint8Array() }),
          maxOpBytes: 8 * 1024 * 1024 - 4096,
          refused: (reason) => refused.push(reason),
        })
        adapter.listen((ops) => sent.push(...ops))
        return { adapter, sent, refused }
      }
      const a = peer(alice),
        b = peer(bob)
      alice.commands.setTextSelection(posOf(alice, '6/2024'))
      alice.commands.keyboardShortcut('Enter')
      if (bobEdit === 'type') bob.commands.insertContentAt(posOf(bob, '2024'), 'B')
      else {
        bob.commands.setTextSelection(posOf(bob, '2024'))
        bob.commands.keyboardShortcut('Shift-Enter')
      }
      const aOps = a.sent.splice(0),
        bOps = b.sent.splice(0)
      const rebased = b.adapter.integrate(
        aOps.map((op) => b.adapter.decode(a.adapter.encode(op))),
        bOps,
      )
      a.adapter.confirmed?.(aOps)
      a.adapter.integrate(
        rebased.map((op) => a.adapter.decode(b.adapter.encode(op))),
        [],
      )
      b.adapter.confirmed?.(rebased)
      expect(alice.getJSON()).toEqual(bob.getJSON())
      expect(a.sent).toEqual([])
      expect(b.sent).toEqual([])
      expect([...a.refused, ...b.refused]).toEqual([])
      const xml = await save(alice)
      expect(count(xml, 'sdt>')).toBe(1)
      expect(await save(bob)).toBe(xml)
      expect(xml).toContain('1234567')
    })
  }
})
