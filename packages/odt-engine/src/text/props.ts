/**
 * Formatting properties both ways: ODF property attributes ↔ the docx engine's
 * own model (`ParaFormat`, the formatting fields of `Run`).
 *
 * The engine model is the meeting point: ODF → OOXML builds engine models and
 * lets the engine write the OOXML; OOXML → ODF compares the edited model with
 * the model built from the original ODF style and writes back only the fields
 * that differ, as attribute overrides on a copy of the original style.
 * Comparisons go through `paraKeys` / `textKeys`, which apply the same rounding
 * as the OOXML encoding, so an untouched value never reads as changed.
 */
import type { ParaFormat, Run, TabStop } from '@genoffice/docx-engine'
import { unquoteFamily } from '../core/convert'
import { halfPointsToPt, lengthToTwips, percent, twips, twipsToCm, twipsToPt } from './units'

/** Decoded attributes of one property element, keyed by canonical name. */
export type OdfAttrs = Record<string, string>

/** Attribute overrides: a value sets, null removes. */
export type AttrOverrides = Record<string, string | null>

// ---------------------------------------------------------------------------
// Paragraph properties

const ALIGN_FROM_ODF: Record<string, ParaFormat['align']> = {
  start: 'left',
  left: 'left',
  end: 'right',
  right: 'right',
  center: 'center',
  justify: 'justify',
}

const hex = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim())
  return m ? m[1].toUpperCase() : undefined
}

const LEADER_FROM_ODF: Record<string, TabStop['leader']> = {
  dotted: 'dot',
  dot: 'dot',
  dash: 'hyphen',
  'long-dash': 'hyphen',
  'dot-dash': 'hyphen',
  'dot-dot-dash': 'hyphen',
  wave: 'hyphen',
  solid: 'underscore',
}

/** ODF tab stops (attribute maps) → engine tab stops; positions become margin-relative twips. */
export function tabStopsFromOdf(
  stops: ReadonlyArray<Record<string, string>> | null | undefined,
  marginLeftTwips: number,
): TabStop[] | undefined {
  if (!stops || stops.length === 0) return undefined
  const out: TabStop[] = []
  for (const s of stops) {
    const pos = lengthToTwips(s['style:position'])
    if (pos === undefined) continue
    const type = s['style:type'] ?? 'left'
    const val: TabStop['val'] =
      type === 'right'
        ? 'right'
        : type === 'center'
          ? 'center'
          : type === 'char'
            ? 'decimal'
            : 'left'
    let leader: TabStop['leader'] = 'none'
    const style = s['style:leader-style']
    if (style && style !== 'none') leader = LEADER_FROM_ODF[style] ?? 'dot'
    else if (!style && s['style:leader-text']) {
      const t = s['style:leader-text']
      leader = t === '.' ? 'dot' : t === '-' ? 'hyphen' : t === '_' ? 'underscore' : 'none'
    }
    out.push({ pos: Math.round(pos + marginLeftTwips), val, leader })
  }
  return out.length ? out : undefined
}

/**
 * `style:paragraph-properties` attributes (a style's own, not inherited) →
 * `ParaFormat`. `tabStops` are the effective tab stops (ODF replaces, never
 * merges, a parent's list), `marginLeftTwips` the effective left margin they
 * are relative to.
 */
export function paraFormatFromOdf(
  pp: OdfAttrs,
  tabStops: ReadonlyArray<Record<string, string>> | null | undefined,
  marginLeftTwips: number,
): ParaFormat {
  const f: ParaFormat = {}
  const align = pp['fo:text-align']
  if (align && ALIGN_FROM_ODF[align]) {
    f.align = ALIGN_FROM_ODF[align]
    if (align === 'justify' && pp['fo:text-align-last'] === 'justify') f.align = 'distribute'
  }
  const left = twips(pp['fo:margin-left'])
  if (left !== undefined) f.indentLeft = left
  const right = twips(pp['fo:margin-right'])
  if (right !== undefined) f.indentRight = right
  const first = twips(pp['fo:text-indent'])
  if (first !== undefined) f.indentFirstLine = first
  const before = twips(pp['fo:margin-top'])
  if (before !== undefined) f.spaceBefore = Math.max(0, before)
  const after = twips(pp['fo:margin-bottom'])
  if (after !== undefined) f.spaceAfter = Math.max(0, after)
  const lh = pp['fo:line-height']
  const lhPct = percent(lh)
  const atLeast = twips(pp['style:line-height-at-least'])
  if (lhPct !== undefined && lhPct > 0) {
    f.lineSpacing = lhPct
    f.lineRule = 'auto'
  } else if (lh !== undefined && twips(lh) !== undefined && (twips(lh) as number) > 0) {
    f.lineRule = 'exact'
    f.lineRawTwips = twips(lh)
  } else if (atLeast !== undefined && atLeast > 0) {
    f.lineRule = 'atLeast'
    f.lineRawTwips = atLeast
  }
  if (pp['fo:keep-with-next'] === 'always') f.keepNext = true
  if (pp['fo:keep-together'] === 'always') f.keepLines = true
  if (pp['fo:break-before'] === 'page') f.pageBreakBefore = true
  const bg = hex(pp['fo:background-color'])
  if (bg) f.shadingFill = bg
  const tabs = tabStopsFromOdf(tabStops, marginLeftTwips)
  if (tabs) f.tabStops = tabs
  return f
}

