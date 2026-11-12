// Group markers: symbol-fonts.ts and list-markers.ts.
import {
  computeListMarkerInfos,
  computeListMarkers,
  computeListValues,
  customEnumItems,
  formatNumber,
  type ListItemRef,
  markerFallbackFace,
  markerTabAdvance,
  SEGOE_UI_SYMBOL_RE,
  substituteBullet,
} from './reference/list-markers'
import { parseNumbering } from './reference/parse-package'
import {
  decodeSymbolChar,
  decodeSymbolText,
  isSymbolFont,
  symbolGlyph,
  symbolPuaChar,
  toSymbolPua,
} from './reference/symbol-fonts'
import type { NumberingDef } from './reference/types'
import { type CallSpec, type Input, zipOf } from './calls-spec'

const FONTS = [
  'Symbol',
  'Wingdings',
  'Wingdings 2',
  'Wingdings 3',
  'Webdings',
  ' SYMBOL ',
  '\uFEFFwingdings\t',
  'Symbol\u0085',
  'Wingdings2',
  'Calibri',
  'Courier New',
  '',
  // keys every object inherits, as the table is read (trimmed, lower case)
  'constructor',
  ' __PROTO__ ',
]

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** The code units the symbol functions test, both sides of each boundary. */
const CODES = [...range(0x00, 0x101), ...range(0xefff, 0xf101)]

const TEXTS = [
  '',
  ' ',
  '\u00a0',
  'abc',
  'l n',
  '\uf0b7\uf0a7',
  'a\u{1F600}b',
  '\u{1F600}',
  'o',
  '\t\r\n',
  'AB\u00ff\u0100',
  '\uf020\uf021',
  '>',
  '\uf03e',
  'J',
  'ÿ',
]

