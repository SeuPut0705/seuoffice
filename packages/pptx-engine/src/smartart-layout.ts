/**
 * SmartArt preset layout math, split from smartart.ts so the renderer can import
 * it for gallery previews without pulling in the archive/XML machinery (Node-only deps).
 */
import type { EmuRect } from './types'
import { call } from './engine'

export type SmartArtLayout =
  'list' | 'process' | 'cycle' | 'hierarchy' | 'pyramid' | 'matrix' | 'venn'
export interface SmartArtChildShape {
  prst: string
  box: EmuRect
  text?: string
  color: string
  fontSize?: number
  /** Fill opacity 0..1 (venn overlaps); omitted = opaque */
  alpha?: number
}
/** Generate child shapes per layout (child coordinate space = the group's own resolution-independent coords, in EMU). */
export function layoutShapes(
  layout: SmartArtLayout,
  items: string[],
  cx: number,
  cy: number,
): SmartArtChildShape[] {
  return call('layoutShapes', [layout, items, cx, cy]) as never
}