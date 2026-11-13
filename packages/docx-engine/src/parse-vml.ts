// Legacy VML (v:shape / v:group) geometry and color readers.
import type { HfImage } from './types'
import { invoke } from './engine'

/** VML length ("46pt", "16in", "2cm", "12px"; unitless = pt) → CSS px */
export function vmlLengthPx(value: string | undefined): number | undefined {
  return invoke('vmlLengthPx', [value], { undef: true }) as never
}
/** one declaration of a VML style attribute ("rotation:315;width:4in" → "4in") */
export function vmlStyleProp(style: string, key: string): string | undefined {
  return invoke('vmlStyleProp', [style, key], { undef: true }) as never
}
/** VML rotation ("315", "-45", "41366637fd" = 1/65536 degree units) → degrees clockwise in (0, 360) */
export function vmlRotationDeg(style: string): number | undefined {
  return invoke('vmlRotationDeg', [style], { undef: true }) as never
}
/**
 * position:absolute placement of a VML shape → header/footer float anchor
 * fields. mso-position-*-relative "text"/"column" is the paragraph box (the
 * margin box in a header); a keyword alignment wins over the margin offsets.
 */
/** wp:positionH relativeFrom / VML mso-position-horizontal-relative → placement band */
export function anchorRelH(rel: string | undefined): NonNullable<HfImage['posHRel']> {
  return invoke('anchorRelH', [rel]) as never
}
/** wp:positionV relativeFrom / VML mso-position-vertical-relative → placement band */
export function anchorRelV(rel: string | undefined): NonNullable<HfImage['posVRel']> {
  return invoke('anchorRelV', [rel]) as never
}
export function vmlFloatAnchor(
  style: string,
  out: Pick<HfImage, 'posH' | 'posV' | 'posXPx' | 'posYPx' | 'posHRel' | 'posVRel'>,
): void {
  out.posHRel = anchorRelH(vmlStyleProp(style, 'mso-position-horizontal-relative'))
  out.posVRel = anchorRelV(vmlStyleProp(style, 'mso-position-vertical-relative'))
  const posH = vmlStyleProp(style, 'mso-position-horizontal')
  const posV = vmlStyleProp(style, 'mso-position-vertical')
  if (posH === 'left' || posH === 'center' || posH === 'right') out.posH = posH
  else out.posXPx = Math.round(vmlLengthPx(vmlStyleProp(style, 'margin-left')) ?? 0)
  if (posV === 'top' || posV === 'center' || posV === 'bottom') out.posV = posV
  else out.posYPx = Math.round(vmlLengthPx(vmlStyleProp(style, 'margin-top')) ?? 0)
}
/** VML fixed-point, fraction or percentage ("32768f" = 0.5, ".5", "50%", "1") → number */
export function vmlFraction(value: string | undefined): number | undefined {
  return invoke('vmlFraction', [value], { undef: true }) as never
}
/** VML color attr ("#dbe5f1", "#aaa", "#dbe5f1 [3204]", "silver") → hex without '#' */
export function vmlColorHex(value: string | undefined): string | undefined {
  return invoke('vmlColorHex', [value], { undef: true }) as never
}
/** px per group-coordinate unit for children of a v:group (drawing canvas) */
export interface VmlGroupScale {
  sx: number
  sy: number
}
/** a group-child origin, px from the host paragraph */
export interface VmlOrigin {
  x: number
  y: number
}
/** v:shapetype templates of an XML part, by id (shapes point at them with type="#id") */
export function vmlShapeTypeTable(xml: string): Map<string, Record<string, string>> {
  return invoke('vmlShapeTypeTable', [xml], { shape: { k: 'map' } }) as never
}
/**
 * Textless VML shape (v:oval / v:rect / v:roundrect / straight-path v:shape)
 * with a solid or linear-gradient fill and stroke → SVG data URL at the
 * shape's declared size. Attributes and geometry the shape omits come from
 * the v:shapetype it points at (in the pict or in `shapeTypes`). Bails (null)
 * on groups, pictures, text and curved paths so partial art never renders.
 */
export function vmlShapeSvg(
  pict: string,
  shapeTypes?: Pick<ReadonlyMap<string, Record<string, string>>, 'get'>,
): { dataUrl: string; widthPx: number; heightPx: number; style: string } | null {
  return invoke('vmlShapeSvg', [pict, shapeTypes]) as never
}
