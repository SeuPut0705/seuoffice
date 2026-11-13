// Group `resolve`: resolve-props.ts, the effective paragraph and run
// properties. The context of a call is built on both sides from `args.parts`
// (styles, numbering, theme) by the readers already ported, with the compat
// values of `args.compat` and the table of `args.table` set on it.
import type { CharUnits } from './reference/parse-props'
import { parseNumbering } from './reference/parse-package'
import { parseStyles } from './reference/parse-styles'
import {
  AUTO_SPACING_TWIPS,
  autoSpacingTwips,
  directParaFormat,
  directRunFormat,
  effectiveLineFormat,
  effectiveParaFormat,
  effectiveSpacingTwips,
  hfLineSources,
  resolveCtxOf,
  resolveParagraphProps,
  resolveParagraphPropsXml,
  resolveRunProps,
  shadowCompare,
  type EffectivePPr,
  type LineSpacing,
  type PropSource,
  type ResolveCtx,
  type ResolveParaOptions,
  type TableCond,
} from './reference/resolve-props'
import type {
  DocDefaults,
  NumberingDef,
  StyleInfo,
  ThemeColors,
  ThemeFonts,
} from './reference/types'
import { nameOf, xmlParser, type XNode } from './reference/xml-utils'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { parseTheme } from './compare-package'
import { elementFragments, tagTokens } from './fragments'

// ---------------------------------------------------------------- the context

interface Parsed {
  styles: Map<string, StyleInfo>
  docDefaults?: DocDefaults
  numbering: Map<string, NumberingDef>
  theme: { fonts: ThemeFonts | null; colors: ThemeColors | null }
}

async function parse(parts: unknown): Promise<Parsed> {
  const zip = zipOf(parts)
  const theme = await parseTheme(zip)
  const { styles, docDefaults } = await parseStyles(zip, theme.colors, theme.fonts)
  const { defs } = await parseNumbering(zip)
  return { styles, docDefaults, numbering: defs, theme }
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

interface CompatArgs {
  compatibilityMode?: number
  doNotUseHTMLParagraphAutoSpacing?: boolean
  indentNotNumberingTabStop?: boolean
}

function compatOf(args: Record<string, unknown>): CompatArgs {
  const compat = (args.compat ?? {}) as CompatArgs
  return {
    compatibilityMode: compat.compatibilityMode,
    doNotUseHTMLParagraphAutoSpacing: compat.doNotUseHTMLParagraphAutoSpacing,
    indentNotNumberingTabStop: compat.indentNotNumberingTabStop,
  }
}

async function ctxOf(args: Record<string, unknown>): Promise<ResolveCtx> {
  const { styles, docDefaults, numbering, theme } = await parsedOf(args.parts)
  const ctx = resolveCtxOf({
    styles,
    docDefaults,
    numbering,
    themeFonts: theme.fonts,
    themeColors: theme.colors,
    ...compatOf(args),
  })
  if (args.table !== undefined) ctx.table = args.table as ResolveCtx['table']
  return ctx
}

/** The top-level element of `text` named `args.node`. */
function nodeOf(text: string, args: Record<string, unknown>): XNode | undefined {
  return (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === args.node)
}

const optsOf = (args: Record<string, unknown>): ResolveParaOptions => ({
  charUnits: args.charUnits as CharUnits | undefined,
})

async function effOf(text: string, args: Record<string, unknown>) {
  const ctx = await ctxOf(args)
  return { ctx, eff: resolveParagraphPropsXml(text, ctx, optsOf(args)) }
}

async function runEffOf(text: string, args: Record<string, unknown>) {
  const ctx = await ctxOf(args)
  const para = { styleId: args.paraStyleId, bidi: args.paraBidi === true } as EffectivePPr
  return resolveRunProps(nodeOf(text, args), para, ctx, args.mark === true)
}

// ---------------------------------------------------------------- the corpus

const PARTS = ['word/styles.xml', 'word/numbering.xml', 'word/theme/theme1.xml']
/** Characters of parts per spec and document: every call carries its parts. */
const PARTS_BUDGET = 1_500_000
const MAX_PARAGRAPHS = 40
const MAX_TABLES = 3
const CONDS: TableCond[][] = [
  [],
  ['firstRow'],
  ['firstCol', 'lastRow'],
  ['lastCol', 'firstRow'],
  ['lastRow'],
]

interface Paragraph {
  p: string
  pPr?: string
  rPrs: string[]
  styleId?: string
  table?: ResolveCtx['table']
}

interface Collected {
  parts: Array<[string, string]>
  compat: CompatArgs
  paragraphs: Paragraph[]
  lines: LineSpacing[]
}

const collected = new WeakMap<ReadonlyMap<string, string>, Collected>()

/** The first `name` element of `xml`, the outermost when they nest. */
function firstElement(xml: string, name: string): string | undefined {
  let depth = 0
  let start = 0
  for (const tag of tagTokens(xml)) {
    if (tag.name !== name) continue
    if (tag.selfClosing) {
      if (depth === 0) return xml.slice(tag.start, tag.end)
    } else if (!tag.closing) {
      if (depth++ === 0) start = tag.start
    } else if (depth > 0 && --depth === 0) return xml.slice(start, tag.end)
  }
  return undefined
}

function paragraphOf(p: string, table?: ResolveCtx['table']): Paragraph {
  const pPr = firstElement(p, 'w:pPr')
  return {
    p,
    pPr,
    rPrs: elementFragments(p, 'w:rPr').slice(0, 3),
    styleId: pPr && /<w:pStyle\b[^>]*\bw:val="([^"]*)"/.exec(pPr)?.[1],
    table,
  }
}

