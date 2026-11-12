import { describe, expect, it } from 'vitest'
import { fontSizeOptions, parseFontSize, stepFontSize } from '../src/renderer/font-sizes'

describe('font size list', () => {
  it("lists Word's sizes, each under its number", () => {
    expect(fontSizeOptions().map((o) => o.pt)).toEqual([
      8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
    ])
    expect(fontSizeOptions()[4]).toEqual({ name: '12', pt: 12 })
  })
  it('parses a typed size', () => {
    expect(parseFontSize(' 13.3 ')).toBe(13.5)
    expect(parseFontSize('12pt')).toBe(12)
    expect(parseFontSize('\uff11\uff12')).toBe(12)
    expect(parseFontSize('0')).toBeNull()
    expect(parseFontSize('abc')).toBeNull()
    expect(parseFontSize('5000')).toBe(1638)
  })
})

describe('Increase / Decrease Font Size stepping', () => {
  it('walks the list inside it', () => {
    expect(stepFontSize(11, 1)).toBe(12)
    expect(stepFontSize(11.5, 1)).toBe(12)
    expect(stepFontSize(12, -1)).toBe(11)
    expect(stepFontSize(11.5, -1)).toBe(11)
    expect(stepFontSize(10, 1)).toBe(11)
    expect(stepFontSize(28, 1)).toBe(36)
  })
  it('goes by tens above the list up to 1638', () => {
    expect(stepFontSize(72, 1)).toBe(80)
    expect(stepFontSize(75, 1)).toBe(80)
    expect(stepFontSize(80, 1)).toBe(90)
    expect(stepFontSize(1630, 1)).toBe(1638)
    expect(stepFontSize(1638, 1)).toBe(1638)
    expect(stepFontSize(1638, -1)).toBe(1630)
    expect(stepFontSize(95, -1)).toBe(90)
    expect(stepFontSize(90, -1)).toBe(80)
    expect(stepFontSize(80, -1)).toBe(72)
    expect(stepFontSize(75, -1)).toBe(72)
  })
  it('moves one point at a time below the list down to 1', () => {
    expect(stepFontSize(8, -1)).toBe(7)
    expect(stepFontSize(7.5, -1)).toBe(7)
    expect(stepFontSize(1, -1)).toBe(1)
    expect(stepFontSize(6, 1)).toBe(7)
    expect(stepFontSize(7.5, 1)).toBe(8)
  })
})
