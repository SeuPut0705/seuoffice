// Group `drawing` of comparison (f): parse-drawing-geometry.ts without
// w14TextOutlineOf (compared with the property readers). A function over a
// node takes the XML text and the name of the top-level element in
// `args.node`; the theme crosses as `args.theme`; a section crosses as the
// w:sectPr text both sides read with sectionSettingsFromXml.
import {
  colorNodeHex,
  composeGroupCtm,
  DEFAULT_WRAP_DIST_EMU,
  drawingAnchorMeta,
  EMU_PER_TWIP,
  gradFillApproxHex,
  IDENTITY_CTM,
  lineBoxOf,
  LINE_PRSTS,
  LINE_PRSTS_RE,
  MIN_WRAP_SLIVER_EMU,
  resolveAnchorPagePos,
  resolveAnchorPageYEmu,
  solidFillAlpha,
  topLevelDrawings,
  w14GlowOf,
  w14TextFillHex,
  type DrawingAnchorMeta,
  type GroupCtm,
} from './reference/parse-drawing-geometry'
import { sectionSettingsFromXml } from './reference/section'
import { readThemeColors } from './reference/theme'
import type { ThemeColors } from './reference/types'
import { nameOf, xmlParser, type XNode } from './reference/xml-utils'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'
import { hiddenIn } from './calls-markup'

const CONSTANTS: Record<string, unknown> = {
  LINE_PRSTS_RE: { source: LINE_PRSTS_RE.source, flags: LINE_PRSTS_RE.flags },
  LINE_PRSTS: [...LINE_PRSTS].sort(),
  EMU_PER_TWIP,
  MIN_WRAP_SLIVER_EMU,
  DEFAULT_WRAP_DIST_EMU,
  IDENTITY_CTM,
}

/** The top-level element of `text` named `args.node`. */
function nodeOf(text: string, args: Record<string, unknown>): XNode | undefined {
  return (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === args.node)
}

const elementOf = (text: string, args: Record<string, unknown>): XNode => nodeOf(text, args) ?? {}

const themeArg = (args: Record<string, unknown>): ThemeColors | undefined =>
  args.theme as ThemeColors | undefined

const sectionOf = (text: string, args: Record<string, unknown>) =>
  args.noSection === true ? undefined : sectionSettingsFromXml(text)

// ---------------------------------------------------------------- the corpus

/** Fragments kept per function and document. */
const CORPUS_KEPT = 40
const CONTENT_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|styles)\.xml$/

/** Distinct `[element, fragment]` pairs of the content parts that pass `keep`, a bounded few. */
function fragmentsOf(
  parts: ReadonlyMap<string, string>,
  elements: string[],
  keep: (fragment: string) => boolean = () => true,
  kept = CORPUS_KEPT,
): Array<[string, string]> {
  const out = new Map<string, string>()
  for (const [name, xml] of parts) {
    if (!CONTENT_PART.test(name)) continue
    for (const element of elements) {
      for (const fragment of elementFragments(xml, element)) {
        if (out.size >= kept) return [...out].map(([text, el]) => [el, text])
        if (keep(fragment) && !out.has(fragment)) out.set(fragment, element)
      }
    }
  }
  return [...out].map(([text, el]) => [el, text])
}

/** Each fragment as a node call, without a theme and under the document's own. */
function nodeInputs(
  parts: ReadonlyMap<string, string>,
  pairs: Array<[string, string]>,
  themed: boolean,
): Input[] {
  const theme = themed ? readThemeColors(parts.get('word/theme/theme1.xml') ?? '') : null
  return pairs.flatMap(([node, text]) =>
    theme
      ? [
          { text, args: { node } },
          { text, args: { node, theme } },
        ]
      : [{ text, args: { node } }],
  )
}

const drawingParagraphsOf = (parts: ReadonlyMap<string, string>): string[] =>
  fragmentsOf(parts, ['w:p'], (p) => p.includes('<w:drawing')).map(([, text]) => text)

function drawingFragmentsOf(parts: ReadonlyMap<string, string>): string[] {
  const top = drawingParagraphsOf(parts).flatMap((p) => topLevelDrawings(p))
  const elements = fragmentsOf(parts, ['w:drawing', 'mc:AlternateContent']).map(([, text]) => text)
  return [...new Set([...top, ...elements])].slice(0, CORPUS_KEPT * 2)
}

function anchorInputs(parts: ReadonlyMap<string, string>): Input[] {
  const metas = new Map<string, DrawingAnchorMeta>()
  for (const fragment of drawingFragmentsOf(parts)) {
    const meta = drawingAnchorMeta(fragment)
    if (meta.anchored) metas.set(JSON.stringify(meta), meta)
    if (metas.size >= 20) break
  }
  const sectPrs = [...new Set(elementFragments(parts.get('word/document.xml') ?? '', 'w:sectPr'))]
  const texts = sectPrs.slice(0, 2)
  return [...metas.values()].flatMap((meta) => [
    ...texts.map((text) => ({ text, args: { meta } })),
    { text: '', args: { meta, noSection: true } },
  ])
}

// ---------------------------------------------------------------- built inputs

const THEME_CUSTOM: ThemeColors = {
  name: 'custom',
  dk1: '010101',
  lt1: 'fefefe',
  dk2: '102030',
  lt2: 'A0B0C0',
  accent1: 'ff0000',
  accent2: '00FF00',
  accent3: '0000ff',
  accent4: '808080',
  accent5: '7F7F7F',
  accent6: 'C0FFEE',
  hlink: '123ABC',
  folHlink: 'abcdef',
}

/** Slots a theme part can hold that do not read as six hex digits, and missing slots. */
const THEME_BROKEN: ThemeColors = {
  dk1: '',
  lt1: ' abcdef ',
  dk2: 'GGGGGG',
  lt2: '12345',
  accent1: '1234567',
  accent2: '\u3000a1b2c3',
}

const THEMES: Array<ThemeColors | undefined> = [undefined, THEME_CUSTOM, THEME_BROKEN]

const withThemes = (node: string, texts: string[]): Input[] =>
  texts.flatMap((text) =>
    THEMES.map((theme) => ({ text, args: theme ? { node, theme } : { node } })),
  )

const MALFORMED = [
  '',
  '<a:solidFill><a:srgbClr val="FF0000"></a:solidFill>',
  '<a:solidFill><a:srgbClr val="FF0000"/>',
  '<a:solidFill',
  '</a:solidFill>',
  '<a:solidFill val="a"b"/>',
  '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></x>',
  'text only',
]

const SCHEME_VALS = [
  'tx1',
  'bg1',
  'tx2',
  'bg2',
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
  'phClr',
  'ACCENT1',
  '',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
]

const PRST_VALS = [
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'cyan',
  'magenta',
  'gray',
  'orange',
  'Black',
  '__proto__',
  'constructor',
  'toString',
]

