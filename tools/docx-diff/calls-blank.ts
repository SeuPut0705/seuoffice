// Group `blank` of comparison (f): blank.ts, the template of a new document,
// and through buildBlankDocx the zip writer of crates/ooxml-pkg/src/write.rs.
import JSZip from 'jszip'
import {
  abstractNumXml,
  buildBlankDocx,
  customLevelFromNumberingLevel,
  customLevelXml,
  mergeLevelXml,
  numberingLevelFromCustom,
  numPicBulletXml,
  paperSizeForLocale,
  paperSizeForRegion,
  type BlankDocxOptions,
  type BlankPaperSize,
  type CustomNumberingLevel,
} from './reference/blank'
import { parseNumbering } from './reference/parse-package'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { mulberry32 } from './synthetic'

const RealDate = Date

/**
 * `run` with the clock stopped at `now`. buildBlankDocx and JSZip read the
 * clock (`new Date()`); the Rust side takes that instant as a parameter.
 */
async function atClock<T>(now: number, run: () => Promise<T>): Promise<T> {
  class StoppedDate extends RealDate {
    constructor(value?: number | string | Date) {
      super(value ?? now)
    }

    static override now(): number {
      return new RealDate(now).getTime()
    }
  }
  globalThis.Date = StoppedDate as DateConstructor
  try {
    return await run()
  } finally {
    globalThis.Date = RealDate
  }
}

/** A package as `[name, text]` pairs; a null text is `zip.folder(name)`. */
export type ZipParts = Array<[name: string, text: string | null]>

/** A package written by both writers at `now` (a time value). */
export interface ZipPackage {
  label: string
  parts: ZipParts
  now: number
}

