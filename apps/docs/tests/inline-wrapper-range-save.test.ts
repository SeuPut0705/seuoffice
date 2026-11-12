import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { parseDocx, saveDocx, type HeaderFooter, type ParsedDocFull } from '@seuoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { mountHfEditor } from '../src/renderer/editor/hf-editor'

/**
 * The file says what the screen says about where a content control sits. A
 * paragraph whose text and formatting are the file's still counts as edited
 * when the control in the editor covers text the file's control does not: it
 * grew over a neighbouring character, or it moved to other text. Each test
 * opens a document the way the editor does, edits it through the editor and
 * reads the saved XML.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
;(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {}

const PR = '<w:sdtPr><w:tag w:val="name"/><w:id w:val="77"/></w:sdtPr>'
const OPEN = `<w:sdt>${PR}<w:sdtContent>`
const CLOSE = '</w:sdtContent></w:sdt>'
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const control = (text: string) => OPEN + run(text) + CLOSE
const para = (inner: string) => `<w:p>${inner}</w:p>`
const OTHER = para(run('Untouched paragraph'))
/** the paragraph of the report: `Name: [Hong] end`, and the same with an s behind the control */
const NAME = para(run('Name: ') + control('Hong') + run(' end'))
const NAME_S = para(run('Name: ') + control('Hong') + run('s end'))
const GROWN = `[Name: ]${OPEN}[Hongs]${CLOSE}[ end]`

/** the xml with every text run reduced to [its text]: what sits around the runs stays visible */
const skeleton = (xml: string) =>
  xml.replace(/<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g, '[$1]')

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

async function open(bodyXml: string) {
  const source = await buildDocx({ bodyXml })
  const parsed = await parseDocx(source)
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor({
    element: host,
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
  return { bytes, xml: reparsed.internal.documentXml, reparsed }
}

/**
 * What the app does once a save has landed: the saved bytes become the
 * document the next save compares against, and the editor is redrawn from
 * them only when it shows something else (so undo survives an equal reload).
 */
function rebase(editor: Editor, reparsed: ParsedDocFull): { redrawn: boolean } {
  const rebased = blocksToPmDoc(reparsed.blocks)
  if (editor.state.doc.eq(editor.schema.nodeFromJSON(rebased))) return { redrawn: false }
  editor.commands.setContent(rebased as never)
  return { redrawn: true }
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

/** the text the control mark stands on, one entry per stretch */
function controlTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'inlineWrap'))
      out.push(node.text ?? '')
  })
  return out
}

/** every text block of the document, at any depth */
function lines(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent)
  })
  return out
}

/**
 * `Name: [Hong]s end` turned into `Name: [Hongs] end` by hand: the s behind
 * the control is deleted, `gs` is typed inside the control before its last
 * letter, and that letter is deleted. The text is what it was.
 */
function growOverTheS(editor: Editor): void {
  const behind = posOf(editor, 's end')
  editor.commands.deleteRange({ from: behind, to: behind + 1 })
  const lastLetter = posOf(editor, 'Hong') + 3
  editor.commands.insertContentAt(lastLetter, 'gs')
  editor.commands.deleteRange({ from: lastLetter + 2, to: lastLetter + 3 })
}

