// Group `odtText` of comparison (f): text/*.ts of packages/odt-engine (the pure
// functions: units, lists, align, markers, props, style-xml, the OOXML readers
// of styles.ts, paragraph-model's helpers). The Rust side answers in
// crates/office-wasm/src/calls/odt_text.rs to `odtText.<TypeScript name>`;
// the convention is at the top of calls-support.ts. Shapes particular to this
// group:
//
//   alignTexts         text the original; args `edited`, and the queries `maps` `[[offset, 'start'|'end']]`,
//                      `originalOf` `[index]`, `intact` `[[start, length]]` (the harness chooses them: the
//                      TextAlignment is a closure object). Result `{ maps: [...], originalOf: [...], intact: [...] }`,
//                      each list the answers in the order of its queries.
//   keptCharacters     args `originals` (BridgeParagraphs), `edited`.
//   placeMarkers       text the part string both parts of the fake context answer to; args `originals`
//                      (BridgeParagraphs, their offsets index `text`), `edited`; result `{ placements, warnings }`.
//   textStyleAttrs, readParagraph   text the content.xml (the source's part: `content.xml`, scope `content`,
//                      its root's prefixes, no font faces); args `stylesXml` (absent for none), `name`
//                      (textStyleAttrs; absent for null), `range` `{ start, openEnd, closeStart, end,
//                      selfClosing }` and `record` (readParagraph).
//   editedParagraphFromBlock (`b`), editedParagraphFromTableParagraph (`p`)   a Block / a TableParagraph.
//   pairMarkers        args `markers`: the list as it is after the call (it pairs in place).
//   textFormatFromOdf  args `tp`, `fontFaces` as entries `[[name, family]]`.
//   textOverrides      args `keys`, `edited`; `face(family)` answers `<family>|face`. Result
//                      `{ overrides, faces }`, `faces` the families `face` was called with, in order.
//   patchStartTag, editStyleXml  args `prefixes`: the root attributes `[{ name, raw }]` of a PrefixMap.
//   styleEntryForOdf, styleEntryById  args `map`: `{ styles: { paragraph } }` of a BridgeMap.
//   docxStylesById     the Map as its entries.
//   numFmtFromOdf, lengthToTwips, twips, percent: `args.missing` for `undefined`/`null`.
//   twipsToCm, twipsToPt, halfPointsToPt: args `value`.//
//   odtText.constant   args `name`: the value of the exported constant of that name of the group (or the
//        answer of a function that takes nothing); the names are the keys of the spec at the end of this file.

import type { ParaFormat } from '@seuoffice/docx-engine'
import { elementFragments } from '../docx-diff/fragments'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { type Args, distinct, rootPrefixes, constantSpec } from './calls-support'
import { REAL_TABLES, firstOf, withFields } from './real-model'
import * as ts from './ts'

const props = ts.textProps
const part = (parts: ReadonlyMap<string, string>, name: string): string | undefined =>
  parts.get(name)

const prefixMapOf = (list: unknown): ts.coreXml.PrefixMap =>
  new ts.coreXml.PrefixMap(
    ((list ?? []) as Array<{ name: string; raw: string }>).map((a) => ({
      name: a.name,
      raw: a.raw,
      nameStart: 0,
      valueStart: 0,
      valueEnd: 0,
    })),
  )

// ---------------------------------------------------------------------------
// Vocabularies

const PP_BAGS: Array<Record<string, string>> = [
  {},
  { 'fo:text-align': 'center' },
  { 'fo:text-align': 'justify', 'fo:text-align-last': 'justify' },
  {
    'fo:text-align': 'start',
    'fo:margin-left': '0.529cm',
    'fo:margin-right': '1mm',
    'fo:text-indent': '-0.5cm',
  },
  {
    'fo:text-align': 'end',
    'fo:margin-top': '-1cm',
    'fo:margin-bottom': '12pt',
    'fo:line-height': '160%',
  },
  {
    'fo:line-height': '14pt',
    'fo:keep-with-next': 'always',
    'fo:keep-together': 'always',
    'fo:break-before': 'page',
  },
  { 'style:line-height-at-least': '0.5cm', 'fo:background-color': '#aabbcc' },
  {
    'fo:line-height': '0%',
    'style:line-height-at-least': '0pt',
    'fo:background-color': 'transparent',
  },
  {
    'fo:line-height': 'normal',
    'fo:margin-left': '1in',
    'fo:margin-right': '2pc',
    'fo:text-indent': '10px',
  },
  {
    'fo:text-align': 'bogus',
    'fo:margin-left': 'abc',
    'fo:keep-with-next': 'auto',
    'fo:break-before': 'auto',
  },
  {
    'fo:margin-left': '1e1cm',
    'fo:margin-top': '.5cm',
    'fo:margin-bottom': '+1cm',
    'fo:background-color': 'AABBCC',
  },
]

const TAB_STOP_LISTS: Array<Array<Record<string, string>> | null> = [
  null,
  [],
  [{ 'style:position': '3cm' }],
  [
    { 'style:position': '14.993cm', 'style:type': 'right', 'style:leader-style': 'dotted' },
    { 'style:position': '15.5cm', 'style:type': 'center', 'style:leader-style': 'none' },
  ],
  [
    { 'style:position': '2cm', 'style:type': 'char', 'style:leader-text': '.' },
    { 'style:position': '4cm', 'style:leader-text': '-' },
    { 'style:position': '5cm', 'style:leader-text': '_' },
    { 'style:position': '6cm', 'style:leader-text': '*' },
  ],
  [
    { 'style:position': 'x' },
    { 'style:type': 'right' },
    { 'style:position': '1cm', 'style:leader-style': 'wave' },
  ],
  [
    { 'style:position': '1cm', 'style:leader-style': 'long-dash' },
    { 'style:position': '2cm', 'style:leader-style': 'dot-dash' },
    { 'style:position': '3cm', 'style:leader-style': 'solid' },
    { 'style:position': '4cm', 'style:leader-style': 'unknown' },
  ],
]

