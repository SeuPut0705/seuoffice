// The TypeScript side of the `props` command: every exported function of
// parse-props.ts and of the helpers it stands on, under its own name, with the
// inputs it is called on.
import { isOn } from './reference/checkbox-control'
import { ownValue } from './reference/own-value'
import * as props from './reference/parse-props'
import { runBorderOf } from './reference/parse-styles'
import * as xmlText from './reference/parse-xml-text'
import { resolveThemeColor } from './reference/theme'
import type {
  CharIndents,
  ParaBorderSides,
  ParaFormat,
  Run,
  ThemeColors,
  ThemeFonts,
} from './reference/types'
import { findChild, nameOf, serializeXNode, type XNode, xmlParser } from './reference/xml-utils'

/** Arguments beside the text or node, the same object on both sides of the wire. */
export interface Args {
  /** The top-level element of the text that is the node argument. */
  node?: string
  name?: string
  rootTag?: string
  part?: 'w:rubyBase' | 'w:rt'
  tag?: string
  withInside?: boolean
  markOnly?: boolean
  besidesBreaks?: boolean
  csSizeHalfPoints?: number
  theme?: ThemeColors
  fonts?: ThemeFonts
  eaRef?: string
  de?: boolean
  dn?: boolean
  base?: CharIndents
  over?: CharIndents
  chars?: CharIndents
  format?: ParaFormat
  units?: props.CharUnits
  runs?: Run[]
  sides?: ParaBorderSides
  direct?: props.ParaBorderModel
  themeColor?: string
  tint?: string
  shade?: string
}

/** The documents' own theme, which the readers with a theme argument are compared under. */
export interface Themes {
  colors?: ThemeColors
  fonts?: ThemeFonts
}

/** What a function is called on: text of some kind, or elements of a name. */
export type Population =
  'paragraph' | 'table' | 'part' | 'instruction' | 'attributeValue' | { element: string }

export interface Reader {
  fn: string
  on: Population[]
  /** One call per entry; a single call with no arguments when absent. */
  variants?: (themes: Themes) => Args[]
  call(text: string, args: Args): unknown
}

const EMPTY: XNode = {}

function found(text: string, args: Args): XNode | undefined {
  return (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === args.node)
}

/** The node argument, `{}` where the fragment has no such element. */
function node(text: string, args: Args): XNode {
  return found(text, args) ?? EMPTY
}

const exact = (x: number): string => (Object.is(x, -0) ? '-0' : String(x))

const elements = (...names: string[]): Population[] => names.map((element) => ({ element }))

const withTheme = (themes: Themes): Args[] => [{}, { theme: themes.colors }]
const withFonts = (themes: Themes): Args[] => [{}, { fonts: themes.fonts }]

const ON_OFF_NAMES = [
  'w:b',
  'w:i',
  'w:vanish',
  'w:specVanish',
  'w:rtl',
  'w:bidi',
  'w:keepNext',
  'w:snapToGrid',
  'w:autoSpaceDE',
]

/**
 * Tag names that mean something inside a pattern. onOffTagIn and
 * partXmlSpacePreserve put the name into a RegExp unescaped: some of these
 * match other tags, the rest make `new RegExp` throw.
 */
const PATTERN_NAMES = [
  'w:.',
  'w:(b|i|hdr)',
  'w:[a-z]+',
  'w:b?',
  'w:\\w*',
  'w:b{1',
  'w:{',
  'w:]',
  'w:(',
  'w:)',
  'w:[',
  'w:*',
  'w:b{2,1}',
  'w:[z-a]',
  'w:\\',
  'w:(?<n>b)\\k<n>',
  'w:(?<n',
]

const overText = (
  fn: string,
  on: Population[],
  call: (text: string, args: Args) => unknown,
): Reader => ({ fn, on, call })

