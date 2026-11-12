// Group `placeholder` of comparison (f): placeholder.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_placeholder.rs to
// `pptxPlaceholder.placeholder.<TypeScript name>`.
import { xmlParser } from './reference/xml-parser'
import { resolveColorNode } from './reference/color'
import {
  type LstStyleSource,
  MAX_AUTO_NUM_START,
  type MasterTextStyles,
  mergeTextStyleChain,
  parseDefaultTextStyle,
  parseDefRPrStyle,
  parseLstStyleLevels,
  parseMasterTextStyles,
  parsePlaceholderMap,
  type PlaceholderMap,
  placeholderStyleChain,
  resolvePlaceholderAnchor,
  resolvePlaceholderAnchorCtr,
  resolvePlaceholderFillSpPr,
  resolvePlaceholderInsets,
  resolvePlaceholderPresetGeom,
  resolvePlaceholderTransform,
  type TextStyleLevels,
} from './reference/placeholder'
import { parseClrMap, parseTheme, type Theme } from './reference/theme'
import { xmlArray } from './reference/xml-utils'
import { relsPathFor, resolveTarget } from './reference/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

type Args = Record<string, unknown>
type Parts = ReadonlyMap<string, string>
type Node = Record<string, unknown>

/** A value as it reaches Rust: keys that hold undefined are gone, NaN is null. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * The parser of tools/pptx-diff/reference/parse.ts, which parses the
 * `a:lstStyle` and `a:defRPr` nodes parse.ts hands to placeholder.ts. The
 * Rust dispatch holds the same list.
 */
const parseTsParser = xmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  isArray: (name) =>
    [
      'a:p',
      'a:r',
      'a:br',
      'a:fld',
      'p:sp',
      'p:pic',
      'p:graphicFrame',
      'p:grpSp',
      'p:cxnSp',
      'a:tr',
      'a:tc',
      'a:gridCol',
    ].includes(name),
})

/** `phParser` of placeholder.ts: the parser of layouts, masters and txStyles. */
const phParser = xmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['p:sp', 'p:graphicFrame', 'p:pic'].includes(name),
})

/** The node `args.name` of `text`, parsed as `args.parser` names. */
const nodeOf = (text: string, args: Args): unknown =>
  ((args.parser === 'placeholder' ? phParser : parseTsParser).parse(text) as Node)[
    args.name as string
  ]

/** `args[key]`, a list of `[rId, path]` pairs, as the Map the engine holds. */
const mediaOf = (pairs: unknown): Map<string, string> | undefined =>
  pairs == null ? undefined : new Map(pairs as Array<[string, string]>)

interface Layers {
  layout?: PlaceholderMap
  master?: PlaceholderMap
  masterTx?: MasterTextStyles
  type?: string
  idx?: string
}

/**
 * The layers of a slide placeholder as index.ts reads them: the maps of the
 * layout (`text`) and the master (`args.masterXml`), or of the master
 * (`text`, `args.textIs` 'master') and `args.layoutXml`.
 */
function layersOf(text: string, args: Args): Layers {
  const theme = args.theme as Theme | undefined
  const masterText = args.textIs === 'master'
  const layoutXml = masterText ? (args.layoutXml as string | undefined) : text
  const masterXml = masterText ? text : (args.masterXml as string | undefined)
  const layoutMedia = mediaOf(args.layoutMediaRels)
  const masterMedia = mediaOf(args.masterMediaRels)
  return {
    layout:
      layoutXml === undefined ? undefined : parsePlaceholderMap(layoutXml, theme, layoutMedia),
    master:
      masterXml === undefined ? undefined : parsePlaceholderMap(masterXml, theme, masterMedia),
    masterTx:
      masterXml === undefined || args.noTx === true
        ? undefined
        : parseMasterTextStyles(masterXml, theme, masterMedia),
    type: args.type as string | undefined,
    idx: args.idx as string | undefined,
  }
}

const withTheme = (theme: Theme | undefined): Args => (theme === undefined ? {} : { theme })

// ── Built parts ───────────────────────────────────────────────────────

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const BIG = '9'.repeat(400)

const srgb = (val: string): string => `<a:srgbClr val="${val}"/>`
const scheme = (val: string): string => `<a:schemeClr val="${val}"/>`
const solid = (color: string): string => `<a:solidFill>${color}</a:solidFill>`

const JPAN = '\u6E38\u30B4\u30B7\u30C3\u30AF'
const HANG = '\uB9D1\uC740 \uACE0\uB515'
const HANS = '\u7B49\u7EBF'
const HANT = '\u65B0\u7D30\u660E\u9AD4'

const fontSet = (latin: string, ea: string): string =>
  `<a:latin typeface="${latin}"/><a:ea typeface="${ea}"/><a:cs typeface=""/>` +
  `<a:font script="Jpan" typeface="${JPAN}"/><a:font script="Hang" typeface="${HANG}"/>` +
  `<a:font script="Hans" typeface="${HANS}"/><a:font script="Hant" typeface="${HANT}"/>`

const themeXml = (majorEa: string, minorEa: string): string =>
  DECL +
  `<a:theme ${A_NS} name="Office Theme"><a:themeElements>` +
  '<a:clrScheme name="Office">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  `<a:dk2>${srgb('44546A')}</a:dk2><a:lt2>${srgb('E7E6E6')}</a:lt2>` +
  `<a:accent1>${srgb('4472C4')}</a:accent1><a:accent2>${srgb('ED7D31')}</a:accent2>` +
  `<a:accent3>${srgb('A5A5A5')}</a:accent3><a:accent4>${srgb('FFC000')}</a:accent4>` +
  `<a:accent5>${srgb('5B9BD5')}</a:accent5><a:accent6>${srgb('70AD47')}</a:accent6>` +
  `<a:hlink>${srgb('0563C1')}</a:hlink><a:folHlink>${srgb('954F72')}</a:folHlink>` +
  '</a:clrScheme>' +
  `<a:fontScheme name="Office"><a:majorFont>${fontSet('Calibri Light', majorEa)}</a:majorFont>` +
  `<a:minorFont>${fontSet('Calibri', minorEa)}</a:minorFont></a:fontScheme>` +
  '</a:themeElements></a:theme>'

/** Themes as the callers hold them, each the JSON of what the real parseTheme gave. */
const T_FULL = wire(parseTheme(themeXml('', '')))
const T_EA = wire(parseTheme(themeXml('MS Gothic', 'Meiryo')))
const T_DARK = wire({
  ...T_FULL,
  clrMap: parseClrMap(
    `<p:sldMaster ${A_NS} ${P_NS}><p:cSld/><p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent2" accent2="accent1" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`,
  ),
})

interface ShapeSpec {
  ph?: string
  xfrm?: string
  spPr?: string
  bodyPr?: string
  lst?: string
  kind?: 'sp' | 'frame' | 'pic'
}

const ph = (type?: string, idx?: string): string =>
  `<p:ph${type === undefined ? '' : ` type="${type}"`}${idx === undefined ? '' : ` idx="${idx}"`}/>`

