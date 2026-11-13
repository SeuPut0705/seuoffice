// Group `genText`: the text patches of generate.ts (cached field text, OMML
// tokens, table cell texts, textbox paragraphs) and the segment scanner they
// share.
import {
  patchFieldParagraphXml,
  patchMathTokens,
  patchTableCellTexts,
  patchTextboxParas,
  type CellTextsPatch,
  type FieldTextPatch,
  type TextboxParasPatchSet,
} from './reference/generate'
import { xmlSegments } from './reference/xml-tag'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'
import { SEGMENT_CASES, hiddenIn } from './calls-markup'

// ---------------------------------------------------------------- the corpus

interface Collected {
  bodies: string[]
  tables: string[]
  /** paragraphs with a run tab and visible text: TOC entries and the like */
  tabParas: string[]
  maths: string[]
  boxParas: string[]
}

const collected = new WeakMap<ReadonlyMap<string, string>, Collected>()

const BODY_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/
const PER_DOC = 12

function collect(parts: ReadonlyMap<string, string>): Collected {
  const known = collected.get(parts)
  if (known) return known
  const bodies = [...parts].filter(([name]) => BODY_PART.test(name)).map(([, text]) => text)
  const paras = bodies.flatMap((body) => elementFragments(body, 'w:p'))
  const result: Collected = {
    bodies,
    tables: bodies.flatMap((body) => elementFragments(body, 'w:tbl')).slice(0, PER_DOC),
    tabParas: paras
      .filter((p) => /<w:tab\s*\/>|<w:tab>\s*<\/w:tab>/.test(p) && /<w:t[\s>]/.test(p))
      .slice(0, PER_DOC),
    maths: bodies.flatMap((body) => elementFragments(body, 'm:oMath')).slice(0, PER_DOC),
    boxParas: paras.filter((p) => /<w:txbxContent[\s>]|<wps:wsp[\s>]/.test(p)).slice(0, PER_DOC),
  }
  collected.set(parts, result)
  return result
}

// ---------------------------------------------------------------- patches made from a text

const FIELD_PATCHES: FieldTextPatch[] = [
  { left: 'Updated & chapter', right: '12' },
  { left: ' Edge ' },
  { right: '\u00A0 9' },
  { left: 'Title with \u{1F600} emoji', right: '1' },
  {},
]

/** Tokens per OMML fragment: one per paired m:t, or a count that differs. */
function tokensFor(math: string): string[][] {
  const count = [...math.matchAll(/<m:t(?:\s[^>]*)?>[\s\S]*?<\/m:t>/g)].length
  const same = Array.from({ length: count }, (_, i) => (i % 2 ? `x<${i}>` : ` y&${i} `))
  return [same, [...same, 'extra']]
}

/** A grid of cell patches over the rows and cells the table has. */
function gridsFor(table: string): CellTextsPatch[][][] {
  const rows = xmlSegments(table, 'w:tr', 0, table.length).map(
    (tr) => xmlSegments(table, 'w:tc', tr.start, tr.end).length,
  )
  const cellOf = (r: number, c: number, variant: number): CellTextsPatch | null => {
    switch ((r + c + variant) % 6) {
      case 0:
        return [`T${r}.${c}`]
      case 1:
        return [null, 'a\tb\nc\u00ADd\u2011e\f']
      case 2:
        return [{ runs: [{ text: 'rich ' }, { text: 'bold', bold: true }] }, '']
      case 3:
        return { nested: [[[['N']]], null] }
      case 4:
        return null
      default:
        return [{ runs: [], xml: '<w:r><w:t>pre</w:t></w:r>' }]
    }
  }
  return [0, 1].map((variant) =>
    rows.map((cells, r) => Array.from({ length: cells }, (_, c) => cellOf(r, c, variant)) as never),
  )
}

