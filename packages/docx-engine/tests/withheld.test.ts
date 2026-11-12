import { describe, expect, it } from 'vitest'
import { parseEntry, runsText, withheldNode, withheldText } from '../src/withheld'

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

describe('withheldText', () => {
  const read = (xml: string) => withheldText(parseEntry(xml)!, runsText)

  it('is undefined for an entry that hides nothing', () => {
    expect(read(`<w:p>${plain('open')}</w:p>`)).toBeUndefined()
  })

  it('withholds the whole entry when a mark sits where no run accounts for it', () => {
    expect(read(`<w:p><go:redact w:label="phone"/>${plain('secret')}</w:p>`)).toBe('{{private}}')
  })

  it('gives the placeholder text otherwise', () => {
    expect(read(`<w:p>${plain('Call ')}${hidden('secret')}</w:p>`)).toBe('Call {{phone}}')
  })

  it('reads markup inside CDATA as words, not as an entry of its own', () => {
    const xml = `<w:p>${hidden('<![CDATA[</w:p><w:p><w:r><w:t>secret</w:t></w:r></w:p>]]>')}</w:p>`
    expect(read(xml)).toBe('{{phone}}')
  })
})
