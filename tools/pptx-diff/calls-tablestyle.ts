// Group `tablestyle` of comparison (f): table-style.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_tablestyle.rs to
// `pptxTablestyle.table-style.<TypeScript name>`.
import { xmlParser } from '../../packages/pptx-engine/src/xml-parser'
import { tableRowGridCols } from '../../packages/pptx-engine/src/table-grid'
import {
  BUILTIN_TABLE_STYLES,
  builtinTableStyleName,
  cellPartStyle,
  cellStyleBorders,
  LEGACY_NO_STYLE,
  resolveBuiltinTableStyleId,
  resolveTableStyle,
  type TableStyleDef,
  type TableStyleFlags,
} from '../../packages/pptx-engine/src/table-style'
import { parseClrMap, parseTheme, type Theme } from '../../packages/pptx-engine/src/theme'
import { asXmlNode, xmlArray, type XmlNode } from '../../packages/pptx-engine/src/xml-utils'
import { relsPathFor, resolveTarget } from '../../packages/pptx-engine/src/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

type Args = Record<string, unknown>
type Parts = ReadonlyMap<string, string>

/** A value as it reaches Rust: keys that hold undefined are gone. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The parser of packages/pptx-engine/src/parse.ts, which reads the tables. */
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

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const JPAN = '\u6E38\u30B4\u30B7\u30C3\u30AF'
const HANG = '\uB9D1\uC740 \uACE0\uB515'

// ── Themes ────────────────────────────────────────────────────────────

const SLOTS = [
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
]
const srgbSlot = (val: string): string => `<a:srgbClr val="${val}"/>`
const clrScheme = (colors: string[]): string =>
  `<a:clrScheme name="T">${SLOTS.map((key, i) => `<a:${key}>${colors[i]}</a:${key}>`).join('')}</a:clrScheme>`
const OFFICE = clrScheme([
  '<a:sysClr val="windowText" lastClr="000000"/>',
  '<a:sysClr val="window" lastClr="FFFFFF"/>',
  ...[
    '44546A',
    'E7E6E6',
    '4472C4',
    'ED7D31',
    'A5A5A5',
    'FFC000',
    '5B9BD5',
    '70AD47',
    '0563C1',
    '954F72',
  ].map(srgbSlot),
])
const SECOND = clrScheme(
  [
    '1F2D3D',
    'F7F3E8',
    '2C3E50',
    'ECF0F1',
    'C0504D',
    '9BBB59',
    '8064A2',
    '4BACC6',
    'F79646',
    '2C4D75',
    '0000FF',
    '800080',
  ].map(srgbSlot),
)
const LN_STYLES =
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"/></a:lnStyleLst>'
const ODD_LN_STYLES =
  '<a:lnStyleLst><a:ln/><a:ln w="abc"/><a:ln w="0"/><a:ln w="-3175"/><a:prstDash val="solid"/></a:lnStyleLst>'
const fmtScheme = (lnStyles: string): string =>
  '<a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  lnStyles +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
const themeXml = (elements: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<a:theme ${A_NS} name="T"><a:themeElements>${elements}</a:themeElements></a:theme>`

const T_OFFICE = wire(parseTheme(themeXml(OFFICE + fmtScheme(LN_STYLES))))
const T_SECOND = wire(parseTheme(themeXml(SECOND + fmtScheme(ODD_LN_STYLES))))
/** A dark master: bg and tx swapped, accent1 and accent2 swapped. */
const T_MAPPED = wire({
  ...T_OFFICE,
  clrMap: parseClrMap(
    `<p:sldMaster ${A_NS} ${P_NS}><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent2" accent2="accent1" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`,
  ),
})
/** Colours that are not `#RRGGBB`: empty, short, signed, prefixed, astral. */
const T_ODD = wire({
  colors: {
    dk1: '#12',
    lt1: 'FFFFFF',
    dk2: '',
    lt2: '#0x1F2F3F',
    accent1: '',
    accent2: 'zz',
    accent3: '#-A-B-C',
    accent4: '##ABCDEF',
    accent5: '#4472c4',
    accent6: '#\uD83D\uDE00AB12',
    hlink: '#ABCDEF80',
    folHlink: ' #FFFFFF',
  },
  lnStyles: [
    { 'a:ln': { '@_w': '9525' } },
    { 'a:ln': {} },
    { 'a:ln': [{ '@_w': '1' }, { '@_w': '2' }] },
    {},
  ],
} as unknown as Theme)
const T_NO_COLORS = wire({ colors: {} } as unknown as Theme)
const THEMES: Array<Theme | undefined> = [
  undefined,
  T_OFFICE,
  T_SECOND,
  T_MAPPED,
  T_ODD,
  T_NO_COLORS,
]

const withTheme = (theme: Theme | undefined): Args => (theme === undefined ? {} : { theme })

// ── tableStyles.xml ───────────────────────────────────────────────────