/** The bytes JSZip writes for `parts` with the options blank.ts passes. */
export function typescriptZip({ parts, now }: ZipPackage): Promise<Uint8Array> {
  return atClock(now, () => {
    const zip = new JSZip()
    for (const [name, text] of parts) {
      if (text === null) zip.folder(name)
      else zip.file(name, text)
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  })
}

const ODD_SECOND = 1_700_000_001_999
const zipRandom = mulberry32(20261113)

/** Packages no blank document is: what the writer meets as a general component. */
export const ZIP_PACKAGES: ZipPackage[] = [
  { label: 'no entry', parts: [], now: ODD_SECOND },
  { label: 'an empty file', parts: [['empty.xml', '']], now: ODD_SECOND },
  {
    label: 'only empty files',
    parts: [
      ['a', ''],
      ['b/c', ''],
      ['d/e/f', ''],
    ],
    now: ODD_SECOND,
  },
  { label: 'one byte', parts: [['x', 'a']], now: ODD_SECOND },
  {
    label: 'array index names',
    parts: ['b', '10', '2', '0', 'a/1', '4294967294', '4294967295', '01', '2'].map((name, at) => [
      name,
      at % 3 === 0 ? '' : `${name}${at}`,
    ]),
    now: ODD_SECOND,
  },
  {
    label: 'nested folders',
    parts: [
      ['a/b/c/d.xml', '<d/>'],
      ['a/b/e.xml', '<e/>'],
      ['a/f.xml', 'f'],
      ['a/b/c/g.xml', ''],
    ],
    now: ODD_SECOND,
  },
  {
    label: 'explicit folders',
    parts: [
      ['media', null],
      ['word/media', null],
      ['word/media/image1.png', 'png'],
      ['x/y/z', null],
      ['x/', null],
      ['s/', 'a file named like a folder'],
      ['s/t', null],
    ],
    now: ODD_SECOND,
  },
  {
    label: 'a doubled slash',
    parts: [
      ['a//b/c.txt', 'x'],
      ['f//g', null],
    ],
    now: ODD_SECOND,
  },
  {
    label: 'non-ASCII and astral names',
    parts: [
      ['word/\u00E9t\u00E9.xml', 'x'],
      ['\u{1F600}/\u{10437}.xml', 'y'],
      ['\uD55C\uAE00', ''],
      ['\u00E9', null],
    ],
    now: ODD_SECOND,
  },
  {
    label: 'a backslash and a leading slash',
    parts: [
      ['a\\b.xml', 'x'],
      ['/root.xml', 'y'],
      ['/top/inner.xml', 'z'],
    ],
    now: ODD_SECOND,
  },
  {
    label: 'non-ASCII content',
    parts: [['t.xml', '<t>\uD55C\uAE00 \u00E9 \u{1F600} \u0000 \uFEFF \u5B57</t>']],
    now: ODD_SECOND,
  },
  {
    label: 'a 1 MB repetitive part',
    parts: [['word/document.xml', '<w:p><w:r><w:t>hello</w:t></w:r></w:p>'.repeat(26_000)]],
    now: ODD_SECOND,
  },
  {
    label: 'an incompressible-looking part',
    parts: [
      [
        'word/media/noise.bin',
        Array.from({ length: 200_000 }, () =>
          String.fromCharCode(0x21 + Math.floor(zipRandom() * 0x7d0)),
        ).join(''),
      ],
    ],
    now: ODD_SECOND,
  },
  {
    label: '300 entries',
    parts: Array.from({ length: 300 }, (_, at): [string, string] => [
      `p/${at % 7}/e${at}.xml`,
      `<e n="${at}"/>`.repeat(at % 13),
    ]),
    now: ODD_SECOND,
  },
  // DOS time: before 1980, its first second, 2107's last second and the year
  // after (it wraps), even seconds, the ends of the time range, and an
  // invalid date
  ...[
    315_532_799_000, 315_532_800_000, 4_354_819_199_000, 4_354_819_200_000, 1_700_000_000_500, -1,
    8.64e15, -8.64e15, 1e20,
  ].map((now): ZipPackage => ({
    label: `the date ${now}`,
    parts: [
      ['a.xml', 'x'],
      ['d/b.xml', ''],
    ],
    now,
  })),
]

/** The arguments of buildBlankDocx as they cross the wire: a date is its time value. */
interface WireBlankOptions {
  eastAsiaFont?: string
  /** Unchecked, as a caller outside the type system passes it. */
  paperSize?: unknown
  createdAt?: number
  application?: string
  appVersion?: string
  template?: string
  /** Unchecked, as a caller outside the type system passes it: only truthiness counts. */
  omitGeneratorFields?: unknown
}

type TextOption = 'eastAsiaFont' | 'application' | 'appVersion' | 'template'

/**
 * The bytes buildBlankDocx gives for `args`: `{ options?, now, textOption?,
 * locale? }`, where the option `textOption` names, if any, is `text`, and the
 * paper size is `paperSizeForLocale(locale)` where a locale is given.
 */
export async function typescriptBlankDocx(
  text: string,
  args: Record<string, unknown>,
): Promise<Uint8Array> {
  const wire = args.options as WireBlankOptions | undefined
  const textOption = args.textOption as TextOption | undefined
  const locale = args.locale as string | undefined
  let options: BlankDocxOptions | undefined
  if (wire !== undefined || textOption !== undefined || locale !== undefined) {
    const { createdAt, paperSize, omitGeneratorFields, ...rest } = wire ?? {}
    options = {
      ...rest,
      paperSize: paperSize as BlankPaperSize | undefined,
      omitGeneratorFields: omitGeneratorFields as boolean | undefined,
      createdAt: createdAt === undefined ? undefined : new Date(createdAt),
    }
    if (textOption !== undefined) options[textOption] = text
    if (locale !== undefined) options.paperSize = paperSizeForLocale(locale)
  }
  return atClock(args.now as number, () => buildBlankDocx(options))
}

/** Not own keys of PAPER_TWIPS: other names, names every object inherits, other types. */
const UNKNOWN_PAPER_SIZES = ['B5', 'letter', 'constructor', '__proto__', 'toString', '', 5, null]
const EAST_ASIA_FONTS = [undefined, '', 'Malgun Gothic', 'A"<&\u5B8B\u4F53']
const PAPER_SIZES = [undefined, 'A4', 'Letter']
/** Before 1970, a leap day, year 10000 (expanded ISO year), a year before 0. */
const CREATED_AT = [undefined, 0, 951_782_400_123, 253_402_300_800_000, -62_198_755_200_001]
const APPLICATIONS = [undefined, '', 'Word & <Co>\u0001']
const APP_VERSIONS = [undefined, '', '16.0000']
const TEMPLATES = [undefined, '', 'Normal\u0007.dotm']
const OMIT_GENERATOR_FIELDS = [true, false, 1, 0, '', 'x', null, {}, []]
/**
 * Clock instants: DOS time's first and last representable seconds, before
 * 1980 (a negative DOS year), an odd second with milliseconds, and later.
 */
const CLOCKS = [315_532_800_000, 4_354_819_199_000, 0, 1_700_000_001_999, 1_762_900_000_000, -1_000]

/** Every option crossed with every other, absent included. */
export const BLANK_DOCX_MATRIX: Input[] = []
for (const eastAsiaFont of EAST_ASIA_FONTS)
  for (const paperSize of PAPER_SIZES)
    for (const createdAt of CREATED_AT)
      for (const application of APPLICATIONS)
        for (const appVersion of APP_VERSIONS)
          for (const template of TEMPLATES) {
            const options: WireBlankOptions = {
              eastAsiaFont,
              paperSize,
              createdAt,
              application,
              appVersion,
              template,
            }
            for (const key of Object.keys(options) as Array<keyof WireBlankOptions>) {
              if (options[key] === undefined) delete options[key]
            }
            BLANK_DOCX_MATRIX.push({
              args: { options, now: CLOCKS[BLANK_DOCX_MATRIX.length % CLOCKS.length] },
            })
          }
BLANK_DOCX_MATRIX.push(
  { args: { now: 1_762_900_000_000 } },
  // no options at all, and the clock outside DOS time on both sides
  { args: { options: { createdAt: 0 }, now: 8.64e15 } },
  { args: { options: { createdAt: 0 }, now: -8.64e15 } },
  // an invalid clock: the zip date is 0, a default creation stamp throws
  { args: { options: { createdAt: 0 }, now: 1e20 } },
  { args: { options: {}, now: 1e20 } },
  // an invalid creation date throws RangeError; a paper size the table does not hold gives A4
  { args: { options: { createdAt: 1e20 }, now: 0 } },
  { args: { options: { createdAt: 8.64e15 + 1 }, now: 0 } },
  { args: { options: { createdAt: 8.64e15 }, now: 0 } },
  { args: { options: { createdAt: -8.64e15 }, now: 0 } },
  { args: { options: { createdAt: 1.9 }, now: 0 } },
  { args: { options: { createdAt: -0.5 }, now: 0.7 } },
  ...UNKNOWN_PAPER_SIZES.map((paperSize) => ({ args: { options: { paperSize }, now: 0 } })),
  // the generator fields dropped or kept: only truthiness counts, whatever the type
  ...OMIT_GENERATOR_FIELDS.flatMap((omitGeneratorFields) =>
    TEMPLATES.flatMap((template) =>
      [{}, { application: 'Word & <Co>\u0001', appVersion: '16.0000' }].map((generator) => {
        const options: WireBlankOptions = { omitGeneratorFields, ...generator }
        if (template !== undefined) options.template = template
        return { args: { options, now: 1_700_000_001_999 } }
      }),
    ),
  ),
)

/** Seeds of the mutations: the text is the option `textOption` names. */
const BLANK_DOCX_TEXTS: Input[] = [
  { text: 'Malgun Gothic', args: { textOption: 'eastAsiaFont', now: 1_762_900_000_000 } },
  { text: 'Word & <Co>', args: { textOption: 'application', now: 315_532_800_000 } },
  { text: '16.0000', args: { textOption: 'appVersion', now: 0 } },
  {
    text: 'Normal.dotm',
    args: { textOption: 'template', options: { paperSize: 'Letter' }, now: 1_700_000_001_999 },
  },
  { text: '', args: { textOption: 'template', now: 1_700_000_001_999 } },
]

const BASE_LEVEL: CustomNumberingLevel = { numFmt: 'decimal', lvlText: '%1.', indentLeft: 720 }

/** One change of BASE_LEVEL per value of every field. */
const LEVEL_CHANGES: Array<Partial<CustomNumberingLevel>> = [
  { numFmt: 'bullet', lvlText: '\uF0B7' },
  { numFmt: 'lowerLetter' },
  { numFmt: 'a"<&>' },
  { numFmt: 'custom' },
  { numFmt: 'custom', customFormat: '\u03B1, \u03B2, \u03B3, ...' },
  { numFmt: 'custom', customFormat: '' },
  { numFmt: 'custom', customFormat: '1"<&>' },
  { numFmt: 'decimal', customFormat: 'x' },
  { lvlText: '' },
  { lvlText: '%1.%2)' },
  { lvlText: '<&">' },
  { indentLeft: 0 },
  { indentLeft: 359.5 },
  { indentLeft: -2.5 },
  { indentLeft: 1e21 },
  { indentLeft: 0.1 + 0.2 },
  { hanging: 0 },
  { hanging: 2.5 },
  { hanging: -2.5 },
  { hanging: 425 },
  { start: 0 },
  { start: 5 },
  { start: 1.5 },
  { start: -3 },
  { suff: 'tab' },
  { suff: 'space' },
  { suff: 'nothing' },
  { lvlJc: 'left' },
  { lvlJc: 'center' },
  { lvlJc: 'right' },
  { tabStop: 0 },
  { tabStop: 1080.5 },
  { tabStop: -0.5 },
  { font: '' },
  { font: 'Symbol' },
  { font: 'A&B"<>' },
  { szHalfPoints: 0 },
  { szHalfPoints: 24 },
  { szHalfPoints: 21.5 },
  { color: '' },
  { color: 'FF0000' },
  { color: '"&<' },
  { bold: true },
  { bold: false },
  { italic: true },
  { italic: false },
  { pStyle: '' },
  { pStyle: 'ListParagraph' },
  { pStyle: '"<' },
  { isLgl: true },
  { isLgl: false },
  { lvlRestart: 0 },
  { lvlRestart: 2 },
  { picBulletId: 0 },
  { picBulletId: 3 },
  { picBulletId: 1.5 },
]

const random = mulberry32(20261112)

/** BASE_LEVEL, each change alone, and random combinations of them. */
const LEVELS: CustomNumberingLevel[] = [
  BASE_LEVEL,
  ...LEVEL_CHANGES.map((change) => ({ ...BASE_LEVEL, ...change })),
  ...Array.from({ length: 60 }, () =>
    Object.assign(
      { ...BASE_LEVEL },
      ...Array.from(
        { length: 2 + Math.floor(random() * 5) },
        () => LEVEL_CHANGES[Math.floor(random() * LEVEL_CHANGES.length)]!,
      ),
    ),
  ),
]
const ILVLS = [0, 1, 8, 2.5]
/** A level the type forbids: escAttr(undefined) throws. */
const NO_LVL_TEXT = { numFmt: 'decimal', indentLeft: 0 }
const NO_NUM_FMT = { lvlText: '%1.', indentLeft: 0 }

const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
/** Existing w:lvl elements: every kind of child, odd shapes, and none. */
const EXISTING_LEVELS = [
  '',
  'no element at all',
  '<w:lvl w:ilvl="0"/>',
  '<w:lvl w:ilvl="2" w15:tentative="1"><w:start w:val="3"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/><w:lvlJc w:val="right"/><w:pPr><w:ind w:left="2160" w:hanging="180"/></w:pPr></w:lvl>',
  `<w:lvl w:ilvl="0" w:tplc="04090001"><w:start w:val="1"/><mc:AlternateContent ${MC}><mc:Choice Requires="w14"><w:numFmt w:val="custom" w:format="001, 002, 003, ..."/></mc:Choice><mc:Fallback><w:numFmt w:val="decimal"/></mc:Fallback></mc:AlternateContent><w:lvlText w:val="%1"/><w:legacy w:legacy="1" w:legacySpace="0" w:legacyIndent="360"/><w:lvlJc w:val="left"/><w:pPr><w:spacing w:before="120"/><w:jc w:val="both"/><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/><w:keepNext/><w:x/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/><w:b/><w:color w:val="FF0000"/><w14:ligatures w14:val="standard"/><w:sz w:val="20"/></w:rPr></w:lvl>`,
  '<w:lvl w:ilvl="1"><w:pStyle w:val="Heading2"/><w:isLgl/><w:suff w:val="space"/><w:lvlRestart w:val="0"/><w:lvlPicBulletId w:val="2"/><w:rPr><w14:shadow/></w:rPr><w:start w:val="1"/><w:start w:val="9"/></w:lvl>',
  '<w:lvl\n w:ilvl="4">\r\n  <w:start w:val="1"/>  <w:pPr/></w:lvl>',
  '</w:lvl><w:lvl>',
  '<w:lvlText w:val="x"/>',
  '<w:lvl>>><w:numFmt w:val="a"></w:numFmt></w:lvl>',
  '<w:lvl w:ilvl="0"><w:rPr><w:i/><w:iCs/><w:bCs/><w:sz w:val="8"/><w:szCs w:val="8"/></w:rPr></w:lvl>',
  '<w:lvl w:ilvl="0"><w:pPr><w:ind w:left="1" w:hanging="2"/><w:ind w:left="3"/><w:numPr/><w:pStyle w:val="x"/></w:pPr></w:lvl>',
  '<w:lvl w:ilvl="0">text<!-- c --><w:numFmt w:val="x"/></w:lvl>',
  '<w:lvl w:ilvl="0"><x:AlternateContent><w:numFmtX/></x:AlternateContent><y:AlternateContent><w:numFmt/></y:AlternateContent><w:numFmt w:val="z"/></w:lvl>',
  '<w:lvl w:ilvl="0"><w:rPr/><w:pPr></w:pPr></w:lvl>',
  '<w:lvl w:ilvl="0"><w:rPr><w14:glow w14:rad="1"><w14:srgbClr w14:val="FF0000"/></w14:glow></w:rPr></w:lvl>',
]

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
function numberingOf(levels: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="0">${levels}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="7"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="2"><w:lvl w:ilvl="2"><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%3)"/><w:pPr><w:ind w:start="100"/></w:pPr></w:lvl></w:lvlOverride></w:num>' +
    '</w:numbering>'
  )
}

