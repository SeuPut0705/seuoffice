// Groups `charclass` and `xmltag` of comparison (f): char-class.ts, the one
// character classification of the layout rules, and xml-tag.ts, start tags
// read through their quoted attribute values.
// The other predicates of char-class.ts stay TypeScript only (the layout calls
// them per character, too often for a wasm call each): no Rust to compare.
import { charClass, isDoubleByteChar, isEastAsianLangTag } from './reference/char-class'
import { findStartTag, removeElements } from './reference/xml-tag'
import type { CallSpec, Input } from './calls-spec'

/** Every boundary of every range charClass names, one either side, and a few inside. */
const BOUNDARIES = [
  0x00, 0x08, 0x09, 0x0a, 0x1f, 0x20, 0x21, 0x2f, 0x30, 0x39, 0x3a, 0x40, 0x41, 0x5a, 0x5b, 0x60,
  0x61, 0x7a, 0x7b, 0x7e, 0x7f, 0x80, 0x9f, 0xa0, 0xa1, 0xbf, 0xc0, 0xd6, 0xd7, 0xd8, 0xf6, 0xf7,
  0xf8, 0x24f, 0x250, 0x10ff, 0x1100, 0x11ff, 0x1200, 0x2e7f, 0x2e80, 0x2fff, 0x3000, 0x3001,
  0x3004, 0x3005, 0x3006, 0x3007, 0x3008, 0x3020, 0x3021, 0x3029, 0x302a, 0x303f, 0x3040, 0x30fa,
  0x30fb, 0x30fc, 0x30ff, 0x3100, 0x312f, 0x3130, 0x318f, 0x3190, 0x319f, 0x31a0, 0x31bf, 0x31c0,
  0x31ef, 0x31f0, 0x31ff, 0x3200, 0x33ff, 0x3400, 0x4dbf, 0x4dc0, 0x4dff, 0x4e00, 0x9fff, 0xa000,
  0xa95f, 0xa960, 0xa97f, 0xa980, 0xabff, 0xac00, 0xd7af, 0xd7b0, 0xd7ff, 0xd800, 0xdfff, 0xe000,
  0xf8ff, 0xf900, 0xfaff, 0xfb00, 0xfeff, 0xff00, 0xff60, 0xff61, 0xffdc, 0xffdd, 0xffdf, 0xffe0,
  0xffe6, 0xffe7, 0xffe8, 0xffee, 0xffef, 0xfffd, 0xffff, 0x10000, 0x1ffff, 0x20000, 0x2a6df,
  0x3ffff, 0x40000, 0x10ffff,
]

// a lone surrogate cannot cross the wire as text; as a code point it can
const CODE_POINTS: Input[] = BOUNDARIES.map((cp) => ({ args: { cp } }))

const pointSpec = (name: string, fn: (cp: number) => unknown): CallSpec => ({
  fn: `charclass.${name}`,
  call: (_text, args) => fn(Number(args.cp)),
  built: CODE_POINTS,
  mutation: 'none',
})

const LANG_TAGS: unknown[] = [
  null,
  '',
  'ko',
  'ko-KR',
  'KO_kr',
  'ja',
  'ja-JP',
  'zh',
  'zh-Hant',
  'zhx',
  'kor',
  'en-US',
  '-ko',
  'ko-',
]

export const CHARCLASS: CallSpec[] = [
  pointSpec('charClass', charClass),
  pointSpec('isDoubleByteChar', isDoubleByteChar),
  {
    fn: 'charclass.isEastAsianLangTag',
    call: (_text, args) =>
      args.korean === undefined
        ? isEastAsianLangTag(args.tag as string | null)
        : isEastAsianLangTag(args.tag as string | null, Boolean(args.korean)),
    fromDocument: (parts) =>
      [
        ...new Set(
          [...(parts.get('word/styles.xml') ?? '').matchAll(/w:eastAsia="([^"]*)"/g)].map(
            (m) => m[1]!,
          ),
        ),
      ]
        .slice(0, 10)
        .map((tag) => ({ args: { tag } })),
    built: LANG_TAGS.flatMap((tag) => [{ args: { tag } }, { args: { tag, korean: false } }]),
    mutation: 'none',
  },
]

