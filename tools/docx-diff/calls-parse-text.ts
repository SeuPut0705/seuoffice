// parse.ts: the text of runs and the leaf readers of paragraphs, runs and
// styles (crates/docx-engine/src/parse/text.rs).
//
// A BuildContext crosses as `args.parts` (the package its styles, numbering
// and theme are read from, as calls-resolve.ts builds its context) and
// `args.ctx`, the names of the members the captured context had. A captured
// member counts only where it is the document's own: the object the first
// context holding `numbering` (the body's or the resolver's) had under that
// name, with as many entries as it had then. The notes context has no
// numbering, a header's may have no styles; any other value (a nested parse,
// a table of styles merged into later) is not an input. A ResolveCtx crosses
// as `args.parts`, `args.compat` and `args.table`.
import { parseNumbering } from './reference/parse-package'
import { parseStyles } from './reference/parse-styles'
import { resolveCtxOf, type ResolveCtx } from './reference/resolve-props'
import { scanBody } from './reference/scan'
import type {
  DocDefaults,
  NumberingDef,
  StyleInfo,
  ThemeColors,
  ThemeFonts,
} from './reference/types'
import { parseNotesXml, type NoteKind, type NoteParagraphReader } from './reference/notes'
import { nameOf, serializeXNode, xmlParser, type XNode } from './reference/xml-utils'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { ENTRIES, hiddenRun, marks, NOTE_PARTS, plainRun, STORIES } from './withheld-inputs'
import { parseInternals } from './parse-internals'
import { lineRuleOutsideItsType } from './listed'
import { hiddenIn } from './calls-markup'

const internals = await parseInternals()

const attrsOf = (value: unknown): Record<string, string> | undefined =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string')
    ? (value as Record<string, string>)
    : undefined

/** A model value as it crosses JSON, taken at the call. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const isNode = (value: unknown): value is XNode =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A parsed node argument: its XML text and the name to find it by. */
function nodeInput(node: unknown): { text: string; node?: string } | undefined {
  if (node === undefined) return { text: '' }
  if (!isNode(node)) return undefined
  const name = nameOf(node)
  return name ? { text: serializeXNode(node), node: name } : undefined
}

/** The top-level element `name` of `text` (none: undefined). */
function named(text: string, name: unknown): XNode | undefined {
  if (name === undefined) return undefined
  return (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === name)
}

const nodeOf = (text: string, args: Record<string, unknown>): XNode | undefined =>
  named(text, args.node)

// ---------------------------------------------------------------- contexts

const CTX_PARTS = [
  'word/styles.xml',
  'word/numbering.xml',
  'word/theme/theme1.xml',
  'word/settings.xml',
]
/** Characters of parts per spec and document: every call carries its parts. */
const PARTS_BUDGET = 400_000
const MAX_CTX_INPUTS = 40

interface Parsed {
  styles: Map<string, StyleInfo>
  docDefaults?: DocDefaults
  numbering: Map<string, NumberingDef>
  numFormats: Map<string, 'bullet' | 'ordered'>
  defaultParaStyle?: StyleInfo
  themeFonts: ThemeFonts | null
  themeColors: ThemeColors | null
}

async function parse(parts: unknown): Promise<Parsed> {
  const zip = zipOf(parts)
  const theme = (await internals.parseTheme!(zip)) as {
    fonts: ThemeFonts | null
    colors: ThemeColors | null
  }
  const { styles, docDefaults } = await parseStyles(zip, theme.colors, theme.fonts)
  const { defs, formats } = await parseNumbering(zip)
  const defaultParaStyle = [...styles.values()].find((s) => s.type === 'paragraph' && s.isDefault)
  return {
    styles,
    docDefaults,
    numbering: defs,
    numFormats: formats,
    ...(defaultParaStyle ? { defaultParaStyle } : {}),
    themeFonts: theme.fonts,
    themeColors: theme.colors,
  }
}

/** Parsed once per `args.parts` array: the inputs of one document share it. */
const parsedByParts = new WeakMap<object, Promise<Parsed>>()

function parsedOf(parts: unknown): Promise<Parsed> {
  if (typeof parts !== 'object' || parts === null) return parse(parts)
  let parsed = parsedByParts.get(parts)
  if (!parsed) {
    parsed = parse(parts)
    parsedByParts.set(parts, parsed)
  }
  return parsed
}

const MEMBERS = ['styles', 'numbering', 'numFormats', 'defaultParaStyle', 'docDefaults'] as const
type Member = (typeof MEMBERS)[number]

/** The BuildContext of `args`: the members `args.ctx` names. */
async function buildCtxOf(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = await parsedOf(args.parts)
  const has = new Set(args.ctx as Member[])
  const ctx: Record<string, unknown> = {}
  for (const member of MEMBERS)
    if (has.has(member) && parsed[member] !== undefined) ctx[member] = parsed[member]
  return ctx
}

interface CompatArgs {
  compatibilityMode?: number
  doNotUseHTMLParagraphAutoSpacing?: boolean
  indentNotNumberingTabStop?: boolean
}

/** The ResolveCtx of `args`, as calls-resolve.ts builds it. */
async function rctxOf(args: Record<string, unknown>): Promise<ResolveCtx> {
  const { styles, docDefaults, numbering, themeFonts, themeColors } = await parsedOf(args.parts)
  const compat = (args.compat ?? {}) as CompatArgs
  const ctx = resolveCtxOf({
    styles,
    docDefaults,
    numbering,
    themeFonts,
    themeColors,
    compatibilityMode: compat.compatibilityMode,
    doNotUseHTMLParagraphAutoSpacing: compat.doNotUseHTMLParagraphAutoSpacing,
    indentNotNumberingTabStop: compat.indentNotNumberingTabStop,
  })
  if (args.table !== undefined) ctx.table = args.table as ResolveCtx['table']
  return ctx
}

/** The document's own context members, by name, with the size of each map then. */
interface Reference {
  values: Map<string, unknown>
  sizes: Map<string, number>
}

const references = new WeakMap<ReadonlyMap<string, string>, Reference>()

const sizeOf = (value: unknown): number => (value instanceof Map ? value.size : -1)

/**
 * The names of `names` the context has, each the document's own; undefined
 * where one is another value.
 */
function membersOf(
  parts: ReadonlyMap<string, string>,
  ctx: unknown,
  names: readonly string[],
): string[] | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const context = ctx as Record<string, unknown>
  let reference = references.get(parts)
  if (!reference) {
    reference = { values: new Map(), sizes: new Map() }
    references.set(parts, reference)
  }
  const own = context.numbering !== undefined
  const present: string[] = []
  for (const name of names) {
    const value = context[name]
    if (value === undefined) continue
    if (!reference.values.has(name)) {
      if (!own) return undefined
      reference.values.set(name, value)
      reference.sizes.set(name, sizeOf(value))
    }
    if (reference.values.get(name) !== value || reference.sizes.get(name) !== sizeOf(value))
      return undefined
    present.push(name)
  }
  return present
}

/** The parts a context is read from, one array per document. */
const ownParts = new WeakMap<
  ReadonlyMap<string, string>,
  { parts: Array<[string, string]>; cap: number }
>()

function partsOf(parts: ReadonlyMap<string, string>): {
  parts: Array<[string, string]>
  cap: number
} {
  let own = ownParts.get(parts)
  if (!own) {
    const pairs = CTX_PARTS.flatMap((name) => {
      const text = parts.get(name)
      return text === undefined ? [] : [[name, text] as [string, string]]
    })
    const size = pairs.reduce((sum, [, text]) => sum + text.length, 0)
    own = {
      parts: pairs,
      cap: Math.max(3, Math.min(MAX_CTX_INPUTS, Math.floor(PARTS_BUDGET / Math.max(1, size)))),
    }
    ownParts.set(parts, own)
  }
  return own
}

/** What each spec took per document, by its input without the parts. */
const takenByDocument = new WeakMap<ReadonlyMap<string, string>, Map<string, Set<string>>>()

/**
 * The input with the document's parts, or undefined once the spec has taken
 * as many distinct ones as the parts budget allows for this document.
 */
function withParts(
  fn: string,
  parts: ReadonlyMap<string, string>,
  input: Input,
): Input | undefined {
  const own = partsOf(parts)
  const byFn = takenByDocument.get(parts) ?? new Map<string, Set<string>>()
  takenByDocument.set(parts, byFn)
  const taken = byFn.get(fn) ?? new Set<string>()
  byFn.set(fn, taken)
  const key = JSON.stringify(input)
  if (!taken.has(key)) {
    if (taken.size >= own.cap) return undefined
    taken.add(key)
  }
  return { ...input, args: { ...input.args, parts: own.parts } }
}

// ---------------------------------------------------------------- built packages

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const style = (type: string, id: string, inner: string, attrs = ''): string =>
  `<w:style w:type="${type}" w:styleId="${id}"${attrs}><w:name w:val="${id}"/>${inner}</w:style>`

const STYLES = `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults>${[
  style('paragraph', 'Normal', '<w:rPr><w:sz w:val="24"/></w:rPr>', ' w:default="1"'),
  style('paragraph', 'Heading1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
  style('paragraph', 'Heading3', '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>'),
  style(
    'paragraph',
    'ListBullet',
    '<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:bidi w:val="0"/></w:pPr>',
  ),
  style('paragraph', 'ListPlain', '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>'),
  style('paragraph', 'NoList', '<w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>', ''),
  style(
    'paragraph',
    'RtlPara',
    '<w:pPr><w:bidi/></w:pPr><w:rPr><w:rtl/><w:szCs w:val="30"/></w:rPr>',
  ),
  style(
    'paragraph',
    'LtrPara',
    '<w:pPr><w:bidi w:val="0"/></w:pPr><w:rPr><w:sz w:val="40"/></w:rPr>',
  ),
  style('paragraph', 'Heading7x', ''),
  style('paragraph', 'constructor', '<w:pPr><w:outlineLvl w:val="4"/></w:pPr>'),
  style('character', 'Strong', '<w:rPr><w:b/><w:color w:val="00AA00"/></w:rPr>'),
  style('character', 'RtlChar', '<w:rPr><w:rtl/><w:bCs/><w:szCs w:val="36"/></w:rPr>'),
].join('')}</w:styles>`

/** No default paragraph style, no docDefaults. */
const PLAIN_STYLES = `<w:styles ${W}>${style('paragraph', 'Body', '<w:rPr><w:sz w:val="28"/></w:rPr>')}${style('paragraph', 'Heading1', '')}</w:styles>`

const NUMBERING = `<w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/><w:pPr><w:bidi/></w:pPr></w:lvl><w:lvl w:ilvl="2"><w:lvlText w:val="x"/><w:pPr><w:bidi w:val="0"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="9"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num></w:numbering>`

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Major Latin"/><a:ea typeface=""/><a:cs typeface="Major Cs"/></a:majorFont><a:minorFont><a:latin typeface="Minor Latin"/><a:ea typeface="Minor Ea"/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`

const RICH: Array<[string, string]> = [
  ['word/styles.xml', STYLES],
  ['word/numbering.xml', NUMBERING],
  ['word/theme/theme1.xml', THEME],
]
const PLAIN: Array<[string, string]> = [['word/styles.xml', PLAIN_STYLES]]
const BARE: Array<[string, string]> = []
const PACKAGES = [RICH, PLAIN, BARE]

const ALL_MEMBERS: string[] = [...MEMBERS]
const MEMBER_SETS: string[][] = [
  ALL_MEMBERS,
  ['styles', 'docDefaults'],
  ['numbering', 'numFormats'],
  [],
]

const pPr = (inner: string): string => `<w:pPr>${inner}</w:pPr>`
const numPr = (numId?: string, ilvl?: string): string =>
  `<w:numPr>${ilvl === undefined ? '' : `<w:ilvl w:val="${ilvl}"/>`}${numId === undefined ? '' : `<w:numId w:val="${numId}"/>`}</w:numPr>`