/** Percent values each transform reader meets: bounds, beyond, negative, not a number. */
const PCTS = [
  '0',
  '-0',
  '1',
  '50000',
  '99999',
  '100000',
  '150000',
  '-5',
  'abc',
  '',
  '75000.5',
  ' 60000',
  '1e5',
  '99999999999999999999999',
]

const A_TRANSFORMS = ['a:lumMod', 'a:lumOff', 'a:shade', 'a:tint', 'a:satMod', 'a:alpha']

const solid = (inner: string): string => `<a:solidFill>${inner}</a:solidFill>`
const aMod = (name: string, val: string): string => `<${name} val="${val}"/>`

const COLOR_NODES: string[] = [
  ...[
    'FF0000',
    'ff8800',
    ' 00ff00 ',
    '12345',
    'GGGGGG',
    '',
    '1234567',
    '\u3000ABCDEF',
    '0x1234',
  ].map((val) => solid(`<a:srgbClr val="${val}"/>`)),
  solid('<a:srgbClr/>'),
  solid(`<a:srgbClr val="808080">${aMod('a:lumMod', '50000')}</a:srgbClr>`),
  solid('<a:sysClr val="windowText" lastClr="123456"/>'),
  solid('<a:sysClr val="windowText"/>'),
  solid('<a:sysClr val="window"/>'),
  solid('<a:sysClr/>'),
  solid('<a:sysClr val="windowText" lastClr=""/>'),
  solid('<a:sysClr val="windowText" lastClr="zz"/>'),
  solid('<a:sysClr lastClr=""/><a:prstClr val="red"/>'),
  ...PRST_VALS.map((val) => solid(`<a:prstClr val="${val}"/>`)),
  solid('<a:prstClr/>'),
  solid('<a:prstClr val="orange"/><a:schemeClr val="accent2"/>'),
  ...SCHEME_VALS.map((val) => solid(`<a:schemeClr val="${val}"/>`)),
  solid('<a:schemeClr/>'),
  ...A_TRANSFORMS.flatMap((name) =>
    PCTS.map((val) => solid(`<a:schemeClr val="accent1">${aMod(name, val)}</a:schemeClr>`)),
  ),
  solid(`<a:schemeClr val="dk1">${aMod('a:lumMod', '50000')}</a:schemeClr>`),
  solid(`<a:schemeClr val="tx1">${aMod('a:lumOff', '50000')}</a:schemeClr>`),
  solid(
    `<a:schemeClr val="accent5">${aMod('a:lumMod', '75000')}${aMod('a:lumOff', '25000')}</a:schemeClr>`,
  ),
  solid(
    `<a:schemeClr val="accent6">${aMod('a:tint', '40000')}${aMod('a:shade', '60000')}</a:schemeClr>`,
  ),
  solid(
    `<a:schemeClr val="bg2">${aMod('a:tint', '66000')}${aMod('a:lumOff', '10000')}${aMod('a:shade', '95000')}${aMod('a:lumMod', '90000')}</a:schemeClr>`,
  ),
  solid(
    `<a:schemeClr val="accent1">${aMod('a:lumMod', '50000')}${aMod('a:lumMod', '0')}</a:schemeClr>`,
  ),
  solid(`<a:srgbClr val=""/><a:schemeClr val="accent2">${aMod('a:lumMod', '50000')}</a:schemeClr>`),
  solid(
    `<a:srgbClr val="00FF00"/><a:schemeClr val="accent2">${aMod('a:lumMod', '50000')}</a:schemeClr>`,
  ),
  solid(
    `<a:schemeClr val="accent3">${aMod('a:lumMod', '50000')}</a:schemeClr><a:srgbClr val="ABCDEF"/>`,
  ),
  solid('<a:sysClr val="window"/><a:schemeClr val="accent2"/>'),
  solid('<a:srgbClr val="111111"/><a:srgbClr val="222222"/>'),
  solid('<a:hslClr hue="0" sat="100000" lum="50000"/>'),
  solid('<a:scrgbClr r="100000" g="0" b="0"/>'),
  solid(''),
  solid('\n  <a:srgbClr val="C0C0C0"/>\n'),
  '<a:noFill/>',
  ...MALFORMED,
]

const ALPHAS = ['0', '-0', '50000', '99999', '100000', '-1', 'abc', '', ' 7', '1.5', '1e3']

const ALPHA_HOLDERS = [
  'a:srgbClr val="FF0000"',
  'a:schemeClr val="accent1"',
  'a:sysClr val="window"',
  'a:prstClr val="red"',
  'a:hslClr hue="0" sat="0" lum="0"',
  'a:scrgbClr r="0" g="0" b="0"',
]

const ALPHA_FILLS: string[] = [
  ...ALPHA_HOLDERS.flatMap((holder) => {
    const name = holder.split(' ')[0]!
    return ALPHAS.map((val) => solid(`<${holder}>${aMod('a:alpha', val)}</${name}>`))
  }),
  ...ALPHA_HOLDERS.map((holder) => solid(`<${holder}/>`)),
  solid(
    `<a:schemeClr val="accent1">${aMod('a:alpha', '30000')}</a:schemeClr><a:srgbClr val="FF0000"/>`,
  ),
  solid(`<a:prstClr val="red">${aMod('a:alpha', '40000')}</a:prstClr><a:sysClr val="window"/>`),
  solid(`<a:srgbClr val="FF0000"><a:alpha/></a:srgbClr>`),
  solid(
    `<a:srgbClr val="FF0000">${aMod('a:alpha', '10000')}${aMod('a:alpha', '20000')}</a:srgbClr>`,
  ),
  solid(''),
  ...MALFORMED,
]

const drawingTag = (inner: string, attrs = ''): string => `<w:drawing${attrs}>${inner}</w:drawing>`
const TXBX = (inner: string): string =>
  `<wps:txbx><w:txbxContent><w:p><w:r>${inner}</w:r></w:p></w:txbxContent></wps:txbx>`

