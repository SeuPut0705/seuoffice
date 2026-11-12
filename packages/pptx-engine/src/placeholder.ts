/**
 * Placeholder geometry inheritance (Phase 2, filling a gap left by Phase 1).
 *
 * Placeholder shapes on a slide (<p:ph>) often omit their own <a:xfrm>; geometry
 * must be backfilled from the slideLayout per OOXML inheritance rules, and from
 * the slideMaster when the layout lacks it.
 *
 * Matching rules (aligned with PowerPoint / pptxtojson):
 *   1. exact (type, idx) match first;
 *   2. then by idx (when type is missing/inconsistent);
 *   3. then by type;
 *   4. body-like types (body/subTitle, etc.) fall back to each other, as do
 *      title/ctrTitle.
 *
 * Read-only: layout/master geometry is used only for render inheritance, never
 * written back to the original pptx.
 */
import type { Transform, TextAlign } from './types'
import { type EaScript, type Theme } from './theme'
import { call } from './engine'

/** Default run/paragraph style for one indent level (from lstStyle's lvlNpPr/defRPr). */
/** Fields whose inheritance source a level records (see mergeTextStyleChain). */
export type StyleSourceField =
  'fontSize' | 'bold' | 'italic' | 'color' | 'latinFont' | 'eaFont' | 'csFont' | 'align'
export interface LevelTextStyle {
  /** Which chain layer supplied each field (only set by mergeTextStyleChain) */
  src?: Partial<Record<StyleSourceField, string>>
  /** The level's unresolved latin theme ref (+mj-lt / +mn-lt), kept beside the resolved name */
  latinFontRef?: string
  /** Font size (pt) */
  fontSize?: number
  bold?: boolean
  italic?: boolean
  /** Character casing <a:defRPr cap>: 'all' | 'small' | 'none' */
  cap?: string
  color?: string
  /** <a:defRPr><a:effectLst><a:outerShdw> (rare; e.g. watermark text boxes) */
  shadow?: import('./types').ShadowEffect
  latinFont?: string
  eaFont?: string
  /** The level's unresolved ea theme ref (+mj-ea / +mn-ea): a run re-resolves it with its own
   *  script, since an empty theme <a:ea/> picks the per-script font only once the script is known */
  eaFontRef?: string
  csFont?: string
  /** East Asian script of the level's defRPr lang/altLang (steers empty-ea theme refs on runs without a lang of their own) */
  eaScript?: EaScript
  /** Line-breaking language of a level whose defRPr carries lang/altLang: its East Asian
   *  script, or 'none' for a non-East-Asian tag (so an inherited en-US still counts as a tag) */
  eaLang?: Exclude<EaScript, 'han'> | 'none'
  align?: TextAlign
  /** Bullet default (master bodyStyle levels commonly use buChar '•') */
  bullet?: {
    type: 'none' | 'char' | 'number' | 'blip'
    char?: string
    /** <a:buBlip> picture bullet: media zip path + blip rId (see Paragraph.bullet) */
    mediaRef?: string
    blipEmbedId?: string
    /** <a:buFont> typeface (symbol fonts like Wingdings) */
    font?: string
    color?: string
    /** <a:buSzPct> (%, 100 = same size as text) */
    sizePct?: number
    /** <a:buSzPts> absolute glyph size (pt) */
    sizePt?: number
    /** <a:buAutoNum type> (arabicPeriod/romanLcParen…) */
    numType?: string
    /** <a:buAutoNum startAt> */
    startAt?: number
  }
  /** Paragraph left indent (EMU) */
  marL?: number
  /** First-line indent (EMU, negative = hanging) */
  indent?: number
  /** Line/paragraph spacing defaults (lnSpc/spcBef/spcAft from master txStyles; source of inherited line spacing) */
  lineHeight?: number
  lineExact?: number
  spaceBefore?: number
  spaceAfter?: number
  spaceBeforePct?: number
  spaceAfterPct?: number
  /** <a:lvlNpPr hangingPunct/latinLnBrk/eaLnBrk> line-break switches; absent = inherit */
  hangingPunct?: boolean
  latinLnBrk?: boolean
  eaLnBrk?: boolean
}
/** Default styles for the 9 levels (index = level, 0-based). */
export interface TextStyleLevels {
  levels: Array<LevelTextStyle | undefined>
  /** where this layer sits in the inheritance chain, for style provenance */
  src?: string
}
/** master <p:txStyles>: the title/body/other families. */
export interface MasterTextStyles {
  title?: TextStyleLevels
  body?: TextStyleLevels
  other?: TextStyleLevels
}
export interface PlaceholderGeom {
  type: string // ph type, normalized to 'body' when missing
  idx: string // ph idx, '' when missing
  transform: Transform | null
  /** Default text style from this placeholder txBody's <a:lstStyle> */
  textStyle?: TextStyleLevels
  /** Vertical anchor from this placeholder's <a:bodyPr anchor=""> */
  anchor?: 'top' | 'middle' | 'bottom'
  /** <a:bodyPr anchorCtr> (explicit 0 recorded too: it overrides an inherited 1) */
  anchorCtr?: boolean
  /** Explicit bodyPr inset attrs (EMU); slide bodyPr attrs missing these inherit per-attribute */
  insets?: { l?: number; t?: number; r?: number; b?: number }
  /** Raw spPr node when it carries an explicit fill (parse.ts resolves it with the part's rels) */
  fillSpPr?: unknown
  /** Non-rect <a:prstGeom>: placeholder pictures inherit it as their clip shape */
  presetGeom?: { prst: string; avLstRaw?: unknown }
}
/** Placeholder geometry table for one layer (layout or master). */
export interface PlaceholderMap {
  entries: PlaceholderGeom[]
}
/**
 * Extract the placeholder geometry table + lstStyle text style defaults from a
 * layout/master's full XML. Collects shapes that carry <p:ph> and at least one of
 * <a:xfrm> or <a:lstStyle>.
 */
