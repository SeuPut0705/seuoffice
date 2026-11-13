import { describe, expect, it } from 'vitest'
import { stripTextboxes, rawPPrOf } from '../src/parse-props'
import { elementInner, removeSegments, replaceSegments, xmlSegments } from '../src/xml-tag'

/**
 * The slicers cut XML by its tags. A tag is a tag the way an XML parser reads
 * it: markup inside a comment or CDATA is none, a `>` inside a quoted value
 * does not end a tag, an end tag may hold white space before its `>`.
 */

const SPELLINGS: Record<string, { open: string; close: string; between: string }> = {
  plain: { open: '<mc:Fallback>', close: '</mc:Fallback>', between: '' },
  'attributes with > in a value': {
    open: '<mc:Fallback w:x="a>b" y=\'c/>d\'>',
    close: '</mc:Fallback>',
    between: '',
  },
  'space before > in the end tag': { open: '<mc:Fallback>', close: '</mc:Fallback >', between: '' },
  'newline before > in the end tag': {
    open: '<mc:Fallback>',
    close: '</mc:Fallback\n>',
    between: '',
  },
  'end tag in a comment': {
    open: '<mc:Fallback>',
    close: '</mc:Fallback>',
    between: '<!-- </mc:Fallback> <mc:Fallback> -->',
  },
  'end tag in CDATA': {
    open: '<mc:Fallback>',
    close: '</mc:Fallback>',
    between: '<w:t><![CDATA[</mc:Fallback>]]></w:t>',
  },
}

describe.each(Object.entries(SPELLINGS))('an mc:Fallback spelled with %s', (_name, s) => {
  const fallback = `${s.open}<w:pict>${s.between}fallback</w:pict>${s.close}`
  const xml = `<w:p><w:r><mc:Choice>choice</mc:Choice>${fallback}</w:r><w:r>after</w:r></w:p>`

  it('is found as one segment', () => {
    const segs = xmlSegments(xml, 'mc:Fallback', 0, xml.length)
    expect(segs.map((seg) => xml.slice(seg.start, seg.end))).toEqual([fallback])
  })

  it('is removed whole', () => {
    expect(removeSegments(xml, 'mc:Fallback')).toBe(
      '<w:p><w:r><mc:Choice>choice</mc:Choice></w:r><w:r>after</w:r></w:p>',
    )
  })

  it('is replaced whole, the rest untouched', () => {
    expect(replaceSegments(xml, 'mc:Fallback', (e) => `[${e.length}]`)).toBe(
      `<w:p><w:r><mc:Choice>choice</mc:Choice>[${fallback.length}]</w:r><w:r>after</w:r></w:p>`,
    )
  })
})

describe('a w:txbxContent spelled in each way', () => {
  it.each([
    ['plain', '<w:txbxContent>', '</w:txbxContent>'],
    ['with an attribute', '<w:txbxContent w:x="a>b">', '</w:txbxContent>'],
    ['space before > in the end tag', '<w:txbxContent>', '</w:txbxContent >'],
    ['single quoted attribute', "<w:txbxContent w:x='>'>", '</w:txbxContent>'],
  ])('%s is stripped from the host paragraph', (_name, open, close) => {
    const xml = `<w:p><w:r>host</w:r><w:r>${open}<w:p><w:r>boxed</w:r></w:p>${close}</w:r></w:p>`
    expect(stripTextboxes(xml)).toBe('<w:p><w:r>host</w:r><w:r></w:r></w:p>')
  })

  it('is stripped whole when another one is nested in it', () => {
    const xml =
      '<w:p><w:txbxContent><w:p><w:txbxContent>in</w:txbxContent></w:p></w:txbxContent>x</w:p>'
    expect(stripTextboxes(xml)).toBe('<w:p>x</w:p>')
  })
})

describe('the inside of an element', () => {
  it.each([
    ['<w:tr><w:tc/></w:tr>', '<w:tc/>'],
    ['<w:tr><w:tc/></w:tr >', '<w:tc/>'],
    ['<w:tr w:x="a>b"><w:tc/></w:tr>', '<w:tc/>'],
    ['<w:tr><w:tc/><!-- </w:tr> --></w:tr>', '<w:tc/><!-- </w:tr> -->'],
    ['<w:tr/>', ''],
  ])('of %j is %j', (xml, inner) => {
    expect(elementInner(xml)).toBe(inner)
  })
})

describe('the properties of a paragraph', () => {
  const pPr = '<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>'
  it.each([
    ['plain', `<w:p>${pPr}<w:r/></w:p>`, pPr],
    ['a > in the paragraph tag', `<w:p w:x="a>b">${pPr}<w:r/></w:p>`, pPr],
    ['a comment before them', `<w:p><!-- <w:pPr/> -->${pPr}<w:r/></w:p>`, pPr],
    [
      'space before > in the end tag',
      `<w:p>${pPr.replace(/<\/w:pPr>$/, '</w:pPr >')}<w:r/></w:p >`,
      pPr.replace(/<\/w:pPr>$/, '</w:pPr >'),
    ],
    ['a pPr only in a nested box', '<w:p><w:r><w:pPr/></w:r></w:p>', undefined],
  ])('are read from %s', (_name, xml, expected) => {
    expect(rawPPrOf(xml)).toBe(expected)
  })
})
