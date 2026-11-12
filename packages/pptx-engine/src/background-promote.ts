/// Full-page background normalization. The cloud html→pptx converter encodes the
/// page background as ordinary bottom-of-z-order full-page shapes when its own
/// promotion heuristics miss (e.g. a 1px fully-transparent border on the
/// container). Such shapes swallow every click/marquee on the slide, so:
/// - promoteSlideBackground rewrites them into a native <p:bg> at landing time
///   (strict conditions, destructive);
/// - isBackgroundLikeElement is the loose predicate the render layer uses to mark
///   surviving full-page backgrounds (existing files, image backgrounds) as
///   interaction-layer background nodes (non-destructive).
import type { Slide, SlideElement, SlideSize } from './types'
import { call } from './engine'

/**
 * Promote the bottom-of-z-order contiguous run of full-page opaque solid shapes
 * into a native <p:bg> (topmost color wins — it is the one visible) and delete
 * them. Returns whether anything was promoted; on success the slide is
 * structureDirty and its model background is updated.
 */
export function promoteSlideBackground(slide: Slide, size: SlideSize): boolean {
  return call('promoteSlideBackground', [slide, size], { mut: { 0: 'json' } }) as never
}
/**
 * Loose predicate for interaction-layer marking: a full-page unrotated textless
 * fill (solid/gradient/image shape, or a picture) with an invisible stroke.
 * Marked nodes stay visible and editable but stop swallowing marquee drags.
 */
export function isBackgroundLikeElement(el: SlideElement, size: SlideSize): boolean {
  return call('isBackgroundLikeElement', [el, size]) as never
}