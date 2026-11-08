import { describe, expect, it } from 'vitest'
import { MAX_PREVIEW_CHARS, clipText, cutIndex, previewChars } from '../src/preview'

const args = (flags: Record<string, string | true>) => ({ positionals: [], flags })

describe('previewChars', () => {
  it('uses the fallback without flags and Infinity with --full', () => {
    expect(previewChars(args({}), 200)).toBe(200)
    expect(previewChars(args({ full: true }), 200)).toBe(Infinity)
  })

  it('accepts positive integers within the cap', () => {
    expect(previewChars(args({ 'max-chars': '50' }), 200)).toBe(50)
    expect(previewChars(args({ 'max-chars': String(MAX_PREVIEW_CHARS) }), 200)).toBe(
      MAX_PREVIEW_CHARS,
    )
  })

  it('rejects non-positive, non-integer, and unbounded values', () => {
    for (const raw of ['0', '-5', '3.5', 'abc', String(MAX_PREVIEW_CHARS + 1), '1e21']) {
      expect(() => previewChars(args({ 'max-chars': raw }), 200), raw).toThrow(/--max-chars/)
    }
  })
})

describe('clipText', () => {
  const text = '가나😀다라마'

  it('never leaves half of a surrogate pair at the cut', () => {
    // index 2 is the high half of the emoji, 3 its low half
    expect(clipText(text, 3).text).toBe('가나…(+5 chars)')
    expect(clipText(text, 4).text).toBe('가나😀…(+3 chars)')
    for (let max = 1; max < text.length; max++) {
      const kept = clipText(text, max).text.split('…(+')[0]!
      expect(kept.isWellFormed(), `max ${max}`).toBe(true)
    }
  })

  it('steps over the pair when the window is one unit wide', () => {
    expect(cutIndex('😀a', 0, 1)).toBe(2)
    expect(clipText('😀a', 1).text).toBe('😀…(+1 chars)')
  })

  it('leaves plain text and the end of the text alone', () => {
    expect(cutIndex('가나다', 0, 2)).toBe(2)
    expect(cutIndex('가나😀', 0, 4)).toBe(4)
    expect(clipText('가나다', 3)).toEqual({ text: '가나다', truncated: false })
  })
})
