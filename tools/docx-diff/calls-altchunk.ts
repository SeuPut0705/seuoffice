// Group `altchunk` of comparison (f): alt-chunk.ts, the w:altChunk sniffing
// and the HTML / MHT decoding before the host's converter. A byte argument is
// `args.bytes` (an array of numbers), or else the text as UTF-8; a returned
// Uint8Array crosses as an array of numbers.
import {
  altChunkKind,
  altChunkPartPath,
  decodeHtmlBytes,
  decodeMhtToHtml,
  decodeQuotedPrintable,
} from './reference/alt-chunk'
import type { RelInfo } from './reference/parse-xml-text'
import type { CallSpec, Input } from './calls-spec'

const bytesOf = (text: string, args: Record<string, unknown>): Uint8Array =>
  Array.isArray(args.bytes)
    ? Uint8Array.from(args.bytes as number[])
    : new TextEncoder().encode(text)

/** Latin-1 text as its bytes: every character is one byte. */
const bin = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)]

const bytes = (list: number[][]): Input[] => list.map((value) => ({ args: { bytes: value } }))

/** The first `length` code units of `text`, without splitting a surrogate pair. */
function cut(text: string, length: number): string {
  const end = Math.min(text.length, length)
  const last = text.charCodeAt(end - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

// ------------------------------------------------------------ samples

const EUC_KR = [0xc7, 0xd1, 0xb1, 0xdb] // two Hangul syllables
const EUC_KR_EDGES = [0x81, 0x41, 0xa1, 0x41, 0xc8, 0xfe, 0x80, 0xff] // CP949 extension, 0x80
const SHIFT_JIS = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x5c, 0x7e, 0x80, 0xa0, 0x81, 0x5f, 0x87]
const GB18030 = [0xd6, 0xd0, 0xce, 0xc4, 0x81, 0x30, 0x81, 0x30, 0xa6, 0xd9, 0x84, 0x31, 0xa4, 0x39]
const GB18030_EDGES = [0x80, 0xfe, 0x51, 0xa8, 0xbc, 0x84, 0x31, 0x95, 0x33, 0xff, 0x81]
const BIG5 = [0xa4, 0xa4, 0xa4, 0xe5, 0x87, 0x40, 0x88, 0x62, 0x88, 0x64, 0xf9, 0xfe, 0x80, 0xa1]
const CP1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]
const CP1252_HIGH = [0x80, 0x81, 0x8d, 0x8f, 0x90, 0x92, 0x9d, 0x9f, 0xe9, 0xff]
const ISO_2022_JP = [0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42, 0x41, 0x1b]
const UTF16LE = [0x68, 0x00, 0x69, 0x00, 0x5c, 0xd5, 0x3d, 0xd8, 0x00, 0xde, 0x00, 0xd8, 0x41]
const UTF16BE = [0x00, 0x68, 0x00, 0x69, 0xd5, 0x5c, 0xd8, 0x3d, 0xde, 0x00, 0xdc, 0x00]
const BAD_UTF8 = [0x63, 0x61, 0x66, 0xe9, 0x20, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98]

/** An HTML page whose head holds `head` (Latin-1) and whose body is `body`. */
const page = (head: string, body: number[]): number[] => [
  ...bin(`<html><head>${head}</head><body>`),
  ...body,
  ...bin('</body></html>'),
]

const meta = (charset: string): string => `<meta charset="${charset}">`

/** A page whose `<meta charset="label">` value starts `at` bytes from the start. */
function metaAt(at: number, label: string, body: number[]): number[] {
  const open = '<html><head>'
  const tag = '<meta charset="'
  return page(`${' '.repeat(at - open.length - tag.length)}${tag}${label}">`, body)
}