const xfrm = (x = '10', y = '20', cx = '300', cy = '400', attrs = ''): string =>
  `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

function shape(s: ShapeSpec): string {
  const nvPr = `<p:nvPr>${s.ph ?? ''}</p:nvPr>`
  if (s.kind === 'frame') {
    const frameXfrm = s.xfrm === undefined ? '' : s.xfrm.split('a:xfrm').join('p:xfrm')
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="f"/><p:cNvGraphicFramePr/>${nvPr}</p:nvGraphicFramePr>${frameXfrm}<a:graphic/></p:graphicFrame>`
  }
  if (s.kind === 'pic') {
    return `<p:pic><p:nvPicPr><p:cNvPr id="5" name="p"/><p:cNvPicPr/>${nvPr}</p:nvPicPr><p:blipFill/><p:spPr>${s.xfrm ?? ''}${s.spPr ?? ''}</p:spPr></p:pic>`
  }
  const txBody =
    s.bodyPr === undefined && s.lst === undefined
      ? ''
      : `<p:txBody>${s.bodyPr ?? '<a:bodyPr/>'}${s.lst ?? ''}<a:p/></p:txBody>`
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/>${nvPr}</p:nvSpPr><p:spPr>${s.xfrm ?? ''}${s.spPr ?? ''}</p:spPr>${txBody}</p:sp>`
}

const spTree = (shapes: ShapeSpec[]): string =>
  '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
  shapes.map(shape).join('') +
  '</p:spTree></p:cSld>'

const layoutOf = (shapes: ShapeSpec[]): string =>
  `${DECL}<p:sldLayout ${A_NS} ${R_NS} ${P_NS}>${spTree(shapes)}</p:sldLayout>`

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

const masterOf = (shapes: ShapeSpec[], txStyles = ''): string =>
  `${DECL}<p:sldMaster ${A_NS} ${R_NS} ${P_NS}>${spTree(shapes)}${CLR_MAP}${txStyles}</p:sldMaster>`

const lvl = (n: number, attrs = '', inner = ''): string =>
  inner === '' ? `<a:lvl${n}pPr${attrs}/>` : `<a:lvl${n}pPr${attrs}>${inner}</a:lvl${n}pPr>`
const lst = (...levels: string[]): string => `<a:lstStyle>${levels.join('')}</a:lstStyle>`
const defRPr = (attrs = '', inner = ''): string =>
  inner === '' ? `<a:defRPr${attrs}/>` : `<a:defRPr${attrs}>${inner}</a:defRPr>`

const MEDIA: Array<[string, string]> = [
  ['rId2', 'ppt/media/image1.png'],
  ['rId3', ''],
]

// ── lstStyle levels ───────────────────────────────────────────────────

/** Numbers through `parseInt`: the forms that read alike or apart. */
const NUMBERS = ['0', '342900', '-342900', '12.7', 'abc', '', '0x10', '1e3', ' 7', '+5', '-0', BIG]

const spc = (tag: string, kind: 'Pct' | 'Pts', val?: string): string =>
  `<a:${tag}>${val === undefined ? `<a:spc${kind}/>` : `<a:spc${kind} val="${val}"/>`}</a:${tag}>`

const BULLET_DRESS = [
  '',
  '<a:buFont typeface="Wingdings"/>',
  '<a:buFont typeface=""/>',
  '<a:buFont/>',
  `<a:buClr>${srgb('FF0000')}</a:buClr>`,
  `<a:buClr>${scheme('accent1')}</a:buClr>`,
  '<a:buClr/>',
  '<a:buSzPct val="75000"/>',
  '<a:buSzPct val="abc"/>',
  '<a:buSzPct val="-0"/>',
  `<a:buSzPct val="${BIG}"/>`,
  '<a:buSzPts val="1200"/>',
  '<a:buSzPts val="12.5"/>',
  '<a:buSzPts/>',
  `<a:buClr>${srgb('00FF00')}</a:buClr><a:buSzPct val="50000"/><a:buFont typeface="Symbol"/>`,
]

const BULLETS = [
  '<a:buNone/>',
  '<a:buChar char="\u2022"/>',
  '<a:buChar char="&#8226;"/>',
  '<a:buChar char="&amp;#8226;"/>',
  '<a:buChar char="&amp;#x1F600;"/>',
  '<a:buChar char="&amp;#xD800;"/>',
  '<a:buChar char="&amp;#1114112;"/>',
  '<a:buChar char="\uD83D\uDE00"/>',
  '<a:buChar char=""/>',
  "<a:buChar char='-'/>",
  '<a:buChar/>',
  '<a:buAutoNum type="arabicPeriod"/>',
  '<a:buAutoNum/>',
  '<a:buAutoNum startAt="5"/>',
  '<a:buAutoNum type=""/>',
  ...[
    '1',
    '2',
    '0',
    '-3',
    '32766',
    '32767',
    '32768',
    '99999999999',
    'abc',
    '',
    '2.9',
    '0x10',
    '1e3',
    ' 5',
    BIG,
  ].map((startAt) => `<a:buAutoNum type="romanUcPeriod" startAt="${startAt}"/>`),
  '<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>',
  '<a:buBlip><a:blip r:embed="rId3"/></a:buBlip>',
  '<a:buBlip><a:blip r:embed="rId9"/></a:buBlip>',
  '<a:buBlip><a:blip r:embed=""/></a:buBlip>',
  '<a:buBlip><a:blip/></a:buBlip>',
  '<a:buBlip/>',
  '<a:buNone/><a:buChar char="x"/>',
  '<a:buChar char="x"/><a:buAutoNum type="arabicPeriod"/>',
]

/** One level's pPr, as attributes and children. */
const LEVEL_FORMS: Array<[string, string]> = [
  ...['l', 'ctr', 'r', 'just', 'dist', '', 'CTR'].map((v): [string, string] => [
    ` algn="${v}"`,
    '',
  ]),
  [" algn='r'", ''],
  ...NUMBERS.flatMap((v): Array<[string, string]> => [
    [` marL="${v}"`, ''],
    [` indent="${v}"`, ''],
  ]),
  ...['1', '0', 'true', 'false', 'TRUE', '', '2'].map((v): [string, string] => [
    ` hangingPunct="${v}" latinLnBrk="${v}" eaLnBrk="${v}"`,
    '',
  ]),
  [' eaLnBrk="0" hangingPunct="1"', ''],
  ...['150000', '2400', 'abc', '', '-1000', '12.5', '0x10', '1e5', BIG].flatMap(
    (v): Array<[string, string]> => [
      ['', spc('lnSpc', 'Pct', v)],
      ['', spc('lnSpc', 'Pts', v)],
      ['', spc('spcBef', 'Pts', v)],
      ['', spc('spcBef', 'Pct', v)],
      ['', spc('spcAft', 'Pts', v)],
      ['', spc('spcAft', 'Pct', v)],
    ],
  ),
  ['', spc('lnSpc', 'Pct')],
  ['', '<a:lnSpc/>'],
  ['', '<a:lnSpc><a:spcPct val="90000"/><a:spcPts val="1200"/></a:lnSpc>'],
  [
    '',
    '<a:spcBef><a:spcPct val="20000"/><a:spcPts val="600"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>',
  ],
  ...BULLETS.map((b): [string, string] => ['', b]),
  ...BULLET_DRESS.flatMap((dress): Array<[string, string]> => [
    ['', `<a:buChar char="o"/>${dress}`],
    ['', `<a:buNone/>${dress}`],
    ['', `<a:buAutoNum type="alphaLcParenR" startAt="3"/>${dress}`],
    ['', `<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>${dress}`],
  ]),
  ['', `<a:defRPr sz="1800" b="1">${solid(scheme('tx1'))}<a:latin typeface="+mj-lt"/></a:defRPr>`],
  ['', defRPr(' lang="en-US"')],
  ['', '<a:defRPr/>'],
  [
    ' marL="342900" indent="-342900" algn="l" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"',
    `<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="\u2022"/>${defRPr(' sz="2800" kern="1200"', `${solid(scheme('tx1'))}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>`)}`,
  ],
]

/** Whole lstStyle texts: levels 1 to 9 and around them. */
const LST_FORMS: string[] = [
  ...LEVEL_FORMS.map(([attrs, inner]) => lst(lvl(1, attrs, inner))),
  lst(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => lvl(n, ` marL="${n * 457200}"`))),
  lst(lvl(9, ' algn="r"')),
  lst(lvl(10, ' algn="r"'), '<a:lvl0pPr algn="r"/>'),
  lst(lvl(2, ' algn="ctr"'), lvl(5, '', defRPr(' sz="1000"'))),
  lst(lvl(1, ' algn="ctr"'), lvl(1, ' algn="r"')),
  lst('<a:lvl1pPr>3</a:lvl1pPr>'),
  lst('<a:lvl1pPr> </a:lvl1pPr>'),
  lst(lvl(1)),
  lst('<a:defPPr algn="ctr"/>', lvl(3, ' indent="0"')),
  lst('<a:extLst/>'),
  '<a:lstStyle/>',
  '<a:lstStyle></a:lstStyle>',
  '<a:lstStyle>text</a:lstStyle>',
  '<a:lstStyle>0</a:lstStyle>',
  `<a:lstStyle><a:lvl1pPr algn="ctr"></a:lstStyle>`,
  `<a:lstStyle ${A_NS}>${lvl(1, ' algn="just"')}</a:lstStyle>`,
]

/** ledger inherited-key-placeholder-317: an algn every object inherits. */
const INHERITED_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

const LST_ARGS: Args[] = [
  { theme: T_FULL },
  {},
  { theme: T_FULL, parser: 'placeholder' },
  { theme: T_DARK, mediaRels: MEDIA },
  { theme: T_FULL, mediaRels: MEDIA, foreignPart: true, parser: 'placeholder' },
  { theme: T_EA, mediaRels: MEDIA, foreignPart: false },
  { theme: T_FULL, noSrc: true },
]

const LST_INPUTS: Input[] = [
  ...LST_FORMS.flatMap((text, at) =>
    // every form with the first two argument sets; every seventh with all of them
    (at % 7 === 0 ? LST_ARGS : LST_ARGS.slice(0, 2)).map((args) => ({
      text,
      args: { name: 'a:lstStyle', ...args },
    })),
  ),
  // the same bullets under every source: rId kept, dropped, resolved or not
  ...BULLETS.filter((b) => b.includes('buBlip')).flatMap((b) =>
    LST_ARGS.map((args) => ({ text: lst(lvl(1, '', b)), args: { name: 'a:lstStyle', ...args } })),
  ),
  // the other families of txStyles and presentation.xml
  ...['p:titleStyle', 'p:bodyStyle', 'p:otherStyle', 'p:defaultTextStyle'].map((name) => ({
    text: `<${name}>${lvl(1, ' algn="ctr"')}${lvl(2, ' marL="10"')}</${name}>`,
    args: { name, theme: T_FULL, parser: 'placeholder' },
  })),
  { text: lst(lvl(1, ' algn="ctr"')), args: { name: 'a:other', theme: T_FULL } },
  ...INHERITED_NAMES.flatMap((name): Input[] => [
    // ledger inherited-key-placeholder-317: the TypeScript sets align to a function or Object.prototype, the Rust no align
    {
      text: lst(lvl(1, ` algn="${name}"`)),
      args: { name: 'a:lstStyle', theme: T_FULL },
      seed: false,
    },
    { text: lst(lvl(1, ` algn="${name}" marL="5"`)), args: { name: 'a:lstStyle' }, seed: false },
  ]),
]

// ── defRPr ────────────────────────────────────────────────────────────

const SHADOW = (attrs: string, color: string): string =>
  `<a:effectLst><a:outerShdw${attrs}>${color}</a:outerShdw></a:effectLst>`

const DEF_RPR_TEXTS: string[] = [
  ...[...NUMBERS, '1800', '1800 ', '24.5pt'].map((sz) => defRPr(` sz="${sz}"`)),
  ...['1', '0', 'true', 'false', '', 'on'].map((v) => defRPr(` b="${v}" i="${v}"`)),
  defRPr(` i="1" b='true'`),
  ...['all', 'small', 'none', ''].map((cap) => defRPr(` cap="${cap}"`)),
  ...[
    srgb('FF0000'),
    srgb('ff00aa'),
    '<a:srgbClr val="4472C4"><a:lumMod val="75000"/></a:srgbClr>',
    scheme('accent1'),
    scheme('tx1'),
    scheme('bg1'),
    scheme('phClr'),
    '<a:sysClr val="windowText" lastClr="000000"/>',
    '<a:prstClr val="red"/>',
    '',
  ].map((color) => defRPr('', color === '' ? '<a:solidFill/>' : solid(color))),
  ...[
    [
      ' blurRad="38100" dist="38100" dir="2700000" algn="tl"',
      '<a:srgbClr val="000000"><a:alpha val="43137"/></a:srgbClr>',
    ],
    [' blurRad="" dist="abc" dir="-5400000"', srgb('000000')],
    [` blurRad="${BIG}" dist="12.5" dir="2700000.5"`, scheme('phClr')],
    [' dir="0x10"', scheme('accent2')],
    ['', srgb('112233')],
    [' blurRad="5"', ''],
  ].map(([attrs, color]) => defRPr('', SHADOW(attrs!, color!))),
  defRPr(
    '',
    '<a:effectLst><a:innerShdw blurRad="5">' + srgb('000000') + '</a:innerShdw></a:effectLst>',
  ),
  ...['ja-JP', 'ko-KR', 'zh-TW', 'zh-CN', 'zh-Hant', 'en-US', '', 'JA'].flatMap((lang) => [
    defRPr(
      ` lang="${lang}"`,
      '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>',
    ),
    defRPr(` lang="en-US" altLang="${lang}"`, '<a:ea typeface="+mj-ea"/>'),
    defRPr(` lang="ko-KR" altLang="${lang}"`, '<a:ea typeface="+mn-ea"/>'),
  ]),
  ...['+mj-lt', '+mn-lt', 'Arial', '', '+mj-ea', '+xx', '+', 'Calibri Light'].map((face) =>
    defRPr('', `<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/>`),
  ),
  defRPr('', '<a:latin/>'),
  defRPr(' lang="en-US"'),
  '<a:defRPr/>',
  '<a:defRPr></a:defRPr>',
  '<a:defRPr>text</a:defRPr>',
  '<a:defRPr sz="1" /><a:defRPr sz="2"/>',
  `<a:defRPr sz='2000' lang='ko-KR' b='1'><a:solidFill><a:schemeClr val='accent6'/></a:solidFill></a:defRPr>`,
  defRPr(
    ' sz="1400" b="0" i="1" cap="small" lang="ja-JP" altLang="en-US"',
    `${solid(scheme('tx2'))}${SHADOW(' blurRad="1" dist="2" dir="60000"', srgb('ABCDEF'))}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="Arial"/>`,
  ),
  '<a:defRPr sz="1800"><a:solidFill><a:srgbClr val="FF0000"></a:solidFill></a:defRPr>',
]

const DEF_RPR_INPUTS: Input[] = [
  ...DEF_RPR_TEXTS.flatMap((text) =>
    [
      { name: 'a:defRPr', theme: T_FULL },
      { name: 'a:defRPr' },
      { name: 'a:defRPr', theme: T_DARK, phClr: '#ABCDEF' },
    ].map((args) => ({ text, args })),
  ),
  ...DEF_RPR_TEXTS.filter((text) => /ea typeface|lang=/.test(text)).map((text) => ({
    text,
    args: { name: 'a:defRPr', theme: T_EA, parser: 'placeholder' },
  })),
  { text: defRPr(' sz="1800"'), args: { name: 'a:rPr', theme: T_FULL } },
]

// ── Placeholder maps ──────────────────────────────────────────────────

const L_MAIN = layoutOf([
  {
    ph: ph('title'),
    xfrm: xfrm('100', '200', '300', '400'),
    bodyPr: '<a:bodyPr anchor="b" anchorCtr="0" lIns="10"/>',
    lst: lst(lvl(1, ' algn="ctr"')),
  },
  {
    ph: ph(undefined, '1'),
    xfrm: xfrm('1', '2', '3', '4'),
    bodyPr: '<a:bodyPr tIns="20" rIns="30"/>',
    spPr: solid(srgb('00FF00')),
    lst: lst(lvl(1, '', defRPr(' sz="2000"'))),
  },
  {
    ph: ph('dt', '2'),
    xfrm: xfrm('5', '6', '7', '8'),
    bodyPr: '<a:bodyPr anchor="ctr"/>',
    spPr: '<a:noFill/>',
    lst: lst(lvl(1, '', defRPr(' sz="1000"'))),
  },
  { ph: ph('obj', '3'), spPr: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' },
  {
    ph: ph('pic', '4'),
    kind: 'pic',
    xfrm: xfrm('9', '9', '9', '9'),
    spPr: '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst></a:prstGeom>',
  },
  { ph: ph('tbl', '5'), kind: 'frame', xfrm: xfrm('11', '12', '13', '14') },
  { ph: ph('ctrTitle'), bodyPr: '<a:bodyPr anchorCtr="1"/>' },
  {
    ph: ph('subTitle', '6'),
    bodyPr: '<a:bodyPr bIns="5" anchor="t"/>',
    spPr: '<a:gradFill><a:gsLst/></a:gradFill>',
  },
  { ph: ph('body', '7'), bodyPr: '<a:bodyPr numCol="2"/>' },
  { ph: '<p:ph/>', xfrm: xfrm('77', '77', '77', '77') },
])

const L_EXACT = layoutOf([
  { ph: ph(undefined, '1'), lst: lst(lvl(1, ' marL="0"')) },
  { ph: ph('title'), xfrm: xfrm() },
  { ph: ph('body', '9'), bodyPr: '<a:bodyPr anchor="ctr" lIns="91440"/>' },
])

const L_EMPTY = layoutOf([{ xfrm: xfrm(), bodyPr: '<a:bodyPr anchor="b"/>' }])

const L_FUNC = layoutOf([
  {
    ph: ph('dt', '1'),
    xfrm: xfrm('3', '3', '3', '3'),
    spPr: solid(srgb('123456')) + '<a:prstGeom prst="triangle"/>',
    lst: lst(lvl(1, ' algn="r"')),
  },
  { ph: ph('ftr', '2'), bodyPr: '<a:bodyPr anchor="b" anchorCtr="1" lIns="1"/>' },
  { ph: ph('sldNum', '12'), xfrm: xfrm('4', '4', '4', '4') },
])

const L_NOFILL = layoutOf([
  { ph: ph('body', '1'), spPr: '<a:noFill/><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' },
  { ph: ph('obj', '1'), xfrm: xfrm(), spPr: '<a:pattFill prst="pct5"/>' },
  {
    ph: ph('title'),
    spPr: '<a:blipFill/><a:prstGeom prst=""/>',
    bodyPr: '<a:bodyPr anchorCtr="true"/>',
  },
])

const L_ODD = layoutOf([
  {
    ph: ph('', ''),
    xfrm: xfrm('a', '', '0x10', BIG),
    bodyPr: '<a:bodyPr anchor="" anchorCtr=""/>',
  },
  { ph: ph('constructor', 'toString'), xfrm: xfrm('1e3', '-5', '12.9', ' 7') },
  {
    ph: ph('body', '01'),
    xfrm: xfrm(undefined, undefined, undefined, undefined, ' rot="5400000" flipH="1" flipV="true"'),
  },
  {
    ph: ph('title', '0'),
    xfrm: xfrm(undefined, undefined, undefined, undefined, ' rot="abc" flipH="TRUE" flipV="0"'),
  },
  { ph: "<p:ph type='body' idx='3'/>", xfrm: '<a:xfrm rot=""><a:off/><a:ext cx="5"/></a:xfrm>' },
  { ph: ph('obj', '8'), xfrm: '<a:xfrm><a:ext cx="1" cy="2"/></a:xfrm>' },
  { ph: ph('obj', '9'), xfrm: '<a:xfrm/>' },
  { ph: ph('obj', '10'), xfrm: xfrm() + xfrm('1', '1', '1', '1') },
  { ph: ph('obj', '11'), xfrm: '<a:xfrm><a:off x="1"/><a:off x="2"/></a:xfrm>' },
  { ph: '<p:ph>5</p:ph>', xfrm: xfrm('6', '6', '6', '6') },
  { ph: '<p:ph>0</p:ph>', xfrm: xfrm('7', '7', '7', '7') },
])

/**
 * ledger inherited-key-placeholder-233: bodyPr anchors every object
 * inherits. The TypeScript records a function or Object.prototype as the
 * anchor, so the entry exists and matches; the Rust records no anchor.
 */
const L_INHERITED = layoutOf([
  { ph: ph(undefined, '1'), bodyPr: '<a:bodyPr anchor="constructor"/>' },
  { ph: ph('title'), xfrm: xfrm(), bodyPr: '<a:bodyPr anchor="__proto__"/>' },
  { ph: ph('obj', '3'), bodyPr: '<a:bodyPr anchor="toString"/>' },
  { ph: ph('subTitle', '4'), bodyPr: '<a:bodyPr anchor="hasOwnProperty"/>' },
])

const TX_STYLES =
  '<p:txStyles>' +
  `<p:titleStyle>${lvl(1, ' algn="l"', defRPr(' sz="4400"', `${solid(scheme('tx1'))}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/>`))}</p:titleStyle>` +
  `<p:bodyStyle>${lvl(1, ' marL="228600" indent="-228600"', `<a:buFont typeface="Arial"/><a:buChar char="\u2022"/>${defRPr(' sz="2800"')}`)}${lvl(2, ' marL="685800"', '<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>')}</p:bodyStyle>` +
  `<p:otherStyle>${lvl(1, '', defRPr(' sz="1800"'))}</p:otherStyle>` +
  '</p:txStyles>'

const M_MAIN = masterOf(
  [
    {
      ph: ph('title'),
      xfrm: xfrm('1000', '1000', '1000', '1000'),
      bodyPr: '<a:bodyPr anchor="ctr" tIns="7"/>',
      lst: lst(lvl(1, ' algn="r"')),
    },
    {
      ph: ph('body', '1'),
      xfrm: xfrm('2000', '2000', '2000', '2000'),
      bodyPr: '<a:bodyPr lIns="0" tIns="0" anchorCtr="1" anchor="t"/>',
      spPr: solid(scheme('accent1')) + '<a:prstGeom prst="snipRect"/>',
      lst: lst(lvl(1, '', defRPr(' sz="3200" b="1"')), lvl(2, ' indent="5"')),
    },
    { ph: ph('dt', '2'), xfrm: xfrm('3000', '1', '1', '1'), bodyPr: '<a:bodyPr anchor="b"/>' },
    { ph: ph('ftr', '3'), xfrm: xfrm('4000', '1', '1', '1'), lst: lst(lvl(1, ' algn="ctr"')) },
    {
      ph: ph('sldNum', '4'),
      xfrm: xfrm('5000', '1', '1', '1'),
      bodyPr: '<a:bodyPr rIns="3" bIns="4"/>',
    },
    { ph: ph('obj', '7'), spPr: '<a:noFill/>' },
  ],
  TX_STYLES,
)

const M_BARE = masterOf([{ ph: ph('body'), xfrm: xfrm('8', '8', '8', '8') }])

const PH_MAP_TEXTS: string[] = [
  L_MAIN,
  L_EXACT,
  L_EMPTY,
  L_FUNC,
  L_NOFILL,
  L_ODD,
  M_MAIN,
  M_BARE,
  ...LST_FORMS.filter((_, at) => at % 3 === 0).map((text) =>
    layoutOf([{ ph: ph('body', '1'), lst: text }]),
  ),
  layoutOf([
    {
      ph: ph('body', '1'),
      lst: lst(lvl(1, '', '<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>')),
    },
  ]),
  ...NUMBERS.map((v) =>
    layoutOf([
      { ph: ph('body', '1'), bodyPr: `<a:bodyPr lIns="${v}" tIns="${v}" rIns="1" bIns="${v}"/>` },
    ]),
  ),
  layoutOf([{ ph: ph('body', '1'), bodyPr: '<a:bodyPr bIns="1" lIns="2"/>' }]),
  ...['1', '0', 'true', 'false', '', ' 1', '01'].map((v) =>
    layoutOf([{ ph: ph('body', '1'), bodyPr: `<a:bodyPr anchorCtr="${v}"/>` }]),
  ),
  ...['t', 'ctr', 'b', 'just', 'dist', 'T', ''].map((v) =>
    layoutOf([{ ph: ph('body', '1'), bodyPr: `<a:bodyPr anchor="${v}"/>` }]),
  ),
  ...['a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:noFill', 'a:grpFill'].map((tag) =>
    layoutOf([{ ph: ph('body', '1'), spPr: `<${tag}/>` }]),
  ),
  ...['rect', 'ellipse', '', 'Rect'].map((prst) =>
    layoutOf([{ ph: ph('pic', '1'), kind: 'pic', spPr: `<a:prstGeom prst="${prst}"/>` }]),
  ),
  layoutOf([{ ph: ph('pic', '1'), spPr: '<a:prstGeom/>' }]),
  layoutOf([{ ph: ph('pic', '1'), spPr: '<a:prstGeom prst="ellipse">0</a:prstGeom>' }]),
  layoutOf([
    { ph: ph('chart', '1'), kind: 'frame', xfrm: xfrm('1', '2', '3', '4', ' rot="60000"') },
  ]),
  layoutOf([{ ph: ph('chart', '1'), kind: 'frame' }]),
  `<p:sldLayout ${P_NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
  `<p:sldLayout ${P_NS}><p:cSld/></p:sldLayout>`,
  `<p:sldLayout ${P_NS}/>`,
  `<p:sldLayout ${P_NS}><p:cSld><p:spTree>text</p:spTree></p:cSld></p:sldLayout>`,
  `<p:notesMaster ${P_NS}>${spTree([{ ph: ph('body', '1'), xfrm: xfrm() }])}</p:notesMaster>`,
  `<p:sldLayout ${P_NS}><p:cSld><p:spTree></p:cSld></p:sldLayout>`,
  `<p:sldLayout ${P_NS}>${spTree([{ ph: ph('body'), xfrm: xfrm() }])}</p:sldLayout><p:sldMaster/>`,
  `<p:sldMaster ${P_NS}>${spTree([{ ph: ph('body'), xfrm: xfrm() }])}</p:sldMaster>`,
  '',
  'not xml',
]

