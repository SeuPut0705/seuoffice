// Group `theme` of comparison (f): theme.ts and color.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_theme.rs to `pptxTheme.<module>.<TypeScript name>`.
import { xmlParser } from '../../packages/pptx-engine/src/xml-parser'
import {
  applyColorMods,
  hexToRgb,
  resolveColorNode,
  scaleLuminance,
} from '../../packages/pptx-engine/src/color'
import {
  type EaScript,
  eaScriptOfLang,
  parseClrMap,
  parseTheme,
  resolveFontRef,
  resolveSchemeColor,
  sysColorHex,
  type Theme,
  themeWithOverride,
} from '../../packages/pptx-engine/src/theme'
import { relsPathFor, resolveTarget } from '../../packages/pptx-engine/src/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { mulberry32 } from '../docx-diff/synthetic'

type Args = Record<string, unknown>
type Parts = ReadonlyMap<string, string>

/**
 * A value as it reaches Rust: a theme's keys that hold undefined are gone,
 * so the TypeScript is given the same object.
 */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * The parser of packages/pptx-engine/src/parse.ts, which parses the nodes
 * resolveColorNode and applyColorMods are given. The Rust dispatch holds the
 * same list.
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

// ── Theme parts ───────────────────────────────────────────────────────

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const mod = (name: string, val?: string): string =>
  val === undefined ? `<a:${name}/>` : `<a:${name} val="${val}"/>`
const srgb = (val: string, mods = ''): string =>
  mods ? `<a:srgbClr val="${val}">${mods}</a:srgbClr>` : `<a:srgbClr val="${val}"/>`
const sys = (val: string, lastClr?: string): string =>
  `<a:sysClr val="${val}"${lastClr === undefined ? '' : ` lastClr="${lastClr}"`}/>`
const scheme = (val: string, mods = ''): string =>
  mods ? `<a:schemeClr val="${val}">${mods}</a:schemeClr>` : `<a:schemeClr val="${val}"/>`
const prst = (val: string): string => `<a:prstClr val="${val}"/>`

const clrScheme = (slots: Array<[string, string]>): string =>
  `<a:clrScheme name="Office">${slots.map(([key, color]) => `<a:${key}>${color}</a:${key}>`).join('')}</a:clrScheme>`

const OFFICE: Array<[string, string]> = [
  ['dk1', sys('windowText', '000000')],
  ['lt1', sys('window', 'FFFFFF')],
  ['dk2', srgb('44546A')],
  ['lt2', srgb('E7E6E6')],
  ['accent1', srgb('4472C4')],
  ['accent2', srgb('ED7D31')],
  ['accent3', srgb('A5A5A5')],
  ['accent4', srgb('FFC000')],
  ['accent5', srgb('5B9BD5')],
  ['accent6', srgb('70AD47')],
  ['hlink', srgb('0563C1')],
  ['folHlink', srgb('954F72')],
]
const CLR_SCHEME = clrScheme(OFFICE)

/** Every form of slot readColorNode meets. */
const ODD_SCHEME = clrScheme([
  ['dk1', srgb('ff00aa')],
  ['lt1', '<a:srgbClr/>'],
  ['dk2', srgb('')],
  ['lt2', sys('btnFace')],
  ['accent1', sys('window', '123456')],
  ['accent2', srgb('112233') + sys('windowText', 'FFFFFF')],
  ['accent3', srgb('111111') + srgb('222222')],
  ['accent4', '<a:srgbClr>12</a:srgbClr>'],
  ['accent5', '<a:srgbClr>0</a:srgbClr>'],
  // ligature ff, sharp s and dotless i upper-case to FF, SS and I
  ['accent6', srgb('\uFB00\u00DF\u0131')],
  ['hlink', '<a:srgbClr lastClr="1"/>'],
  ['folHlink', '<a:scrgbClr r="0" g="0" b="0"/>'],
])

const ODD_SCHEME_2 = clrScheme([
  ['dk1', ''],
  ['lt1', 'text'],
  ['dk2', sys('WINDOW', 'abc')],
  ['lt2', sys('windowText')],
  ['accent1', '<a:sysClr lastClr="00ff00"/>'],
  ['accent2', '<a:sysClr/>'],
  ['accent7', srgb('ABCDEF')],
])

const JPAN = '\u6E38\u30B4\u30B7\u30C3\u30AF'
const HANG = '\uB9D1\uC740 \uACE0\uB515'
const HANS = '\u7B49\u7EBF'
const HANT = '\u65B0\u7D30\u660E\u9AD4'

const face = (tag: string, typeface: string): string => `<a:${tag} typeface="${typeface}"/>`
const fontSet = (
  latin?: string,
  ea?: string,
  cs?: string,
  scripts: Array<[string, string]> = [],
): string =>
  (latin === undefined ? '' : face('latin', latin)) +
  (ea === undefined ? '' : face('ea', ea)) +
  (cs === undefined ? '' : face('cs', cs)) +
  scripts
    .map(([script, typeface]) => `<a:font script="${script}" typeface="${typeface}"/>`)
    .join('')
const fontScheme = (major: string, minor: string): string =>
  `<a:fontScheme name="Office"><a:majorFont>${major}</a:majorFont><a:minorFont>${minor}</a:minorFont></a:fontScheme>`

const SCRIPTS: Array<[string, string]> = [
  ['Jpan', JPAN],
  ['Hang', HANG],
  ['Hans', HANS],
  ['Hant', HANT],
  ['Arab', 'Times New Roman'],
  ['Hebr', 'Times New Roman'],
]
const FONT_SCHEME = fontScheme(
  fontSet('Calibri Light', '', '', SCRIPTS),
  fontSet('Calibri', '', '', SCRIPTS),
)

