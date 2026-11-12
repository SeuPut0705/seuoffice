import { afterEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import {
  buildBlankDocx,
  PAGE_MARK,
  parseDocx,
  saveDocx,
  TOTAL_PAGES_MARK,
  type HeaderFooter,
  type SaveBlock,
} from '@genoffice/docx-engine'
import {
  hfDocJson,
  hfValueFromDoc,
  insertHfField,
  insertHfInstrField,
  mountHfEditor,
  type HfEditorHandle,
} from '../src/renderer/editor/hf-editor'
import type { PmNode } from '../src/renderer/editor/convert'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'

const handles: HfEditorHandle[] = []
afterEach(() => {
  for (const h of handles.splice(0)) {
    if (!h.editor.isDestroyed) h.exit()
  }
})

function mount(value: HeaderFooter, onCommit: (next: HeaderFooter) => void = () => {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const handle = mountHfEditor(host, {
    value,
    pageNo: '3',
    pageTotal: '9',
    spellcheck: false,
    onCommit,
    onExit: () => host.remove(),
  })
  handles.push(handle)
  return { host, handle, editor: handle.editor as Editor }
}

const RICH: HeaderFooter = {
  text: '',
  pageNumber: true,
  paras: [
    { runs: [], cells: [{ paras: [[{ text: 'logo row' }]] }] },
    {
      align: 'right',
      tabStops: [{ pos: 4680, val: 'right' }],
      runs: [
        { text: 'Report', bold: true },
        { text: '\tPage ' },
        { text: PAGE_MARK, italic: true },
        { text: ` of ${TOTAL_PAGES_MARK}` },
      ],
    },
    { align: 'center', runs: [{ text: 'second line', color: 'FF0000' }] },
  ],
}

describe('hfDocJson / hfValueFromDoc', () => {
  it('maps text paragraphs to editor nodes with field atoms and keeps rows out', () => {
    const doc = hfDocJson(RICH)
    expect(doc.content).toHaveLength(2)
    const first = doc.content![0]
    expect(first.attrs).toMatchObject({ align: 'right', hfIndex: 1 })
    expect(JSON.parse(String(first.attrs!.tabStops))).toEqual([{ pos: 4680, val: 'right' }])
    const types = (first.content ?? []).map((n) => n.type)
    expect(types).toEqual(['text', 'text', 'hfField', 'text', 'hfField'])
    const fields = (first.content ?? []).filter((n) => n.type === 'hfField')
    expect(fields.map((n) => n.attrs?.kind)).toEqual(['PAGE', 'NUMPAGES'])
    // the sentinel's own formatting stays on the atom
    expect(fields[0].marks).toEqual([{ type: 'italic' }])
  })

  it('round-trips unchanged content and splices the row back at its slot', () => {
    const back = hfValueFromDoc(hfDocJson(RICH), RICH)
    expect(back.paras).toHaveLength(3)
    expect(back.paras![0].cells).toBeTruthy()
    expect(back.paras![1]).toMatchObject({
      align: 'right',
      tabStops: [{ pos: 4680, val: 'right' }],
    })
    expect(back.paras![1].runs.map((r) => r.text).join('')).toBe(
      `Report\tPage ${PAGE_MARK} of ${TOTAL_PAGES_MARK}`,
    )
    expect(back.paras![1].runs[0]).toMatchObject({ text: 'Report', bold: true })
    expect(back.paras![1].runs.find((r) => r.text === PAGE_MARK)).toMatchObject({ italic: true })
    expect(back.paras![2].runs[0]).toMatchObject({ text: 'second line', color: 'FF0000' })
    expect(back.pageNumber).toBe(true)
  })

  it('a new paragraph split from an existing one inherits that paragraph as its template', () => {
    const doc = hfDocJson(RICH)
    const [p1, p2] = doc.content!
    const extra: PmNode = {
      type: 'docParagraph',
      attrs: { ...p1.attrs },
      content: [{ type: 'text', text: 'new' }],
    }
    const back = hfValueFromDoc({ type: 'doc', content: [p1, extra, p2] }, RICH)
    expect(back.paras!.map((p) => p.align)).toEqual([undefined, 'right', 'right', 'center'])
    expect(back.paras![2].runs[0].text).toBe('new')
    expect(back.text).toBe(`Report\tPage ${PAGE_MARK} of ${TOTAL_PAGES_MARK}newsecond line`)
  })

  it('an empty legacy value edits as one paragraph; a typed PAGE field sets pageNumber', () => {
    const doc = hfDocJson({ text: '' })
    expect(doc.content).toHaveLength(1)
    const back = hfValueFromDoc(
      {
        type: 'doc',
        content: [
          {
            type: 'docParagraph',
            attrs: { align: 'center' },
            content: [{ type: 'hfField', attrs: { kind: 'PAGE' } }],
          },
        ],
      },
      { text: '' },
    )
    expect(back.paras![0].runs[0].text).toBe(PAGE_MARK)
    expect(back.pageNumber).toBe(true)
  })
})

describe('mountHfEditor', () => {
  it('renders field atoms with the live numbers and commits typed formatting on exit', () => {
    const commits: HeaderFooter[] = []
    const { host, handle, editor } = mount(RICH, (next) => commits.push(next))
    const fields = host.querySelectorAll('.hf-field')
    expect(Array.from(fields, (f) => f.getAttribute('data-hf-num'))).toEqual(['3', '9'])
    editor.commands.focus('end')
    editor.chain().insertContent(' tail').setMark('bold').run()
    editor.commands.insertContent('X')
    expect(
      handle
        .changed()
        ?.paras?.[2].runs.map((r) => r.text)
        .join(''),
    ).toBe('second line tailX')
    handle.exit()
    expect(commits).toHaveLength(1)
    const last = commits[0].paras![2]
    expect(last.runs.at(-1)).toMatchObject({ text: 'X', bold: true })
    expect(editor.isDestroyed).toBe(true)
  })

  it('does not commit when nothing changed', () => {
    let commits = 0
    const { handle } = mount(RICH, () => commits++)
    handle.exit()
    expect(commits).toBe(0)
  })

  it('stays open when its strip is detached under the caret, exits on a real blur', async () => {
    const { host, editor } = mount(RICH)
    const blur = () => editor.view.dom.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    // Blink blurs the focused element before removing it: the host is still connected
    blur()
    host.remove()
    await Promise.resolve()
    expect(editor.isDestroyed).toBe(false)
    document.body.append(host)
    blur()
    expect(editor.isDestroyed).toBe(false)
    await Promise.resolve()
    expect(editor.isDestroyed).toBe(true)
  })

  it('inserts PAGE / NUMPAGES atoms and DATE fields through the ribbon helpers', () => {
    const commits: HeaderFooter[] = []
    const { handle, editor } = mount({ text: '' }, (next) => commits.push(next))
    insertHfField(editor, 'PAGE')
    editor.commands.insertContent(' / ')
    insertHfField(editor, 'NUMPAGES')
    insertHfInstrField(editor, 'DATE', '2026-09-23')
    handle.exit()
    const runs = commits[0].paras![0].runs
    expect(runs.map((r) => r.text).join('')).toBe(`${PAGE_MARK} / ${TOTAL_PAGES_MARK}2026-09-23`)
    expect(runs.at(-1)).toMatchObject({ text: '2026-09-23', instrField: 'DATE' })
    expect(commits[0].pageNumber).toBe(true)
  })
})

describe('edited header saves with its formatting', () => {
  it('bold run, tab, PAGE and NUMPAGES fields survive save and reparse', async () => {
    const parsed = await parseDocx(await buildBlankDocx())
    const saveBlocks: SaveBlock[] = parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))
    let committed: HeaderFooter | null = null
    const { handle, editor } = mount({ text: '' }, (next) => (committed = next))
    editor.commands.focus('end')
    editor.commands.insertContent([
      { type: 'text', text: 'Title', marks: [{ type: 'bold' }] },
      { type: 'text', text: '\tp. ' },
    ])
    insertHfField(editor, 'PAGE')
    handle.exit()
    const saved = await saveDocx(parsed, saveBlocks, { header: committed! })
    const zip = await (await import('jszip')).default.loadAsync(saved)
    const hdr = await zip.file('word/header1.xml')!.async('string')
    expect(hdr).toMatch(/<w:r><w:rPr><w:b\/>.*<\/w:rPr><w:t[^>]*>Title<\/w:t>/)
    expect(hdr).toContain('<w:tab/>')
    expect(hdr).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>')
    const reparsed = await parseDocx(saved)
    expect(reparsed.headerParas![0].runs[0]).toMatchObject({ text: 'Title', bold: true })
    expect(reparsed.headerHasPageNumber).toBe(true)
  })
})