const PH_MAP_INPUTS: Input[] = [
  ...PH_MAP_TEXTS.flatMap((text) => [
    { text, args: { theme: T_FULL } },
    { text, args: { theme: T_DARK, mediaRels: MEDIA } },
  ]),
  ...PH_MAP_TEXTS.slice(0, 8).map((text) => ({ text })),
  // ledger inherited-key-placeholder-233: the TypeScript records a function or {} as the anchor, the Rust none
  { text: L_INHERITED, args: { theme: T_FULL }, seed: false },
  ...INHERITED_NAMES.map((name): Input => ({
    text: layoutOf([{ ph: ph('body', '1'), bodyPr: `<a:bodyPr anchor="${name}"/>` }]),
    seed: false,
  })),
  // ledger inherited-key-placeholder-317: an algn every object inherits, in a layout's lstStyle
  ...INHERITED_NAMES.map((name): Input => ({
    text: layoutOf([{ ph: ph('body', '1'), lst: lst(lvl(1, ` algn="${name}"`)) }]),
    args: { theme: T_FULL },
    seed: false,
  })),
]

// ── Master text styles and presentation defaults ──────────────────────

const MASTER_TEXTS: string[] = [
  M_MAIN,
  M_BARE,
  masterOf([], '<p:txStyles/>'),
  masterOf([], `<p:txStyles><p:bodyStyle>${lvl(1, ' algn="ctr"')}</p:bodyStyle></p:txStyles>`),
  masterOf(
    [],
    `<p:txStyles><p:otherStyle>${lvl(3, ' marL="1"')}</p:otherStyle><p:titleStyle/></p:txStyles>`,
  ),
  masterOf(
    [],
    `<p:txStyles><p:titleStyle>${lvl(1, ' algn="r"')}</p:titleStyle><p:titleStyle>${lvl(1)}</p:titleStyle></p:txStyles>`,
  ),
  masterOf(
    [],
    `<p:txStyles><p:bodyStyle>${LST_FORMS.slice(0, 1).join('')}</p:bodyStyle></p:txStyles>`,
  ),
  masterOf([], `<p:txStyles>0</p:txStyles>`),
  masterOf(
    [],
    `<p:txStyles><p:bodyStyle>${lvl(1, '', '<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>')}${lvl(2, '', '<a:buBlip><a:blip r:embed="rId3"/></a:buBlip>')}</p:bodyStyle></p:txStyles>`,
  ),
  ...LEVEL_FORMS.filter((_, at) => at % 5 === 0).map(([attrs, inner]) =>
    masterOf(
      [],
      `<p:txStyles><p:titleStyle>${lvl(1, attrs, inner)}</p:titleStyle><p:bodyStyle>${lvl(4, attrs, inner)}</p:bodyStyle></p:txStyles>`,
    ),
  ),
  `<p:sldLayout ${P_NS}>${TX_STYLES}</p:sldLayout>`,
  `<p:sldMaster ${P_NS}><p:txStyles>`,
  '',
]