const HTML_BYTES: number[][] = [
  [],
  bin('plain ascii'),
  utf8('<p>caf\u00e9 \ud55c\uae00 \u{1F600}</p>'),
  // BOMs of the three kinds, doubled, and over bytes that are not of that kind
  [0xef, 0xbb, 0xbf, ...utf8('h\u00e9')],
  [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8('x')],
  [0xef, 0xbb, 0xbf, ...BAD_UTF8],
  [0xef, 0xbb],
  [0xff, 0xfe, ...UTF16LE],
  [0xff, 0xfe, 0xff, 0xfe, 0x41, 0x00],
  [0xff, 0xfe, 0x41],
  [0xff],
  [0xfe, 0xff, ...UTF16BE],
  [0xfe, 0xff, 0xfe, 0xff, 0x00, 0x41],
  [0xfe, 0xff, 0x00],
  [0xfe],
  // <meta charset> in each quoting form, and http-equiv
  page(meta('euc-kr'), EUC_KR),
  page("<meta charset='shift_jis'>", SHIFT_JIS),
  page('<meta charset=gb18030>', GB18030),
  page('<META CHARSET = " big5 ">', BIG5),
  page('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">', CP1251),
  page('<meta content="text/html; CHARSET=Windows-1252" http-equiv="Content-Type">', CP1252_HIGH),
  page(meta('iso-8859-1'), CP1252_HIGH),
  page(meta('latin1'), CP1252_HIGH),
  page(meta('utf-16'), utf8('ab')),
  page(meta('utf-16le'), UTF16LE),
  page(meta('utf-16be'), UTF16BE),
  page(meta('unicode'), utf8('abcd')),
  page(meta('iso-2022-jp'), ISO_2022_JP),
  page(meta('euc-jp'), [0x8e, 0xa1, 0x8f, 0xa2, 0xaf, 0x5c, 0xa1]),
  page(meta('gbk'), GB18030_EDGES),
  page(meta('gb18030'), GB18030_EDGES),
  page(meta('euc-kr'), EUC_KR_EDGES),
  page(meta('ks_c_5601-1987'), EUC_KR),
  page(meta('big5-hkscs'), BIG5),
  page(meta('x-sjis'), SHIFT_JIS),
  page(meta('koi8-r'), [0xf0, 0xd2, 0xc9]),
  page(meta('macintosh'), [0x80, 0xff]),
  page(meta('x-mac-cyrillic'), [0x80, 0xff]),
  page(meta('iso-8859-8-i'), [0xe0]),
  page(meta('windows-874'), [0xa1, 0xdb]),
  // utf-8 is fatal under its own label only; other labels of it replace
  page(meta('utf-8'), BAD_UTF8),
  page(meta('UTF-8'), BAD_UTF8),
  page(meta('utf8'), BAD_UTF8),
  page(meta('unicode-1-1-utf-8'), BAD_UTF8),
  page(meta('utf-8'), utf8('\u00e9')),
  // labels TextDecoder throws on: the next candidate is utf-8, then windows-1252
  page(meta('bogus'), utf8('\u00e9')),
  page(meta('bogus'), BAD_UTF8),
  page(meta('replacement'), utf8('ok')),
  page(meta('iso-2022-kr'), BAD_UTF8),
  page(meta('hz-gb-2312'), utf8('ok')),
  page(meta('x-user-defined'), [0x80, 0xff]),
  page(meta('iso-8859-16'), [0xa1, 0xa4]),
  page(meta('-'), utf8('x')),
  page('<meta charset="">', BAD_UTF8),
  page('<meta name="x">', BAD_UTF8),
  page('<metacharset=euc-kr>', EUC_KR),
  page('<meta\ncharset=euc-kr>', EUC_KR),
  page('<meta charset=\u00a0euc-kr>', EUC_KR),
  // the XML declaration, quoted only
  [...bin('<?xml version="1.0" encoding="windows-1251"?><html>'), ...CP1251],
  [...bin("<?xml version='1.0' encoding='Shift_JIS'?><r>"), ...SHIFT_JIS],
  [...bin('<?xml version="1.0" encoding=euc-kr?><r>'), ...EUC_KR],
  [...bin('<?xml encoding="euc-kr"?><meta charset="big5">'), ...BIG5],
  [...bin('<?xml version="1.0"?><r>'), ...BAD_UTF8],
  // no declaration: utf-8, else windows-1252
  BAD_UTF8,
  CP1252_HIGH,
  [0x80],
  [0xc3],
  // the sniff reads 4096 bytes: a label inside, cut at the edge, and past it
  metaAt(4096 - 'euc-kr'.length, 'euc-kr', EUC_KR),
  metaAt(4096 - 2, 'euc-kr', EUC_KR),
  metaAt(4096, 'euc-kr', EUC_KR),
  metaAt(4096 - 'utf-8'.length, 'utf-8', BAD_UTF8),
  metaAt(4096 - 3, 'utf-8', BAD_UTF8),
]