/** Start tags with quoted `>`, both quote kinds, self-closing forms, longer names and open ends. */
const TAG_TEXTS = [
  '<w:pPrChange w:author="a>b" w:id="1"><w:pPr/></w:pPrChange>',
  "<w:pPrChange w:author='a>b'/><w:p/>",
  '<w:pPrChangeX/><w:pPrChange/>',
  '<w:pPrChange\t/>',
  '<w:pPrChange\u3000/>',
  '<w:pPrChange w:a="x/">tail</w:pPrChange>',
  '<w:pPrChange w:a="open',
  '<w:pPrChange><w:pPrChange/></w:pPrChange></w:pPrChange>',
  '<?xml version="1.0"?><!-- <w:pPrChange/> --><w:pPrChange/>',
  '<1a/><_b/><w:pPrChange a=">" b=\'"\'/>',
  '\u{1F600}<w:pPrChange/>\u{1F600}<w:pPrChange>x</w:pPrChange>',
  '<w:settings xmlns:w="urn:a>b"/>',
  '<settings/><x:settings a=">"/><w:settingsX/>',
  '<w:pPrChange>no close',
  '',
]

const NAMES: unknown[] = [
  'w:pPrChange',
  'w:settings',
  'w:p',
  '_b',
  undefined,
  { regex: 'settingsRoot' },
]

/** The one RegExp the engine passes: the settings root of patch.ts, under any prefix. */
const SETTINGS_ROOT = /^(?:[A-Za-z0-9._-]+:)?settings$/

const regexOf = (name: unknown): string | RegExp | undefined => {
  if (name && typeof name === 'object' && 'regex' in name && name.regex === 'settingsRoot')
    return SETTINGS_ROOT
  return typeof name === 'string' ? name : undefined
}

export const XMLTAG: CallSpec[] = [
  {
    fn: 'xmltag.findStartTag',
    call: (text, args) =>
      findStartTag(
        text,
        regexOf(args.name),
        args.from === undefined ? undefined : Number(args.from),
      ),
    fromDocument: (parts) =>
      ['word/document.xml', 'word/settings.xml', 'word/styles.xml']
        .filter((name) => parts.has(name))
        .flatMap((name) =>
          ['w:pPrChange', 'w:settings', 'w:pgSz'].map((tag) => ({
            text: parts.get(name)!.slice(0, 60_000),
            args: { name: tag },
          })),
        ),
    built: TAG_TEXTS.flatMap((text) =>
      NAMES.flatMap((name) =>
        [undefined, 0, 1, 5, 40].map((from) => ({
          text,
          args: {
            ...(name === undefined ? {} : { name }),
            ...(from === undefined ? {} : { from }),
          },
        })),
      ),
    ),
  },
  {
    fn: 'xmltag.removeElements',
    call: (text, args) =>
      args.limit === undefined
        ? removeElements(text, String(args.name))
        : removeElements(text, String(args.name), Number(args.limit)),
    fromDocument: (parts) =>
      [...parts]
        .filter(
          ([path, text]) =>
            path.endsWith('.xml') && /<w:(?:pPr|rPr|tblPr|trPr|tcPr|sectPr)Change\b/.test(text),
        )
        .flatMap(([, text]) =>
          ['w:pPrChange', 'w:rPrChange', 'w:tcPrChange'].map((name) => ({
            text: text.slice(0, 60_000),
            args: { name },
          })),
        ),
    built: TAG_TEXTS.flatMap((text) =>
      ['w:pPrChange', 'w:p'].flatMap((name) => [
        { text, args: { name } },
        { text, args: { name, limit: 1 } },
      ]),
    ),
  },
]
