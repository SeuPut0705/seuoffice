import { afterEach, describe, expect, it } from 'vitest'
import { parseDocx } from '../src/parse'
import { setAltChunkHtmlConverter } from '../src/alt-chunk'
import { buildDocx } from './helpers/build-docx'

/**
 * An HTML or MHT altChunk in a legacy charset is decoded by the Encoding
 * Standard on every host: the desktop renderer, the CLI and a Node main
 * process hand the converter the same text. Each case is a byte sequence the
 * host decoders answered differently (Node 22 against Chromium, measured
 * 2026-11-12), with the Encoding Standard's answer.
 */

const CASES: Array<[label: string, bytes: number[], text: string]> = [
  ['euc-kr', [0x8c, 0x63], '\uB620'],
  ['ks_c_5601-1987', [0x81, 0x41], '\uAC02'],
  ['big5', [0x87, 0x40], '\u43F0'],
  // Chromium 156 answers U+0093 and a lone surrogate here; the standard's index gives two code points
  ['big5', [0x88, 0x62], '\u00CA\u0304'],
  ['shift_jis', [0x80, 0x41], '\u0080A'],
  ['euc-jp', [0x80, 0x41], '\uFFFDA'],
  ['koi8-u', [0xae, 0xbe], '\u045E\u040E'],
  ['windows-874', [0xdb], '\uFFFD'],
  ['windows-1253', [0xaa], '\uFFFD'],
  ['windows-1255', [0xca], '\u05BA'],
  ['iso-8859-16', [0xa1], '\u0104'],
  ['x-user-defined', [0x80], '\uF780'],
  // every host agreed here: the table loads for these too
  ['gbk', [0xc4, 0xe3], '\u4F60'],
]

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))
const HEAD = (label: string) => `<html><head><meta charset="${label}"></head><body><p>`
const TAIL = '</p></body></html>'

const htmlChunk = (label: string, bytes: number[]) =>
  Uint8Array.from([...ascii(HEAD(label)), ...bytes, ...ascii(TAIL)])

/** the charset named only in the MIME header, the HTML itself declaring none */
const mhtChunk = (label: string, bytes: number[]) =>
  Uint8Array.from([
    ...ascii(
      'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\n' +
        `Content-Type: text/html; charset="${label}"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n` +
        '<html><body><p>',
    ),
    ...bytes,
    ...ascii(`${TAIL}\r\n--b--\r\n`),
  ])

const CHUNKS = {
  html: { path: 'word/afchunk.htm', contentType: 'text/html', build: htmlChunk },
  mht: { path: 'word/afchunk.mht', contentType: 'message/rfc822', build: mhtChunk },
}

/** the text the host's converter receives for a docx whose only chunk is `kind` */
async function convertedText(kind: keyof typeof CHUNKS, label: string, bytes: number[]) {
  const chunk = CHUNKS[kind]
  const received: string[] = []
  setAltChunkHtmlConverter(async (html) => {
    received.push(html)
    return null
  })
  await parseDocx(
    await buildDocx({
      bodyXml: '<w:altChunk r:id="rIdChunk"/><w:p><w:r><w:t>After</w:t></w:r></w:p>',
      extraRels: `<Relationship Id="rIdChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="/${chunk.path}"/>`,
      extraParts: [
        {
          path: chunk.path,
          xml: chunk.build(label, bytes) as unknown as string,
          contentType: chunk.contentType,
        },
      ],
    }),
  )
  expect(received).toHaveLength(1)
  return /<p>([\s\S]*)<\/p>/.exec(received[0]!)![1]
}

afterEach(() => setAltChunkHtmlConverter(null))

describe.each(['html', 'mht'] as const)('a legacy-charset %s altChunk', (kind) => {
  it.each(CASES)('%s %j decodes as the Encoding Standard says', async (label, bytes, text) => {
    expect(await convertedText(kind, label, bytes)).toBe(text)
  })
})