const P_PRS: Array<string | undefined> = [
  undefined,
  pPr(''),
  pPr(numPr('1', '0')),
  pPr(numPr('1', '1')),
  pPr(numPr('2')),
  pPr(numPr('0', '1')),
  pPr(numPr(undefined, '2')),
  pPr(numPr('', '1')),
  pPr(numPr('5', 'x')),
  pPr(numPr('1', '-0')),
  pPr(numPr('1', ' 3.7')),
  pPr('<w:numPr><w:numId/></w:numPr>'),
  pPr('<w:outlineLvl w:val="0"/>'),
  pPr('<w:outlineLvl w:val="8"/>'),
  pPr('<w:outlineLvl w:val="9"/>'),
  pPr('<w:outlineLvl w:val="-1"/>'),
  pPr('<w:outlineLvl w:val="3abc"/>'),
  pPr('<w:outlineLvl w:val=""/>'),
  pPr('<w:outlineLvl/>'),
]

const STYLE_IDS: Array<string | undefined> = [
  undefined,
  '',
  'Normal',
  'Heading1',
  'Heading3',
  'ListBullet',
  'ListPlain',
  'NoList',
  'RtlPara',
  'LtrPara',
  'Heading7x',
  'Heading4',
  'heading9',
  'HEADING2',
  'Heading0',
  'Heading10',
  'Head\u0131ng2',
  'Missing',
  'constructor',
  'toString',
  'Strong',
]

/** Every pPr and style id over the rich package, then the other packages and member sets. */
function nodeBuilt(): Input[] {
  const inputs: Input[] = []
  P_PRS.forEach((p, index) => {
    for (const styleId of STYLE_IDS) {
      const at = inputs.length
      const parts = index === 0 || at % 5 !== 0 ? RICH : PACKAGES[at % PACKAGES.length]!
      const ctx = at % 7 === 0 ? MEMBER_SETS[(at / 7) % MEMBER_SETS.length]! : ALL_MEMBERS
      inputs.push({
        text: p ?? '',
        args: {
          parts,
          ctx,
          ...(p === undefined ? {} : { node: 'w:pPr' }),
          ...(styleId === undefined ? {} : { styleId }),
        },
      })
    }
  })
  return inputs
}

const NODE_BUILT = nodeBuilt()

const LIST_REFS: Array<{ numId: string; ilvl: number } | undefined> = [
  undefined,
  { numId: '1', ilvl: 0 },
  { numId: '1', ilvl: 1 },
  { numId: '1', ilvl: 2 },
  { numId: '1', ilvl: 5 },
  { numId: '1', ilvl: -0 },
  { numId: '1', ilvl: 1.5 },
  { numId: '2', ilvl: 0 },
  { numId: '3', ilvl: 0 },
  { numId: '4', ilvl: 0 },
  { numId: '9', ilvl: 0 },
  { numId: '', ilvl: 0 },
  { numId: 'constructor', ilvl: 0 },
]

/** The arguments of a context reader only, over each package and member set. */
function ctxBuilt(extra: Array<Record<string, unknown>>): Input[] {
  const inputs: Input[] = []
  for (const parts of PACKAGES) {
    for (const ctx of MEMBER_SETS) {
      for (const more of extra) inputs.push({ args: { parts, ctx, ...more } })
    }
  }
  return inputs
}

// ---------------------------------------------------------------- resolved values

const PARA_INDENT = { left: 0, right: 0, firstLine: 0 }
const SPACING = { before: 0, after: 0, beforeAuto: false, afterAuto: false }

/** `values` with its keys in `order`, the order the resolver writes them in. */
function inOrder(
  order: readonly string[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of order) if (key in values) out[key] = values[key]
  return out
}

const MARK_KEYS = [
  'styleId',
  'cs',
  'bold',
  'italic',
  'sizeHalfPoints',
  'fonts',
  'color',
  'underline',
  'strike',
  'caps',
  'vanish',
  'charSpacingTwips',
  'kernHalfPoints',
  'vertAlign',
  'bdr',
  'shading',
  'eastAsiaLang',
  'source',
]

const markOf = (more: Record<string, unknown> = {}): Record<string, unknown> =>
  inOrder(MARK_KEYS, {
    cs: false,
    bold: false,
    italic: false,
    sizeHalfPoints: 20,
    fonts: {},
    underline: false,
    strike: false,
    caps: 'none',
    vanish: false,
    charSpacingTwips: 0,
    source: {},
    ...more,
  })

const EFF_KEYS = [
  'styleId',
  'align',
  'bidi',
  'indent',
  'spacing',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'widowControl',
  'contextualSpacing',
  'suppressLineNumbers',
  'snapToGrid',
  'autoSpaceDE',
  'autoSpaceDN',
  'wordWrap',
  'overflowPunct',
  'tabStops',
  'borders',
  'shading',
  'eastAsiaLang',
  'list',
  'mark',
  'hidden',
  'source',
]

const effOf = (more: Record<string, unknown> = {}): Record<string, unknown> =>
  inOrder(EFF_KEYS, {
    bidi: false,
    indent: PARA_INDENT,
    spacing: SPACING,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: true,
    contextualSpacing: false,
    suppressLineNumbers: false,
    snapToGrid: true,
    autoSpaceDE: true,
    autoSpaceDN: true,
    wordWrap: true,
    overflowPunct: true,
    tabStops: [],
    mark: markOf(),
    hidden: false,
    source: {},
    ...more,
  })

const EFFS: Array<Record<string, unknown>> = [
  effOf(),
  effOf({ styleId: 'Heading1', bidi: true, autoSpaceDE: false }),
  effOf({
    autoSpaceDN: false,
    wordWrap: false,
    overflowPunct: false,
    eastAsiaLang: 'ko-KR',
    source: { eastAsiaLang: 'paraStyle' },
  }),
  effOf({
    autoSpaceDE: false,
    autoSpaceDN: false,
    eastAsiaLang: 'zh-CN',
    source: { eastAsiaLang: 'docDefaults' },
  }),
  effOf({
    eastAsiaLang: '',
    tabStops: [
      { pos: 720, val: 'left' },
      { pos: 360, val: 'center', leader: 'dot' },
    ],
  }),
  effOf({
    bidi: true,
    tabStops: [
      { pos: 1440, val: 'right' },
      { pos: 720, val: 'decimal' },
      { pos: 720, val: 'bar' },
    ],
    indent: { left: 420, right: 210, firstLine: 0, chars: { left: 200 } },
    source: { indentFirstLine: 'paraStyle' },
  }),
  effOf({
    indent: { left: 0, right: 315, firstLine: -210, chars: { right: 150, hanging: 100 } },
    mark: markOf({ sizeHalfPoints: 36, source: { sizeHalfPoints: 'direct' } }),
  }),
  effOf({
    indent: { left: 0, right: 0, firstLine: 0, chars: { firstLine: 0 } },
    source: { indentFirstLine: 'direct' },
    mark: markOf({ sizeHalfPoints: 1, source: { sizeHalfPoints: 'paraStyle' } }),
  }),
  effOf({
    indent: { left: 0, right: 0, firstLine: 0, chars: {} },
    mark: markOf({ sizeHalfPoints: 30 }),
  }),
]

const FORMATS: Array<Record<string, unknown> | undefined> = [
  undefined,
  {},
  { align: 'left' },
  { align: 'right', bidi: false },
  { align: 'center', bidi: true },
  { align: 'left', bidiInherited: true, wordWrap: true },
  { overflowPunct: true, eastAsiaLang: 'ja-JP', autoSpace: 'latin' },
  {
    tabStops: [
      { pos: 720, val: 'right' },
      { pos: 2000, val: 'left' },
    ],
    indentFirstLine: 100,
  },
  {
    indentLeft: 5,
    indentFirstLine: 7,
    indentRight: 9,
    charIndents: { left: 1 },
    effective: effOf(),
  },
]

const EFF_P_PRS: Array<string | undefined> = [
  undefined,
  pPr(''),
  pPr('<w:ind w:leftChars="100" w:firstLineChars="0"/>'),
  pPr('<w:ind w:hangingChars="50" w:rightChars="x"/>'),
  pPr('<w:ind w:left="720"/><w:rPr><w:rtl/></w:rPr>'),
  pPr('<w:rPr><w:rtl w:val="0"/></w:rPr>'),
  pPr('<w:rPr><w:rtl w:val="off"/><w:sz w:val="40"/></w:rPr>'),
  pPr('<w:rPr><w:rtl w:val="true"/></w:rPr>'),
]

const TAB_STOPS: Array<Array<Record<string, unknown>> | undefined> = [
  undefined,
  [],
  [{ pos: 720, val: 'left' }],
  [{ pos: 720, val: 'clear' }],
  [
    { pos: 1440, val: 'center', leader: 'dot' },
    { pos: 720, val: 'right' },
    { pos: 720, val: 'decimal' },
  ],
  [
    { pos: 360, val: 'clear' },
    { pos: 2160, val: 'bar' },
    { pos: 360, val: 'left', rel: 'margin' },
  ],
  [
    { pos: 720, val: 'clear' },
    { pos: 1440, val: 'clear' },
  ],
  [
    { pos: -100, val: 'left' },
    { pos: 0, val: 'right' },
    { pos: 1440, val: 'left', inherited: true },
  ],
]

const RUNS: Array<Record<string, unknown>> = [
  { text: 'a' },
  {
    text: 'b',
    bold: false,
    italic: true,
    underline: false,
    strike: true,
    color: '1f497d',
    sizeHalfPoints: 0,
    fontAscii: '',
    caps: 'none',
  },
  {
    text: 'c',
    color: 'auto',
    sizeHalfPoints: 30,
    fontAscii: 'Arial',
    caps: 'small',
    textOutline: { color: 'FF0000', widthPt: 0.75 },
  },
  {
    text: 'd',
    effective: markOf({ cs: true, bold: true, italic: true, sizeHalfPoints: 28 }),
    ins: { author: 'A', date: '2024-01-01T00:00:00Z' },
  },
  {
    text: 'e',
    effective: markOf({ cs: false, bold: true, sizeHalfPoints: 50 }),
    del: { author: 'B' },
    color: 'FFAA00',
    caps: 'all',
  },
  { text: '', bold: true, effective: markOf({ cs: true, bold: false, sizeHalfPoints: 0 }) },
  { text: 'g', color: '12345G', sizeHalfPoints: -2 },
  { text: 'h', color: 'ABCDEF0' },
]

const BASES: Array<Record<string, unknown>> = [
  markOf(),
  markOf({
    bold: true,
    italic: true,
    underline: true,
    strike: true,
    color: 'c0504d',
    caps: 'all',
    fonts: { ascii: 'Times' },
    source: { sizeHalfPoints: 'builtin' },
  }),
  markOf({
    sizeHalfPoints: 24,
    caps: 'small',
    color: '',
    fonts: { ascii: '' },
    source: { sizeHalfPoints: 'docDefaults' },
  }),
  markOf({ sizeHalfPoints: 0, color: 'auto', source: { sizeHalfPoints: 'paraStyle' } }),
]

// ---------------------------------------------------------------- fields and notes

const ZOTERO_DOCS: string[] = [
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {&quot;a&quot;:1}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p><w:p><w:r><w:t>three</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType='begin'/></w:r><w:r><w:instrText>ADDIN </w:instrText></w:r><w:r><w:instrText>CSL_BIBLIOGRAPHY</w:instrText></w:r><w:r><w:fldChar w:fldCharType = "separate"/></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>zotero_bibl</w:instrText></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>ZOTERO_TEMP</w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p/><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>ZOTERO_ITEM \u{1F600}</w:instrText></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:t>\u{1F600}\u4E2D</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>CSL_CITATION \u{1F600}</w:instrText></w:r></w:p><w:p><w:r><w:t>\u{1F601}</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>ZOTERO_ITEM</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>\u017FOTERO_ITEM</w:instrText></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>  csl_citation &amp;</w:instrText></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="BEGIN"/></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
].map((body) => `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`)

const elementsOf = (xml: string): Array<{ name: string; start: number; end: number }> =>
  scanBody(xml).elements.map(({ name, start, end }) => ({ name, start, end }))

