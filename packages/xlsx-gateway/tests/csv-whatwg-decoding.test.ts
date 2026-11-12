import { describe, expect, it } from 'vitest'

import { decodeCsvBuffer } from '../src/gateway/csv-import'
import { decodeHtmlBuffer } from '../src/gateway/html-import'

// Legacy-charset files read the same in the main process, the CLI and the
// renderer: by the Encoding Standard, as a browser reads them. Node's own
// decoder knows less of each charset than the programs that wrote the files.

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('a CSV in a legacy charset', () => {
  // Korean Excel (code page 949) with syllables only the Unified Hangul Code has
  const KOREAN = '이름,지역,학과\n김민수,서울,경제학과\n이지은,부산,정보기술\n똠양꿍,햏자,대학교\n'
  const KOREAN_CP949 = bytes(
    'c0ccb8a72cc1f6bfaa2cc7d0b0fa0ab1e8b9cebcf62cbcadbfef2cb0e6c1a6c7d0b0fa0a' +
      'c0ccc1f6c0ba2cbacebbea2cc1a4bab8b1e2bcfa0a8c63bee7b2e12cc164c0da2cb4ebc7d0b1b30a',
  )

  it('reads Korean with 똠 and 햏 on a Korean install', () => {
    expect(decodeCsvBuffer(KOREAN_CP949, 'euc-kr')).toBe(KOREAN)
  })

  it('reads the same Korean with no language to go by', () => {
    expect(decodeCsvBuffer(KOREAN_CP949)).toBe(KOREAN)
  })

  it('reads Hong Kong characters from Big5', () => {
    const cantonese = '名稱,數量\n佢哋嘅貨,3\n係㗎,5\n'
    const big5 = bytes('a657bad92cbcc6b6710aca5c925d9defb3662c330aab599dee2c350a')
    expect(decodeCsvBuffer(big5, 'big5')).toBe(cantonese)
  })

  it('keeps byte 0x80 of Shift_JIS as the control character Windows reads', () => {
    const japanese = '品名,数量\nりんご\u0080,100\nみかん,200\n'
    const shiftJis = bytes('956996bc2c909497ca0a82e882f182b2802c3130300a82dd82a982f12c3230300a')
    expect(decodeCsvBuffer(shiftJis, 'shift_jis')).toBe(japanese)
  })
})

describe('an HTML table that declares its charset', () => {
  it('reads x-user-defined, the label the Encoding Standard keeps for raw bytes', () => {
    const page = join(
      ascii('<html><head><meta charset="x-user-defined"></head><body><table><tr><td>'),
      bytes('80ff'),
      ascii('</td></tr></table></body></html>'),
    )
    expect(decodeHtmlBuffer(page)).toContain('<td>\uF780\uF7FF</td>')
  })
})
