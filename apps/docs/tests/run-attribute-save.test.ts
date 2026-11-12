import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx, type Block, type Run } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'

/**
 * Character formatting given to a word in the editor is in the file after
 * save and reopen, whatever the attribute. Each case changes one attribute of
 * one word and nothing else, the way the ribbon and the font dialog set it
 * (`setMark('docTextStyle', patch)`), then saves with the engine and reads the
 * file back.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const RUNS =
  '<w:r><w:t xml:space="preserve">Due on </w:t></w:r>' +
  '<w:r><w:rPr><w:b/></w:rPr><w:t>5/6/2024</w:t></w:r>' +
  '<w:r><w:t xml:space="preserve"> at noon</w:t></w:r>'
const OWN_RUN = `<w:p>${RUNS}</w:p>`
const ONE_RUN = '<w:p><w:r><w:t>Due on 5/6/2024 at noon</w:t></w:r></w:p>'
const IN_CELL =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid>' +
  `<w:tr><w:tc><w:p>${RUNS}</w:p></w:tc></w:tr></w:tbl><w:p/>`

interface Attribute {
  patch: Record<string, unknown>
  saved: (run: Run) => unknown
  value: unknown
}

const ATTRIBUTES: Record<string, Attribute> = {
  'character shading': { patch: { shading: 'FFFF00' }, saved: (r) => r.shading, value: 'FFFF00' },
  'right-to-left': { patch: { rtl: true }, saved: (r) => r.rtl, value: true },
  'text effect': { patch: { textEffect: 'emboss' }, saved: (r) => r.textEffect, value: 'emboss' },
  'emphasis mark': { patch: { em: 'dot' }, saved: (r) => r.em, value: 'dot' },
  // the font dialog's hidden box sets both: the shown value and the run's own
  'hidden text': {
    patch: { vanish: true, vanishOwn: true },
    saved: (r) => r.vanishOwn,
    value: true,
  },
}

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

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

/** open `bodyXml`, give `word` the patch, save, reopen: the reopened runs of the first paragraph */
async function savedRuns(bodyXml: string, word: string, patch: Record<string, unknown>) {
  const parsed = await parseDocx(await buildDocx({ bodyXml }))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  const from = posOf(editor, word)
  editor
    .chain()
    .setTextSelection({ from, to: from + word.length })
    .setMark('docTextStyle', patch)
    .run()
  const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
  const reparsed = await parseDocx(await saveDocx(parsed, plan.saveBlocks))
  return firstParagraphRuns(reparsed.blocks[0])
}

function firstParagraphRuns(block: Block): Run[] {
  if (block.type === 'table') return block.table?.rows[0]?.[0]?.richParas?.[0]?.runs ?? []
  return block.runs ?? []
}

/** the attribute's value on the run(s) carrying each piece of text, in order */
function valuesOver(runs: Run[], saved: (run: Run) => unknown, pieces: string[]): unknown[] {
  return pieces.map((piece) => {
    const run = runs.find((r) => r.text.includes(piece))
    if (!run) throw new Error(`"${piece}" is not in a saved run: ${JSON.stringify(runs)}`)
    return saved(run) ?? null
  })
}

describe('an attribute given to a word that is its own run is saved', () => {
  for (const [name, { patch, saved, value }] of Object.entries(ATTRIBUTES)) {
    it(`${name}, in a body paragraph`, async () => {
      const runs = await savedRuns(OWN_RUN, '5/6/2024', patch)
      expect(runs.map((r) => r.text).join('')).toBe('Due on 5/6/2024 at noon')
      expect(valuesOver(runs, saved, ['Due on', '5/6/2024', 'at noon'])).toEqual([
        null,
        value,
        null,
      ])
      expect(runs.find((r) => r.text === '5/6/2024')?.bold).toBe(true)
    })

    it(`${name}, in a table cell`, async () => {
      const runs = await savedRuns(IN_CELL, '5/6/2024', patch)
      expect(runs.map((r) => r.text).join('')).toBe('Due on 5/6/2024 at noon')
      expect(valuesOver(runs, saved, ['Due on', '5/6/2024', 'at noon'])).toEqual([
        null,
        value,
        null,
      ])
      expect(runs.find((r) => r.text === '5/6/2024')?.bold).toBe(true)
    })
  }
})

describe('an attribute given to part of a one-run paragraph stays on that part', () => {
  for (const [name, { patch, saved, value }] of Object.entries(ATTRIBUTES)) {
    it(`${name}, on a word in the middle`, async () => {
      const runs = await savedRuns(ONE_RUN, '5/6/2024', patch)
      expect(runs.map((r) => r.text).join('')).toBe('Due on 5/6/2024 at noon')
      expect(valuesOver(runs, saved, ['Due on', '5/6/2024', 'at noon'])).toEqual([
        null,
        value,
        null,
      ])
    })

    it(`${name}, on the first word`, async () => {
      const runs = await savedRuns(ONE_RUN, 'Due', patch)
      expect(valuesOver(runs, saved, ['Due', ' on 5/6/2024 at noon'])).toEqual([value, null])
    })
  }
})