/** Normalised comparison keys of the paragraph fields this bridge maps. */
export interface ParaKeys {
  align: string | null
  indentLeft: number | null
  indentRight: number | null
  indentFirstLine: number | null
  spaceBefore: number | null
  spaceAfter: number | null
  /** `auto:<twips>` / `exact:<twips>` / `atLeast:<twips>` */
  line: string | null
  keepNext: boolean
  keepLines: boolean
  pageBreakBefore: boolean
  shading: string | null
  /** `val:pos:leader;…` of the paragraph's own stops */
  tabs: string | null
}

const num = (n: number | undefined | null) =>
  n === undefined || n === null || !Number.isFinite(n) ? null : Math.round(n)

export function paraKeys(f: ParaFormat | undefined): ParaKeys {
  const fmt = f ?? {}
  let line: string | null = null
  if ((fmt.lineRule === 'exact' || fmt.lineRule === 'atLeast') && fmt.lineRawTwips)
    line = `${fmt.lineRule}:${Math.round(fmt.lineRawTwips)}`
  else if (fmt.lineSpacing && fmt.lineSpacing > 0)
    line = `auto:${Math.round(fmt.lineSpacing * 240)}`
  const stops = (fmt.tabStops ?? []).filter((t) => !t.rel && !t.inherited)
  return {
    align: fmt.align ?? null,
    indentLeft: num(fmt.indentLeft),
    indentRight: num(fmt.indentRight),
    indentFirstLine: num(fmt.indentFirstLine),
    // the engine never writes w:before="0", so an explicit 0 reads back as absent
    spaceBefore: fmt.spaceBefore ? num(fmt.spaceBefore) : null,
    spaceAfter: num(fmt.spaceAfter),
    line,
    keepNext: !!fmt.keepNext,
    keepLines: !!fmt.keepLines,
    pageBreakBefore: !!fmt.pageBreakBefore,
    shading: fmt.shadingFill ? fmt.shadingFill.toUpperCase() : null,
    tabs: stops.length
      ? stops.map((t) => `${t.val}:${Math.round(t.pos)}:${t.leader ?? 'none'}`).join(';')
      : null,
  }
}

/**
 * Keys whose edited value differs from the original. A value the original had
 * and the edited paragraph lacks was cleared in the editor (null): an
 * untouched paragraph never gets here, because the editor writes its original
 * pPr bytes back and the engine reads them as the same keys.
 */
export function changedParaKeys(original: ParaKeys, edited: ParaKeys): Array<keyof ParaKeys> {
  const out: Array<keyof ParaKeys> = []
  for (const key of Object.keys(original) as Array<keyof ParaKeys>) {
    if (original[key] !== edited[key]) out.push(key)
  }
  return out
}

/** Twips as centimetres, or null (remove) for a cleared value. */
const cm = (value: number | undefined): string | null =>
  value === undefined ? null : twipsToCm(value)

const ALIGN_TO_ODF: Record<string, string> = {
  left: 'start',
  right: 'end',
  center: 'center',
  justify: 'justify',
  distribute: 'justify',
}