// ------------------------------------------------------------ MHT

interface Part {
  headers: string[]
  body: number[]
}

/**
 * A MIME message: `top` headers, then each part after `--boundary` and the
 * closing `--boundary--` (left out when `close` is false). Headers are Latin-1.
 */
function mime(
  top: string[],
  boundary: string | null,
  parts: Part[],
  { eol = '\r\n', close = true }: { eol?: string; close?: boolean } = {},
): number[] {
  const out = [...bin(top.join(eol)), ...bin(eol + eol)]
  if (boundary === null) return [...out, ...(parts[0]?.body ?? [])]
  for (const part of parts) {
    out.push(...bin(`--${boundary}${eol}${part.headers.join(eol)}${eol}${eol}`), ...part.body)
    out.push(...bin(eol))
  }
  if (close) out.push(...bin(`--${boundary}--${eol}`))
  return out
}

const BOUNDARY = '----=_NextPart_01D9'
const related = (boundary = BOUNDARY): string[] => [
  'MIME-Version: 1.0',
  `Content-Type: multipart/related; boundary="${boundary}"`,
]

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]
const PNG_BASE64 = bin(Buffer.from(PNG).toString('base64'))

const image = (headers: string[], body = PNG_BASE64): Part => ({
  headers: ['Content-Transfer-Encoding: base64', ...headers],
  body,
})

const WORD_HTML = bin(
  '<html><body><p>caf=C3=A9 =\r\nsoft=\nbreak</p>' +
    '<img src=3D"Doc_files/image001.png">' +
    "<img src=3D'file:///C:/Users/x/Doc_files/IMAGE001.png'>" +
    '<img SRC =3D cid:IMG2@X>' +
    '<v:imagedata src=3D"Doc_files/image003.gif" o:href=3D"cid:missing"/>' +
    '<a href=3D"other.htm" xhref=3D"Doc_files/image001.png">x</a>' +
    '<img src=3D"">' +
    '</body></html>',
)

const WORD_MHT = mime(related(), BOUNDARY, [
  {
    headers: [
      'Content-Location: file:///C:/Users/x/Doc.htm',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Type: text/html; charset="utf-8"',
    ],
    body: WORD_HTML,
  },
  image(['Content-Location: file:///C:/Users/x/Doc_files/image001.png', 'Content-Type: image/png']),
  image(['Content-ID: <img2@x>', 'Content-Type: IMAGE/GIF; name="a.gif"']),
  image(['Content-Location: Doc_files/image003.gif', 'Content-Type: image/gif']),
])

const html = (body: string, headers: string[] = ['Content-Type: text/html']): Part => ({
  headers,
  body: utf8(`<html><body>${body}</body></html>`),
})

const REFERENCING = html(
  '<img src="a.png"><img src=\'B.PNG\'><img src=c.png><a href = "cid:d">x</a>',
)