function compatOfSettings(settings: string): CompatArgs {
  let compatibilityMode: number | undefined
  for (const tag of settings.match(/<w:compatSetting\b[^>]*>/g) ?? []) {
    if (!/\sw:name="compatibilityMode"/.test(tag)) continue
    const val = /\sw:val="(\d+)"/.exec(tag)
    if (val) {
      compatibilityMode = parseInt(val[1]!, 10)
      break
    }
  }
  return {
    compatibilityMode,
    doNotUseHTMLParagraphAutoSpacing: /<w:doNotUseHTMLParagraphAutoSpacing\b/.test(settings)
      ? true
      : undefined,
    indentNotNumberingTabStop: /<w:doNotUseIndentAsNumberingTabStop\b/.test(settings)
      ? true
      : undefined,
  }
}

function collect(parts: ReadonlyMap<string, string>): Collected {
  const known = collected.get(parts)
  if (known) return known
  const own: Array<[string, string]> = PARTS.flatMap((name) => {
    const text = parts.get(name)
    return text === undefined ? [] : [[name, text] as [string, string]]
  })
  const size = own.reduce((sum, [, text]) => sum + text.length, 0)
  const cap = Math.max(3, Math.min(MAX_PARAGRAPHS, Math.floor(PARTS_BUDGET / Math.max(1, size))))
  const body = parts.get('word/document.xml') ?? ''
  const all = elementFragments(body, 'w:p')
  const step = Math.max(1, Math.ceil(all.length / cap))
  const paragraphs = all.filter((_, index) => index % step === 0).map((p) => paragraphOf(p))
  elementFragments(body, 'w:tbl')
    .slice(0, MAX_TABLES)
    .forEach((tbl, index) => {
      const styleId = /<w:tblStyle\b[^>]*\bw:val="([^"]*)"/.exec(tbl)?.[1]
      for (const p of elementFragments(tbl, 'w:p').slice(0, 2)) {
        const cond = CONDS[(index + paragraphs.length) % CONDS.length]!
        paragraphs.push(paragraphOf(p, styleId === undefined ? { cond } : { styleId, cond }))
      }
    })
  const lines: LineSpacing[] = []
  for (const { pPr } of paragraphs) {
    const spacing = pPr && /<w:spacing\b[^>]*>/.exec(pPr)?.[0]
    const line = spacing && /\bw:line="([^"]*)"/.exec(spacing)?.[1]
    const raw = line === undefined ? NaN : parseInt(line, 10)
    if (!Number.isFinite(raw)) continue
    lines.push({
      rule: (/\bw:lineRule="([^"]*)"/.exec(spacing!)?.[1] ?? 'auto') as LineSpacing['rule'],
      raw,
    })
  }
  const result: Collected = {
    parts: own,
    compat: compatOfSettings(parts.get('word/settings.xml') ?? ''),
    paragraphs,
    lines,
  }
  collected.set(parts, result)
  return result
}

const UNITS: CharUnits = { run: 240, normal: 210 }
const LINE_SOURCES: Array<PropSource[] | undefined> = [
  undefined,
  ['direct', 'paraStyle'],
  ['tableStyle'],
]

/** One input per paragraph: its text, the document's context, and its table. */
function paragraphInputs(parts: ReadonlyMap<string, string>, node?: 'w:pPr'): Input[] {
  const { parts: own, compat, paragraphs } = collect(parts)
  return paragraphs.map(({ p, pPr, table }, index) => ({
    text: node ? (pPr ?? p) : p,
    args: {
      parts: own,
      compat,
      ...(node ? { node } : {}),
      ...(table ? { table } : {}),
      ...(index % 2 === 1 ? { charUnits: UNITS } : {}),
      inTable: table !== undefined,
      lineSources: LINE_SOURCES[index % LINE_SOURCES.length],
    },
  }))
}

function runInputs(parts: ReadonlyMap<string, string>): Input[] {
  const { parts: own, compat, paragraphs } = collect(parts)
  return paragraphs.flatMap(({ rPrs, styleId, table }) =>
    rPrs.map((text) => ({
      text,
      args: {
        parts: own,
        compat,
        node: 'w:rPr',
        ...(styleId === undefined ? {} : { paraStyleId: styleId }),
        ...(table ? { table } : {}),
      },
    })),
  )
}

// ---------------------------------------------------------------- built inputs

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Major Latin"/><a:ea typeface=""/><a:cs typeface="Major Cs"/><a:font script="Hang" typeface="Major Hang"/></a:majorFont><a:minorFont><a:latin typeface="Minor Latin"/><a:ea typeface="Minor Ea"/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`

const style = (type: string, id: string, inner: string, attrs = ''): string =>
  `<w:style w:type="${type}" w:styleId="${id}"${attrs}><w:name w:val="${id}"/>${inner}</w:style>`

const DOC_DEFAULTS = `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cs="Arial"/><w:b/><w:bCs w:val="0"/><w:sz w:val="22"/><w:szCs w:val="24"/><w:color w:val="333333"/><w:kern w:val="2"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:spacing w:before="40" w:after="160" w:line="259" w:lineRule="auto" w:beforeAutospacing="1"/><w:ind w:left="100" w:right="50" w:firstLineChars="100"/><w:pBdr><w:top w:val="single" w:sz="4" w:color="FF0000"/><w:left w:val="none"/></w:pBdr></w:pPr></w:pPrDefault></w:docDefaults>`

const RTL_DEFAULTS = `<w:docDefaults><w:rPrDefault><w:rPr><w:rtl/><w:bCs/><w:iCs/><w:szCs w:val="30"/><w:i w:val="0"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/><w:ind w:hangingChars="100"/><w:spacing w:afterAutospacing="1"/></w:pPr></w:pPrDefault></w:docDefaults>`