export function parsePlaceholderMap(
  layoutOrMasterXml: string,
  theme?: Theme,
  mediaRels?: Map<string, string>,
): PlaceholderMap {
  return call('parsePlaceholderMap', [layoutOrMasterXml, theme, mediaRels], { shape: {"k":"obj","f":{"entries":{"k":"arr","v":{"k":"obj","f":{"textStyle":{"k":"obj","f":{"levels":{"k":"arr","u":true}}}}}}}} }) as never
}
/** <a:lvlNpPr> (including defRPr) → LevelTextStyle. */
/** Where a list style lives: only the slide part's own rIds may be written back into slide XML. */
export interface LstStyleSource {
  mediaRels?: Map<string, string>
  /** Layout/master part: picture bullets resolve their image but keep no rId */
  foreignPart?: boolean
}
/** <a:lstStyle> (or one txStyles family) → 9-level style table. */
export function parseLstStyleLevels(
  lst: unknown,
  theme?: Theme,
  src?: LstStyleSource,
): TextStyleLevels | undefined {
  return call('parseLstStyleLevels', [lst, theme, src], { names: ["lst","theme","src"], shape: {"k":"obj","f":{"levels":{"k":"arr","u":true}}}, undef: true }) as never
}
/** presentation.xml <p:defaultTextStyle> → base defaults for non-placeholder text boxes. */
export function parseDefaultTextStyle(
  presentationXml: string,
  theme?: Theme,
): TextStyleLevels | undefined {
  return call('parseDefaultTextStyle', [presentationXml, theme], { shape: {"k":"obj","f":{"levels":{"k":"arr","u":true}}}, undef: true }) as never
}
/** master <p:txStyles> → default styles for the title/body/other families. */
export function parseMasterTextStyles(
  masterXml: string,
  theme?: Theme,
  mediaRels?: Map<string, string>,
): MasterTextStyles {
  return call('parseMasterTextStyles', [masterXml, theme, mediaRels], { shape: {"k":"obj","f":{"title":{"k":"obj","f":{"levels":{"k":"arr","u":true}}},"body":{"k":"obj","f":{"levels":{"k":"arr","u":true}}},"other":{"k":"obj","f":{"levels":{"k":"arr","u":true}}}}} }) as never
}
/**
 * Resolve a placeholder's inherited bodyPr insets, merged per-attribute (layout wins
 * over master). PowerPoint inherits each unspecified inset attr along the ph chain —
 * a master body with lIns=0 reaches slides whose layout bodyPr only sets numCol.
 */