const MHT_BYTES: number[][] = [
  [],
  bin('Content-Type: text/html\r\n\r\n<p>top level</p>'),
  bin('Content-Type: text/html\n\n<p>LF only</p>'),
  bin('Content-Type: text/html\r\n\n<p>mixed</p>'),
  bin('Content-Type: text/html\n\r\n<p>mixed</p>'),
  bin('Content-Type: text/html\r\n\r<p>no blank line</p>'),
  bin('Content-Type: text/html'),
  bin('Content-Type: text/plain\r\n\r\n<p>plain</p>'),
  bin('Content-Type:   TEXT/HTML ; charset=utf-8\r\n\r\n<p>caps</p>'),
  bin('Content-Type: xtext/html\r\n\r\n<p>no</p>'),
  bin('\r\n\r\n<p>no headers</p>'),
  WORD_MHT,
  mime(related(), BOUNDARY, [
    html('<img src="a.png">', ['Content-Type: text/html', 'Content-Location: http://x/doc/']),
    image(['Content-Location: http://x/doc/a.png', 'Content-Type: image/png']),
  ]),
  // LF line ends, an unquoted boundary, folded headers
  mime(
    [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related;\n\tboundary=simple;\n type="text/html"',
    ],
    'simple',
    [REFERENCING, image(['Content-Location: a.png', 'Content-Type: image/png'])],
    { eol: '\n' },
  ),
  mime(['Content-Type: multipart/related;', ' boundary="folded"'], 'folded', [
    REFERENCING,
    image(['Content-Location: B.png', 'Content-Type: image/png']),
  ]),
  // a header line without a colon, one with the colon first, a header set twice
  mime(
    [
      'Content-Type: text/plain',
      'no colon here',
      ': empty name',
      `Content-Type: multipart/related; boundary=b`,
    ],
    'b',
    [
      html('<img src="cid:x">', ['Content-Type: text/html', 'garbage']),
      image(['content-id: <x>', 'CONTENT-TYPE: image/png', 'Content-Type: image/jpeg']),
    ],
  ),
  // Content-ID forms
  mime(related('c'), 'c', [
    html('<img src="cid:a"><img src="cid:"><img src="cid:b"><img src="cid:<c>">'),
    image(['Content-ID: a', 'Content-Type: image/png']),
    image(['Content-ID: <>', 'Content-Type: image/png']),
    image(['Content-ID: <b', 'Content-Type: image/png']),
    image(['Content-ID: <<c>>', 'Content-Type: image/png']),
  ]),
  // a base not the prefix of the location, and an empty location
  mime(related('d'), 'd', [
    html('<img src="a.png"><img src="other/a.png">', [
      'Content-Type: text/html',
      'Content-Location: file:///C:/doc/page.htm',
    ]),
    image(['Content-Location: file:///D:/other/a.png', 'Content-Type: image/png']),
    image(['Content-Location:', 'Content-Type: image/png']),
  ]),
  // parts that are not images, and an image with no way to reference it
  mime(related('e'), 'e', [
    html('<link href="style.css">'),
    { headers: ['Content-Location: style.css', 'Content-Type: text/css'], body: bin('p{}') },
    image(['Content-Type: image/png']),
  ]),
  // U+017F is an s only under Unicode case folding: its attribute is no src
  mime(related('g'), 'g', [
    html('<img x\u017frc="a.png"><img src="a.png"><img X\u017fRC=a.png>'),
    image(['Content-Location: a.png', 'Content-Type: image/png']),
  ]),
  // no text/html part, and an html part inside a nested multipart
  mime(related('f'), 'f', [image(['Content-Location: a.png', 'Content-Type: image/png'])]),
  mime(related('outer'), 'outer', [
    {
      headers: ['Content-Type: multipart/alternative; boundary="inner"'],
      body: mime([], 'inner', [html('<p>nested</p>')]).slice(4),
    },
  ]),
  mime(related('outer'), 'outer', [
    {
      headers: ['Content-Type: multipart/alternative; boundary="inner"'],
      body: mime([], 'inner', [html('<p>nested</p>')]).slice(4),
    },
    html('<p>second</p>'),
  ]),
  // the transfer encodings
  mime(related('g'), 'g', [
    {
      headers: ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: BASE64'],
      body: bin(
        Buffer.from('<p>caf\u00e9 \ud55c</p>')
          .toString('base64')
          .replace(/(.{8})/g, '$1\r\n'),
      ),
    },
  ]),
  mime(related('h'), 'h', [
    {
      headers: ['Content-Type: text/html', 'Content-Transfer-Encoding: Quoted-Printable'],
      body: bin('<p>=E2=82=AC =3d =ZZ =4 end=\r\nnext ==\r\n41 =</p>='),
    },
  ]),
  mime(related('i'), 'i', [
    {
      headers: ['Content-Type: text/html; charset=euc-kr', 'Content-Transfer-Encoding: 8bit'],
      body: [...bin('<p>'), ...EUC_KR, ...bin('</p>')],
    },
  ]),
  mime(related('j'), 'j', [
    {
      headers: ['Content-Type: text/html', 'Content-Transfer-Encoding: binary'],
      body: page(meta('shift_jis'), SHIFT_JIS),
    },
  ]),
  mime(related('k'), 'k', [
    {
      headers: ['Content-Type: text/html', 'Content-Transfer-Encoding: x-unknown'],
      body: [0xef, 0xbb, 0xbf, ...utf8('<p>bom</p>')],
    },
  ]),
  // atob throws: a "=" inside, a length of 4n+1
  mime(related('l'), 'l', [
    html('<img src="a.png">'),
    image(['Content-Location: a.png', 'Content-Type: image/png'], bin('QU=JD')),
  ]),
  mime(related('l'), 'l', [
    html('<img src="a.png">'),
    image(['Content-Location: a.png', 'Content-Type: image/png'], bin('QUJDR')),
  ]),
  mime(related('l'), 'l', [
    {
      headers: ['Content-Type: text/html', 'Content-Transfer-Encoding: base64'],
      body: bin('PHA+==='),
    },
  ]),
  // atob accepts: padding, no padding, junk dropped
  mime(related('m'), 'm', [
    html('<img src="a"><img src="b"><img src="c"><img src="d">'),
    image(['Content-Location: a', 'Content-Type: image/png'], bin('QUI=')),
    image(['Content-Location: b', 'Content-Type: image/png'], bin('QUI')),
    image(['Content-Location: c', 'Content-Type: image/png'], bin('Q U\u00e9I*==')),
    image(['Content-Location: d', 'Content-Type: image/png'], bin('QR==')),
  ]),
  // charset parameter forms of the html part
  ...[
    'charset="\'euc-kr\'"',
    'charset=" euc-kr "',
    "charset='euc-kr'",
    'charset=\u00a0euc-kr',
    'charset=""',
    'charset=bogus',
    'charset=utf-8',
    'CHARSET = "UTF-16LE"',
    'charset=replacement',
  ].map((param) =>
    mime(related('n'), 'n', [
      {
        headers: [`Content-Type: text/html; ${param}`],
        body: [...bin('<meta charset="big5"><p>'), ...EUC_KR, ...bin('</p>')],
      },
    ]),
  ),
  // the closing boundary, a missing one, parts after it, CR only, text before the first
  mime(related('o'), 'o', [html('<p>one</p>'), html('<p>two</p>')], { close: false }),
  [
    ...mime(related('o'), 'o', [html('<p>one</p>')]),
    ...bin('--o\r\nContent-Type: text/html\r\n\r\nafter'),
  ],
  [
    ...bin('Content-Type: multipart/related; boundary=o\r\n\r\npreamble --o-x\r\n'),
    ...bin('Content-Type: text/html\r\n\r\n<p>x</p>--o'),
  ],
  bin(
    'Content-Type: multipart/related; boundary=o\r\n\r\n--o\rContent-Type: text/html\r\n\r\n<p>cr</p>\r--o--',
  ),
  bin(
    'Content-Type: multipart/related; boundary=o\r\n\r\n--o--\r\n--o\r\nContent-Type: text/html\r\n\r\nx',
  ),
  bin('Content-Type: multipart/related; boundary=o\r\n\r\n--o'),
  bin('Content-Type: multipart/related; boundary=o\r\n\r\n--o\r\n'),
  bin(
    'Content-Type: multipart/related; boundary=o\r\n\r\n--o\r\n--o\r\nContent-Type: text/html\r\n\r\ny',
  ),
  // a boundary with a Latin-1 letter: the marker is its UTF-8, not its byte
  [
    ...bin('Content-Type: multipart/related; boundary="caf\u00e9"\r\n\r\n--caf\u00e9\r\n'),
    ...bin('Content-Type: text/html\r\n\r\n<p>latin1 marker</p>'),
  ],
  [
    ...bin('Content-Type: multipart/related; boundary="caf\u00e9"\r\n\r\n'),
    ...utf8('--caf\u00e9\r\n'),
    ...bin('Content-Type: text/html\r\n\r\n<p>utf-8 marker</p>'),
  ],
  // the header block is searched in its first 65536 bytes
  bin(
    `Content-Type: text/html\r\nX-Pad: ${'a'.repeat(65536 - 34)}\r\n\r\n<p>blank line inside</p>`,
  ),
  bin(
    `Content-Type: text/html\r\nX-Pad: ${'a'.repeat(65536 - 33)}\r\n\r\n<p>blank line across</p>`,
  ),
  bin(`X-Pad: ${'a'.repeat(70000)}\r\nContent-Type: text/html\r\n\r\n<p>header past it</p>`),
  mime(related('p'), 'p', [
    html('<p>part header past it</p>', [`X-Pad: ${'a'.repeat(65536)}`, 'Content-Type: text/html']),
  ]),
  mime(related('p'), 'p', [
    html('<p>part header inside</p>', [`X-Pad: ${'a'.repeat(65000)}`, 'Content-Type: text/html']),
  ]),
]