/** word/numbering.xml around the given abstractNum and num elements. */
const numbering = (body: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">' +
  body +
  '</w:numbering>'

const lvl = (ilvl: number, fmt: string, text: string, extra = '', start = '1'): string =>
  `<w:lvl w:ilvl="${ilvl}">${start === '' ? '' : `<w:start w:val="${start}"/>`}` +
  `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`

const font = (name: string): string =>
  `<w:rPr><w:rFonts w:ascii="${name}" w:hAnsi="${name}"/></w:rPr>`

const ORDERED = numbering(
  '<w:abstractNum w:abstractNumId="0">' +
    lvl(0, 'decimal', '%1.') +
    lvl(1, 'lowerLetter', '%1.%2.') +
    lvl(2, 'lowerRoman', '%3)', '', '4') +
    lvl(3, 'upperLetter', '(%4)', '', '') +
    lvl(4, 'upperRoman', '%1.%2.%3.%4.%5', '<w:isLgl/>') +
    lvl(5, 'decimalZero', '%6 %5 %0 %9', '<w:isLgl w:val="1"/>') +
    lvl(6, 'none', '') +
    lvl(7, 'decimal', '') +
    '<w:lvl w:ilvl="8"><w:start w:val="1"/><mc:AlternateContent><mc:Choice Requires="w14">' +
    '<w:numFmt w:val="custom" w:format="\u03b1, \u03b2, \u03b3, ..."/></mc:Choice>' +
    '<mc:Fallback><w:numFmt w:val="decimal"/></mc:Fallback></mc:AlternateContent>' +
    '<w:lvlText w:val="%9 %8"/></w:lvl>' +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1">' +
    lvl(0, 'chineseCounting', '\u7b2c%1\u7ae0', '', '9') +
    lvl(1, 'ganada', '%2.') +
    lvl(2, 'ordinalText', '%3 and %1', '<w:isLgl w:val="0"/>') +
    lvl(-1, 'upperRoman', '%0', '', '7') +
    lvl(3, 'decimalEnclosedCircle', '%4%1', '', '19') +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="0"/>' +
    '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride>' +
    '<w:lvlOverride w:ilvl="2"><w:startOverride w:val="0"/></w:lvlOverride></w:num>' +
    '<w:num w:numId="3"><w:abstractNumId w:val="0"/>' +
    `<w:lvlOverride w:ilvl="1">${lvl(1, 'upperRoman', '%1-%2', '', '3')}</w:lvlOverride></w:num>` +
    '<w:num w:numId="4"><w:abstractNumId w:val="1"/></w:num>' +
    '<w:num w:numId="5"><w:abstractNumId w:val="1"/>' +
    '<w:lvlOverride w:ilvl="1"><w:startOverride w:val="10"/></w:lvlOverride></w:num>' +
    '<w:num w:numId="6"><w:abstractNumId w:val="9"/></w:num>',
)

const BULLETS = numbering(
  '<w:abstractNum w:abstractNumId="7">' +
    lvl(0, 'bullet', '\uf0b7', font('Symbol')) +
    lvl(1, 'bullet', 'o', font('Courier New')) +
    lvl(2, 'bullet', '\uf0a7', font('Wingdings')) +
    lvl(3, 'bullet', 'l', font(' Wingdings ')) +
    lvl(4, 'bullet', '') +
    lvl(5, 'bullet', '\uf0d8') +
    lvl(6, 'bullet', 'x', '<w:lvlPicBulletId w:val="0"/>') +
    lvl(7, 'bullet', '\u2022', font('Calibri')) +
    lvl(8, 'bullet', '\uf080', font('Wingdings 2')) +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="8">' +
    lvl(0, 'bullet', '\ue000') +
    lvl(1, 'bullet', '-', font('Symbol')) +
    lvl(2, 'bullet', 'o') +
    lvl(3, 'bullet', 'x', '<w:lvlPicBulletId w:val="3"/>') +
    lvl(4, 'bullet', '\u25aa \u25aa', font('Arial')) +
    lvl(5, 'bullet', '\uf076') +
    lvl(6, 'bullet', 'q', font('Symbol')) +
    lvl(7, 'bullet', '\uf0fc') +
    lvl(8, 'bullet', 'ab', font('\u00a0')) +
    lvl(9, 'bullet', '\uf0b7', font('Times New Roman')) +
    lvl(10, 'bullet', '\uf0b7') +
    lvl(11, 'bullet', '\uf080', font('Symbol')) +
    lvl(12, 'bullet', '', font('Wingdings')) +
    '</w:abstractNum>' +
    // names every object inherits, as level text and as font
    '<w:abstractNum w:abstractNumId="9">' +
    lvl(0, 'bullet', 'constructor') +
    lvl(1, 'bullet', 'toString', font('constructor')) +
    lvl(2, 'bullet', '__proto__', font('__proto__')) +
    lvl(3, 'bullet', 'valueOf', font('Symbol')) +
    '</w:abstractNum>' +
    '<w:num w:numId="10"><w:abstractNumId w:val="7"/></w:num>' +
    '<w:num w:numId="11"><w:abstractNumId w:val="8"/></w:num>' +
    '<w:num w:numId="12"><w:abstractNumId w:val="9"/></w:num>',
)

const item = (numId: string | null, ilvl: number, deleted?: boolean): ListItemRef =>
  deleted === undefined ? { numId, ilvl } : { numId, ilvl, deleted }

const ITEM_LISTS: ListItemRef[][] = [
  [item('1', 0), item('1', 0), item('1', 1), item('1', 1), item('1', 0), item('1', 2)],
  [item('1', 2), item('1', 0), item('1', 3), item('1', 1), item('1', 4), item('1', 5)],
  [item('1', 6), item('1', 7), item('1', 8), item('1', 8), item('1', 9), item('1', 4)],
  [item('2', 0), item('2', 0), item('1', 0), item('2', 2), item('2', 2), item('3', 1)],
  [item('3', 1), item('3', 0), item('3', 1), item('2', 1), item('7', 0), item(null, 0)],
  [item('1', 0), item('1', 0, true), item('1', 0), item('2', 0, true), item('2', 0)],
  [item('1', 1, true), item('1', 1), item('1', 3, false), item('2', 3, true), item('2', 3)],
  [item('4', 0), item('4', 1), item('4', 2), item('4', 3), item('4', 0), item('5', 1)],
  [item('5', 1), item('5', 1), item('4', -1), item('4', -3), item('4', 1.5), item('6', 0)],
  [item('1', -1), item('1', -0.5), item('1', 10), item('1', 1e21), item('1', 0)],
  range(0, 10).map((l) => item('10', l)),
  range(0, 13).map((l) => item('11', l)),
  [item('10', 0), item('1', 0), item('10', 1), item('1', 0), item('11', 3)],
  range(0, 4).map((l) => item('12', l)),
]

const PICS: Array<Array<[number, string]> | undefined> = [
  undefined,
  [[0, 'data:image/png;base64,AAAA']],
  [
    [3, 'data:image/gif;base64,R0lG'],
    [3, ''],
    [0, 'first'],
    [0, 'second'],
  ],
]

const listInputs: Input[] = [
  ...ITEM_LISTS.flatMap((items) => [ORDERED, BULLETS].map((text) => ({ text, args: { items } }))),
  ...PICS.flatMap((pics) =>
    ITEM_LISTS.slice(10, 13).map((items) => ({ text: BULLETS, args: { items, pics } })),
  ),
  { text: '<w:numbering', args: { items: [item('1', 0)] } },
  { text: '', args: { items: [item('1', 0)] } },
  { text: ORDERED, args: { items: [] } },
]

/** List items in document order, from the w:numPr of the paragraphs. */
function itemsOf(document: string): ListItemRef[] {
  const items: ListItemRef[] = []
  for (const [pPr] of document.matchAll(/<w:pPr>[\s\S]*?<\/w:pPr>/g)) {
    const numId = /<w:numId w:val="([^"]*)"/.exec(pPr)?.[1]
    if (numId === undefined) continue
    const ilvl = Number(/<w:ilvl w:val="(-?\d+)"/.exec(pPr)?.[1] ?? 0)
    items.push(item(numId, ilvl, /<w:rPr>[\s\S]*<w:del\b/.test(pPr) ? true : undefined))
    if (items.length >= 400) break
  }
  return items
}