const FONT_SCHEMES: string[] = [
  FONT_SCHEME,
  fontScheme(fontSet('Major', 'MajorEa', 'MajorCs'), fontSet('Minor', 'MinorEa', 'MinorCs')),
  fontScheme(fontSet('Major'), fontSet('Minor')),
  // one Han script in the major font, two in the minor one
  fontScheme(
    fontSet(undefined, '', '', [
      ['Hant', HANT],
      ['Hang', HANG],
    ]),
    fontSet('Minor', '', '', [
      ['Jpan', JPAN],
      ['Hans', HANS],
    ]),
  ),
  fontScheme('<a:latin/>', `<a:latin typeface=""/>${face('ea', '\u{1F600}')}`),
  // a record keyed by data: index keys first, a key set again keeps its place
  fontScheme(
    fontSet('M', '', '', [
      ['b', 'B'],
      ['10', 'Ten'],
      ['2', 'Two'],
      ['b', 'B2'],
      ['constructor', 'C'],
      ['toString', 'S'],
      ['', 'Empty'],
      ['x', ''],
    ]) + '<a:font typeface="NoScript"/><a:font script="y"/>',
    fontSet('m'),
  ),
  '',
  "<a:fontScheme name='x'><a:majorFont><a:latin typeface='A&amp;B'/></a:majorFont>" +
    '<a:minorFont><a:latin typeface="&lt;C&gt;"/></a:minorFont></a:fontScheme>',
  `<a:fontScheme><a:majorFont>${fontSet('One')}</a:majorFont><a:majorFont>${fontSet('Two', '', '', SCRIPTS)}</a:majorFont></a:fontScheme>`,
]

/**
 * ledger theme-script-font-proto: a script font named `__proto__`. The
 * TypeScript's `out[script] = face` sets no key for it, so the entry is
 * lost; the Rust keeps it.
 */
const PROTO_FONT_SCHEME = fontScheme(
  fontSet('M', '', '', [['__proto__', 'Proto']]),
  fontSet('m', '', '', [
    ['Jpan', JPAN],
    ['__proto__', 'Proto'],
  ]),
)

const PH = scheme('phClr')
const GRAD =
  '<a:gradFill rotWithShape="1"><a:gsLst>' +
  `<a:gs pos="0">${scheme('phClr', mod('lumMod', '110000') + mod('satMod', '105000') + mod('tint', '67000'))}</a:gs>` +
  `<a:gs pos="100000">${scheme('phClr', mod('shade', '78000'))}</a:gs>` +
  '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
const FMT_SCHEME =
  '<a:fmtScheme name="Office">' +
  `<a:fillStyleLst><a:solidFill>${PH}</a:solidFill>${GRAD}<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">${PH}</a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>` +
  `<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${PH}</a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
  `<a:ln w="12700"><a:solidFill>${PH}</a:solidFill></a:ln><a:ln w="19050"><a:solidFill>${PH}</a:solidFill></a:ln></a:lnStyleLst>` +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  `<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">${srgb('000000', mod('alpha', '63000'))}</a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill>${PH}</a:solidFill><a:solidFill>${scheme('phClr', mod('tint', '95000') + mod('satMod', '170000'))}</a:solidFill>${GRAD}</a:bgFillStyleLst>` +
  '</a:fmtScheme>'

const FMT_SCHEMES: string[] = [
  FMT_SCHEME,
  '',
  '<a:fmtScheme name="Office"/>',
  '<a:fmtScheme name="x"><a:fillStyleLst/><a:lnStyleLst></a:lnStyleLst></a:fmtScheme>',
  // element types mixed, with a comment, text and a processing instruction between them
  `<a:fmtScheme><a:fillStyleLst><a:solidFill>${PH}</a:solidFill><!-- note --><a:blipFill><a:blip r:embed="rId1"/></a:blipFill>text<a:noFill/><?pi x?><a:pattFill prst="pct5"><a:fgClr>${PH}</a:fgClr></a:pattFill></a:fillStyleLst></a:fmtScheme>`,
  // a tag inside a comment is counted by topLevelFragments
  `<a:fmtScheme><a:fillStyleLst><!-- <a:x> --><a:solidFill>${PH}</a:solidFill></a:fillStyleLst></a:fmtScheme>`,
  // a stray closing tag at depth 0
  `<a:fmtScheme><a:fillStyleLst></a:stray><a:solidFill>${PH}</a:solidFill><a:noFill/></a:fillStyleLst></a:fmtScheme>`,
  // a fragment the parser refuses
  '<a:fmtScheme><a:lnStyleLst><a:ln><a:x></a:y></a:ln></a:lnStyleLst></a:fmtScheme>',
  `<a:fmtScheme><a:lnStyleLst><a:ln w="1" name="a>b" note='c"d'><a:solidFill>${PH}</a:solidFill></a:ln></a:lnStyleLst></a:fmtScheme>`,
  '<a:fmtScheme name="1"><a:effectStyleLst><a:effectStyle/></a:effectStyleLst></a:fmtScheme>' +
    '<a:fmtScheme name="2"><a:bgFillStyleLst><a:noFill/></a:bgFillStyleLst></a:fmtScheme>',
  // tag values the default parser turns into numbers
  '<a:fmtScheme><a:bgFillStyleLst><a:x>0123</a:x><a:y>1e3</a:y><a:z> 7 </a:z><a:w>0x1F</a:w><a:v>-0</a:v></a:bgFillStyleLst></a:fmtScheme>',
  '<a:fmtScheme><a:fillStyleLst/><a:solidFill/></a:fillStyleLst></a:fmtScheme>',
  `<a:fmtScheme>\n  <a:effectStyleLst>\n    <a:effectStyle>\n      <a:effectLst/>\n    </a:effectStyle>\n  </a:effectStyleLst>\n</a:fmtScheme>`,
]