const NOTE_DOCS: string[] = [
  `<w:p><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="5"/></w:r></w:p><w:p><w:r><w:footnoteReference w:id="2"/><w:footnoteReference w:customMarkFollows="1" w:id="3"/><w:footnoteReference w:id="9"/></w:r></w:p>`,
  `<w:p><w:r><w:footnoteReference w:id="1"/></w:r><w:pPr><w:sectPr/></w:pPr></w:p><w:p><w:r><w:footnoteReference w:id="2"/><w:endnoteReference w:id="4"/></w:r></w:p><w:p/><w:p><w:pPr><w:sectPr></w:sectPr></w:pPr><w:r><w:footnoteReference w:id="3"/></w:r></w:p><w:p><w:r><w:footnoteReference w:id="4" w:customMarkFollows="true"/><w:footnoteReference w:id="4"/></w:r></w:p>`,
  `<w:p><w:r><w:endnoteReference w:id="6"/><w:endnoteReference w:id="5"/><w:footnoteReference w:id=""/><w:footnoteReference/></w:r></w:p><w:sectPr/>`,
  `<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr/><w:p><w:r><w:footnoteReference w:id="2"/></w:r></w:p><w:p><w:r><w:endnoteReference w:id="5"/><w:footnoteReference w:id="3"/></w:r></w:p>`,
  `<w:p><w:r><w:txbxContent><w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:txbxContent><w:footnoteReference w:id="2"/></w:r></w:p><w:p><w:r><w:footnoteReference w:id="3"/></w:r></w:p></w:p><w:p><w:r><w:footnoteReference w:id="4"/></w:r></w:p>`,
]

const notes = (ids: string[]): Array<Record<string, unknown>> =>
  ids.map((id) => ({ id, text: `note ${id}` }))

const NOTE_ARGS: Array<Record<string, unknown>> = [
  { footnotes: notes(['1', '2', '3', '4']), endnotes: notes(['4', '5', '6']) },
  {
    footnotes: notes(['1', '2', '3', '4']),
    endnotes: notes(['5', '4']),
    footnoteProps: { numRestart: 'eachSect' },
    endnoteProps: { numStart: 3 },
  },
  {
    footnotes: notes(['2', '2', '1', '3']),
    endnotes: [],
    footnoteProps: { numStart: 5, numRestart: 'eachSect' },
    endnoteProps: { numRestart: 'eachSect', numStart: 0 },
  },
  {
    footnotes: [],
    endnotes: notes(['6', '5']),
    footnoteProps: { numRestart: 'continuous', pos: 'pageBottom' },
  },
]

// ---------------------------------------------------------------- the specs

// ---------------------------------------------------------------- whole-context readers

/**
 * A whole BuildContext of `args`: every member of `buildCtxOf` present, the
 * resolver of `rctxOf`, no relationships, notes, media or section index. The
 * Rust side (calls/parse/text_ctx.rs) builds the same.
 */
async function fullCtxOf(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = await parsedOf(args.parts)
  const resolver = await rctxOf(args)
  const namespaces = args.partNamespaces as Array<[string, string]> | undefined
  return {
    styles: parsed.styles,
    numbering: parsed.numbering,
    numFormats: parsed.numFormats,
    ...(parsed.docDefaults ? { docDefaults: parsed.docDefaults } : {}),
    ...(parsed.defaultParaStyle ? { defaultParaStyle: parsed.defaultParaStyle } : {}),
    themeColors: parsed.themeColors,
    themeFonts: parsed.themeFonts,
    rels: new Map(),
    chartParts: {},
    noteNumbers: new Map(),
    sdtGroupSeq: 0,
    resolver,
    compat: resolver.compat,
    ...(typeof args.compatibilityMode === 'number'
      ? { compatibilityMode: args.compatibilityMode }
      : {}),
    xmlSpacePreserve: args.xmlSpacePreserve === true,
    ...(namespaces ? { partNamespaces: new Map(namespaces) } : {}),
  }
}

/** The ctx part of the arguments of a captured whole context: undefined where it is not the document's own. */
function fullCtxArgs(
  parts: ReadonlyMap<string, string>,
  ctx: unknown,
): Record<string, unknown> | undefined {
  const members = membersOf(parts, ctx, ['styles', 'numbering'])
  if (!members || members.length < 2) return undefined
  const context = ctx as {
    resolver?: ResolveCtx
    compat?: ResolveCtx['compat']
    compatibilityMode?: unknown
    xmlSpacePreserve?: unknown
    partNamespaces?: unknown
  }
  const compat = context.resolver?.compat ?? context.compat
  return {
    compat: {
      compatibilityMode:
        compat?.mode ??
        (typeof context.compatibilityMode === 'number' ? context.compatibilityMode : 0),
      doNotUseHTMLParagraphAutoSpacing: compat?.additiveParaSpacing ?? false,
      indentNotNumberingTabStop: compat?.indentNotNumberingTabStop ?? false,
    },
    ...(typeof context.compatibilityMode === 'number'
      ? { compatibilityMode: context.compatibilityMode }
      : {}),
    ...(context.xmlSpacePreserve === true ? { xmlSpacePreserve: true } : {}),
    ...(context.partNamespaces instanceof Map
      ? { partNamespaces: [...context.partNamespaces] }
      : {}),
  }
}

/** Parts of a paragraph the bare context cannot answer for: relationships, media, comments, shapes. */
const NEEDS_DOCUMENT =
  /r:id=|r:embed|r:link|r:pict|<w:drawing|<w:pict|<w:object|mc:AlternateContent|Reference\b|<w:sdt\b|w:fldChar|<w:tbl\b/

/** A complex field whose result is `result`: the cached runs a person may have hidden from AI. */
const markedField = (instr: string, result: string): string =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
const SEEN_RUN = '<w:r><w:rPr><w:i/></w:rPr><w:t>seen</w:t></w:r>'
const HIDDEN_RUN = '<w:r><w:rPr><w:b/><go:redact w:label="secret"/></w:rPr><w:t>hid</w:t></w:r>'

/** A complex field whose instruction run carries `rPr` (a mark hidden from AI among its properties, or none). */
const instrMarkedField = (instrRun: string, rPr: string, result: string): string =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}${instrRun}</w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
const HIDDEN_RPR = '<w:rPr><w:b/><go:redact w:label="secret"/></w:rPr>'
const INSTR = (text: string): string => `<w:instrText xml:space="preserve">${text}</w:instrText>`

/** Field instructions hidden from AI: the field's cached result is hidden with it, whatever the field. */
const HIDDEN_INSTR_FIELD_XMLS: string[] = [
  `<w:p>${instrMarkedField(INSTR(' REF bm \\h '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), HIDDEN_RPR, SEEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), HIDDEN_RPR, HIDDEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), HIDDEN_RPR, '')}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), '<w:rPr><w:b/></w:rPr>', SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), '', SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' PAGE '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' AUTHOR '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' HYPERLINK "http://example.com" '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' HYPERLINK \\l "anchor" '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' TOC \\o "1-3" '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' XE "term" '), HIDDEN_RPR, SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), '<w:rPr><redact xmlns="urn:r" w:label="a"/></w:rPr>', SEEN_RUN)}</w:p>`,
  `<w:p>${instrMarkedField(INSTR(' REF bm '), '<w:rPr><w:b/><go:redact/></w:rPr>', SEEN_RUN)}</w:p>`,
  // the second instruction run is the hidden one; the first mark wins when both are
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r>${INSTR(' REF ')}</w:r><w:r>${HIDDEN_RPR}${INSTR(' bm ')}</w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${SEEN_RUN}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><go:redact w:label="one"/></w:rPr>${INSTR(' REF ')}</w:r><w:r>${HIDDEN_RPR}${INSTR(' bm ')}</w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${SEEN_RUN}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  // a field after a hidden one is not hidden with it
  `<w:p>${instrMarkedField(INSTR(' REF a '), HIDDEN_RPR, SEEN_RUN)}${instrMarkedField(INSTR(' REF b '), '', SEEN_RUN)}</w:p>`,
  // nested: the hidden instruction sits in the inner field
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r>${INSTR(' IF ')}</w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${instrMarkedField(INSTR(' REF bm '), HIDDEN_RPR, SEEN_RUN)}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
]

/** Field results with a run marked hidden from AI, among others and alone: the result carries the mark. */
const MARKED_FIELD_XMLS: string[] = [
  ...HIDDEN_INSTR_FIELD_XMLS,
  `<w:p>${markedField(' REF bm \\h ', SEEN_RUN + HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' REF bm ', HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' REF bm ', HIDDEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' REF bm ', '')}</w:p>`,
  `<w:p>${markedField(' REF bm ', SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' HYPERLINK "http://example.com" ', HIDDEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' HYPERLINK "http://example.com" ', HIDDEN_RUN + HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' HYPERLINK "http://example.com" ', SEEN_RUN + HIDDEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' HYPERLINK \\l "anchor" ', HIDDEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' FILLIN "who" ', HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' TOC \\o "1-3" ', HIDDEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' MERGEFIELD name ', SEEN_RUN + HIDDEN_RUN + SEEN_RUN)}</w:p>`,
  `<w:p>${markedField(' PAGE ', SEEN_RUN + HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' PAGE ', HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' AUTHOR ', HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' HYPERLINK "http://example.com" ', SEEN_RUN + HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' XE "term" ', HIDDEN_RUN)}</w:p>`,
  `<w:p>${markedField(' REF bm ', '<w:r><w:rPr><redact xmlns="urn:r" w:label="a"/></w:rPr><w:t>x</w:t></w:r>')}</w:p>`,
  `<w:p>${markedField(' REF bm ', '<w:r><w:rPr><w:b/><go:redact/></w:rPr><w:t>x</w:t></w:r>')}</w:p>`,
  `<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText> REF bm </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${HIDDEN_RUN}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:fldSimple w:instr=" REF bm ">${SEEN_RUN}${HIDDEN_RUN}</w:fldSimple></w:p>`,
  `<w:p><w:fldSimple w:instr=" REF bm ">${HIDDEN_RUN}</w:fldSimple></w:p>`,
  `<w:p><w:fldSimple w:instr=" PAGE ">${SEEN_RUN}${HIDDEN_RUN}</w:fldSimple></w:p>`,
  `<w:p><w:fldSimple w:instr=" MERGEFIELD name ">${HIDDEN_RUN}</w:fldSimple></w:p>`,
  `<w:p><w:fldSimple w:instr=" XE &quot;t&quot; ">${HIDDEN_RUN}</w:fldSimple></w:p>`,
  `<w:p><w:fldSimple w:instr=" PAGE " w:dirty="1">${SEEN_RUN}</w:fldSimple></w:p>`,
]