const MASTER_INPUTS: Input[] = [
  ...MASTER_TEXTS.flatMap((text) => [
    { text, args: { theme: T_FULL, mediaRels: MEDIA } },
    { text, args: { theme: T_EA } },
  ]),
  ...MASTER_TEXTS.slice(0, 3).map((text) => ({ text })),
  ...INHERITED_NAMES.map((name): Input => ({
    // ledger inherited-key-placeholder-317: an algn every object inherits, in txStyles
    text: masterOf(
      [],
      `<p:txStyles><p:bodyStyle>${lvl(1, ` algn="${name}"`)}</p:bodyStyle></p:txStyles>`,
    ),
    args: { theme: T_FULL },
    seed: false,
  })),
]

const presentationOf = (inner: string): string =>
  `${DECL}<p:presentation ${A_NS} ${R_NS} ${P_NS}><p:sldSz cx="12192000" cy="6858000"/>${inner}</p:presentation>`

const DEFAULT_TEXTS: string[] = [
  presentationOf(
    `<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${[1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((n) =>
        lvl(
          n,
          ` marL="${(n - 1) * 457200}" algn="l"`,
          defRPr(
            ' sz="1800" kern="1200"',
            `${solid(scheme('tx1'))}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>`,
          ),
        ),
      )
      .join('')}</p:defaultTextStyle>`,
  ),
  presentationOf(
    `<p:defaultTextStyle>${lvl(1, '', defRPr(' sz="1400" lang="ja-JP"', '<a:ea typeface="+mn-ea"/>'))}</p:defaultTextStyle>`,
  ),
  presentationOf('<p:defaultTextStyle/>'),
  presentationOf('<p:defaultTextStyle><a:defPPr/></p:defaultTextStyle>'),
  presentationOf(''),
  presentationOf(
    `<p:defaultTextStyle>${lvl(1, '', '<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>')}</p:defaultTextStyle>`,
  ),
  `<p:other ${P_NS}><p:defaultTextStyle>${lvl(1, ' algn="r"')}</p:defaultTextStyle></p:other>`,
  `<p:presentation ${P_NS}><p:defaultTextStyle>`,
  '',
]