const MEDIUM2_A1 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'
const THEMED2 = '{5940675A-B579-460E-94D1-54222C63F5DA}'
const LIGHT1 = '{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}'
const cid = (n: number): string => `{A0000000-0000-4000-8000-${String(n).padStart(12, '0')}}`

const el = (tag: string, inner = '', attrs = ''): string =>
  inner ? `<a:${tag}${attrs}>${inner}</a:${tag}>` : `<a:${tag}${attrs}/>`
const sf = (color: string): string => `<a:solidFill>${color}</a:solidFill>`
const sch = (val: string, mods = ''): string =>
  mods ? `<a:schemeClr val="${val}">${mods}</a:schemeClr>` : `<a:schemeClr val="${val}"/>`
const rgb = (val: string, mods = ''): string =>
  mods ? `<a:srgbClr val="${val}">${mods}</a:srgbClr>` : `<a:srgbClr val="${val}"/>`
const prst = (val: string): string => `<a:prstClr val="${val}"/>`
const mod = (name: string, val: string): string => `<a:${name} val="${val}"/>`
const ln = (w: string | undefined, inner: string): string =>
  `<a:ln${w === undefined ? '' : ` w="${w}"`}>${inner}</a:ln>`
const lnRef = (idx: string | undefined, inner: string): string =>
  `<a:lnRef${idx === undefined ? '' : ` idx="${idx}"`}>${inner}</a:lnRef>`
const tcStyle = (borders: string, fill = ''): string =>
  el('tcStyle', (borders ? el('tcBdr', borders) : '') + (fill ? el('fill', sf(fill)) : ''))
const font = (latin?: string, ea?: string, cs?: string): string =>
  el(
    'font',
    (
      [
        ['latin', latin],
        ['ea', ea],
        ['cs', cs],
      ] as Array<[string, string | undefined]>
    )
      .filter(([, face]) => face !== undefined)
      .map(([tag, face]) => `<a:${tag} typeface="${face}"/>`)
      .join(''),
  )
const tblStyle = (id: string, body: string, name = 'Custom'): string =>
  body
    ? `<a:tblStyle styleId="${id}" styleName="${name}">${body}</a:tblStyle>`
    : `<a:tblStyle styleId="${id}" styleName="${name}"/>`
