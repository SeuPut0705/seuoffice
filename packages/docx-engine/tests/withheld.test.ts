import { describe, expect, it } from 'vitest'
import { parseEntry, runsText, withheldEntryText, withheldNode } from '../src/withheld'

const hidden = (text: string, label = 'phone') =>
  `<w:r><w:rPr><go:redact w:label="${label}"/></w:rPr><w:t>${text}</w:t></w:r>`
const plain = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`

/** what a model reads of a paragraph, or null when the entry is withheld whole */
function modelText(xml: string): string | null {
  const view = withheldNode(parseEntry(xml)!)
  return view === null ? null : runsText(view)
}

describe('withheldNode', () => {
  it('reads runs next to each other under one label as one placeholder, others apart', () => {
    const xml = `<w:p>${plain('a')}${hidden('138')}\n  ${hidden('000')}${plain('b')}${hidden('x', 'name')}</w:p>`
    expect(modelText(xml)).toBe('a{{phone}}b{{name}}')
  })

  it('finds a hidden run inside a text box that a plain run holds', () => {
    const xml =
      '<w:p><w:r><w:drawing><w:txbxContent><w:p>' +
      `${plain('in box ')}${hidden('secret')}` +
      `</w:p></w:txbxContent></w:drawing></w:r>${hidden('after')}</w:p>`
    expect(modelText(xml)).toBe('in box {{phone}}{{phone}}')
  })

  it('replaces a hidden run holding other runs whole', () => {
    const xml =
      '<w:p><w:r><w:rPr><go:redact w:label="logo"/></w:rPr><w:drawing><w:txbxContent><w:p>' +
      `${plain('inner words')}</w:p></w:txbxContent></w:drawing></w:r>${plain('tail')}</w:p>`
    expect(modelText(xml)).toBe('{{logo}}tail')
  })

  it('reads the tags as the parser does: white space, comments, quotes, CDATA', () => {
    const xml =
      `<w:p><w:r w:rsidR='a>b' >\n  <!-- c </w:r> -->\n  <w:rPr><gx:redact w:label = 'phone'/></w:rPr>` +
      '<w:t><![CDATA[</w:r>secret]]></w:t></w:r></w:p>'
    expect(modelText(xml)).toBe('{{phone}}')
  })

  it('takes a mark on a paragraph mark as understood: it has no words', () => {
    const xml = `<w:p><w:pPr><w:rPr><go:redact w:label="phone"/></w:rPr></w:pPr>${plain('open')}</w:p>`
    expect(modelText(xml)).toBe('open')
  })

  it('gives null for a mark no run accounts for, so the reader withholds the whole entry', () => {
    for (const xml of [
      `<w:p><w:r><w:t>secret</w:t><go:redact w:label="phone"/></w:r></w:p>`,
      `<w:p><go:redact w:label="phone"/>${plain('secret')}</w:p>`,
    ]) {
      expect(modelText(xml)).toBeNull()
    }
  })
})

describe('withheldEntryText', () => {
  const read = (xml: string, text: string) => withheldEntryText(xml, text, runsText)

  it('is undefined for an entry that hides nothing', () => {
    expect(read(`<w:p>${plain('open')}</w:p>`, 'open')).toBeUndefined()
  })

  it('withholds the whole entry when the reader saw other words than the tree', () => {
    // a pattern that took the CDATA markup for text, or stopped at a ">" inside a value
    expect(read(`<w:p>${hidden('<![CDATA[x]]>')}</w:p>`, 'x and more')).toBe('{{private}}')
    // a slice the parser cannot read
    expect(read('<w:p><go:redact w:label="p"/><w:t>secret</w:p></w:t>', 'secret')).toBe(
      '{{private}}',
    )
  })

  it('gives the placeholder text when the readings agree', () => {
    expect(read(`<w:p>${plain('Call ')}${hidden('secret')}</w:p>`, 'Call secret')).toBe(
      'Call {{phone}}',
    )
  })
})