const DEFAULT_INPUTS: Input[] = DEFAULT_TEXTS.flatMap((text) =>
  [T_FULL, T_EA, undefined].map((theme) => ({ text, args: withTheme(theme) })),
)

// ── Placeholder resolution ────────────────────────────────────────────

const PAIRS: Array<[string | undefined, string | undefined]> = [
  [undefined, undefined],
  ['title', undefined],
  ['ctrTitle', undefined],
  ['body', '1'],
  [undefined, '1'],
  ['obj', '3'],
  ['subTitle', '1'],
  ['dt', '2'],
  ['body', '2'],
  ['pic', '4'],
  ['tbl', '9'],
  ['', ''],
  ['constructor', 'toString'],
  ['sldNum', '12'],
  ['unknown', '99'],
  ['body', ''],
  ['title', '0'],
  ['obj', '7'],
]

const LAYOUTS = [L_MAIN, L_EXACT, L_EMPTY, L_FUNC, L_NOFILL, L_ODD]
const MASTERS: Array<string | undefined> = [M_MAIN, M_BARE, undefined]

const pairArgs = ([type, idx]: [string | undefined, string | undefined]): Args => ({
  ...(type === undefined ? {} : { type }),
  ...(idx === undefined ? {} : { idx }),
})

const RESOLVE_INPUTS: Input[] = [
  ...LAYOUTS.flatMap((text) =>
    MASTERS.flatMap((masterXml) =>
      PAIRS.map((pair) => ({
        text,
        args: {
          theme: T_FULL,
          ...pairArgs(pair),
          ...(masterXml === undefined ? {} : { masterXml }),
        },
      })),
    ),
  ),
  // the master as the text, with and without a layout
  ...[M_MAIN, M_BARE].flatMap((text) =>
    [L_MAIN, L_EXACT, undefined].flatMap((layoutXml) =>
      PAIRS.slice(0, 10).map((pair) => ({
        text,
        args: {
          textIs: 'master',
          ...pairArgs(pair),
          ...(layoutXml === undefined ? {} : { layoutXml }),
        },
      })),
    ),
  ),
  ...PAIRS.map((pair) => ({ text: '', args: { masterXml: M_MAIN, ...pairArgs(pair) } })),
  ...PAIRS.map((pair) => ({ text: 'not xml', args: { masterXml: 'not xml', ...pairArgs(pair) } })),
  // ledger inherited-key-placeholder-233: the TypeScript's layout has entries the Rust's lacks
  ...[M_MAIN, undefined].flatMap((masterXml) =>
    PAIRS.slice(0, 10).map((pair): Input => ({
      text: L_INHERITED,
      args: { ...pairArgs(pair), ...(masterXml === undefined ? {} : { masterXml }) },
      seed: false,
    })),
  ),
]