const tblStyleLst = (styles: string, def = MEDIUM2_A1): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<a:tblStyleLst ${A_NS} def="${def}">${styles}</a:tblStyleLst>`

/** Every part, every border form, a direct and a referenced background. */
const FULL = tblStyle(
  cid(1),
  el('tblBg', el('fill', sf(rgb('F2F2F2'))) + el('fillRef', sch('accent1'), ' idx="2"')) +
    el(
      'wholeTbl',
      el(
        'tcTxStyle',
        el('fontRef', sch('dk1'), ' idx="minor"') + font('Arial', JPAN, 'Arial') + sch('dk1'),
        ' b="on"',
      ) +
        tcStyle(
          el('left', ln('12700', sf(rgb('000000')))) +
            el('right', ln('0', sf(sch('accent2')))) +
            el('top', ln('25400.7', sf(sch('accent3', mod('lumMod', '75000'))))) +
            el('bottom', ln('-5', sf(prst('black')))) +
            el('insideH', lnRef('1', sch('accent1'))) +
            el('insideV', lnRef('3', rgb('C00000'))),
          sch('accent1', mod('tint', '20000')),
        ),
    ) +
    el('band1H', tcStyle('', rgb('4472C4', mod('alpha', '50000')))) +
    el('band2H', tcStyle('', sch('accent2', mod('lumMod', '75000') + mod('lumOff', '25000')))) +
    el('band1V', tcStyle('', prst('white'))) +
    el('band2V', tcStyle('', prst('black'))) +
    el(
      'firstRow',
      el('tcTxStyle', el('fontRef', '', ' idx="major"') + sch('lt1'), ' b="on"') +
        tcStyle('', sch('accent1')),
    ) +
    el(
      'lastRow',
      el('tcTxStyle', rgb('ff0000'), ' b="off"') +
        tcStyle('', sch('accent1', mod('shade', '50000'))),
    ) +
    el('firstCol', el('tcTxStyle', font('Calibri'))) +
    el(
      'lastCol',
      el('tcTxStyle', '<a:sysClr val="windowText" lastClr="000000"/>') +
        tcStyle('', '<a:scrgbClr r="0" g="0" b="0"/>'),
    ),
)

/** Lines that are off, colourless, of odd width, and an ln beside an lnRef. */
const NO_FILL = tblStyle(
  cid(2),
  el(
    'wholeTbl',
    el('tcTxStyle') +
      tcStyle(
        el('left', ln('12700', '<a:noFill/>' + sf(rgb('FF0000')))) +
          el('right', ln('12700', '')) +
          el('top', ln('abc', sf(prst('black')))) +
          el('bottom', ln(undefined, sf(rgb('00FF00')))) +
          el('insideH', ln('3175', sf(rgb('0000FF'))) + lnRef('2', rgb('FF00FF'))) +
          el('insideV', lnRef('0', sch('accent4'))),
        sch('phClr'),
      ),
  ),
)

/** Theme line styles by every index form. */
const LN_REFS = tblStyle(
  cid(3),
  el(
    'wholeTbl',
    tcStyle(
      el('left', lnRef('2', sch('accent5'))) +
        el('right', lnRef('4', sch('accent6'))) +
        el('top', lnRef('x', rgb('123456'))) +
        el('bottom', lnRef(undefined, rgb('654321'))) +
        el('insideH', lnRef('1', '')) +
        el('insideV', lnRef('-1', sch('bg1'))),
    ),
  ) + el('band1H', tcStyle('', sch('tx2'))),
)

/** Repeated parts and edges (arrays), a part that is text, an empty part. */
const ARRAYS = tblStyle(
  cid(4),
  el('firstRow', tcStyle('', rgb('111111'))) +
    el('band1H', 'text') +
    el('band2H') +
    el(
      'wholeTbl',
      el('tcTxStyle', rgb('333333'), ' b="on"') +
        el('tcTxStyle', rgb('444444')) +
        el(
          'tcStyle',
          el('fill', sf(rgb('555555')) + sf(rgb('666666'))) +
            el(
              'tcBdr',
              el('left', ln('100', sf(rgb('777777'))) + ln('200', sf(rgb('888888')))) +
                el('right', ln('300', sf(rgb('999999')))),
            ),
        ),
    ) +
    el('firstRow', tcStyle('', rgb('222222'))) +
    el('lastRow', tcStyle('', rgb('AAAAAA'))),
)

/** Every colour element form readColor meets. */
const COLORS = tblStyle(
  cid(5),
  el(
    'wholeTbl',
    el('tcTxStyle', el('fontRef', '', ' idx="none"') + '<a:font x="1"/>' + prst('white')),
  ) +
    el('band1H', tcStyle('', '<a:srgbClr lastClr="1"/>')) +
    el('band2H', tcStyle('', '<a:srgbClr>5</a:srgbClr>')) +
    el('band1V', tcStyle('', '<a:srgbClr>0</a:srgbClr>' + sch('accent6'))) +
    el('band2V', el('tcTxStyle', sch('constructor'), ' b="on"') + tcStyle('', sch('unknown'))) +
    el(
      'firstRow',
      el('tcTxStyle', el('fontRef', '', ' idx="major"') + sch('phClr')) + tcStyle('', prst('red')),
    ) +
    el(
      'lastRow',
      el('tcTxStyle', sch('tx1', mod('satMod', '120000'))) +
        tcStyle(
          '',
          rgb('80ff00', mod('lumMod', '50000') + mod('lumOff', '10000') + mod('alpha', '30000')),
        ),
    ) +
    el(
      'firstCol',
      el('tcTxStyle', '', ' b="1"') + el('tcStyle', el('fill', '<a:solidFill>x</a:solidFill>')),
    ) +
    el('lastCol', tcStyle('', rgb('010203') + rgb('040506'))),
)

/** Typefaces: astral, an entity, empty, a subset, the attributes in another order. */
const FONTS = tblStyle(
  cid(6),
  el('wholeTbl', el('tcTxStyle', font('\uD835\uDC00', 'A&amp;B', ''), ' b="on"')) +
    el('firstRow', el('tcTxStyle', font(undefined, HANG))) +
    el('lastRow', el('tcTxStyle', el('font', '<a:cs typeface="Cs"/><a:latin typeface="La"/>'))),
)

const QUOTES =
  `<a:tblStyle styleName='Q' styleId='${cid(7)}'><a:wholeTbl><a:tcTxStyle b='on'><a:srgbClr val='abcdef'/>` +
  `</a:tcTxStyle><a:tcStyle><a:tcBdr><a:insideH><a:ln w='9525'><a:solidFill><a:srgbClr val='ABCDEF'/></a:solidFill>` +
  `</a:ln></a:insideH></a:tcBdr></a:tcStyle></a:wholeTbl></a:tblStyle>`

const DUPLICATES =
  tblStyle(cid(8), el('wholeTbl', tcStyle('', rgb('111111')))) +
  tblStyle(cid(8), el('wholeTbl', tcStyle('', rgb('222222'))))

const BACKGROUNDS =
  tblStyle(
    cid(11),
    el('tblBg', el('fill', sf(sch('accent2'))) + el('fillRef', sch('accent1'), ' idx="0"')),
  ) +
  tblStyle(cid(12), el('tblBg', el('fillRef', '', ' idx="1001"'))) +
  tblStyle(cid(13), el('tblBg', el('fillRef', sch('accent3'), ' idx="x"'))) +
  tblStyle(cid(14), el('tblBg') + el('wholeTbl', el('tcTxStyle', '', ' b="on"'))) +
  tblStyle(cid(15), el('tblBg', el('fillRef', sch('phClr')))) +
  tblStyle(
    cid(16),
    el('tblBg', el('fill', sf(rgb('ABCDEF'))) + el('fillRef', prst('black'), ' idx="3"')),
  )

const OTHERS =
  tblStyle(cid(17), '', 'Empty') +
  tblStyle(MEDIUM2_A1, el('wholeTbl', tcStyle('', rgb('123456'))), 'Override') +
  tblStyle(LIGHT1, '', 'Empty built-in') +
  tblStyle(cid(19), el('wholeTbl', el('tcTxStyle', '', ' b="on"')), `Named ${cid(18)}`) +
  tblStyle(cid(20).toLowerCase(), el('wholeTbl', tcStyle('', rgb('202020')))) +
  // a color written in lower case: the model holds it in upper case
  tblStyle(cid(21), el('wholeTbl', tcStyle('', rgb('a0b1c2')))) +
  // upper-casing before the hex pairs are cut matters only where it changes
  // the length: 'ß' becomes 'SS' and shifts every pair after it
  tblStyle(cid(22), el('wholeTbl', tcStyle('', rgb('ß0a0b0'))))

const CUSTOM_XML = tblStyleLst(
  FULL + NO_FILL + LN_REFS + ARRAYS + COLORS + FONTS + QUOTES + DUPLICATES + BACKGROUNDS + OTHERS,
)
const CUSTOM_IDS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(cid),
  cid(20).toLowerCase(),
  cid(21),
  cid(22),
  MEDIUM2_A1,
  LIGHT1,
]

const DEFAULT_LIST = tblStyleLst('')
const SELF_CLOSING_LIST = `<a:tblStyleLst ${A_NS} def="${MEDIUM2_A1}"/>`

/** Texts the parser refuses or reads into another shape. */
const BROKEN_XML = [
  tblStyleLst(FULL).slice(0, -1),
  `<a:tblStyleLst ${A_NS}><!-- ${FULL}`,
  tblStyleLst(FULL) + `<a:tblStyleLst><a:tblStyle styleId="${cid(1)}"/></a:tblStyleLst>`,
  `<tblStyleLst><tblStyle styleId="${cid(1)}"><wholeTbl><tcTxStyle b="on"/></wholeTbl></tblStyle></tblStyleLst>`,
  `<a:tblStyleLst ${A_NS}><a:tblStyle styleId="${cid(1)}"><a:wholeTbl><a:tcTxStyle b="on"></a:wholeTbl></a:tblStyle></a:tblStyleLst>`,
  `${cid(1)} ${MEDIUM2_A1}`,
]

/** Names every object inherits. */
const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
const INHERITED_XML = tblStyleLst(
  tblStyle('constructor', el('wholeTbl', tcStyle('', rgb('ABCDEF')))) +
    tblStyle(
      cid(21),
      el('wholeTbl', el('tcTxStyle', '', ' b="on"')),
      'toString __proto__ hasOwnProperty valueOf',
    ),
)

const BUILTIN_IDS = BUILTIN_TABLE_STYLES.map((s) => s.id)
const BUILTIN_TEXTS = ['', DEFAULT_LIST, CUSTOM_XML]

const RESOLVE_INPUTS: Input[] = [
  ...BUILTIN_IDS.flatMap((styleId, i) =>
    THEMES.map((theme, j) => ({
      text: BUILTIN_TEXTS[(i + j) % BUILTIN_TEXTS.length]!,
      args: { styleId, ...withTheme(theme) },
    })),
  ),
  ...CUSTOM_IDS.flatMap((styleId) =>
    THEMES.slice(0, 5).map((theme) => ({
      text: CUSTOM_XML,
      args: { styleId, ...withTheme(theme) },
    })),
  ),
  ...[
    LEGACY_NO_STYLE,
    LEGACY_NO_STYLE.toLowerCase(),
    MEDIUM2_A1.toLowerCase(),
    ` ${MEDIUM2_A1}`,
    cid(99),
    'x',
    '{}',
  ].flatMap((styleId) => [
    { text: '', args: { styleId, theme: T_OFFICE } },
    { text: CUSTOM_XML, args: { styleId, theme: T_OFFICE } },
  ]),
  ...[MEDIUM2_A1, cid(1), LEGACY_NO_STYLE, ''].map((styleId) => ({
    text: CUSTOM_XML,
    args: { styleId, noXml: true, theme: T_OFFICE },
  })),
  { text: CUSTOM_XML, args: { theme: T_OFFICE } },
  { text: CUSTOM_XML, args: { styleId: '', theme: T_OFFICE } },
  ...[SELF_CLOSING_LIST, DEFAULT_LIST].map((text) => ({
    text,
    args: { styleId: MEDIUM2_A1, theme: T_SECOND },
  })),
  ...BROKEN_XML.flatMap((text) =>
    [cid(1), MEDIUM2_A1].map((styleId) => ({ text, args: { styleId, theme: T_OFFICE } })),
  ),
  // ledger inherited-key-table-style-477: `BUILTIN[styleId]` finds these on
  // Object.prototype, builtinStyle falls out of its switch with undefined,
  // and reading `def.wholeTbl` throws a TypeError. Rust: undefined (no
  // style). `constructor` with INHERITED_XML is the part's own definition.
  ...INHERITED.flatMap((styleId): Input[] => [
    { text: '', args: { styleId, theme: T_OFFICE }, seed: false },
    { text: DEFAULT_LIST, args: { styleId }, seed: false },
    { text: INHERITED_XML, args: { styleId, theme: T_OFFICE }, seed: false },
  ]),
]

// ── Cells ─────────────────────────────────────────────────────────────

const FLAG_NAMES = ['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol'] as const
const flagsOf = (bits: number): TableStyleFlags =>
  Object.fromEntries(
    FLAG_NAMES.map((name, i) => [name, (bits & (1 << i)) !== 0]),
  ) as unknown as TableStyleFlags
const EVERY_FLAGS = Array.from({ length: 64 }, (_, bits) => flagsOf(bits))
const FEW_FLAGS = [0, 63, 0b010001, 0b101100, 0b010010, 0b110101].map(flagsOf)

/** `[nRows, nCols, with positions outside and between cells]` */
type TableShape = [number, number, boolean]

function positionsOf([nRows, nCols, extras]: TableShape): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) out.push([r, c])
  if (extras) {
    out.push(
      [-1, 0],
      [0, -1],
      [nRows, nCols - 1],
      [nRows - 1, nCols],
      [0.5, 0],
      [1.5, 1.5],
      [-2, -3],
      [nRows - 0.5, nCols - 1],
    )
  }
  return out
}

const cellInputs = (
  def: TableStyleDef,
  flagsList: TableStyleFlags[],
  shapes: TableShape[],
): Input[] =>
  flagsList.flatMap((flags) =>
    shapes.flatMap((shape) =>
      positionsOf(shape).map(([r, c]) => ({
        args: { def, flags, r, c, nRows: shape[0], nCols: shape[1] },
      })),
    ),
  )

const solid = (color: string) => ({ type: 'solid', color })
const stroke = (color: string, width: number) => ({ fill: solid(color), width })

/** Every part distinct, keys in orders no literal writes, bold false. */
const PROBE = wire({
  wholeTbl: { textColor: '#000001', fontRef: 'minor', bold: false },
  band1H: { fill: solid('#B1H000'), textColor: '#000002' },
  band2H: { textColor: '#000003', fill: solid('#B2H000') },
  band1V: { bold: true, fill: solid('#B1V000') },
  band2V: { font: { ea: 'E', latin: 'L' }, textColor: '#000004' },
  firstRow: { textColor: '#000005', fill: solid('#FR0000'), bold: true, font: { latin: 'F' } },
  lastRow: { bold: true, textColor: '#000006' },
  firstCol: { fill: solid('#FC0000'), fontRef: 'major' },
  lastCol: { textColor: '#000007' },
  insideH: stroke('#0000A1', 1),
  insideV: stroke('#0000A2', 2),
  outer: {
    l: stroke('#0000A3', 3),
    r: stroke('#0000A4', 4),
    t: stroke('#0000A5', 5),
    b: stroke('#0000A6', 6),
  },
  firstRowBottom: stroke('#0000A7', 7),
  lastRowTop: stroke('#0000A8', 8),
}) as unknown as TableStyleDef

/** Second bands only, no whole table, half an outer border. */
const PROBE_2 = wire({
  band2H: { textColor: '#000003' },
  band2V: { fill: solid('#B2V000') },
  insideV: stroke('#0000A2', 2),
  outer: { r: stroke('#0000A4', 4), b: stroke('#0000A6', 6) },
  firstRowBottom: stroke('#0000A7', 7),
}) as unknown as TableStyleDef

const resolvedDef = (
  styleId: string,
  xml: string | undefined,
  theme: Theme | undefined,
): TableStyleDef => wire(resolveTableStyle(styleId, xml, theme) ?? {})

const CELL_DEFS: TableStyleDef[] = [
  ...[
    '{3C2FFA5D-87B4-456A-9821-1D502468CF0F}',
    THEMED2,
    '{18603FDC-E32A-4AB5-989C-0864C3EAD2B8}',
    LIGHT1,
    '{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}',
    '{8799B23B-EC83-4686-B30A-512413B5E67A}',
    '{1E171933-4619-4E11-9A3F-F7608DF75F80}',
    '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}',
    '{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}',
    '{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}',
    '{E8034E78-7F5D-4C2E-B375-FC64B27BC917}',
    '{125E5076-3810-47DD-B79F-674D7AD40C01}',
    '{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}',
  ].map((styleId) => resolvedDef(styleId, undefined, T_OFFICE)),
  ...[1, 2, 3, 5, 6].map((n) => resolvedDef(cid(n), CUSTOM_XML, T_OFFICE)),
  PROBE_2,
  wire({}),
  wire({ outer: {} }) as unknown as TableStyleDef,
]

const CELL_INPUTS: Input[] = [
  ...cellInputs(PROBE, EVERY_FLAGS, [
    [1, 1, false],
    [1, 4, false],
    [4, 1, false],
    [5, 4, true],
    [0, 0, true],
  ]),
  ...CELL_DEFS.flatMap((def) =>
    cellInputs(def, FEW_FLAGS, [
      [1, 1, false],
      [1, 3, false],
      [3, 1, false],
      [4, 5, true],
    ]),
  ),
]

// ── Style ids and names ───────────────────────────────────────────────

const ID_INPUTS: Input[] = [
  ...BUILTIN_IDS,
  ...BUILTIN_IDS.slice(0, 20).map((id) => id.toLowerCase()),
  ...BUILTIN_IDS.slice(20, 30).map((id) => `\t${id}\n`),
  `\uFEFF${MEDIUM2_A1}\u00A0`,
  `\u3000${MEDIUM2_A1.toLowerCase()}`,
  MEDIUM2_A1.slice(0, -2) + '}',
  MEDIUM2_A1.slice(0, -1) + 'A}',
  MEDIUM2_A1.replace('5', 'G'),
  `{${'-'.repeat(36)}}`,
  `{${'0'.repeat(36)}}`,
  LEGACY_NO_STYLE,
  cid(1),
  '',
  '   ',
].map((text) => ({ text }))

const NAMES = BUILTIN_TABLE_STYLES.map((s) => s.name)
const NAME_INPUTS: Input[] = [
  ...NAMES,
  ...NAMES.map((name) => name.toUpperCase()),
  ...NAMES.slice(0, 30).map((name) => name.toLowerCase().replace(/ /g, '  ')),
  ...NAMES.slice(30).map((name) => ` ${name.replace(/ - /g, '\t-\u00A0')}\n`),
  ...[1, 2, 3, 4, 5, 6, 7, 0].map((n) => `Dark Style 2 - Accent ${n}`),
  'dark style 2 - accent 1/accent 2',
  'Dark Style 2 - Accent 2/Accent 3',
  'Dark Style 2 - Accent 02',
  'Dark Style 2 - Accent 2.0',
  'Dark Style 2',
  'DAR\u212A STYLE 1',
  'MED\u0130UM STYLE 1',
  'Light Style 1\u2028- Accent 1',
  'Light Style 1 \uD83D\uDE00',
  'no style,  no grid',
  'No Style,Table Grid',
  'Themed Style 1 - Accent 0',
  'Medium Style 2 - Accent',
].map((text) => ({ text }))

// ── The corpus ────────────────────────────────────────────────────────

const THEME_PART = /^ppt\/theme\/theme\d+\.xml$/
const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/
const TABLE_STYLES_PART = 'ppt/tableStyles.xml'
const TABLE = /<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g
const STYLE_ID = /<a:tableStyleId>([^<]*)<\/a:tableStyleId>/g

/** The part the first relationship of `type` of `part` names, where the deck has it. */
function related(parts: Parts, part: string | undefined, type: string): string | undefined {
  const rels = part === undefined ? undefined : parts.get(relsPathFor(part))
  if (part === undefined || rels === undefined) return undefined
  for (const [rel] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!rel.includes(`/relationships/${type}"`)) continue
    const target = /\bTarget="([^"]*)"/.exec(rel)?.[1]
    const path = target === undefined ? '' : resolveTarget(part, target)
    if (path && parts.has(path)) return path
  }
  return undefined
}