const TP_BAGS: Array<Record<string, string>> = [
  {},
  { 'fo:font-weight': 'bold', 'fo:font-style': 'italic', 'fo:color': '#ff0000' },
  { 'fo:font-weight': '700', 'fo:font-style': 'oblique', 'fo:color': 'ff00ff' },
  { 'fo:font-weight': '500', 'fo:font-style': 'normal', 'fo:color': 'red' },
  {
    'style:font-name': 'Malgun',
    'style:font-name-asian': 'HCR Batang',
    'style:font-name-complex': 'Arial',
    'fo:font-size': '10.5pt',
  },
  {
    'fo:font-family': "'Malgun Gothic', serif",
    'style:font-family-asian': 'Batang',
    'style:font-family-complex': '"Tahoma"',
    'fo:font-size': '120%',
  },
  {
    'style:font-size-asian': '9pt',
    'style:font-weight-asian': 'bold',
    'style:font-style-asian': 'italic',
  },
  {
    'style:text-underline-style': 'solid',
    'style:text-underline-type': 'double',
    'style:text-line-through-style': 'solid',
  },
  {
    'style:text-underline-style': 'none',
    'style:text-line-through-style': 'none',
    'style:text-line-through-type': 'single',
  },
  { 'style:text-underline-type': 'none', 'style:text-line-through-type': 'none' },
  {
    'fo:letter-spacing': 'normal',
    'style:text-scale': '150%',
    'fo:background-color': '#00ff00',
    'style:text-position': 'super 58%',
  },
  {
    'fo:letter-spacing': '1pt',
    'style:text-scale': '100%',
    'style:text-position': 'sub',
    'fo:text-transform': 'uppercase',
  },
  { 'style:text-position': '33% 100%', 'fo:font-variant': 'small-caps', 'style:text-scale': '0%' },
  { 'style:text-position': '-33%', 'fo:font-size': '0pt', 'fo:letter-spacing': 'zz' },
  { 'style:text-position': '0% 100%', 'fo:font-size': '-5pt' },
]

const FONT_FACES: Array<Array<[string, string]>> = [
  [],
  [
    ['Malgun', 'Malgun Gothic'],
    ['HCR Batang', '\ud568\ucd08\ub871\ubc14\ud0d5'],
  ],
  [['Arial', 'Arial']],
]

const PARA_FORMATS: ParaFormat[] = [
  {},
  { align: 'center' },
  { align: 'distribute', indentLeft: 720, indentRight: 0, indentFirstLine: -360 },
  { align: 'justify', spaceBefore: 0, spaceAfter: 200, lineSpacing: 1.5, lineRule: 'auto' },
  { lineRule: 'exact', lineRawTwips: 300, keepNext: true, keepLines: true, pageBreakBefore: true },
  { lineRule: 'atLeast', lineRawTwips: 280, shadingFill: 'aabbcc' },
  { lineSpacing: 0, spaceBefore: 120, indentFirstLine: 0 },
  {
    tabStops: [
      { pos: 1701, val: 'left', leader: 'none' },
      { pos: 8500, val: 'right', leader: 'dot' },
      { pos: 9000, val: 'decimal', leader: 'underscore' },
      { pos: 100, val: 'center', leader: 'hyphen' },
      { pos: 5, val: 'clear' },
      { pos: 7, val: 'bar', rel: 'margin' },
      { pos: 9, val: 'left', inherited: true },
    ],
  },
  { align: 'right', indentLeft: 1.4, lineSpacing: 1.0049, shadingFill: 'ffffff' },
  { align: 'left', lineRule: 'exact' },
]

const TEXT_FORMATS: Array<Record<string, unknown>> = [
  {},
  { bold: true, italic: true, underline: true, strike: true },
  { bold: false, color: 'ff0000', sizeHalfPoints: 28 },
  { color: 'auto', vertAlign: 'superscript', caps: 'all' },
  {
    vertAlign: 'subscript',
    caps: 'small',
    font: '\ub9d1\uc740 \uace0\ub515',
    fontAscii: 'Arial',
    fontCs: 'Tahoma',
  },
  { eastAsiaFont: 'Batang', font: 'Other', charSpacingTwips: 20, charScalePct: 150 },
  { charSpacingTwips: 0, charScalePct: 100, caps: 'none' },
  { highlight: 'yellow', shading: 'aabbcc' },
  { highlight: 'darkMagenta' },
  { highlight: 'nonsense', shading: 'ff00ff' },
  { shading: 'abc123', sizeHalfPoints: 0 },
]

const PARA_KEY_NAMES = [
  'align',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'line',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'shading',
  'tabs',
]
const TEXT_KEY_NAMES = [
  'bold',
  'italic',
  'underline',
  'strike',
  'vertAlign',
  'caps',
  'color',
  'size',
  'font',
  'fontAscii',
  'fontCs',
  'spacing',
  'scale',
  'background',
]

const pick = <T>(list: readonly T[], at: number): T =>
  list[((at % list.length) + list.length) % list.length]!

// ---------------------------------------------------------------------------
// Inputs from documents

/** Property bags of every style of an ODT (the TypeScript's own reading of the part). */
function styleBags(parts: ReadonlyMap<string, string>): {
  para: Array<{ pp: Record<string, string>; tabs: Array<Record<string, string>> | null }>
  text: Array<Record<string, string>>
  faces: Array<[string, string]>
} {
  const content = part(parts, 'content.xml')
  if (content === undefined) return { para: [], text: [], faces: [] }
  const table = ts.coreStyles.readOdtStyles(part(parts, 'styles.xml') ?? null, content)
  const para: Array<{ pp: Record<string, string>; tabs: Array<Record<string, string>> | null }> = []
  const text: Array<Record<string, string>> = []
  for (const style of table.all.slice(0, 80)) {
    const pp = style.properties['style:paragraph-properties']
    const tp = style.properties['style:text-properties']
    if (pp) para.push({ pp, tabs: style.tabStops })
    if (tp) text.push(tp)
  }
  const faces = [
    ...content.matchAll(
      /<style:font-face [^>]*style:name="([^"]*)"[^>]*svg:font-family="([^"]*)"/g,
    ),
  ].map((m): [string, string] => [m[1]!, m[2]!])
  return { para: distinct(para, 30), text: distinct(text, 30), faces: distinct(faces, 10) }
}

const wordFragments = (parts: ReadonlyMap<string, string>, name: string): string[] =>
  distinct(
    [...parts]
      .filter(([path]) => /^word\/(document|styles|header\d*|footer\d*)\.xml$/.test(path))
      .flatMap(([, text]) => elementFragments(text, name)),
    40,
  )

const paragraphTexts = (parts: ReadonlyMap<string, string>): string[] => {
  const content = part(parts, 'content.xml')
  if (content === undefined) return []
  return distinct(
    [...content.matchAll(/<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)]
      .map((m) => ts.coreXml.decodeXmlEntities(m[1]!.replace(/<[^>]*>/g, '')))
      .filter((t) => t.length > 0 && t.length < 200),
    12,
  )
}