const PARAGRAPHS: string[] = [
  '',
  '<w:p><w:r><w:t>no drawing</w:t></w:r></w:p>',
  `<w:p><w:r>${drawingTag('<wp:inline/>')}</w:r></w:p>`,
  `<w:p><w:r>${drawingTag('<wp:anchor/>', ' mc:MustUnderstand="wps"')}</w:r></w:p>`,
  `<w:p><w:r><w:drawing\n><wp:inline/></w:drawing></w:r></w:p>`,
  `<w:p><w:r><w:drawing\u3000><wp:inline/></w:drawing></w:r></w:p>`,
  `<w:p><w:r><w:drawing\uFEFF><wp:inline/></w:drawing></w:r></w:p>`,
  `<w:p><w:r><w:drawingX>x</w:drawing></w:r></w:p>`,
  `<w:p><w:r><w:drawings><w:drawing>a</w:drawing></w:drawings></w:r></w:p>`,
  `<w:p><w:r><w:drawing/><w:drawing>b</w:drawing></w:r></w:p>`,
  `<w:p>${drawingTag('one')}${drawingTag('two')}<w:r>${drawingTag('three')}</w:r></w:p>`,
  `<w:p>${drawingTag(`<wp:anchor>${TXBX(drawingTag('<wp:inline>nested</wp:inline>'))}</wp:anchor>`)}${drawingTag('after')}</w:p>`,
  `<w:p>${drawingTag(TXBX(drawingTag(TXBX(drawingTag('deep')))))}</w:p>`,
  `<w:p>${drawingTag(TXBX(drawingTag('a') + drawingTag('b')))}${drawingTag('c')}</w:p>`,
  `<w:p><w:drawing>unclosed</w:p>`,
  `<w:p>${drawingTag('ok')}<w:drawing>unclosed<w:drawing>inner</w:drawing></w:p>`,
  `<w:p><w:drawing>a</w:drawing></w:drawing></w:drawing>${drawingTag('b')}</w:p>`,
  `<w:p></w:drawing>${drawingTag('x')}</w:p>`,
  `<w:p><mc:AlternateContent><mc:Choice Requires="wps">${drawingTag('<wp:anchor>choice</wp:anchor>')}</mc:Choice><mc:Fallback><w:pict><v:shape/></w:pict></mc:Fallback></mc:AlternateContent></w:p>`,
  `<w:p><mc:AlternateContent><mc:Choice Requires="wps">${drawingTag('choice')}</mc:Choice><mc:Fallback>${drawingTag('fallback')}</mc:Fallback></mc:AlternateContent></w:p>`,
  `<w:p><mc:AlternateContent><mc:Choice Requires="wps">${drawingTag('only choice')}</mc:Choice></mc:AlternateContent></w:p>`,
  `<w:p><w:r><w:t>\u{1F600}\uAC00</w:t></w:r>${drawingTag('\uAC00\u{1F600}')}<w:t>\u{1F600}</w:t>${drawingTag('z')}</w:p>`,
  `\u{10000}<w:drawing>astral before</w:drawing>`,
  `<w:drawing>${'<w:drawing>'.repeat(30)}${'</w:drawing>'.repeat(31)}`,
  `<w:drawing>${'<w:drawing>'.repeat(5)}${'</w:drawing>'.repeat(4)}`,
]

/** Paragraphs whose drawings a literal search for the tags cuts wrongly: see calls-markup.ts. */
const MARKUP_PARAGRAPHS: string[] = [
  ...hiddenIn('<w:drawing>').map((hidden) => `<w:p>${hidden}${drawingTag('real')}</w:p>`),
  ...hiddenIn('</w:drawing>').map(
    (hidden) => `<w:p>${drawingTag(`a${hidden}b`)}${drawingTag('after')}</w:p>`,
  ),
  ...hiddenIn(drawingTag('fake')).map((hidden) => `<w:p>${hidden}</w:p>`),
  ...hiddenIn(drawingTag('fake')).map((hidden) => `<w:p>${hidden}${drawingTag('own')}</w:p>`),
  '<w:p><w:r><w:drawing><wp:inline/></w:drawing ></w:r></w:p>',
  '<w:p><w:r><w:drawing\t><wp:inline/></w:drawing\n></w:r></w:p>',
  '<w:p><w:r><w:drawing a=">"><wp:inline/></w:drawing></w:r></w:p>',
  `<w:p><w:r><w:drawing a='>' b="'>"><wp:inline/></w:drawing><w:drawing/></w:r></w:p>`,
  '<w:p><w:drawing a="x/>y"/><w:drawing>b</w:drawing></w:p>',
  `<w:p>${drawingTag(`<wp:anchor>${TXBX(drawingTag('inner').replace('</w:drawing>', '</w:drawing >'))}</wp:anchor>`)}${drawingTag('x')}</w:p>`,
  `<w:p>${drawingTag(`<wp:anchor>${TXBX(drawingTag('inner', ' a="<>"'))}</wp:anchor>`)}</w:p>`,
  '<w:p><w:drawing a="open></w:drawing></w:p>',
]

const GRAPHIC =
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp/></a:graphicData></a:graphic>'
const ANCHOR_ATTRS =
  ' distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"'
const anchor = (attrs: string, inner: string, graphic = GRAPHIC): string =>
  drawingTag(`<wp:anchor${attrs}>${inner}${graphic}</wp:anchor>`)
const pos = (dir: 'H' | 'V', rel: string, body: string): string =>
  `<wp:position${dir} relativeFrom="${rel}">${body}</wp:position${dir}>`
const off = (dir: 'H' | 'V', rel: string, value: string): string =>
  pos(dir, rel, `<wp:posOffset>${value}</wp:posOffset>`)
const EXTENT = '<wp:extent cx="1828800" cy="914400"/>'
const STD = `<wp:simplePos x="0" y="0"/>${off('H', 'column', '12700')}${off('V', 'paragraph', '-25400')}${EXTENT}`

/**
 * Anchors in spellings a literal search for the tags reads wrongly: markup
 * hidden in a comment, CDATA or an instruction, single-quoted attributes with
 * white space around `=`, spaced end tags, a `>` in an attribute value.
 */
const MARKUP_FRAGMENTS = (): string[] => [
  ...hiddenIn('<wp:wrapNone/>').map((hidden) =>
    anchor(ANCHOR_ATTRS, `${STD}${hidden}<wp:wrapSquare wrapText="bothSides"/>`),
  ),
  ...hiddenIn('<wp:extent cx="1" cy="2"/>').map((hidden) =>
    anchor(ANCHOR_ATTRS, `${hidden}${STD}`),
  ),
  ...hiddenIn('<wp:posOffset>9</wp:posOffset>').map((hidden) =>
    anchor('', `${pos('H', 'page', `${hidden}<wp:posOffset>7</wp:posOffset>`)}${EXTENT}`),
  ),
  ...hiddenIn('<wp:anchor behindDoc="1" distL="9">').map((hidden) => hidden + anchor('', STD)),
  anchor(" behindDoc = '1' distL = '5' distT='6'", `${STD}<wp:wrapSquare/>`),
  anchor(
    '',
    `<wp:positionH relativeFrom = 'page'><wp:posOffset>7</wp:posOffset></wp:positionH ><wp:positionV relativeFrom='margin'><wp:align>top</wp:align></wp:positionV >${"<wp:extent cx = '5' cy = '6' />"}`,
  ),
  anchor(
    '',
    `<wp:positionH relativeFrom="page" descr="a>b"><wp:posOffset>9</wp:posOffset></wp:positionH>${EXTENT}`,
  ),
  anchor(" layoutInCell = 'false'", STD),
  anchor(' descr="a>b" behindDoc="1"', `${STD}<wp:wrapNone/>`),
  anchor(" descr='a>b' behindDoc='1'", `${STD}<wp:wrapSquare/>`),
]

