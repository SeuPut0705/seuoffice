import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseDocx, saveDocx, type HeaderFooter, type ParsedDocFull } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { executeOps } from '../src/renderer/ai/ops'
import { executeTool } from '../src/renderer/ai/tools'
import { FindPanel, findMatches } from '../src/renderer/components/FindPanel'
import { takeOdtRefusal } from '../src/renderer/odt-gate'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions, textboxSubExtensions } from '../src/renderer/editor/extensions'
import { mountHfEditor } from '../src/renderer/editor/hf-editor'
import { PASTED_CONTENT } from '../src/renderer/editor/inline-wrap'
import { acceptAllRevisions, collectRevisions } from '../src/renderer/editor/revisions'

/**
 * A paragraph the user edits keeps the run-level structure the editor has no
 * model for: inline content controls (w:sdt inside w:p), w:smartTag,
 * w:customXml, w:bdo, w:dir, and elements without text (w:permStart /
 * w:permEnd, customXml range markers). Each test opens a document the way the
 * editor does (parse -> editor document), edits, builds the save plan and
 * saves with the engine.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

// written the way a file may write it, not the way a serializer would: single
// quotes and an empty element with a closing tag
const BINDING =
  '<w:dataBinding w:prefixMappings="" w:xpath="/root[1]/due[1]" w:storeItemID="{11111111-2222-3333-4444-555555555555}"/>'
const sdtPr = (lock: string, binding = BINDING) =>
  '<w:sdtPr><w:alias w:val=\'Due date\'></w:alias><w:tag w:val="due"/><w:id w:val="1234567"/>' +
  lock +
  binding +
  '<w:date w:fullDate="2024-05-06T00:00:00Z"><w:dateFormat w:val="M/d/yyyy"/><w:lid w:val="en-US"/>' +
  '<w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date></w:sdtPr>'

interface Kind {
  open: string
  close: string
}
const LOCKED: Kind = {
  open: `<w:sdt>${sdtPr('<w:lock w:val="contentLocked"/>')}<w:sdtContent>`,
  close: '</w:sdtContent></w:sdt>',
}
const UNLOCKED: Kind = { open: `<w:sdt>${sdtPr('')}<w:sdtContent>`, close: LOCKED.close }
/**
 * The unlocked control as the engine writes it once its text is not the text
 * it was read with: the binding to the stored value goes, or Word would put
 * the old value back on open. Every other byte stays.
 */
const UNLOCKED_EDITED: Kind = { open: `<w:sdt>${sdtPr('', '')}<w:sdtContent>`, close: LOCKED.close }

const KINDS: Record<string, Kind> = {
  'w:sdt (content locked)': LOCKED,
  'w:sdt': UNLOCKED,
  'w:smartTag': {
    open:
      '<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="place">' +
      '<w:smartTagPr><w:attr w:name=\'k\' w:val="v"></w:attr></w:smartTagPr>',
    close: '</w:smartTag>',
  },
  'w:customXml': {
    open:
      '<w:customXml w:uri="urn:x" w:element="city">' +
      '<w:customXmlPr><w:attr w:name="k" w:val="v"/></w:customXmlPr>',
    close: '</w:customXml>',
  },
  'w:bdo': { open: "<w:bdo w:val='rtl'>", close: '</w:bdo>' },
  'w:dir': { open: '<w:dir w:val="rtl">', close: '</w:dir>' },
  'w:permStart / w:permEnd': {
    open: '<w:permStart w:id=\'77\' w:edGrp="everyone"/>',
    close: '<w:permEnd w:id="77"/>',
  },
  'customXml range markers': {
    open: '<w:customXmlInsRangeStart w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z"/>',
    close: '<w:customXmlInsRangeEnd w:id="3"/>',
  },
}

const around = (kind: Kind) =>
  '<w:p><w:r><w:t xml:space="preserve">Due on </w:t></w:r>' +
  `${kind.open}<w:r><w:rPr><w:b/></w:rPr><w:t>5/6/2024</w:t></w:r>${kind.close}` +
  '<w:r><w:t xml:space="preserve"> at noon</w:t></w:r></w:p>'

const OTHER = '<w:p><w:r><w:t>Untouched paragraph</w:t></w:r></w:p>'
const OTHER_YEAR = '<w:p><w:r><w:t>Untouched year 2024 paragraph</w:t></w:r></w:p>'
const NUM_IDS = { bullet: null, ordered: null }
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
;(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** the xml with every text run reduced to [its text]: what sits around the runs stays visible */
const skeleton = (xml: string) =>
  xml.replace(/<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g, '[$1]')

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  takeOdtRefusal()
})

