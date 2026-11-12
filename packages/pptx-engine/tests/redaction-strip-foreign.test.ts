import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  REDACT_EXT_URI,
  readRedactLabel,
  redactExtXml,
  setRedactExt,
  stripRedactExt,
  syncRedactExt,
} from '../src/redaction-xml'

/**
 * Clearing the hide-from-AI mark must take out our own <a:ext> and nothing else. It used to
 * rewrite every non-empty <a:extLst> as a bare <a:extLst>, dropping its attributes, and a
 * self-closing <a:ext> with our uri ran on to the next </a:ext>, taking the extension after it.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
})

const OTHER_EXT = '<a:ext uri="{OTHER}"><x:thing v="1"><x:deep/></x:thing></a:ext>'
const OURS = redactExtXml('client phone')
const OURS_SELF_CLOSING = `<a:ext uri="${REDACT_EXT_URI}"/>`
const LIST_OPEN = '<a:extLst xmlns:x="urn:x" x:keep="1">'

const rPr = (inner: string) =>
  `<a:rPr lang="en-US" sz="1800"><a:latin typeface="Calibri"/>${inner}</a:rPr>`

const labelOf = (xml: string): string | undefined => readRedactLabel(parser.parse(xml)['a:rPr'])

describe('clearing the mark leaves every other extension as it was', () => {
  it('an extLst with attributes and a foreign extension keeps both, byte for byte', () => {
    for (const marked of [
      rPr(`${LIST_OPEN}${OTHER_EXT}${OURS}</a:extLst>`),
      rPr(`${LIST_OPEN}${OURS}${OTHER_EXT}</a:extLst>`),
    ]) {
      expect(labelOf(marked)).toBe('client phone')
      const out = stripRedactExt(marked)
      expect(out).toBe(rPr(`${LIST_OPEN}${OTHER_EXT}</a:extLst>`))
      expect(XMLValidator.validate(out)).toBe(true)
      expect(labelOf(out)).toBeUndefined()
    }
  })

  it('a self-closing extension with our uri does not take the one after it', () => {
    const marked = rPr(`<a:extLst>${OURS_SELF_CLOSING}${OTHER_EXT}</a:extLst>`)
    const out = stripRedactExt(marked)
    expect(out).toBe(rPr(`<a:extLst>${OTHER_EXT}</a:extLst>`))
    expect(XMLValidator.validate(out)).toBe(true)
  })

  it('a new label over a self-closing one keeps the extension after it', () => {
    const marked = rPr(`<a:extLst>${OURS_SELF_CLOSING}${OTHER_EXT}</a:extLst>`)
    const out = setRedactExt(marked, 'new label')
    expect(XMLValidator.validate(out)).toBe(true)
    expect(out).toContain(OTHER_EXT)
    expect(labelOf(out)).toBe('new label')
    expect(out.split(REDACT_EXT_URI)).toHaveLength(2)
  })

  it('an extLst elsewhere in the node, which never held the mark, keeps its bytes', () => {
    const link =
      '<a:hlinkClick r:id="rId1"><a:extLst x:keep="1"><a:ext uri="{LINK}"><x:c/></a:ext></a:extLst></a:hlinkClick>'
    const emptyElsewhere = '<a:ln><a:extLst/></a:ln>'
    const marked = `<a:rPr lang="en-US">${emptyElsewhere}${link}<a:extLst>${OURS}</a:extLst></a:rPr>`
    const out = stripRedactExt(marked)
    expect(out).toBe(`<a:rPr lang="en-US">${emptyElsewhere}${link}</a:rPr>`)
    expect(XMLValidator.validate(out)).toBe(true)
  })

  it('marking and clearing gives back the node it started from', () => {
    const start = rPr(`${LIST_OPEN}${OTHER_EXT}</a:extLst>`)
    const marked = setRedactExt(start, 'client phone')
    expect(labelOf(marked)).toBe('client phone')
    expect(stripRedactExt(marked)).toBe(start)
  })

  it('the list goes when the mark was all it held, and the node closes up again', () => {
    expect(stripRedactExt(`<a:rPr lang="en-US"><a:extLst>${OURS}</a:extLst></a:rPr>`)).toBe(
      '<a:rPr lang="en-US"/>',
    )
    expect(stripRedactExt(rPr(`<a:extLst> ${OURS}${OURS} </a:extLst>`))).toBe(rPr(''))
  })

  it('clearing through the run-level sync leaves the rest of the run alone', () => {
    const before = rPr(`${LIST_OPEN}${OTHER_EXT}</a:extLst>`)
    const run = `<a:r>${setRedactExt(before, 'client phone')}<a:t>words</a:t></a:r>`
    expect(syncRedactExt(run, 'a:rPr')).toBe(`<a:r>${before}<a:t>words</a:t></a:r>`)
  })
})