function parsedTheme(xml: string | undefined): Theme | undefined {
  if (xml === undefined) return undefined
  try {
    return parseTheme(xml)
  } catch {
    return undefined
  }
}

/** Each slide with the master's theme and the chain's clrMap, as index.ts assigns it. */
function slidesOf(parts: Parts): Array<{ xml: string; theme?: Theme }> {
  const firstTheme = [...parts].find(([path]) => THEME_PART.test(path))?.[1]
  return [...parts]
    .filter(([path]) => SLIDE_PART.test(path))
    .map(([path, xml]) => {
      const layout = related(parts, path, 'slideLayout')
      const master = related(parts, layout, 'slideMaster')
      const themePath = related(parts, master, 'theme')
      const theme = parsedTheme(themePath === undefined ? firstTheme : parts.get(themePath))
      const masterXml = master === undefined ? undefined : parts.get(master)
      const layoutXml = layout === undefined ? undefined : parts.get(layout)
      return {
        xml,
        theme: theme && wire({ ...theme, clrMap: parseClrMap(masterXml, layoutXml, xml) }),
      }
    })
}

/** The distinct themes the deck's slides are read with, and each theme part as it is. */
function themesOf(parts: Parts): Theme[] {
  const seen = new Map<string, Theme>()
  const add = (theme: Theme | undefined): void => {
    if (theme) seen.set(JSON.stringify(theme), theme)
  }
  for (const { theme } of slidesOf(parts)) add(theme)
  for (const [path, xml] of parts) {
    const theme = THEME_PART.test(path) ? parsedTheme(xml) : undefined
    if (theme) add(wire(theme))
  }
  return [...seen.values()]
}