/** Every w:num of the part at levels 0, 1, 2, 1, 0, 3. */
function sweepOf(text: string): ListItemRef[] {
  const ids = [...text.matchAll(/<w:num w:numId="([^"]*)"/g)].map((m) => m[1]!).slice(0, 40)
  return ids.flatMap((id) => [0, 1, 2, 1, 0, 3].map((l) => item(id, l)))
}

function listFromDocument(parts: ReadonlyMap<string, string>): Input[] {
  const text = parts.get('word/numbering.xml')
  if (text === undefined) return []
  const fromBody = itemsOf(parts.get('word/document.xml') ?? '')
  return [
    ...(fromBody.length > 0 ? [{ text, args: { items: fromBody } }] : []),
    { text, args: { items: sweepOf(text) } },
  ]
}

/** Entity references only: a numeric one could name a lone surrogate, which JSON cannot carry to Rust. */
const unescapeXml = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/** What one document holds for the character-level functions, deduplicated. */
interface CorpusValues {
  /** w:sym font and char */
  syms: Array<[font: string, char: string]>
  fonts: string[]
  /** w:lvl lvlText and the font of its w:rFonts ('' without one) */
  bullets: Array<[text: string, font: string]>
  /** w:lvl numFmt and w:start */
  formats: Array<[fmt: string, start: string]>
  customFormats: string[]
}

let corpusParts: ReadonlyMap<string, string> | undefined
let corpusValues: CorpusValues | undefined

function corpusOf(parts: ReadonlyMap<string, string>): CorpusValues {
  if (corpusParts === parts && corpusValues) return corpusValues
  const syms = new Map<string, [string, string]>()
  const fonts = new Set<string>()
  const bullets = new Map<string, [string, string]>()
  const formats = new Map<string, [string, string]>()
  const customFormats = new Set<string>()
  for (const [name, text] of parts) {
    if (!name.startsWith('word/') || !name.endsWith('.xml')) continue
    for (const m of text.matchAll(/<w:sym\b[^>]*>/g)) {
      const font = /w:font="([^"]*)"/.exec(m[0])?.[1]
      const char = /w:char="([^"]*)"/.exec(m[0])?.[1]
      if (font !== undefined && char !== undefined && syms.size < 60) {
        syms.set(`${font}\0${char}`, [unescapeXml(font), unescapeXml(char)])
      }
    }
    for (const m of text.matchAll(/w:(?:ascii|hAnsi)="([^"]*)"/g)) {
      if (fonts.size < 60) fonts.add(unescapeXml(m[1]!))
    }
  }
  const numbering = parts.get('word/numbering.xml') ?? ''
  for (const [lvl] of numbering.matchAll(/<w:lvl\b[\s\S]*?<\/w:lvl>/g)) {
    const lvlText = /<w:lvlText w:val="([^"]*)"/.exec(lvl)?.[1]
    const font = /<w:rFonts\b[^>]*w:ascii="([^"]*)"/.exec(lvl)?.[1] ?? ''
    if (lvlText !== undefined && bullets.size < 60) {
      bullets.set(`${lvlText}\0${font}`, [unescapeXml(lvlText), unescapeXml(font)])
    }
    const fmt = /<w:numFmt w:val="([^"]*)"/.exec(lvl)?.[1]
    const start = /<w:start w:val="([^"]*)"/.exec(lvl)?.[1] ?? '0'
    if (fmt !== undefined && formats.size < 60) formats.set(`${fmt}\0${start}`, [fmt, start])
    const custom = /w:format="([^"]*)"/.exec(lvl)?.[1]
    if (custom !== undefined) customFormats.add(unescapeXml(custom))
  }
  corpusParts = parts
  corpusValues = {
    syms: [...syms.values()],
    fonts: [...fonts],
    bullets: [...bullets.values()],
    formats: [...formats.values()],
    customFormats: [...customFormats],
  }
  return corpusValues
}