async function open(bodyXml: string, extra: Partial<Parameters<typeof buildDocx>[0]> = {}) {
  const source = await buildDocx({ bodyXml, ...extra })
  const parsed = await parseDocx(source)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  return { editor, parsed, source }
}

async function save(editor: Editor, parsed: ParsedDocFull) {
  const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
  const bytes = await saveDocx(parsed, plan.saveBlocks)
  const reparsed = await parseDocx(bytes)
  return { plan, bytes, xml: reparsed.internal.documentXml, reparsed }
}

/** document position of the first occurrence of `text` */
function posOf(editor: Editor, text: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false
    const at = node.isText ? (node.text ?? '').indexOf(text) : -1
    if (at !== -1) found = pos + at
    return true
  })
  if (found === -1) throw new Error(`"${text}" is not in the document`)
  return found
}

/** the text of every top-level block */
function texts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(node.textContent))
  return out
}

const occurrences = (xml: string, part: string) => xml.split(part).length - 1

const press = (editor: Editor, key: string, shiftKey = false) =>
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  )

/** the clipboard HTML of [from, to), as a copy or a cut puts it there */
const clipboardHtml = (editor: Editor, from: number, to: number) =>
  editor.view.serializeForClipboard(editor.state.doc.slice(from, to)).dom.innerHTML

/** paste `html` at the end of the last paragraph */
function pasteAtEnd(editor: Editor, html: string): void {
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  editor.view.pasteHTML(html)
}