/** `xsdBool` of parse.ts. */
const xsdBool = (v: unknown): boolean => {
  const s = String(v ?? '').toLowerCase()
  return s === '1' || s === 'true'
}

interface FoundTable {
  /** The id parseTable resolves: its own, else the grid style where no cell draws a line. */
  styleId?: string
  flags: TableStyleFlags
  nRows: number
  nCols: number
  /** `[r, c]` of each cell, `c` its grid column as tableRowGridCols counts it. */
  cells: Array<[number, number]>
}

/** Every table of a slide, read as parseTable reads it. */
function tablesOf(xml: string): FoundTable[] {
  const out: FoundTable[] = []
  for (const [fragment] of xml.matchAll(TABLE)) {
    let tree: XmlNode
    try {
      tree = asXmlNode(parseTsParser.parse(fragment))
    } catch {
      continue
    }
    const tbl = asXmlNode(tree['a:tbl'])
    const gridCols = xmlArray(asXmlNode(tbl['a:tblGrid'])['a:gridCol'])
    const trs = xmlArray(tbl['a:tr'])
    if (!gridCols.length || !trs.length) continue
    const tblPr = asXmlNode(tbl['a:tblPr'])
    const styleIdRaw = tblPr['a:tableStyleId']
    const styleId =
      typeof styleIdRaw === 'string'
        ? styleIdRaw
        : (asXmlNode(styleIdRaw)['#text'] as string | undefined)
    const cellsDefineLines = trs.some((tr) =>
      xmlArray(tr['a:tc']).some((tc) =>
        ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'].some((k) => asXmlNode(tc['a:tcPr'])[k] !== undefined),
      ),
    )
    const cells = trs.flatMap((tr, r): Array<[number, number]> => {
      const cols = tableRowGridCols(
        xmlArray(tr['a:tc']).map((tc) => ({
          gridSpan: tc['@_gridSpan'] ? parseInt(String(tc['@_gridSpan']), 10) || 1 : 1,
          merged: xsdBool(tc['@_hMerge']) || xsdBool(tc['@_vMerge']),
        })),
      )
      return cols.map((c): [number, number] => [r, c])
    })
    out.push({
      styleId: styleId ?? (cellsDefineLines ? undefined : THEMED2),
      flags: {
        firstRow: xsdBool(tblPr['@_firstRow']),
        lastRow: xsdBool(tblPr['@_lastRow']),
        firstCol: xsdBool(tblPr['@_firstCol']),
        lastCol: xsdBool(tblPr['@_lastCol']),
        bandRow: xsdBool(tblPr['@_bandRow']),
        bandCol: xsdBool(tblPr['@_bandCol']),
      },
      nRows: trs.length,
      nCols: gridCols.length,
      cells,
    })
  }
  return out
}