// ------------------------------------------------------------ altChunkPartPath

const AF_CHUNK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk'

const rel = (target: string, type = AF_CHUNK, targetMode?: string): RelInfo =>
  targetMode === undefined ? { target, type } : { target, type, targetMode }

const RELS: Array<[string, RelInfo]> = [
  ['rId1', rel('afchunk.htm')],
  ['rId2', rel('../chunk.mht')],
  ['rId3', rel('/word/afchunk2.docx')],
  ['rId4', rel('x%20y.htm')],
  ['rId5', rel('%E0%A4%A.htm')],
  ['rId6', rel('http://example.com/a.htm')],
  ['rId7', rel('a.htm#frag')],
  ['rId8', rel('#only')],
  ['rId9', rel('../../outside.htm')],
  ['rId10', rel('a.htm', AF_CHUNK, 'External')],
  ['rId11', rel('a.htm', AF_CHUNK, 'Internal')],
  ['rId12', rel('a.htm', `${AF_CHUNK}X`)],
  ['rId13', rel('a.htm', AF_CHUNK.toLowerCase())],
  ['rId14', rel('a.htm', '/aFChunk')],
  ['rId15', rel('a.htm', 'aFChunk')],
  ['rId16', rel('sub\\chunk.htm')],
  ['rId17', rel('\\rooted.htm')],
  ['rId18', rel('./a/./b/../c.htm')],
  ['rId19', rel('')],
  ['rId20', rel('C:/x.htm')],
  ['rId21', rel('\u00e9t\u00e9 \ud55c.htm')],
  ['rId22', rel('a.htm', `${AF_CHUNK}\n`)],
  ['__proto__', rel('proto.htm')],
  ['constructor', rel('ctor.htm')],
]