/** numbering.xml parts that give a NumberingLevel every field, and none. */
const NUMBERING_PARTS = [
  numberingOf('<w:lvl w:ilvl="0"/>'),
  numberingOf(
    '<w:lvl w:ilvl="0"><w:start w:val="3"/>' +
      `<mc:AlternateContent ${MC}><mc:Choice Requires="w14"><w:numFmt w:val="custom" w:format="01, 02, 03, ..."/></mc:Choice><mc:Fallback><w:numFmt w:val="decimal"/></mc:Fallback></mc:AlternateContent>` +
      '<w:lvlRestart w:val="0"/><w:pStyle w:val="Heading1"/><w:isLgl/><w:suff w:val="space"/><w:lvlText w:val="%1&#46;"/><w:lvlPicBulletId w:val="1"/><w:lvlJc w:val="end"/>' +
      '<w:pPr><w:bidi/><w:tabs><w:tab w:val="num" w:pos="1080"/></w:tabs><w:ind w:left="720" w:right="10" w:hanging="360"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings"/><w:b/><w:i/><w:color w:val="ff00aa"/><w:sz w:val="24"/></w:rPr></w:lvl>' +
      '<w:lvl w:ilvl="1"><w:start w:val="x"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:suff w:val="nothing"/><w:lvlJc w:val="center"/>' +
      '<w:pPr><w:ind w:left="360" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="Batang"/><w:b w:val="0"/><w:i w:val="off"/><w:color w:val="auto"/><w:sz w:val="0"/></w:rPr></w:lvl>' +
      '<w:lvl w:ilvl="10"><w:start w:val="2"/><w:numFmt w:val="lowerLetter"/><w:suff w:val="tab"/><w:isLgl w:val="false"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab/></w:tabs><w:ind w:hanging="-5"/></w:pPr></w:lvl>' +
      '<w:lvl w:ilvl="-1"><w:numFmt w:val="decimalZero"/><w:lvlText w:val="%1"/></w:lvl>' +
      '<w:lvl w:ilvl="x"/>',
  ),
  numberingOf(
    `<w:lvl w:ilvl="0"><mc:AlternateContent ${MC}><mc:Choice Requires="w14"><w:numFmt w:val="ordinal"/></mc:Choice></mc:AlternateContent></w:lvl>` +
      `<w:lvl w:ilvl="1"><mc:AlternateContent ${MC}><mc:Choice Requires="w14"><w:numFmt w:val="custom"/></mc:Choice><mc:Fallback><w:numFmt w:val="decimal"/></mc:Fallback></mc:AlternateContent></w:lvl>`,
  ),
  '',
  '<w:numbering/>',
  '<w:numbering><w:lvl',
]