/** Every style id a deck names: in its slides, and defined or defaulted in tableStyles.xml. */
function styleIdsOf(parts: Parts): string[] {
  const ids = new Set<string>()
  for (const { xml } of slidesOf(parts)) for (const m of xml.matchAll(STYLE_ID)) ids.add(m[1]!)
  const styles = parts.get(TABLE_STYLES_PART) ?? ''
  for (const m of styles.matchAll(/\b(?:styleId|def)="([^"]*)"/g)) ids.add(m[1]!)
  return [...ids]
}

const CORPUS_CELL_CAP = 400

function cellsFromDocument(parts: Parts): Input[] {
  const xml = parts.get(TABLE_STYLES_PART)
  const out: Input[] = []
  for (const { xml: slideXml, theme } of slidesOf(parts)) {
    for (const table of tablesOf(slideXml)) {
      let def: TableStyleDef | undefined
      try {
        def = resolveTableStyle(table.styleId, xml, theme)
      } catch {
        continue
      }
      if (!def) continue
      const wired = wire(def)
      const { flags, nRows, nCols } = table
      const positions = new Map<string, [number, number]>()
      for (const cell of table.cells) positions.set(cell.join(), cell)
      for (const cell of positionsOf([nRows, nCols, false])) positions.set(cell.join(), cell)
      for (const [r, c] of positions.values()) {
        if (out.length >= CORPUS_CELL_CAP) return out
        out.push({ args: { def: wired, flags, r, c, nRows, nCols } })
      }
    }
  }
  return out
}