const themeXml = (elements: string, root = 'a:theme'): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<${root} ${A_NS} name="Office Theme"><a:themeElements>${elements}</a:themeElements></${root}>`

const THEME_XML = themeXml(CLR_SCHEME + FONT_SCHEME + FMT_SCHEME)

const THEME_TEXTS: string[] = [
  THEME_XML,
  themeXml(CLR_SCHEME + FONT_SCHEME + FMT_SCHEME, 'theme'),
  themeXml(''),
  `<a:theme ${A_NS}/>`,
  '',
  '<?xml version="1.0"?><a:themeElements/>',
  themeXml(ODD_SCHEME + FONT_SCHEMES[1]!),
  themeXml(ODD_SCHEME_2),
  ...FONT_SCHEMES.map((fonts) => themeXml(CLR_SCHEME + fonts)),
  ...FMT_SCHEMES.map((fmt) => themeXml(CLR_SCHEME + FONT_SCHEME + fmt)),
  themeXml(CLR_SCHEME + CLR_SCHEME),
  `<theme><themeElements>${CLR_SCHEME}</themeElements></theme>`,
  `<a:theme ${A_NS}><a:themeElements>${CLR_SCHEME}</a:theme>`,
  `<a:theme ${A_NS}><a:themeElements>${CLR_SCHEME}</a:themeElements></a:theme><a:theme/>`,
]

/** Themes as the callers hold them, each the JSON of what the real parseTheme gave. */
const T_FULL = wire(parseTheme(THEME_XML))
const T_EA = wire(parseTheme(themeXml(CLR_SCHEME + FONT_SCHEMES[1]!)))
const T_PLAIN = wire(parseTheme(themeXml(CLR_SCHEME + FONT_SCHEMES[2]!)))
const T_HAN = wire(parseTheme(themeXml(CLR_SCHEME + FONT_SCHEMES[3]!)))
const T_EMPTY = wire(parseTheme(''))
const T_ODD = wire(parseTheme(themeXml(ODD_SCHEME + FONT_SCHEMES[4]!)))
const DARK_MAP = parseClrMap(
  '<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent2" accent2="accent1" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="folHlink" folHlink="hlink"/>',
)
const T_DARK = wire({ ...T_FULL, clrMap: DARK_MAP })
/**
 * ledger inherited-key-theme-257: a master that maps scheme names to names
 * every object inherits. The TypeScript reads `colors[key]` through the
 * prototype: a function, or Object.prototype for `__proto__`.
 */
const T_INHERITED = wire({
  ...T_FULL,
  clrMap: parseClrMap(
    '<p:clrMap bg1="constructor" tx1="toString" bg2="__proto__" tx2="hasOwnProperty" accent1="valueOf" accent2="isPrototypeOf"/>',
  ),
})
const INHERITED_MAPPED = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2']

// ── The corpus ────────────────────────────────────────────────────────

const THEME_PART = /^ppt\/theme\/theme\d+\.xml$/
const OVERRIDE_PART = /^ppt\/theme\/themeOverride\d+\.xml$/
const MASTER_PART = /^ppt\/slideMasters\/[^/]+\.xml$/
const LAYOUT_PART = /^ppt\/slideLayouts\/[^/]+\.xml$/
const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/
const SHAPE_TREE_PART = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/

const partsOf = (parts: Parts, name: RegExp): Array<[string, string]> =>
  [...parts].filter(([path]) => name.test(path))

const textsOf = (parts: Parts, ...names: RegExp[]): string[] =>
  [...parts].filter(([path]) => names.some((name) => name.test(path))).map(([, text]) => text)

/** Group `group` of each match of `re` over `texts`, distinct, at most `cap`. */
function distinct(texts: string[], re: RegExp, cap: number, group = 0): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      if (found.size >= cap) return [...found]
      found.add(m[group] ?? '')
    }
  }
  return [...found]
}

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

interface Context {
  xml: string
  masterXml?: string
  layoutXml?: string
  slideXml?: string
  /** The master's theme with the chain's clrMap, as index.ts assigns it. */
  theme?: Theme
}

/** Every master, layout and slide with its chain and the theme it is read with. */
function contextsOf(parts: Parts): Context[] {
  const firstTheme = partsOf(parts, THEME_PART)[0]?.[1]
  const themeOf = (master: string | undefined): Theme | undefined => {
    const path = related(parts, master, 'theme')
    return parsedTheme(path === undefined ? firstTheme : parts.get(path))
  }
  const context = (
    xml: string,
    master: string | undefined,
    layoutXml?: string,
    slideXml?: string,
  ): Context => {
    const masterXml = master === undefined ? undefined : parts.get(master)
    const theme = themeOf(master)
    return {
      xml,
      masterXml,
      layoutXml,
      slideXml,
      theme: theme && wire({ ...theme, clrMap: parseClrMap(masterXml, layoutXml, slideXml) }),
    }
  }
  const out: Context[] = []
  for (const [path, xml] of partsOf(parts, MASTER_PART)) out.push(context(xml, path))
  for (const [path, xml] of partsOf(parts, LAYOUT_PART)) {
    out.push(context(xml, related(parts, path, 'slideMaster'), xml))
  }
  for (const [path, xml] of partsOf(parts, SLIDE_PART)) {
    const layout = related(parts, path, 'slideLayout')
    out.push(
      context(
        xml,
        related(parts, layout, 'slideMaster'),
        layout === undefined ? undefined : parts.get(layout),
        xml,
      ),
    )
  }
  return out
}

/** The distinct themes the deck's parts are read with. */
function themesOf(parts: Parts): Theme[] {
  const seen = new Map<string, Theme>()
  for (const { theme } of contextsOf(parts)) {
    if (theme) seen.set(JSON.stringify(theme), theme)
  }
  return [...seen.values()]
}

const withTheme = (theme: Theme | undefined): Args => (theme === undefined ? {} : { theme })

/** Elements that hold a colour element, as the engine hands them to resolveColorNode. */
const HOLDER =
  /<(a:(?:solidFill|fgClr|bgClr|buClr|highlight|outerShdw|innerShdw|prstShdw|glow|fontRef|fillRef|lnRef|effectRef|gs|extrusionClr|contourClr))\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g
const COLOR_ELEMENT =
  /<(a:(?:srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr))\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g
const nameOf = (element: string): string => /^<([\w:]+)/.exec(element)?.[1] ?? ''

// ── Built inputs ──────────────────────────────────────────────────────

const SYS_VALS: unknown[] = ['window', 'windowText', 'btnFace', 'WINDOW', '', null, 7]
const SYS_LASTS: Input[] = [
  { text: 'abcdef' },
  { text: '' },
  { text: '\u00DF\u0131\u017F' },
  { text: 'x', args: { lastClr: null } },
  { text: 'x', args: { lastClr: 7 } },
  { text: 'x', args: { lastClr: ['ab', 'cd'] } },
  { text: 'x', args: { lastClr: {} } },
]
const SYS_INPUTS: Input[] = [
  ...SYS_LASTS.map((last) => ({ text: last.text, args: { ...last.args } })),
  ...SYS_VALS.flatMap((val) =>
    SYS_LASTS.map((last) => ({ text: last.text, args: { val, ...last.args } })),
  ),
]

const LANG_INPUTS: Input[] = [
  ...[
    'ja-JP',
    'JA',
    'ja',
    'jav',
    'ko-KR',
    'KO',
    'kok',
    'zh-TW',
    'zh-tw',
    'ZH-HK',
    'zh-MO',
    'zh-Hant',
    'zh-Hant-TW',
    'zh-hantx',
    'zh-twx',
    'zh-CN',
    'zh-Hans',
    'zh',
    'zh-',
    'zht',
    'zh_TW',
    'en-US',
    '',
    ' ja',
    'x-ja',
    // Kelvin sign lower-cases to k; dotted capital I to i and a combining dot
    '\u212Ao-KR',
    '\u0130a',
    '\u017Fh',
  ].map((text) => ({ text })),
  ...[null, 7, true, ['zh', 'TW'], ['ja'], {}, 'ko'].map((tag) => ({
    text: 'ja',
    args: { tag },
  })),
]

const TYPEFACES = [
  '+mj-lt',
  '+mn-lt',
  '+mj-cs',
  '+mn-cs',
  '+mj-sym',
  '+',
  '+MJ-LT',
  'Arial',
  '',
  ' +mj-lt',
  '\u{1F600}',
]
const EA_REFS = ['+mj-ea', '+mn-ea']
const EA_SCRIPTS: Array<EaScript | undefined> = [undefined, 'ja', 'ko', 'sc', 'tc', 'han']
const FONT_THEMES: Array<Theme | undefined> = [
  undefined,
  T_FULL,
  T_EA,
  T_PLAIN,
  T_HAN,
  T_EMPTY,
  wire({
    colors: {},
    majorFont: 'Major',
    majorEaFont: '',
    majorScriptFonts: { Jpan: '', Hant: 'Hant face', Hans: '' },
    minorScriptFonts: { Jpan: 'J', Hans: 'S', Hant: 'T' },
  } as Theme),
]
const FONT_INPUTS: Input[] = [
  ...FONT_THEMES.flatMap((theme) => [
    ...TYPEFACES.map((text) => ({ text, args: withTheme(theme) })),
    { text: '+mj-lt', args: { ...withTheme(theme), eaScript: 'ja' } },
    { text: 'x', args: { ...withTheme(theme), noTypeface: true } },
    ...EA_REFS.flatMap((text) =>
      EA_SCRIPTS.map((eaScript) => ({
        text,
        args: { ...withTheme(theme), ...(eaScript ? { eaScript } : {}) },
      })),
    ),
  ]),
]

const SCHEME_NAMES = [
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
  'unknown',
  '',
  'TX1',
  // a name every object inherits, looked up in the clrMap and the standard table
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  'valueOf',
]
const SCHEME_THEMES: Array<Theme | undefined> = [undefined, T_FULL, T_DARK, T_EMPTY, T_ODD]
const SCHEME_INPUTS: Input[] = [
  ...SCHEME_THEMES.flatMap((theme) =>
    SCHEME_NAMES.map((text) => ({ text, args: withTheme(theme) })),
  ),
  ...['#ABCDEF', '', 'abc'].flatMap((phClr) => [
    { text: 'phClr', args: { phClr } },
    { text: 'phClr', args: { theme: T_FULL, phClr } },
    { text: 'accent1', args: { theme: T_FULL, phClr } },
  ]),
  ...['accent3', 'constructor', 'lt1'].map((text) => ({ text, args: { theme: T_INHERITED } })),
  // ledger inherited-key-theme-257: the TypeScript answers a function or {}, the Rust undefined
  ...INHERITED_MAPPED.map((text): Input => ({ text, args: { theme: T_INHERITED }, seed: false })),
]

const STANDARD_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'
const master = (clrMap: string): string =>
  `<p:sldMaster ${A_NS} ${P_NS}><p:cSld><p:spTree/></p:cSld>${clrMap}<p:sldLayoutIdLst/></p:sldMaster>`
const overrideMapping = (attrs: string): string =>
  `<p:clrMapOvr><a:overrideClrMapping ${attrs}/></p:clrMapOvr>`
const INHERIT_MAPPING = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
const layout = (mapping: string): string =>
  `<p:sldLayout ${A_NS} ${P_NS}><p:cSld/>${mapping}</p:sldLayout>`
const slide = (mapping: string): string => `<p:sld ${A_NS} ${P_NS}><p:cSld/>${mapping}</p:sld>`

const MASTER_TEXTS = [
  master(`<p:clrMap ${STANDARD_MAP}/>`),
  master('<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"/>'),
  master("<p:clrMap bg1='dk1' tx1='lt1'/>"),
  master(`<p:clrMap bg1 = "dk1"  tx1= 'lt1'\n accent1\t=\t"accent2" />`),
  master('<p:clrMap folHlink="hlink" accent1="accent6"/>'),
  master('<p:clrMap bg1="" tx1="lt1"/>'),
  master('<p:clrMap bg1=""/>'),
  master('<p:clrMap/>'),
  master(''),
  master('<p:clrMapOvr/><p:clrMap bg1="dk2"/>'),
  master('<p:clrMap xbg1="dk1" a:bg1="lt2"/>'),
  master(`<p:clrMap name="bg1='dk2'" tx1="lt1"/>`),
  master(`<p:clrMap bg1="dk1' tx1='lt1"/>`),
  master('<p:clrMap bg1="d\nk1" tx1="lt1"/>'),
  master('<p:clrMap bg1="constructor" tx1="__proto__"/>'),
  master('<p:clrMap bg1="\u{1F600}"/>'),
  master('<p:clrMap accent10="x" accent1="y"/>'),
  master('<p:clrMap bg1="dk1"></p:clrMap>'),
  master('<p:clrMap bg1="a>b"/>'),
  master(`<p:clrMap ${STANDARD_MAP}/>`).replace('<p:clrMap', '<p:clrMap \u00A0'),
]
const DARK_MASTER = MASTER_TEXTS[1]!
const LAYOUT_TEXTS = [
  layout(overrideMapping('bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"')),
  layout(INHERIT_MAPPING),
  layout(overrideMapping('')),
  layout(overrideMapping("bg1='lt2' accent1 = 'accent3'")),
  layout(''),
]
const CLR_MAP_INPUTS: Input[] = [
  ...MASTER_TEXTS.map((text) => ({ text })),
  ...LAYOUT_TEXTS.flatMap((text) => [
    { text, args: { textIs: 'layout', masterXml: DARK_MASTER } },
    { text, args: { textIs: 'layout' } },
  ]),
  ...[
    slide(overrideMapping('bg1="lt1" tx1="dk1"')),
    slide(INHERIT_MAPPING),
    slide(overrideMapping('foo="bar"')),
    slide(''),
  ].flatMap((text) => [
    ...LAYOUT_TEXTS.map((layoutXml) => ({
      text,
      args: { textIs: 'slide', layoutXml, masterXml: MASTER_TEXTS[0] },
    })),
    { text, args: { textIs: 'slide' } },
  ]),
  { text: '', args: { textIs: 'slide', layoutXml: '', masterXml: '' } },
  { text: '', args: { textIs: 'master', layoutXml: LAYOUT_TEXTS[0] } },
]

const themeOverride = (inner: string): string =>
  `<a:themeOverride ${A_NS}>${inner}</a:themeOverride>`
const OVERRIDE_TEXTS = [
  themeOverride(
    clrScheme(
      OFFICE.map(([key, color]): [string, string] => [
        key,
        key.startsWith('accent') ? srgb('C00000') : color,
      ]),
    ),
  ),
  themeOverride(clrScheme([['accent1', srgb('00B050')]])),
  themeOverride(FONT_SCHEMES[1]!),
  themeOverride(FONT_SCHEME),
  themeOverride(FMT_SCHEME),
  themeOverride(CLR_SCHEME + FONT_SCHEMES[2]! + FMT_SCHEME),
  themeOverride(
    '<a:fontScheme><a:majorFont><a:latin typeface="Over"/></a:majorFont></a:fontScheme>',
  ),
  `<a:themeOverride ${A_NS}/>`,
  themeOverride(''),
  'not an override',
  '<?xml version="1.0"?>\n' + themeOverride(CLR_SCHEME),
  // greedy: the inner text runs to the last closing tag and does not parse
  themeOverride(clrScheme([['dk1', srgb('1')]])) + themeOverride(FONT_SCHEMES[2]!),
  themeOverride('<a:clrScheme><a:dk1></a:clrScheme>'),
]
const OVERRIDE_BASES: Array<Theme | undefined> = [
  undefined,
  T_FULL,
  T_DARK,
  T_PLAIN,
  T_EMPTY,
  wire({ majorFont: 'Base', colors: { accent1: '#111111', '10': '#AAAAAA', '2': '#BBBBBB' } }),
  wire({ colors: {}, minorFont: 'Keep', clrMap: { bg1: 'dk1' } }),
]
const OVERRIDE_INPUTS: Input[] = OVERRIDE_TEXTS.flatMap((text) =>
  OVERRIDE_BASES.map((theme) => ({ text, args: withTheme(theme) })),
)

const fill = (color: string): string => `<a:solidFill>${color}</a:solidFill>`
const BIG = '9'.repeat(400)

/** The colour element of every kind and value form, without transforms. */
const BASE_COLORS: string[] = [
  ...[
    'FF0000',
    'ff0000',
    '4472C4',
    'F00',
    'FF000080',
    'zz',
    '\uFB00\uFB00\uFB00',
    '#FF0000',
    '1',
    '-10000',
    '0x1234',
    '\u{1F600}00FF',
    'ABCDEFAB12',
    ' 00FF00',
  ].map((val) => srgb(val)),
  srgb(''),
  '<a:srgbClr/>',
  '<a:srgbClr lastClr="1"/>',
  '<a:srgbClr>FF0000</a:srgbClr>',
  '<a:srgbClr>  </a:srgbClr>',
  ...[
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'tx1',
    'bg1',
    'tx2',
    'bg2',
    'dk1',
    'lt1',
    'hlink',
    'folHlink',
    'phClr',
    'unknown',
    '',
  ].map((val) => scheme(val)),
  '<a:schemeClr/>',
  '<a:schemeClr x="1"/>',
  sys('window'),
  sys('windowText', 'FFFFFF'),
  sys('btnFace', 'F0F0F0'),
  sys('btnFace'),
  sys('menu', 'abc'),
  ...[
    'red',
    'Red',
    'RED',
    'dkBlue',
    'DkBlue',
    'DKBLUE',
    'medPurple',
    'mediumPurple',
    'Medpurple',
    'unknownColor',
    '',
    '\u212Ahaki',
    '\u212AHAKI',
    '\u0130ndigo',
    '\u{1F600}red',
  ].map(prst),
  '<a:prstClr/>',
  '<a:prstClr x="1"/>',
  '<a:hslClr hue="0" sat="100000" lum="50000"/>',
  '<a:scrgbClr r="100000" g="0" b="0"/>',
  srgb('FF0000') + scheme('accent1'),
  srgb('111111') + srgb('222222'),
  scheme('accent1') + scheme('accent2'),
  sys('btnFace', 'F0F0F0') + sys('window'),
]

/** Transforms: each alone, in both orders, repeated, out of range and not numbers. */
const MOD_SETS: string[] = [
  mod('lumMod', '75000'),
  mod('lumMod', '40000') + mod('lumOff', '60000'),
  mod('lumOff', '60000') + mod('lumMod', '40000'),
  mod('tint', '55000'),
  mod('shade', '50000'),
  mod('tint', '50000') + mod('shade', '50000'),
  mod('shade', '50000') + mod('tint', '50000'),
  mod('satMod', '150000'),
  mod('satMod', '0'),
  mod('alpha', '50000'),
  mod('alpha', '0'),
  mod('alpha', '100000'),
  mod('alpha', '120000'),
  mod('alpha', '-50000'),
  mod('alpha', '60000') + mod('alpha', '30000'),
  mod('alpha', ''),
  mod('alpha', 'abc'),
  mod('alpha'),
  mod('alpha', '50196'),
  mod('alpha', '-' + '9'.repeat(30)),
  mod('alpha', '-' + BIG),
  mod('hueOff', '5400000'),
  mod('hueOff', '-21600000'),
  mod('hueOff', '1'),
  mod('satOff', '20000'),
  mod('satOff', '-150000'),
  mod('hueOff', BIG) + mod('hueOff', '-' + BIG),
  mod('satOff', BIG) + mod('satOff', '-' + BIG),
  mod('lumMod', BIG),
  mod('lumMod', BIG) + mod('lumMod', '0'),
  mod('shade', BIG) + mod('shade', '0'),
  mod('lumMod', '0'),
  mod('lumMod', 'abc'),
  mod('lumMod', '50%'),
  mod('lumMod', ' 50000'),
  mod('lumMod', '1e5'),
  mod('lumMod', '-50000'),
  mod('lumMod', '50000') + mod('lumMod', '50000'),
  mod('lumOff', '10000') + mod('lumOff', '20000'),
  mod('tint', 'x'),
  mod('shade', '0'),
  mod('tint', '200000'),
  mod('shade', '200000'),
  mod('tint', '-50000'),
  mod('gray') + mod('inv') + mod('comp') + mod('alphaMod', '50000') + mod('red', '0'),
  mod('lumMod'),
  '<a:lumMod foo="1"/>',
  '<a:lumMod>50000</a:lumMod>',
  mod('hueOff', '1200000') +
    mod('satOff', '10000') +
    mod('satMod', '120000') +
    mod('lumMod', '90000') +
    mod('lumOff', '5000') +
    mod('shade', '90000') +
    mod('tint', '80000') +
    mod('alpha', '70000'),
  mod('alpha', '70000') +
    mod('tint', '80000') +
    mod('shade', '90000') +
    mod('lumOff', '5000') +
    mod('lumMod', '90000') +
    mod('satMod', '120000') +
    mod('satOff', '10000') +
    mod('hueOff', '1200000'),
]

/** The colour elements the transforms are applied to. */
const MOD_TARGETS: Array<(mods: string) => string> = [
  (mods) => srgb('4472C4', mods),
  (mods) => srgb('7F0000', mods),
  (mods) => srgb('000000', mods),
  (mods) => srgb('FFFFFF', mods),
  (mods) => srgb('808080', mods),
  (mods) => scheme('accent2', mods),
  (mods) => `<a:sysClr val="window" lastClr="FFFFFF">${mods}</a:sysClr>`,
  (mods) => `<a:prstClr val="dkBlue">${mods}</a:prstClr>`,
]

/** Holders the engine passes, and texts the parser refuses. */
const HOLDERS: Array<[string, string]> = [
  ['a:solidFill', '<a:solidFill/>'],
  ['a:solidFill', '<a:solidFill>  </a:solidFill>'],
  ['a:solidFill', '<a:solidFill>text</a:solidFill>'],
  [
    'a:outerShdw',
    `<a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0">${srgb('000000', mod('alpha', '35000'))}</a:outerShdw>`,
  ],
  ['a:fontRef', `<a:fontRef idx="minor">${scheme('tx1')}</a:fontRef>`],
  ['a:fillRef', `<a:fillRef idx="1">${scheme('accent1', mod('shade', '50000'))}</a:fillRef>`],
  [
    'a:glow',
    `<a:glow rad="63500">${srgb('4472C4', mod('satMod', '175000') + mod('alpha', '40000'))}</a:glow>`,
  ],
  ['a:solidFill', fill(srgb('FF0000')) + fill(srgb('00FF00'))],
  ['a:none', fill(srgb('FF0000'))],
  ['a:solidFill', `<a:solidFill>${srgb('FF0000')}`],
  ['a:solidFill', `<a:solidFill>${srgb('FF0000')}</a:solidFil>`],
  [
    'a:solidFill',
    "<a:solidFill><a:srgbClr val='FF0000'><a:lumMod val='50000'/></a:srgbClr></a:solidFill>",
  ],
  ['a:solidFill', '<a:solidFill><a:srgbClr\n  val="00ff00"\n/></a:solidFill>'],
  ['a:solidFill', '<a:solidFill><a:srgbClr val="&#x46;F0000"/></a:solidFill>'],
  ['a:solidFill', '<a:solidFill><a:srgbClr val="F&amp;0000"/></a:solidFill>'],
  ['a:p', `<a:p>${fill(srgb('FF0000'))}</a:p>`],
]