const STYLE_CHAIN_INPUTS: Input[] = [
  ...RESOLVE_INPUTS,
  ...PAIRS.map((pair) => ({
    text: L_MAIN,
    args: {
      masterXml: M_MAIN,
      noTx: true,
      layoutMediaRels: MEDIA,
      masterMediaRels: MEDIA,
      theme: T_EA,
      ...pairArgs(pair),
    },
  })),
  ...PAIRS.map((pair) => ({
    text: layoutOf([
      {
        ph: ph('body', '1'),
        lst: lst(lvl(1, '', '<a:buBlip><a:blip r:embed="rId2"/></a:buBlip>')),
      },
    ]),
    args: { masterXml: M_MAIN, layoutMediaRels: MEDIA, ...pairArgs(pair) },
  })),
]

// ── Style chains ──────────────────────────────────────────────────────

const LEVELS = [0, 1, 2, 4, 8, 9]

/** A chain as parse.ts builds it, then as it crosses JSON. */
function chainOf(
  layers: Layers,
  own: TextStyleLevels | undefined,
  fontRefColor: string | undefined,
): Array<TextStyleLevels | undefined> {
  return wire([
    own ? { ...own, src: 'shape lstStyle' } : undefined,
    ...(fontRefColor ? [{ levels: [{ color: fontRefColor }], src: 'shape style' }] : []),
    ...placeholderStyleChain(
      layers.layout,
      layers.master,
      layers.masterTx,
      layers.type,
      layers.idx,
    ),
  ])
}

const shadow = { color: '#000000', blurRad: 1, dist: 2, dirDeg: 45 }

const HAND_CHAINS: unknown[][] = [
  [],
  [null],
  [{ levels: [] }],
  [{ levels: [{}] }],
  [{ levels: [null, { italic: true }] }],
  [
    { levels: [{ bold: true }], src: 'a' },
    { levels: [{ fontSize: 12, bold: false }], src: 'b' },
  ],
  [
    { levels: [{ color: '#000000' }], src: 'x' },
    { levels: [{ fontSize: 10, align: 'center', bold: true }], src: 'y' },
  ],
  [{ levels: [{ lineExact: 12 }] }, { levels: [{ lineHeight: 150, lineExact: 20 }] }],
  [{ levels: [{ lineHeight: 90 }] }, { levels: [{ lineExact: 20 }] }],
  [
    { levels: [{ spaceBeforePct: 20 }] },
    { levels: [{ spaceBefore: 6, spaceAfter: 3 }] },
    { levels: [{ spaceAfterPct: 50 }] },
  ],
  [
    { levels: [{ spaceAfter: 0, spaceBefore: 0 }] },
    { levels: [{ spaceAfterPct: 1, spaceBeforePct: 2 }] },
  ],
  [
    { levels: [{ latinFontRef: '+mj-lt' }] },
    { levels: [{ latinFont: 'Calibri', latinFontRef: '+mn-lt' }], src: 'L' },
  ],
  [
    { levels: [{ latinFont: 'Arial' }] },
    { levels: [{ latinFont: 'Calibri', latinFontRef: '+mn-lt' }] },
  ],
  [
    { levels: [{ eaFont: 'MS Gothic', eaFontRef: '+mj-ea', eaScript: 'ja' }] },
    { levels: [{ csFont: 'Arial', eaScript: 'ko' }] },
  ],
  [
    { levels: [{ eaFontRef: '+mn-ea' }], src: '' },
    { levels: [{ eaFont: 'Meiryo' }], src: null },
  ],
  [
    {
      levels: [
        { bullet: { type: 'char', char: '\u2022', font: 'Arial', color: '#FF0000', sizePct: 75 } },
      ],
    },
    { levels: [{ bullet: { type: 'none' }, marL: 0, indent: -342900 }] },
  ],
  [{ levels: [{ bullet: { type: 'number', numType: 'arabicPeriod', startAt: 3, sizePt: 12 } }] }],
  [
    {
      levels: [{ bullet: { type: 'blip', blipEmbedId: 'rId2', mediaRef: 'ppt/media/image1.png' } }],
    },
  ],
  [
    { levels: [{ hangingPunct: false, latinLnBrk: true }] },
    { levels: [{ hangingPunct: true, eaLnBrk: false }] },
  ],
  [{ levels: [{ cap: 'all', shadow }] }, { levels: [{ cap: 'none', fontSize: 9 }] }],
  [{ levels: [{ align: 'justify', src: { align: 'ignored' } }], src: 'own' }],
  [
    { levels: [{ fontSize: 10 }, { fontSize: 20 }, null, { fontSize: 40 }], src: 'one' },
    undefined,
    { levels: [{ bold: true }, { italic: true }, { color: '#111111' }], src: 'two' },
  ],
  [
    { levels: [null, null, { marL: 5 }] },
    {
      levels: [
        { indent: 1 },
        { indent: 2 },
        { indent: 3 },
        { indent: 4 },
        { indent: 5 },
        { indent: 6 },
        { indent: 7 },
        { indent: 8 },
        { indent: 9 },
      ],
    },
  ],
]

/** A slide shape's own lstStyle, as parse.ts reads it. */
const OWN_STYLE = parseLstStyleLevels(
  (parseTsParser.parse(lst(lvl(1, ' algn="r"', defRPr(' sz="900"')), lvl(3, ' marL="7"'))) as Node)[
    'a:lstStyle'
  ],
  T_FULL,
)

/** Chains built by the real readers from the built layouts and masters. */
const PARSED_CHAINS: unknown[][] = [L_MAIN, L_EXACT, L_FUNC].flatMap((layoutXml) =>
  PAIRS.slice(0, 9).map((pair) =>
    chainOf(
      layersOf(layoutXml, { theme: T_FULL, masterXml: M_MAIN, ...pairArgs(pair) }),
      pair[1] === '1' ? OWN_STYLE : undefined,
      pair[0] === 'title' ? '#C00000' : undefined,
    ),
  ),
)

const MERGE_INPUTS: Input[] = [
  ...HAND_CHAINS.flatMap((chain) =>
    [...LEVELS, 3, 10, -1, 1.5, 1e300].map((level) => ({ args: { chain: wire(chain), level } })),
  ),
  ...PARSED_CHAINS.flatMap((chain) => LEVELS.map((level) => ({ args: { chain, level } }))),
]

// ── The corpus ────────────────────────────────────────────────────────

const MASTER_PART = /^ppt\/slideMasters\/[^/]+\.xml$/
const LAYOUT_PART = /^ppt\/slideLayouts\/[^/]+\.xml$/
const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/
const PRESENTATION = 'ppt/presentation.xml'

const partsOf = (parts: Parts, name: RegExp): Array<[string, string]> =>
  [...parts].filter(([path]) => name.test(path))

interface Rel {
  id: string
  type: string
  target: string
}

function relsOf(parts: Parts, part: string | undefined): Rel[] {
  const rels = part === undefined ? undefined : parts.get(relsPathFor(part))
  if (rels === undefined) return []
  return [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([rel]) => ({
    id: /\bId="([^"]*)"/.exec(rel)?.[1] ?? '',
    type: /\bType="([^"]*)"/.exec(rel)?.[1] ?? '',
    target: /\bTarget="([^"]*)"/.exec(rel)?.[1] ?? '',
  }))
}

/** The part the first relationship of `type` of `part` names, where the deck has it. */
function related(parts: Parts, part: string | undefined, type: string): string | undefined {
  for (const rel of relsOf(parts, part)) {
    if (!rel.type.endsWith(`/relationships/${type}`)) continue
    const path = part === undefined ? '' : resolveTarget(part, rel.target)
    if (path && parts.has(path)) return path
  }
  return undefined
}

