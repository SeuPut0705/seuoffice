import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The index tables of the legacy multi-byte charsets load the first time a
 * chunk declares one, as a chunk of their own. When that load fails (a
 * renderer whose split chunk is gone, a host that cannot import it), the
 * chunk is still read: with the host's own decoder, which is right for the
 * common characters and differs only on a few, rather than as windows-1252
 * garbage. The failure is reported once.
 */

vi.mock('@exodus/bytes/encoding.js', () => {
  throw new Error('the charset tables could not be loaded')
})

const { decodeHtmlBytes } = await import('../src/alt-chunk')

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))
/** the bytes of an HTML chunk in `label` whose paragraph holds `bytes` */
const chunk = (label: string, bytes: number[]) =>
  Uint8Array.from([
    ...ascii(`<html><head><meta charset="${label}"></head><body><p>`),
    ...bytes,
    ...ascii('</p></body></html>'),
  ])
/** what the paragraph decodes to */
const paragraph = (html: string) => /<p>(.*)<\/p>/s.exec(html)?.[1]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a legacy charset whose tables cannot be loaded', () => {
  it('is decoded by the host, and the failure is reported once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Korean "annyeong" in euc-kr, and Chinese "ni hao" in gbk: every decoder agrees on both
    expect(paragraph(await decodeHtmlBytes(chunk('euc-kr', [0xbe, 0xc8, 0xb3, 0xe7])))).toBe(
      '\uC548\uB155',
    )
    expect(paragraph(await decodeHtmlBytes(chunk('gbk', [0xc4, 0xe3, 0xba, 0xc3])))).toBe(
      '\u4F60\u597D',
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