describe('a control that covers more text than the file has in it is saved where the editor shows it', () => {
  it('the s typed behind a control, saved, taken back and typed inside it: the second save has it inside', async () => {
    const { editor, parsed } = await open(NAME + OTHER)
    // a character that lands behind the control, outside it
    const behind = posOf(editor, ' end')
    editor.view.dispatch(editor.state.tr.insert(behind, editor.schema.text('s')))
    expect(controlTexts(editor)).toEqual(['Hong'])
    const first = await save(editor, parsed)
    expect(skeleton(first.xml)).toContain(`[Name: ]${OPEN}[Hong]${CLOSE}[s end]`)
    // the editor already shows what the file holds, so the s can still be undone
    expect(rebase(editor, first.reparsed).redrawn).toBe(false)

    editor.commands.undo()
    expect(lines(editor)[0]).toBe('Name: Hong end')
    const lastLetter = posOf(editor, 'Hong') + 3
    editor.commands.insertContentAt(lastLetter, 'gs')
    editor.commands.deleteRange({ from: lastLetter + 2, to: lastLetter + 3 })
    expect(lines(editor)[0]).toBe('Name: Hongs end')
    expect(controlTexts(editor)).toEqual(['Hongs'])

    const second = await save(editor, first.reparsed)
    expect(skeleton(second.xml)).toContain(GROWN)
    expect(second.xml).toContain(OTHER)
    // and the reload after that save leaves the screen as it is
    expect(rebase(editor, second.reparsed).redrawn).toBe(false)
  })

  it('a control grown over the character behind it is written around that character', async () => {
    const { editor, parsed } = await open(NAME_S + OTHER)
    growOverTheS(editor)
    expect(lines(editor)[0]).toBe('Name: Hongs end')
    expect(controlTexts(editor)).toEqual(['Hongs'])
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(GROWN)
  })

  it('a control cut from its word and pasted over the same word further on is written there', async () => {
    const { editor, parsed } = await open(para(control('Hong') + run(' or Hong')) + OTHER)
    const from = posOf(editor, 'Hong')
    const cut = editor.view.serializeForClipboard(editor.state.doc.slice(from, from + 4)).dom
      .innerHTML
    editor.commands.deleteRange({ from, to: from + 4 })
    editor.commands.insertContentAt(from, 'Hong')
    const second = posOf(editor, ' or Hong') + 4
    editor.commands.setTextSelection({ from: second, to: second + 4 })
    editor.view.pasteHTML(cut)
    expect(lines(editor)[0]).toBe('Hong or Hong')
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`<w:p>[Hong or ]${OPEN}[Hong]${CLOSE}</w:p>`)
    expect(xml.split('<w:sdt>').length - 1).toBe(1)
  })

  it('in a table cell, the grown control is written around the character too', async () => {
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${NAME_S}</w:tc></w:tr></w:tbl>`
    const { editor, parsed, source } = await open(table + OTHER)
    const untouched = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, untouched.saveBlocks)).toEqual(source)

    growOverTheS(editor)
    expect(lines(editor)[0]).toBe('Name: Hongs end')
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(GROWN)
    expect(xml).toContain(OTHER)
  })

  it('in a header, the grown control is handed over and written around the character', async () => {
    const header =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `${NAME_S}</w:hdr>`
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
    growOverTheS(handle.editor)
    expect(handle.editor.state.doc.textContent).toBe('Name: Hongs end')
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
    expect(skeleton(hdr)).toContain(GROWN)
  })

  it('in a text box, the grown control is written around the character too', async () => {
    const box =
      '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" type="#_x0000_t202" ' +
      'style="width:200pt;height:50pt"><v:textbox>' +
      `<w:txbxContent>${NAME_S}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const { editor, parsed } = await open(box + OTHER)
    const subDom = editor.view.dom.querySelector('.doc-textbox .doc-textbox-editor')
    // tiptap exposes the Editor instance on its root DOM element
    const sub = subDom && 'editor' in subDom ? (subDom.editor as Editor) : undefined
    if (!sub) throw new Error('the text box has no editor')
    growOverTheS(sub)
    expect(sub.state.doc.textContent).toBe('Name: Hongs end')
    window.dispatchEvent(new Event('ai-docs-commit-tables'))
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(GROWN)
  })
})

describe('a control that covers less text than the file has in it keeps the file as it is', () => {
  it('Enter inside it, the halves joined again and saved: the reload draws the control over all of its text', async () => {
    const { editor, parsed, source } = await open(
      para(run('Due on ') + control('5/6/2024') + run(' at noon')) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, '6/2024'))
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    editor.commands.joinBackward()
    expect(lines(editor)).toEqual(['Due on 5/6/2024 at noon', 'Untouched paragraph'])
    // no command shrinks a control: the split left it on the first half only
    expect(controlTexts(editor)).toEqual(['5/'])
    const { bytes, reparsed } = await save(editor, parsed)
    expect(bytes).toEqual(source)
    expect(rebase(editor, reparsed).redrawn).toBe(true)
    expect(controlTexts(editor)).toEqual(['5/6/2024'])
  })
})

describe('a nested wrapper the editor no longer shows', () => {
  // a smart tag inside the control: the control covers all three words, the
  // tag the middle one
  const TAG_OPEN = '<w:smartTag w:uri="urn:place" w:element="city">'
  const NESTED = para(
    run('Code: ') +
      OPEN +
      run('A ') +
      TAG_OPEN +
      run('Seoul') +
      '</w:smartTag>' +
      run(' B') +
      CLOSE +
      run(' end'),
  )

  /** the middle word keeps the control and loses the tag, as a peer or a rewrite may leave it */
  function dropTheTag(editor: Editor): void {
    const at = posOf(editor, 'Seoul')
    const outer = editor.state.doc
      .nodeAt(posOf(editor, 'A '))!
      .marks.find((mark) => mark.type.name === 'inlineWrap')!
    editor.view.dispatch(editor.state.tr.addMark(at, at + 'Seoul'.length, outer))
  }

  it('in a paragraph: the control covers what it covered, so the file is the one that was opened', async () => {
    const { editor, parsed, source } = await open(NESTED + OTHER)
    dropTheTag(editor)
    expect(controlTexts(editor)).toEqual(['A Seoul B'])
    const { bytes } = await save(editor, parsed)
    expect(bytes).toEqual(source)
  })

  it('in a table cell: the file is the one that was opened', async () => {
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${NESTED}</w:tc></w:tr></w:tbl>`
    const { editor, parsed, source } = await open(table + OTHER)
    dropTheTag(editor)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
  })

  it('the control grown over the word behind it is still an edit', async () => {
    const { editor, parsed } = await open(NESTED + OTHER)
    dropTheTag(editor)
    const behind = posOf(editor, ' end')
    const outer = editor.state.doc
      .nodeAt(posOf(editor, 'A '))!
      .marks.find((mark) => mark.type.name === 'inlineWrap')!
    editor.view.dispatch(editor.state.tr.addMark(behind, behind + 1, outer))
    const { xml } = await save(editor, parsed)
    expect(skeleton(xml)).toContain(`${OPEN}[A Seoul B ]${CLOSE}[end]`)
  })
})