const P_XMLS: string[] = [
  ...MARKED_FIELD_XMLS,
  '<w:p/>',
  '<w:p><w:r><w:t>plain</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:jc w:val="center"/><w:ind w:left="720" w:firstLine="360"/><w:spacing w:before="120" w:after="60" w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve"> spaced </w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="RtlPara"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:rtl/><w:szCs w:val="44"/></w:rPr><w:t>rtl</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:ind w:leftChars="200" w:firstLineChars="100"/></w:pPr><w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t>chars</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:br w:type="page"/><w:t>c</w:t></w:r></w:p>',
  '<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>',
  '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '<w:p><w:hyperlink w:anchor="x"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:hyperlink w:tooltip="t"><w:r><w:t>none</w:t></w:r></w:hyperlink></w:p>',
  '<w:p><w:ins w:id="1" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r><w:t>in</w:t></w:r></w:ins><w:del w:id="2" w:author="B"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
  '<w:p><w:r><w:sym w:font="Wingdings" w:char="F0FC"/><w:t>x</w:t><w:sym w:font="Symbol" w:char="F061"/></w:r></w:p>',
  '<w:p><w:r><w:rPr><w:rStyle w:val="Strong"/><w:i/><w:color w:val="FF0000"/><w:sz w:val="40"/><w:vertAlign w:val="superscript"/><w:u w:val="single"/><w:highlight w:val="yellow"/></w:rPr><w:t> x </w:t></w:r></w:p>',
  '<w:p><w:bookmarkStart w:id="0" w:name="b"/><w:smartTag w:uri="u" w:element="e"><w:r><w:t>s</w:t></w:r></w:smartTag><w:bookmarkEnd w:id="0"/></w:p>',
  '<w:p><w:sdt><w:sdtPr><w:alias w:val="A"/><w:tag w:val="t"/></w:sdtPr><w:sdtContent><w:r><w:t>c</w:t></w:r></w:sdtContent></w:sdt></w:p>',
  '<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:t>after</w:t></w:r></w:p>',
  '<w:p><m:oMathPara><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:oMathPara></w:p>',
  '<w:p><w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/></w:rubyPr><w:rt><w:r><w:t>rt</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>base</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>',
  '<w:p><w:r><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>three</w:t></w:r></w:p>',
  '<w:p><w:r><w:noBreakHyphen/><w:softHyphen/><w:cr/><w:t>\u00a0nbsp</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:rPr><w:sz w:val="48"/></w:rPr></w:pPr></w:p>',
  '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION {} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>(Smith)</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '<w:p><w:r><w:drawing><wp:anchor distL="0" distR="0"><wp:positionH relativeFrom="column"><wp:posOffset>95250</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>9525</wp:posOffset></wp:positionV><wp:extent cx="5000000" cy="9525"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></wps:spPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="100" cy="100"/></wp:anchor></w:drawing></w:r><w:r><w:t>text</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="clear" w:pos="1440"/></w:tabs><w:shd w:val="clear" w:fill="FFFF00"/></w:pPr><w:r><w:t>tabs</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>unclosed',
  '<w:r><w:t>not a paragraph</w:t></w:r>',
]

/** Every paragraph over each package, with the context knobs turned in turn. */
function paraBuilt(extra: (index: number) => Record<string, unknown> = () => ({})): Input[] {
  const inputs: Input[] = []
  P_XMLS.forEach((text, index) => {
    const parts = PACKAGES[index % PACKAGES.length]!
    inputs.push({ text, args: { parts, ...extra(index) } })
    inputs.push({
      text,
      args: {
        parts: RICH,
        compat: { compatibilityMode: 15 },
        xmlSpacePreserve: index % 2 === 0,
        partNamespaces: [
          ['w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'],
          ['m', 'http://schemas.openxmlformats.org/officeDocument/2006/math'],
        ],
        ...extra(index + 1),
      },
    })
  })
  return inputs
}

/** A paragraph of a document the bare context stands for. */
const plainParagraph = (xml: unknown): xml is string =>
  typeof xml === 'string' && !NEEDS_DOCUMENT.test(xml)

const STYLE_BIDIS = [undefined, false, true]

const P_PRS_DEFINED = P_PRS.filter((p): p is string => p !== undefined)

/** A pPr node over each package, style and theme flag. */
function pPrBuilt(extra: (index: number) => Record<string, unknown>): Input[] {
  return P_PRS_DEFINED.flatMap((p, index) =>
    [RICH, PLAIN, BARE].map((parts, at) => ({
      text: p,
      args: { parts, node: 'w:pPr', ...extra(index + at) },
    })),
  )
}

const P_NODE_RUNS: Array<Array<Record<string, unknown>>> = [
  [],
  [{ text: '' }],
  [{ text: 'a' }],
  [
    { text: '', sizeHalfPoints: 99 },
    { text: 'b', sizeHalfPoints: 30 },
  ],
  [{ text: 'c', styleId: 'Strong' }],
  [{ text: 'd', styleId: 'Missing' }],
  [{ text: 'e', sizeHalfPoints: 0 }],
]

const SIZE_PARAS = [
  '<w:p/>',
  '<w:p><w:pPr><w:rPr><w:sz w:val="44"/></w:rPr></w:pPr></w:p>',
  '<w:p><w:pPr><w:rPr><w:szCs w:val="26"/><w:rtl/></w:rPr></w:pPr></w:p>',
  '<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t>a</w:t></w:r></w:p>',
]

function sizeBuilt(): Input[] {
  const inputs: Input[] = []
  P_NODE_RUNS.forEach((runs, index) => {
    SIZE_PARAS.forEach((pNode, at) => {
      for (const styleId of [undefined, 'Body', 'Heading1', 'RtlPara', 'Missing']) {
        const own = at % 2 === 0
        inputs.push({
          text: own ? '' : (/<w:pPr>.*<\/w:pPr>/.exec(pNode)?.[0] ?? ''),
          args: {
            parts: PACKAGES[(index + at) % PACKAGES.length]!,
            runs,
            pNode,
            ...(own ? {} : { node: 'w:pPr' }),
            ...(styleId === undefined ? {} : { styleId }),
          },
        })
      }
    })
  })
  return inputs
}

const NOTES_PARTS: string[] = [
  `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> First </w:t></w:r><w:r><w:rPr><w:b/><w:i/><w:color w:val="ff0000"/><w:sz w:val="30"/><w:rFonts w:ascii="Arial"/><w:caps/></w:rPr><w:t>styled</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:before="100" w:after="50" w:line="300" w:lineRule="exact"/></w:pPr><w:ins w:id="9" w:author="Z"><w:r><w:t>two</w:t></w:r></w:ins></w:p></w:footnote></w:footnotes>`,
  `<w:endnotes ${W}><w:endnote w:id="1"><w:p><w:r><w:t>end</w:t></w:r></w:p></w:endnote><w:endnote w:id="x"><w:p><w:r><w:t>bad id</w:t></w:r></w:p></w:endnote></w:endnotes>`,
  `<w:footnotes ${W}><w:footnote w:id="3"><w:p><w:r><w:drawing/></w:r><w:r><w:t>pic</w:t></w:r></w:p></w:footnote><w:footnote w:id="4"/><w:footnote w:id="5"><w:p/></w:footnote></w:footnotes>`,
  `<w:footnotes ${W}/>`,
  'not xml',
  '',
]

/** A TypeScript spec for a function of one paragraph's XML and the context. */
function paragraphSpec(
  fn: string,
  call: (xml: string, ctx: Record<string, unknown>) => unknown,
  extra?: Partial<CallSpec>,
): CallSpec {
  return {
    fn: `parse.${fn}`,
    call: async (text, args) => call(text, await fullCtxOf(args)),
    fromParse: {
      fn,
      input: ([xml, ctx], parts) => {
        const own = fullCtxArgs(parts, ctx)
        if (!own || !plainParagraph(xml)) return undefined
        return withParts(fn, parts, { text: xml, args: own })
      },
    },
    built: paraBuilt(),
    ...extra,
  }
}