// ── Specs ─────────────────────────────────────────────────────────────

export const TABLESTYLE: CallSpec[] = [
  {
    fn: 'pptxTablestyle.table-style.BUILTIN_TABLE_STYLES',
    call: (_text, args) => BUILTIN_TABLE_STYLES[args.index as number],
    built: [...Array.from({ length: 74 }, (_, i) => i), 74, 75, -1, 1.5, 1e9].map((index) => ({
      args: { index },
    })),
    mutation: 'none',
  },
  {
    fn: 'pptxTablestyle.table-style.BUILTIN_TABLE_STYLES.length',
    call: (text) =>
      text === ''
        ? BUILTIN_TABLE_STYLES.length
        : BUILTIN_TABLE_STYLES.filter((s) => s.family === text).length,
    built: [
      '',
      'themed1',
      'themed2',
      'light1',
      'light2',
      'light3',
      'medium1',
      'medium2',
      'medium3',
      'medium4',
      'dark1',
      'dark2',
      'Dark2',
      'unknown',
    ].map((text) => ({ text })),
    mutation: 'none',
  },
  {
    fn: 'pptxTablestyle.table-style.LEGACY_NO_STYLE',
    call: (text) => (text === 'LEGACY_NO_STYLE' ? LEGACY_NO_STYLE : undefined),
    built: ['LEGACY_NO_STYLE', '', LEGACY_NO_STYLE].map((text) => ({ text })),
    mutation: 'none',
  },
  {
    fn: 'pptxTablestyle.table-style.builtinTableStyleName',
    call: (text, args) => builtinTableStyleName(args.undefined === true ? undefined : text),
    fromDocument: (parts) => styleIdsOf(parts).map((text) => ({ text })),
    built: [
      ...ID_INPUTS,
      { text: '', args: { undefined: true } },
      ...NAMES.slice(0, 5).map((text) => ({ text })),
      // ledger inherited-key-table-style-206: `BUILTIN[styleId]` answers
      // these from the prototype; no prototype value has a `family`, so
      // builtinName returns FAMILY_LABEL[undefined], undefined: the two
      // sides agree.
      ...INHERITED.map((text): Input => ({ text, seed: false })),
    ],
  },
  {
    fn: 'pptxTablestyle.table-style.resolveBuiltinTableStyleId',
    call: (text) => resolveBuiltinTableStyleId(text),
    fromDocument: (parts) =>
      styleIdsOf(parts).flatMap((id) => {
        const name = builtinTableStyleName(id)
        return name === undefined ? [{ text: id }] : [{ text: id }, { text: name }]
      }),
    built: [
      ...ID_INPUTS,
      ...NAME_INPUTS,
      // ledger inherited-key-table-style-218: `BUILTIN[upper]` is reached
      // only by a key the GUID pattern matched, which no inherited name
      // does: the two sides agree.
      ...[...INHERITED, '{constructor}'].map((text): Input => ({ text, seed: false })),
    ],
  },
  {
    fn: 'pptxTablestyle.table-style.resolveTableStyle',
    call: (text, args) =>
      resolveTableStyle(
        args.styleId as string | undefined,
        args.noXml === true ? undefined : text,
        args.theme as Theme | undefined,
      ),
    fromDocument: (parts) => {
      const stylesXml = parts.get(TABLE_STYLES_PART)
      const text = stylesXml ?? ''
      const args: Args = stylesXml === undefined ? { noXml: true } : {}
      const fromSlides = slidesOf(parts).flatMap(({ xml, theme }) =>
        tablesOf(xml).map((table) => ({
          text,
          args: {
            ...args,
            ...(table.styleId === undefined ? {} : { styleId: table.styleId }),
            ...withTheme(theme),
          },
        })),
      )
      const themes = themesOf(parts)
      const fromPart = styleIdsOf(parts).flatMap((styleId) =>
        [undefined, ...themes].map((theme) => ({
          text,
          args: { ...args, styleId, ...withTheme(theme) },
        })),
      )
      return [...fromSlides, ...fromPart]
    },
    built: RESOLVE_INPUTS,
  },
  {
    fn: 'pptxTablestyle.table-style.cellStyleBorders',
    call: (_text, args) =>
      cellStyleBorders(
        args.def as TableStyleDef,
        args.flags as TableStyleFlags,
        args.r as number,
        args.c as number,
        args.nRows as number,
        args.nCols as number,
      ),
    fromDocument: cellsFromDocument,
    built: CELL_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'pptxTablestyle.table-style.cellPartStyle',
    call: (_text, args) =>
      cellPartStyle(
        args.def as TableStyleDef,
        args.flags as TableStyleFlags,
        args.r as number,
        args.c as number,
        args.nRows as number,
        args.nCols as number,
      ),
    fromDocument: cellsFromDocument,
    built: CELL_INPUTS,
    mutation: 'none',
  },
]
