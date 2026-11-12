/**
 * Single resolver for effective paragraph / run properties (ECMA-376 §17.7.2):
 * builtin -> docDefaults -> table style (whole table, then conditions) ->
 * paragraph style chain -> numbering level pPr -> direct. Runs continue with
 * docDefaults -> table-style rPr -> paragraph style -> character style -> direct,
 * toggle properties XOR across the style layers, the Cs twins selected by the
 * rtl chain. The raw tri-state readers (extractParaFormat, styleDisplayOf)
 * stay where they are; this module only composes them.
 */
import { type XNode } from './xml-utils'
import { type CharUnits } from './parse-props'
import type { CharIndents, DocDefaults, NumberingDef, NumberingLevel, ParaAlign, ParaBorderSides, Run, StyleInfo, TabStop, ThemeColors, ThemeFonts } from './types'
import { invoke, xnodeArg } from './engine'

export type PropSource =
  'direct' | 'numbering' | 'paraStyle' | 'charStyle' | 'tableStyle' | 'docDefaults' | 'builtin'
export type TableCond = 'firstRow' | 'lastRow' | 'firstCol' | 'lastCol'
export interface ResolveCompat {
  /** settings.xml compatibilityMode (0 = legacy layout) */
  mode: number
  /** w:doNotUseHTMLParagraphAutoSpacing: before/after spacing adds instead of collapsing */
  additiveParaSpacing: boolean
  /** w:doNotUseIndentAsNumberingTabStop */
  indentNotNumberingTabStop: boolean
}
export interface ResolveCtx {
  styles: Map<string, StyleInfo>
  defaultParaStyle?: StyleInfo
  defaultCharStyle?: StyleInfo
  docDefaults?: DocDefaults
  numbering: Map<string, NumberingDef>
  themeFonts?: ThemeFonts | null
  themeColors?: ThemeColors | null
  compat: ResolveCompat
  /** the table a cell paragraph sits in (conditions in ascending precedence: the last one wins) */
  table?: { styleId?: string; cond: TableCond[] }
  /** per-ctx caches (filled lazily) */
  cache?: WeakMap<XNode, { key: string; eff: EffectivePPr }>
  styleMemo?: Map<string, PLayer>
}
export interface LineSpacing {
  rule: 'auto' | 'atLeast' | 'exact'
  raw: number
}
export interface EffectivePPr {
  styleId?: string
  align?: ParaAlign
  bidi: boolean
  indent: { left: number; right: number; firstLine: number; chars?: CharIndents }
  spacing: {
    before: number
    after: number
    beforeAuto: boolean
    afterAuto: boolean
    line?: LineSpacing
  }
  keepNext: boolean
  keepLines: boolean
  pageBreakBefore: boolean
  widowControl: boolean
  contextualSpacing: boolean
  suppressLineNumbers: boolean
  snapToGrid: boolean
  autoSpaceDE: boolean
  autoSpaceDN: boolean
  wordWrap: boolean
  overflowPunct: boolean
  tabStops: TabStop[]
  borders?: ParaBorderSides
  shading?: string
  eastAsiaLang?: string
  list?: { numId: string; ilvl: number; level?: NumberingLevel }
  /** paragraph-mark rPr resolved through the same chain */
  mark: EffectiveRPr
  /** the mark is hidden (direct / style / default-style w:vanish, specVanish excluded) */
  hidden: boolean
  source: Record<string, PropSource>
}
export interface EffectiveRPr {
  styleId?: string
  cs: boolean
  bold: boolean
  italic: boolean
  sizeHalfPoints: number
  fonts: { ascii?: string; eastAsia?: string; cs?: string; eaSlotEmpty?: boolean }
  color?: string
  underline: boolean
  strike: boolean
  caps: 'none' | 'all' | 'small'
  vanish: boolean
  charSpacingTwips: number
  kernHalfPoints?: number
  vertAlign?: 'superscript' | 'subscript'
  bdr?: Run['bdr']
  shading?: string
  eastAsiaLang?: string
  source: Record<string, PropSource>
  /** toggles whose style-layer XOR inverted the winning layer's own value (display override) */
  styleXor?: Array<'bold' | 'italic' | 'strike' | 'vanish'>
}
export interface ResolveParaOptions {
  /** twips per character for *Chars indents; absent = character indents stay unresolved */
  charUnits?: CharUnits
}
/** one layer of paragraph properties, every field tri-state */
export interface PLayer {
  align?: ParaAlign
  bidi?: boolean
  indentLeft?: number
  indentRight?: number
  indentFirstLine?: number
  indentChars?: CharIndents
  spaceBefore?: number
  spaceAfter?: number
  spaceBeforeAuto?: boolean
  spaceAfterAuto?: boolean
  line?: LineSpacing
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
  widowControl?: boolean
  contextualSpacing?: boolean
  suppressLineNumbers?: boolean
  snapToGrid?: boolean
  autoSpaceDE?: boolean
  autoSpaceDN?: boolean
  wordWrap?: boolean
  overflowPunct?: boolean
  tabStops?: TabStop[]
  borders?: ParaBorderSides
  shading?: string
  eastAsiaLang?: string
}
export function resolveParagraphProps(
  pPr: XNode | undefined,
  ctx: ResolveCtx,
  opts?: ResolveParaOptions,
): EffectivePPr {
  return invoke('resolveParagraphProps', [xnodeArg(pPr), ctx, opts ?? {}]) as never
}
/** resolveParagraphProps for callers holding a raw <w:p> / <w:pPr> XML slice */
export function resolveParagraphPropsXml(
  xml: string,
  ctx: ResolveCtx,
  opts?: ResolveParaOptions,
): EffectivePPr {
  return invoke('resolveParagraphPropsXml', [xml, ctx, opts ?? {}]) as never
}
export function resolveRunProps(
  rPr: XNode | undefined,
  para: EffectivePPr,
  ctx: ResolveCtx,
  mark = false,
): EffectiveRPr {
  return invoke('resolveRunProps', [xnodeArg(rPr), para.styleId, !!para.bidi, ctx, mark]) as never
}
// ---------------------------------------------------------------- shadow

