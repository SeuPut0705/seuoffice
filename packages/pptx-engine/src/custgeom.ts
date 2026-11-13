/**
 * <a:custGeom> custom geometry parsing (read-only rendering).
 *
 * fast-xml-parser does not preserve document order of mixed child nodes
 * (moveTo/lnTo/… order would be lost), so we scan tags in order directly over
 * the raw XML bytes.
 * Output is a normalized SVG path: coordinates 0..1, relative to each <a:path>'s
 * declared w/h; arcTo is converted to cubic beziers; gdLst/avLst formulas are
 * evaluated first so pt/arcTo can reference them.
 */
import type { CustomGeometry } from './types'
import { call } from './engine'

/**
 * gd formula evaluation (CT_GeomGuide fmla). Evaluated in order; may reference
 * earlier guides and built-in variables (w/h/ss/hc/vc/l/t/r/b/wdN/hdN/ssdN/cdN…,
 * angles in 1/60000 of a degree).
 */
export function evalGuides(
  gds: Array<{ name: string; fmla: string }>,
  w: number,
  h: number,
): Record<string, number> {
  return call('evalGuides', [gds, w, h]) as never
}
/**
 * Extract and parse <a:custGeom> from a shape's raw XML.
 * shapeW/shapeH: element box in EMU (basis for guide evaluation; fallback space
 * when a path declares no w/h).
 */
export function parseCustGeom(
  shapeXml: string,
  shapeW: number,
  shapeH: number,
): CustomGeometry | undefined {
  return call('parseCustGeom', [shapeXml, shapeW, shapeH], { undef: true }) as never
}
/** Absolute path command in <a:path> space (EMU when w/h are the element extents). */
export interface CustGeomPathCmd {
  op: 'M' | 'L' | 'C' | 'Q' | 'Z'
  pts: number[]
}
/** Editable single-path custom geometry: what Edit Points writes back as <a:custGeom>. */
export interface CustGeomPath {
  w: number
  h: number
  cmds: CustGeomPathCmd[]
}
export const CUST_GEOM_PT_COUNT: Record<CustGeomPathCmd['op'], number> = {
  M: 2,
  L: 2,
  C: 6,
  Q: 4,
  Z: 0,
}
export function validCustGeomPath(p: unknown): p is CustGeomPath {
  return call('validCustGeomPath', [p]) as never
}
/** Serialize a path as a complete <a:custGeom> (integer coordinates, path w/h as the space). */
export function custGeomXml(p: CustGeomPath): string {
  return call('custGeomXml', [p]) as never
}