/** Tab stops as the inner XML of `style:tab-stops` (positions relative to `marginLeftTwips`). */
export function tabStopsToOdf(stops: readonly TabStop[], marginLeftTwips: number): string {
  return stops
    .filter((t) => !t.rel && !t.inherited && t.val !== 'clear')
    .map((t) => {
      const type =
        t.val === 'right'
          ? 'right'
          : t.val === 'center'
            ? 'center'
            : t.val === 'decimal'
              ? 'char'
              : 'left'
      const leader =
        t.leader === 'dot' || t.leader === 'middleDot'
          ? 'dotted'
          : t.leader === 'hyphen'
            ? 'dash'
            : t.leader === 'underscore' || t.leader === 'heavy'
              ? 'solid'
              : 'none'
      const char = type === 'char' ? ' style:char="."' : ''
      return `<style:tab-stop style:position="${twipsToCm(t.pos - marginLeftTwips)}" style:type="${type}"${char} style:leader-style="${leader}"${leader === 'none' ? '' : ' style:leader-text="' + (leader === 'dotted' ? '.' : leader === 'dash' ? '-' : '_') + '"'}/>`
    })
    .join('')
}

export interface ParaOverrides {
  /** `style:paragraph-properties` attribute overrides */
  attrs: AttrOverrides
  /** new inner XML of `style:tab-stops`, or undefined to keep the list */
  tabStops?: string
}

/**
 * ODF overrides for the changed paragraph keys, taking the values from the
 * edited format. `marginLeftTwips` is the effective left margin after the edit
 * (tab positions are relative to it).
 */
export function paraOverrides(
  keys: ReadonlyArray<keyof ParaKeys>,
  edited: ParaFormat,
  marginLeftTwips: number,
  original: ParaKeys,
): ParaOverrides {
  const attrs: AttrOverrides = {}
  let tabStops: string | undefined
  for (const key of keys) {
    switch (key) {
      // a cleared value removes the attribute: the paragraph then takes its
      // common style's value, as the docx paragraph takes its style's
      case 'align': {
        const a = edited.align
        attrs['fo:text-align'] = a ? (ALIGN_TO_ODF[a] ?? 'start') : null
        if (a === 'distribute') attrs['fo:text-align-last'] = 'justify'
        else if (original.align === 'distribute') attrs['fo:text-align-last'] = null
        break
      }
      case 'indentLeft':
        attrs['fo:margin-left'] = cm(edited.indentLeft)
        break
      case 'indentRight':
        attrs['fo:margin-right'] = cm(edited.indentRight)
        break
      case 'indentFirstLine':
        attrs['fo:text-indent'] = cm(edited.indentFirstLine)
        break
      case 'spaceBefore':
        // the engine reads an absent w:before for 0
        attrs['fo:margin-top'] = twipsToCm(edited.spaceBefore ?? 0)
        break
      case 'spaceAfter':
        attrs['fo:margin-bottom'] = cm(edited.spaceAfter)
        break
      case 'line': {
        if ((edited.lineRule === 'exact' || edited.lineRule === 'atLeast') && edited.lineRawTwips) {
          if (edited.lineRule === 'exact') {
            attrs['fo:line-height'] = twipsToCm(edited.lineRawTwips)
            attrs['style:line-height-at-least'] = null
          } else {
            attrs['style:line-height-at-least'] = twipsToCm(edited.lineRawTwips)
            attrs['fo:line-height'] = null
          }
        } else if (edited.lineSpacing && edited.lineSpacing > 0) {
          attrs['fo:line-height'] = `${Math.round(edited.lineSpacing * 100)}%`
          attrs['style:line-height-at-least'] = null
        } else {
          attrs['fo:line-height'] = null
          attrs['style:line-height-at-least'] = null
        }
        break
      }
      case 'keepNext':
        attrs['fo:keep-with-next'] = edited.keepNext ? 'always' : 'auto'
        break
      case 'keepLines':
        attrs['fo:keep-together'] = edited.keepLines ? 'always' : 'auto'
        break
      case 'pageBreakBefore':
        attrs['fo:break-before'] = edited.pageBreakBefore ? 'page' : 'auto'
        break
      case 'shading':
        attrs['fo:background-color'] = edited.shadingFill
          ? `#${edited.shadingFill.toLowerCase()}`
          : null
        break
      case 'tabs':
        tabStops = tabStopsToOdf(edited.tabStops ?? [], marginLeftTwips)
        break
    }
  }
  return { attrs, tabStops }
}

// ---------------------------------------------------------------------------
// Text properties

/** The formatting fields of `Run` this bridge maps. */
export type TextFormat = Pick<
  Run,
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'color'
  | 'sizeHalfPoints'
  | 'font'
  | 'fontAscii'
  | 'eastAsiaFont'
  | 'fontCs'
  | 'charSpacingTwips'
  | 'charScalePct'
  | 'shading'
  | 'highlight'
  | 'vertAlign'
  | 'caps'
>