export interface ResolveDiff {
  /** which parse surface produced the paragraph */
  surface?: 'body' | 'cell' | 'run'
  key: string
  old: unknown
  eff: unknown
  text?: string
}
/** key-by-key comparison of a legacy direct reader's output with the resolver's */
export function shadowCompare(
  legacy: object | undefined,
  resolved: object | undefined,
  keys?: readonly string[],
): ResolveDiff[] {
  return invoke('shadowCompare', [legacy, resolved, keys]) as never
}
/** ResolveCtx over a parsed document (tests, tools, renderer-side consumers) */
export function resolveCtxOf(doc: {
  styles: Map<string, StyleInfo>
  docDefaults?: DocDefaults
  numbering: Map<string, NumberingDef>
  themeFonts?: ThemeFonts | null
  themeColors?: ThemeColors | null
  compatibilityMode?: number
  doNotUseHTMLParagraphAutoSpacing?: boolean
  indentNotNumberingTabStop?: boolean
}): ResolveCtx {
  return invoke('resolveCtxOf', [doc], { shape: {"k":"obj","f":{"styles":{"k":"map"},"numbering":{"k":"map"},"styleMemo":{"k":"map"}}} }) as never
}
export interface EffectiveSpacingTwips {
  before: number
  after: number
}
/**
 * The resolved paragraph as display-only ParaFormat keys (non-editable
 * surfaces: header/footer strips, cells, notes). Zero geometry is omitted so
 * the consumers' "absent = none" checks keep working.
 */
export interface EffectiveParaFormatOptions {
  /** layers whose line spacing travels inline; absent = every layer. Surfaces
   *  whose base line already carries Normal / docDefaults pass the style and
   *  direct layers only */
  lineSources?: readonly PropSource[]
}