/** `partMediaRels` of index.ts: the part's image relationships. */
const mediaPairs = (parts: Parts, part: string | undefined): Array<[string, string]> =>
  part === undefined
    ? []
    : relsOf(parts, part)
        .filter((rel) => rel.type.endsWith('/image'))
        .map((rel): [string, string] => [rel.id, resolveTarget(part, rel.target)])

function parsedTheme(xml: string | undefined): Theme | undefined {
  if (xml === undefined) return undefined
  try {
    return parseTheme(xml)
  } catch {
    return undefined
  }
}

interface Context {
  layoutXml?: string
  masterXml?: string
  slideXml?: string
  theme?: Theme
  layoutMedia: Array<[string, string]>
  masterMedia: Array<[string, string]>
}

/** A slide, layout or master with its chain, read as index.ts reads it. */
function contextOf(
  parts: Parts,
  layoutPath: string | undefined,
  masterPath: string | undefined,
  slideXml?: string,
): Context {
  const layoutXml = layoutPath === undefined ? undefined : parts.get(layoutPath)
  const masterXml = masterPath === undefined ? undefined : parts.get(masterPath)
  const themePath = related(parts, masterPath, 'theme')
  const base = parsedTheme(themePath === undefined ? undefined : parts.get(themePath))
  return {
    layoutXml,
    masterXml,
    slideXml,
    theme: base && wire({ ...base, clrMap: parseClrMap(masterXml, layoutXml, slideXml) }),
    layoutMedia: mediaPairs(parts, layoutPath),
    masterMedia: mediaPairs(parts, masterPath),
  }
}

const slideContext = (parts: Parts, slidePath: string, slideXml: string): Context => {
  const layoutPath = related(parts, slidePath, 'slideLayout')
  return contextOf(parts, layoutPath, related(parts, layoutPath, 'slideMaster'), slideXml)
}

/** The arguments of a placeholder (type, idx) against its context's layers. */
function layerInput(
  c: Context,
  type: string | undefined,
  idx: string | undefined,
): Input | undefined {
  const args: Args = { ...withTheme(c.theme), ...pairArgs([type, idx]) }
  if (c.layoutMedia.length) args.layoutMediaRels = c.layoutMedia
  if (c.masterMedia.length) args.masterMediaRels = c.masterMedia
  if (c.layoutXml) {
    if (c.masterXml) args.masterXml = c.masterXml
    return { text: c.layoutXml, args }
  }
  if (c.masterXml) return { text: c.masterXml, args: { ...args, textIs: 'master' } }
  return undefined
}

interface SlideShape {
  ph: boolean
  type?: string
  idx?: string
  lst?: unknown
  fontRef?: unknown
  hasText: boolean
}

/** The shapes of a slide's tree, groups included, as parse.ts reads them. */
function shapesOf(slideXml: string): SlideShape[] {
  let doc: Node
  try {
    doc = parseTsParser.parse(slideXml) as Node
  } catch {
    return []
  }
  const out: SlideShape[] = []
  const walk = (tree: unknown, depth: number): void => {
    if (!tree || typeof tree !== 'object' || depth > 32) return
    const t = tree as Node
    for (const [key, nvKey] of [
      ['p:sp', 'p:nvSpPr'],
      ['p:pic', 'p:nvPicPr'],
      ['p:graphicFrame', 'p:nvGraphicFramePr'],
    ] as const) {
      for (const node of xmlArray(t[key])) {
        const nvPr = (node[nvKey] as Node | undefined)?.['p:nvPr'] as Node | undefined
        const phNode = nvPr?.['p:ph'] as Node | string | undefined
        const txBody = node['p:txBody'] as Node | undefined
        const phObject = phNode && typeof phNode === 'object' ? phNode : undefined
        out.push({
          ph: !!phNode,
          type: phObject?.['@_type'] as string | undefined,
          idx: phObject?.['@_idx'] != null ? String(phObject['@_idx']) : undefined,
          lst: txBody?.['a:lstStyle'],
          fontRef: (node['p:style'] as Node | undefined)?.['a:fontRef'],
          hasText: txBody !== undefined,
        })
      }
    }
    for (const group of xmlArray(t['p:grpSp'])) walk(group, depth + 1)
  }
  const sld = doc['p:sld'] as Node | undefined
  walk((sld?.['p:cSld'] as Node | undefined)?.['p:spTree'], 0)
  return out
}

/** Every (type, idx) of a `<p:ph>` in the deck's slides, layouts and masters. */
function deckPairs(parts: Parts, cap: number): Array<[string | undefined, string | undefined]> {
  const seen = new Map<string, [string | undefined, string | undefined]>()
  for (const [, xml] of [
    ...partsOf(parts, SLIDE_PART),
    ...partsOf(parts, LAYOUT_PART),
    ...partsOf(parts, MASTER_PART),
  ]) {
    for (const [tag] of xml.matchAll(/<p:ph\b[^>]*>/g)) {
      const pair: [string | undefined, string | undefined] = [
        /\btype="([^"]*)"/.exec(tag)?.[1],
        /\bidx="([^"]*)"/.exec(tag)?.[1],
      ]
      if (seen.size < cap) seen.set(JSON.stringify(pair), pair)
    }
  }
  return [...seen.values()]
}

const distinctInputs = (inputs: Array<Input | undefined>): Input[] => {
  const seen = new Map<string, Input>()
  for (const input of inputs) if (input) seen.set(JSON.stringify(input), input)
  return [...seen.values()]
}

/** Every slide placeholder against its own chain, and every layout with the deck's pairs. */
function placeholderInputs(parts: Parts): Input[] {
  const fromSlides = partsOf(parts, SLIDE_PART).flatMap(([path, xml]) => {
    const c = slideContext(parts, path, xml)
    return shapesOf(xml)
      .filter((s) => s.ph)
      .map((s) => layerInput(c, s.type, s.idx))
  })
  const pairs = deckPairs(parts, 16)
  const fromLayouts = partsOf(parts, LAYOUT_PART).flatMap(([path]) => {
    const c = contextOf(parts, path, related(parts, path, 'slideMaster'))
    return pairs.map(([type, idx]) => layerInput(c, type, idx))
  })
  return distinctInputs([...fromSlides, ...fromLayouts])
}

/** The style chain of every text shape of every slide, as parse.ts builds it. */
function chainInputs(parts: Parts): Input[] {
  const presXml = parts.get(PRESENTATION)
  return distinctInputs(
    partsOf(parts, SLIDE_PART).flatMap(([path, xml]) => {
      const c = slideContext(parts, path, xml)
      const layoutMedia = mediaOf(c.layoutMedia)
      const masterMedia = mediaOf(c.masterMedia)
      const layout = c.layoutXml
        ? parsePlaceholderMap(c.layoutXml, c.theme, layoutMedia)
        : undefined
      const master = c.masterXml
        ? parsePlaceholderMap(c.masterXml, c.theme, masterMedia)
        : undefined
      const masterTx = c.masterXml
        ? parseMasterTextStyles(c.masterXml, c.theme, masterMedia)
        : undefined
      const defaults = presXml ? parseDefaultTextStyle(presXml, c.theme) : undefined
      const src: LstStyleSource = { mediaRels: new Map(mediaPairs(parts, path)) }
      return shapesOf(xml)
        .filter((s) => s.hasText)
        .flatMap((s) => {
          const own = parseLstStyleLevels(s.lst, c.theme, src)
          const fontRefColor = resolveColorNode(s.fontRef, c.theme)
          const chain = s.ph
            ? chainOf({ layout, master, masterTx, type: s.type, idx: s.idx }, own, fontRefColor)
            : wire([
                own ? { ...own, src: 'shape lstStyle' } : undefined,
                ...(fontRefColor
                  ? [{ levels: [{ color: fontRefColor }], src: 'shape style' }]
                  : []),
                ...(defaults ? [{ ...defaults, src: 'presentation defaultTextStyle' }] : []),
              ])
          return LEVELS.map((level): Input => ({ args: { chain, level } }))
        })
    }),
  )
}

