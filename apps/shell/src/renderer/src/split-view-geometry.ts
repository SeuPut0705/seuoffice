/**
 * Pure split-view geometry for the shell renderer. The main process lays the
 * two pane WebContentsViews out below the tab strip and leaves
 * SPLIT_DIVIDER_PX between them; the shell paints the divider inside that gap,
 * so this module derives the rectangle from the same constants the main
 * process uses. No React or DOM imports so unit tests can drive it directly.
 */
import {
  SPLIT_DIVIDER_PX,
  SPLIT_MIN_PANE_PX,
  type SplitOrientation,
} from '../../shared/split-view-api'
import { TAB_STRIP_HEIGHT } from '../../shared/tab-drag-geometry'

/** Share of the first pane (a) a double click on the divider restores. */
export const SPLIT_EVEN_RATIO = 0.5

/** Window content size in CSS px — the same space the pane bounds live in. */
export interface ViewportSize {
  width: number
  height: number
}

export interface DividerRect {
  left: number
  top: number
  width: number
  height: number
}

/** Tolerance so landing exactly on a minimum/maximum boundary is still live. */
const EPSILON = 1e-9

/** The space both panes share: everything below the tab strip's own axis. */
function alongAxis(viewport: ViewportSize, orientation: SplitOrientation): number {
  return orientation === 'side' ? viewport.width : viewport.height - TAB_STRIP_HEIGHT
}

/** Where the pane space begins along the split axis (y starts below the strip). */
function axisStart(orientation: SplitOrientation): number {
  return orientation === 'side' ? 0 : TAB_STRIP_HEIGHT
}

/**
 * Pane length along the split axis once the divider gap is taken out. Pane a
 * takes ratio * this; pane b takes the rest.
 */
export function splitAvailablePx(viewport: ViewportSize, orientation: SplitOrientation): number {
  return Math.max(0, alongAxis(viewport, orientation) - SPLIT_DIVIDER_PX)
}

/**
 * Smallest and largest live ratio: both panes keep SPLIT_MIN_PANE_PX. A window
 * too short or too narrow for two minimums cannot honor them, so the share
 * stays free and only the physical ends close a side.
 */
export function splitRatioLimits(
  viewport: ViewportSize,
  orientation: SplitOrientation,
): { min: number; max: number } {
  const available = splitAvailablePx(viewport, orientation)
  if (available <= 0) return { min: SPLIT_EVEN_RATIO, max: SPLIT_EVEN_RATIO }
  const min = SPLIT_MIN_PANE_PX / available
  if (min >= SPLIT_EVEN_RATIO) return { min: 0, max: 1 }
  return { min, max: 1 - min }
}

/** The divider rectangle for a ratio; the share is clamped to [0, 1]. */
export function dividerRect(
  viewport: ViewportSize,
  orientation: SplitOrientation,
  ratio: number,
): DividerRect {
  const share = Math.min(1, Math.max(0, ratio))
  const offset = axisStart(orientation) + share * splitAvailablePx(viewport, orientation)
  if (orientation === 'side') {
    return {
      left: offset,
      top: TAB_STRIP_HEIGHT,
      width: SPLIT_DIVIDER_PX,
      height: Math.max(0, viewport.height - TAB_STRIP_HEIGHT),
    }
  }
  return {
    left: 0,
    top: offset,
    width: Math.max(0, viewport.width),
    height: SPLIT_DIVIDER_PX,
  }
}

/** Pane-a share a divider leading edge means, with no limits applied. */
export function ratioForDividerOffset(
  offset: number,
  viewport: ViewportSize,
  orientation: SplitOrientation,
): number {
  const available = splitAvailablePx(viewport, orientation)
  if (available <= 0) return SPLIT_EVEN_RATIO
  return (offset - axisStart(orientation)) / available
}

/**
 * The ratio a drag asks for. Past a pane's minimum that side is meant to close,
 * so the result is exactly 0 (close a) or 1 (close b); otherwise it is the
 * pointer's share, clamped so neither pane drops under its minimum.
 */
export function ratioForDragOffset(
  offset: number,
  viewport: ViewportSize,
  orientation: SplitOrientation,
): number {
  const share = ratioForDividerOffset(offset, viewport, orientation)
  const { min, max } = splitRatioLimits(viewport, orientation)
  if (share < min - EPSILON) return 0
  if (share > max + EPSILON) return 1
  return Math.min(max, Math.max(min, share))
}
