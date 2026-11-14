import {
  decodeEntryText,
  encodeEntryText,
  type EpubTextEncoding,
} from '../../packages/epub-engine/src/encoding'
import {
  ADOBE_FONT_OBFUSCATION,
  deobfuscateFont,
  fontObfuscationKey,
  IDPF_FONT_OBFUSCATION,
  isFontObfuscationAlgorithm,
  obfuscateFont,
  obfuscateFontWithKey,
  type FontObfuscationAlgorithm,
} from '../../packages/epub-engine/src/fonts'
import {
  directoryOf,
  fileNameOf,
  hasUrlScheme,
  normalizeZipPath,
  resolveHref,
} from '../../packages/epub-engine/src/paths'
import { sha1 } from '../../packages/epub-engine/src/sha1'
import type { Input, Spec } from '../fileparse-diff/spec'

// Bytes leave as arrays of numbers: JSON.stringify writes a Uint8Array as an object keyed by index.
const list = (bytes: Uint8Array | null) => (bytes === null ? null : Array.from(bytes))
const utf8 = (text: string) => new TextEncoder().encode(text)
const units = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))

function bin(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = state >>> 24
  }
  return out
}

const OTHER_ALGORITHM = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'
const ALGORITHMS = [IDPF_FONT_OBFUSCATION, ADOBE_FONT_OBFUSCATION, OTHER_ALGORITHM] as const
const UUID = 'urn:uuid:12345678-1234-1234-1234-123456789abc'

const SCHEME_HREFS = [
  'https://example.com/x',
  'file:///c/x',
  'data:text/plain,x',
  'mailto:a@b',
  'C:\\book\\x',
  'c:/x',
  '  javascript:x',
  '\ufeffhttp:x',
  '\u00a0//host',
  '//host/a',
  '\\\\server\\share',
  '/\\x',
  '\\/x',
  'a+.-9:x',
  '1a:b',
  'a_b:c',
  'é:x',
  '\u212aa:x',
  'chapter.xhtml',
  'text/x:y',
  '/root.xhtml',
  '',
  ':x',
  'a',
  'a:',
]
const ZIP_PATHS = [
  '',
  '/',
  '.',
  '..',
  'a/./b',
  '../../x',
  'a/../../b',
  'a//b/',
  'OEBPS/../META-INF/container.xml',
  'a/b/..',
  'C:/x',
  '\\a\\..\\b',
  '/a/b/c.xhtml',
  'a/.../b',
  ' a / b ',
]
const SEGMENT_PATHS = [
  '',
  'a',
  'a/',
  '/a',
  'a/b/c.xhtml',
  'a//b',
  '/',
  'OEBPS/Text/ch1.xhtml',
  'a\\b',
]
const BASES = ['OEBPS/content.opf', 'toc.ncx', 'a/b/c.xhtml', '', '/abs/x.html', 'a/../b/c.xhtml']
const HREFS = [
  '',
  '#',
  '#frag',
  '#%E2%82',
  '#a%20b',
  'ch1.xhtml',
  '../../../etc/passwd',
  '/root.xhtml',
  '%2F..%2Fx',
  'a%zz.xhtml',
  'x.xhtml?q=1#f',
  'x?#',
  '?only',
  ' sp.xhtml ',
  'https://evil/x',
  '//h/x',
  '\\\\h\\x',
  'C:/win',
  'images/%ED%95%9C.png',
  '%2e%2e/%2e%2e/x',
  'a#b#c',
  '..',
  './',
  'a/%ED%A0%80.png',
  '#%ED%A0%80',
]
const IDENTIFIERS = [
  UUID,
  'URN:UUID:{ABCDEF01-2345-6789-ABCD-EF0123456789}',
  ' 12345678123412341234123456789abc ',
  'urn:uuid:1234',
  'urn:isbn:9780000000000',
  '',
  'id with\tspaces\r\n',
  '한글 id',
  'urn:uuid:12345678-1234-1234-1234-123456789abg',
  `urn:uuid:${UUID}`,
  `\u00a0${UUID}\ufeff`,
  '{12345678-1234-1234-1234-123456789abc}',
  'urn:uuid12345678123412341234123456789abc',
]
const KEYS: Record<string, number[]> = {
  empty: [],
  one: [0xff],
  three: [1, 2, 3],
  idpf: Array.from(fontObfuscationKey(IDPF_FONT_OBFUSCATION, UUID)!),
  adobe: Array.from(fontObfuscationKey(ADOBE_FONT_OBFUSCATION, UUID)!),
}
const FONT_LENGTHS = [0, 5, 1023, 1024, 1025, 1039, 1040, 1041]
const fonts = FONT_LENGTHS.map((length, i) => bin(length, 11 + i))