describe('a header or footer that reads as it did is not committed', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
  const sdt = (text: string, id: number) =>
    `<w:sdt><w:sdtPr><w:id w:val="${id}"/></w:sdtPr><w:sdtContent>${run(text)}</w:sdtContent></w:sdt>`
  const ONE = `<w:p>${run('Doc ')}${sdt('Annual report', 5)}${run(' end')}</w:p>`
  const TWINS = `<w:p>${run('From ')}${sdt('2024', 5)}${run(' to ')}${sdt('2024', 6)}</w:p>`
  const TABLE =
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>${run('logo')}</w:p></w:tc></w:tr></w:tbl>`

  /** the part of a document as the app hands it to the header editor, mounted */
  async function open(inner: string, kind: 'header' | 'footer' = 'header') {
    const tag = kind === 'header' ? 'hdr' : 'ftr'
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p>${run('Body')}</w:p>`,
        extraParts: [
          {
            path: `word/${kind}1.xml`,
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} ${W}>${inner}</w:${tag}>`,
            contentType: `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`,
          },
        ],
        extraRels: `<Relationship Id="rId40" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${kind}1.xml"/>`,
        sectPrExtra: `<w:${kind}Reference w:type="default" r:id="rId40"/>`,
      }),
    )
    const value: HeaderFooter =
      kind === 'header'
        ? { text: parsed.headerText ?? '', paras: parsed.headerParas ?? [] }
        : { text: parsed.footerText ?? '', paras: parsed.footerParas ?? [] }
    const commits: HeaderFooter[] = []
    return { ...mount(value, (next) => commits.push(next)), commits }
  }
  /** the first `text` deleted and `typed` put in its place, as a person retypes it */
  function retype(editor: Editor, text: string, typed = text) {
    let from = -1
    editor.state.doc.descendants((node, pos) => {
      if (from !== -1 || !node.isTextblock) return
      const at = node.textContent.indexOf(text)
      if (at !== -1) from = pos + 1 + at
    })
    editor.commands.deleteRange({ from, to: from + text.length })
    editor.commands.insertContentAt(from, typed)
    return { from, to: from + typed.length }
  }
  const wrapped = (editor: Editor) => {
    let count = 0
    editor.state.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === 'inlineWrap')) count++
    })
    return count
  }

  for (const [name, inner, text, kind] of [
    ['the text of a control retyped', ONE, 'Annual report', 'header'],
    ['the whole paragraph text retyped', ONE, 'Doc Annual report end', 'header'],
    ['the first of two controls around the same text retyped', TWINS, '2024', 'header'],
    ['the text of a control retyped, beside a table', TABLE + ONE, 'Annual report', 'header'],
    ['the text of a control retyped in a footer', ONE, 'Annual report', 'footer'],
  ] as const) {
    it(name, async () => {
      const { handle, editor, commits } = await open(inner, kind)
      const before = wrapped(editor)
      expect(before).toBeGreaterThan(0)
      retype(editor, text)
      // the editor no longer shows the control on the retyped text
      expect(wrapped(editor)).toBeLessThan(before)
      expect(handle.changed()).toBeNull()
      handle.exit()
      expect(commits).toHaveLength(0)
    })
  }

  it('one character different is an edit', async () => {
    const { handle, editor, commits } = await open(ONE)
    retype(editor, 'Annual report', 'Annual repors')
    expect(
      handle
        .changed()
        ?.paras?.[0].runs.map((r) => r.text)
        .join(''),
    ).toBe('Doc Annual repors end')
    handle.exit()
    expect(commits).toHaveLength(1)
  })

  it('the same text retyped in bold is an edit', async () => {
    const { handle, editor, commits } = await open(ONE)
    const range = retype(editor, 'Annual report')
    editor.chain().setTextSelection(range).setMark('bold').run()
    expect(handle.changed()?.paras?.[0].runs.find((r) => r.bold)?.text).toBe('Annual report')
    handle.exit()
    expect(commits).toHaveLength(1)
  })

  it('the same text retyped with a shading is an edit', async () => {
    // run shading is not part of the body's "is it as read" signature; here
    // every difference but the wrapper mark stays an edit
    const { handle, editor, commits } = await open(ONE)
    const range = retype(editor, 'Annual report')
    editor.chain().setTextSelection(range).setMark('docTextStyle', { shading: 'FFFF00' }).run()
    expect(handle.changed()?.paras?.[0].runs.find((r) => r.shading)?.text).toBe('Annual report')
    handle.exit()
    expect(commits).toHaveLength(1)
  })

  it('a paragraph attribute changed beside the retyped text is an edit', async () => {
    const { handle, editor, commits } = await open(ONE)
    retype(editor, 'Annual report')
    editor.commands.updateAttributes('docParagraph', { align: 'right' })
    expect(handle.changed()?.paras?.[0].align).toBe('right')
    handle.exit()
    expect(commits).toHaveLength(1)
  })
})