// every run property the reader models, on runs beside plain ones; a property
// the signature saw differently on the two sides would rewrite these paragraphs
const r = (rPr: string, text: string) =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const p = (...runs: string[]) => `<w:p>${runs.join('')}${r('', ' plain')}</w:p>`
const fld = (instr: string, result: string) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>` +
  (result ? `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('', result)}` : '') +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
const AT = 'w:author="A" w:date="2026-01-01T00:00:00Z"'
const ARABIC = '\u0645\u0631\u062d\u0628\u0627'
const EVERY_RUN_PROPERTY = [
  p(r('<w:b w:val="0"/><w:i w:val="0"/><w:strike w:val="0"/><w:u w:val="none"/>', 'off')),
  p(r('<w:shd w:val="pct25" w:color="FF0000" w:fill="FFFFFF"/>', 'pattern')),
  p(r('<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>', 'shaded')),
  p(r('<w:lang w:eastAsia="ja-JP"/>', 'lang'), r('<w:rStyle w:val="Inherits"/>', 'styled')),
  p(
    r('<w:emboss/>', 'emboss'),
    r('<w:outline/><w:shadow/>', 'outline'),
    r('<w:em w:val="dot"/>', 'em'),
  ),
  p(
    r(
      '<w14:glow w14:rad="63500"><w14:srgbClr w14:val="FF0000"><w14:alpha w14:val="60000"/></w14:srgbClr></w14:glow>',
      'glow',
    ),
    r(
      '<w14:textOutline w14:w="9525" w14:cap="flat" w14:cmpd="sng" w14:algn="ctr"><w14:solidFill><w14:srgbClr w14:val="00FF00"/></w14:solidFill></w14:textOutline>',
      'outlined',
    ),
  ),
  p(
    r('<w:kern w:val="0"/><w:spacing w:val="0"/><w:position w:val="-2"/><w:w w:val="80"/>', 'k'),
    r(
      '<w:caps w:val="0"/><w:smallCaps/><w:dstrike w:val="0"/><w:vanish w:val="0"/><w:rtl w:val="0"/>',
      'c',
    ),
    r('<w:vanish/><w:specVanish/>', 's'),
    r('<w:sz w:val="0"/><w:position w:val="0"/><w:w w:val="100"/>', 'z'),
  ),
  p(r('<w:rFonts w:cs="Arial"/>', ARABIC), r('<w:rFonts w:cs="Arial"/>', 'latin')),
  p(r('<w:rtl/><w:bCs/><w:szCs w:val="30"/>', ARABIC)),
  p(r(`<w:b/><w:rPrChange w:id="9" ${AT}><w:rPr><w:i/></w:rPr></w:rPrChange>`, 'changed')),
  p(
    `<w:ins w:id="10" ${AT}>${r('', 'inserted')}</w:ins>`,
    '<w:del w:id="11" w:author="A"><w:r><w:delText>deleted</w:delText></w:r></w:del>',
    '<w:moveToRangeStart w:id="20" w:author="A" w:name="move1"/>',
    `<w:moveTo w:id="21" w:author="A">${r('', 'moved')}</w:moveTo>`,
    '<w:moveToRangeEnd w:id="20"/>',
  ),
  p(
    `<w:hyperlink r:id="rIdL" w:tooltip="tip">${r('<w:rStyle w:val="Hyperlink"/>', 'link')}</w:hyperlink>`,
    '<w:bookmarkStart w:id="1" w:name="bm"/><w:bookmarkEnd w:id="1"/>',
    `<w:hyperlink w:anchor="bm">${r('', 'anchor')}</w:hyperlink>`,
  ),
  p(
    fld(' DATE \\@ "M/d/yyyy" ', '1/1/2026'),
    fld(' REF bm \\h ', 'ref'),
    fld(' ADDIN ZOTERO_ITEM CSL_CITATION {} ', '(Doe 2020)'),
    fld(' XE "term" ', ''),
  ),
  p(r('', 'math '), '<m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath>'),
  p(
    '<w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r>',
    r('<w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/>', 'abg'),
  ),
  p(
    '<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/><w:hps w:val="10"/><w:hpsRaise w:val="18"/>' +
      '<w:hpsBaseText w:val="20"/><w:lid w:val="ja-JP"/></w:rubyPr><w:rt><w:r><w:t>kan</w:t></w:r></w:rt>' +
      '<w:rubyBase><w:r><w:t>X</w:t></w:r></w:rubyBase></w:ruby></w:r>',
  ),
  p(
    r('', 'picture '),
    '<w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData ' +
      'uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>' +
      '<a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
  ),
  p(
    '<w:commentRangeStart w:id="0"/>',
    r('', 'commented'),
    '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>',
  ),
  p(
    '<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent>' +
      r('<w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hAnsi="MS Gothic"/>', '\u2610') +
      '</w:sdtContent></w:sdt>',
  ),
  p(
    r('<w:highlight w:val="none"/><w:color w:val="auto"/>', 'auto'),
    r('<w:em w:val="none"/>', 'none'),
  ),
  p(r('', 'tab\there'), '<w:r><w:br/></w:r>', r('', 'after'), '<w:r><w:tab/></w:r>'),
].join('')

describe('a document saved without an edit', () => {
  it('keeps every paragraph, whatever run properties it carries', async () => {
    const source = await buildDocx({
      bodyXml: EVERY_RUN_PROPERTY,
      // a character style handing down an East Asian language, a border,
      // hidden text and right-to-left
      extraStylesXml:
        '<w:style w:type="character" w:styleId="Inherits"><w:name w:val="Inherits"/><w:rPr>' +
        '<w:lang w:eastAsia="zh-CN"/><w:bdr w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '<w:vanish/><w:rtl/></w:rPr></w:style>',
      withImage: true,
      extraRels:
        '<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>',
      docRootExtraAttrs: 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
    })
    const parsed = await parseDocx(source)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    editors.push(editor)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await parseDocx(await saveDocx(parsed, plan.saveBlocks))
    expect(saved.internal.documentXml).toBe(parsed.internal.documentXml)
  })
})