const FRAGMENTS: string[] = [
  '',
  drawingTag(`<wp:inline distT="0">${EXTENT}${GRAPHIC}</wp:inline>`),
  drawingTag('<wp:anchor>'),
  anchor(ANCHOR_ATTRS, `${STD}<wp:wrapSquare wrapText="bothSides"/>`),
  anchor(ANCHOR_ATTRS, `${STD}<wp:wrapNone/>`),
  anchor(ANCHOR_ATTRS, `${STD}<wp:wrapTight wrapText="bothSides"/>`),
  anchor(ANCHOR_ATTRS, `${STD}<wp:wrapThrough wrapText="bothSides"/>`),
  anchor(ANCHOR_ATTRS, `${STD}<wp:wrapTopAndBottom/>`),
  anchor(' behindDoc="1"', STD),
  anchor(' behindDoc="true"', `${STD}<wp:wrapSquare/>`),
  anchor(" behindDoc='1'", `${STD}<wp:wrapTopAndBottom/>`),
  anchor(
    ' behindDoc = "1"',
    STD,
    `<a:graphic>${drawingTag('<wp:anchor><wp:wrapSquare/></wp:anchor>')}</a:graphic>`,
  ),
  anchor(
    ' behindDoc="0"',
    STD,
    `<a:graphic>${drawingTag('<wp:anchor><wp:wrapNone/></wp:anchor>')}</a:graphic>`,
  ),
  anchor(' behindDoc="1"', STD, ''),
  anchor(' relativeHeight="251658240"', STD),
  anchor(' relativeHeight="251658241"', STD),
  anchor(' relativeHeight="0"', STD),
  anchor(' relativeHeight="0251658245"', STD),
  anchor(` relativeHeight="${'9'.repeat(400)}"`, STD),
  anchor(' relativeHeight="-5"', STD),
  anchor(' layoutInCell="0"', STD),
  anchor(" layoutInCell='false'", STD),
  anchor(' layoutInCell="1"', STD),
  anchor(` distL="0" distR='7' distT = "12" distB="x"`, STD),
  anchor(' xdistL="5" wp:distR="9"', STD),
  anchor(` distT="${'1'.repeat(400)}"`, STD),
  anchor(' descr="a>b" distL="5"', STD),
  anchor('', `${off('H', 'page', '+5')}${off('V', 'page', '1.5')}`),
  anchor('', `${off('H', 'page', `${'9'.repeat(400)}`)}${off('V', 'margin', '-0')}`),
  anchor(
    '',
    `<wp:positionH relativeFrom="page">\n  <wp:posOffset>100</wp:posOffset>\n</wp:positionH>`,
  ),
  anchor(
    '',
    `<wp:positionH relativeFrom="page"><wp:align>left</wp:align><wp:posOffset>5</wp:posOffset></wp:positionH>`,
  ),
  ...['page', 'margin', 'column', 'character', 'leftMargin', 'insideMargin', 'a-b'].map((rel) =>
    anchor(
      '',
      `${pos('H', rel, '<wp:align>center</wp:align>')}${pos('V', rel, '<wp:align>bottom</wp:align>')}${EXTENT}`,
    ),
  ),
  ...['left', 'right', 'inside', 'outside', 'top', ' center'].map((align) =>
    anchor(
      '',
      `${pos('H', 'margin', `<wp:align>${align}</wp:align>`)}${pos('V', 'page', `<wp:align>${align}</wp:align>`)}`,
    ),
  ),
  anchor(
    '',
    `${pos('H', 'page', '<wp14:pctPosHOffset>45000</wp14:pctPosHOffset>')}${pos('V', 'margin', '<wp14:pctPosVOffset x="1">-20000</wp14:pctPosVOffset>')}${EXTENT}`,
  ),
  anchor(
    '',
    `${pos('H', 'page', '<wp:align>right</wp:align><wp14:pctPosHOffset>abc</wp14:pctPosHOffset>')}${pos('V', 'page', '<wp14:pctPosVOffset>12</wp14:pctPosVOffset>')}`,
  ),
  anchor(
    '',
    `<wp:positionH relativeFrom='page'/><wp:positionV relativeFrom="page"></wp:positionV>${EXTENT}`,
  ),
  anchor(
    '',
    `<wp:positionH relativeFrom="page"/>${off('V', 'line', '7')}<wp:positionH>tail</wp:positionH>`,
  ),
  anchor('', `<wp:positionHX relativeFrom="page"><wp:align>left</wp:align></wp:positionHX>`),
  anchor('', `${off('H', 'page', '10')}`),
  anchor('', `${off('V', 'page', '10')}<wp:extent cx="5"/>`),
  anchor('', `<wp:extent cx="1" cy="2">x</wp:extent>`),
  anchor('', `<wp:extent cx='3' cy = "4"/><wp:effectExtent l="1" t="2" r="3" b="4"/>`),
  anchor('', `<wp:effectExtent l="1"/><wp:extent cy="9"/>`),
  anchor('', `<wp:extent xcx="1" cy="-2"/>`),
  drawingTag('<wp:anchorX distL="3"><wp:wrapNone/></wp:anchorX>'),
  anchor(' descr="\u{1F600}\uAC00"', `${off('H', 'page', '1')}${EXTENT}`),
  `<mc:AlternateContent><mc:Choice Requires="wps">${anchor(ANCHOR_ATTRS, STD)}</mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent>`,
  '<wp:anchor distL="1"',
  '<wp:anchor distL="1">',
  anchor(ANCHOR_ATTRS, STD).slice(0, 300),
]

const SECTIONS: string[] = [
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1134" w:bottom="1417" w:left="1800"/><w:cols w:num="2"/></w:sectPr>',
  '<w:sectPr><w:pgSz w:w="11907" w:h="16839"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0"/><w:cols w:num="0"/></w:sectPr>',
  '',
]

const H_RELS = ['page', 'margin', 'column', 'character', 'leftMargin']
const V_RELS = ['page', 'margin', 'topMargin', 'paragraph']

const H_METAS: DrawingAnchorMeta[] = [
  ...H_RELS.flatMap((relH): DrawingAnchorMeta[] => [
    { anchored: true, relH, alignH: 'left', extentXEmu: 914400 },
    { anchored: true, relH, alignH: 'center', extentXEmu: 914401 },
    { anchored: true, relH, alignH: 'right', extentXEmu: 914400 },
    { anchored: true, relH, alignH: 'outside' },
    { anchored: true, relH, alignH: 'inside', extentXEmu: 100 },
    { anchored: true, relH, pctH: 50000, extentXEmu: 914400 },
    { anchored: true, relH, pctH: -25000, alignH: 'right' },
    { anchored: true, relH },
  ]),
  { relH: 'page', alignH: 'center', extentXEmu: 20000001 },
  { relH: 'page', alignH: 'center', extentXEmu: 0.5 },
  { relH: 'page', pctH: 125 },
  { relH: 'page', pctH: -125 },
  { relH: 'margin', pctH: 0 },
  { relH: 'margin', pctH: 100000, extentXEmu: 1 },
  { relH: 'page', alignH: 'left', extentXEmu: 1143000 },
  { relH: 'page', alignH: 'right', extentXEmu: 1143000 },
  { relH: 'margin', alignH: 'left', extentXEmu: -100 },
  { relH: 'column', alignH: 'right', pctH: 10000 },
  { alignH: 'left', extentXEmu: 5 },
]