export function resolvePlaceholderInsets(
  layout: PlaceholderMap | undefined,
  master: PlaceholderMap | undefined,
  type: string | undefined,
  idx: string | undefined,
): PlaceholderGeom['insets'] {
  return call('resolvePlaceholderInsets', [layout, master, type, idx], { names: ["layout","master","type","idx"], undef: true }) as never
}
/** Resolve a placeholder's inherited vertical anchor: layout first, master as fallback. */
export function resolvePlaceholderAnchor(
  layout: PlaceholderMap | undefined,
  master: PlaceholderMap | undefined,
  type: string | undefined,
  idx: string | undefined,
): PlaceholderGeom['anchor'] {
  return call('resolvePlaceholderAnchor', [layout, master, type, idx], { names: ["layout","master","type","idx"], undef: true }) as never
}
/**
 * Placeholder text style inheritance chain (highest priority first):
 * layout placeholder lstStyle → master placeholder lstStyle → master txStyles
 * (by ph family). The caller may prepend the slide shape's own lstStyle.
 */
export function placeholderStyleChain(
  layout: PlaceholderMap | undefined,
  master: PlaceholderMap | undefined,
  masterTx: MasterTextStyles | undefined,
  type: string | undefined,
  idx: string | undefined,
): TextStyleLevels[] {
  return call('placeholderStyleChain', [layout, master, masterTx, type, idx], { names: ["layout","master","masterTx","type","idx"], shape: {"k":"arr","v":{"k":"obj","f":{"levels":{"k":"arr","u":true}}}} }) as never
}
/**
 * Merge one level's default style field by field along the inheritance chain
 * (earlier layers win). When a layer lacks the level, fall back to that layer's
 * lvl1 (lenient fallback).
 */
export function mergeTextStyleChain(
  chain: Array<TextStyleLevels | undefined>,
  level: number,
): LevelTextStyle | undefined {
  return call('mergeTextStyleChain', [chain, level], { undef: true }) as never
}
/**
 * Placeholder fill inheritance: the nearest layer (layout, then master) whose matching
 * placeholder spPr carries an explicit fill — including <a:noFill>, which stops the fallback.
 * Returns the raw spPr plus its layer so the caller resolves blip rIds in that part's rels.
 */
export function resolvePlaceholderFillSpPr(
  layout: PlaceholderMap | undefined,
  master: PlaceholderMap | undefined,
  type: string | undefined,
  idx: string | undefined,
): { spPr: unknown; layer: 'layout' | 'master' } | undefined {
  return call('resolvePlaceholderFillSpPr', [layout, master, type, idx], { names: ["layout","master","type","idx"], undef: true }) as never
}
/**
 * Resolve placeholder geometry: layout first, master as fallback.
 * undefined means neither layer has inheritable geometry (the render layer may
 * further fall back to a default or (0,0)).
 */
export function resolvePlaceholderTransform(
  layout: PlaceholderMap | undefined,
  master: PlaceholderMap | undefined,
  type: string | undefined,
  idx: string | undefined,
): Transform | undefined {
  return call('resolvePlaceholderTransform', [layout, master, type, idx], { names: ["layout","master","type","idx"], undef: true }) as never
}