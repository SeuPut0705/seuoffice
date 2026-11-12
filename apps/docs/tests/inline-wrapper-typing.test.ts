import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx, type ParsedDocFull } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { takeOdtRefusal } from '../src/renderer/odt-gate'

/**
 * Where typed text lands at the edges of a content control. The caret has one
 * position between the last letter of a control and the text behind it, so the
 * editor picks a side: the end of a control belongs to the control (typing
 * there adds to it, as in Word), the start does not. Each test types the way
 * the browser hands text to the editor and reads the saved XML.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
;(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {}

const LOCK = '<w:lock w:val="contentLocked"/>'
const open = (locked = false) =>
  `<w:sdt><w:sdtPr><w:tag w:val="name"/><w:id w:val="77"/>${locked ? LOCK : ''}</w:sdtPr><w:sdtContent>`
const OPEN = open()
const CLOSE = '</w:sdtContent></w:sdt>'
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const para = (inner: string) => `<w:p>${inner}</w:p>`
const OTHER = para(run('Untouched paragraph'))
const NAME = para(run('Name: ') + OPEN + run('Hong') + CLOSE + run(' end'))

/** the xml with every text run reduced to [its text]: what sits around the runs stays visible */
const skeleton = (xml: string) =>
  xml.replace(/<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g, '[$1]')
const controls = (xml: string) => xml.split('<w:sdt>').length - 1

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  takeOdtRefusal()
})

async function load(bodyXml: string) {
  const parsed = await parseDocx(await buildDocx({ bodyXml }))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  return { editor, parsed }
}

async function saved(editor: Editor, parsed: ParsedDocFull): Promise<string> {
  const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
  return (await parseDocx(await saveDocx(parsed, plan.saveBlocks))).internal.documentXml
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

/** feed characters the way the browser does: through handleTextInput, plain insert when nothing takes them */
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { view } = editor
    const { from, to } = view.state.selection
    const deflt = () => view.state.tr.insertText(ch, from, to)
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt))
    if (!handled) view.dispatch(deflt())
  }
}

const press = (editor: Editor, key: string) =>
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )

describe('typing at the edges of a content control', () => {
  it('at its end, the typed text joins the control', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    type(editor, 'sa')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`[Name: ]${OPEN}[Hongsa]${CLOSE}[ end]`)
    expect(controls(xml)).toBe(1)
  })

  it('at its end when it ends the paragraph, the typed text joins the control', async () => {
    const { editor, parsed } = await load(para(run('Name: ') + OPEN + run('Hong') + CLOSE) + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    type(editor, 's')
    expect(skeleton(await saved(editor, parsed))).toContain(`[Name: ]${OPEN}[Hongs]${CLOSE}</w:p>`)
  })

  it('at its start, the typed text stays in front of it', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong'))
    type(editor, 'Mr ')
    expect(skeleton(await saved(editor, parsed))).toContain(
      `[Name: Mr ]${OPEN}[Hong]${CLOSE}[ end]`,
    )
  })

  it('at the start of a paragraph that begins with it, the typed text stays in front of it', async () => {
    const { editor, parsed } = await load(para(OPEN + run('Hong') + CLOSE + run(' end')) + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong'))
    type(editor, 'Mr ')
    expect(skeleton(await saved(editor, parsed))).toContain(
      `<w:p>[Mr ]${OPEN}[Hong]${CLOSE}[ end]</w:p>`,
    )
  })

  it('Enter at its end starts a paragraph outside it', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    press(editor, 'Enter')
    type(editor, 'next')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`[Name: ]${OPEN}[Hong]${CLOSE}</w:p><w:p>[next end]</w:p>`)
    expect(controls(xml)).toBe(1)
  })

  it('at the end of one locked against editing, the typed text lands behind it', async () => {
    const locked = open(true)
    const { editor, parsed } = await load(
      para(run('Name: ') + locked + run('Hong') + CLOSE + run(' end')) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    type(editor, 's')
    expect(takeOdtRefusal()).toBeNull()
    expect(skeleton(await saved(editor, parsed))).toContain(
      `[Name: ]${locked}[Hong]${CLOSE}[s end]`,
    )
  })

  it('plain text pasted at its end lands behind it: a paste never adds to a control the document holds', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    editor.view.pasteText('zz')
    expect(skeleton(await saved(editor, parsed))).toContain(`[Name: ]${OPEN}[Hong]${CLOSE}[zz end]`)
  })

  it('in a table cell, typing at its end joins the control too', async () => {
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${NAME}</w:tc></w:tr></w:tbl>`
    const { editor, parsed } = await load(table + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    type(editor, 's')
    expect(skeleton(await saved(editor, parsed))).toContain(`[Name: ]${OPEN}[Hongs]${CLOSE}[ end]`)
  })
})

describe('a composition (an IME) at the edges of a content control', () => {
  // the marks the caret holds when the composition starts are the ones its
  // text is drawn with, before any of it reaches the document
  const composingInControl = (editor: Editor) => {
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const { storedMarks, selection } = editor.state
    return (storedMarks ?? selection.$from.marks()).some((mark) => mark.type.name === 'inlineWrap')
  }

  it('at its end, it is composed inside the control', async () => {
    const { editor } = await load(NAME + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    expect(composingInControl(editor)).toBe(true)
  })

  it('at the end of a locked one, it is composed behind it', async () => {
    const { editor } = await load(
      para(run('Name: ') + open(true) + run('Hong') + CLOSE + run(' end')) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    expect(composingInControl(editor)).toBe(false)
  })

  it('at the end of a smart tag, it is composed behind it', async () => {
    const { editor } = await load(
      para(
        run('Name: ') +
          '<w:smartTag w:uri="urn:place" w:element="city">' +
          run('Seoul') +
          '</w:smartTag>' +
          run(' end'),
      ) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    expect(composingInControl(editor)).toBe(false)
  })

  it('at the start of a paragraph that begins with it, it is composed in front of it', async () => {
    const { editor } = await load(para(OPEN + run('Hong') + CLOSE + run(' end')) + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Hong'))
    expect(composingInControl(editor)).toBe(false)
  })
})

describe('typing over a selection that holds a content control', () => {
  it('all of its text selected: the typed text is what the control holds now', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    const from = posOf(editor, 'Hong')
    editor.commands.setTextSelection({ from, to: from + 4 })
    type(editor, 'Kim')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`[Name: ]${OPEN}[Kim]${CLOSE}[ end]`)
    expect(controls(xml)).toBe(1)
  })

  it('a selection from inside it to beyond its end: the typed text stays in the control', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    const from = posOf(editor, 'Hong') + 2
    editor.commands.setTextSelection({ from, to: from + 4 })
    type(editor, 'ly')
    expect(skeleton(await saved(editor, parsed))).toContain(`[Name: ]${OPEN}[Holy]${CLOSE}[nd]`)
  })

  it('a selection that starts in front of it: the typed text replaces the control', async () => {
    const { editor, parsed } = await load(NAME + OTHER)
    const from = posOf(editor, 'Name: ') + 5
    editor.commands.setTextSelection({ from, to: from + 5 })
    type(editor, '-')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain('<w:p>[Name:- end]</w:p>')
    expect(controls(xml)).toBe(0)
  })
})

describe('the end of a wrapper that is not a plain content control', () => {
  // only an unlocked content control that shows its own text takes what is
  // typed at its end; every other wrapper ends where the file has it end
  const SMART = '<w:smartTag w:uri="urn:place" w:element="city">'
  const CUSTOM = '<w:customXml w:uri="urn:x" w:element="city">'
  const DIR = '<w:dir w:val="rtl">'
  const BDO = '<w:bdo w:val="rtl">'
  const PLACEHOLDER = '<w:sdt><w:sdtPr><w:id w:val="88"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>'
  const tagged = (open: string, close: string) =>
    para(run('Name: ') + open + run('Seoul') + close + run(' end'))

  it.each([
    ['w:smartTag', SMART, '</w:smartTag>'],
    ['w:customXml', CUSTOM, '</w:customXml>'],
    ['w:dir', DIR, '</w:dir>'],
    ['w:bdo', BDO, '</w:bdo>'],
  ])('%s: text typed at its end lands behind it', async (_name, open, close) => {
    const { editor, parsed } = await load(tagged(open, close) + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    type(editor, 'xy')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${open}[Seoul]${close}[xy end]`)
    expect(xml.split(open).length - 1).toBe(1)
  })

  it('w:smartTag: lines pasted at its end make no new tags', async () => {
    const { editor, parsed } = await load(tagged(SMART, '</w:smartTag>') + OTHER)
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    editor.view.pasteText('one\ntwo')
    const xml = await saved(editor, parsed)
    expect(xml.split('<w:smartTag').length - 1).toBe(1)
  })

  it.each([
    ['w:smartTag', SMART, '</w:smartTag>'],
    ['w:customXml', CUSTOM, '</w:customXml>'],
    ['w:dir', DIR, '</w:dir>'],
    ['w:bdo', BDO, '</w:bdo>'],
  ])(
    '%s: text typed over its last letters is one piece behind it, as before',
    async (_name, open, close) => {
      const { editor, parsed } = await load(tagged(open, close) + OTHER)
      const from = posOf(editor, 'Seoul') + 3
      editor.commands.setTextSelection({ from, to: from + 2 })
      type(editor, 'ZZ')
      const xml = await saved(editor, parsed)
      // the typed text is never split between the wrapper and what follows it
      expect(skeleton(xml)).toContain(`${open}[Seo]${close}[ZZ end]`)
      expect(xml.split(open).length - 1).toBe(1)
    },
  )

  it.each([
    ['w:smartTag', SMART, '</w:smartTag>'],
    ['w:customXml', CUSTOM, '</w:customXml>'],
    ['w:dir', DIR, '</w:dir>'],
    ['w:bdo', BDO, '</w:bdo>'],
  ])('%s: text pasted over its last letters stays inside it', async (_name, open, close) => {
    const { editor, parsed } = await load(tagged(open, close) + OTHER)
    const from = posOf(editor, 'Seoul') + 3
    editor.commands.setTextSelection({ from, to: from + 2 })
    editor.view.pasteText('ZZ')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${open}[SeoZZ]${close}[ end]`)
    expect(xml.split(open).length - 1).toBe(1)
  })

  it.each([
    ['w:smartTag', SMART, '</w:smartTag>'],
    ['w:customXml', CUSTOM, '</w:customXml>'],
    ['w:dir', DIR, '</w:dir>'],
    ['w:bdo', BDO, '</w:bdo>'],
    ['a control showing its placeholder', PLACEHOLDER, CLOSE],
    [
      'a plain-text control showing its placeholder',
      '<w:sdt><w:sdtPr><w:tag w:val="name"/><w:id w:val="89"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent>',
      CLOSE,
    ],
  ])(
    '%s: a word typed over all of its text is one word, the wrapper replaced',
    async (_name, open, close) => {
      const { editor, parsed } = await load(tagged(open, close) + OTHER)
      const from = posOf(editor, 'Seoul')
      editor.commands.setTextSelection({ from, to: from + 5 })
      type(editor, 'Kim')
      const xml = await saved(editor, parsed)
      const paragraph = xml.slice(0, xml.indexOf('Untouched paragraph'))
      expect([...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).toBe(
        'Name: Kim end',
      )
      // as before the mark was inclusive: the word replaced the wrapper, no piece of it kept one
      expect(paragraph).not.toMatch(/<w:(?:sdt|smartTag|customXml|dir|bdo)\b/)
    },
  )

  it('w:smartTag: a word typed over a selection from its start into the next paragraph is one word', async () => {
    const { editor, parsed } = await load(tagged(SMART, '</w:smartTag>') + OTHER)
    const from = posOf(editor, 'Seoul')
    editor.commands.setTextSelection({ from, to: posOf(editor, 'paragraph') })
    type(editor, 'Kim')
    const xml = await saved(editor, parsed)
    expect(xml).not.toContain('<w:smartTag')
    expect([...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).toBe(
      'Name: Kimparagraph',
    )
  })

  it('a control inside a w:dir: text typed at their end lands behind both', async () => {
    const { editor, parsed } = await load(
      para(run('Name: ') + DIR + OPEN + run('Seoul') + CLOSE + '</w:dir>' + run(' end')) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    type(editor, 'xy')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${DIR}${OPEN}[Seoul]${CLOSE}</w:dir>[xy end]`)
  })

  it('a w:dir inside a control: text typed at their end joins the control, not the w:dir', async () => {
    const { editor, parsed } = await load(
      para(
        run('Name: ') + OPEN + run('in ') + DIR + run('Seoul') + '</w:dir>' + CLOSE + run(' z'),
      ) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    type(editor, 'xy')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${DIR}[Seoul]</w:dir>[xy]${CLOSE}[ z]`)
    expect(xml.split(DIR).length - 1).toBe(1)
  })

  it('a locked control holding a w:dir: text typed at its end is plain text behind it', async () => {
    const locked = open(true)
    const { editor, parsed } = await load(
      para(
        run('Name: ') + locked + run('in ') + DIR + run('Seoul') + '</w:dir>' + CLOSE + run(' z'),
      ) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    type(editor, 'XY')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${CLOSE}[XY z]`)
    expect(xml.split(DIR).length - 1).toBe(1)
  })

  it('a locked control holding a w:dir: text pasted at its end is plain text behind it', async () => {
    const locked = open(true)
    const { editor, parsed } = await load(
      para(
        run('Name: ') + locked + run('in ') + DIR + run('Seoul') + '</w:dir>' + CLOSE + run(' z'),
      ) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Seoul') + 5)
    editor.view.pasteText('XY')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${CLOSE}[XY z]`)
    expect(xml.split(DIR).length - 1).toBe(1)
  })

  it('a control showing its placeholder: text typed at its end lands behind it, and it stays a placeholder', async () => {
    const { editor, parsed } = await load(
      para(run('Name: ') + PLACEHOLDER + run('Click here') + CLOSE + run(' end')) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Click here') + 10)
    type(editor, 'xy')
    const xml = await saved(editor, parsed)
    expect(skeleton(xml)).toContain(`${PLACEHOLDER}[Click here]${CLOSE}[xy end]`)
  })

  it('a control inside a hyperlink that starts before it: typing at its end keeps the link whole', async () => {
    const link = '<w:hyperlink w:anchor="target">'
    const { editor, parsed } = await load(
      para(
        run('Name: ') +
          link +
          run('see ') +
          OPEN +
          run('Hong') +
          CLOSE +
          '</w:hyperlink>' +
          run(' end'),
      ) + OTHER,
    )
    editor.commands.setTextSelection(posOf(editor, 'Hong') + 4)
    type(editor, 'xy')
    const xml = await saved(editor, parsed)
    expect(xml.split('<w:hyperlink').length - 1).toBe(1)
    expect(controls(xml)).toBe(1)
    expect(skeleton(xml)).toMatch(
      /<w:hyperlink [^>]*>(?:<w:r>.*?<\/w:r>|\[see \])<w:sdt>.*?\[Hong\]<\/w:sdtContent><\/w:sdt><\/w:hyperlink>/,
    )
  })
})