const NODE_THEMES: Array<Theme | undefined> = [undefined, T_FULL, T_DARK, T_ODD]

const NODE_INPUTS: Input[] = [
  ...BASE_COLORS.map((color) => ({ text: fill(color), args: { name: 'a:solidFill' } })),
  ...BASE_COLORS.filter((color) => color.includes('schemeClr')).flatMap((color) =>
    NODE_THEMES.slice(1).map((theme) => ({
      text: fill(color),
      args: { name: 'a:solidFill', theme },
    })),
  ),
  ...[undefined, '#ABCDEF', '', 'abcdef'].flatMap((phClr) =>
    [undefined, T_FULL].map((theme) => ({
      text: fill(scheme('phClr', mod('lumMod', '50000'))),
      args: { name: 'a:solidFill', ...withTheme(theme), ...(phClr === undefined ? {} : { phClr }) },
    })),
  ),
  ...MOD_TARGETS.flatMap((target) =>
    MOD_SETS.map((mods) => ({
      text: fill(target(mods)),
      args: { name: 'a:solidFill', theme: T_FULL },
    })),
  ),
  ...HOLDERS.flatMap(([name, text]) => [
    { text, args: { name } },
    { text, args: { name, theme: T_DARK } },
  ]),
  ...['accent3', 'lt1'].map((val) => ({
    text: fill(scheme(val)),
    args: { name: 'a:solidFill', theme: T_INHERITED },
  })),
  // ledger inherited-key-theme-257: the TypeScript throws on the function it resolves to
  ...INHERITED_MAPPED.map((val): Input => ({
    text: fill(scheme(val, mod('lumMod', '50000'))),
    args: { name: 'a:solidFill', theme: T_INHERITED },
    seed: false,
  })),
  // ledger inherited-key-color-39: a preset name every object inherits; the TypeScript throws
  ...[
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
  ].map((val): Input => ({ text: fill(prst(val)), args: { name: 'a:solidFill' }, seed: false })),
  // ledger inherited-key-color-41: the same once its first letter is lower-cased
  ...['Constructor', 'ToString', 'HasOwnProperty', 'ValueOf', 'IsPrototypeOf'].map(
    (val): Input => ({ text: fill(prst(val)), args: { name: 'a:solidFill' }, seed: false }),
  ),
]