const STYLES_BODY = [
  style(
    'paragraph',
    'Normal',
    '<w:pPr><w:jc w:val="both"/><w:spacing w:after="100"/><w:ind w:leftChars="200"/></w:pPr><w:rPr><w:i/></w:rPr>',
    ' w:default="1"',
  ),
  style(
    'paragraph',
    'Base',
    '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:contextualSpacing/><w:tabs><w:tab w:val="left" w:pos="1000"/><w:tab w:val="right" w:leader="dot" w:pos="2000"/></w:tabs><w:pBdr><w:top w:val="double" w:sz="8" w:space="2" w:themeColor="accent1"/></w:pBdr><w:shd w:val="clear" w:fill="EEEEEE"/><w:spacing w:beforeAutospacing="0" w:afterAutospacing="1"/><w:ind w:leftChars="300" w:hangingChars="50"/></w:pPr><w:rPr><w:i/><w:strike/><w:lang w:eastAsia="ja-JP"/><w:caps/></w:rPr>',
  ),
  style(
    'paragraph',
    'Child',
    '<w:basedOn w:val="Base"/><w:pPr><w:tabs><w:tab w:val="clear" w:pos="1000"/><w:tab w:val="center" w:pos="3000"/></w:tabs><w:pBdr><w:top w:val="nil"/><w:bottom w:val="single" w:sz="12"/></w:pBdr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr><w:bidi/><w:jc w:val="left"/><w:spacing w:line="360" w:lineRule="exact"/></w:pPr><w:rPr><w:b/><w:vanish/><w:sz w:val="28"/><w:rtl w:val="0"/></w:rPr>',
  ),
  style(
    'paragraph',
    'GrandChild',
    '<w:basedOn w:val="Child"/><w:pPr><w:keepLines/><w:widowControl/><w:pageBreakBefore/><w:suppressLineNumbers/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:wordWrap w:val="0"/><w:overflowPunct w:val="0"/><w:numPr><w:numId w:val="0"/></w:numPr><w:jc w:val="right"/><w:ind w:firstLine="240" w:right="120"/></w:pPr><w:rPr><w:b/><w:i/><w:vanish w:val="0"/><w:strike/><w:u w:val="single"/><w:bdr w:val="single" w:sz="4" w:space="1" w:color="00FF00"/><w:shd w:val="clear" w:fill="FFFF00"/></w:rPr>',
  ),
  style(
    'paragraph',
    'RtlPara',
    '<w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr><w:rPr><w:rtl/><w:bCs/><w:iCs/><w:szCs w:val="32"/><w:rFonts w:cs="Arabic Typesetting"/></w:rPr>',
  ),
  style(
    'paragraph',
    'ListStyle',
    '<w:pPr><w:numPr><w:numId w:val="3"/></w:numPr><w:ind w:left="1440" w:leftChars="100"/></w:pPr>',
  ),
  style(
    'paragraph',
    'NumOnly',
    '<w:pPr><w:numPr><w:ilvl w:val="3"/><w:numId w:val="1"/></w:numPr></w:pPr>',
  ),
  style(
    'paragraph',
    '__proto__',
    '<w:pPr><w:jc w:val="constructor"/><w:spacing w:before="77"/></w:pPr>',
  ),
  style(
    'paragraph',
    'toString',
    '<w:pPr><w:jc w:val="center"/><w:shd w:val="clear" w:fill="auto"/></w:pPr><w:rPr><w:smallCaps/></w:rPr>',
  ),
  style(
    'paragraph',
    'CycleA',
    '<w:basedOn w:val="CycleB"/><w:pPr><w:spacing w:after="11"/></w:pPr>',
  ),
  style(
    'paragraph',
    'CycleB',
    '<w:basedOn w:val="CycleA"/><w:pPr><w:spacing w:before="22"/></w:pPr><w:rPr><w:b/></w:rPr>',
  ),
  style(
    'character',
    'Emph',
    '<w:rPr><w:b/><w:strike/><w:vanish/><w:sz w:val="30"/><w:rFonts w:ascii="Courier" w:eastAsia="Batang" w:hAnsi="Courier"/><w:color w:val="0000FF"/><w:spacing w:val="20"/><w:kern w:val="0"/><w:bdr w:val="dotted" w:sz="2"/><w:shd w:val="pct25" w:color="000000" w:fill="FFFFFF"/><w:lang w:eastAsia="zh-CN"/><w:caps w:val="0"/></w:rPr>',
  ),
  style(
    'character',
    'CsChar',
    '<w:rPr><w:rtl/><w:bCs w:val="0"/><w:iCs/><w:szCs w:val="40"/><w:rFonts w:eastAsiaTheme="minorEastAsia" w:asciiTheme="majorAscii"/></w:rPr>',
  ),
  style(
    'table',
    'Grid',
    '<w:pPr><w:spacing w:before="10" w:after="20" w:line="300"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:color w:val="111111"/><w:sz w:val="18"/><w:kern w:val="4"/></w:rPr>' +
      '<w:tblStylePr w:type="firstRow"><w:pPr><w:spacing w:before="111" w:line="400" w:lineRule="atLeast"/><w:jc w:val="right"/></w:pPr><w:rPr><w:b/><w:color w:val="FF00FF"/><w:caps/></w:rPr></w:tblStylePr>' +
      '<w:tblStylePr w:type="lastRow"><w:pPr><w:jc w:val="left"/><w:spacing w:after="222"/></w:pPr><w:rPr><w:i/><w:sz w:val="26"/></w:rPr></w:tblStylePr>' +
      '<w:tblStylePr w:type="firstCol"><w:pPr><w:spacing w:line="264" w:lineRule="exact"/></w:pPr><w:rPr><w:rFonts w:ascii="Col Font"/><w:spacing w:val="-10"/></w:rPr></w:tblStylePr>' +
      '<w:tblStylePr w:type="lastCol"><w:pPr><w:jc w:val="both"/></w:pPr><w:rPr><w:smallCaps/><w:sz w:val="16"/></w:rPr></w:tblStylePr>',
  ),
  style(
    'table',
    'GridChild',
    '<w:basedOn w:val="Grid"/><w:tblStylePr w:type="firstRow"><w:pPr><w:jc w:val="constructor"/></w:pPr><w:rPr><w:i/></w:rPr></w:tblStylePr>',
  ),
  style('table', 'Plain', ''),
].join('')