const PIC_BULLET_SRCS = [undefined, '', 'data:image/png;base64,AAAA']

const REGIONS = [
  'US',
  'us',
  'Us',
  'CA',
  'MX',
  'PH',
  'LR',
  'MM',
  'PR',
  'CL',
  'CO',
  'VE',
  'GT',
  'CR',
  'PA',
  'DO',
  'GB',
  'KR',
  'JP',
  '',
  ' US',
  'US ',
  'u\u017F',
  '\u0131T',
  'usa',
  'u',
  'ZZ',
  '419',
]

const LOCALES = [
  'en-US',
  'en',
  'en_CA',
  'EN-us',
  'es-MX',
  'es',
  'es-419',
  'zh-Hans-CN',
  'zh-Hant-TW',
  'ko-KR',
  'ja',
  'fil',
  'tl',
  'my',
  'chr',
  'haw',
  'ceb',
  'vai',
  'und',
  'und-Cher',
  'und-Bass',
  'und-Latn',
  'sh',
  'sr-Latn',
  'pt-BR',
  'fr-CA',
  'ar-SA',
  'de-DE-u-co-phonebk',
  'en-US-x-private',
  'ja-JP-u-ca-japanese',
  'hy-arevmda',
  'art-lojban',
  'art-lojban-lojban',
  'zh-guoyu-guoyu',
  'zh-hakka-hakka-hakka',
  'my-BU',
  'en-PZ',
  'en-840',
  'en-999',
  'en-ZZ',
  'en-Latn-ZZ',
  'und-Latn-ZZ',
  'zzz-ZZ',
  'zzz',
  'abcde-US',
  'abcd',
  'root',
  'en-root',
  'pi-Mymr',
  'en-Shaw',
  'sgn-US',
  'sgn-CO',
  'sgn-170',
  'sgn-MX-fonipa',
  'sgn-US-aaland',
  'sgn-840-aaland',
  'en-aaland',
  'en-US-aaland',
  'en-aaland-US',
  'x-private',
  'en-x',
  'en-u-ca-a1',
  'en-u-ca-ca-a1',
  'en-u-ca-ca-a1-0a',
  'en-t-en-posix',
  'en-t-en-arevela-posix',
  'en-t-en-fonipa-posix',
  'en-t-h0',
  'en-t-h0-hybrid',
  'en-t-0a-abc',
  'en-fonipa-fonipa',
  'en-US-US',
  'en-a-bc-a-bc',
  'en-a-bc-b-de',
  'en-u-ca-gregory-u-nu-latn',
  'en-US-0abc',
  'en-US-0ab',
  'en-12',
  'en-1234567',
  'en--US',
  'en-US-',
  '-en',
  'en US',
  'en-\u00E9',
  'en-Latn-US-fonipa-u-ca-x-y',
  // every Letter region, and its numeric code
  ...['US', 'CA', 'MX', 'PH', 'LR', 'MM', 'PR', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO'].map(
    (region) => `es-${region}`,
  ),
  ...['840', '124', '484', '608', '430', '104', '630', '152', '170', '862', '320', '188'].map(
    (code) => `en-${code}`,
  ),
  'en-591',
  'en-214',
]