const HEXES = [
  '#FF0000',
  'FF0000',
  '#ff0000',
  '#F00',
  '#FF000080',
  '',
  '#',
  '##FF0000',
  'zz',
  '#GG0000',
  '#1',
  '+F0000',
  '-F0000',
  '#\u{1F600}FF00',
  '#F\u{1F600}F00',
  ' FF0000',
  '\u00A0FF0000',
  '#0x1234',
  '#7F0000',
  '#4472C4',
  '#000000',
  '#FFFFFF',
  '#808080',
]

/**
 * Colors through the gamma curve of tint and shade, where `Math.pow` has to
 * agree to the last bit: a channel that comes back within rounding of a half
 * goes one way or the other. The first comparison found two such colors in
 * the tracked decks (tint and shade of 100000 after a satMod).
 */
const GAMMA_INPUTS: Input[] = (() => {
  const random = mulberry32(0x7061)
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!
  const amounts = ['100000', '50000', '75000', '20000', '95000', '5000', '99999', '1']
  return Array.from({ length: 600 }, (): Input => {
    const hex = `#${Math.floor(random() * 0x1000000)
      .toString(16)
      .padStart(6, '0')}`
    const mods =
      (random() < 0.5 ? mod('satMod', pick(['130000', '120000', '300000', '90000'])) : '') +
      (random() < 0.3 ? mod('lumMod', pick(['110000', '80000', '102000'])) : '') +
      mod('tint', random() < 0.3 ? String(Math.floor(random() * 100001)) : pick(amounts)) +
      (random() < 0.7
        ? mod('shade', random() < 0.3 ? String(Math.floor(random() * 100001)) : pick(amounts))
        : '')
    return { text: srgb('000000', mods), args: { hex, name: 'a:srgbClr' } }
  })
})()