const STYLES = `<w:styles ${W}>${DOC_DEFAULTS}${STYLES_BODY}</w:styles>`
const RTL_STYLES = `<w:styles ${W}>${RTL_DEFAULTS}${style('paragraph', 'Normal', '', ' w:default="1"')}${STYLES_BODY.replace(/w:default="1"/, '')}</w:styles>`

const NUMBERING = `<w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pStyle w:val="ListStyle"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:pPr><w:bidi/><w:ind w:left="1440" w:right="200" w:firstLine="180"/></w:pPr></w:lvl><w:lvl w:ilvl="2"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3)"/><w:pPr><w:ind w:start="2160" w:hanging="0"/></w:pPr></w:lvl><w:lvl w:ilvl="3"><w:numFmt w:val="decimal"/><w:lvlText w:val="%4"/><w:pPr><w:ind w:left="2880" w:hanging="-5" w:firstLine="0"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="1"><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%2"/><w:pPr><w:ind w:left="900" w:hanging="450"/><w:bidi w:val="0"/></w:pPr></w:lvl></w:lvlOverride></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num></w:numbering>`

const RICH: Array<[string, string]> = [
  ['word/styles.xml', STYLES],
  ['word/numbering.xml', NUMBERING],
  ['word/theme/theme1.xml', THEME],
]
const RTL: Array<[string, string]> = [
  ['word/styles.xml', RTL_STYLES],
  ['word/numbering.xml', NUMBERING],
]
const BARE: Array<[string, string]> = []
const DAMAGED_STYLES: Array<[string, string]> = [
  ['word/styles.xml', `<w:styles ${W}><w:style`],
  ['word/theme/theme1.xml', 'not a theme'],
]
/** parseNumbering throws on a part the parser refuses: so does building the context. */
const THROWS: Array<[string, string]> = [
  ['word/styles.xml', STYLES],
  ['word/numbering.xml', `<w:numbering ${W}><w:num w:numId="1"`],
]
const PACKAGES = [RICH, RTL, BARE, DAMAGED_STYLES]
const CHAR_DEFAULT = style(
  'character',
  'CharDefault',
  '<w:rPr><w:b/><w:color w:val="00AA00"/><w:sz w:val="40"/></w:rPr>',
  ' w:default="1"',
)
const TABLE_DEFAULT = style(
  'table',
  'TableDefault',
  '<w:pPr><w:spacing w:before="33" w:after="44"/></w:pPr><w:rPr><w:i/><w:color w:val="AA0000"/></w:rPr>',
  ' w:default="1"',
)
const PARA_DEFAULT = style(
  'paragraph',
  'ParaDefault',
  '<w:pPr><w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:rPr><w:caps/><w:sz w:val="30"/></w:rPr>',
  ' w:default="1"',
)
/** A character and a table default ahead of the paragraph default: only the last is the default paragraph style. */
const OTHER_DEFAULTS: Array<Array<[string, string]>> = [
  [['word/styles.xml', `<w:styles ${W}>${CHAR_DEFAULT}${TABLE_DEFAULT}${PARA_DEFAULT}</w:styles>`]],
  [['word/styles.xml', `<w:styles ${W}>${TABLE_DEFAULT}${CHAR_DEFAULT}${PARA_DEFAULT}</w:styles>`]],
]

const COMPATS: CompatArgs[] = [
  {},
  {
    compatibilityMode: 15,
    doNotUseHTMLParagraphAutoSpacing: true,
    indentNotNumberingTabStop: true,
  },
  { compatibilityMode: -1 },
  { compatibilityMode: 1e308, doNotUseHTMLParagraphAutoSpacing: false },
  { compatibilityMode: 14.5 },
]

const TABLES: Array<ResolveCtx['table']> = [
  undefined,
  { styleId: 'Grid', cond: [] },
  { styleId: 'Grid', cond: ['firstRow'] },
  { styleId: 'Grid', cond: ['firstRow', 'lastRow'] },
  { styleId: 'Grid', cond: ['lastRow', 'firstRow'] },
  { styleId: 'Grid', cond: ['firstCol', 'lastCol'] },
  { styleId: 'Grid', cond: ['lastCol', 'firstCol'] },
  { styleId: 'Grid', cond: ['firstCol', 'lastRow', 'firstRow', 'lastCol'] },
  { styleId: 'GridChild', cond: ['firstRow'] },
  { styleId: 'Plain', cond: ['firstRow'] },
  { styleId: 'Missing', cond: ['lastRow'] },
  { styleId: 'Normal', cond: ['firstRow'] },
  { styleId: '', cond: ['firstRow'] },
  { cond: ['lastCol'] },
]

