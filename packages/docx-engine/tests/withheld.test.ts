import { describe, expect, it } from 'vitest'
import { withheldAsPlaceholders } from '../src/withheld'

const hidden = (text: string, label = 'phone') =>
  `<w:r><w:rPr><go:redact w:label="${label}"/></w:rPr><w:t>${text}</w:t></w:r>`
const plain = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`
const placeholder = (label: string) => `<w:r><w:t xml:space="preserve">{{${label}}}</w:t></w:r>`

describe('withheldAsPlaceholders', () => {
  it('reads runs next to each other under one label as one placeholder, others apart', () => {
    const xml = `<w:p>${plain('a')}${hidden('138')}${hidden('000')}${plain('b')}${hidden('x', 'name')}</w:p>`
    expect(withheldAsPlaceholders(xml)).toBe(
      `<w:p>${plain('a')}${placeholder('phone')}${plain('b')}${placeholder('name')}</w:p>`,
    )
  })

  it('finds a hidden run inside a text box that a plain run holds', () => {
    const xml =
      '<w:p><w:r><w:drawing><w:txbxContent><w:p>' +
      `${plain('in box ')}${hidden('secret')}` +
      `</w:p></w:txbxContent></w:drawing></w:r>${hidden('after')}</w:p>`
    const out = withheldAsPlaceholders(xml)
    expect(out).not.toContain('secret')
    expect(out).not.toContain('after')
    expect(out).toContain('in box ')
  })

  it('replaces a hidden run holding other runs whole', () => {
    const xml =
      '<w:p><w:r><w:rPr><go:redact w:label="logo"/></w:rPr><w:drawing><w:txbxContent><w:p>' +
      `${plain('inner words')}</w:p></w:txbxContent></w:drawing></w:r>${plain('tail')}</w:p>`
    expect(withheldAsPlaceholders(xml)).toBe(`<w:p>${placeholder('logo')}${plain('tail')}</w:p>`)
  })

  it('finds the properties of a run past white space and a comment', () => {
    const xml = `<w:p><w:r>\n  <!-- c -->\n  <w:rPr><go:redact w:label="phone"/></w:rPr><w:t>secret</w:t></w:r></w:p>`
    expect(withheldAsPlaceholders(xml)).toBe(`<w:p>${placeholder('phone')}</w:p>`)
  })

  it('takes a mark on a paragraph mark as understood: it has no words', () => {
    const xml = `<w:p><w:pPr><w:rPr><go:redact w:label="phone"/></w:rPr></w:pPr>${plain('open')}</w:p>`
    expect(withheldAsPlaceholders(xml)).toBe(xml)
  })

  it('gives null for a mark no run accounts for, so the reader withholds the whole entry', () => {
    for (const xml of [
      `<w:p><w:r><w:t>secret</w:t><go:redact w:label="phone"/></w:r></w:p>`,
      `<w:p><go:redact w:label="phone"/>${plain('secret')}</w:p>`,
      `<w:p><w:r><?pi?><w:rPr><go:redact w:label="phone"/></w:rPr><w:t>secret</w:t></w:r></w:p>`,
    ]) {
      expect(withheldAsPlaceholders(xml)).toBeNull()
    }
  })
})
