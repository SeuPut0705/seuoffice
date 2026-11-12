import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { readRedactLabel, setRedactExt } from '../src/redaction-xml'

/**
 * The hide-from-AI label is typed by the user. On a node that already holds an <a:extLst> it used
 * to be spliced in through a replacement STRING, where `$&`, `$$`, `$1`, `` $` `` and `$'` are
 * patterns: "Cost $$" lost a `$`, and "R$&D" pasted markup into the label attribute.
 */
const DOLLAR = "A$&B$$C$1D$`E$'F"

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
})

const OTHER_EXT = '<a:ext uri="{OTHER}"><x:thing v="1"/></a:ext>'
const WITH_LIST = `<a:rPr lang="en-US"><a:latin typeface="Calibri"/><a:extLst>${OTHER_EXT}</a:extLst></a:rPr>`
const WITH_EMPTY_LIST = '<a:rPr lang="en-US"><a:latin typeface="Calibri"/><a:extLst/></a:rPr>'

const labelOf = (rPrXml: string): string | undefined =>
  readRedactLabel(parser.parse(rPrXml)['a:rPr'])

describe('the hide-from-AI label keeps its $ sequences beside an existing extLst', () => {
  for (const label of [DOLLAR, 'Cost $$', 'R$&D']) {
    it(`"${label}" joins an extLst that holds another extension`, () => {
      const out = setRedactExt(WITH_LIST, label)
      expect(XMLValidator.validate(out)).toBe(true)
      expect(labelOf(out)).toBe(label)
      expect(out).toContain(OTHER_EXT)
      expect(out.match(/<a:extLst\b/g)).toHaveLength(1)
    })

    it(`"${label}" fills a self-closing extLst`, () => {
      const out = setRedactExt(WITH_EMPTY_LIST, label)
      expect(XMLValidator.validate(out)).toBe(true)
      expect(labelOf(out)).toBe(label)
      expect(out.match(/<a:extLst\b/g)).toHaveLength(1)
    })
  }

  it('a second label replaces the first exactly', () => {
    const out = setRedactExt(setRedactExt(WITH_LIST, 'first'), DOLLAR)
    expect(XMLValidator.validate(out)).toBe(true)
    expect(labelOf(out)).toBe(DOLLAR)
    expect(out).not.toContain('first')
  })
})