const isBold = (v: string) => v === 'bold' || (/^\d+$/.test(v) && parseInt(v, 10) >= 600)

/**
 * Merged `style:text-properties` attributes → engine run formatting.
 * `fontFaces` resolves `style:font-name*` through the part's font-face decls.
 */
export function textFormatFromOdf(
  tp: OdfAttrs,
  fontFaces: ReadonlyMap<string, string>,
): TextFormat {
  const f: TextFormat = {}
  const face = (name: string | undefined, family: string | undefined) => {
    if (name !== undefined) return fontFaces.get(name) ?? name
    return family !== undefined ? unquoteFamily(family.split(',')[0]) : undefined
  }
  const latin = face(tp['style:font-name'], tp['fo:font-family'])
  const ea = face(tp['style:font-name-asian'], tp['style:font-family-asian'])
  const cs = face(tp['style:font-name-complex'], tp['style:font-family-complex'])
  if (latin) f.fontAscii = latin
  if (ea) f.eastAsiaFont = ea
  if (ea ?? latin) f.font = ea ?? latin
  if (cs) f.fontCs = cs
  const size = tp['fo:font-size'] ?? tp['style:font-size-asian']
  if (size && !size.endsWith('%')) {
    const t = lengthToTwips(size)
    if (t !== undefined && t > 0) f.sizeHalfPoints = Math.max(1, Math.round(t / 10))
  }
  const weight = tp['fo:font-weight'] ?? tp['style:font-weight-asian']
  if (weight !== undefined) f.bold = isBold(weight)
  const style = tp['fo:font-style'] ?? tp['style:font-style-asian']
  if (style !== undefined) f.italic = style === 'italic' || style === 'oblique'
  const uStyle = tp['style:text-underline-style']
  const uType = tp['style:text-underline-type']
  if (uStyle !== undefined || uType !== undefined) {
    f.underline =
      uStyle !== undefined && uStyle !== 'none' && (uType === undefined || uType !== 'none')
  }
  const sStyle = tp['style:text-line-through-style']
  const sType = tp['style:text-line-through-type']
  if (sStyle !== undefined || sType !== undefined) {
    f.strike =
      sStyle !== undefined && sStyle !== 'none' && (sType === undefined || sType !== 'none')
  }
  const color = hex(tp['fo:color'])
  if (color) f.color = color
  const ls = tp['fo:letter-spacing']
  if (ls !== undefined) {
    const t = ls === 'normal' ? 0 : twips(ls)
    if (t !== undefined) f.charSpacingTwips = t
  }
  const scale = percent(tp['style:text-scale'])
  if (scale !== undefined && Math.round(scale * 100) !== 100 && scale > 0)
    f.charScalePct = Math.round(scale * 100)
  const bg = hex(tp['fo:background-color'])
  if (bg) f.shading = bg
  const pos = tp['style:text-position']
  if (pos) {
    const first = pos.trim().split(/\s+/)[0]
    if (first === 'super') f.vertAlign = 'superscript'
    else if (first === 'sub') f.vertAlign = 'subscript'
    else {
      const p = percent(first)
      if (p !== undefined && p > 0) f.vertAlign = 'superscript'
      else if (p !== undefined && p < 0) f.vertAlign = 'subscript'
    }
  }
  if (tp['fo:text-transform'] === 'uppercase') f.caps = 'all'
  else if (tp['fo:font-variant'] === 'small-caps') f.caps = 'small'
  return f
}

/** Hex values of the OOXML named highlight colours. */
export const HIGHLIGHT_HEX: Readonly<Record<string, string>> = {
  yellow: 'FFFF00',
  green: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  blue: '0000FF',
  red: 'FF0000',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
  black: '000000',
  white: 'FFFFFF',
}

export interface TextKeys {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  vertAlign: string | null
  caps: string | null
  color: string | null
  size: number | null
  font: string | null
  fontAscii: string | null
  fontCs: string | null
  spacing: number | null
  scale: number | null
  background: string | null
}

export function textKeys(f: TextFormat | undefined): TextKeys {
  const r = f ?? {}
  const background = r.highlight
    ? (HIGHLIGHT_HEX[r.highlight] ?? null)
    : r.shading
      ? r.shading.toUpperCase()
      : null
  return {
    bold: !!r.bold,
    italic: !!r.italic,
    underline: !!r.underline,
    strike: !!r.strike,
    vertAlign: r.vertAlign ?? null,
    caps: r.caps && r.caps !== 'none' ? r.caps : null,
    color: r.color && r.color !== 'auto' ? r.color.toUpperCase() : null,
    size: r.sizeHalfPoints ?? null,
    font: r.eastAsiaFont ?? r.font ?? null,
    fontAscii: r.fontAscii ?? null,
    fontCs: r.fontCs ?? null,
    spacing: r.charSpacingTwips ? r.charSpacingTwips : null,
    scale: r.charScalePct && r.charScalePct !== 100 ? r.charScalePct : null,
    background,
  }
}