function editedOf(original: string, step: number): string {
  const chars = Array.from(original)
  const at = Math.floor(chars.length / 2)
  switch (step % 5) {
    case 0:
      return '>> ' + original
    case 1:
      return chars.slice(0, at).join('') + '\ud83d\ude00' + chars.slice(at + 1).join('')
    case 2:
      return chars.slice(0, Math.max(0, at - 1)).join('') + chars.slice(at + 2).join('')
    case 3:
      return original + ' \ud55c\uae00'
    default:
      return chars.reverse().join('')
  }
}

function alignInput(original: string, edited: string): Input {
  const o = original.length
  const e = edited.length
  const step = (n: number, k: number): number[] =>
    Array.from({ length: Math.min(n + 1, k) }, (_, i) =>
      Math.floor((i * n) / Math.max(1, Math.min(n, k - 1))),
    )
  const offsets = distinct([...step(o, 24), o + 3, -1], 40)
  const maps = offsets.flatMap((offset) => [
    [offset, 'start'],
    [offset, 'end'],
  ])
  const originalOf = distinct([...step(Math.max(0, e - 1), 24), e + 2, -1], 40)
  const intact = distinct(
    offsets.flatMap(
      (s) =>
        [
          [s, 1],
          [s, 3],
          [s, 8],
        ] as Array<[number, number]>,
    ),
    40,
  )
  return { text: original, args: { edited, maps, originalOf, intact } }
}

function alignRecord(original: string, edited: string, args: Args): unknown {
  const align = ts.textAlign.alignTexts(original, edited)
  return {
    maps: (args.maps as Array<[number, 'start' | 'end']>).map(([offset, bias]) =>
      align.map(offset, bias),
    ),
    originalOf: (args.originalOf as number[]).map((index) => align.originalOf(index)),
    intact: (args.intact as Array<[number, number]>).map(([start, length]) =>
      align.intact(start, length),
    ),
  }
}

/** A BridgeMarker as the bridge records it. */
const marker = (
  kind: string,
  name: string,
  offset: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  kind,
  name,
  offset,
  length: 0,
  start: 0,
  end: 0,
  pair: null,
  field: false,
  owner: null,
  ooxmlName: null,
  ...extra,
})

/** A BridgeParagraph as the bridge records it. */
const bridgeParagraph = (
  id: number,
  text: string,
  markers: Array<Record<string, unknown>> = [],
): Record<string, unknown> => ({
  id,
  part: 'content.xml',
  start: 0,
  end: text.length,
  element: 'text:p',
  styleName: null,
  text,
  markers,
  pPr: '',
  list: null,
  owner: 'text',
  block: null,
})

/** A part string and the paragraphs of its `text:p` elements, markers placed where the bookmark elements are. */
function markedPart(pieces: string[][]): {
  xml: string
  originals: Array<Record<string, unknown>>
} {
  let xml = ''
  const originals: Array<Record<string, unknown>> = []
  pieces.forEach((paragraph, id) => {
    const start = xml.length
    xml += '<text:p>'
    let text = ''
    const markers: Array<Record<string, unknown>> = []
    for (const piece of paragraph) {
      if (piece.startsWith('<')) {
        const name = /text:name="([^"]*)"/.exec(piece)?.[1] ?? 'x'
        const kind = piece.startsWith('<text:bookmark-start')
          ? 'bookmark-start'
          : piece.startsWith('<text:bookmark-end')
            ? 'bookmark-end'
            : piece.startsWith('<text:bookmark')
              ? 'bookmark'
              : piece.startsWith('<text:note')
                ? 'text'
                : 'keep'
        markers.push(
          marker(kind, name, text.length, {
            start: xml.length,
            end: xml.length + piece.length,
            length: kind === 'text' ? 3 : 0,
          }),
        )
        xml += piece
        if (kind === 'text') text += '[n]'
      } else {
        xml += piece
        text += piece
      }
    }
    xml += '</text:p>'
    // `pair` of starts and ends: the nearest open start of the same name
    markers.forEach((m, i) => {
      if (m.kind === 'bookmark-end') {
        const open = markers
          .slice(0, i)
          .reverse()
          .findIndex((x) => x.kind === 'bookmark-start' && x.name === m.name && x.pair === null)
        if (open >= 0) {
          const at = i - 1 - open
          m.pair = at
          markers[at]!.pair = i
        }
      }
    })
    originals.push(
      bridgeParagraph(
        id,
        text,
        markers.map((m) => ({ ...m, start: m.start, end: m.end })),
      ),
    )
    originals[id]!.start = start
    originals[id]!.end = xml.length
  })
  return { xml, originals }
}

const MARKED: string[][][] = [
  [
    [
      'ab',
      '<text:bookmark-start text:name="f"/>',
      'cd',
      '<text:bookmark-end text:name="f"/>',
      'ef',
    ],
  ],
  [
    ['ab', '<text:bookmark text:name="p"/>', 'cd'],
    ['gh', '<text:bookmark-start text:name="g"/>', 'ij'],
    ['kl', '<text:bookmark-end text:name="g"/>', 'mn'],
  ],
  [['one', '<text:note text:note-class="footnote"/>', 'two', '<text:soft-page-break/>', 'three']],
  [
    [
      '\ud55c\uae00 ',
      '<text:bookmark-start text:name="\ud55c"/>',
      '\ub0b4\uc6a9',
      '<text:bookmark-end text:name="\ud55c"/>',
      ' \ud83d\ude00',
    ],
  ],
  [
    [
      'x',
      '<text:bookmark-end text:name="orphan"/>',
      'y',
      '<text:bookmark-start text:name="open"/>',
      'z',
    ],
  ],
  [[]],
]

const MARKED_EDITS: string[][] = [
  ['abcdef'],
  ['abXcdYef'],
  ['ab', 'cdef'],
  ['', 'abcdef'],
  ['abc', 'def', 'ghijkl'],
  ['ab', 'ghijklmn', 'cdef', ''],
  ['ef'],
  [''],
  ['one two three'],
  ['onethree'],
  ['\ud55c\uae00 \ub0b4 \ud83d\ude00'],
  ['\ud55c', '\uae00 \ub0b4\uc6a9 \ud83d\ude00'],
  ['xyz'],
  ['x', 'z'],
]

const MARKERS = (kinds: Array<[string, string]>): unknown[] =>
  kinds.map(([kind, name], i) =>
    marker(kind, name, i, { start: i * 10, end: i * 10 + 5, owner: 'text', pair: 99 }),
  )

