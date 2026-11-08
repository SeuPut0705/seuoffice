/**
 * execCommand('fontName') parses its value as a CSS font-family: a name the parser rejects
 * ("A2Z 1", "Bauhaus 93") would make the picked font a silent no-op, so those come quoted.
 */
import { describe, expect, it } from 'vitest'
import { fontNameCommandValue } from '../src/renderer/TextEditOverlay'

describe('fontNameCommandValue', () => {
  it('passes plain names through', () => {
    expect(fontNameCommandValue('Arial')).toBe('Arial')
    expect(fontNameCommandValue('Times New Roman')).toBe('Times New Roman')
    expect(fontNameCommandValue('Malgun Gothic')).toBe('Malgun Gothic')
    expect(fontNameCommandValue('맑은 고딕')).toBe('맑은 고딕')
    expect(fontNameCommandValue('HCR Batang Ext')).toBe('HCR Batang Ext')
  })

  it('quotes the names the CSS parser rejects', () => {
    expect(fontNameCommandValue('A2Z 1')).toBe('"A2Z 1"')
    expect(fontNameCommandValue('Paperlogy 4')).toBe('"Paperlogy 4"')
    expect(fontNameCommandValue('Bauhaus 93')).toBe('"Bauhaus 93"')
    expect(fontNameCommandValue('Modern No. 20')).toBe('"Modern No. 20"')
    expect(fontNameCommandValue('Bookshelf Symbol 7')).toBe('"Bookshelf Symbol 7"')
  })

  it('escapes quotes and backslashes inside the quoted value', () => {
    expect(fontNameCommandValue('a"b')).toBe('"a\\"b"')
    expect(fontNameCommandValue('a\\b')).toBe('"a\\\\b"')
  })
})