/** The text, or null or undefined where `args.missing` says so. */
function given(text: string, args: Record<string, unknown>): string | null | undefined {
  if (args.missing === 'null') return null
  return args.missing === 'undefined' ? undefined : text
}

const missingInputs: Input[] = [{ args: { missing: 'null' } }, { args: { missing: 'undefined' } }]

export const BLANK: CallSpec[] = [
  {
    fn: 'blank.customLevelXml',
    call: (_text, args) => customLevelXml(args.level as CustomNumberingLevel, args.ilvl as number),
    built: [
      ...LEVELS.map((level, at) => ({ args: { level, ilvl: ILVLS[at % ILVLS.length] } })),
      { args: { level: NO_LVL_TEXT, ilvl: 0 } },
      { args: { level: NO_NUM_FMT, ilvl: 0 } },
    ],
    mutation: 'none',
  },
  {
    fn: 'blank.mergeLevelXml',
    call: (text, args) =>
      mergeLevelXml(text, args.level as CustomNumberingLevel, args.ilvl as number),
    fromDocument: (parts) =>
      [...(parts.get('word/numbering.xml') ?? '').matchAll(/<w:lvl\b[\s\S]*?<\/w:lvl>/g)]
        .slice(0, 4)
        .flatMap((match, at) =>
          [LEVELS[at % LEVELS.length]!, LEVELS[(at * 7 + 3) % LEVELS.length]!].map((level) => ({
            text: match[0],
            args: { level, ilvl: at },
          })),
        ),
    built: [
      ...EXISTING_LEVELS.flatMap((text, at) =>
        LEVELS.filter((_, index) => index % EXISTING_LEVELS.length === at).map((level) => ({
          text,
          args: { level, ilvl: ILVLS[at % ILVLS.length] },
        })),
      ),
      ...EXISTING_LEVELS.map((text) => ({ text, args: { level: BASE_LEVEL, ilvl: 3 } })),
      { text: EXISTING_LEVELS[4], args: { level: NO_LVL_TEXT, ilvl: 0 } },
    ],
  },
  {
    fn: 'blank.abstractNumXml',
    call: (_text, args) =>
      abstractNumXml(
        args.abstractNumId as string,
        args.kind as 'bullet' | 'ordered',
        args.levels as CustomNumberingLevel[] | undefined,
      ),
    built: [
      ...['0', '7', 'a"b'].flatMap((abstractNumId) =>
        ['bullet', 'ordered'].flatMap((kind) =>
          [undefined, [], LEVELS.slice(0, 1), LEVELS.slice(5, 8), LEVELS.slice(20, 29)].map(
            (levels) => ({ args: { abstractNumId, kind, levels } }),
          ),
        ),
      ),
      { args: { abstractNumId: '1', kind: 'bullet', levels: [BASE_LEVEL, NO_LVL_TEXT] } },
    ],
    mutation: 'none',
  },
  {
    fn: 'blank.numPicBulletXml',
    call: (_text, args) => numPicBulletXml(args.id as number, args.rId as string),
    built: [0, 1, 12, 1.5, -3, 1e21, 123_456_789_012].flatMap((id) =>
      ['rId1', '', 'a"<&'].map((rId) => ({ args: { id, rId } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'blank.customLevelFromNumberingLevel',
    call: async (text) => {
      const { defs } = await parseNumbering(zipOf([['word/numbering.xml', text]]))
      const levels: Record<string, CustomNumberingLevel> = {}
      for (const [numId, def] of defs) {
        for (const [ilvl, level] of Object.entries(def.levels)) {
          levels[`${numId} ${ilvl}`] = customLevelFromNumberingLevel(level)
        }
      }
      return levels
    },
    fromDocument: (parts) => {
      const text = parts.get('word/numbering.xml')
      return text === undefined ? [] : [{ text }]
    },
    built: NUMBERING_PARTS.map((text) => ({ text })),
  },
  {
    fn: 'blank.numberingLevelFromCustom',
    call: (_text, args) =>
      numberingLevelFromCustom(
        args.level as CustomNumberingLevel,
        args.picBulletSrc as string | undefined,
      ),
    built: [
      ...LEVELS.map((level, at) => ({
        args: { level, picBulletSrc: PIC_BULLET_SRCS[at % PIC_BULLET_SRCS.length] },
      })),
      // no level: reading its numFmt throws
      { args: { picBulletSrc: '' } },
    ],
    mutation: 'none',
  },
  {
    fn: 'blank.paperSizeForRegion',
    call: (text, args) => paperSizeForRegion(given(text, args)),
    built: [...REGIONS.map((text) => ({ text })), ...missingInputs],
  },
  {
    fn: 'blank.paperSizeForLocale',
    call: (text, args) => paperSizeForLocale(given(text, args)),
    built: [...LOCALES.map((text) => ({ text })), ...missingInputs],
  },
  {
    fn: 'blank.buildBlankDocx',
    // the package read back: [name, isDirectory, text] in central directory order
    call: async (text, args) => {
      const zip = await JSZip.loadAsync(await typescriptBlankDocx(text, args))
      const entries: Array<[string, boolean, string]> = []
      for (const [name, file] of Object.entries(zip.files)) {
        entries.push([name, file.dir, await file.async('string')])
      }
      return { entries }
    },
    built: [...BLANK_DOCX_MATRIX, ...BLANK_DOCX_TEXTS],
  },
  {
    fn: 'blank.pageSizeTag',
    // the w:pgSz of word/document.xml in the package buildBlankDocx builds
    call: async (text, args) => {
      const zip = await JSZip.loadAsync(await typescriptBlankDocx(text, args))
      const document = await zip.file('word/document.xml')?.async('string')
      return document?.match(/<w:pgSz[^>]*\/>/)?.[0]
    },
    built: [
      ...[undefined, 'A4', 'Letter', ...UNKNOWN_PAPER_SIZES].map((paperSize) => ({
        args: { options: { paperSize }, now: 0 },
      })),
      { args: { now: 1_762_900_000_000 } },
      ...LOCALES.map((locale) => ({ args: { locale, now: 0 } })),
    ],
    mutation: 'none',
  },
]