async function defsOf(text: string, pics: unknown): Promise<Map<string, NumberingDef>> {
  const { defs } = await parseNumbering(zipOf([['word/numbering.xml', text]]))
  const srcById = new Map<number, string>()
  for (const [id, src] of (pics ?? []) as Array<[number, string]>) if (src) srcById.set(id, src)
  for (const def of defs.values()) {
    for (const level of Object.values(def.levels)) {
      if (level.picBulletId === undefined || level.picBulletSrc) continue
      const src = srcById.get(level.picBulletId)
      if (src) level.picBulletSrc = src
    }
  }
  return defs
}

const NUM_FMTS = [
  'decimal',
  'decimalZero',
  'lowerLetter',
  'upperLetter',
  'lowerRoman',
  'upperRoman',
  'lowerGreek',
  'upperGreek',
  'chineseCounting',
  'chineseCountingThousand',
  'japaneseCounting',
  'taiwaneseCounting',
  'taiwaneseCountingThousand',
  'chineseLegalSimplified',
  'ideographLegalTraditional',
  'ideographDigital',
  'japaneseDigitalTenThousand',
  'taiwaneseDigital',
  'koreanDigital',
  'koreanDigital2',
  'decimalFullWidth',
  'decimalFullWidth2',
  'thaiNumbers',
  'hindiNumbers',
  'decimalEnclosedCircle',
  'decimalEnclosedCircleChinese',
  'decimalEnclosedParen',
  'decimalEnclosedFullstop',
  'ideographEnclosedCircle',
  'ideographTraditional',
  'ideographZodiac',
  'aiueo',
  'aiueoFullWidth',
  'irohaFullWidth',
  'ganada',
  'chosung',
  'russianLower',
  'russianUpper',
  'ordinal',
  'cardinalText',
  'ordinalText',
  'numberInDash',
  'none',
  'custom',
  'bullet',
  'hebrew1',
  '',
  'Decimal',
]

const VALUES = [
  ...range(-3, 30).map(String),
  ...[
    34, 35, 36, 40, 44, 46, 47, 48, 49, 50, 51, 52, 53, 99, 100, 101, 102, 110, 111, 112, 113, 114,
    121, 200, 1000, 1001, 1010, 1100, 1999, 2000, 3999, 4000, 9999, 10000, 10001, 12345, 100000,
    999999, 1000000, 1e9, -10, -11, -12, -13, -21, -100, -111,
  ].map(String),
  '-0',
  '0.5',
  '1.5',
  '-1.5',
  '12.9',
  '-0.5',
  'NaN',
  'Infinity',
  '-Infinity',
  '1e21',
  '-1e300',
]

const CUSTOM_FORMATS = ['\u03b1, \u03b2, \u03b3, ...', 'a,b', 'x', '', 'one, two, three, \u2026']

const formatInputs: Input[] = [
  ...NUM_FMTS.flatMap((fmt) => VALUES.map((value) => ({ text: fmt, args: { value } }))),
  ...CUSTOM_FORMATS.flatMap((customFormat) =>
    ['0', '1', '2', '3', '4', '7', '-1', 'NaN'].flatMap((value) => [
      { text: 'custom', args: { value, customFormat } },
      { text: 'decimal', args: { value, customFormat } },
    ]),
  ),
]