/** Text keys whose edited value differs from the original; null in the edited keys = cleared. */
export function changedTextKeys(original: TextKeys, edited: TextKeys): Array<keyof TextKeys> {
  const out: Array<keyof TextKeys> = []
  for (const key of Object.keys(original) as Array<keyof TextKeys>) {
    if (original[key] !== edited[key]) out.push(key)
  }
  return out
}

/**
 * The values to write for changed keys: the edited value, or for a cleared
 * one what the docx run then inherits from its paragraph style chain
 * (`inherited`; null there removes the attribute).
 */
export function clearedToInherited(
  changed: ReadonlyArray<keyof TextKeys>,
  edited: TextKeys,
  inherited: TextKeys,
): TextKeys {
  const out = { ...edited } as Record<keyof TextKeys, TextKeys[keyof TextKeys]>
  for (const key of changed) {
    if (edited[key] === null) out[key] = inherited[key]
  }
  return out as TextKeys
}

/**
 * ODF `style:text-properties` overrides for changed text keys. `face` returns
 * the `style:font-face` name to reference for a family (declaring it if needed).
 */
export function textOverrides(
  keys: ReadonlyArray<keyof TextKeys>,
  edited: TextKeys,
  face: (family: string) => string,
): AttrOverrides {
  const o: AttrOverrides = {}
  const trio = (base: string, value: string | null, foName = `fo:${base}`) => {
    o[foName] = value
    o[`style:${base}-asian`] = value
    o[`style:${base}-complex`] = value
  }
  for (const key of keys) {
    switch (key) {
      case 'bold':
        trio('font-weight', edited.bold ? 'bold' : 'normal')
        break
      case 'italic':
        trio('font-style', edited.italic ? 'italic' : 'normal')
        break
      case 'underline':
        o['style:text-underline-style'] = edited.underline ? 'solid' : 'none'
        o['style:text-underline-type'] = edited.underline ? 'single' : 'none'
        if (edited.underline) {
          o['style:text-underline-width'] = 'auto'
          o['style:text-underline-color'] = 'font-color'
        }
        break
      case 'strike':
        o['style:text-line-through-style'] = edited.strike ? 'solid' : 'none'
        o['style:text-line-through-type'] = edited.strike ? 'single' : 'none'
        break
      case 'vertAlign':
        o['style:text-position'] =
          edited.vertAlign === 'superscript'
            ? 'super 58%'
            : edited.vertAlign === 'subscript'
              ? 'sub 58%'
              : '0% 100%'
        break
      case 'caps':
        o['fo:text-transform'] = edited.caps === 'all' ? 'uppercase' : 'none'
        o['fo:font-variant'] = edited.caps === 'small' ? 'small-caps' : 'normal'
        break
      case 'color':
        o['fo:color'] = edited.color ? `#${edited.color.toLowerCase()}` : null
        break
      case 'size':
        trio('font-size', edited.size ? halfPointsToPt(edited.size) : null)
        break
      case 'font':
        o['style:font-name-asian'] = edited.font ? face(edited.font) : null
        o['style:font-family-asian'] = edited.font ? quoteFamily(edited.font) : null
        break
      case 'fontAscii':
        o['style:font-name'] = edited.fontAscii ? face(edited.fontAscii) : null
        o['fo:font-family'] = edited.fontAscii ? quoteFamily(edited.fontAscii) : null
        break
      case 'fontCs':
        o['style:font-name-complex'] = edited.fontCs ? face(edited.fontCs) : null
        o['style:font-family-complex'] = edited.fontCs ? quoteFamily(edited.fontCs) : null
        break
      case 'spacing':
        o['fo:letter-spacing'] = twipsToPt(edited.spacing ?? 0)
        break
      case 'scale':
        o['style:text-scale'] = `${edited.scale ?? 100}%`
        break
      case 'background':
        o['fo:background-color'] = edited.background
          ? `#${edited.background.toLowerCase()}`
          : 'transparent'
        break
    }
  }
  return o
}

export const quoteFamily = (family: string): string => (/\s/.test(family) ? `'${family}'` : family)
