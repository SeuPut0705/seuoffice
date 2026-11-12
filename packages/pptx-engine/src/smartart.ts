/**
 * SmartArt (simplified) — instead of writing real diagram parts (the
 * data/layout/colors/quickStyle quartet is too heavy), generate a <p:grpSp> shape
 * group from a preset layout; it is freely editable and is just a plain shape group
 * in PowerPoint.
 *
 * Supported layouts: list (vertical list) / process (horizontal flow) / cycle /
 * hierarchy / pyramid / matrix / venn.
 */
import type { EmuRect, Slide } from './types'
import { type OpenedPptx } from './index'
import { type SmartArtLayout } from './smartart-layout'
import { call } from './engine'

export type { SmartArtLayout } from './smartart-layout'
export interface NewSmartArtOptions {
  layout: SmartArtLayout
  /** Text for each node (determines node count, 1..8) */
  items: string[]
  offset: EmuRect
}
/** Build the grpSp group fragment. */
export function buildSmartArtXml(slide: Slide, opts: NewSmartArtOptions): string {
  return call('buildSmartArtXml', [slide, opts]) as never
}
/** Insert SmartArt (shape-group version): append + reparse, returning the new slide and element id. */
export function addSmartArt(
  opened: OpenedPptx,
  slideIndex: number,
  opts: NewSmartArtOptions,
): { slide: Slide; elementId: string } | null {
  const v = call('addSmartArt', [opened, slideIndex, opts], { mut: { 0: 'opened' } }) as never as { elementId?: string } | null
  return v === null || v.elementId === undefined ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v.elementId }
}