const SOURCES: Array<string | undefined> = [
  undefined,
  'word/document.xml',
  'word/glossary/document.xml',
  'document.xml',
  '',
  '/',
]

const PART_PATH_IDS = [...RELS.map(([id]) => id), 'rId99', 'toString', 'hasOwnProperty', '']

/** Every relationship of a .rels part as `[id, RelInfo]`, attributes read as written. */
function relsOf(xml: string): Array<[string, RelInfo]> {
  const out: Array<[string, RelInfo]> = []
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const attrs = new Map<string, string>()
    for (const m of tag.matchAll(/\b(Id|Type|Target|TargetMode)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs.set(m[1]!, m[2] ?? m[3] ?? '')
    const id = attrs.get('Id')
    if (!id) continue
    const info: RelInfo = { target: attrs.get('Target') ?? '', type: attrs.get('Type') ?? '' }
    const mode = attrs.get('TargetMode')
    out.push([id, mode === undefined ? info : { ...info, targetMode: mode }])
  }
  return out
}

/** `[Content_Types].xml` overrides by part name, without the leading slash. */
function overridesOf(parts: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const tag of parts.get('[Content_Types].xml')?.match(/<Override\b[^>]*>/g) ?? []) {
    const name = /\bPartName\s*=\s*"([^"]*)"/.exec(tag)?.[1]
    const type = /\bContentType\s*=\s*"([^"]*)"/.exec(tag)?.[1]
    if (name !== undefined && type !== undefined) out.set(name.replace(/^\//, ''), type)
  }
  return out
}