const DECODE_BYTES: Record<string, number[]> = {
  empty: [],
  ascii: [0x61, 0x62, 0x63],
  'utf8 bom': [0xef, 0xbb, 0xbf, 0x61],
  'utf8 korean': [...utf8('한글')],
  'le a': [0xff, 0xfe, 0x61, 0],
  'be a': [0xfe, 0xff, 0, 0x61],
  'le bom only': [0xff, 0xfe],
  'be bom only': [0xfe, 0xff],
  'le odd': [0xff, 0xfe, 0x61],
  'be odd': [0xfe, 0xff, 0, 0x61, 0],
  'le lead at end': [0xff, 0xfe, 0, 0xd8],
  'le lead then odd byte': [0xff, 0xfe, 0, 0xd8, 0x41],
  'le lead then ascii': [0xff, 0xfe, 0, 0xd8, 0x41, 0],
  'le lone trail': [0xff, 0xfe, 0, 0xdc, 0x41, 0],
  'le pair': [0xff, 0xfe, 0x3d, 0xd8, 0, 0xde],
  'be pair': [0xfe, 0xff, 0xd8, 0x3d, 0xde, 0],
  'be lead lead trail': [0xfe, 0xff, 0xd8, 0, 0xd8, 0, 0xdc, 0],
  'le pair then odd': [0xff, 0xfe, 0x3d, 0xd8, 0, 0xde, 7],
  'c3 28': [0xc3, 0x28],
  'e2 82': [0xe2, 0x82],
  surrogate: [0xed, 0xa0, 0x80],
  'f0 9f 98': [0xf0, 0x9f, 0x98, 0x41],
  'lone 80': [0x80],
  'past 10ffff': [0xf4, 0x90, 0x80, 0x80],
  overlong: [0xc0, 0xaf],
  'lone ff': [0xff],
  'fe ff fe': [0xfe, 0xff, 0xfe],
  'ff fe ff fe': [0xff, 0xfe, 0xff, 0xfe],
  'bom then bad': [0xef, 0xbb, 0xbf, 0xff, 0x61],
  'utf32le bom': [0xff, 0xfe, 0, 0, 0x61, 0, 0, 0],
}
const ENCODE_TEXTS: Record<string, number[]> = {
  empty: [],
  text: units('aé한😀'),
  bom: units('\ufeff<a/>'),
  'lone lead': [0xd800, 0x41],
  'lone trail': [0xdc00],
  'lead at end': [0x41, 0xd800],
  reversed: [0xde00, 0xd83d],
  nul: [0, 0xffff],
}
const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'latin1', 'UTF-8']

const font = (input: Input) => ({
  bytes: input.bytes ?? new Uint8Array(),
  algorithm: input.args?.algorithm as FontObfuscationAlgorithm,
})
const textSpec = (fn: string, texts: string[], call: (text: string) => unknown): Spec => ({
  fn,
  extensions: [],
  mutateText: true,
  call: ({ text = '' }) => call(text),
  built: () => texts.map((text) => ({ label: JSON.stringify(text), text })),
})
const byFont = (label: string) =>
  fonts.flatMap((bytes) =>
    ALGORITHMS.map((algorithm) => ({
      bytes,
      algorithm,
      label: `${label} ${bytes.length} ${algorithm}`,
    })),
  )