const V_METAS: DrawingAnchorMeta[] = [
  ...V_RELS.flatMap((relV): DrawingAnchorMeta[] => [
    { relV, alignV: 'top', extentYEmu: 914400 },
    { relV, alignV: 'center', extentYEmu: 914401 },
    { relV, alignV: 'bottom', extentYEmu: 914400 },
    { relV, alignV: 'outside' },
    { relV, alignV: 'inside', extentYEmu: 3 },
    { relV, pctV: 30000, extentYEmu: 914400 },
    { relV, pctV: -10000, alignV: 'bottom' },
    { relV },
  ]),
  { relV: 'page', alignV: 'center', extentYEmu: 0.5 },
  { relV: 'page', alignV: 'center', extentYEmu: 30000001 },
  { relV: 'margin', pctV: 100000 },
  { relV: 'margin', pctV: 1 },
  { alignV: 'top', pctV: 5 },
]

const METAS: DrawingAnchorMeta[] = [
  {},
  { anchored: true, offsetXEmu: 100, offsetYEmu: 200 },
  ...H_METAS,
  ...V_METAS,
  ...H_METAS.map((meta, at) => ({ ...meta, ...V_METAS[at % V_METAS.length] })),
]

const RESOLVE_INPUTS: Input[] = METAS.flatMap((meta) => [
  ...SECTIONS.map((text) => ({ text, args: { meta } })),
  { text: SECTIONS[0], args: { meta, noSection: true } },
])

const xfrm = (inner: string): string => `<wpg:grpSpPr><a:xfrm>${inner}</a:xfrm></wpg:grpSpPr>`
const XFRM_FULL =
  '<a:off x="100" y="200"/><a:ext cx="1000" cy="2000"/><a:chOff x="10" y="20"/><a:chExt cx="500" cy="1000"/>'

const GROUPS: Array<[string, string]> = [
  ['wpg:wgp', '<wpg:wgp><wpg:cNvGrpSpPr/></wpg:wgp>'],
  ['wpg:wgp', '<wpg:wgp><wpg:grpSpPr/></wpg:wgp>'],
  ['wpg:wgp', `<wpg:wgp>${xfrm(XFRM_FULL)}</wpg:wgp>`],
  ['wpg:grpSp', `<wpg:grpSp>${xfrm(XFRM_FULL)}</wpg:grpSp>`],
  [
    'wpg:wgp',
    `<wpg:wgp>${xfrm('<a:off x="5" y="6"/><a:ext cx="1000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>')}</wpg:wgp>`,
  ],
  [
    'wpg:wgp',
    `<wpg:wgp>${xfrm('<a:off x="5" y="6"/><a:ext cx="0" cy="-10"/><a:chOff x="3" y="4"/><a:chExt cx="10" cy="10"/>')}</wpg:wgp>`,
  ],
  [
    'wpg:wgp',
    `<wpg:wgp>${xfrm('<a:off x="5" y="6"/><a:ext cx="100" cy="100"/><a:chOff x="3" y="4"/><a:chExt cx="-10" cy="3"/>')}</wpg:wgp>`,
  ],
  [
    'wpg:wgp',
    `<wpg:wgp>${xfrm('<a:ext cx="300" cy="200"/><a:chExt cx="600" cy="800"/>')}</wpg:wgp>`,
  ],
  ['wpg:wgp', `<wpg:wgp>${xfrm('')}</wpg:wgp>`],
  [
    'wpg:wgp',
    `<wpg:wgp>${xfrm('<a:off x="abc" y=" 7"/><a:ext cx="1.5" cy="2e3"/><a:chOff x="-0" y=""/><a:chExt cx="3" cy="+4"/>')}</wpg:wgp>`,
  ],
  [
    'wpg:wgp',
    `<wpg:wgp>${xfrm(`<a:off x="${'9'.repeat(400)}" y="${'9'.repeat(308)}"/><a:ext cx="${'9'.repeat(308)}" cy="1"/><a:chOff/><a:chExt cx="1" cy="1"/>`)}</wpg:wgp>`,
  ],
  ['wpg:wgp', `<wpg:wgp><wpg:grpSp>${xfrm(XFRM_FULL)}</wpg:grpSp></wpg:wgp>`],
  ['wpg:wgp', `<wpg:wgp><wpg:grpSpPr/>${xfrm(XFRM_FULL)}</wpg:wgp>`],
  ['wpg:wgp', `<wpg:wgp>${xfrm('<a:off x="1" y="1"/><a:off x="2" y="2"/>')}</wpg:wgp>`],
  ['wpg:wgp', '<wpg:grpSp/>'],
  ['wpg:wgp', `<wpg:wgp>${xfrm(XFRM_FULL)}`],
  ['wpg:wgp', '<wpg:wgp><wpg:grpSpPr></wpg:wgp>'],
]

const OUTERS: GroupCtm[] = [
  IDENTITY_CTM,
  { sx: 0.5, sy: 2, tx: 914400, ty: -12700 },
  { sx: 0, sy: -1, tx: 0.25, ty: 3 },
]

const w14Color = (kind: 'srgbClr' | 'schemeClr', val: string, mods = ''): string =>
  `<w14:${kind} w14:val="${val}">${mods}</w14:${kind}>`
const w14Mod = (name: string, val: string): string => `<w14:${name} w14:val="${val}"/>`
const textFill = (inner: string): string => `<w:rPr><w14:textFill>${inner}</w14:textFill></w:rPr>`
const w14Solid = (inner: string): string => textFill(`<w14:solidFill>${inner}</w14:solidFill>`)
const w14Grad = (stops: string): string =>
  textFill(
    `<w14:gradFill><w14:gsLst>${stops}</w14:gsLst><w14:lin w14:ang="0" w14:scaled="0"/></w14:gradFill>`,
  )
const w14Gs = (position: string, color: string): string =>
  `<w14:gs w14:pos="${position}">${color}</w14:gs>`

const W14_MODS = ['lumMod', 'lumOff', 'shade', 'tint', 'satMod', 'alpha']
const W14_PCTS = ['0', '-0', '50000', '100000', '150000', '-1', 'abc', '']
const SAT_BASES = [
  '808080',
  'FF0000',
  '00FF00',
  '0000FF',
  'FF0080',
  '336699',
  'CCDDEE',
  '000000',
  'FFFFFF',
]