const ENUM_FORMATS = [
  '',
  '\u03b1, \u03b2, \u03b3, ...',
  'a,b',
  'a',
  'a,,b',
  'a, b, \u2026',
  'a,b,...,...',
  ' , ',
  '...',
  'a,b,..',
  'a,b,....',
  'a, b,\u2026, ',
  '\uFEFFa\uFEFF,\u00a0b',
  'a,b,c,d,e,f,g',
]

const FACES = [
  'Calibri',
  'Arial',
  'Times New Roman',
  'Cambria',
  'Aptos',
  'Verdana',
  'Tahoma',
  'Roboto',
  'Segoe UI Symbol',
  ' segoe ui symbol ',
  'Segoe UI Symbol2',
  'Symbol',
  'Wingdings',
  '',
  'constructor',
  '__proto__',
  'CALIBRI Light',
  'Cambria Math',
]

const GLYPHS = [
  '\u25b8',
  '\u25b9',
  '\u25c6',
  '\u25c7',
  '\u27a2',
  '\u27a4',
  '\u2714',
  '\u2726',
  '\u2756',
  '\u2605',
  '\u2606',
  '\u2794',
  '\u2713',
  '\u2610',
  '\u2611',
  '\u2023',
  '\u25a0',
  '\u25ba',
  '\u25b2',
  '\u25bc',
  '\u2043',
  '\u25aa',
  '\u25ab',
  '\u25a1',
  '\u25cf',
  '\u25e6',
  '\u2022',
  '1.',
  '',
  '\u{1F600}',
  'a',
  '\uf0b7',
]

const STARTS = [0, 360, -360, 720]
const WIDTHS = [0, 200, 360, 800, 1500.5]
const INDENTS = [0, 360, 720, 1440]
const TABS = [undefined, 720, 0, -1, 708.5]
const STOPS = [undefined, [], [500], [1000, 300], [300, 300], [2000], [-5, 100, 400], [540, 200]]

const tabInputs: Input[] = STARTS.flatMap((markerStart) =>
  WIDTHS.flatMap((markerWidth) =>
    INDENTS.flatMap((textIndent) =>
      TABS.flatMap((defaultTab) =>
        STOPS.map((customStops) => ({
          args: {
            markerStart,
            markerWidth,
            textIndent,
            ...(defaultTab === undefined ? {} : { defaultTab }),
            ...(customStops === undefined ? {} : { customStops }),
          },
        })),
      ),
    ),
  ),
)

const hex = (code: number): string => code.toString(16)

const listSpec = (
  fn: string,
  call: (items: ListItemRef[], defs: Map<string, NumberingDef>) => unknown,
): CallSpec => ({
  fn: `markers.${fn}`,
  call: async (text, args) => call(args.items as ListItemRef[], await defsOf(text, args.pics)),
  fromDocument: listFromDocument,
  built: listInputs,
})

