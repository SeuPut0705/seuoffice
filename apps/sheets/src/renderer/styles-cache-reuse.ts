/**
 * Univer re-renders the sheet for every scene change (a selection move, the
 * copy marquee, a hover), and every Spreadsheet.render rebuilds the styles
 * cache of the whole visible range plus ~20 columns of overflow lookahead
 * first — each cell through the full cell-content interceptor chain
 * (conditional formatting, data validation, protection, number formats). A
 * frame whose viewport is clean and unscrolled then draws nothing: it blits
 * the cached canvas. On a bordered sheet with formatting rules that rebuild
 * was most of every arrow-key press and drag step, and frozen panes repeat it
 * per pane. Skip the rebuild for exactly those blit-only frames; the visible
 * range is still recorded so later lookups see the current viewport. Any frame
 * that paints (dirty, force-dirty, scrolled, no cache canvas) rebuilds as
 * before, so a data or style change still reaches the screen.
 */
import { Spreadsheet, SpreadsheetSkeleton } from '@univerjs/engine-render'

export interface ViewportFrameInfo {
  readonly viewportKey?: string
  readonly cacheCanvas?: unknown
  readonly isDirty?: unknown
  readonly isForceDirty?: unknown
  readonly diffX?: number
  readonly diffY?: number
  readonly diffBounds?: readonly unknown[]
}

/// Content viewports draw through the cache canvas (cf. Univer's
/// sheetContentViewportKeys); header and corner viewports never reach here.
const CONTENT_VIEWPORT_KEYS = new Set([
  'viewMain',
  'viewMainLeftTop',
  'viewMainTop',
  'viewMainLeft',
])

/// True when Spreadsheet.renderByViewports will only copy the cache canvas
/// for this viewport: nothing is painted, so nothing reads the styles cache.
export function blitOnlyFrame(
  viewport: ViewportFrameInfo | null | undefined,
  componentDirty: boolean,
  componentForceDirty: boolean,
): boolean {
  if (!viewport?.cacheCanvas) return false
  if (!viewport.viewportKey || !CONTENT_VIEWPORT_KEYS.has(viewport.viewportKey)) return false
  if (viewport.isDirty || viewport.isForceDirty || componentDirty || componentForceDirty) {
    return false
  }
  if ((viewport.diffX ?? 0) !== 0 || (viewport.diffY ?? 0) !== 0) return false
  return (viewport.diffBounds?.length ?? 0) === 0
}

interface ComponentLike {
  getSkeleton(): unknown
  isDirty(): boolean
  isForceDirty(): boolean
}

interface SkeletonLike {
  updateVisibleRange(viewport?: unknown): boolean
}

let installed = false

export function installStylesCacheReuse(): void {
  if (installed) return
  installed = true
  const sheetProto = Spreadsheet.prototype as unknown as {
    render(this: ComponentLike, ctx: unknown, viewport?: ViewportFrameInfo): unknown
  }
  const skeletonProto = SpreadsheetSkeleton.prototype as unknown as {
    setStylesCache(this: SkeletonLike, viewport?: unknown): unknown
  }
  const originalRender = sheetProto.render
  const originalSetStylesCache = skeletonProto.setStylesCache
  if (typeof originalRender !== 'function' || typeof originalSetStylesCache !== 'function') return
  // The skeleton whose next setStylesCache call belongs to a blit-only frame.
  let reuseFor: unknown = null
  sheetProto.render = function (ctx, viewport) {
    if (!blitOnlyFrame(viewport, this.isDirty(), this.isForceDirty())) {
      return originalRender.call(this, ctx, viewport)
    }
    reuseFor = this.getSkeleton()
    try {
      return originalRender.call(this, ctx, viewport)
    } finally {
      reuseFor = null
    }
  }
  skeletonProto.setStylesCache = function (viewport) {
    if (reuseFor !== null && reuseFor === this) {
      reuseFor = null
      this.updateVisibleRange(viewport)
      return this
    }
    return originalSetStylesCache.call(this, viewport)
  }
}
