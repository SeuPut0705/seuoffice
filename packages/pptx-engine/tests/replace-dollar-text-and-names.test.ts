import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  addTable,
  createBlankPptx,
  editTableCellText,
  mergeTableCells,
  openPptx,
  patchTextElementXml,
  savePptx,
  setElementName,
} from '../src/index'
import type { TableElement, TextElement, TextRun } from '../src/types'

/**
 * String.prototype.replace reads `$&`, `$$`, `$1`, `` $` `` and `$'` in a replacement STRING as
 * patterns. These writers used to put text the user typed (a font name, a shape name, the words
 * of a table cell) or text the deck carries (a run's attribute values) through one.
 */
const DOLLAR = "A$&B$$C$1D$`E$'F"
const DOLLAR_IN_XML = DOLLAR.replace(/&/g, '&amp;')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
})

describe('the in-place run patch keeps $ sequences', () => {
  const el = (run: TextRun) =>
    ({ type: 'text', text: { paragraphs: [{ runs: [run] }] } }) as unknown as TextElement
  const sp = (run: string) => `<p:sp><p:txBody><a:p>${run}</a:p></p:txBody></p:sp>`
  /** The run's rPr as the parser reads it back, after checking the fragment is well-formed. */
  const rPrOf = (xml: string) => {
    expect(XMLValidator.validate(xml)).toBe(true)
    return parser.parse(xml)['p:sp']['p:txBody']['a:p']['a:r']['a:rPr']
  }

  it('a font name and a link tooltip written onto a run that had no rPr', () => {
    const out = patchTextElementXml(
      el({ text: 'x', fontFamily: DOLLAR, hyperlinkRId: 'rId2', hyperlinkTooltip: DOLLAR }),
      sp('<a:r><a:t>x</a:t></a:r>'),
    )
    const rPr = rPrOf(out)
    expect(rPr['a:latin']['@_typeface']).toBe(DOLLAR)
    expect(rPr['a:ea']['@_typeface']).toBe(DOLLAR)
    expect(rPr['a:hlinkClick']['@_tooltip']).toBe(DOLLAR)
    expect(out.match(/<a:r>/g)).toHaveLength(1)
  })

  it('a language the model gained', () => {
    const out = patchTextElementXml(
      el({ text: 'x', lang: DOLLAR }),
      sp('<a:r><a:rPr sz="1800"/><a:t>x</a:t></a:r>'),
    )
    const rPr = rPrOf(out)
    expect(rPr['@_lang']).toBe(DOLLAR)
    expect(rPr['@_sz']).toBe('1800')
  })

  it("the run's own underline style when its text is edited", () => {
    const out = patchTextElementXml(
      el({ text: 'edited', underline: true, underlineStyle: DOLLAR }),
      sp(`<a:r><a:rPr sz="1800" u="${DOLLAR_IN_XML}"/><a:t>x</a:t></a:r>`),
    )
    const rPr = rPrOf(out)
    expect(rPr['@_u']).toBe(DOLLAR)
    expect(rPr['@_sz']).toBe('1800')
  })

  it('an underline style carried onto a run that had none', () => {
    const out = patchTextElementXml(
      el({ text: 'x', underline: true, underlineStyle: DOLLAR }),
      sp('<a:r><a:rPr sz="1800"/><a:t>x</a:t></a:r>'),
    )
    const rPr = rPrOf(out)
    expect(rPr['@_u']).toBe(DOLLAR)
    expect(rPr['@_sz']).toBe('1800')
  })

  // a comment makes the run unscannable, which sends the font through the regex fallback
  for (const [form, rPr] of [
    [
      'an rPr that already names a Latin font',
      '<a:rPr sz="1800"><a:latin typeface="Old"/></a:rPr>',
    ],
    ['a self-closing rPr', '<a:rPr sz="1800"/>'],
    ['a paired rPr without fonts', '<a:rPr sz="1800"><a:noFill/></a:rPr>'],
  ]) {
    it(`a font name written through the fallback onto ${form}`, () => {
      const out = patchTextElementXml(
        el({ text: 'x', fontFamily: DOLLAR }),
        sp(`<a:r>${rPr}<!-- note --><a:t>x</a:t></a:r>`),
      )
      const read = rPrOf(out)
      expect(read['a:latin']['@_typeface']).toBe(DOLLAR)
      expect(read['a:ea']['@_typeface']).toBe(DOLLAR)
      expect(read['@_sz']).toBe('1800')
    })
  }
})

describe('setElementName keeps $ sequences in the name the user typed', () => {
  /** Rename the first element (after `prepare` shaped its bytes) and read the name back from a save. */
  async function renamed(prepare: (xml: string) => string): Promise<string | undefined> {
    const opened = await openPptx(await createBlankPptx())
    const added = addTable(opened, 0, {
      rows: 1,
      cols: 1,
      offset: { x: 914400, y: 914400, cx: 1828800, cy: 914400 },
    })!
    const el = added.slide.elements.find((e) => e.id === added.elementId)!
    el.anchor.originalXml = prepare(el.anchor.originalXml)
    expect(setElementName(added.slide, el.id, DOLLAR)).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    const slide = reopened.deck.slides[0]!
    expect(XMLValidator.validate(reopened.archive.readText(slide.path)!)).toBe(true)
    return slide.elements.find((e) => e.type === 'table')?.name
  }

  it('over the name the element already has', async () => {
    expect(await renamed((xml) => xml)).toBe(DOLLAR)
  })

  it('on a <p:cNvPr> that has no name attribute', async () => {
    const withoutName = (xml: string) => xml.replace(/(<p:cNvPr\b[^>]*?)\sname="[^"]*"/, '$1')
    expect(await renamed(withoutName)).toBe(DOLLAR)
  })
})

describe('mergeTableCells keeps $ sequences in the words it moves', () => {
  it('the merged-in cell text comes back exactly', async () => {
    const opened = await openPptx(await createBlankPptx())
    const added = addTable(opened, 0, {
      rows: 2,
      cols: 2,
      offset: { x: 914400, y: 914400, cx: 3657600, cy: 1828800 },
    })!
    editTableCellText(added.slide, added.elementId, 0, 0, [{ runs: [{ text: 'A1' }] }])
    editTableCellText(added.slide, added.elementId, 0, 1, [{ runs: [{ text: DOLLAR }] }])

    const merged = mergeTableCells(opened, 0, added.elementId, {
      kind: 'merge-right',
      row: 0,
      col: 0,
    })
    expect(merged).not.toBeNull()

    const reopened = await openPptx(await savePptx(opened))
    const slide = reopened.deck.slides[0]!
    expect(XMLValidator.validate(reopened.archive.readText(slide.path)!)).toBe(true)
    const table = slide.elements.find((e) => e.type === 'table') as TableElement
    const anchor = table.rows[0]![0]!
    expect(anchor.gridSpan).toBe(2)
    expect(anchor.text!.paragraphs.map((p) => p.runs.map((r) => r.text).join(''))).toEqual([
      'A1',
      DOLLAR,
    ])
  })
})
