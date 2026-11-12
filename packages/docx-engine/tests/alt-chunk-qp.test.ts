import { describe, expect, it } from 'vitest'
import { decodeQuotedPrintable } from '../src/alt-chunk'

describe('decodeQuotedPrintable', () => {
  it('decodes soft breaks and hex escapes correctly', () => {
    expect(Array.from(decodeQuotedPrintable('a=3Db=\r\nc=E9'))).toEqual([
      'a'.charCodeAt(0),
      61,
      'b'.charCodeAt(0),
      'c'.charCodeAt(0),
      0xe9,
    ])
  })
})