const CHAR_UNITS: Array<CharUnits | undefined> = [
  undefined,
  { run: 240, normal: 210 },
  { run: 0, normal: 0 },
  { run: -100, normal: 50 },
  { run: 12.5, normal: 7.25 },
  { run: 1e308, normal: 1e308 },
  { run: NaN, normal: 240 },
  { run: 240, normal: NaN },
]

const pPr = (inner: string): string => `<w:pPr>${inner}</w:pPr>`
const para = (props: string, runs = '<w:r><w:t>x</w:t></w:r>'): string =>
  `<w:p>${props === '' ? '' : pPr(props)}${runs}</w:p>`
const styled = (id: string, more = ''): string => para(`<w:pStyle w:val="${id}"/>${more}`)
const numbered = (numId: string, ilvl?: string, more = ''): string =>
  para(
    `${more}<w:numPr>${ilvl === undefined ? '' : `<w:ilvl w:val="${ilvl}"/>`}<w:numId w:val="${numId}"/></w:numPr>`,
  )

const HUGE = '9'.repeat(306)

const PARAS: string[] = [
  para(''),
  '<w:p/>',
  ...[
    'Normal',
    'Base',
    'Child',
    'GrandChild',
    'RtlPara',
    'ListStyle',
    'NumOnly',
    '__proto__',
    'toString',
    'constructor',
    'CycleA',
    'CycleB',
    'Missing',
    'Emph',
    'Grid',
    '',
  ].map((id) => styled(id)),
  para(
    '<w:pStyle w:val="Child"/><w:bidi w:val="0"/><w:jc w:val="right"/><w:spacing w:before="0" w:after="-5" w:line="0" w:lineRule="atLeast" w:beforeAutospacing="true" w:afterAutospacing="0"/><w:ind w:left="360" w:hanging="720" w:rightChars="50"/><w:pageBreakBefore w:val="false"/><w:keepNext w:val="0"/><w:keepLines/><w:suppressLineNumbers/><w:widowControl/><w:contextualSpacing w:val="1"/><w:snapToGrid w:val="0"/><w:wordWrap/><w:overflowPunct w:val="off"/><w:autoSpaceDE/><w:autoSpaceDN w:val="0"/><w:shd w:val="clear" w:fill="auto"/><w:pBdr><w:bottom w:val="none" w:space="4"/><w:right w:val="single" w:sz="6"/></w:pBdr><w:tabs><w:tab w:val="clear" w:pos="2000"/><w:tab w:val="decimal" w:pos="500"/></w:tabs><w:rPr><w:vanish/></w:rPr>',
  ),
  para(
    '<w:pStyle w:val="Base"/><w:snapToGrid/><w:autoSpaceDN/><w:rPr><w:vanish/><w:specVanish/></w:rPr>',
  ),
  // a specVanish that is there but off: the mark stays hidden
  para('<w:pStyle w:val="Base"/><w:rPr><w:vanish/><w:specVanish w:val="0"/></w:rPr>'),
  para('<w:rPr><w:specVanish w:val="false"/><w:vanish w:val="1"/></w:rPr>'),
  para(
    '<w:pStyle w:val="GrandChild"/><w:rPr><w:rStyle w:val="Emph"/><w:vanish w:val="0"/></w:rPr>',
  ),
  para('<w:bidi/><w:jc w:val="left"/>'),
  para('<w:bidi/><w:jc w:val="end"/>'),
  para('<w:pStyle w:val="RtlPara"/><w:bidi w:val="0"/>'),
  para('<w:jc w:val="constructor"/>'),
  para('<w:jc w:val="toString"/><w:spacing w:line="276"/>'),
  para('<w:jc w:val="__proto__"/><w:spacing w:line="12.7" w:lineRule="exact"/>'),
  para('<w:jc w:val="distribute"/><w:spacing w:line="abc" w:before="x" w:after="7.9"/>'),
  para('<w:jc w:val="thaiDistribute"/><w:spacing w:line="300" w:lineRule="foo"/>'),
  para('<w:spacing w:line="-240"/><w:shd w:val="clear" w:themeFill="accent2" w:fill="123456"/>'),
  para(
    '<w:shd w:fill="#ABCDEF"/><w:pBdr><w:top w:val="single"/></w:pBdr><w:pBdr><w:top w:val="nil"/><w:left w:val="dashed" w:themeColor="accent4" w:sz="9"/></w:pBdr>',
  ),
  para('<w:shd w:val="pct50" w:color="FF0000" w:fill="0000FF"/><w:tabs/>'),
  para(
    '<w:shd/><w:tabs><w:tab w:pos="x"/><w:tab w:val="bar" w:pos="-0"/><w:tab w:val="weird" w:pos="0"/></w:tabs>',
  ),
  para('<w:ind w:leftChars="200" w:firstLineChars="150"/>'),
  para('<w:pStyle w:val="Base"/><w:ind w:hangingChars="100" w:leftChars="0"/>'),
  para('<w:pStyle w:val="Base"/><w:ind w:firstLineChars="0" w:firstLine="200"/>'),
  para('<w:ind w:startChars="-120" w:endChars="30" w:firstLineChars="-5"/>'),
  para(`<w:ind w:leftChars="${HUGE}" w:hangingChars="${HUGE}"/>`),
  para(`<w:ind w:rightChars="-${HUGE}" w:left="${HUGE}0"/>`),
  para('<w:ind w:start="1" w:end="2" w:firstLine="-7" w:hanging="-3"/>'),
  numbered('1', '0'),
  numbered('1', '1'),
  numbered('1', '2'),
  numbered('1', '3'),
  numbered('1', '9'),
  numbered('1', 'x'),
  numbered('1', '-0'),
  numbered('1'),
  numbered('2', '1', '<w:pStyle w:val="ListStyle"/>'),
  numbered('0', '1', '<w:pStyle w:val="ListStyle"/>'),
  numbered('', '1', '<w:pStyle w:val="ListStyle"/>'),
  numbered('constructor', '0'),
  numbered('99', '0'),
  para('<w:pStyle w:val="Child"/><w:numPr><w:ilvl w:val="3"/></w:numPr>'),
  para('<w:pStyle w:val="ListStyle"/><w:ind w:leftChars="50"/>'),
  para(
    '<w:pPrChange w:id="1"><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange><w:jc w:val="right"/>',
  ),
  '<w:p><w:pPr></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="Base"/>',
  '<w:p><w:pPr><w:jc w:val="center"',
  '<w:p><w:pPr/><w:r/></w:p>',
  '<w:p><w:pPr w:rsidR="1"><w:jc w:val="center"/></w:pPr><w:pPr><w:jc w:val="right"/></w:pPr></w:p>',
  '<w:pPr><w:pStyle w:val="Base"/></w:pPr>',
  '',
  'text only',
]

