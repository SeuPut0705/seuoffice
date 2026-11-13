// DrawingML geometry and color helpers: line presets, scheme/preset colors,
// anchor metadata and page-position resolution, group transforms.
import { type XNode } from './xml-utils'
import type { SectionSettings, ThemeColors } from './types'
import { invoke, xnodeArg } from './engine'

/** color-bearing node (a:solidFill / a:fillRef / a:lnRef …) → hex without '#' */
export function colorNodeHex(
  node: XNode | undefined,
  theme?: ThemeColors | null,
): string | undefined {
  return invoke('colorNodeHex', [xnodeArg(node), theme], { undef: true }) as never
}
/** anchored-drawing placement of one top-level w:drawing fragment */
export interface DrawingAnchorMeta {
  offsetXEmu?: number
  offsetYEmu?: number
  /** wrapNone (front) / behindDoc anchors leave the text flow entirely */
  noWrap?: boolean
  /** behindDoc="1": paints under the body text (z-order only) */
  behind?: boolean
  /** raw page coordinates for a first-page page-anchored cover drawing: the
   *  renderer resolves the boxes against the page box, not the paragraph */
  pageXEmu?: number
  pageYEmu?: number
  /** wp:wrapTopAndBottom: body text is excluded from the drawing's vertical band */
  topBottom?: boolean
  /** layoutInCell="0": a cell-anchored drawing positions against the page/column, not its cell */
  outsideCell?: boolean
  anchored?: boolean
  /** wp:positionH/V relativeFrom */
  relH?: string
  relV?: string
  /** wp:align inside wp:positionH/V */
  alignH?: string
  alignV?: string
  /** wp14:pctPosH/VOffset in 1/1000 of a percent of the reference frame */
  pctH?: number
  pctV?: number
  /** wp:extent (drawing size) */
  extentXEmu?: number
  extentYEmu?: number
  /** wp:anchor distL/distR/distT/distB: text clearance around a side-wrapped drawing */
  distLEmu?: number
  distREmu?: number
  distTEmu?: number
  distBEmu?: number
  /** relativeHeight − Word's 251658240 base: paint order among overlapping anchors */
  z?: number
}
/** anchor position resolved to EMU offsets from the paragraph flow origin
 *  (column left / body top), page coordinates recoverable via the margins */
export interface ResolvedAnchorPos {
  xEmu: number
  yEmu?: number
  /** the drawing lies horizontally outside the body column (sidebar layout) */
  outsideColumn: boolean
}
export interface ExtractTextboxOpts {
  /** include textless preset shapes (stars, block arrows…) as display boxes */
  shapes?: boolean
  /** include picture-only drawings (pic:pic without a shape) as picture boxes */
  pictures?: boolean
  /** page geometry of the governing section (page/margin-anchored placement) */
  section?: SectionSettings
  /** document.xml byte offset of the host paragraph: textbox paragraphs resolve
   *  their character-unit indents under that section's document grid */
  docOffset?: number
  /** the paragraph sits before the first explicit page break: page-V-anchored
   *  cover art may pin to the page origin instead of the paragraph origin */
  firstPage?: boolean
}
/** child-EMU → anchor-EMU affine transform of a wpg group (X = tx + x·sx) */
export interface GroupCtm {
  sx: number
  sy: number
  tx: number
  ty: number
}