export const SPECS: Spec[] = [
  textSpec('hasUrlScheme', SCHEME_HREFS, hasUrlScheme),
  textSpec('normalizeZipPath', ZIP_PATHS, normalizeZipPath),
  textSpec('directoryOf', SEGMENT_PATHS, directoryOf),
  textSpec('fileNameOf', SEGMENT_PATHS, fileNameOf),
  {
    fn: 'resolveHref',
    extensions: [],
    mutateText: true,
    call: ({ text = '', args = {} }) => resolveHref(args.basePath as string, text),
    built: () =>
      BASES.flatMap((basePath) =>
        HREFS.map((text) => ({
          label: `${JSON.stringify(basePath)} ${JSON.stringify(text)}`,
          text,
          args: { basePath },
        })),
      ),
  },
  textSpec(
    'isFontObfuscationAlgorithm',
    [
      IDPF_FONT_OBFUSCATION,
      ADOBE_FONT_OBFUSCATION,
      '',
      ` ${IDPF_FONT_OBFUSCATION}`,
      ADOBE_FONT_OBFUSCATION.toUpperCase(),
      `${IDPF_FONT_OBFUSCATION}/`,
      OTHER_ALGORITHM,
    ],
    isFontObfuscationAlgorithm,
  ),
  {
    fn: 'fontObfuscationKey',
    extensions: [],
    mutateText: true,
    call: ({ text = '', args = {} }) =>
      list(fontObfuscationKey(args.algorithm as FontObfuscationAlgorithm, text)),
    built: () =>
      ALGORITHMS.flatMap((algorithm) =>
        IDENTIFIERS.map((text) => ({
          label: `${algorithm} ${JSON.stringify(text)}`,
          text,
          args: { algorithm },
        })),
      ),
  },
  {
    fn: 'obfuscateFontWithKey',
    extensions: [],
    mutation: 'none',
    call: (input) => {
      const { bytes, algorithm } = font(input)
      return list(
        obfuscateFontWithKey(bytes, algorithm, new Uint8Array(input.args?.key as number[])),
      )
    },
    built: () =>
      byFont('font').flatMap(({ bytes, algorithm, label }) =>
        Object.entries(KEYS).map(([name, key]) => ({
          label: `${label} key ${name}`,
          bytes,
          args: { algorithm, key },
        })),
      ),
  },
  ...(['obfuscateFont', 'deobfuscateFont'] as const).map((fn): Spec => ({
    fn,
    extensions: [],
    mutation: 'none',
    call: (input) => {
      const { bytes, algorithm } = font(input)
      return list(
        (fn === 'obfuscateFont' ? obfuscateFont : deobfuscateFont)(
          bytes,
          algorithm,
          input.text ?? '',
        ),
      )
    },
    built: () =>
      byFont('font').flatMap(({ bytes, algorithm, label }) =>
        [UUID, 'urn:isbn:1', ''].map((text) => ({
          label: `${label} ${JSON.stringify(text)}`,
          bytes,
          text,
          args: { algorithm },
        })),
      ),
  })),
  {
    fn: 'sha1',
    extensions: [],
    mutation: 'none',
    call: (input) => list(sha1(input.bytes ?? new Uint8Array())),
    built: () =>
      [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000].map((length) => {
        const bytes = length === 3 ? utf8('abc') : bin(length, 29 + length)
        return { label: `${length} bytes`, bytes }
      }),
  },
  {
    fn: 'decodeEntryText',
    extensions: [],
    mutation: 'none',
    call: (input) => decodeEntryText(input.bytes ?? new Uint8Array()),
    built: () =>
      Object.entries(DECODE_BYTES).map(([label, bytes]) => ({
        label,
        bytes: new Uint8Array(bytes),
      })),
  },
  {
    // `units` carries the text as UTF-16 code units so a lone surrogate reaches both sides intact.
    fn: 'encodeEntryText',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) =>
      list(
        encodeEntryText(
          String.fromCharCode(...(args.units as number[])),
          args.encoding as EpubTextEncoding,
        ),
      ),
    built: () =>
      Object.entries(ENCODE_TEXTS).flatMap(([name, text]) =>
        ENCODINGS.map((encoding) => ({
          label: `${name} ${encoding}`,
          args: { units: text, encoding },
        })),
      ),
  },
]