const RPRS: string[] = [
  '<w:rPr/>',
  '<w:rPr></w:rPr>',
  '<w:rPr><w:rStyle w:val="Emph"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="Emph"/><w:b w:val="0"/><w:vanish/><w:specVanish/></w:rPr>',
  '<w:rPr><w:vanish/><w:specVanish w:val="0"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="Emph"/><w:specVanish w:val="off"/><w:vanish w:val="true"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="Emph"/><w:strike/><w:i w:val="1"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="CsChar"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="CsChar"/><w:rtl w:val="0"/></w:rPr>',
  '<w:rPr><w:rtl/><w:bCs/><w:iCs w:val="0"/><w:szCs w:val="0"/><w:sz w:val="99"/></w:rPr>',
  '<w:rPr><w:rtl w:val="0"/><w:b/><w:i/><w:sz w:val="-4"/><w:strike w:val="0"/></w:rPr>',
  '<w:rPr><w:sz w:val="7.9"/><w:szCs w:val="x"/></w:rPr>',
  '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cstheme="minorBidi"/></w:rPr>',
  '<w:rPr><w:rFonts w:ascii="A" w:eastAsia="E" w:cs="C"/></w:rPr>',
  '<w:rPr><w:rFonts w:ascii="" w:eastAsia=""/></w:rPr>',
  '<w:rPr><w:color w:val="auto"/></w:rPr>',
  '<w:rPr><w:color w:val="#ff0000"/></w:rPr>',
  '<w:rPr><w:color w:themeColor="accent3" w:themeShade="80"/></w:rPr>',
  '<w:rPr><w:color w:val=""/></w:rPr>',
  '<w:rPr><w:u/></w:rPr>',
  '<w:rPr><w:u w:val="none"/></w:rPr>',
  '<w:rPr><w:u w:val="double"/></w:rPr>',
  '<w:rPr><w:caps w:val="0"/><w:smallCaps/></w:rPr>',
  '<w:rPr><w:caps/></w:rPr>',
  '<w:rPr><w:smallCaps w:val="0"/></w:rPr>',
  '<w:rPr><w:spacing w:val="-20"/><w:kern w:val="abc"/></w:rPr>',
  '<w:rPr><w:kern w:val="-0"/><w:spacing w:val="x"/></w:rPr>',
  '<w:rPr><w:kern w:val="16"/></w:rPr>',
  '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>',
  '<w:rPr><w:vertAlign w:val="subscript"/></w:rPr>',
  '<w:rPr><w:vertAlign w:val="baseline"/></w:rPr>',
  '<w:rPr><w:vertAlign w:val="weird"/></w:rPr>',
  '<w:rPr><w:bdr w:val="none"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="Emph"/><w:bdr w:val="nil"/></w:rPr>',
  '<w:rPr><w:bdr w:val="single" w:sz="0" w:color="auto" w:space="3"/></w:rPr>',
  '<w:rPr><w:shd w:val="clear" w:fill="auto"/></w:rPr>',
  '<w:rPr><w:shd w:fill="00FF00"/></w:rPr>',
  '<w:rPr><w:shd w:val="solid" w:color="auto"/></w:rPr>',
  '<w:rPr><w:shd w:val="clear" w:themeFill="accent1" w:themeFillTint="99"/></w:rPr>',
  '<w:rPr><w:lang w:eastAsia="zh-TW"/></w:rPr>',
  '<w:rPr><w:lang w:eastAsia=""/></w:rPr>',
  '<w:rPr><w:vanish w:val="0"/><w:strike/><w:b w:val="false"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="__proto__"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="constructor"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="toString"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="Missing"/></w:rPr>',
  '<w:rPr><w:rStyle w:val=""/></w:rPr>',
  '<w:rPr><w:rStyle w:val="GrandChild"/></w:rPr>',
  '<w:rPr><w:b></w:rPr>',
  '<w:rPr><w:b',
  '<w:r><w:rPr><w:b/></w:rPr></w:r>',
  '<w:rPr><w:cs/><w:bCs/><w:b w:val="0"/><w:sz w:val="40"/><w:szCs w:val="20"/></w:rPr>',
  '<w:rPr><w:cs w:val="0"/><w:rtl w:val="0"/><w:b/><w:bCs w:val="0"/><w:sz w:val="40"/></w:rPr>',
  '<w:rPr><w:rStyle w:val="Emph"/><w:cs w:val="true"/><w:i/><w:iCs/></w:rPr>',
  '',
]