/** the Find panel on its Replace tab, driven the way a person drives it */
function openFindPanel(editor: Editor) {
  Element.prototype.scrollIntoView = () => {}
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(FindPanel, { editor, onClose: () => {} })))
  act(() => container.querySelectorAll<HTMLButtonElement>('.find-tab')[1].click())
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return {
    replaceAll(find: string, replacement: string) {
      const inputs = container.querySelectorAll<HTMLInputElement>('.find-input')
      // the scan runs after a pause in typing: the pause passes on a clock the test moves
      vi.useFakeTimers()
      try {
        act(() => type(inputs[0], find))
        act(() => type(inputs[1], replacement))
        act(() => {
          vi.advanceTimersByTime(200)
        })
        act(() => container.querySelectorAll<HTMLButtonElement>('.find-action')[1].click())
      } finally {
        vi.useRealTimers()
      }
    },
    count: () => container.querySelector('.find-count')!.textContent,
    close() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('editing text beside run-level structure keeps the structure', () => {
  for (const [name, kind] of Object.entries(KINDS)) {
    it(`${name}: an untouched document saves as the original bytes`, async () => {
      const { editor, parsed, source } = await open(around(kind) + OTHER)
      expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
      const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
      expect(plan.changedCount).toBe(0)
      expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
    })

    it(`${name}: a character typed in the first run leaves it in place, byte for byte`, async () => {
      const { editor, parsed } = await open(around(kind) + OTHER)
      editor.commands.insertContentAt(posOf(editor, 'Due on'), 'X')
      const { xml } = await save(editor, parsed)
      const edited = xml.slice(xml.indexOf('<w:p>'), xml.indexOf(OTHER))
      expect(skeleton(edited)).toBe(
        `<w:p>[XDue on ]${kind.open}[5/6/2024]${kind.close}[ at noon]</w:p>`,
      )
      expect(edited).toContain(`${kind.open}<w:r><w:rPr><w:b/></w:rPr>`)
      // the paragraph that was not edited keeps its bytes
      expect(xml).toContain(OTHER)
    })
  }

  it('the control is read back with the same tag, title, lock, id and text', async () => {
    const { editor, parsed } = await open(around(LOCKED) + OTHER)
    editor.commands.insertContentAt(posOf(editor, 'Due on'), 'X')
    const { reparsed } = await save(editor, parsed)
    expect(reparsed.blocks[0].inlineContentControls).toEqual(parsed.blocks[0].inlineContentControls)
    expect(reparsed.blocks[0].inlineContentControls).toMatchObject([
      { tag: 'due', lock: 'contentLocked', id: '1234567', text: '5/6/2024' },
    ])
  })

  it('text typed inside a control stays inside it', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    editor.commands.insertContentAt(posOf(editor, '6/2024'), 'X')
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(
      `[Due on ]${UNLOCKED_EDITED.open}[5/X6/2024]${UNLOCKED_EDITED.close}[ at noon]`,
    )
  })

  it('text typed at the end of a control lands after it, not in it', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    const end = posOf(editor, '5/6/2024') + '5/6/2024'.length
    editor.chain().setTextSelection(end).insertContent('X').run()
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}[X]`)
  })

  it('formatting part of a control keeps one control around all of its runs', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024')
    editor
      .chain()
      .setTextSelection({ from, to: from + 3 })
      .setMark('italic')
      .run()
    const { xml } = await save(editor, parsed)
    expect(xml.match(/<w:sdt>/g)).toHaveLength(1)
    expect(skeleton(xml)).toContain(`${UNLOCKED.open}[5/6][/2024]${UNLOCKED.close}`)
  })

  it('Backspace right after an invisible marker reaches the text before it, not the marker', async () => {
    const perm = KINDS['w:permStart / w:permEnd']
    const { editor, parsed } = await open(around(perm) + OTHER)
    const afterMarker = posOf(editor, '5/6/2024')
    editor.commands.setTextSelection(afterMarker)
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    )
    // the caret stepped over the marker; the key then deletes what is before it
    const caret = editor.state.selection.from
    expect(caret).toBeLessThan(afterMarker)
    editor.commands.deleteRange({ from: caret - 1, to: caret })
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`[Due on]${perm.open}[5/6/2024]${perm.close}[ at noon]`)
  })

  it('a paragraph split before the control keeps the control in the second half', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    editor.chain().setTextSelection(posOf(editor, 'on ')).splitBlock().run()
    expect(editor.state.doc.childCount).toBe(3)
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(
      `[Due ]</w:p><w:p>[on ]${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}[ at noon]</w:p>`,
    )
  })
})

describe('a control locked against editing (w:lock contentLocked)', () => {
  it('refuses text typed inside it, and says so to the tool that asked', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    editor.commands.insertContentAt(posOf(editor, '6/2024'), 'X')
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
    // the same edit asked for by a tool comes back as an error, not as a silent no-op
    const at = posOf(editor, '6/2024')
    editor.commands.setTextSelection({ from: at, to: at + 1 })
    const result = await executeTool(
      editor,
      { id: 'ai', name: 'replace_selection', input: { html: '7' } },
      NUM_IDS,
    )
    expect(result.isError).toBe(true)
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(0)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
  })

  it('refuses a deletion that takes part of its text', async () => {
    const { editor } = await open(around(LOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024') - 3
    editor.commands.deleteRange({ from, to: from + 5 })
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
  })

  it('refuses typing over a selection that covers it whole', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024')
    editor.view.dispatch(editor.state.tr.insertText('NEW', from, from + '5/6/2024'.length))
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
    // and over a wider selection that holds it
    editor.view.dispatch(editor.state.tr.insertText('NEW', from - 3, from + 11))
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
  })

  it('one find-and-replace run skips the match inside it and replaces the others', async () => {
    const { editor, parsed } = await open(around(LOCKED) + OTHER_YEAR)
    const outcome = executeOps(editor, [{ op: 'findReplace', find: '2024', replace: '2025' }])
    expect(outcome.ok, outcome.error).toBe(true)
    expect(outcome.results[0]).toMatchObject({ changed: 1, skippedLocked: 1 })
    expect(texts(editor)).toEqual(['Due on 5/6/2024 at noon', 'Untouched year 2025 paragraph'])
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`[Due on ]${LOCKED.open}[5/6/2024]${LOCKED.close}[ at noon]`)
  })

  it('the tool that ran the replace is told how many matches were skipped, not refused', async () => {
    const { editor } = await open(around(LOCKED) + OTHER_YEAR)
    const result = await executeTool(
      editor,
      {
        id: 'ai',
        name: 'apply_ops',
        input: { ops: [{ op: 'findReplace', find: '2024', replace: '2025' }] },
      },
      NUM_IDS,
    )
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(true)
    expect(result.output).toMatch(/1 match\(es\).*locked/)
    expect(texts(editor)).toEqual(['Due on 5/6/2024 at noon', 'Untouched year 2025 paragraph'])
  })

  it('Replace All in the Find panel skips the match inside it and replaces the others', async () => {
    const { editor } = await open(around(LOCKED) + OTHER_YEAR)
    const panel = openFindPanel(editor)
    panel.replaceAll('2024', '2025')
    expect(texts(editor)).toEqual(['Due on 5/6/2024 at noon', 'Untouched year 2025 paragraph'])
    // the match that was left is still listed
    expect(panel.count()).toBe('1/1')
    panel.close()
  })

  it('Accept All applies every tracked change except the one that would change its text', async () => {
    const rev = (id: number) => `w:id="${id}" w:author="A" w:date="2024-01-01T00:00:00Z"`
    const { editor } = await open(
      '<w:p><w:r><w:t xml:space="preserve">Due on </w:t></w:r>' +
        `${LOCKED.open}<w:r><w:t>5/6/2024</w:t></w:r>` +
        `<w:del ${rev(9)}><w:r><w:delText>?</w:delText></w:r></w:del>${LOCKED.close}` +
        '<w:r><w:t xml:space="preserve"> at noon</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Other </w:t></w:r>' +
        `<w:del ${rev(11)}><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
    )
    expect(texts(editor)).toEqual(['Due on 5/6/2024? at noon', 'Other gone'])
    acceptAllRevisions(editor)
    expect(texts(editor)).toEqual(['Due on 5/6/2024? at noon', 'Other '])
    const left = collectRevisions(editor.state.doc)
    expect(left.map((r) => editor.state.doc.textBetween(r.from, r.to))).toEqual(['?'])
  })

  it('refuses taking it off its text, and clearing formatting leaves it whole', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024')
    editor.view.dispatch(editor.state.tr.removeMark(from, from + 4, editor.schema.marks.inlineWrap))
    const untouched = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, untouched.saveBlocks)).toEqual(source)

    editor
      .chain()
      .setTextSelection({ from, to: from + 4 })
      .unsetAllMarks()
      .run()
    const { xml } = await save(editor, parsed)
    expect(xml.match(/<w:sdt>/g)).toHaveLength(1)
    expect(skeleton(xml)).toContain(`[Due on ]${LOCKED.open}[5/6/][2024]${LOCKED.close}[ at noon]`)
    // the part that lost its bold is still locked
    editor.commands.insertContentAt(from + 2, 'Z')
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
  })

  it('an edit made before a refused one is what undo takes back', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    editor.commands.insertContentAt(posOf(editor, 'Due on'), 'X')
    editor.commands.insertContentAt(posOf(editor, '6/2024'), 'Y')
    expect(editor.state.doc.child(0).textContent).toBe('XDue on 5/6/2024 at noon')
    editor.commands.undo()
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at noon')
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
    editor.commands.redo()
    expect(editor.state.doc.child(0).textContent).toBe('XDue on 5/6/2024 at noon')
  })

  it('a block rewrite that changes its text is refused; one that keeps the text keeps it', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    const rewrite = (html: string) =>
      executeTool(
        editor,
        {
          id: 'ai',
          name: 'replace_blocks',
          input: { startBlockIndex: 0, endBlockIndex: 0, html },
        },
        NUM_IDS,
      )
    const refused = await rewrite('<p>Due on <strong>5/6/2025</strong> at night</p>')
    expect(refused.isError).toBe(true)
    const dropped = await rewrite('<p>Due at night</p>')
    expect(dropped.isError).toBe(true)
    const untouched = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, untouched.saveBlocks)).toEqual(source)

    const kept = await rewrite('<p>Due on <strong>5/6/2024</strong> at night</p>')
    expect(kept.isError).toBeFalsy()
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`[Due on ]${LOCKED.open}[5/6/2024]${LOCKED.close}[ at night]`)
    // still locked after the rewrite
    editor.commands.insertContentAt(posOf(editor, '6/2024'), 'X')
    expect(editor.state.doc.child(0).textContent).toBe('Due on 5/6/2024 at night')
  })

  it('can still be deleted whole', async () => {
    const { editor, parsed } = await open(around(LOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024')
    editor.commands.deleteRange({ from, to: from + '5/6/2024'.length })
    expect(editor.state.doc.child(0).textContent).toBe('Due on  at noon')
    const { xml } = await save(editor, parsed)
    expect(xml).not.toContain('<w:sdt>')
  })

  it('an unlocked control takes the same edits', async () => {
    const { editor } = await open(around(UNLOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024') - 3
    editor.commands.deleteRange({ from, to: from + 5 })
    expect(editor.state.doc.child(0).textContent).toBe('Due 6/2024 at noon')
    expect(takeOdtRefusal()).toBeNull()
  })
})

describe('pasted HTML cannot put bytes of its own into the document', () => {
  const span = (chain: string, text: string) => {
    const el = document.createElement('span')
    el.setAttribute('data-inline-wrap', chain)
    el.textContent = text
    return `<p>${el.outerHTML}</p>`
  }

  it('a wrapper this document was opened with, cut out, pastes back as that wrapper', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    const chain = editor.view.dom
      .querySelector('[data-inline-wrap]')!
      .getAttribute('data-inline-wrap')!
    const from = posOf(editor, '5/6/2024')
    editor.commands.deleteRange({ from, to: from + '5/6/2024'.length })
    editor.commands.insertContentAt(editor.state.doc.content.size, span(chain, 'pasted'))
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`${UNLOCKED_EDITED.open}[pasted]${UNLOCKED_EDITED.close}`)
  })

  it('a wrapper from anywhere else pastes as plain text', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    const foreign = JSON.stringify([{ seq: 0, open: '<w:evil>', close: '</w:evil>' }])
    editor.commands.insertContentAt(editor.state.doc.content.size, span(foreign, 'pasted'))
    const { xml } = await save(editor, parsed)
    expect(xml).not.toContain('w:evil')
    expect(skeleton(xml)).toContain('[pasted]')
  })
})