export const READERS: Reader[] = [
  overText('staysVanished', ['paragraph'], (xml) => props.staysVanished(xml)),
  overText('crossParaCommentMarkers', ['paragraph'], (xml) => props.crossParaCommentMarkers(xml)),
  overText('bookmarkNamesOf', ['paragraph'], (xml) => props.bookmarkNamesOf(xml)),
  overText('rawPPrOf', ['paragraph'], (xml) => props.rawPPrOf(xml)),
  overText('isThinRule', ['paragraph'], (xml) => props.isThinRule(xml)),
  overText('ruleDisplayOf', ['paragraph'], (xml) => props.ruleDisplayOf(xml)),
  overText('isInvisibleEmptyShape', ['paragraph'], (xml) => props.isInvisibleEmptyShape(xml)),
  overText('isInvisibleVmlPict', ['paragraph'], (xml) => props.isInvisibleVmlPict(xml)),
  overText('stripTextboxes', ['paragraph'], (xml) => props.stripTextboxes(xml)),
  overText('hostPageBreak', ['paragraph'], (xml) => props.hostPageBreak(xml)),
  overText('fieldCharsBalanced', ['paragraph'], (xml) => props.fieldCharsBalanced(xml)),
  overText('onlyOleFields', ['paragraph'], (xml) => props.onlyOleFields(xml)),
  overText('fieldInstructions', ['paragraph'], (xml) => props.fieldInstructions(xml)),
  overText('onlyXeFields', ['paragraph'], (xml) => props.onlyXeFields(xml)),
  overText('rubyFragmentsOf', ['paragraph'], (xml) => props.rubyFragmentsOf(xml)),
  overText('plainText', ['paragraph', 'table'], (xml) => xmlText.plainText(xml)),
  overText('mathTokens', ['paragraph'], (xml) => xmlText.mathTokens(xml)),
  {
    fn: 'partXmlSpacePreserve',
    on: ['part'],
    variants: () =>
      ['w:document', 'w:hdr', 'w:ftr', 'w:footnotes', 'w:styles', ...PATTERN_NAMES].map(
        (rootTag) => ({ rootTag }),
      ),
    call: (xml, args) => props.partXmlSpacePreserve(xml, args.rootTag!),
  },
  {
    fn: 'onOffTagIn',
    on: elements('w:rPr'),
    // w:\uAC00 is a name outside ASCII without case; one with case
    // (w:\u00E9) is refused by jscompat under `i`, and no caller passes one
    variants: () =>
      ['w:b', 'w:vanish', 'w:rtl', 'w:B', 'w:\uAC00', ...PATTERN_NAMES].map((name) => ({ name })),
    call: (xml, args) => xmlText.onOffTagIn(xml, args.name!),
  },

  overText('convertibleHyperlink', ['instruction'], (instr) => props.convertibleHyperlink(instr)),
  overText('SIMPLE_INLINE_FIELD_RE', ['instruction'], (instr) =>
    props.SIMPLE_INLINE_FIELD_RE.test(instr),
  ),
  overText('ZOTERO_INLINE_FIELD_RE', ['instruction'], (instr) =>
    props.ZOTERO_INLINE_FIELD_RE.test(instr),
  ),
  overText('MERGEFIELD_INSTR_RE', ['instruction'], (instr) => {
    const match = props.MERGEFIELD_INSTR_RE.exec(instr)
    return match && [match[1] ?? null, match[2] ?? null]
  }),

  // the tables as the engine reads them: for their own keys only
  overText('JC_ALIGN', ['attributeValue'], (value) => ownValue(props.JC_ALIGN, value)),
  overText('EA_LANG_DEFAULT_FONT', ['attributeValue'], (value) =>
    ownValue(props.EA_LANG_DEFAULT_FONT, value),
  ),
  overText('isOn', ['attributeValue'], (value) => isOn(value)),
  overText('decodeEntities', ['attributeValue', 'instruction'], (value) =>
    xmlText.decodeEntities(value),
  ),
  overText('decodeNumericCharRefs', ['attributeValue', 'instruction'], (value) =>
    xmlText.decodeNumericCharRefs(value),
  ),
  overText('stripHash', ['attributeValue'], (value) => xmlText.stripHash(value)),
  overText('lineTwipsOf', ['attributeValue'], (value) => exact(xmlText.lineTwipsOf(value))),
  overText('jsPrimitives', ['attributeValue'], (value) => {
    const number = Number(value)
    return {
      parseInt10: exact(parseInt(value, 10)),
      parseInt16: exact(parseInt(value, 16)),
      parseFloat: exact(parseFloat(value)),
      number: exact(number),
      round: exact(Math.round(number)),
      roundOfHundredth: exact(Math.round(number / 100)),
      int32: number | 0,
      hex: Math.round(number).toString(16),
    }
  }),

  {
    fn: 'collectNodes',
    on: ['paragraph'],
    variants: () => ['w:r', 'w:p', 'wps:wsp'].map((name) => ({ name })),
    call: (xml, args) => {
      const out: XNode[] = []
      props.collectNodes(xmlParser.parse(xml) as XNode[], args.name!, out)
      return out.map(serializeXNode)
    },
  },
  {
    fn: 'collectTopNodes',
    on: ['paragraph'],
    variants: () => ['w:r', 'w:p', 'w:t'].map((name) => ({ name })),
    call: (xml, args) => {
      const out: XNode[] = []
      props.collectTopNodes(xmlParser.parse(xml) as XNode[], args.name!, out)
      return out.map(serializeXNode)
    },
  },
  overText('allRunsVanished', elements('w:p'), (xml, args) =>
    props.allRunsVanished(node(xml, args)),
  ),
  {
    fn: 'hasLayoutRunContent',
    on: elements('w:p'),
    variants: () => [{}, { besidesBreaks: true }],
    call: (xml, args) =>
      args.besidesBreaks
        ? props.hasLayoutRunContent(node(xml, args), props.LAYOUT_RUN_CONTENT_BESIDES_BREAKS)
        : props.hasLayoutRunContent(node(xml, args)),
  },
  overText('ptabDisplayStops', elements('w:p'), (xml, args) =>
    props.ptabDisplayStops(node(xml, args)),
  ),
  {
    fn: 'emptyParaSizeHalfPoints',
    on: elements('w:p'),
    variants: () => [{}, { markOnly: true }, { csSizeHalfPoints: 24 }, { csSizeHalfPoints: 21.5 }],
    call: (xml, args) => {
      const p = node(xml, args)
      return props.emptyParaSizeHalfPoints(
        p,
        findChild(p, 'w:pPr'),
        args.markOnly,
        args.csSizeHalfPoints,
      )
    },
  },
  {
    fn: 'emptyParaMarkFont',
    on: elements('w:p'),
    variants: (themes) => [{}, { fonts: themes.fonts }, { fonts: themes.fonts, markOnly: true }],
    call: (xml, args) => {
      const p = node(xml, args)
      return props.emptyParaMarkFont(p, findChild(p, 'w:pPr'), args.fonts, args.markOnly)
    },
  },
  overText('txbxHasStructuredContent', elements('w:txbxContent'), (xml, args) =>
    props.txbxHasStructuredContent(node(xml, args)),
  ),
  overText('checkboxStateOf', elements('w:r'), (xml, args) =>
    props.checkboxStateOf(found(xml, args) ?? null),
  ),
  overText('splitImageRun', elements('w:r'), (xml, args) =>
    props.splitImageRun(node(xml, args)).map(serializeXNode),
  ),
  overText('splitSymRun', elements('w:r'), (xml, args) =>
    props.splitSymRun(node(xml, args)).map(serializeXNode),
  ),
  {
    fn: 'rubyPartText',
    on: elements('w:ruby'),
    variants: () => [{ part: 'w:rubyBase' }, { part: 'w:rt' }],
    call: (xml, args) => props.rubyPartText(node(xml, args), args.part!),
  },

  overText('autoSpaceFlagsOf', elements('w:pPr'), (xml, args) =>
    props.autoSpaceFlagsOf(node(xml, args)),
  ),
  overText('tabStopsOf', elements('w:pPr'), (xml, args) => props.tabStopsOf(node(xml, args))),
  {
    fn: 'paraBorderSidesOf',
    on: elements('w:pPr'),
    variants: withTheme,
    call: (xml, args) => props.paraBorderSidesOf(node(xml, args), args.theme),
  },
  overText('indentTwipsOf', elements('w:ind'), (xml, args) => props.indentTwipsOf(node(xml, args))),
  overText('charIndentsOf', elements('w:ind'), (xml, args) =>
    props.charIndentsOf(found(xml, args)),
  ),
  {
    fn: 'shdDisplayFill',
    on: elements('w:shd'),
    variants: withTheme,
    call: (xml, args) => props.shdDisplayFill(found(xml, args), args.theme),
  },
  {
    fn: 'themedRFonts',
    on: elements('w:rFonts'),
    variants: withFonts,
    call: (xml, args) => {
      const attrs = (node(xml, args)[':@'] ?? {}) as Record<string, string>
      return props.themedRFonts(attrs, args.fonts)
    },
  },
  {
    fn: 'colorFrom',
    on: elements('w:rPr'),
    variants: withTheme,
    call: (xml, args) => xmlText.colorFrom(found(xml, args), args.theme),
  },
  overText('autoColorOf', elements('w:rPr'), (xml, args) => xmlText.autoColorOf(found(xml, args))),
  {
    fn: 'onOffOf',
    on: elements('w:rPr', 'w:pPr'),
    variants: () => ON_OFF_NAMES.map((name) => ({ name })),
    call: (xml, args) => xmlText.onOffOf(node(xml, args), args.name!),
  },
  overText('runBorderOf', elements('w:bdr'), (xml, args) => runBorderOf(node(xml, args))),

  overText('rowBandSizeOf', elements('w:tblPr'), (xml, args) =>
    props.rowBandSizeOf(found(xml, args)),
  ),
  overText('tableLookOf', elements('w:tblPr'), (xml, args) => props.tableLookOf(found(xml, args))),
  {
    fn: 'mergedBorderLinesOf',
    on: elements('w:tblPr'),
    variants: () => [{ tag: 'w:tblBorders', withInside: true }],
    call: (xml, args) => props.mergedBorderLinesOf(found(xml, args), args.tag!, true),
  },
  {
    fn: 'mergedBorderLinesOf',
    on: elements('w:tcPr'),
    variants: () => [{ tag: 'w:tcBorders', withInside: false }],
    call: (xml, args) => props.mergedBorderLinesOf(found(xml, args), args.tag!, false),
  },
  overText('cellMarginsOf', elements('w:tcMar', 'w:tblCellMar'), (xml, args) =>
    props.cellMarginsOf(found(xml, args)),
  ),
]

/** Functions over model values: called on what the readers above returned, and on made values. */
export const MODEL_FUNCTIONS: Record<string, (args: Args) => unknown> = {
  autoSpaceMode: (args) => props.autoSpaceMode(args.de, args.dn),
  mergeCharIndents: (args) => props.mergeCharIndents(args.base, args.over),
  activeCharIndents: (args) => props.activeCharIndents(args.chars),
  resolveCharIndents: (args) => props.resolveCharIndents(args.format, args.chars!, args.units!),
  spaceOnlyRuns: (args) => props.spaceOnlyRuns(args.runs!),
  breakOnlyRuns: (args) => props.breakOnlyRuns(args.runs!),
  mergeRuns: (args) => props.mergeRuns(args.runs!),
  themeLangEaSlotFont: (args) => props.themeLangEaSlotFont(args.fonts!, args.eaRef),
  paraBordersOf: (args) => props.paraBordersOf(args.sides!),
  mergeStyleBorders: (args) => props.mergeStyleBorders(args.sides!, args.direct),
  resolveThemeColor: (args) =>
    resolveThemeColor(args.themeColor!, args.theme!, args.tint, args.shade),
}