const PARA_STYLE_IDS: Array<string | undefined> = [
  undefined,
  'Child',
  'RtlPara',
  'Missing',
  'GrandChild',
  '',
  'Base',
]

/** Every paragraph over the rich package, then a rotation of the other arguments. */
function paragraphBuilt(node?: 'w:pPr'): Input[] {
  const text = (p: string): string =>
    node ? (/<w:pPr[\s\S]*?<\/w:pPr>|<w:pPr\/>/.exec(p)?.[0] ?? p) : p
  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
    parts: RICH,
    ...(node ? { node } : {}),
    ...extra,
  })
  const inputs: Input[] = []
  PARAS.forEach((p, index) => {
    inputs.push({ text: text(p), args: base({}) })
    inputs.push({
      text: text(p),
      args: base({
        table: TABLES[index % TABLES.length],
        charUnits: CHAR_UNITS[index % CHAR_UNITS.length],
        compat: COMPATS[index % COMPATS.length],
        inTable: index % 2 === 0,
        lineSources: LINE_SOURCES[index % LINE_SOURCES.length],
      }),
    })
    inputs.push({
      text: text(p),
      args: { parts: PACKAGES[1 + (index % (PACKAGES.length - 1))], ...(node ? { node } : {}) },
    })
  })
  for (const p of [
    styled('Child'),
    styled('GrandChild'),
    para('<w:ind w:leftChars="200" w:firstLineChars="150"/>'),
    styled('Base'),
  ]) {
    for (const table of TABLES) inputs.push({ text: text(p), args: base({ table, inTable: true }) })
    for (const charUnits of CHAR_UNITS) inputs.push({ text: text(p), args: base({ charUnits }) })
    for (const compat of COMPATS) inputs.push({ text: text(p), args: base({ compat }) })
  }
  // a table without its conditions: cacheKey joins them and throws
  inputs.push({ text: text(styled('Base')), args: base({ table: { styleId: 'Grid' } }) })
  // a paragraph without w:pStyle, with and without a w:pPr, takes the paragraph default only
  for (const parts of OTHER_DEFAULTS) {
    for (const p of [para(''), para('<w:ind w:left="10"/>')]) {
      inputs.push({ text: text(p), args: { parts, ...(node ? { node } : {}) } })
    }
  }
  inputs.push({ text: text(styled('Base')), args: { parts: THROWS, ...(node ? { node } : {}) } })
  return inputs
}

function runBuilt(): Input[] {
  const inputs: Input[] = []
  RPRS.forEach((text, index) => {
    inputs.push({ text, args: { parts: RICH, node: 'w:rPr' } })
    inputs.push({
      text,
      args: {
        parts: RICH,
        node: 'w:rPr',
        paraStyleId: PARA_STYLE_IDS[index % PARA_STYLE_IDS.length],
        table: TABLES[index % TABLES.length],
      },
    })
    inputs.push({ text, args: { parts: RTL, node: 'w:rPr' } })
  })
  for (const text of [RPRS[0]!, RPRS[2]!, RPRS[7]!]) {
    for (const paraStyleId of PARA_STYLE_IDS) {
      inputs.push({ text, args: { parts: RICH, node: 'w:rPr', paraStyleId } })
    }
    for (const table of TABLES) inputs.push({ text, args: { parts: RICH, node: 'w:rPr', table } })
    for (const parts of PACKAGES) inputs.push({ text, args: { parts, node: 'w:rPr' } })
  }
  // the mark of a bidi paragraph reads the Cs twins with its own w:rtl off, any other run does not
  for (const text of [RPRS[0]!, RPRS[2]!, RPRS[9]!, RPRS[10]!, ...RPRS.slice(-4, -1)]) {
    for (const parts of [RICH, RTL]) {
      for (const paraBidi of [false, true]) {
        for (const mark of [false, true]) {
          inputs.push({ text, args: { parts, node: 'w:rPr', paraBidi, mark } })
        }
      }
    }
  }
  inputs.push({ text: RPRS[2]!, args: { parts: THROWS, node: 'w:rPr' } })
  // tableStyleRLayer reads the conditions with `?? []`: no throw without them
  inputs.push({ text: RPRS[2]!, args: { parts: RICH, node: 'w:rPr', table: { styleId: 'Grid' } } })
  // a run of a paragraph without a style takes the run properties of the paragraph default only
  for (const parts of OTHER_DEFAULTS)
    inputs.push({ text: RPRS[0]!, args: { parts, node: 'w:rPr' } })
  return inputs
}

/** What a plain object inherits: `constructor`, `toString`, ..., `__proto__`. */
const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype)

const SHADOWS: Array<Record<string, unknown>> = [
  { legacy: { a: 1, b: [1, 2] }, resolved: { a: 1, b: [2, 1] } },
  { legacy: { align: 'left', bidi: true }, resolved: { align: 'left' } },
  { resolved: { x: null } },
  { legacy: null, resolved: {} },
  { legacy: { effective: 1 }, resolved: { effective: 2, k: 'v' } },
  { legacy: { k: 1 }, resolved: { k: 2 }, keys: ['k', 'k', 'missing'] },
  {
    legacy: { constructor: 'x' },
    resolved: {},
    keys: ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'],
  },
  { legacy: { o: { a: 1, b: 2 } }, resolved: { o: { b: 2, a: 1 } } },
  { legacy: { n: 1e21, z: 0 }, resolved: { n: 1e21, z: -0 } },
  { legacy: { '2': 'a', '10': 'b', x: 1 }, resolved: { x: 2, '10': 'b' } },
  { legacy: { s: '\uD55C' }, resolved: { s: '\u{1F600}' }, keys: null },
  { legacy: {}, resolved: {}, keys: 5 },
  { legacy: {}, resolved: {}, keys: {} },
  // an own key named after an Object.prototype member against the inherited member, either side;
  // Object.fromEntries makes even `__proto__` an own key, as JSON.parse does for the Rust side
  ...PROTO_NAMES.flatMap((name) => [
    { legacy: Object.fromEntries([[name, 1]]), resolved: {} },
    { legacy: {}, resolved: Object.fromEntries([[name, 1]]) },
  ]),
  {
    legacy: Object.fromEntries(PROTO_NAMES.map((name) => [name, 1])),
    resolved: {},
    keys: PROTO_NAMES,
  },
  {
    legacy: {},
    resolved: Object.fromEntries(PROTO_NAMES.map((name) => [name, 1])),
    keys: PROTO_NAMES,
  },
]