const TEXT_FILLS: string[] = [
  '<w:rPr><w:b/></w:rPr>',
  '<w:rPr/>',
  ...['FF0000', ' 12abEF ', 'xyz', '', '1234567'].map((val) => w14Solid(w14Color('srgbClr', val))),
  w14Solid('<w14:srgbClr/>'),
  ...SCHEME_VALS.map((val) => w14Solid(w14Color('schemeClr', val))),
  ...W14_MODS.flatMap((name) =>
    W14_PCTS.map((val) => w14Solid(w14Color('schemeClr', 'accent1', w14Mod(name, val)))),
  ),
  ...SAT_BASES.flatMap((base) =>
    ['50000', '120000', '300000'].map((val) =>
      w14Solid(w14Color('srgbClr', base, w14Mod('satMod', val))),
    ),
  ),
  w14Solid(
    w14Color(
      'srgbClr',
      '4472C4',
      w14Mod('lumMod', '75000') + w14Mod('lumOff', '25000') + w14Mod('satMod', '150000'),
    ),
  ),
  w14Solid(w14Color('schemeClr', 'tx2', w14Mod('tint', '66000') + w14Mod('shade', '50000'))),
  w14Solid(w14Color('srgbClr', 'FF0000') + w14Color('schemeClr', 'accent2')),
  w14Solid(w14Color('schemeClr', 'accent2') + w14Color('srgbClr', 'FF0000')),
  w14Solid(''),
  textFill(
    `<w14:solidFill/><w14:gradFill><w14:gsLst>${w14Gs('0', w14Color('srgbClr', 'FF0000'))}</w14:gsLst></w14:gradFill>`,
  ),
  textFill('<w14:noFill/>'),
  textFill('<w14:gradFill/>'),
  w14Grad(''),
  w14Grad(w14Gs('0', w14Color('srgbClr', 'FF0000'))),
  w14Grad(
    w14Gs('0', w14Color('srgbClr', 'FFFFFF')) + w14Gs('100000', w14Color('srgbClr', '000000')),
  ),
  w14Grad(
    w14Gs('100000', w14Color('srgbClr', '010101')) + w14Gs('0', w14Color('srgbClr', '000000')),
  ),
  w14Grad(
    w14Gs('50000', w14Color('schemeClr', 'accent1', w14Mod('lumMod', '60000'))) +
      w14Gs('50000', w14Color('srgbClr', 'nope')) +
      w14Gs('0', w14Color('schemeClr', 'phClr')) +
      '<w14:other/>' +
      w14Gs('100000', w14Color('schemeClr', 'bg1', w14Mod('satMod', '200000'))),
  ),
  w14Grad(w14Gs('0', w14Color('srgbClr', 'nope')) + w14Gs('1', '')),
  '<w:rPr><w14:textFill><w14:solidFill><w14:srgbClr w14:val="FF0000"></w14:solidFill></w14:textFill></w:rPr>',
  '<w:rPr><w14:textFill>',
  '',
]

const glow = (rad: string | undefined, inner: string): string =>
  `<w:rPr><w14:glow${rad === undefined ? '' : ` w14:rad="${rad}"`}>${inner}</w14:glow></w:rPr>`

const GLOWS: string[] = [
  '<w:rPr><w:b/></w:rPr>',
  ...['63500', '0', '-5', 'abc', '', '1', '127', '6350', '1e5', '25400.7', ' 101600', '-0'].map(
    (rad) => glow(rad, w14Color('srgbClr', 'FF0000', w14Mod('alpha', '60000'))),
  ),
  glow(undefined, w14Color('srgbClr', 'FF0000')),
  ...['100000', '99999', '0', '-0', '-1', 'x', ''].map((alpha) =>
    glow(
      '38100',
      w14Color('schemeClr', 'accent2', w14Mod('satMod', '175000') + w14Mod('alpha', alpha)),
    ),
  ),
  glow(
    '38100',
    w14Color('schemeClr', 'accent2', w14Mod('alpha', '40000')) + w14Color('srgbClr', '00FF00'),
  ),
  glow('38100', w14Color('srgbClr', 'nope', w14Mod('alpha', '40000'))),
  glow('38100', w14Color('schemeClr', '__proto__')),
  glow('38100', ''),
  glow(
    '38100',
    w14Color('schemeClr', 'hlink', w14Mod('lumMod', '50000') + w14Mod('lumOff', '50000')),
  ),
  '<w:rPr><w14:glow w14:rad="1"><w14:srgbClr w14:val="FF0000"></w14:glow></w:rPr>',
  '',
]

const gradSpPr = (stops: string, extra = ''): string =>
  `<wps:spPr>${extra}<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></wps:spPr>`
const gs = (position: string, color: string): string => `<a:gs pos="${position}">${color}</a:gs>`

const GRAD_SP_PRS: string[] = [
  '<wps:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></wps:spPr>',
  '<wps:spPr><a:gradFill/></wps:spPr>',
  gradSpPr(''),
  gradSpPr(gs('0', '<a:srgbClr val="4472C4"/>')),
  gradSpPr(gs('0', '<a:srgbClr val="FFFFFF"/>') + gs('100000', '<a:srgbClr val="000000"/>')),
  gradSpPr(gs('0', '<a:srgbClr val="FFFFFF"/>') + gs('100000', '<a:schemeClr val="accent1"/>')),
  gradSpPr(
    gs(
      '100000',
      '<a:schemeClr val="accent1"><a:shade val="30000"/><a:satMod val="115000"/></a:schemeClr>',
    ) +
      gs(
        '0',
        '<a:schemeClr val="accent1"><a:tint val="66000"/><a:satMod val="160000"/></a:schemeClr>',
      ) +
      gs('50000', '<a:schemeClr val="accent1"><a:tint val="44500"/></a:schemeClr>') +
      gs('50000', '<a:prstClr val="red"/>') +
      gs('20000', '<a:sysClr val="window" lastClr="FEFEFE"/>'),
  ),
  gradSpPr(gs('0', '<a:schemeClr val="phClr"/>') + gs('1', '<a:srgbClr val="xyz"/>')),
  gradSpPr(gs('0', '<a:schemeClr val="phClr"/>') + gs('1', '<a:srgbClr val="010101"/>')),
  gradSpPr(
    `<a:other/>${gs('0', '<a:srgbClr val="808080"/>')}text${gs('1', '<a:srgbClr val="818181"/>')}`,
  ),
  gradSpPr(
    gs('0', '<a:srgbClr val="FF0000"/>'),
    '<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>',
  ),
  `<wps:spPr><a:gradFill><a:gsLst>${gs('0', '<a:srgbClr val="FF0000"/>')}</a:gsLst></a:gradFill><a:gradFill><a:gsLst>${gs('0', '<a:srgbClr val="0000FF"/>')}</a:gsLst></a:gradFill></wps:spPr>`,
  gradSpPr(
    gs('0', '<a:schemeClr val="dk1"><a:lumMod val="50000"/></a:schemeClr>') +
      gs('1', '<a:schemeClr val="lt1"/>'),
  ),
  gradSpPr(gs('0', '<a:schemeClr val="accent2"><a:lumOff val="150000"/></a:schemeClr>')),
  '<wps:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gsLst></a:gradFill></wps:spPr>',
  '<wps:spPr><a:gradFill>',
  '',
]

const WSP_STYLE_LN_REF = (inner: string): string =>
  `<wps:style><a:lnRef idx="1">${inner}</a:lnRef></wps:style>`