/** Each part with the context it is read in. */
function partContexts(
  parts: Parts,
): Array<{ path: string; xml: string; c: Context; slide: boolean }> {
  return [
    ...partsOf(parts, SLIDE_PART).map(([path, xml]) => ({
      path,
      xml,
      c: slideContext(parts, path, xml),
      slide: true,
    })),
    ...partsOf(parts, LAYOUT_PART).map(([path, xml]) => ({
      path,
      xml,
      c: contextOf(parts, path, related(parts, path, 'slideMaster')),
      slide: false,
    })),
    ...partsOf(parts, MASTER_PART).map(([path, xml]) => ({
      path,
      xml,
      c: contextOf(parts, undefined, path),
      slide: false,
    })),
  ]
}

/** Each match of `re` in `text`, distinct, at most `cap`. */
const matchesOf = (text: string, re: RegExp, cap: number): string[] =>
  [...new Set([...text.matchAll(re)].map(([m]) => m))].slice(0, cap)

const LIST_STYLE =
  /<(a:lstStyle|p:titleStyle|p:bodyStyle|p:otherStyle|p:defaultTextStyle)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g
const DEF_RPR = /<a:defRPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:defRPr>)/g
const nameOf = (element: string): string => /^<([\w:]+)/.exec(element)?.[1] ?? ''

function lstStyleInputs(parts: Parts): Input[] {
  const fromParts = partContexts(parts).flatMap(({ path, xml, c, slide }) =>
    matchesOf(xml, LIST_STYLE, 20).map((text): Input => {
      const name = nameOf(text)
      const media = mediaPairs(parts, path)
      return {
        text,
        args: {
          name,
          ...withTheme(c.theme),
          ...(slide && name === 'a:lstStyle' ? {} : { parser: 'placeholder', foreignPart: true }),
          ...(media.length ? { mediaRels: media } : {}),
        },
      }
    }),
  )
  const presXml = parts.get(PRESENTATION)
  const theme = partContexts(parts)[0]?.c.theme
  const fromPresentation =
    presXml === undefined
      ? []
      : matchesOf(presXml, LIST_STYLE, 4).map((text): Input => ({
          text,
          args: { name: nameOf(text), ...withTheme(theme), parser: 'placeholder', noSrc: true },
        }))
  return distinctInputs([...fromParts, ...fromPresentation]).slice(0, 160)
}

function defRPrInputs(parts: Parts): Input[] {
  const contexts = partContexts(parts)
  const texts = [...contexts.map(({ xml }) => xml), parts.get(PRESENTATION) ?? '']
  const theme = contexts[0]?.c.theme
  return [...new Set(texts.flatMap((xml) => matchesOf(xml, DEF_RPR, 40)))]
    .slice(0, 100)
    .flatMap((text) => [
      { text, args: { name: 'a:defRPr', ...withTheme(theme) } },
      { text, args: { name: 'a:defRPr', ...withTheme(theme), phClr: '#ABCDEF' } },
    ])
}

const mediaArgs = (pairs: Array<[string, string]>): Args =>
  pairs.length ? { mediaRels: pairs } : {}

// ── Specs ─────────────────────────────────────────────────────────────

const resolveSpec = (name: string, resolve: (l: Layers) => unknown): CallSpec => ({
  fn: `pptxPlaceholder.placeholder.${name}`,
  call: (text, args) => resolve(layersOf(text, args)),
  fromDocument: placeholderInputs,
  built: RESOLVE_INPUTS,
})

const CONSTANTS: Record<string, unknown> = { MAX_AUTO_NUM_START }

export const PLACEHOLDER: CallSpec[] = [
  {
    fn: 'pptxPlaceholder.placeholder.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: ['MAX_AUTO_NUM_START', 'nothing', 'constructor', 'toString'].map((name) => ({
      args: { name },
    })),
    mutation: 'none',
  },
  {
    fn: 'pptxPlaceholder.placeholder.parsePlaceholderMap',
    call: (text, args) =>
      parsePlaceholderMap(text, args.theme as Theme | undefined, mediaOf(args.mediaRels)),
    fromDocument: (parts) => [
      ...partsOf(parts, LAYOUT_PART).flatMap(([path, text]) => {
        const c = contextOf(parts, path, related(parts, path, 'slideMaster'))
        return [{ text, args: { ...withTheme(c.theme), ...mediaArgs(c.layoutMedia) } }, { text }]
      }),
      ...partsOf(parts, MASTER_PART).flatMap(([path, text]) => {
        const c = contextOf(parts, undefined, path)
        return [{ text, args: { ...withTheme(c.theme), ...mediaArgs(c.masterMedia) } }, { text }]
      }),
    ],
    built: PH_MAP_INPUTS,
  },
  {
    fn: 'pptxPlaceholder.placeholder.parseDefRPrStyle',
    call: (text, args) =>
      parseDefRPrStyle(
        nodeOf(text, args),
        args.theme as Theme | undefined,
        args.phClr as string | undefined,
      ),
    fromDocument: defRPrInputs,
    built: DEF_RPR_INPUTS,
  },
  {
    fn: 'pptxPlaceholder.placeholder.parseLstStyleLevels',
    call: (text, args) => {
      const mediaRels = mediaOf(args.mediaRels)
      const src: LstStyleSource | undefined =
        args.noSrc === true
          ? undefined
          : {
              ...(mediaRels === undefined ? {} : { mediaRels }),
              ...(args.foreignPart === undefined ? {} : { foreignPart: args.foreignPart === true }),
            }
      return parseLstStyleLevels(nodeOf(text, args), args.theme as Theme | undefined, src)
    },
    fromDocument: lstStyleInputs,
    built: LST_INPUTS,
  },
  {
    fn: 'pptxPlaceholder.placeholder.parseDefaultTextStyle',
    call: (text, args) => parseDefaultTextStyle(text, args.theme as Theme | undefined),
    fromDocument: (parts) => {
      const text = parts.get(PRESENTATION)
      if (text === undefined) return []
      const themes = new Map<string, Theme>()
      for (const [path] of partsOf(parts, MASTER_PART)) {
        const theme = contextOf(parts, undefined, path).theme
        if (theme) themes.set(JSON.stringify(theme), theme)
      }
      return [{ text }, ...[...themes.values()].map((theme) => ({ text, args: { theme } }))]
    },
    built: DEFAULT_INPUTS,
  },
  {
    fn: 'pptxPlaceholder.placeholder.parseMasterTextStyles',
    call: (text, args) =>
      parseMasterTextStyles(text, args.theme as Theme | undefined, mediaOf(args.mediaRels)),
    fromDocument: (parts) =>
      partsOf(parts, MASTER_PART).flatMap(([path, text]) => {
        const c = contextOf(parts, undefined, path)
        return [{ text, args: { ...withTheme(c.theme), ...mediaArgs(c.masterMedia) } }, { text }]
      }),
    built: MASTER_INPUTS,
  },
  resolveSpec('resolvePlaceholderInsets', (l) =>
    resolvePlaceholderInsets(l.layout, l.master, l.type, l.idx),
  ),
  resolveSpec('resolvePlaceholderAnchor', (l) =>
    resolvePlaceholderAnchor(l.layout, l.master, l.type, l.idx),
  ),
  resolveSpec('resolvePlaceholderAnchorCtr', (l) =>
    resolvePlaceholderAnchorCtr(l.layout, l.master, l.type, l.idx),
  ),
  {
    ...resolveSpec('placeholderStyleChain', (l) =>
      placeholderStyleChain(l.layout, l.master, l.masterTx, l.type, l.idx),
    ),
    built: STYLE_CHAIN_INPUTS,
  },
  {
    fn: 'pptxPlaceholder.placeholder.mergeTextStyleChain',
    call: (_text, args) =>
      mergeTextStyleChain(args.chain as Array<TextStyleLevels | undefined>, args.level as number),
    fromDocument: chainInputs,
    built: MERGE_INPUTS,
    mutation: 'none',
  },
  resolveSpec('resolvePlaceholderFillSpPr', (l) =>
    resolvePlaceholderFillSpPr(l.layout, l.master, l.type, l.idx),
  ),
  resolveSpec('resolvePlaceholderTransform', (l) =>
    resolvePlaceholderTransform(l.layout, l.master, l.type, l.idx),
  ),
  resolveSpec('resolvePlaceholderPresetGeom', (l) =>
    resolvePlaceholderPresetGeom(l.layout, l.master, l.type, l.idx),
  ),
]