const APPLY_INPUTS: Input[] = [
  ...GAMMA_INPUTS,
  ...HEXES.flatMap((hex) => [
    { text: '', args: { hex } },
    ...[
      mod('lumMod', '75000'),
      mod('lumMod', '40000') + mod('lumOff', '60000'),
      mod('tint', '55000'),
      mod('satMod', '150000'),
      mod('hueOff', '5400000'),
      mod('alpha', '50000'),
    ].map((mods) => ({ text: srgb('000000', mods), args: { hex, name: 'a:srgbClr' } })),
  ]),
  ...MOD_SETS.map((mods) => ({
    text: srgb('000000', mods),
    args: { hex: '#4472C4', name: 'a:srgbClr' },
  })),
  { text: '<a:x>text</a:x>', args: { hex: '#4472C4', name: 'a:x' } },
  { text: srgb('000000', mod('lumMod', '50000')), args: { hex: '#4472C4', name: 'a:none' } },
  {
    text: srgb('000000', mod('lumMod', '50000')) + srgb('000000', mod('tint', '50000')),
    args: { hex: '#4472C4', name: 'a:srgbClr' },
  },
  {
    text: `<a:srgbClr val="1">${mod('lumMod', '50000')}`,
    args: { hex: '#4472C4', name: 'a:srgbClr' },
  },
  { text: '<a:srgbClr></a:sysClr>', args: { hex: '#4472C4' } },
]

