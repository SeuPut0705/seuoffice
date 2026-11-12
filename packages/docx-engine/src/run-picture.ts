import type { HfPictureEdit, ImageWrap } from './types'
import { invoke } from './engine'

/**
 * Write the floating pictures a header/footer strip moved or resized back into
 * the part: each edited <w:drawing> (by its HfImage.drawing ordinal) takes
 * the new extents, and each axis it moved along is pinned to the page at the
 * new top-left corner. An axis it did not move keeps its own base and offset,
 * so a resize from the far edge leaves a margin-relative banner relative to
 * the margin. Every other byte of the part is kept.
 */
export function patchHfPicturesXml(partXml: string, edits: Record<number, HfPictureEdit>): string {
  return invoke('patchHfPicturesXml', [partXml, edits]) as never
}
/** The editor's geometry of a run-level picture (its docInlineImage attrs). */
export interface RunPictureGeometry {
  widthPx?: number | null
  heightPx?: number | null
  wrap?: ImageWrap | null
  offsetXEmu?: number | null
  offsetYEmu?: number | null
  relH?: 'page' | 'margin' | null
  relV?: 'page' | 'margin' | 'line' | null
  lineCenterV?: boolean | null
}
/**
 * Write a run-level picture's edited geometry back into its <w:drawing>
 * fragment. Only what differs from the fragment's own geometry is rewritten,
 * so a picture nobody touched keeps its bytes: a wrap change swaps the wrap
 * element (or converts in-line <-> floating), a move writes numeric
 * posOffsets on the bases the editor positioned it from, a resize the extents.
 * VML pictures (no wp:inline / wp:anchor) come back unchanged.
 */
export function patchRunPictureXml(xml: string, next: RunPictureGeometry): string {
  return invoke('patchRunPictureXml', [xml, next]) as never
}