/** A wps:wsp line shape: `xfrm` and `ln` are inner XML of a:xfrm and the whole a:ln. */
const lineShape = (
  prst: string | undefined,
  { xfrm, ln, style }: { xfrm?: string; ln?: string; style?: string } = {},
): string =>
  `<wps:wsp><wps:cNvCnPr/><wps:spPr>${xfrm ?? ''}${
    prst === undefined ? '' : `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`
  }${ln ?? ''}</wps:spPr>${style ?? ''}<wps:bodyPr/></wps:wsp>`

const xfrmOf = (attrs: string, cx?: string, cy?: string): string =>
  `<a:xfrm${attrs}><a:off x="0" y="0"/>${
    cx === undefined && cy === undefined
      ? ''
      : `<a:ext${cx === undefined ? '' : ` cx="${cx}"`}${cy === undefined ? '' : ` cy="${cy}"`}/>`
  }</a:xfrm>`

const lnOf = (attrs: string, inner = ''): string => `<a:ln${attrs}>${inner}</a:ln>`
const srgbLn = (val: string): string => solid(`<a:srgbClr val="${val}"/>`)
const ends = (head?: string, tail?: string): string =>
  (head === undefined ? '' : `<a:headEnd type="${head}"/>`) +
  (tail === undefined ? '' : `<a:tailEnd type="${tail}"/>`)

const ARROW_TYPES: Array<string | undefined> = [undefined, 'none', '', 'triangle', 'arrow']

/** Line shapes for every branch of lineBoxOf, each called under every theme of THEMES. */
const LINE_SHAPES: string[] = [
  '<wps:wsp><wps:bodyPr/></wps:wsp>',
  '<wps:wsp><wps:spPr/></wps:wsp>',
  '<wps:wsp><wps:spPr><a:prstGeom/></wps:spPr></wps:wsp>',
  ...['', 'rect', 'Line', 'bentConnector5', 'curvedConnector', '__proto__', ' line'].map((prst) =>
    lineShape(prst),
  ),
  // every preset, bare and with a slanted extent and both flips
  ...[...LINE_PRSTS].flatMap((prst) => [
    lineShape(prst),
    lineShape(prst, {
      xfrm: xfrmOf(' flipH="1" flipV="1"', '952500', '476250'),
      ln: lnOf(' w="12700"', srgbLn('FF0000') + ends('triangle', undefined)),
    }),
  ]),
  // the colour of the stroke: literal, empty, non-ASCII, scheme in the fill, theme lnRef
  ...['4472C4', '', 'zz', '\u00e9\u00e8', 'ff00ff'].map((val) =>
    lineShape('line', { ln: lnOf('', srgbLn(val)) }),
  ),
  lineShape('line', { ln: lnOf('', '<a:solidFill/>') }),
  lineShape('line', { ln: lnOf('', '<a:solidFill><a:srgbClr/></a:solidFill>') }),
  lineShape('line', {
    ln: lnOf('', solid('<a:schemeClr val="accent2"/>')),
    style: WSP_STYLE_LN_REF('<a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr>'),
  }),
  lineShape('line', { ln: lnOf('', '<a:noFill/>') }),
  ...[
    '<a:schemeClr val="accent1"/>',
    '<a:schemeClr val="tx1"/>',
    '<a:schemeClr val="accent2"/>',
    '<a:schemeClr val="phClr"/>',
    '<a:srgbClr val="00FF00"/>',
    '<a:srgbClr val="nope"/>',
    '<a:prstClr val="blue"/>',
    '<a:sysClr val="windowText"/>',
    '',
  ].flatMap((inner) => [
    lineShape('straightConnector1', { style: WSP_STYLE_LN_REF(inner) }),
    lineShape('straightConnector1', { ln: lnOf(' w="9525"'), style: WSP_STYLE_LN_REF(inner) }),
  ]),
  lineShape('line', {
    ln: lnOf('', srgbLn('123456')),
    style: WSP_STYLE_LN_REF('<a:schemeClr val="accent1"/>'),
  }),
  lineShape('line', {
    style: '<wps:style><a:fillRef idx="1"><a:srgbClr val="00FF00"/></a:fillRef></wps:style>',
  }),
  // the arrow ends, alone, on each preset kind, and an end without its a:ln
  ...ARROW_TYPES.flatMap((head) =>
    ARROW_TYPES.map((tail) =>
      lineShape('straightConnector1', {
        xfrm: xfrmOf('', '952500', '0'),
        ln: lnOf(' w="19050"', ends(head, tail)),
      }),
    ),
  ),
  lineShape('bentConnector3', { ln: lnOf('', ends('triangle', undefined)) }),
  lineShape('curvedConnector3', { ln: lnOf('', ends(undefined, 'triangle')) }),
  `<wps:wsp><wps:spPr><a:prstGeom prst="line"/>${ends('triangle', 'triangle')}</wps:spPr></wps:wsp>`,
  // head-only arrows reverse the flips they had
  ...['', ' flipH="1"', ' flipV="1"', ' flipH="1" flipV="1"'].flatMap((flips) =>
    ['0', '76200', '114300', '123825'].map((cy) =>
      lineShape('line', {
        xfrm: xfrmOf(flips, '952500', cy),
        ln: lnOf('', ends('triangle', 'none')),
      }),
    ),
  ),
  lineShape('line', {
    xfrm: xfrmOf(' flipH="1"', '952500', '0'),
    ln: lnOf('', ends(undefined, 'stealth')),
  }),
  // extents: missing, zero, negative, fractional, not a number, the 12 px boundary
  lineShape('line', { xfrm: '<a:xfrm/>' }),
  lineShape('line', { xfrm: xfrmOf('') }),
  lineShape('line', { xfrm: xfrmOf('', '952500') }),
  lineShape('line', { xfrm: xfrmOf('', undefined, '114300') }),
  ...[
    ['0', '0'],
    ['-9525', '-9525'],
    ['4762', '4762'],
    ['4763', '4763'],
    ['14287.9', '14288'],
    ['abc', ''],
    [' 9525', '1e5'],
    ['952500', '114300'],
    ['952500', '114301'],
    ['952500', '119062'],
    ['952500', '119063'],
    ['952500', '123825'],
    ['1', '1'],
  ].flatMap(([cx, cy]) =>
    ['line', 'bentConnector2'].map((prst) => lineShape(prst, { xfrm: xfrmOf('', cx, cy) })),
  ),
  // flips: each spelling, on straight and on bent presets, at a low height
  ...[
    'flipH="1"',
    'flipH="true"',
    'flipH="0"',
    'flipH="True"',
    'flipV="1"',
    'flipV="true"',
    'flipV="false"',
  ].flatMap((flip) =>
    ['line', 'curvedConnector4'].map((prst) =>
      lineShape(prst, { xfrm: xfrmOf(` ${flip}`, '952500', '9525') }),
    ),
  ),
  // rotation in 60000ths of a degree
  ...[
    '5400000',
    '-30000',
    '30000',
    '29999',
    '-90000',
    '0',
    '-0',
    'abc',
    '',
    '5400000.7',
    '21599999',
  ].map((rot) => lineShape('line', { xfrm: xfrmOf(` rot="${rot}"`, '952500', '0') })),
  // a:ln widths in EMU
  ...['12700', '9525', '0', '-1', '1', '95', '96', 'abc', '', '6350.7', '28575', '1e3'].map((w) =>
    lineShape('line', { ln: lnOf(` w="${w}"`) }),
  ),
  lineShape('line', { ln: '<a:ln/>' }),
  '<wps:wsp><wps:spPr><a:prstGeom prst="line"></wps:spPr></wps:wsp>',
  '',
]