// ------------------------------------------------------------ altChunkKind

const KIND_HEADS: number[][] = [
  [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x03],
  [0x50, 0x4b, 0x05, 0x06],
  bin('MIME-Version: 1.0\r\n'),
  bin('  \r\n\tFrom: someone'),
  bin('subject: x'),
  bin('CONTENT-TYPE: text/html'),
  bin('Content-Type : text/html'),
  bin('Content-Typo: x'),
  bin('X-From: x'),
  [0xa0, ...bin('From: nbsp is white space')],
  [0x85, ...bin('From: U+0085 is not')],
  [0xef, 0xbb, 0xbf, ...bin('From: a BOM as Latin-1 is not')],
  [0x0b, 0x0c, ...bin('Subject: vt ff')],
  bin('<!DOCTYPE html><html>'),
  bin('<!doctype\n\tHTML>'),
  [...bin('<!doctype'), 0xa0, ...bin('html>')],
  bin('<!doctypehtml>'),
  bin('<html>'),
  bin('<HTML lang="en">'),
  bin('<html\t'),
  bin('<html'),
  bin('<htmlx>'),
  bin('text before <html>'),
  bin('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">'),
  bin('hello'),
  [],
  [...bin(' '.repeat(5000)), ...bin('<html>')],
]

const KIND_CONTENT_TYPES: Array<string | undefined> = [
  undefined,
  'text/html',
  'TEXT/HTML; charset=utf-8',
  ' text/html ',
  'text/htmlx',
  ';text/html',
  'application/xhtml+xml',
  'message/rfc822',
  'Multipart/Related; boundary=x',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/octet-stream',
  '',
  '\u00a0text/html\ufeff',
]

const KIND_PATHS = [
  'word/afchunk.htm',
  'a.HTML',
  'a.xhtml',
  'a.mht',
  'a.MHTML',
  'a.eml',
  'a.docx',
  'a.DOCM',
  'a.dotx',
  'a.dotm',
  'a.html.bin',
  'dir.htm/file',
  'afchunk',
  'a.',
  '',
  '.htm',
  'a.\u0130htm',
]

const kindInputs: Input[] = [
  ...KIND_HEADS.flatMap((head) =>
    ['chunk.bin', 'a.htm'].map((path) => ({ args: { path, bytes: head } })),
  ),
  ...KIND_CONTENT_TYPES.flatMap((contentType) =>
    [[0x50, 0x4b, 0x03, 0x04], bin('From: x'), bin('<html>'), bin('x')].map((head) => ({
      args: { path: 'word/afchunk.bin', contentType, bytes: head },
    })),
  ),
  ...KIND_PATHS.flatMap((path) =>
    [undefined, 'text/plain', 'text/html'].map((contentType) => ({
      text: 'From: sniffed',
      args: { path, contentType },
    })),
  ),
]

// ------------------------------------------------------------ the specs