describe('the same paragraph inside a container', () => {
  it('table cell: text typed beside the control keeps it, byte for byte', async () => {
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${around(UNLOCKED)}</w:tc></w:tr></w:tbl>`
    const { editor, parsed, source } = await open(table + OTHER)
    const untouched = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, untouched.saveBlocks)).toEqual(source)

    editor.commands.insertContentAt(posOf(editor, 'Due on'), 'X')
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(
      `[XDue on ]${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}[ at noon]`,
    )
    expect(xml).toContain(OTHER)
  })

  it('header: text typed beside the control keeps it', async () => {
    // header paragraphs are read through the parse tree, so the control's
    // properties are written in the form a serializer produces
    const pr = '<w:sdtPr><w:tag w:val="due"/><w:id w:val="5"/></w:sdtPr>'
    const header =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:r><w:t xml:space="preserve">Due on </w:t></w:r>' +
      `<w:sdt>${pr}<w:sdtContent><w:r><w:t>5/6/2024</w:t></w:r></w:sdtContent></w:sdt></w:p></w:hdr>`
    const source = await buildDocx({
      bodyXml: OTHER,
      extraParts: [
        {
          path: 'word/header1.xml',
          xml: header,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
        },
      ],
      extraRels:
        '<Relationship Id="rId40" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
      sectPrExtra: '<w:headerReference w:type="default" r:id="rId40"/>',
    })
    const parsed = await parseDocx(source)
    const value: HeaderFooter = { text: parsed.headerText ?? '', paras: parsed.headerParas ?? [] }
    const host = document.createElement('div')
    document.body.append(host)
    let committed: HeaderFooter | null = null
    const handle = mountHfEditor(host, {
      value,
      pageNo: '1',
      pageTotal: '1',
      spellcheck: false,
      onCommit: (next) => (committed = next),
      onExit: () => host.remove(),
    })
    handle.editor.commands.insertContentAt(1, 'X')
    handle.exit()
    expect(committed).not.toBeNull()
    const saved = await saveDocx(
      parsed,
      parsed.blocks
        .filter((b) => !b.hidden && b.docxIndex !== null)
        .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! })),
      { header: committed! },
    )
    const hdr = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
    expect(skeleton(hdr)).toContain(
      `[XDue on ]<w:sdt>${pr}<w:sdtContent>[5/6/2024]</w:sdtContent></w:sdt>`,
    )
  })
})

describe('a paragraph that holds only invisible elements is still an empty paragraph', () => {
  const PS = '<w:permStart w:id="7" w:edGrp="everyone"/>'
  const PE = '<w:permEnd w:id="7"/>'
  const BULLET =
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' +
    `${PS}${PE}</w:p>`
  // the class and style these paragraphs were drawn with before the editor
  // carried the elements (they were dropped on load then): pinned, not derived
  const LATIN = '--doc-line-factor: var(--doc-line-factor-latin,1.2);'
  const DRAWN: Array<[string, string, string, string]> = [
    [
      'range markers alone, with a paragraph mark size',
      `<w:p><w:pPr><w:rPr><w:sz w:val="48"/></w:rPr></w:pPr>${PS}${PE}</w:p>`,
      'doc-p-empty',
      `direction: ltr; font-size: 24pt; ${LATIN}`,
    ],
    [
      'an empty list item',
      BULLET,
      'doc-li doc-li-bullet ilvl-0 doc-p-empty',
      `direction: ltr; ${LATIN}`,
    ],
    [
      'an empty control alone',
      '<w:p><w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr><w:sdtContent></w:sdtContent></w:sdt></w:p>',
      'doc-p-empty',
      `direction: ltr; ${LATIN}`,
    ],
  ]
  for (const [name, xml, className, style] of DRAWN) {
    it(`${name}: drawn with the attributes of an empty paragraph`, async () => {
      const { editor } = await open(xml + OTHER)
      const el = editor.view.dom.firstElementChild!
      expect(el.getAttribute('class')).toBe(className)
      expect(el.getAttribute('style')).toBe(style)
    })
  }

  it('a picture-only paragraph that also holds markers keeps the picture line', () => {
    const marker = (xml: string) => ({ type: 'docInlineOpaque', attrs: { xml } })
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docParagraph',
            attrs: { docxIndex: null },
            content: [
              marker(PS),
              { type: 'docInlineImage', attrs: { dataUrl: PNG, widthPx: 10, heightPx: 10 } },
              marker(PE),
            ],
          },
        ],
      },
    })
    editors.push(editor)
    expect(editor.view.dom.firstElementChild!.classList.contains('doc-p-pic')).toBe(true)
  })

  it('a text box paragraph holding only a marker is drawn as an empty one', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: textboxSubExtensions,
      content: {
        type: 'doc',
        content: [
          { type: 'docParagraph', content: [{ type: 'docInlineOpaque', attrs: { xml: PS } }] },
        ],
      },
    })
    editors.push(editor)
    const el = editor.view.dom.querySelector('.doc-textbox-para')!
    expect(el.classList.contains('doc-textbox-para-empty')).toBe(true)
  })

  it('Enter on an empty list item that holds markers leaves the list and keeps the markers', async () => {
    const { editor, parsed } = await open(BULLET + OTHER)
    expect(editor.state.doc.child(0).type.name).toBe('docListItem')
    editor.commands.setTextSelection(1)
    press(editor, 'Enter')
    expect(editor.state.doc.childCount).toBe(2)
    expect(editor.state.doc.child(0).type.name).toBe('docParagraph')
    const { xml } = await save(editor, parsed)
    expect(xml).toContain(PS + PE)
  })
})

describe('text that reads continuously is found across a marker or a wrapper', () => {
  const live = (kind: Kind) =>
    '<w:p><w:r><w:t xml:space="preserve">I live in </w:t></w:r>' +
    `${kind.open}<w:r><w:t>Paris</w:t></w:r>${kind.close}` +
    '<w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p>'

  for (const name of ['w:permStart / w:permEnd', 'w:smartTag', 'w:sdt']) {
    const source = KINDS[name]
    // the control's text changes in each of these, so it is written in its edited form
    const kind = name === 'w:sdt' ? UNLOCKED_EDITED : source

    it(`${name}: Find sees the phrase, and Replace All changes the word in place`, async () => {
      const { editor, parsed } = await open(live(source) + OTHER)
      expect(findMatches(editor, 'in Paris', { matchCase: true, wholeWord: false })).toHaveLength(1)
      const panel = openFindPanel(editor)
      panel.replaceAll('in Paris', 'in London')
      panel.close()
      const { xml } = await save(editor, parsed)
      expect(skeleton(xml)).toContain(`[I live in ]${kind.open}[London]${kind.close}[ now]`)
    })

    it(`${name}: the AI find-and-replace changes the word in place and counts it`, async () => {
      const { editor, parsed } = await open(live(source) + OTHER)
      const outcome = executeOps(editor, [
        { op: 'findReplace', find: 'in Paris', replace: 'in London' },
      ])
      expect(outcome.results[0]).toMatchObject({ matched: 1, changed: 1 })
      const { xml } = await save(editor, parsed)
      expect(skeleton(xml)).toContain(`[I live in ]${kind.open}[London]${kind.close}[ now]`)
    })

    it(`${name}: a replacement that takes part of the inside leaves the rest inside`, async () => {
      const { editor, parsed } = await open(live(source) + OTHER)
      executeOps(editor, [{ op: 'findReplace', find: 'in Par', replace: 'at Rom' }])
      const { xml } = await save(editor, parsed)
      expect(skeleton(xml)).toContain(`[I live at Rom]${kind.open}[is]${kind.close}[ now]`)
    })
  }

  it('the AI font command reaches a phrase that crosses the boundary', async () => {
    const { editor } = await open(live(KINDS['w:smartTag']) + OTHER)
    const outcome = executeOps(editor, [{ op: 'setMatchedFont', text: 'in Paris', bold: true }])
    expect(outcome.results[0]).toMatchObject({ matched: 1, changed: 1 })
    const bold: string[] = []
    editor.state.doc.child(0).forEach((node) => {
      if (node.marks.some((mark) => mark.type.name === 'bold')) bold.push(node.text ?? '')
    })
    expect(bold.join('')).toBe('in Paris')
  })
})

describe('one control stays one control', () => {
  const saved = async (editor: Editor, parsed: ParsedDocFull) => {
    const { xml } = await save(editor, parsed)
    return { xml, controls: occurrences(xml, '<w:sdt>'), ids: occurrences(xml, 'w:val="1234567"') }
  }

  it('Shift+Enter inside it puts the line break inside it', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    editor.commands.setTextSelection(posOf(editor, '6/2024'))
    press(editor, 'Enter', true)
    expect(editor.state.doc.childCount).toBe(2)
    const { xml, controls, ids } = await saved(editor, parsed)
    expect([controls, ids]).toEqual([1, 1])
    const inside = xml.slice(xml.indexOf('<w:sdtContent>'), xml.indexOf('</w:sdtContent>'))
    expect(inside).toContain('<w:br/>')
    expect(skeleton(inside)).toContain('[5/]')
    expect(skeleton(inside)).toContain('[6/2024]')
  })

  it('an index entry inserted inside it goes inside it', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    editor.commands.insertContentAt(posOf(editor, '6/2024'), {
      type: 'docXeMark',
      attrs: { term: 't' },
    })
    const { xml, controls, ids } = await saved(editor, parsed)
    expect([controls, ids]).toEqual([1, 1])
    const inside = xml.slice(xml.indexOf('<w:sdtContent>'), xml.indexOf('</w:sdtContent>'))
    expect(inside).toContain(' XE "t" ')
  })

  it('Enter inside it leaves it on the first half only', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    editor.commands.setTextSelection(posOf(editor, '6/2024'))
    press(editor, 'Enter')
    expect(texts(editor)).toEqual(['Due on 5/', '6/2024 at noon', 'Untouched paragraph'])
    const { xml, controls, ids } = await saved(editor, parsed)
    expect([controls, ids]).toEqual([1, 1])
    expect(skeleton(xml)).toContain(
      `[Due on ]${UNLOCKED_EDITED.open}[5/]${UNLOCKED_EDITED.close}</w:p><w:p>[6/2024][ at noon]</w:p>`,
    )
    // undo puts the one control back around all of its text
    editor.commands.undo()
    const back = await saved(editor, parsed)
    expect(skeleton(back.xml)).toContain(
      `[Due on ]${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}[ at noon]`,
    )
  })

  it('Enter inside a locked one is refused', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    editor.commands.setTextSelection(posOf(editor, '6/2024'))
    press(editor, 'Enter')
    expect(texts(editor)).toEqual(['Due on 5/6/2024 at noon', 'Untouched paragraph'])
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
  })

  it('clearing all formatting takes the bold off and leaves the control', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    editor.chain().selectAll().unsetAllMarks().run()
    const { xml, controls, ids } = await saved(editor, parsed)
    expect([controls, ids]).toEqual([1, 1])
    expect(xml).not.toContain('<w:b/>')
    expect(skeleton(xml)).toContain(
      `[Due on ]${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}[ at noon]`,
    )
  })

  it('a copy pasted elsewhere is plain text; the original keeps the control', async () => {
    for (const kind of [UNLOCKED, LOCKED]) {
      const { editor, parsed } = await open(around(kind) + OTHER)
      const from = posOf(editor, '5/6/2024')
      pasteAtEnd(editor, clipboardHtml(editor, from, from + '5/6/2024'.length))
      expect(texts(editor)[1]).toBe('Untouched paragraph5/6/2024')
      const { xml, controls, ids } = await saved(editor, parsed)
      expect([controls, ids]).toEqual([1, 1])
      expect(skeleton(xml)).toContain(`[Due on ]${kind.open}[5/6/2024]${kind.close}[ at noon]`)
    }
  })

  it('a copy of a locked one pasted right behind it stays outside it, and undo takes it back', async () => {
    const { editor, parsed, source } = await open(around(LOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024')
    const to = from + '5/6/2024'.length
    const html = clipboardHtml(editor, from, to)
    editor.commands.setTextSelection(to)
    editor.view.pasteHTML(html)
    expect(texts(editor)[0]).toBe('Due on 5/6/20245/6/2024 at noon')
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`${LOCKED.open}[5/6/2024]${LOCKED.close}[5/6/2024][ at noon]`)
    editor.commands.undo()
    expect(texts(editor)[0]).toBe('Due on 5/6/2024 at noon')
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
  })

  it('cut and pasted elsewhere, it moves with its text', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + OTHER)
    const from = posOf(editor, '5/6/2024')
    const to = from + '5/6/2024'.length
    const html = clipboardHtml(editor, from, to)
    editor.commands.deleteRange({ from, to })
    pasteAtEnd(editor, html)
    const { xml, controls, ids } = await saved(editor, parsed)
    expect([controls, ids]).toEqual([1, 1])
    expect(skeleton(xml)).toContain(
      `[Untouched paragraph]${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}</w:p>`,
    )
  })

  it('pasted blocks that replace an empty paragraph bring no second control either', async () => {
    const { editor, parsed } = await open(around(UNLOCKED) + '<w:p/>')
    // the App's own paste lane: whole blocks put in place of the empty paragraph
    const copy = editor.state.doc.child(0).copy(editor.state.doc.child(0).content)
    const at = editor.state.doc.child(0).nodeSize
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(at, at + editor.state.doc.child(1).nodeSize, copy)
        .setMeta(PASTED_CONTENT, true),
    )
    expect(texts(editor)).toEqual(['Due on 5/6/2024 at noon', 'Due on 5/6/2024 at noon'])
    const { xml, controls, ids } = await saved(editor, parsed)
    expect([controls, ids]).toEqual([1, 1])
    expect(skeleton(xml)).toContain(
      `[Due on ]${UNLOCKED.open}[5/6/2024]${UNLOCKED.close}[ at noon]`,
    )
  })

  it('range markers move with a cut and are not doubled by a copy', async () => {
    const perm = KINDS['w:permStart / w:permEnd']
    const { editor, parsed } = await open(around(perm) + OTHER)
    const from = posOf(editor, '5/6/2024') - 1
    const to = from + '5/6/2024'.length + 2
    const html = clipboardHtml(editor, from, to)
    editor.commands.deleteRange({ from, to })
    pasteAtEnd(editor, html)
    const moved = await save(editor, parsed)
    expect(skeleton(moved.xml)).toContain(
      `[Untouched paragraph]${perm.open}[5/6/2024]${perm.close}</w:p>`,
    )
    // a second paste of the same clipboard is a copy: the text arrives, the markers do not
    pasteAtEnd(editor, html)
    const copied = await save(editor, parsed)
    expect(texts(editor)[1]).toBe('Untouched paragraph5/6/20245/6/2024')
    expect(occurrences(copied.xml, '<w:permStart')).toBe(1)
    expect(occurrences(copied.xml, '<w:permEnd')).toBe(1)
  })
})

describe('the same paragraph inside a text box', () => {
  it('clearing formatting in the box keeps the control when the box is written back', async () => {
    // the text box source is read through the parse tree, so the control's
    // properties are written in the form a serializer produces
    const pr = '<w:sdtPr><w:tag w:val="due"/><w:id w:val="5"/></w:sdtPr>'
    const inner =
      '<w:p><w:r><w:t xml:space="preserve">Due on </w:t></w:r>' +
      `<w:sdt>${pr}<w:sdtContent><w:r><w:rPr><w:b/></w:rPr><w:t>5/6/2024</w:t></w:r></w:sdtContent></w:sdt></w:p>`
    const box =
      '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" type="#_x0000_t202" ' +
      'style="width:200pt;height:50pt"><v:textbox>' +
      `<w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const source = await buildDocx({ bodyXml: box + OTHER })
    const parsed = await parseDocx(source)
    const host = document.createElement('div')
    document.body.append(host)
    const editor = new Editor({
      element: host,
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    editors.push(editor)
    const subDom = editor.view.dom.querySelector('.doc-textbox .doc-textbox-editor')
    // tiptap exposes the Editor instance on its root DOM element
    const sub = subDom && 'editor' in subDom ? (subDom.editor as Editor) : undefined
    if (!sub) throw new Error('the text box has no editor')
    sub.chain().selectAll().unsetAllMarks().run()
    window.dispatchEvent(new Event('ai-docs-commit-tables'))
    const { xml } = await save(editor, parsed)
    host.remove()
    expect(xml).not.toContain('<w:b/>')
    expect(skeleton(xml)).toContain(
      `[Due on ]<w:sdt>${pr}<w:sdtContent>[5/6/2024]</w:sdtContent></w:sdt>`,
    )
  })
})