const HEX_INPUTS: Input[] = [
  ...HEXES,
  '#ABCDEF',
  'abcdef',
  '#abc',
  '\uFF26F0000',
  '#-1-1-1',
  '#+1+1+1',
  '#  1  1',
].map((text) => ({ text }))

const LUMINANCE_HEXES = ['#4472C4', '#000000', '#FFFFFF', '#808080', '#7F0000', 'zz', '#F00', '']
const FACTORS = [0, 0.5, 1, 1.2, 2, -1, 0.97, 100, 1e-7]
const LUMINANCE_INPUTS: Input[] = LUMINANCE_HEXES.flatMap((text) =>
  FACTORS.map((factor) => ({ text, args: { factor } })),
)

const PARSE_THEME_INPUTS: Input[] = [
  ...THEME_TEXTS.map((text) => ({ text })),
  // ledger theme-script-font-proto: a script font named __proto__ is dropped by the TypeScript
  { text: themeXml(CLR_SCHEME + PROTO_FONT_SCHEME), seed: false },
]

// ── Specs ─────────────────────────────────────────────────────────────

export const THEME: CallSpec[] = [
  {
    fn: 'pptxTheme.theme.sysColorHex',
    call: (text, args) => sysColorHex(args.val, 'lastClr' in args ? args.lastClr : text),
    fromDocument: (parts) =>
      distinct(textsOf(parts, THEME_PART, SHAPE_TREE_PART), /<a:sysClr\b[^>]*>/g, 30).map((tag) => {
        const val = /\bval="([^"]*)"/.exec(tag)?.[1]
        const lastClr = /\blastClr="([^"]*)"/.exec(tag)?.[1]
        return {
          text: lastClr ?? '',
          args: {
            ...(val === undefined ? {} : { val }),
            ...(lastClr === undefined ? { lastClr: null } : {}),
          },
        }
      }),
    built: SYS_INPUTS,
  },
  {
    fn: 'pptxTheme.theme.parseTheme',
    call: (text) => parseTheme(text),
    fromDocument: (parts) =>
      [...partsOf(parts, THEME_PART), ...partsOf(parts, OVERRIDE_PART)].map(([, text]) => ({
        text,
      })),
    built: PARSE_THEME_INPUTS,
  },
  {
    fn: 'pptxTheme.theme.themeWithOverride',
    call: (text, args) => themeWithOverride(args.theme as Theme | undefined, text),
    fromDocument: (parts) => {
      const base = themesOf(parts)[0]
      const overrides = [
        ...partsOf(parts, OVERRIDE_PART).map(([, text]) => text),
        ...partsOf(parts, THEME_PART).map(([, text]) =>
          themeOverride(
            /<a:themeElements\b[^>]*>([\s\S]*)<\/a:themeElements>/.exec(text)?.[1] ?? '',
          ),
        ),
      ]
      return overrides.flatMap((text) => [{ text, args: withTheme(base) }, { text }])
    },
    built: OVERRIDE_INPUTS,
  },
  {
    fn: 'pptxTheme.theme.eaScriptOfLang',
    call: (text, args) => eaScriptOfLang('tag' in args ? args.tag : text),
    fromDocument: (parts) =>
      distinct(
        textsOf(parts, SHAPE_TREE_PART, THEME_PART),
        /\b(?:lang|altLang)="([^"]*)"/g,
        40,
        1,
      ).map((text) => ({ text })),
    built: LANG_INPUTS,
  },
  {
    fn: 'pptxTheme.theme.resolveFontRef',
    call: (text, args) =>
      resolveFontRef(
        args.noTypeface === true ? undefined : text,
        args.theme as Theme | undefined,
        args.eaScript as EaScript | undefined,
      ),
    fromDocument: (parts) => {
      const theme = themesOf(parts)[0]
      const faces = distinct(
        textsOf(parts, SHAPE_TREE_PART, THEME_PART),
        /\btypeface="([^"]*)"/g,
        40,
        1,
      )
      return [
        ...faces.flatMap((text) =>
          [undefined, 'ja', 'han'].map((eaScript) => ({
            text,
            args: { ...withTheme(theme), ...(eaScript ? { eaScript } : {}) },
          })),
        ),
        ...[...TYPEFACES, ...EA_REFS].flatMap((text) =>
          EA_SCRIPTS.map((eaScript) => ({
            text,
            args: { ...withTheme(theme), ...(eaScript ? { eaScript } : {}) },
          })),
        ),
      ]
    },
    built: FONT_INPUTS,
  },
  {
    fn: 'pptxTheme.theme.resolveSchemeColor',
    call: (text, args) =>
      resolveSchemeColor(text, args.theme as Theme | undefined, args.phClr as string | undefined),
    fromDocument: (parts) => {
      const names = new Set([
        ...distinct(
          textsOf(parts, SHAPE_TREE_PART, THEME_PART),
          /<a:schemeClr\b[^>]*?\bval="([^"]*)"/g,
          40,
          1,
        ),
        ...SCHEME_NAMES.slice(0, 18),
      ])
      return themesOf(parts).flatMap((theme) =>
        [...names].map((text) => ({ text, args: { theme } })),
      )
    },
    built: SCHEME_INPUTS,
  },
  {
    fn: 'pptxTheme.theme.parseClrMap',
    call: (text, args) => {
      const textIs = (args.textIs as string | undefined) ?? 'master'
      return parseClrMap(
        textIs === 'master' ? text : (args.masterXml as string | undefined),
        textIs === 'layout' ? text : (args.layoutXml as string | undefined),
        textIs === 'slide' ? text : (args.slideXml as string | undefined),
      )
    },
    fromDocument: (parts) =>
      contextsOf(parts).map(({ xml, masterXml, layoutXml, slideXml }): Input => {
        const textIs =
          slideXml !== undefined ? 'slide' : layoutXml !== undefined ? 'layout' : 'master'
        const args: Args = { textIs }
        if (textIs !== 'master' && masterXml !== undefined) args.masterXml = masterXml
        if (textIs === 'slide' && layoutXml !== undefined) args.layoutXml = layoutXml
        return { text: xml, args }
      }),
    built: CLR_MAP_INPUTS,
  },
  {
    fn: 'pptxTheme.color.resolveColorNode',
    call: (text, args) =>
      resolveColorNode(
        (parseTsParser.parse(text) as Record<string, unknown>)[args.name as string],
        args.theme as Theme | undefined,
        args.phClr as string | undefined,
      ),
    fromDocument: (parts) => {
      const fromParts = contextsOf(parts).flatMap(({ xml, theme }) =>
        distinct([xml], HOLDER, 25).map((text) => ({
          text,
          args: { name: nameOf(text), ...withTheme(theme) },
        })),
      )
      const theme = themesOf(parts)[0]
      const fromThemes = distinct(textsOf(parts, THEME_PART), HOLDER, 40).map((text) => ({
        text,
        args: { name: nameOf(text), ...withTheme(theme), phClr: '#ABCDEF' },
      }))
      return [...fromParts.slice(0, 200), ...fromThemes]
    },
    built: NODE_INPUTS,
  },
  {
    fn: 'pptxTheme.color.applyColorMods',
    call: (text, args) => {
      const tree = parseTsParser.parse(text) as Record<string, unknown>
      return applyColorMods(
        args.hex as string,
        args.name === undefined
          ? undefined
          : (tree[args.name as string] as Record<string, unknown> | undefined),
      )
    },
    fromDocument: (parts) => {
      const hex = themesOf(parts)[0]?.colors.accent1 ?? '#4472C4'
      return distinct(textsOf(parts, SHAPE_TREE_PART, THEME_PART), COLOR_ELEMENT, 80).map(
        (text) => ({ text, args: { hex, name: nameOf(text) } }),
      )
    },
    built: APPLY_INPUTS,
  },
  {
    fn: 'pptxTheme.color.hexToRgb',
    call: (text) => hexToRgb(text),
    fromDocument: (parts) =>
      distinct(
        textsOf(parts, SHAPE_TREE_PART, THEME_PART),
        /\b(?:val|lastClr)="([0-9A-Fa-f]{6})"/g,
        40,
        1,
      ).map((hex) => ({ text: '#' + hex })),
    built: HEX_INPUTS,
  },
  {
    fn: 'pptxTheme.color.scaleLuminance',
    call: (text, args) => scaleLuminance(text, args.factor as number),
    fromDocument: (parts) =>
      Object.values(themesOf(parts)[0]?.colors ?? {}).flatMap((text) =>
        [0.5, 1, 1.4].map((factor) => ({ text, args: { factor } })),
      ),
    built: LUMINANCE_INPUTS,
  },
]