export const ALTCHUNK: CallSpec[] = [
  {
    fn: 'altchunk.altChunkKind',
    call: (text, args) =>
      altChunkKind(String(args.path), args.contentType as string | undefined, bytesOf(text, args)),
    fromDocument: (parts) => {
      const overrides = overridesOf(parts)
      return [...parts].map(([path, text]) => ({
        text: cut(text, 4096),
        args: { path, contentType: overrides.get(path) },
      }))
    },
    built: kindInputs,
  },
  {
    fn: 'altchunk.decodeHtmlBytes',
    call: (text, args) => decodeHtmlBytes(bytesOf(text, args)),
    fromDocument: (parts) =>
      [...parts]
        .filter(([path]) => path.endsWith('.xml'))
        .map(([, text]) => ({ text: cut(text, 70_000) })),
    built: [
      ...bytes(HTML_BYTES),
      { text: '<meta charset="euc-kr">\ud55c\uae00' },
      { text: '<?xml version="1.0" encoding="UTF-16"?><r>\u00e9</r>' },
      { text: '\ufeffBOM as text' },
    ],
  },
  {
    fn: 'altchunk.decodeQuotedPrintable',
    call: (text) => Array.from(decodeQuotedPrintable(text)),
    fromDocument: (parts) =>
      [...parts]
        .filter(([path]) => path.endsWith('.xml'))
        .map(([, text]) => ({ text: cut(text, 16_384) })),
    built: [
      '',
      'plain',
      'a=3Db',
      'a=3db=3D',
      'soft=\r\nbreak',
      'soft=\nbreak',
      'soft=\rbreak',
      '=\r\n',
      '=\n=\n=\n',
      'x==\r\n41',
      '==41',
      '=3D41',
      'bad=ZZ',
      'bad=4',
      '=4G',
      '=G4',
      'end=',
      'end=4',
      'end=41',
      '=',
      '==',
      '= 41',
      '=E2=82=AC',
      '=e2=82=ac',
      '=0A=0D=00=FF',
      'caf\u00e9',
      '\ud55c\uae00',
      '\u{1F600}=41',
      '=\u{1F600}',
      '=\uff11\uff11',
      '\u0100\u013d',
      `${'line of seventy characters '.repeat(3)}=\r\n${'x'.repeat(76)}`,
    ].map((text) => ({ text })),
  },
  {
    fn: 'altchunk.decodeMhtToHtml',
    call: (text, args) => decodeMhtToHtml(bytesOf(text, args)),
    fromDocument: (parts) => {
      const document = parts.get('word/document.xml')
      if (document === undefined) return []
      return [
        {
          args: {
            bytes: mime(related('doc'), 'doc', [
              {
                headers: ['Content-Type: text/html; charset=utf-8'],
                body: utf8(cut(document, 20_000)),
              },
            ]),
          },
        },
      ]
    },
    built: [
      ...bytes(MHT_BYTES),
      { text: 'Content-Type: text/html\r\n\r\n<p>\ud55c\uae00</p>' },
      {
        text:
          'Content-Type: multipart/related; boundary="b"\n\n--b\nContent-Type: text/html\n\n' +
          '<img src="x.png">\n--b\nContent-Location: x.png\nContent-Type: image/png\n\niVBORw==\n--b--\n',
      },
      { text: 'not a message at all' },
    ],
  },
  {
    fn: 'altchunk.altChunkPartPath',
    call: (_text, args) =>
      altChunkPartPath(
        new Map(args.rels as Array<[string, RelInfo]>),
        String(args.rId),
        args.sourcePath as string | undefined,
      ),
    fromDocument: (parts) =>
      [...parts]
        .filter(([path]) => path.endsWith('.rels'))
        .flatMap(([path, xml]) => {
          const rels = relsOf(xml)
          // word/_rels/document.xml.rels belongs to word/document.xml
          const sourcePath = path.replace(/_rels\/([^/]*)\.rels$/, '$1')
          return rels.map(([rId]) => ({ args: { rels, rId, sourcePath } }))
        }),
    built: [
      ...SOURCES.flatMap((sourcePath) =>
        PART_PATH_IDS.map((rId) => ({ args: { rels: RELS, rId, sourcePath } })),
      ),
      { args: { rels: [], rId: 'rId1' } },
      {
        args: {
          rels: [
            ['rId1', rel('a.htm')],
            ['rId1', rel('b.htm')],
          ],
          rId: 'rId1',
        },
      },
    ],
    mutation: 'none',
  },
]