const NAME_CASES = [
  'text:p',
  'text:note',
  'text:soft-page-break',
  'text:change-start',
  'draw:frame',
  'table:table',
  'office:annotation',
  'text:span',
  'text:s',
  'text:list',
  'text:a',
  'text:number',
  'form:button',
  'dr3d:scene',
  'chart:chart',
  'presentation:x',
  'text:user-index-mark-end',
  'text:alphabetical-index-mark',
  'NormalField1',
  'NormalField',
  'normalfield',
  ' NormalField',
  'xNormalField',
  '',
  '\ud55c\uae00',
]

const STYLED_STYLES =
  '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"><office:styles><style:style style:name="T2" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style><style:style style:name="Base" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style></office:styles></office:document-styles>'
const STYLED_BODY =
  '<text:p text:style-name="Base">plain \ud55c\uae00</text:p>' +
  '<text:p text:style-name="P1"><text:span text:style-name="T1">span</text:span> <text:span text:style-name="T2">two</text:span><text:s text:c="2"/><text:tab/>x<text:line-break/>y</text:p>' +
  '<text:h text:outline-level="2" text:style-name="Base"><text:a xlink:href="http://x/?a=1&amp;b=2" text:style-name="T1">link</text:a><text:bookmark-start text:name="b"/>m<text:bookmark-end text:name="b"/></text:h>' +
  '<text:p/>' +
  '<text:p text:style-name="Base">a<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation></text:note>b</text:p>'
const STYLED_CONTENT =
  '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:color="#ff0000"/></style:style><style:style style:name="P1" style:family="paragraph" style:parent-style-name="Base"/></office:automatic-styles><office:body><office:text>' +
  STYLED_BODY +
  '</office:text></office:body></office:document-content>'

/** The element ranges of the paragraphs of STYLED_CONTENT. */
const PARAGRAPHS: Array<{
  start: number
  openEnd: number
  closeStart: number
  end: number
  selfClosing: boolean
}> = (() => {
  const body = ts.coreBody.scanOdtBody(STYLED_CONTENT)
  return body.blocks
    .filter((n) => n.kind === 'paragraph' || n.kind === 'heading')
    .map((n) => ({
      start: n.start,
      openEnd: n.openEnd,
      closeStart: n.closeStart,
      end: n.end,
      selfClosing: n.selfClosing,
    }))
})()

/** The ReadParagraphSource of a content.xml: its part, its root's prefixes, no font faces. */
function sourceOf(text: string, args: Args): ts.textParagraphModel.ReadParagraphSource {
  const info = {
    part: 'content.xml',
    xml: text,
    prefixes: ts.coreXml.readRoot(text)?.prefixes ?? new ts.coreXml.PrefixMap(),
    fontFaces: new Map<string, string>(),
    scope: 'content',
  } as ts.coreConvert.OdtPartInfo
  return {
    info,
    styles: ts.coreStyles.readOdtStyles((args.stylesXml as string | undefined) ?? null, text),
  }
}