function boxPatchesFor(p: string): TextboxParasPatchSet[] {
  const ids = [...p.matchAll(/<wps:cNvPr\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!)
  return [
    { byIndex: [[{ runs: [{ text: 'Box ' }, { text: 'new', italic: true }], align: 'center' }, null]] },
    {
      byIndex: [
        null,
        [{ runs: [], numPr: { numId: '3', ilvl: 1 }, indentLeft: 720, align: 'justify' }],
      ],
    },
    { byIndex: [[null, null, { runs: [{ text: 'added' }], align: null, numPr: null }]] },
    ...ids.slice(0, 2).map((shapeId) => ({
      inject: [{ shapeId, paras: [{ runs: [{ text: 'typed' }], align: 'right' as const, indentLeft: 240 }] }],
    })),
  ]
}

const SEGMENT_TAGS = ['w:p', 'w:r', 'w:tbl', 'w:tr', 'w:tc', 'w:txbxContent', 'wps:wsp', 'w:t']

function segmentInputs(text: string): Input[] {
  const half = Math.floor(text.length / 2)
  return [
    ...SEGMENT_TAGS.map((tag) => ({ text, args: { tag, from: 0, to: text.length } })),
    { text, args: { tag: 'w:p', from: half, to: text.length } },
    { text, args: { tag: 'w:r', from: 1, to: half } },
    { text, args: { tag: 'w:p', from: -3, to: text.length + 5 } },
  ]
}

// ---------------------------------------------------------------- built inputs

const r = (inner: string, attrs = ''): string => `<w:r${attrs}>${inner}</w:r>`
const t = (text: string, attrs = ''): string => r(`<w:t${attrs}>${text}</w:t>`)
const p = (...inner: string[]): string => `<w:p>${inner.join('')}</w:p>`
const tc = (...inner: string[]): string => `<w:tc>${inner.join('')}</w:tc>`
const tr = (...cells: string[]): string => `<w:tr>${cells.join('')}</w:tr>`
const tbl = (...rows: string[]): string => `<w:tbl><w:tblGrid/>${rows.join('')}</w:tbl>`
const fld = (type: string): string => r(`<w:fldChar w:fldCharType="${type}"/>`)
const TAB = r('<w:tab/>')

const FIELD_PARAS: string[] = [
  p(
    '<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>',
    '<w:hyperlink w:anchor="_Toc1">',
    t('Chapter '),
    t('one'),
    TAB,
    fld('begin'),
    r('<w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText>'),
    fld('separate'),
    t('7'),
    fld('end'),
    '</w:hyperlink>',
  ),
  p(t('1.1.'), TAB, t('Judul'), r('<w:tab />'), t('7')),
  p(t('1.1 with space'), TAB, t('Title'), r('<w:tab></w:tab>'), t('3')),
  p(t('Foo &#8211; &#x2013; Bar &amp; &#55296; &#99999999;'), TAB, t('12')),
  p(t('no tab here'), r('<w:t/>'), r('<w:t xml:space="preserve"/>')),
  p(r('<w:t/>'), TAB, r('<w:t/>')),
  p(t('\u{1F600}ab'), t('cd'), TAB, t('9')),
  p(r('<w:tab w:val="left"/>'), t('only stop')),
  p('<w:ins w:id="1" w:author="a">', t('inserted'), '</w:ins>', TAB, '<w:del w:id="2" w:author="a">', r('<w:delText>old</w:delText>'), '</w:del>', t('4')),
  p(r('<w:drawing/>')),
  // a first segment before two tabs is the outline number when it is 1..15 UTF-16 units without white space
  ...['a'.repeat(14), 'a'.repeat(15), 'a'.repeat(16), '\u{1F600}' + 'a'.repeat(13), '\u{1F600}' + 'a'.repeat(14)].map((first) =>
    p(t(first), TAB, t('Title'), TAB, t('7')),
  ),
]

const MATHS: string[] = [
  '<m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath>',
  '<m:oMath><m:r><m:t xml:space="preserve"> x </m:t></m:r><m:r><m:t/></m:r><m:r><m:t>&lt;y&gt;</m:t></m:r></m:oMath>',
  '<m:oMath><m:sSup><m:e><m:r><m:t>e</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>',
  '<m:oMath><m:r><w:rPr/><m:t>&#120587;</m:t></m:r></m:oMath>',
  '<m:oMath/>',
]

const BLIP = (id: string): string =>
  `<w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
const ANCHOR_BOX = (text: string): string =>
  `<w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent>${p(t(text))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>`
const TWIN = (id: string): string =>
  `<mc:AlternateContent><mc:Choice Requires="wps">${BLIP(id).replace('wp:inline', 'wp:anchor').replace('</wp:inline>', '</wp:anchor>')}</mc:Choice><mc:Fallback><w:pict><v:shape><v:imagedata r:id="${id}"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent>`

const TABLES: string[] = [
  tbl(
    tr(
      tc('<w:tcPr><w:shd w:val="clear" w:fill="1F3864"/></w:tcPr>', p('<w:pPr><w:jc w:val="center"/></w:pPr>', r('<w:rPr><w:b/></w:rPr><w:t>甲</w:t>'))),
      tc(p(t('乙')), p(t('second'))),
    ),
    tr(tc('<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>', p(t('m'))), tc('<w:tcPr><w:vMerge/></w:tcPr>', '<w:p/>')),
  ),
  tbl(tr(tc(p(r(BLIP('rId10')), t('caption'))), tc(p(t('notes'))))),
  tbl(tr(tc(p(r(ANCHOR_BOX('ghost')), t('label'))), tc(p(r(TWIN('rId5')), t('twin'))))),
  tbl(tr(tc(p(r('<w:pict><v:shape><v:textbox><w:txbxContent>' + p(t('vml')) + '</w:txbxContent></v:textbox></v:shape></w:pict>')), p(r('<w:object/>'))))),
  tbl(
    tr(
      tc(p(t('outer')), tbl(tr(tc(p(t('InnerA'))), tc(p(t('InnerB')))), tr(tc(tbl(tr(tc(p(t('deep'))))), '<w:p/>'))), '<w:p/>'),
      tc(p(t('right'))),
    ),
  ),
  tbl(
    tr(tc(p('<w:ins w:id="3" w:author="a">', t('ins'), '</w:ins>', '<w:del w:id="4" w:author="a">', r('<w:delText>gone</w:delText>'), '</w:del>'))),
    '<w:trPr><w:trHeight w:val="1"/></w:trPr>',
  ),
  tbl(tr('<w:tc w:id="x">' + p('<w:pPr/>', t('a')) + '</w:tc>', tc('<w:tcPr/>', p(r('<w:rPr><w:i/></w:rPr><w:t>x</w:t>'))))),
  '<w:tbl><w:tr><w:tc/></w:tr></w:tbl>',
]

const NESTED_PATCHES: unknown[] = [
  [[{ nested: [[[['EditedInnerA'], null], [{ nested: [[[['D']]]] }]]] }, ['r']]],
  [[{ nested: [] }, null]],
  [[{ nested: [null] }]],
]

const TABLE_INPUTS: Input[] = [
  ...TABLES.flatMap((text) => gridsFor(text).map((texts) => ({ text, args: { texts } }))),
  ...NESTED_PATCHES.map((texts) => ({ text: TABLES[4]!, args: { texts } })),
  { text: TABLES[2]!, args: { texts: [[[{ runs: [{ text: 'labelX' }, { text: 'ghost' }] }], [{ runs: [] }]]] } },
  { text: TABLES[1]!, args: { texts: [[[{ runs: [{ text: 'new' }] }, { runs: [{ text: 'two' }] }]]] } },
  { text: TABLES[0]!, args: { texts: [null, [['A<B', '&C'], ['\u{1F600}']]] } },
  { text: TABLES[0]!, args: { texts: [[[{ runs: [{ text: 'f' }], format: { align: 'right' }, original: { align: 'center' } }]]] } },
  { text: TABLES[0]!, args: { texts: [[['constructor'], ['__proto__']]] } },
]

const SHAPE = (id: string, inner: string): string =>
  `<wps:wsp><wps:cNvPr id="${id}" name="s"/><wps:spPr/>${inner}</wps:wsp>`
const BOX_P = (inner: string): string =>
  p(r(`<w:drawing><wp:anchor><a:graphic><a:graphicData>${inner}</a:graphicData></a:graphic></wp:anchor></w:drawing>`))
const TXBX = (...paras: string[]): string =>
  `<wps:txbx><w:txbxContent>${paras.join('')}</w:txbxContent></wps:txbx>`

const BOX_PARAS: string[] = [
  `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData>${SHAPE(
    '1',
    TXBX(p(t('one')), p('<w:pPr><w:jc w:val="center"/></w:pPr>', t('two'))) + '<wps:bodyPr/>',
  )}</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${p(
    t('one'),
  )}${p('<w:pPr><w:jc w:val="center"/></w:pPr>', t('two'))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
  BOX_P(SHAPE('5', '<wps:bodyPr rot="0"/>') + SHAPE('6', TXBX(p(t('Hello'))) + '<wps:bodyPr anchor="t"/>')),
  BOX_P(SHAPE('7', '')),
  BOX_P(
    SHAPE('8', TXBX('<w:p/>')) +
      SHAPE(
        '9',
        TXBX(
          p('<w:pPr><w:pStyle w:val="List"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:ind w:leftChars="200" w:left="420" w:hanging="360"/><w:rPr><w:b/></w:rPr></w:pPr>', t('item')),
          p('<w:pPr/>', '<w:ins w:id="9" w:author="a">', t('rev'), '</w:ins>'),
        ),
      ),
  ),
  BOX_P(SHAPE('10', '<w:txbxContent></w:txbxContent>')),
]

/**
 * A paragraph of a text box with its fallback twin, with a spelling a literal
 * search for the tags reads wrongly: markup hidden in a comment, CDATA or an
 * instruction, a spaced end tag, a `>` in an attribute value, attributes on
 * the fallback.
 */
const markupBox = (hazard: {
  before?: string
  between?: string
  text?: string
  txbxOpen?: string
  txbxClose?: string
  pClose?: string
  fallbackOpen?: string
  fallbackClose?: string
  inFallback?: string
}): string => {
  const txbxOpen = hazard.txbxOpen ?? '<w:txbxContent>'
  const txbxClose = hazard.txbxClose ?? '</w:txbxContent>'
  const pClose = hazard.pClose ?? '</w:p>'
  const para = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r>${pClose}`
  const paras = `${para(hazard.text ?? 'one')}${hazard.between ?? ''}${para('two')}`
  return (
    `<w:p><w:r>${hazard.before ?? ''}<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData>` +
    SHAPE('1', `<wps:txbx>${txbxOpen}${paras}${txbxClose}</wps:txbx><wps:bodyPr/>`) +
    `</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>` +
    `${hazard.fallbackOpen ?? '<mc:Fallback>'}${hazard.inFallback ?? ''}<w:pict><v:shape><v:textbox>${txbxOpen}${paras}${txbxClose}</v:textbox></v:shape></w:pict>${hazard.fallbackClose ?? '</mc:Fallback>'}` +
    `</mc:AlternateContent></w:r></w:p>`
  )
}

const MARKUP_BOX_PARAS: string[] = [
  markupBox({}),
  ...hiddenIn('<w:txbxContent>').map((before) => markupBox({ before })),
  ...hiddenIn('</w:txbxContent>').map((between) => markupBox({ between })),
  ...hiddenIn('</w:p>').map((text) => markupBox({ text })),
  ...hiddenIn('<w:p>').map((between) => markupBox({ between })),
  ...hiddenIn('<mc:Fallback>').map((before) => markupBox({ before })),
  ...hiddenIn('</mc:Fallback>').map((inFallback) => markupBox({ inFallback })),
  markupBox({ txbxClose: '</w:txbxContent >', fallbackClose: '</mc:Fallback\n>' }),
  markupBox({ pClose: '</w:p\t>', txbxClose: '</w:txbxContent\n>' }),
  markupBox({ txbxOpen: '<w:txbxContent a=">">' }),
  markupBox({ txbxOpen: "<w:txbxContent a='>' b=\"'>\">" }),
  markupBox({ fallbackOpen: '<mc:Fallback xmlns:x="urn:x">' }),
  markupBox({ fallbackOpen: '<mc:Fallback a=">">' }),
  markupBox({ before: '<w:txbxContent/>' }),
]

const BOX_PATCHES: TextboxParasPatchSet[] = [
  {},
  { byIndex: [null] },
  { byIndex: [[{ runs: [{ text: 'a < b & c\tD\nE' }] }]] },
  { byIndex: [[{ runs: [], align: 'left', indentLeft: 1440, numPr: { numId: '7', ilvl: 0 } }]] },
  { byIndex: [null, [{ runs: [{ text: 'x' }], align: 'distribute', indentLeft: null, numPr: null }, null]] },
  { inject: [{ shapeId: '5', paras: [{ runs: [{ text: 'typed' }], align: 'center' }] }] },
  { inject: [{ shapeId: '6', paras: [{ runs: [{ text: 'replaced' }] }, { runs: [] }] }] },
  { inject: [{ shapeId: '7', paras: [{ runs: [{ text: 'x' }], indentLeft: 360 }] }, { shapeId: 'none', paras: [] }] },
]

// ---------------------------------------------------------------- the specs

export const GEN_TEXT: CallSpec[] = [
  {
    fn: 'genText.xmlSegments',
    call: (text, args) =>
      xmlSegments(text, args.tag as string, args.from as number, args.to as number),
    fromDocument: (parts) => {
      const { bodies, tables, boxParas } = collect(parts)
      return [...bodies.slice(0, 1), ...tables.slice(0, 3), ...boxParas.slice(0, 3)].flatMap(segmentInputs)
    },
    built: [
      ...[...TABLES, ...BOX_PARAS, ...FIELD_PARAS, '<w:p/><w:p>\u{1F600}</w:p><w:pPr/>', '</w:p><w:p>'].flatMap(
        segmentInputs,
      ),
      ...[...SEGMENT_CASES, ...MARKUP_BOX_PARAS.map((text) => ({ text, tag: 'w:txbxContent' }))].flatMap(
        ({ text, tag }) => [
          { text, args: { tag, from: 0, to: text.length } },
          { text, args: { tag, from: Math.floor(text.length / 3), to: text.length } },
          { text, args: { tag: 'w:p', from: 0, to: Math.floor(text.length / 2) } },
        ],
      ),
    ],
  },
  {
    fn: 'genText.patchFieldParagraphXml',
    argMutation: true,
    call: (text, args) => patchFieldParagraphXml(text, args.patch as FieldTextPatch),
    fromDocument: (parts) =>
      collect(parts).tabParas.flatMap((text) => FIELD_PATCHES.slice(0, 3).map((patch) => ({ text, args: { patch } }))),
    built: FIELD_PARAS.flatMap((text) => FIELD_PATCHES.map((patch) => ({ text, args: { patch } }))),
  },
  {
    fn: 'genText.patchMathTokens',
    argMutation: true,
    call: (text, args) => patchMathTokens(text, args.tokens as string[]),
    fromDocument: (parts) =>
      collect(parts).maths.flatMap((text) => tokensFor(text).map((tokens) => ({ text, args: { tokens } }))),
    built: MATHS.flatMap((text) => tokensFor(text).map((tokens) => ({ text, args: { tokens } }))),
  },
  {
    fn: 'genText.patchTableCellTexts',
    argMutation: true,
    call: (text, args) => patchTableCellTexts(text, args.texts as never),
    fromDocument: (parts) =>
      collect(parts).tables.flatMap((text) => gridsFor(text).map((texts) => ({ text, args: { texts } }))),
    built: TABLE_INPUTS,
  },
  {
    fn: 'genText.patchTextboxParas',
    argMutation: true,
    call: (text, args) => patchTextboxParas(text, args.patches as TextboxParasPatchSet),
    fromDocument: (parts) =>
      collect(parts).boxParas.flatMap((text) => boxPatchesFor(text).map((patches) => ({ text, args: { patches } }))),
    built: [...BOX_PARAS, ...MARKUP_BOX_PARAS].flatMap((text) =>
      [...BOX_PATCHES, ...boxPatchesFor(text)].map((patches) => ({ text, args: { patches } })),
    ),
  },
]