export const MARKERS: CallSpec[] = [
  {
    fn: 'markers.isSymbolFont',
    call: (text) => isSymbolFont(text),
    fromDocument: (parts) => corpusOf(parts).fonts.map((text) => ({ text })),
    built: [...FONTS, 'webdings', 'WEBDINGS', 'wingdings 3 ', 'Segoe UI Symbol'].map((text) => ({
      text,
    })),
  },
  {
    fn: 'markers.decodeSymbolChar',
    call: (text, args) => decodeSymbolChar(text, args.code as number),
    fromDocument: (parts) =>
      corpusOf(parts).syms.map(([font, char]) => ({
        text: font,
        args: { code: parseInt(char, 16) },
      })),
    built: [
      ...FONTS.flatMap((text) =>
        [...CODES, -1, 0.5, 32.5, 0xf020 + 0.5, -0xf041, 1e21, 0x10041, 0xf141].map((code) => ({
          text,
          args: { code },
        })),
      ),
    ],
  },
  {
    fn: 'markers.symbolPuaChar',
    call: (text) => symbolPuaChar(text),
    fromDocument: (parts) => corpusOf(parts).syms.map(([, text]) => ({ text })),
    built: [
      ...range(0, 0x101).map((code) => ({ text: hex(code) })),
      ...['F0B7', 'f0b7', '0x41', '0X1F', '-41', '', 'zz', '  7f', '1g', '+ff', 'ffffffffff'].map(
        (text) => ({ text }),
      ),
      { text: 'f'.repeat(300) },
    ],
  },
  {
    fn: 'markers.symbolGlyph',
    call: (text, args) => symbolGlyph(args.font as string, text),
    fromDocument: (parts) => corpusOf(parts).syms.map(([font, text]) => ({ text, args: { font } })),
    built: FONTS.flatMap((font) =>
      [
        ...range(0x1f, 0x100).map(hex),
        ...range(0x1f, 0x100).map((code) => `F0${hex(code).padStart(2, '0')}`),
        'zz',
        '',
        '-41',
        'f'.repeat(300),
        '0x6C',
        '1F0B7',
      ].map((text) => ({ text, args: { font } })),
    ),
  },
  {
    fn: 'markers.toSymbolPua',
    call: (text) => toSymbolPua(text),
    fromDocument: (parts) => corpusOf(parts).bullets.map(([text]) => ({ text })),
    built: [...TEXTS, ...range(0x1f, 0x101).map((code) => String.fromCodePoint(code))].map(
      (text) => ({ text }),
    ),
  },
  {
    fn: 'markers.decodeSymbolText',
    call: (text, args) =>
      decodeSymbolText(args.font as string, text, {
        textGlyphsOnly: args.textGlyphsOnly as boolean | undefined,
      }),
    fromDocument: (parts) =>
      corpusOf(parts).bullets.flatMap(([text, font]) => [
        { text, args: { font } },
        { text, args: { font, textGlyphsOnly: true } },
      ]),
    built: [
      ...FONTS.flatMap((font) =>
        [...TEXTS, ...CODES.map((code) => String.fromCodePoint(code))].flatMap((text) => [
          { text, args: { font } },
          { text, args: { font, textGlyphsOnly: true } },
        ]),
      ),
    ],
  },
  {
    fn: 'markers.customEnumItems',
    call: (text) => customEnumItems(text),
    fromDocument: (parts) => corpusOf(parts).customFormats.map((text) => ({ text })),
    built: ENUM_FORMATS.map((text) => ({ text })),
  },
  {
    fn: 'markers.formatNumber',
    call: (text, args) =>
      formatNumber(Number(args.value), text, args.customFormat as string | undefined),
    fromDocument: (parts) => {
      const { formats, customFormats } = corpusOf(parts)
      return [
        ...formats.flatMap(([text, start]) =>
          [start, '1', '12', '27'].map((value) => ({ text, args: { value } })),
        ),
        ...customFormats.flatMap((customFormat) =>
          ['1', '5'].map((value) => ({ text: 'custom', args: { value, customFormat } })),
        ),
      ]
    },
    built: formatInputs,
  },
  {
    fn: 'markers.substituteBullet',
    call: (text) => substituteBullet(text),
    fromDocument: (parts) => corpusOf(parts).bullets.map(([text]) => ({ text })),
    built: [
      ...['\u2022', '\u25cf', '\u25aa', '', '1.', 'o', '\u2022\u2022', ' \u2022'],
      ...['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'],
    ].map((text) => ({ text })),
  },
  {
    fn: 'markers.SEGOE_UI_SYMBOL_RE',
    call: (text) => SEGOE_UI_SYMBOL_RE.test(text),
    fromDocument: (parts) => corpusOf(parts).fonts.map((text) => ({ text: text.toLowerCase() })),
    built: [
      'segoe ui symbol',
      'Segoe UI Symbol',
      'segoe ui symbol ',
      'segoe ui symbol\n',
      ' segoe ui symbol',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'markers.markerFallbackFace',
    call: (text, args) => markerFallbackFace(args.glyph as string, text),
    fromDocument: (parts) =>
      corpusOf(parts).bullets.map(([glyph, text]) => ({ text, args: { glyph } })),
    built: [...FACES.flatMap((text) => GLYPHS.map((glyph) => ({ text, args: { glyph } })))],
  },
  listSpec('computeListMarkerInfos', computeListMarkerInfos),
  listSpec('computeListValues', computeListValues),
  listSpec('computeListMarkers', computeListMarkers),
  {
    fn: 'markers.markerTabAdvance',
    call: (_text, args) =>
      markerTabAdvance(
        args.markerStart as number,
        args.markerWidth as number,
        args.textIndent as number,
        args.defaultTab as number | undefined,
        args.customStops as number[] | undefined,
      ),
    built: tabInputs,
    mutation: 'none',
  },
]
