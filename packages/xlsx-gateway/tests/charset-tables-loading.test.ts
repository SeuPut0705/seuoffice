import { expect, it, vi } from 'vitest'

import { decodeCsvBuffer } from '../src/gateway/csv-import'
import { decodeHtmlBuffer } from '../src/gateway/html-import'

const loaded = vi.hoisted(() => vi.fn())
vi.mock('@exodus/bytes/encoding.js', async (importOriginal) => {
  loaded()
  return importOriginal()
})

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const page = (charset: string, cell: Uint8Array): Uint8Array => {
  const before = utf8(`<html><head><meta charset="${charset}"></head><body><table><tr><td>`)
  const after = utf8('</td></tr></table></body></html>')
  const out = new Uint8Array(before.length + cell.length + after.length)
  out.set(before)
  out.set(cell, before.length)
  out.set(after, before.length + cell.length)
  return out
}

// The tables of the multi-byte charsets are large; a file in UTF-8 or a
// single-byte charset is read without them.
it('loads the multi-byte charset tables only for a file that needs them', async () => {
  expect(await decodeHtmlBuffer(page('utf-8', utf8('가나다')))).toContain('<td>가나다</td>')
  expect(await decodeHtmlBuffer(page('windows-1252', bytes('e9')))).toContain('<td>é</td>')
  expect(await decodeHtmlBuffer(page('x-user-defined', bytes('80')))).toContain('<td>\uF780</td>')
  expect(await decodeCsvBuffer(utf8('a,b\n가,나\n'))).toBe('a,b\n가,나\n')
  expect(loaded).not.toHaveBeenCalled()

  expect(await decodeHtmlBuffer(page('euc-kr', bytes('b0a1')))).toContain('<td>가</td>')
  expect(loaded).toHaveBeenCalledTimes(1)
})