const constantsSpec: CallSpec = {
  fn: 'drawing.constants',
  call: (_text, args) => {
    const name = String(args.name)
    if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
    return CONSTANTS[name]
  },
  built: [...Object.keys(CONSTANTS), 'nothing', '__proto__'].map((name) => ({ args: { name } })),
  mutation: 'none',
}

export const DRAWING: CallSpec[] = [
  constantsSpec,
  {
    fn: 'drawing.colorNodeHex',
    call: (text, args) => colorNodeHex(nodeOf(text, args), themeArg(args)),
    fromDocument: (parts) =>
      nodeInputs(
        parts,
        fragmentsOf(parts, ['a:solidFill', 'a:fillRef', 'a:lnRef', 'a:fontRef', 'a:gs']),
        true,
      ),
    built: [
      ...withThemes('a:solidFill', COLOR_NODES),
      ...withThemes('a:gs', [
        gs('0', '<a:schemeClr val="accent4"><a:lumMod val="40000"/></a:schemeClr>'),
      ]),
      ...withThemes('a:fillRef', ['<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>']),
      { text: solid('<a:srgbClr val="FF0000"/>'), args: { node: 'a:gs' } },
      { text: solid('<a:srgbClr val="FF0000"/>') },
      { text: solid('<a:schemeClr val="accent1"/>'), args: { node: 'a:solidFill', theme: null } },
    ],
  },
  {
    fn: 'drawing.solidFillAlpha',
    call: (text, args) => solidFillAlpha(nodeOf(text, args)),
    fromDocument: (parts) => nodeInputs(parts, fragmentsOf(parts, ['a:solidFill']), false),
    built: [
      ...ALPHA_FILLS.map((text) => ({ text, args: { node: 'a:solidFill' } })),
      {
        text: solid('<a:srgbClr val="FF0000"><a:alpha val="5"/></a:srgbClr>'),
        args: { node: 'a:x' },
      },
    ],
  },
  {
    fn: 'drawing.topLevelDrawings',
    call: (text) => topLevelDrawings(text),
    fromDocument: (parts) => drawingParagraphsOf(parts).map((text) => ({ text })),
    built: [...PARAGRAPHS, ...MARKUP_PARAGRAPHS].map((text) => ({ text })),
  },
  {
    fn: 'drawing.drawingAnchorMeta',
    call: (text) => drawingAnchorMeta(text),
    fromDocument: (parts) => drawingFragmentsOf(parts).map((text) => ({ text })),
    built: [...FRAGMENTS, ...MARKUP_FRAGMENTS()].map((text) => ({ text })),
  },
  {
    fn: 'drawing.resolveAnchorPagePos',
    call: (text, args) =>
      resolveAnchorPagePos(args.meta as DrawingAnchorMeta, sectionOf(text, args)),
    fromDocument: anchorInputs,
    built: RESOLVE_INPUTS,
  },
  {
    fn: 'drawing.resolveAnchorPageYEmu',
    call: (text, args) =>
      resolveAnchorPageYEmu(args.meta as DrawingAnchorMeta, sectionOf(text, args)),
    fromDocument: anchorInputs,
    built: RESOLVE_INPUTS,
  },
  {
    fn: 'drawing.gradFillApproxHex',
    call: (text, args) => gradFillApproxHex(elementOf(text, args), themeArg(args)),
    fromDocument: (parts) =>
      nodeInputs(
        parts,
        [
          ...fragmentsOf(parts, ['wps:spPr', 'pic:spPr', 'wpg:grpSpPr'], (f) =>
            f.includes('<a:gradFill'),
          ),
          ...fragmentsOf(parts, ['wps:spPr'], (f) => !f.includes('<a:gradFill'), 3),
        ],
        true,
      ),
    built: [
      ...withThemes('wps:spPr', GRAD_SP_PRS),
      { text: GRAD_SP_PRS[4], args: { node: 'pic:spPr' } },
    ],
  },
  {
    fn: 'drawing.w14TextFillHex',
    call: (text, args) => w14TextFillHex(elementOf(text, args), themeArg(args)),
    fromDocument: (parts) =>
      nodeInputs(
        parts,
        [
          ...fragmentsOf(parts, ['w:rPr'], (f) => f.includes('<w14:textFill')),
          ...fragmentsOf(parts, ['w:rPr'], (f) => !f.includes('<w14:textFill'), 3),
        ],
        true,
      ),
    built: withThemes('w:rPr', TEXT_FILLS),
  },
  {
    fn: 'drawing.w14GlowOf',
    call: (text, args) => w14GlowOf(elementOf(text, args), themeArg(args)),
    fromDocument: (parts) =>
      nodeInputs(
        parts,
        [
          ...fragmentsOf(parts, ['w:rPr'], (f) => f.includes('<w14:glow')),
          ...fragmentsOf(parts, ['w:rPr'], (f) => !f.includes('<w14:glow'), 3),
        ],
        true,
      ),
    built: withThemes('w:rPr', GLOWS),
  },
  {
    fn: 'drawing.composeGroupCtm',
    call: (text, args) => composeGroupCtm(elementOf(text, args), args.outer as GroupCtm),
    fromDocument: (parts) =>
      fragmentsOf(parts, ['wpg:wgp', 'wpg:grpSp']).flatMap(([node, text]) =>
        OUTERS.slice(0, 2).map((outer) => ({ text, args: { node, outer } })),
      ),
    built: GROUPS.flatMap(([node, text]) =>
      OUTERS.map((outer) => ({ text, args: { node, outer } })),
    ),
  },
  {
    fn: 'drawing.lineBoxOf',
    call: (text, args) => lineBoxOf(elementOf(text, args), themeArg(args)),
    fromDocument: (parts) =>
      nodeInputs(
        parts,
        [
          ...fragmentsOf(parts, ['wps:wsp'], (f) => LINE_PRSTS_RE.test(f)),
          ...fragmentsOf(parts, ['wps:wsp'], (f) => !LINE_PRSTS_RE.test(f), 3),
        ],
        true,
      ),
    built: [
      ...withThemes('wps:wsp', LINE_SHAPES),
      { text: lineShape('line'), args: { node: 'wps:spPr' } },
      { text: lineShape('line') },
      {
        text: lineShape('line', { style: WSP_STYLE_LN_REF('<a:schemeClr val="accent1"/>') }),
        args: { node: 'wps:wsp', theme: null },
      },
    ],
  },
]