export const TEXT: CallSpec[] = [
  {
    fn: 'odtText.alignTexts',
    call: (text, args) => alignRecord(text, args.edited as string, args),
    fromDocument: (parts) =>
      paragraphTexts(parts).flatMap((t, i) => [
        alignInput(t, editedOf(t, i)),
        alignInput(t, editedOf(t, i + 2)),
      ]),
    built: [
      ['', ''],
      ['abc', ''],
      ['', 'abc'],
      ['abc', 'abc'],
      ['abcdef', 'abXdef'],
      ['abcdef', 'aXbXcXdXeXfX'],
      ['abcabc', 'abc'],
      ['aaaa', 'aa'],
      ['aa', 'aaaa'],
      ['\ud55c\uae00 \ub0b4\uc6a9', '\ud55c \ub0b4\uc6a9\uc774'],
      ['a\ud83d\ude00b', 'ab'],
      ['\u0131\u017f\u212a', '\u0131x\u212a'],
      ['one two three', 'three two one'],
      ['abcdefghij', 'jihgfedcba'],
      ['\ud83d\ude00\ud83d\ude00', '\ud83d\ude00'],
      ['x'.repeat(70) + 'y', 'x'.repeat(30) + 'z' + 'x'.repeat(40) + 'y'],
    ].map(([o, e]) => alignInput(o!, e!)),
  },
  {
    fn: 'odtText.numFmtFromOdf',
    call: (text, args) => ts.textLists.numFmtFromOdf(args.missing ? undefined : text),
    built: [
      { text: '1' },
      { text: 'a' },
      { text: 'A' },
      { text: 'i' },
      { text: 'I' },
      { text: '\uac00, \ub098, \ub2e4, ...' },
      { text: '\u3131, \u3134, \u3137, ...' },
      { text: '\u2460, \u2461, \u2462, ...' },
      { text: '' },
      { text: 'zz' },
      { text: '1 ' },
      { text: '', args: { missing: true } },
    ],
  },
  {
    fn: 'odtText.numFmtToOdf',
    call: (text) => ts.textLists.numFmtToOdf(text),
    built: [
      'decimal',
      'lowerLetter',
      'upperLetter',
      'lowerRoman',
      'upperRoman',
      'ganada',
      'chosung',
      'decimalEnclosedCircle',
      'koreanDigital',
      'ideographTraditional',
      'none',
      'bullet',
      'nonsense',
      '',
      'DECIMAL',
    ].map((text) => ({ text })),
  },
  {
    fn: 'odtText.keptCharacters',
    call: (_t, args) =>
      ts.textMarkers.keptCharacters(args.originals as never, args.edited as string[]),
    fromDocument: (parts) => {
      const texts = paragraphTexts(parts)
      if (texts.length < 2) return []
      return [
        {
          args: {
            originals: texts.slice(0, 4).map((text, id) => bridgeParagraph(id, text)),
            edited: texts.slice(0, 4).map((t, i) => editedOf(t, i)),
          },
        },
      ]
    },
    built: [
      [
        ['abc', 'def'],
        ['abc', 'def'],
      ],
      [
        ['abc', 'def'],
        ['abXc', 'de'],
      ],
      [['abc', 'def'], ['abcdef']],
      [['abcdef'], ['abc', 'def']],
      [
        ['', 'x', ''],
        ['x', ''],
      ],
      [
        ['\ud55c\uae00', '\ud83d\ude00'],
        ['\uae00\ud83d\ude00', '\ud55c'],
      ],
      [[], []],
      [['abc'], []],
    ].map(([originals, edited]) => ({
      args: {
        originals: (originals as string[]).map((text, id) => bridgeParagraph(id, text)),
        edited,
      },
    })),
  },
  {
    fn: 'odtText.placeMarkers',
    call: (text, args) => {
      const warnings: string[] = []
      const rctx = {
        part: () => ({ xml: text }),
        warn: (message: string) => warnings.push(message),
      } as unknown as ts.coreConvert.OoxmlToOdfContext
      const placed = ts.textMarkers.placeMarkers(
        rctx,
        args.originals as never,
        args.edited as string[],
      )
      return { placements: placed.placements, warnings }
    },
    built: MARKED.flatMap((pieces) => {
      const { xml, originals } = markedPart(pieces)
      return MARKED_EDITS.map((edited) => ({ text: xml, args: { originals, edited } }))
    }),
    mutation: 'none',
  },
  {
    fn: 'odtText.textStyleAttrs',
    call: (text, args) =>
      ts.textParagraphModel.textStyleAttrs(
        sourceOf(text, args),
        (args.name ?? null) as string | null,
      ),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      const styles = part(parts, 'styles.xml')
      const table = ts.coreStyles.readOdtStyles(styles ?? null, content)
      return table.all
        .filter((s) => s.family === 'text')
        .slice(0, 20)
        .map((s) => ({
          text: content,
          args: { ...(styles === undefined ? {} : { stylesXml: styles }), name: s.name },
        }))
    },
    built: [undefined, 'T1', 'T2', 'Missing', ''].map((name) => ({
      text: STYLED_CONTENT,
      args: { stylesXml: STYLED_STYLES, ...(name === undefined ? {} : { name }) },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtText.readParagraph',
    call: (text, args) =>
      ts.textParagraphModel.readParagraph(
        sourceOf(text, args),
        args.range as never,
        args.record === undefined ? {} : { record: args.record as never },
      ),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      let body: ts.coreBody.OdtBody
      try {
        body = ts.coreBody.scanOdtBody(content)
      } catch {
        return []
      }
      const styles = part(parts, 'styles.xml')
      return ts.coreBody
        .nodesOfKind(body.blocks, 'paragraph')
        .concat(ts.coreBody.nodesOfKind(body.blocks, 'heading'))
        .slice(0, 25)
        .map((n) => ({
          text: content,
          args: {
            ...(styles === undefined ? {} : { stylesXml: styles }),
            range: {
              start: n.start,
              openEnd: n.openEnd,
              closeStart: n.closeStart,
              end: n.end,
              selfClosing: n.selfClosing,
            },
          },
        }))
    },
    built: PARAGRAPHS.map((range) => ({
      text: STYLED_CONTENT,
      args: { stylesXml: STYLED_STYLES, range },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtText.editedParagraphFromBlock',
    call: (_t, args) => ts.textParagraphOdf.editedParagraphFromBlock(args.b as never),
    fromModel: (doc) =>
      distinct(
        doc.blocks.slice(0, 40).map((b) => ({ args: { b } })),
        30,
      ),
    built: [
      firstOf('paragraph'),
      withFields(firstOf('heading'), {
        level: 2,
        outlineOnly: true,
        styleId: 'Heading2',
        rawPPr: '<w:pPr/>',
        hiddenBookmarks: ['_odtp1'],
      }),
      withFields(firstOf('paragraph'), {
        type: 'listItem',
        list: { kind: 'ordered', numId: '1', ilvl: 0 },
      }),
      firstOf('table'),
      firstOf('image'),
      withFields(firstOf('paragraph'), { runs: undefined }),
    ].map((b) => ({ args: { b } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtText.editedParagraphFromTableParagraph',
    call: (_t, args) => ts.textParagraphOdf.editedParagraphFromTableParagraph(args.p as never),
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .filter((b) => b.table)
          .slice(0, 4)
          .flatMap((b) => b.table!.rows.flat().flatMap((c) => c.richParas ?? []))
          .slice(0, 40)
          .map((p) => ({ args: { p } })),
        30,
      ),
    built: REAL_TABLES.slice(0, 3)
      .flatMap(({ model }) =>
        model.rows
          .flat()
          .flatMap((c) => c.richParas ?? [])
          .slice(0, 4),
      )
      .flatMap((p) => [
        p,
        { ...p, styleId: 'T', list: { kind: 'ordered', numId: '3', ilvl: 0 } },
        { ...p, list: undefined, styleId: undefined },
      ])
      .map((p) => ({ args: { p } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtText.isInvisibleInline',
    call: (text) => ts.textParagraphModel.isInvisibleInline(text),
    fromDocument: (parts) =>
      distinct(
        [...(part(parts, 'content.xml') ?? '').matchAll(/<([a-z0-9]+:[\w.-]+)/g)].map((m) => ({
          text: m[1]!,
        })),
        60,
      ),
    built: NAME_CASES.map((text) => ({ text })),
  },
  {
    fn: 'odtText.isFormFieldName',
    call: (text) => ts.textParagraphModel.isFormFieldName(text),
    fromDocument: (parts) =>
      distinct(
        [...(part(parts, 'content.xml') ?? '').matchAll(/text:name="([^"]*)"/g)].map((m) => ({
          text: ts.coreXml.decodeXmlEntities(m[1]!),
        })),
        60,
      ),
    built: NAME_CASES.map((text) => ({ text })),
  },
  {
    fn: 'odtText.pairMarkers',
    call: (_t, args) => {
      const markers = JSON.parse(JSON.stringify(args.markers)) as ts.coreConvert.BridgeMarker[]
      ts.textParagraphModel.pairMarkers(markers)
      return markers
    },
    built: [
      [
        ['bookmark-start', 'a'],
        ['bookmark-end', 'a'],
      ],
      [
        ['bookmark-start', 'a'],
        ['bookmark-start', 'a'],
        ['bookmark-end', 'a'],
        ['bookmark-end', 'a'],
      ],
      [
        ['bookmark-end', 'a'],
        ['bookmark-start', 'a'],
      ],
      [
        ['bookmark', 'a'],
        ['keep', 'b'],
        ['text', 'c'],
        ['handler', 'd'],
      ],
      [
        ['bookmark-start', 'a'],
        ['bookmark-start', 'b'],
        ['bookmark-end', 'a'],
        ['bookmark-end', 'b'],
        ['bookmark-end', 'b'],
      ],
      [
        ['bookmark-start', '\ud55c'],
        ['bookmark-end', '\ud55c'],
        ['bookmark-start', '__proto__'],
        ['bookmark-end', '__proto__'],
      ],
      [],
    ].map((kinds) => ({ args: { markers: MARKERS(kinds as Array<[string, string]>) } })),
    mutation: 'none',
  },
  {
    fn: 'odtText.tabStopsFromOdf',
    call: (_t, args) => props.tabStopsFromOdf(args.stops as never, args.marginLeftTwips as number),
    fromDocument: (parts) =>
      styleBags(parts).para.flatMap(({ tabs }) => [
        { args: { stops: tabs, marginLeftTwips: 0 } },
        { args: { stops: tabs, marginLeftTwips: 567 } },
      ]),
    built: TAB_STOP_LISTS.flatMap((stops) =>
      [0, 567.5, -100].map((marginLeftTwips) => ({ args: { stops, marginLeftTwips } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtText.paraFormatFromOdf',
    call: (_t, args) =>
      props.paraFormatFromOdf(
        args.pp as never,
        args.tabStops as never,
        args.marginLeftTwips as number,
      ),
    fromDocument: (parts) =>
      styleBags(parts).para.map(({ pp, tabs }) => ({
        args: { pp, tabStops: tabs, marginLeftTwips: 0 },
      })),
    built: PP_BAGS.map((pp, i) => ({
      args: { pp, tabStops: pick(TAB_STOP_LISTS, i), marginLeftTwips: i * 100 },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtText.paraKeys',
    call: (_t, args) => props.paraKeys(args.f as ParaFormat | undefined),
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .filter((b) => b.format)
          .slice(0, 40)
          .map((b) => ({ args: { f: b.format } })),
        30,
      ),
    built: [{ args: {} }, ...PARA_FORMATS.map((f) => ({ args: { f } }))],
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtText.changedParaKeys',
    call: (_t, args) => props.changedParaKeys(args.original as never, args.edited as never),
    fromModel: (doc) => {
      const formats = doc.blocks
        .filter((b) => b.format)
        .slice(0, 12)
        .map((b) => props.paraKeys(b.format))
      return formats.slice(1).map((edited, i) => ({ args: { original: formats[i], edited } }))
    },
    built: PARA_FORMATS.slice(1).map((f, i) => ({
      args: { original: props.paraKeys(PARA_FORMATS[i]), edited: props.paraKeys(f) },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtText.tabStopsToOdf',
    call: (_t, args) => props.tabStopsToOdf(args.stops as never, args.marginLeftTwips as number),
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .filter((b) => b.format?.tabStops)
          .slice(0, 20)
          .map((b) => ({ args: { stops: b.format!.tabStops, marginLeftTwips: 0 } })),
        20,
      ),
    built: PARA_FORMATS.flatMap((f) =>
      [0, 567, -300].map((marginLeftTwips) => ({
        args: { stops: f.tabStops ?? [], marginLeftTwips },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtText.paraOverrides',
    call: (_t, args) =>
      props.paraOverrides(
        args.keys as never,
        args.edited as ParaFormat,
        args.marginLeftTwips as number,
        args.original as never,
      ),
    fromModel: (doc) => {
      const blocks = doc.blocks.filter((b) => b.format).slice(0, 10)
      return blocks.slice(1).map((b, i) => {
        const original = props.paraKeys(blocks[i]!.format)
        const edited = props.paraKeys(b.format)
        return {
          args: {
            keys: props.changedParaKeys(original, edited),
            edited: b.format,
            marginLeftTwips: 0,
            original,
          },
        }
      })
    },
    built: PARA_FORMATS.flatMap((edited, i) => {
      const original = props.paraKeys(pick(PARA_FORMATS, i + 3))
      const keys = props.changedParaKeys(original, props.paraKeys(edited))
      return [
        { args: { keys, edited, marginLeftTwips: 0, original } },
        { args: { keys: PARA_KEY_NAMES, edited, marginLeftTwips: 567, original } },
      ]
    }),
    mutation: 'none',
  },
  {
    fn: 'odtText.textFormatFromOdf',
    call: (_t, args) =>
      props.textFormatFromOdf(args.tp as never, new Map(args.fontFaces as Array<[string, string]>)),
    fromDocument: (parts) => {
      const { text, faces } = styleBags(parts)
      return text.map((tp) => ({ args: { tp, fontFaces: faces } }))
    },
    built: TP_BAGS.map((tp, i) => ({ args: { tp, fontFaces: pick(FONT_FACES, i) } })),
    mutation: 'none',
  },
  {
    fn: 'odtText.textKeys',
    call: (_t, args) => props.textKeys(args.f as never),
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .flatMap((b) => (b.runs ?? []).slice(0, 3))
          .slice(0, 60)
          .map((r) => ({ args: { f: r } })),
        30,
      ),
    built: [{ args: {} }, ...TEXT_FORMATS.map((f) => ({ args: { f } }))],
    mutation: 'none',
  },
  {
    fn: 'odtText.changedTextKeys',
    call: (_t, args) => props.changedTextKeys(args.original as never, args.edited as never),
    built: TEXT_FORMATS.slice(1).map((f, i) => ({
      args: {
        original: props.textKeys(TEXT_FORMATS[i] as never),
        edited: props.textKeys(f as never),
      },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtText.clearedToInherited',
    call: (_t, args) =>
      props.clearedToInherited(
        args.changed as never,
        args.edited as never,
        args.inherited as never,
      ),
    built: TEXT_FORMATS.map((f, i) => {
      const edited = props.textKeys(f as never)
      const inherited = props.textKeys(pick(TEXT_FORMATS, i + 2) as never)
      const changed = props.changedTextKeys(
        props.textKeys(pick(TEXT_FORMATS, i + 5) as never),
        edited,
      )
      return { args: { changed, edited, inherited } }
    }),
    mutation: 'none',
  },
  {
    fn: 'odtText.textOverrides',
    call: (_t, args) => {
      const faces: string[] = []
      const overrides = props.textOverrides(args.keys as never, args.edited as never, (family) => {
        faces.push(family)
        return `${family}|face`
      })
      return { overrides, faces }
    },
    built: TEXT_FORMATS.flatMap((f, i) => {
      const edited = props.textKeys(f as never)
      return [
        {
          args: {
            keys: props.changedTextKeys(props.textKeys(pick(TEXT_FORMATS, i + 4) as never), edited),
            edited,
          },
        },
        { args: { keys: TEXT_KEY_NAMES, edited } },
      ]
    }),
    mutation: 'none',
  },
  {
    fn: 'odtText.quoteFamily',
    call: (text) => props.quoteFamily(text),
    built: [
      'Arial',
      'Malgun Gothic',
      '',
      ' ',
      'a\tb',
      '\ub9d1\uc740 \uace0\ub515',
      '\ud55c\uae00',
      "it's",
      'a\u00a0b',
      'a\u3000b',
    ].map((text) => ({ text })),
  },
  {
    fn: 'odtText.patchStartTag',
    call: (text, args) =>
      ts.textStyleXml.patchStartTag(text, prefixMapOf(args.prefixes), args.overrides as never),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      const prefixes = rootPrefixes(content)
      return distinct(
        [...content.matchAll(/<style:(?:style|paragraph-properties|text-properties)\b[^>]*>/g)].map(
          (m) => m[0],
        ),
        12,
      ).flatMap((tag, i) => [
        {
          text: tag,
          args: {
            prefixes,
            overrides: pick(
              [
                { 'fo:text-align': 'center' },
                { 'style:name': 'X&Y', 'fo:color': null },
                { 'fo:margin-left': null },
              ],
              i,
            ),
          },
        },
      ])
    },
    built: [
      ['<a b="1" c="2">', { b: '9' }],
      ['<a b="1" c="2"/>', { b: null }],
      ['<a b="1" c="2"/>', { d: '&<"' }],
      ['<a  b="1"   c="2" >', { c: null, b: null }],
      ['<a>', { b: '1', c: null }],
      ['<a/>', { b: '\ud55c\uae00' }],
      ['<a z:b="1">', { 'text:b': '2' }],
      ['<a\tb="1"\n/>', { b: null }],
      ['', { b: '1' }],
    ].map(([text, overrides]) => ({
      text: text as string,
      args: {
        prefixes: [{ name: 'xmlns:z', raw: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0' }],
        overrides,
      },
    })),
  },
  {
    fn: 'odtText.editStyleXml',
    call: (text, args) =>
      ts.textStyleXml.editStyleXml(text, prefixMapOf(args.prefixes), args.edit as never),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      const prefixes = rootPrefixes(content)
      return elementFragments(content, 'style:style')
        .slice(0, 10)
        .flatMap((xml, i) => [
          {
            text: xml,
            args: {
              prefixes,
              edit: {
                name: 'New' + i,
                parent: i % 2 ? null : 'Parent',
                props: {
                  'style:paragraph-properties': { 'fo:text-align': 'center' },
                  'style:text-properties': { 'fo:font-weight': 'bold' },
                },
              },
            },
          },
          {
            text: xml,
            args: {
              prefixes,
              edit: {
                tabStops: '<style:tab-stop style:position="1cm"/>',
                attrs: { 'style:display-name': 'D' },
              },
            },
          },
        ])
    },
    built: [
      ['<style:style style:name="A" style:family="paragraph"/>', { name: 'B' }],
      [
        '<style:style style:name="A" style:family="paragraph"></style:style>',
        { parent: 'P', props: { 'style:text-properties': { 'fo:color': '#ff0000' } } },
      ],
      [
        '<style:style style:name="A" style:family="paragraph"><style:paragraph-properties fo:text-align="start"/></style:style>',
        {
          props: { 'style:paragraph-properties': { 'fo:text-align': 'end' } },
          tabStops: '<style:tab-stop style:position="2cm"/>',
        },
      ],
      [
        '<style:style style:name="A" style:family="paragraph"><style:paragraph-properties fo:text-align="start"><style:tab-stops><style:tab-stop style:position="1cm"/></style:tab-stops></style:paragraph-properties><style:text-properties/></style:style>',
        { tabStops: '', props: { 'style:text-properties': { 'fo:color': null } } },
      ],
      [
        '<style:style style:name="A" style:family="paragraph" style:parent-style-name="P"><style:text-properties fo:font-weight="bold"/></style:style>',
        {
          parent: null,
          props: {
            'style:paragraph-properties': { 'fo:margin-left': '1cm' },
            'style:graphic-properties': { 'draw:fill': 'none' },
          },
        },
      ],
      [
        '<style:style style:name="A" style:family="paragraph"><style:table-cell-properties/><foo:bar/></style:style>',
        { props: { 'style:paragraph-properties': { 'fo:margin-left': '1cm' } } },
      ],
      [
        '<style:style style:name="A" style:family="paragraph"><style:paragraph-properties/></style:style>',
        {
          props: { 'style:paragraph-properties': { 'fo:text-align': null } },
          tabStops: '<style:tab-stop style:position="1cm"/>',
        },
      ],
      [
        '<style:style style:name="\ud55c" style:family="text">\ub0b4\uc6a9</style:style>',
        { name: '\u0131', attrs: { 'style:family': 'paragraph' } },
      ],
    ].map(([text, edit]) => ({
      text: text as string,
      args: {
        prefixes: [{ name: 'xmlns:style', raw: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0' }],
        edit,
      },
    })),
  },
  {
    fn: 'odtText.newStyleXml',
    call: (text, args) =>
      ts.textStyleXml.newStyleXml(
        text,
        args.family as string,
        args.parent === null ? null : (args.parent as string),
      ),
    built: [
      ['P_io1', 'paragraph', null],
      ['T&1', 'text', 'Base'],
      ['"q"', 'paragraph', '<x>'],
      ['', '', ''],
      ['\ud55c\uae00', 'table', 'a"b'],
    ].map(([text, family, parent]) => ({ text: text as string, args: { family, parent } })),
  },
  {
    fn: 'odtText.readOoxmlPPr',
    call: (text) => ts.textStyles.readOoxmlPPr(text),
    fromDocument: (parts) => wordFragments(parts, 'w:pPr').map((text) => ({ text })),
    built: [
      '',
      '<w:pPr/>',
      '<w:pPr><w:jc w:val="both"/><w:ind w:left="720" w:hanging="360"/></w:pPr>',
      '<w:pPr><w:jc w:val="end"/><w:ind w:start="100" w:end="200" w:firstLine="300"/><w:spacing w:before="1" w:after="2" w:line="360" w:lineRule="exact"/></w:pPr>',
      '<w:pPr><w:jc w:val="distribute"/><w:spacing w:line="480"/><w:keepNext/><w:keepLines w:val="0"/><w:pageBreakBefore w:val="true"/><w:shd w:fill="aabbcc"/></w:pPr>',
      '<w:pPr><w:jc w:val="left"/><w:spacing w:line="x" w:lineRule="atLeast"/><w:shd w:fill="auto"/><w:ind w:left="1.5"/></w:pPr>',
      '<w:pPr><w:jc w:val="center"/><w:keepNext w:val="off"/></w:pPr>',
      '<w:pPr><w:jc w:val="start"/><w:ind w:left="-5" w:hanging="1e2"/></w:pPr>',
    ].map((text) => ({ text })),
  },
  {
    fn: 'odtText.readOoxmlRPr',
    call: (text) => ts.textStyles.readOoxmlRPr(text),
    fromDocument: (parts) => wordFragments(parts, 'w:rPr').map((text) => ({ text })),
    built: [
      '',
      '<w:rPr/>',
      '<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="\ub9d1\uc740 \uace0\ub515" w:cs="Tahoma"/><w:b/><w:i w:val="0"/><w:u w:val="single"/><w:strike/></w:rPr>',
      '<w:rPr><w:rFonts w:hAnsi="H"/><w:color w:val="ff00aa"/><w:sz w:val="28"/><w:highlight w:val="yellow"/><w:shd w:fill="aabbcc"/><w:vertAlign w:val="superscript"/></w:rPr>',
      '<w:rPr><w:color w:val="auto"/><w:sz w:val="0"/><w:highlight w:val="none"/><w:shd w:fill="auto"/><w:vertAlign w:val="baseline"/><w:spacing w:val="20"/><w:w w:val="150"/><w:caps/></w:rPr>',
      '<w:rPr><w:u w:val="none"/><w:b w:val="false"/><w:smallCaps/><w:w w:val="100"/><w:spacing w:val="x"/></w:rPr>',
      '<w:rPr><w:caps w:val="0"/><w:smallCaps w:val="1"/><w:vertAlign w:val="subscript"/></w:rPr>',
    ].map((text) => ({ text })),
  },
  {
    fn: 'odtText.docxStylesById',
    call: (text) => ts.textStyles.docxStylesById(text),
    fromDocument: (parts) =>
      part(parts, 'word/styles.xml') === undefined
        ? []
        : [{ text: part(parts, 'word/styles.xml')! }],
    built: [
      '',
      '<w:styles/>',
      '<w:styles><w:style w:type="paragraph" w:styleId="A"><w:name w:val="a"/></w:style><w:style w:styleId="B"/><w:style w:styleId="A"/><w:styleX w:styleId="C"/></w:styles>',
      '<w:styles><w:style w:styleId="\ud55c">\ub0b4\uc6a9</w:style><w:style w:type="x">no id</w:style><w:style w:styleId="">e</w:style></w:styles>',
    ].map((text) => ({ text })),
  },
  {
    fn: 'odtText.styleEntryForOdf',
    call: (_t, args) =>
      ts.textStyles.styleEntryForOdf(
        args.map as never,
        args.odfName === null ? null : (args.odfName as string),
      ),
    built: [null, 'A', 'B', '\ud55c\uae00', 'missing', ''].map((odfName) => ({
      args: {
        odfName,
        map: {
          styles: {
            paragraph: [
              { styleId: 'a1', odfName: 'A', headingLevel: null, xml: '<w:style/>' },
              { styleId: 'h1', odfName: null, headingLevel: 1, xml: '' },
              { styleId: 'k', odfName: '\ud55c\uae00', headingLevel: null, xml: '' },
              { styleId: 'dup', odfName: 'A', headingLevel: null, xml: '' },
            ],
          },
        },
      },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtText.styleEntryById',
    call: (_t, args) =>
      ts.textStyles.styleEntryById(args.map as never, args.styleId as string | undefined),
    built: ['a1', 'h1', 'dup', 'nope', '', undefined].map((styleId) => ({
      args: {
        styleId,
        map: {
          styles: {
            paragraph: [
              { styleId: 'a1', odfName: 'A', headingLevel: null, xml: '' },
              { styleId: 'h1', odfName: null, headingLevel: 1, xml: '' },
              { styleId: 'dup', odfName: 'A', headingLevel: null, xml: '1' },
              { styleId: 'dup', odfName: 'B', headingLevel: null, xml: '2' },
            ],
          },
        },
      },
    })),
    mutation: 'none',
  },
  ...(
    [
      ['lengthToTwips', ts.textUnits.lengthToTwips],
      ['twips', ts.textUnits.twips],
      ['percent', ts.textUnits.percent],
    ] as const
  ).map(([name, run]): CallSpec => ({
    fn: `odtText.${name}`,
    call: (text, args) => run(args.missing ? undefined : text),
    fromDocument: (parts) =>
      distinct(
        [
          ...[part(parts, 'content.xml'), part(parts, 'styles.xml')].flatMap((p) =>
            [...(p ?? '').matchAll(/="(-?[\d.]+(?:cm|mm|in|inch|pt|pc|px|%))"/g)].map((m) => m[1]!),
          ),
        ],
        60,
      ).map((text) => ({ text })),
    built: [
      '0cm',
      '1cm',
      '0.529cm',
      '-1.5cm',
      '+2mm',
      '12pt',
      '1in',
      '2inch',
      '3pc',
      '15px',
      '1e1cm',
      '.5cm',
      '5.cm',
      ' 1cm ',
      '1 cm',
      '1CM',
      '1cm1',
      'cm',
      '',
      'abc',
      '160%',
      '-50 %',
      '+.5%',
      '1e2%',
      '%',
      '100',
      '12.5pt',
      '1e400cm',
      '0pt',
      '\ud55c cm',
    ]
      .map((text) => ({ text }))
      .concat([{ text: '' }, { text: '', args: { missing: true } } as never]),
  })),
  ...(
    [
      ['twipsToCm', ts.textUnits.twipsToCm],
      ['twipsToPt', ts.textUnits.twipsToPt],
      ['halfPointsToPt', ts.textUnits.halfPointsToPt],
    ] as const
  ).map(([name, run]): CallSpec => ({
    fn: `odtText.${name}`,
    call: (_t, args) => run(args.value as number),
    built: [
      0, 1, -1, 567, 1440, -1440, 0.5, 1e-9, -1e-9, 12345.678, 1e21, 2.5, -0.0001, 100, 21, 1e6,
      3.00049, 0.0005, 0.005,
    ].map((value) => ({ args: { value } })),
    mutation: 'none',
  })),
  constantSpec('odtText', {
    HIGHLIGHT_HEX: () => props.HIGHLIGHT_HEX,
    TEXT_OWNER: () => ts.textBlocks.TEXT_OWNER,
  }),
]
