import { describe, expect, it, vi } from 'vitest'

import { decodeCsvBuffer, legacyCharsetDecoder } from '../src/gateway/csv-import'

vi.mock('@exodus/bytes/encoding.js', () => {
  throw new Error('the charset tables could not load')
})

describe('a legacy-charset CSV when the charset tables cannot load', () => {
  it("is still read, by the host's decoder", async () => {
    expect(await legacyCharsetDecoder()).toBe(TextDecoder)
    // a two-line Chinese sheet in GBK, the text the expectation spells
    const gbk = new Uint8Array([
      0xc6, 0xb7, 0xc3, 0xfb, 0x2c, 0xbc, 0xdb, 0xb8, 0xf1, 0x0a, 0xbf, 0xa7, 0xb7, 0xc8, 0x2c,
      0x35, 0x30, 0x30, 0x0a,
    ])
    expect(await decodeCsvBuffer(gbk, 'gb18030')).toBe('品名,价格\n咖啡,500\n')
  })
})