const LINES: Array<Record<string, unknown>> = [
  {},
  { line: null },
  { line: { rule: 'auto', raw: 240 } },
  { line: { rule: 'auto', raw: 241 } },
  { line: { rule: 'auto', raw: 246 } },
  { line: { rule: 'auto', raw: -360 } },
  { line: { rule: 'auto', raw: 1e308 } },
  { line: { rule: 'auto', raw: 0.5 } },
  { line: { rule: 'exact', raw: 0 } },
  { line: { rule: 'atLeast', raw: 12.5 } },
  { line: { rule: 'weird', raw: 300 } },
  // a negative half hundredth: Math.round goes up (-2.5 to -2), never away from zero
  { line: { rule: 'auto', raw: -6 } },
  { line: { rule: 'auto', raw: -30 } },
  { line: { rule: 'auto', raw: -1.2 } },
]

// ---------------------------------------------------------------- the specs

const CONSTANTS: Record<string, unknown> = { AUTO_SPACING_TWIPS }

export const RESOLVE: CallSpec[] = [
  {
    fn: 'resolve.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: [...Object.keys(CONSTANTS), 'nothing'].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'resolve.resolveCtxOf',
    call: (_text, args) => ctxOf(args),
    fromDocument: (parts) => {
      const { parts: own, compat } = collect(parts)
      return [{ args: { parts: own, compat } }]
    },
    built: [
      ...PACKAGES.flatMap((parts) => COMPATS.map((compat) => ({ args: { parts, compat } }))),
      { args: { parts: THROWS } },
      ...OTHER_DEFAULTS.map((parts) => ({ args: { parts } })),
    ],
    mutation: 'none',
  },
  {
    fn: 'resolve.resolveParagraphProps',
    call: async (text, args) =>
      resolveParagraphProps(nodeOf(text, args), await ctxOf(args), optsOf(args)),
    fromDocument: (parts) => paragraphInputs(parts, 'w:pPr'),
    built: paragraphBuilt('w:pPr'),
  },
  {
    fn: 'resolve.resolveParagraphPropsXml',
    call: async (text, args) => (await effOf(text, args)).eff,
    fromDocument: (parts) => paragraphInputs(parts),
    built: paragraphBuilt(),
  },
  {
    fn: 'resolve.resolveRunProps',
    call: (text, args) => runEffOf(text, args),
    fromDocument: runInputs,
    built: runBuilt(),
  },
  {
    fn: 'resolve.directParaFormat',
    call: async (text, args) => directParaFormat((await effOf(text, args)).eff),
    fromDocument: (parts) => paragraphInputs(parts),
    built: paragraphBuilt(),
  },
  {
    fn: 'resolve.directRunFormat',
    call: async (text, args) => directRunFormat(await runEffOf(text, args)),
    fromDocument: runInputs,
    built: runBuilt(),
  },
  {
    fn: 'resolve.shadowCompare',
    call: (_text, args) =>
      shadowCompare(
        args.legacy as object | undefined,
        args.resolved as object | undefined,
        args.keys as string[] | undefined,
      ),
    built: SHADOWS.map((args) => ({ args })),
    mutation: 'none',
  },
  {
    fn: 'resolve.autoSpacingTwips',
    call: (_text, args) =>
      autoSpacingTwips(
        resolveCtxOf({ styles: new Map(), numbering: new Map(), ...compatOf(args) }).compat,
      ),
    fromDocument: (parts) => [{ args: { compat: collect(parts).compat } }],
    built: COMPATS.map((compat) => ({ args: { compat } })),
    mutation: 'none',
  },
  {
    fn: 'resolve.effectiveSpacingTwips',
    call: async (text, args) => {
      const { ctx, eff } = await effOf(text, args)
      return effectiveSpacingTwips(eff, ctx.compat)
    },
    fromDocument: (parts) => paragraphInputs(parts),
    built: paragraphBuilt(),
  },
  {
    fn: 'resolve.effectiveLineFormat',
    call: (_text, args) => effectiveLineFormat(args.line as LineSpacing | undefined),
    fromDocument: (parts) => collect(parts).lines.map((line) => ({ args: { line } })),
    built: LINES.map((args) => ({ args })),
    mutation: 'none',
  },
  {
    fn: 'resolve.hfLineSources',
    call: async (text, args) =>
      hfLineSources((await effOf(text, args)).eff, args.inTable as boolean),
    fromDocument: (parts) => paragraphInputs(parts),
    built: paragraphBuilt(),
  },
  {
    fn: 'resolve.effectiveParaFormat',
    call: async (text, args) => {
      const { ctx, eff } = await effOf(text, args)
      return effectiveParaFormat(eff, ctx.compat, {
        lineSources: args.lineSources as PropSource[] | undefined,
      })
    },
    fromDocument: (parts) => paragraphInputs(parts),
    built: paragraphBuilt(),
  },
]