const PARSE_TEXT_B2: CallSpec[] = [
  {
    fn: 'parse.outlineOnlyHeading',
    call: async (text, args) =>
      internals.outlineOnlyHeading!(nodeOf(text, args), args.styleId, await fullCtxOf(args)),
    fromParse: {
      fn: 'outlineOnlyHeading',
      input: ([pPr, styleId, ctx], parts) => {
        const p = nodeInput(pPr)
        const own = fullCtxArgs(parts, ctx)
        if (!p || !own || (styleId !== undefined && typeof styleId !== 'string')) return undefined
        return withParts('outlineOnlyHeading', parts, {
          text: p.text,
          args: {
            ...own,
            ...(p.node ? { node: p.node } : {}),
            ...(styleId === undefined ? {} : { styleId }),
          },
        })
      },
    },
    built: [
      ...NODE_BUILT,
      ...[
        '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>',
        '<w:pPr><w:outlineLvl w:val="9"/><w:pStyle w:val="Heading1"/></w:pPr>',
        '<w:pPr/>',
      ].flatMap((p) =>
        STYLE_IDS.map((styleId) => ({
          text: p,
          args: { parts: RICH, node: 'w:pPr', ...(styleId === undefined ? {} : { styleId }) },
        })),
      ),
    ],
    mutation: 'none',
  },
  {
    fn: 'parse.inheritedCsFont',
    call: async (_text, args) =>
      internals.inheritedCsFont!(args.rStyleId, args.pStyleId, await fullCtxOf(args)),
    fromParse: {
      fn: 'inheritedCsFont',
      input: ([rStyleId, pStyleId, ctx], parts) => {
        const own = fullCtxArgs(parts, ctx)
        if (
          !own ||
          (rStyleId !== undefined && typeof rStyleId !== 'string') ||
          (pStyleId !== undefined && typeof pStyleId !== 'string')
        )
          return undefined
        return withParts('inheritedCsFont', parts, {
          args: {
            ...own,
            ...(rStyleId === undefined ? {} : { rStyleId }),
            ...(pStyleId === undefined ? {} : { pStyleId }),
          },
        })
      },
    },
    built: PACKAGES.flatMap((parts) =>
      STYLE_IDS.flatMap((rStyleId, index) =>
        [STYLE_IDS[(index * 5 + 3) % STYLE_IDS.length], undefined].map((pStyleId) => ({
          args: {
            parts,
            ...(rStyleId === undefined ? {} : { rStyleId }),
            ...(pStyleId === undefined ? {} : { pStyleId }),
          },
        })),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.paraCsSize',
    call: async (_text, args) => internals.paraCsSize!(await fullCtxOf(args), args.styleId),
    fromParse: {
      fn: 'paraCsSize',
      input: ([ctx, styleId], parts) => {
        const own = fullCtxArgs(parts, ctx)
        if (!own || (styleId !== undefined && typeof styleId !== 'string')) return undefined
        return withParts('paraCsSize', parts, {
          args: { ...own, ...(styleId === undefined ? {} : { styleId }) },
        })
      },
    },
    built: PACKAGES.flatMap((parts) =>
      STYLE_IDS.map((styleId) => ({
        args: { parts, ...(styleId === undefined ? {} : { styleId }) },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.paraTextSizeHalfPoints',
    call: async (text, args) =>
      internals.paraTextSizeHalfPoints!(
        await fullCtxOf(args),
        args.runs,
        named(args.pNode as string, 'w:p'),
        nodeOf(text, args),
        args.styleId,
      ),
    fromParse: {
      fn: 'paraTextSizeHalfPoints',
      input: ([ctx, runs, pNode, pPr, styleId], parts) => {
        const own = fullCtxArgs(parts, ctx)
        const p = nodeInput(pPr)
        if (
          !own ||
          !Array.isArray(runs) ||
          !isNode(pNode) ||
          (pPr !== undefined && !p) ||
          (styleId !== undefined && typeof styleId !== 'string')
        )
          return undefined
        return withParts('paraTextSizeHalfPoints', parts, {
          text: p?.text ?? '',
          args: {
            ...own,
            runs: json(runs),
            pNode: serializeXNode(pNode),
            ...(p?.node ? { node: p.node } : {}),
            ...(styleId === undefined ? {} : { styleId }),
          },
        })
      },
    },
    built: sizeBuilt(),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.charUnitsOf',
    call: async (text, args) =>
      internals.charUnitsOf!(
        await fullCtxOf(args),
        args.runs,
        named(args.pNode as string, 'w:p'),
        nodeOf(text, args),
        args.styleId,
        undefined,
      ),
    fromParse: {
      fn: 'charUnitsOf',
      input: ([ctx, runs, pNode, pPr, styleId, docOffset], parts) => {
        const own = fullCtxArgs(parts, ctx)
        const p = nodeInput(pPr)
        if (
          docOffset !== undefined ||
          !own ||
          !Array.isArray(runs) ||
          !isNode(pNode) ||
          (pPr !== undefined && !p) ||
          (styleId !== undefined && typeof styleId !== 'string')
        )
          return undefined
        return withParts('charUnitsOf', parts, {
          text: p?.text ?? '',
          args: {
            ...own,
            runs: json(runs),
            pNode: serializeXNode(pNode),
            ...(p?.node ? { node: p.node } : {}),
            ...(styleId === undefined ? {} : { styleId }),
          },
        })
      },
    },
    built: sizeBuilt(),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.extractParaFormat',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => {
      const parsed = await parsedOf(args.parts)
      return internals.extractParaFormat!(
        nodeOf(text, args),
        args.theme ? parsed.themeColors : undefined,
        args.styleBidi,
      )
    },
    fromParse: {
      fn: 'extractParaFormat',
      input: ([pPr, theme, styleBidi], parts) => {
        const p = nodeInput(pPr)
        if (!p || !p.node || (styleBidi !== undefined && typeof styleBidi !== 'boolean'))
          return undefined
        if (theme !== undefined && theme !== null && typeof theme !== 'object') return undefined
        return withParts('extractParaFormat', parts, {
          text: p.text,
          args: {
            node: p.node,
            theme: theme !== undefined && theme !== null,
            ...(styleBidi === undefined ? {} : { styleBidi }),
          },
        })
      },
    },
    built: pPrBuilt((index) => ({
      theme: index % 2 === 0,
      ...(STYLE_BIDIS[index % 3] === undefined ? {} : { styleBidi: STYLE_BIDIS[index % 3] }),
    })),
    mutation: 'none',
  },
  {
    fn: 'parse.pPrOnlyFormat',
    call: async (text, args) => {
      const parsed = await parsedOf(args.parts)
      return internals.pPrOnlyFormat!(
        nodeOf(text, args),
        args.theme ? parsed.themeColors : undefined,
      )
    },
    fromParse: {
      fn: 'pPrOnlyFormat',
      input: ([pPr, theme], parts) => {
        const p = nodeInput(pPr)
        if (!p || !p.node || (theme !== undefined && theme !== null && typeof theme !== 'object'))
          return undefined
        return withParts('pPrOnlyFormat', parts, {
          text: p.text,
          args: { node: p.node, theme: theme !== undefined && theme !== null },
        })
      },
    },
    built: pPrBuilt((index) => ({ theme: index % 2 === 0 })),
    mutation: 'none',
  },
  {
    fn: 'parse.resolvedParaFormat',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => {
      const parsed = await parsedOf(args.parts)
      return internals.resolvedParaFormat!(
        args.eff,
        nodeOf(text, args),
        args.theme ? parsed.themeColors : undefined,
      )
    },
    fromParse: {
      fn: 'resolvedParaFormat',
      input: ([eff, pPr, theme], parts) => {
        const p = nodeInput(pPr)
        if (
          !eff ||
          typeof eff !== 'object' ||
          (pPr !== undefined && !p) ||
          (theme !== undefined && theme !== null && typeof theme !== 'object')
        )
          return undefined
        return withParts('resolvedParaFormat', parts, {
          text: p?.text ?? '',
          args: {
            eff: json(eff),
            ...(p?.node ? { node: p.node } : {}),
            theme: theme !== undefined && theme !== null,
          },
        })
      },
    },
    built: EFFS.flatMap((eff, index) =>
      [undefined, ...P_PRS_DEFINED.filter((_, at) => at % 3 === index % 3)].map((p, at) => ({
        text: p ?? '',
        args: {
          parts: PACKAGES[(index + at) % PACKAGES.length]!,
          eff,
          ...(p === undefined ? {} : { node: 'w:pPr' }),
          theme: at % 2 === 0,
        },
      })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  paragraphSpec('anchorLineOf', (xml, ctx) => internals.anchorLineOf!(xml, ctx), {
    mutation: 'none',
  }),
  paragraphSpec('strayAnchorLine', (xml, ctx) => internals.strayAnchorLine!(xml, ctx), {
    mutation: 'none',
  }),
  paragraphSpec('anchoredRuleOverlays', (xml, ctx) => internals.anchoredRuleOverlays!(xml, ctx), {
    mutation: 'none',
  }),
  {
    fn: 'parse.cellResolverOf',
    call: async (_text, args) => {
      const scoped = internals.cellResolverOf!(
        await fullCtxOf(args),
        args.tableStyleId,
        args.cond,
      ) as ResolveCtx
      return { table: scoped.table, compat: scoped.compat }
    },
    fromParse: {
      fn: 'cellResolverOf',
      input: ([ctx, tableStyleId, cond], parts) => {
        const own = fullCtxArgs(parts, ctx)
        if (
          !own ||
          !Array.isArray(cond) ||
          (tableStyleId !== undefined && typeof tableStyleId !== 'string')
        )
          return undefined
        return withParts('cellResolverOf', parts, {
          args: {
            ...own,
            cond: json(cond),
            ...(tableStyleId === undefined ? {} : { tableStyleId }),
          },
        })
      },
    },
    built: PACKAGES.flatMap((parts) =>
      [undefined, '', 'TableGrid', 'constructor'].flatMap((tableStyleId) =>
        [[], [{ type: 'firstRow' }], [{ type: 'band1Horz' }, { type: 'lastCol' }]].map((cond) => ({
          args: {
            parts,
            compat: { compatibilityMode: 15 },
            cond,
            ...(tableStyleId === undefined ? {} : { tableStyleId }),
          },
        })),
      ),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.attachInlineContentControls',
    call: (text, args) => {
      const block = json(args.block as Record<string, unknown>)
      internals.attachInlineContentControls!(block, text)
      return block
    },
    fromParse: {
      fn: 'attachInlineContentControls',
      input: ([block, xml]) => {
        if (!block || typeof block !== 'object' || typeof xml !== 'string') return undefined
        return { text: xml, args: { block: json(block) } }
      },
    },
    built: [
      ...P_XMLS,
      '<w:p><w:sdt><w:sdtPr><w:alias w:val="A"/><w:tag w:val="t"/></w:sdtPr><w:sdtContent><w:r><w:t>c</w:t></w:r></w:sdtContent></w:sdt></w:p>',
      '<w:pPr/><w:sdt><w:sdtContent/></w:sdt>',
      '<w:pxx><w:sdt><w:sdtContent/></w:sdt></w:pxx>',
    ].flatMap((text) => [
      { text, args: { block: { id: 'b0', docxIndex: 0, type: 'paragraph', runs: [] } } },
      {
        text,
        args: {
          block: {
            id: 'b0',
            docxIndex: 0,
            type: 'paragraph',
            runs: [],
            inlineContentControls: [{ alias: 'kept' }],
          },
        },
      },
    ]),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.extractRuns',
    call: async (text, args) => {
      const ctx = await fullCtxOf(args)
      const pNode = (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === 'w:p')
      return internals.extractRuns!(pNode, ctx, args.math, args.ruby, args.withImages, args.zotero)
    },
    fromParse: {
      fn: 'extractRuns',
      input: ([pNode, ctx, math, ruby, withImages, zotero, para, raw], parts) => {
        const own = fullCtxArgs(parts, ctx)
        if (!own || !isNode(pNode) || para !== undefined || raw !== undefined) return undefined
        const xml = serializeXNode(pNode)
        if (!plainParagraph(xml) || !Array.isArray(math ?? []) || !Array.isArray(ruby ?? []))
          return undefined
        return withParts('extractRuns', parts, {
          text: xml,
          args: {
            ...own,
            ...(math ? { math: json(math) } : {}),
            ...(ruby ? { ruby: json(ruby) } : {}),
            ...(withImages ? { withImages: true } : {}),
            ...(zotero ? { zotero: json(zotero) } : {}),
          },
        })
      },
    },
    built: [
      ...paraBuilt(),
      ...P_XMLS.flatMap((text) => [
        {
          text,
          args: {
            parts: RICH,
            math: ['<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>', '<m:oMathPara/>'],
            ruby: ['<w:ruby/>'],
            withImages: true,
            zotero: { id: 7, instruction: 'ADDIN ZOTERO_ITEM {}', part: 'single' },
          },
        },
        {
          text,
          args: {
            parts: PLAIN,
            withImages: true,
            zotero: { id: 2, instruction: ' ADDIN ZOTERO_BIBL ', part: 'begin' },
          },
        },
      ]),
    ],
    mutation: 'none',
  },
  {
    fn: 'parse.buildTextParagraph',
    listed: lineRuleOutsideItsType,
    call: async (text, args) =>
      internals.buildTextParagraph!(
        { id: args.id, docxIndex: args.docxIndex, originalXml: text },
        text,
        await fullCtxOf(args),
        args.withImages,
        undefined,
        args.zotero,
      ),
    fromParse: {
      fn: 'buildTextParagraph',
      input: ([base, xml, ctx, withImages, docOffset, zotero], parts) => {
        const own = fullCtxArgs(parts, ctx)
        const b = base as { id?: unknown; docxIndex?: unknown; originalXml?: unknown } | undefined
        if (
          !own ||
          docOffset !== undefined ||
          !plainParagraph(xml) ||
          !b ||
          typeof b.id !== 'string' ||
          typeof b.docxIndex !== 'number' ||
          b.originalXml !== xml
        )
          return undefined
        return withParts('buildTextParagraph', parts, {
          text: xml,
          args: {
            ...own,
            id: b.id,
            docxIndex: b.docxIndex,
            ...(withImages ? { withImages: true } : {}),
            ...(zotero ? { zotero: json(zotero) } : {}),
          },
        })
      },
    },
    built: paraBuilt(() => ({ id: 'b3', docxIndex: 3 })).flatMap((input) => [
      input,
      { ...input, args: { ...input.args, withImages: true } },
    ]),
    mutation: 'none',
  },
  {
    fn: 'parse.standaloneNoteParagraphReader',
    listed: lineRuleOutsideItsType,
    call: (text, args) =>
      parseNotesXml(
        text,
        args.kind as NoteKind,
        internals.standaloneNoteParagraphReader!() as NoteParagraphReader,
      ),
    built: [...NOTES_PARTS, ...NOTE_PARTS].flatMap((text) =>
      (['footnote', 'endnote'] as const).map((kind) => ({
        text: kind === 'endnote' ? text.replaceAll('w:footnote', 'w:endnote') : text,
        args: { kind },
      })),
    ),
  },
]

export const PARSE_TEXT: CallSpec[] = [
  {
    fn: 'parse.breakCharOf',
    call: (_text, args) => internals.breakCharOf!(args.attrs),
    fromParse: {
      fn: 'breakCharOf',
      input: ([attrs]) => {
        const own = attrsOf(attrs)
        return own ? { args: { attrs: own } } : undefined
      },
    },
    built: [
      {},
      { 'w:type': 'page' },
      { 'w:type': 'column' },
      { 'w:type': 'textWrapping' },
      { 'w:type': 'page', 'w:clear': 'all' },
      { 'w:clear': '' },
      { 'w:clear': 'none' },
      { 'w:type': 'constructor' },
      { 'w:type': '__proto__' },
      { 'w:type': 'Page' },
    ].map((attrs) => ({ args: { attrs } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.wtText',
    call: (text, args) => internals.wtText!(text, args.preserve),
    fromParse: {
      fn: 'wtText',
      input: ([raw, preserve]) =>
        typeof raw === 'string' && typeof preserve === 'boolean'
          ? { text: raw, args: { preserve } }
          : undefined,
    },
    built: [
      '',
      ' a ',
      '\ta\tb\t',
      'a\r\nb',
      'a\rb',
      'a\n\rb',
      ' \r\n ',
      '\u00a0x\u00a0',
      '\u3000y',
      'a\u2028b',
    ].flatMap((text) => [true, false].map((preserve) => ({ text, args: { preserve } }))),
  },
  {
    fn: 'parse.emuToPx',
    call: (_text, args) => internals.emuToPx!(args.emu),
    fromParse: {
      fn: 'emuToPx',
      input: ([emu]) =>
        typeof emu === 'number' && Number.isFinite(emu) ? { args: { emu } } : undefined,
    },
    built: [
      0, 9525, 4762.5, 12345, -9525, 1e15, 0.5, 47.625, 95.25, 238.125, -238.125, -4762.5, 1e300,
      5e-324, 914400, 1270,
    ].map((emu) => ({ args: { emu } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.listRefOf',
    call: async (text, args) =>
      internals.listRefOf!(await buildCtxOf(args), nodeOf(text, args), args.styleId),
    fromParse: {
      fn: 'listRefOf',
      input: ([ctx, node, styleId], parts) => {
        const p = nodeInput(node)
        const ctxMembers = membersOf(parts, ctx, ['styles'])
        if (!p || !ctxMembers || (styleId !== undefined && typeof styleId !== 'string'))
          return undefined
        return withParts('listRefOf', parts, {
          text: p.text,
          args: {
            ctx: ctxMembers,
            ...(p.node ? { node: p.node } : {}),
            ...(styleId === undefined ? {} : { styleId }),
          },
        })
      },
    },
    built: NODE_BUILT,
  },
  {
    fn: 'parse.listKindOf',
    call: async (_text, args) =>
      internals.listKindOf!(await buildCtxOf(args), args.numId, args.ilvl),
    fromParse: {
      fn: 'listKindOf',
      input: ([ctx, numId, ilvl], parts) => {
        const ctxMembers = membersOf(parts, ctx, ['numbering', 'numFormats'])
        if (
          !ctxMembers ||
          typeof numId !== 'string' ||
          typeof ilvl !== 'number' ||
          !Number.isFinite(ilvl)
        )
          return undefined
        return withParts('listKindOf', parts, { args: { ctx: ctxMembers, numId, ilvl } })
      },
    },
    built: ctxBuilt(LIST_REFS.filter((ref) => ref !== undefined)),
    mutation: 'none',
  },
  {
    fn: 'parse.headingLevelOf',
    call: async (text, args) =>
      internals.headingLevelOf!(nodeOf(text, args), args.styleId, await buildCtxOf(args)),
    fromParse: {
      fn: 'headingLevelOf',
      input: ([node, styleId, ctx], parts) => {
        const p = nodeInput(node)
        const ctxMembers = membersOf(parts, ctx, ['styles'])
        if (!p || !ctxMembers || (styleId !== undefined && typeof styleId !== 'string'))
          return undefined
        return withParts('headingLevelOf', parts, {
          text: p.text,
          args: {
            ctx: ctxMembers,
            ...(p.node ? { node: p.node } : {}),
            ...(styleId === undefined ? {} : { styleId }),
          },
        })
      },
    },
    built: NODE_BUILT,
  },
  {
    fn: 'parse.styleBidiOf',
    call: async (_text, args) =>
      internals.styleBidiOf!(await buildCtxOf(args), args.styleId, args.listRef),
    fromParse: {
      fn: 'styleBidiOf',
      input: ([ctx, styleId, listRef], parts) => {
        const ctxMembers = membersOf(parts, ctx, [
          'styles',
          'numbering',
          'defaultParaStyle',
          'docDefaults',
        ])
        if (!ctxMembers || (styleId !== undefined && typeof styleId !== 'string')) return undefined
        return withParts('styleBidiOf', parts, {
          args: {
            ctx: ctxMembers,
            ...(styleId === undefined ? {} : { styleId }),
            ...(listRef === undefined ? {} : { listRef: json(listRef) }),
          },
        })
      },
    },
    built: ctxBuilt(
      LIST_REFS.flatMap((listRef, index) =>
        [STYLE_IDS[index % STYLE_IDS.length], STYLE_IDS[(index * 3 + 7) % STYLE_IDS.length]].map(
          (styleId) => ({
            ...(styleId === undefined ? {} : { styleId }),
            ...(listRef === undefined ? {} : { listRef }),
          }),
        ),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.normalSizeHalfPoints',
    call: async (_text, args) => internals.normalSizeHalfPoints!(await buildCtxOf(args)),
    fromParse: {
      fn: 'normalSizeHalfPoints',
      input: ([ctx], parts) => {
        const ctxMembers = membersOf(parts, ctx, ['defaultParaStyle', 'docDefaults'])
        return ctxMembers
          ? withParts('normalSizeHalfPoints', parts, { args: { ctx: ctxMembers } })
          : undefined
      },
    },
    built: ctxBuilt([{}]),
    mutation: 'none',
  },
  {
    fn: 'parse.paraStyleDisplay',
    listed: lineRuleOutsideItsType,
    call: async (_text, args) => internals.paraStyleDisplay!(await buildCtxOf(args), args.styleId),
    fromParse: {
      fn: 'paraStyleDisplay',
      input: ([ctx, styleId], parts) => {
        const ctxMembers = membersOf(parts, ctx, ['styles', 'defaultParaStyle'])
        if (!ctxMembers || (styleId !== undefined && typeof styleId !== 'string')) return undefined
        return withParts('paraStyleDisplay', parts, {
          args: { ctx: ctxMembers, ...(styleId === undefined ? {} : { styleId }) },
        })
      },
    },
    built: ctxBuilt(STYLE_IDS.map((styleId) => (styleId === undefined ? {} : { styleId }))),
    mutation: 'none',
  },
  {
    fn: 'parse.defaultParaStyle',
    listed: lineRuleOutsideItsType,
    call: async (_text, args) =>
      internals.defaultParaStyle!(
        (args.ctx as string[]).includes('styles') ? (await parsedOf(args.parts)).styles : undefined,
      ),
    fromParse: {
      fn: 'defaultParaStyle',
      input: ([styles], parts) => {
        const ctxMembers = membersOf(parts, { styles }, ['styles'])
        return ctxMembers
          ? withParts('defaultParaStyle', parts, { args: { ctx: ctxMembers } })
          : undefined
      },
    },
    built: [
      ...PACKAGES,
      [
        [
          'word/styles.xml',
          `<w:styles ${W}>${style('character', 'C', '', ' w:default="1"')}${style('table', 'T', '', ' w:default="1"')}${style('paragraph', 'P1', '<w:rPr><w:i/></w:rPr>', ' w:default="1"')}${style('paragraph', 'P2', '', ' w:default="1"')}</w:styles>`,
        ] as [string, string],
      ],
    ].flatMap((parts) => [['styles'], []].map((ctx) => ({ args: { parts, ctx } }))),
    mutation: 'none',
  },
  {
    fn: 'parse.inlineContentControlsOf',
    call: (text) => internals.inlineContentControlsOf!(text),
    fromParse: {
      fn: 'inlineContentControlsOf',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: [
      '<w:p><w:r><w:t>plain</w:t></w:r></w:p>',
      '<w:p><w:sdt><w:sdtPr><w:alias w:val="Name"/><w:tag w:val="t1"/><w:lock w:val="sdtLocked"/><w:id w:val="42"/></w:sdtPr><w:sdtContent><w:r><w:t>in &amp; out</w:t></w:r></w:sdtContent></w:sdt></w:p>',
      '<w:p><w:sdt><w:sdtPr><w:tag w:val=\'single\'/></w:sdtPr><w:sdtContent><w:sdt><w:sdtPr><w:alias w:val="inner"/></w:sdtPr><w:sdtContent><w:r><w:t>nested</w:t></w:r></w:sdtContent></w:sdt></w:sdtContent></w:sdt></w:p>',
      '<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>block</w:t></w:r></w:p></w:sdtContent></w:sdt>',
      '<w:p><w:sdt><w:sdtContent><w:tbl/></w:sdtContent></w:sdt><w:sdt><w:sdtContent><w:tbl><w:tr/></w:tbl></w:sdtContent></w:sdt><w:sdt><w:sdtContent><w:pPr/></w:sdtContent></w:sdt></w:p>',
      '<w:p><w:sdt><w:sdtPr><w:id w:val="-1"/></w:sdtPr><w:sdtContent></w:sdtContent></w:sdt><w:sdt><w:sdtPr/></w:sdt></w:p>',
      '<w:p><w:sdt><w:sdtContent><w:r><w:t>unclosed</w:t></w:r></w:sdtContent></w:p>',
      '<w:p><w:sdt><w:sdtPr><w:alias w:val="\u{1F600}"/></w:sdtPr><w:sdtContent><w:r><w:t>\u{1F601}x</w:t></w:r><w:r><w:tab/></w:r></w:sdtContent></w:sdt></w:p>',
      // hidden from AI: a control holding hidden runs, in every spelling of the mark
      ...marks().map(
        (mark) =>
          `<w:p><w:sdt><w:sdtPr><w:tag w:val="phone"/></w:sdtPr><w:sdtContent>${plainRun('Call ')}${hiddenRun('138', mark)}${hiddenRun('000', mark)}${plainRun(' now')}</w:sdtContent></w:sdt></w:p>`,
      ),
      // a mark no run accounts for, one outside the control, a control inside a hidden run
      `<w:p><w:sdt><w:sdtContent><w:r><w:t>a</w:t><go:redact w:label="x"/></w:r></w:sdtContent></w:sdt></w:p>`,
      `<w:p>${hiddenRun('outside', '<go:redact w:label="x"/>')}<w:sdt><w:sdtContent>${plainRun('inside')}</w:sdtContent></w:sdt></w:p>`,
      `<w:p><w:sdt><w:sdtContent><w:r><w:rPr><go:redact w:label="x"/></w:rPr><w:sdt><w:sdtContent>${plainRun('nested')}</w:sdtContent></w:sdt></w:r></w:sdtContent></w:sdt></w:p>`,
      // tags a pattern reads differently from the parser
      `<w:p><w:sdt w:x="a>b"><w:sdtPr><w:tag w:val='a&amp;b'/><w:alias w:val = "T"/></w:sdtPr><w:sdtContent>${plainRun('a&#65;b')}</w:sdtContent></w:sdt></w:p>`,
      `<w:p><w:sdt><w:sdtContent><w:r><w:t><![CDATA[<w:sdt><w:sdtContent><w:r><w:t>fake</w:t></w:r></w:sdtContent></w:sdt>]]></w:t></w:r></w:sdtContent></w:sdt></w:p>`,
      `<w:p><!-- <w:sdt><w:sdtContent><w:r><w:t>fake</w:t></w:r></w:sdtContent></w:sdt> --><w:sdt><w:sdtContent>${plainRun('real')}</w:sdtContent></w:sdt></w:p>`,
      '<w:p><w:sdt><w:sdtPr><w:tag/><w:alias w:val=""/><w:lock/><w:id w:val="1"/></w:sdtPr><w:sdtContent/></w:sdt><w:sdt/></w:p>',
      '<w:p><w:r><w:t>unclosed',
      ...ENTRIES,
      ...STORIES.map((story) => story.document),
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.crossParagraphZoteroFields',
    call: (text, args) => internals.crossParagraphZoteroFields!(args.elements, text),
    fromParse: {
      fn: 'crossParagraphZoteroFields',
      input: ([elements, documentXml]) =>
        Array.isArray(elements) && typeof documentXml === 'string'
          ? {
              text: documentXml,
              args: {
                elements: (elements as Array<{ name: string; start: number; end: number }>).map(
                  ({ name, start, end }) => ({
                    name,
                    start,
                    end,
                  }),
                ),
              },
            }
          : undefined,
    },
    built: [
      ...ZOTERO_DOCS.map((text) => ({ text, args: { elements: elementsOf(text) } })),
      {
        text: ZOTERO_DOCS[0]!,
        args: { elements: [...elementsOf(ZOTERO_DOCS[0]!), ...elementsOf(ZOTERO_DOCS[0]!)] },
      },
      {
        text: ZOTERO_DOCS[0]!,
        args: {
          elements: elementsOf(ZOTERO_DOCS[0]!).map((el) => ({ ...el, start: el.start - 1e6 })),
        },
      },
      {
        text: ZOTERO_DOCS[4]!,
        args: {
          elements: elementsOf(ZOTERO_DOCS[4]!).map((el) => ({ ...el, start: el.start + 1 })),
        },
      },
      {
        text: ZOTERO_DOCS[4]!,
        args: { elements: elementsOf(ZOTERO_DOCS[4]!).map((el) => ({ ...el, end: el.end + 40 })) },
      },
    ],
    mutation: 'none',
  },
  {
    fn: 'parse.mathParaAlign',
    call: (text, args) => internals.mathParaAlign!(text, args.pPr),
    fromParse: {
      fn: 'mathParaAlign',
      input: ([paragraphXml, p]) =>
        typeof paragraphXml === 'string' && typeof p === 'string'
          ? { text: paragraphXml, args: { pPr: p } }
          : undefined,
    },
    built: [
      ['<w:p><m:oMathPara><m:oMath/></m:oMathPara></w:p>', ''],
      [
        '<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr></m:oMathPara></w:p>',
        '<w:pPr><w:jc w:val="right"/></w:pPr>',
      ],
      [
        "<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val='right'/></m:oMathParaPr></m:oMathPara></w:p>",
        '',
      ],
      [
        '<w:p><m:oMathPara><m:oMathParaPr><m:jc  m:val="center"/></m:oMathParaPr></m:oMathPara></w:p>',
        '',
      ],
      [
        '<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr></m:oMathPara></w:p>',
        '',
      ],
      ['<w:p><m:oMathPara><m:jc m:val="left\'/></m:oMathPara></w:p>', ''],
      ['<w:p><m:oMath/></w:p>', '<w:pPr><w:jc w:val="center"/></w:pPr>'],
      ['<w:p><m:oMath/></w:p>', '<w:pPr><w:jc w:val="end"/></w:pPr>'],
      ['<w:p><m:oMath/></w:p>', '<w:pPr><w:jc w:val="right"/></w:pPr>'],
      ['<w:p><m:oMath/></w:p>', '<w:pPr><w:jc w:val="both"/></w:pPr>'],
      ['<w:p><m:oMath/></w:p>', '<w:pPr><w:jcx w:val="center"/><w:jc w:val="start"/></w:pPr>'],
      ['<w:p><m:oMath/></w:p>', ''],
    ].map(([text, p]) => ({ text, args: { pPr: p } })),
  },
  {
    fn: 'parse.mathSizeHalfPoints',
    call: (text, args) => internals.mathSizeHalfPoints!(text, args.eff),
    fromParse: {
      fn: 'mathSizeHalfPoints',
      input: ([omml, eff]) =>
        typeof omml === 'string' && eff ? { text: omml, args: { eff: json(eff) } } : undefined,
    },
    built: [
      '<m:oMath><m:r><w:rPr><w:sz w:val="28"/></w:rPr></m:r></m:oMath>',
      '<m:oMath><m:r><w:rPr><w:sz w:val="0"/></w:rPr></m:r></m:oMath>',
      '<m:oMath><m:r><w:rPr><w:sz w:val="-4"/><w:sz w:val="30"/></w:rPr></m:r></m:oMath>',
      "<m:oMath><m:ctrlPr><w:rPr><w:sz w:val='31.5pt'/></w:rPr></m:ctrlPr></m:oMath>",
      '<m:oMath><m:r><w:rPr><w:sz w:val="x"/></w:rPr></m:r></m:oMath>',
      '<m:oMath><m:r><w:rPr><w:szCs w:val="40"/></w:rPr></m:r></m:oMath>',
      '<m:oMath/>',
    ].flatMap((text, index) =>
      [EFFS[index % EFFS.length]!, EFFS[6]!].map((eff) => ({ text, args: { eff } })),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.mathSourceXmlOf',
    call: (text) => internals.mathSourceXmlOf!(text),
    fromParse: {
      fn: 'mathSourceXmlOf',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: [
      '<w:p><m:oMath/></w:p>',
      '<w:p><mc:AlternateContent><mc:Choice Requires="wps"><m:oMath/></mc:Choice><mc:Fallback><m:oMath/></mc:Fallback></mc:AlternateContent><mc:Fallback x="1">a</mc:Fallback></w:p>',
      '<w:p><mc:Fallback><w:txbxContent><m:oMath/></w:txbxContent></mc:Fallback><w:txbxContent><w:p><m:oMath/></w:p></w:txbxContent><m:oMath/></w:p>',
      '<w:p><mc:Fallback>unclosed<w:txbxContent>also</w:p>',
      '<w:p><mc:FallbackX>x</mc:Fallback><w:txbxContent a="1">kept</w:txbxContent></w:p>',
      // the fallback and the text boxes in other valid spellings: markup hidden in a comment,
      // CDATA or an instruction, spaced end tags, a `>` in an attribute value
      ...hiddenIn('<mc:Fallback>').map(
        (hidden) =>
          `<w:p>${hidden}<mc:AlternateContent><mc:Choice Requires="wps"><m:oMath/></mc:Choice><mc:Fallback><m:oMath/></mc:Fallback></mc:AlternateContent><m:oMath/></w:p>`,
      ),
      ...hiddenIn('</mc:Fallback>').map(
        (hidden) => `<w:p><mc:Fallback>${hidden}<m:oMath/></mc:Fallback><m:oMath/></w:p>`,
      ),
      ...hiddenIn('<w:txbxContent>').map(
        (hidden) =>
          `<w:p>${hidden}<w:txbxContent><w:p><m:oMath/></w:p></w:txbxContent><m:oMath/></w:p>`,
      ),
      ...hiddenIn('</w:txbxContent>').map(
        (hidden) =>
          `<w:p><w:txbxContent><w:p>${hidden}<m:oMath/></w:p></w:txbxContent><m:oMath/></w:p>`,
      ),
      '<w:p><mc:Fallback><m:oMath/></mc:Fallback ><w:txbxContent><w:p><m:oMath/></w:p></w:txbxContent ><m:oMath/></w:p>',
      '<w:p><mc:Fallback a=">"><m:oMath/></mc:Fallback><w:txbxContent a=">"><m:oMath/></w:txbxContent><m:oMath/></w:p>',
      "<w:p><mc:Fallback a='>' b=\"'>\"><m:oMath/></mc:Fallback><w:txbxContent a='>'>x</w:txbxContent>\n<m:oMath/></w:p>",
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.effectiveRunOf',
    call: async (text, args) => {
      const res = { eff: args.eff, rctx: await rctxOf(args), memo: new Map() }
      const earlier = args.earlier as { text: string; node?: string; key?: string } | undefined
      if (earlier) internals.effectiveRunOf!(res, named(earlier.text, earlier.node), earlier.key)
      return internals.effectiveRunOf!(res, nodeOf(text, args), args.key)
    },
    fromParse: {
      fn: 'effectiveRunOf',
      input: ([res, rPr, key], parts) => {
        if (!res || typeof res !== 'object' || (key !== undefined && typeof key !== 'string'))
          return undefined
        const { eff, rctx } = res as { eff: unknown; rctx: ResolveCtx }
        const r = nodeInput(rPr)
        if (!r) return undefined
        // the first call of each key on this paragraph: a later one is a memo hit
        const calls =
          earlierCalls.get(res) ?? new Map<string, { text: string; node?: string; key?: string }>()
        earlierCalls.set(res, calls)
        const earlier = calls.get(key ?? '')
        if (!earlier) calls.set(key ?? '', { ...r, ...(key === undefined ? {} : { key }) })
        const members = membersOf(parts, rctx, [
          'styles',
          'numbering',
          'docDefaults',
          'defaultParaStyle',
          'themeFonts',
          'themeColors',
        ])
        if (!members || !members.includes('styles') || !members.includes('numbering'))
          return undefined
        return withParts('effectiveRunOf', parts, {
          text: r.text,
          args: {
            ...(r.node ? { node: r.node } : {}),
            ...(key === undefined ? {} : { key }),
            eff: json(eff),
            compat: {
              compatibilityMode: rctx.compat.mode,
              doNotUseHTMLParagraphAutoSpacing: rctx.compat.additiveParaSpacing,
              indentNotNumberingTabStop: rctx.compat.indentNotNumberingTabStop,
            },
            ...(rctx.table ? { table: json(rctx.table) } : {}),
            ...(earlier ? { earlier } : {}),
          },
        })
      },
    },
    built: [
      undefined,
      '<w:rPr/>',
      '<w:rPr><w:b/><w:sz w:val="30"/></w:rPr>',
      '<w:rPr><w:rStyle w:val="Strong"/><w:i/></w:rPr>',
      '<w:rPr><w:rStyle w:val="RtlChar"/></w:rPr>',
      '<w:rPr><w:rtl/><w:szCs w:val="44"/><w:rFonts w:asciiTheme="majorHAnsi" w:cs="Arial"/></w:rPr>',
    ].flatMap((rPr, index) =>
      [undefined, 'k', rPr ?? 'none'].map((key, k) => {
        const effs = [{ styleId: 'RtlPara' }, {}, { styleId: 'Missing' }, { styleId: 'LtrPara' }]
        return {
          text: rPr ?? '',
          args: {
            parts: index % 3 === 2 ? PLAIN : RICH,
            ...(rPr === undefined ? {} : { node: 'w:rPr' }),
            ...(key === undefined ? {} : { key }),
            eff: effOf(effs[(index + k) % effs.length]),
            compat: { compatibilityMode: 15 },
            ...(k === 1 ? { table: { cond: [] } } : {}),
            ...(k === 2 ? { earlier: { text: '<w:rPr><w:b/></w:rPr>', node: 'w:rPr', key } } : {}),
            ...(k === 0 && index % 2 === 1
              ? { earlier: { text: '<w:rPr><w:caps/></w:rPr>', node: 'w:rPr' } }
              : {}),
          },
        }
      }),
    ),
  },
  {
    fn: 'parse.markSizeOf',
    call: (text, args) => internals.markSizeOf!(args.eff, nodeOf(text, args)),
    fromParse: {
      fn: 'markSizeOf',
      input: ([eff, node]) => {
        const p = nodeInput(node)
        return p && eff
          ? { text: p.text, args: { ...(p.node ? { node: p.node } : {}), eff: json(eff) } }
          : undefined
      },
    },
    built: EFF_P_PRS.flatMap((p, index) =>
      [EFFS[index % EFFS.length]!, EFFS[6]!, EFFS[8]!].map((eff) => ({
        text: p ?? '',
        args: { ...(p === undefined ? {} : { node: 'w:pPr' }), eff },
      })),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.foldEffectiveFormat',
    call: (text, args) => internals.foldEffectiveFormat!(args.format, nodeOf(text, args), args.eff),
    fromParse: {
      fn: 'foldEffectiveFormat',
      input: ([format, node, eff]) => {
        const p = nodeInput(node)
        if (!p || !eff) return undefined
        return {
          text: p.text,
          args: {
            ...(p.node ? { node: p.node } : {}),
            ...(format === undefined ? {} : { format: json(format) }),
            eff: json(eff),
          },
        }
      },
    },
    built: [
      ...EFFS.flatMap((eff, index) =>
        [FORMATS[index % FORMATS.length], FORMATS[(index * 5 + 3) % FORMATS.length]].map(
          (format, k) => {
            const p = EFF_P_PRS[(index + k) % EFF_P_PRS.length]
            return {
              text: p ?? '',
              args: {
                ...(p === undefined ? {} : { node: 'w:pPr' }),
                ...(format === undefined ? {} : { format }),
                eff,
              },
            }
          },
        ),
      ),
      // a resolved bidi paragraph without its own w:bidi flips a physical jc to the logical side:
      // right to left and left to right, center and an absent jc stay
      ...[
        { align: 'right' },
        { align: 'left' },
        { align: 'center' },
        { align: 'right', bidiInherited: false },
        {},
      ].map((format) => ({ text: pPr(''), args: { node: 'w:pPr', format, eff: EFFS[1]! } })),
    ],
    argMutation: true,
  },
  {
    fn: 'parse.legacyDirectRunFormat',
    call: (text, args) =>
      internals.legacyDirectRunFormat!(nodeOf(text, args), args.cs, args.themeFonts),
    fromParse: {
      fn: 'legacyDirectRunFormat',
      input: ([node, cs, themeFonts]) => {
        const r = nodeInput(node)
        if (!r || typeof cs !== 'boolean') return undefined
        return {
          text: r.text,
          args: {
            ...(r.node ? { node: r.node } : {}),
            cs,
            ...(themeFonts === undefined ? {} : { themeFonts: json(themeFonts) }),
          },
        }
      },
    },
    built: [
      '<w:rPr/>',
      '<w:rPr><w:b/><w:i w:val="0"/><w:bCs w:val="false"/><w:iCs/><w:strike w:val="off"/><w:sz w:val="0"/><w:szCs w:val="33"/></w:rPr>',
      '<w:rPr><w:u w:val="single"/><w:sz w:val="12.5pt"/><w:spacing w:val="0"/><w:kern w:val="x"/><w:caps w:val="0"/></w:rPr>',
      '<w:rPr><w:u w:color="FF0000"/><w:spacing w:val="-20"/><w:kern w:val="28"/><w:caps/><w:smallCaps/><w:vertAlign w:val="superscript"/></w:rPr>',
      '<w:rPr><w:u w:val="none"/><w:smallCaps/><w:vertAlign w:val="baseline"/><w:kern w:val="-0"/></w:rPr>',
      '<w:rPr><w:smallCaps w:val="0"/><w:vertAlign w:val="subscript"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun" w:cs="Mangal"/></w:rPr>',
      '<w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cstheme="minorBidi"/></w:rPr>',
      '<w:rPr><w:rFonts w:hAnsi="Calibri" w:eastAsia=""/><w:sz w:val="99999999999999999999999"/></w:rPr>',
      '<w:rPr><w:rFonts w:ascii="Times" w:eastAsiaTheme="minorEastAsia"/><w:spacing w:val=""/></w:rPr>',
      '<w:x/>',
    ].flatMap((text, index) =>
      [true, false].map((cs, k) => ({
        text,
        args: {
          node: index === 9 && k === 1 ? 'w:rPr' : nameOf((xmlParser.parse(text) as XNode[])[0]!),
          cs,
          ...((index + k) % 3 === 0
            ? {}
            : (index + k) % 3 === 1
              ? { themeFonts: null }
              : {
                  themeFonts: {
                    major: 'Major Latin',
                    minor: 'Minor Latin',
                    eastAsia: 'Minor Ea',
                    majorEastAsia: '',
                    minorCs: '',
                    majorCs: 'Major Cs',
                    eaLang: 'ko-KR',
                  },
                }),
        },
      })),
    ),
  },
  {
    fn: 'parse.frameBoxOf',
    call: (text, args) => internals.frameBoxOf!(nodeOf(text, args)),
    fromParse: {
      fn: 'frameBoxOf',
      input: ([node]) => {
        const p = nodeInput(node)
        return p?.node ? { text: p.text, args: { node: p.node } } : undefined
      },
    },
    built: [
      '<w:pPr/>',
      '<w:pPr><w:framePr w:w="2000" w:h="1000" w:hRule="exact" w:hSpace="180" w:vSpace="0" w:vAnchor="text" w:wrap="around" w:xAlign="right"/></w:pPr>',
      '<w:pPr><w:framePr w:dropCap="drop" w:w="2000"/></w:pPr>',
      '<w:pPr><w:framePr w:dropCap="" w:h="12.5" w:hRule="atLeast" w:vAnchor="text" w:wrap="tight" w:xAlign="outside"/></w:pPr>',
      '<w:pPr><w:framePr w:w="0" w:h="-5"/></w:pPr>',
      '<w:pPr><w:framePr w:w="x" w:hSpace="5"/></w:pPr>',
      '<w:pPr><w:framePr w:w="300" w:vAnchor="page" w:wrap="around"/></w:pPr>',
      '<w:pPr><w:framePr w:w="300" w:vAnchor="text" w:wrap="notBeside" w:xAlign="right"/></w:pPr>',
      '<w:pPr><w:framePr w:w="300" w:vAnchor="text" w:wrap="auto" w:xAlign="center" w:vSpace="20"/></w:pPr>',
      '<w:pPr><w:framePr w:w="300" w:vAnchor="text" w:wrap="Around"/></w:pPr>',
      '<w:pPr><w:framePr w:w="300" w:vAnchor="text"/></w:pPr>',
    ]
      .map((text) => ({ text, args: { node: 'w:pPr' } }))
      .concat([{ text: '<w:x/>', args: { node: 'w:pPr' } }]),
  },
  {
    fn: 'parse.paraFrameOf',
    call: (_text, args) => internals.paraFrameOf!(args.attrs),
    fromParse: {
      fn: 'paraFrameOf',
      input: ([a]) => {
        const own = attrsOf(a)
        return own ? { args: { attrs: own } } : undefined
      },
    },
    built: [
      {},
      { 'w:w': '2000' },
      {
        'w:w': '2000',
        'w:x': '100',
        'w:y': '-50',
        'w:h': '300',
        'w:hRule': 'exact',
        'w:hAnchor': 'margin',
        'w:vAnchor': 'text',
        'w:wrap': 'around',
      },
      {
        'w:w': '1e3',
        'w:x': 'x',
        'w:h': '0',
        'w:hAnchor': 'page',
        'w:vAnchor': 'margin',
        'w:wrap': 'notBeside',
        'w:hSpace': '-20',
        'w:vSpace': '0',
      },
      { 'w:w': '0' },
      { 'w:w': '-5' },
      {
        'w:w': '500',
        'w:h': '200',
        'w:hRule': 'auto',
        'w:hAnchor': 'text',
        'w:vAnchor': 'page',
        'w:wrap': 'none',
        'w:xAlign': 'inside',
        'w:yAlign': 'inline',
        'w:anchorLock': 'true',
      },
      {
        'w:w': '500',
        'w:wrap': 'through',
        'w:xAlign': 'outside',
        'w:yAlign': 'outside',
        'w:anchorLock': '1',
        'w:hSpace': '7',
      },
      {
        'w:w': '500',
        'w:wrap': 'auto',
        'w:xAlign': 'left',
        'w:yAlign': 'top',
        'w:anchorLock': 'on',
        'w:vSpace': '9',
      },
      { 'w:w': '500', 'w:wrap': 'tight', 'w:xAlign': 'center', 'w:yAlign': 'center' },
      { 'w:w': '500', 'w:xAlign': 'right', 'w:yAlign': 'bottom' },
      {
        'w:w': '500',
        'w:xAlign': 'Right',
        'w:yAlign': 'inside',
        'w:x': '99999999999999999999999999',
      },
    ].map((attrs) => ({ args: { attrs } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.propChangeInfo',
    call: (text, args) => internals.propChangeInfo!(text, args.changeName),
    fromParse: {
      fn: 'propChangeInfo',
      input: ([xml, changeName]) =>
        typeof xml === 'string' && typeof changeName === 'string'
          ? { text: xml, args: { changeName } }
          : undefined,
    },
    built: [
      ['<w:tblPr><w:tblW w:w="0"/></w:tblPr>', 'w:tblPrChange'],
      [
        '<w:tblPr><w:tblW w:w="0"/><w:tblPrChange w:id="3" w:author="A" w:date="2024-01-02T03:04:05Z"><w:tblPr><w:jc w:val="center"/></w:tblPr></w:tblPrChange></w:tblPr>',
        'w:tblPrChange',
      ],
      [
        '<w:tblPr><w:tblPrChange w:author="B"><w:tblPr/></w:tblPrChange></w:tblPr>',
        'w:tblPrChange',
      ],
      [
        '<w:trPr><w:trPrChange w:id="" w:author="" w16du:dateUtc="2024-01-01T00:00:00Z"><w:trPr><w:cantSplit/></w:trPr></w:trPrChange></w:trPr>',
        'w:trPrChange',
      ],
      [
        '<w:tcPr><w:cellMerge w:id="1" w:author="C" w:vMerge="cont" w:vMergeOrig="rest"/></w:tcPr>',
        'w:cellMerge',
      ],
      [
        '<w:tcPr><w:tcPrChange w:id="1" w:author="D"><w:tcPr><w:tcW w:w="100"/></w:tcPr></w:tcPrChange></w:tcPr>',
        'w:tcPrChange',
      ],
      [
        '<w:sectPr><w:sectPrChange w:id="9" w:author="E"><w:sectPr><w:pgSz w:w="1"/></w:sectPr></w:sectPrChange></w:sectPr>',
        'w:sectPrChange',
      ],
      [
        '<w:tblGrid><w:tblGridChange w:id="2"><w:tblGrid><w:gridCol w:w="10"/></w:tblGrid></w:tblGridChange></w:tblGrid>',
        'w:tblGridChange',
      ],
      [
        '<w:tblPrEx><w:tblPrExChange w:author="F"><w:tblPrEx/></w:tblPrExChange></w:tblPrEx>',
        'w:tblPrExChange',
      ],
      ['<w:tblPr><w:tblPrChangeX w:author="G"/></w:tblPr>', 'w:tblPrChange'],
      [
        "<w:tblPr><w:tblPrChange w:author='H' w:date='d'><w:tblPr><w:x/></w:tblPr></w:tblPrChange></w:tblPr>",
        'w:tblPrChange',
      ],
    ].map(([text, changeName]) => ({ text, args: { changeName } })),
  },
  {
    fn: 'parse.mergeTabStops',
    call: (_text, args) => internals.mergeTabStops!(args.style, args.direct),
    fromParse: {
      fn: 'mergeTabStops',
      input: ([style, direct]) => ({
        args: {
          ...(style === undefined ? {} : { style: json(style) }),
          ...(direct === undefined ? {} : { direct: json(direct) }),
        },
      }),
    },
    built: TAB_STOPS.flatMap((style, index) =>
      [
        TAB_STOPS[(index + 1) % TAB_STOPS.length],
        TAB_STOPS[(index * 3 + 2) % TAB_STOPS.length],
        undefined,
      ].map((direct) => ({
        args: {
          ...(style === undefined ? {} : { style }),
          ...(direct === undefined ? {} : { direct }),
        },
      })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.noteRunOf',
    call: (_text, args) => internals.noteRunOf!(args.run, args.base),
    fromParse: {
      fn: 'noteRunOf',
      input: ([run, base]) =>
        run && base ? { args: { run: json(run), base: json(base) } } : undefined,
    },
    built: [
      ...RUNS,
      // hidden from AI: the label the run's rPr carries, read the way the serialiser spells it
      ...marks().map((mark) => ({ text: 'secret', rawRPr: `<w:rPr>${mark}</w:rPr>` })),
      { text: 'a', rawRPr: '<w:rPr><go:redact/></w:rPr>' },
      { text: 'b', rawRPr: '<w:rPr><go:redact w:label=""/></w:rPr>', bold: true },
      {
        text: 'c',
        rawRPr: '<w:rPr><go:redact w:label="a &amp; b"/></w:rPr>',
        del: { author: 'Ann' },
      },
      { text: 'd', rawRPr: '<w:rPr><w:b/></w:rPr>' },
      { text: 'e', rawRPr: '' },
    ].flatMap((run, index) =>
      [BASES[index % BASES.length]!, BASES[(index + 1) % BASES.length]!].map((base) => ({
        args: { run, base },
      })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.noteNumbersOf',
    call: (text, args) =>
      internals.noteNumbersOf!(
        text,
        args.footnotes,
        args.endnotes,
        args.footnoteProps,
        args.endnoteProps,
      ),
    fromParse: {
      fn: 'noteNumbersOf',
      input: ([documentXml, footnotes, endnotes, footnoteProps, endnoteProps]) =>
        typeof documentXml === 'string' && Array.isArray(footnotes) && Array.isArray(endnotes)
          ? {
              text: documentXml,
              args: {
                footnotes: json(footnotes),
                endnotes: json(endnotes),
                ...(footnoteProps === undefined ? {} : { footnoteProps: json(footnoteProps) }),
                ...(endnoteProps === undefined ? {} : { endnoteProps: json(endnoteProps) }),
              },
            }
          : undefined,
    },
    built: NOTE_DOCS.flatMap((body) =>
      NOTE_ARGS.map((args) => ({
        text: `<w:document ${W}><w:body>${body}</w:body></w:document>`,
        args,
      })),
    ),
    argMutation: true,
  },
  ...PARSE_TEXT_B2,
]

/** The calls of effectiveRunOf made so far on each RunResolve, by key. */
const earlierCalls = new WeakMap<
  object,
  Map<string, { text: string; node?: string; key?: string }>
>()
