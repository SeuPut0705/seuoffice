/**
 * Pure split-view layout and drag-decision math for the shell main process.
 * Electron-free so unit tests can drive every branch; the shell renderer's
 * split-view-geometry.ts mirrors the same divider formulas (see the parity
 * test in tests/split-layout.test.ts).
 */
import {
  SPLIT_DIVIDER_PX,
  SPLIT_EDGE_ZONE_PX,
  SPLIT_MIN_PANE_PX,
  type SplitDropIntent,
  type SplitOrientation,
  type SplitViewState,
} from '../shared/split-view-api'
import { TAB_STRIP_HEIGHT, type Rect } from '../shared/tab-drag-geometry'
import type { TabKind } from '../shared/tabs-api'

/** Share of the first pane (a) a new split starts with. */
export const SPLIT_EVEN_RATIO = 0.5

export interface PaneRects {
  a: Rect
  b: Rect
}

/** Space the two panes share along the split axis, divider gap taken out. */
export function splitAvailablePx(content: Rect, orientation: SplitOrientation): number {
  const along = orientation === 'side' ? content.width : content.height
  return Math.max(0, along - SPLIT_DIVIDER_PX)
}

/**
 * Smallest and largest live ratio: both panes keep SPLIT_MIN_PANE_PX. A window
 * too small for two minimums cannot honor them, so the share stays free and
 * only the physical ends (0/1) close a side.
 */
export function splitRatioLimits(
  content: Rect,
  orientation: SplitOrientation,
): { min: number; max: number } {
  const available = splitAvailablePx(content, orientation)
  if (available <= 0) return { min: SPLIT_EVEN_RATIO, max: SPLIT_EVEN_RATIO }
  const min = SPLIT_MIN_PANE_PX / available
  if (min >= SPLIT_EVEN_RATIO) return { min: 0, max: 1 }
  return { min, max: 1 - min }
}

/** Live ratio for an in-between request; 0/1 (close a side) are handled by the caller. */
export function clampSplitRatio(
  ratio: number,
  content: Rect,
  orientation: SplitOrientation,
): number {
  const { min, max } = splitRatioLimits(content, orientation)
  return Math.min(max, Math.max(min, ratio))
}

/** Shelf/length halves of the pane space; pane a takes ratio * available. */
export function paneRects(content: Rect, orientation: SplitOrientation, ratio: number): PaneRects {
  const available = splitAvailablePx(content, orientation)
  if (orientation === 'side') {
    const aWidth = available * ratio
    return {
      a: { x: content.x, y: content.y, width: aWidth, height: content.height },
      b: {
        x: content.x + aWidth + SPLIT_DIVIDER_PX,
        y: content.y,
        width: available - aWidth,
        height: content.height,
      },
    }
  }
  const aHeight = available * ratio
  return {
    a: { x: content.x, y: content.y, width: content.width, height: aHeight },
    b: {
      x: content.x,
      y: content.y + aHeight + SPLIT_DIVIDER_PX,
      width: content.width,
      height: available - aHeight,
    },
  }
}

/**
 * Split orientation a torn-drag pointer at window-content coordinates is over:
 * the right edge band means side-by-side, the bottom edge band stacked. The
 * tab strip band is never a split zone — that is the dock target. A pointer
 * in the bottom-right corner picks the nearer edge.
 */
export function splitDropZone(
  x: number,
  y: number,
  width: number,
  height: number,
): SplitOrientation | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (y < TAB_STRIP_HEIGHT) return null
  const fromRight = width - x
  const fromBottom = height - y
  const rightHit = fromRight <= SPLIT_EDGE_ZONE_PX
  const bottomHit = fromBottom <= SPLIT_EDGE_ZONE_PX
  if (rightHit && bottomHit) return fromRight <= fromBottom ? 'side' : 'stack'
  if (rightHit) return 'side'
  if (bottomHit) return 'stack'
  return null
}

export interface SplitDragContext {
  /** the live split, or null when the window shows a single pane */
  split: Pick<SplitViewState, 'aTabId' | 'bTabId' | 'orientation' | 'focus'> | null
  dragged: {
    /** the dragged tab is a document tab (home/help/present are not) */
    isDocument: boolean
    /** the dragged tab is currently shown in one of the two panes */
    isPaneTab: boolean
    /** the pane whose document is this tab's document (by tab id or file path) */
    docPane: 'a' | 'b' | null
  }
  /** the edge orientation the pointer was dropped on */
  dropped: SplitOrientation
}

/**
 * The drag rules of the split view, decided once here so no caller re-reads
 * the drag. A null result means "no split intent" — the existing tear-off /
 * dock flow continues untouched.
 */
export function decideSplitDrop(ctx: SplitDragContext): SplitDropIntent | null {
  const { split, dragged, dropped } = ctx
  if (!dragged.isDocument) return null
  if (!split) {
    // no split yet: the dragged tab opens the pane on the dropped side
    return dragged.isPaneTab ? null : { kind: 'create', orientation: dropped }
  }
  if (dragged.isPaneTab) {
    return dropped === split.orientation ? { kind: 'noop' } : { kind: 'flip', orientation: dropped }
  }
  if (dragged.docPane !== null) return { kind: 'focus' }
  return dropped === split.orientation
    ? { kind: 'replace' }
    : { kind: 'reorient', orientation: dropped }
}

export type SplitActivationMode = 'normal' | 'pane' | 'replace-pane' | 'cover'

/**
 * What activating a tab means while a split exists: pane tabs only move
 * focus; home/help/present cover the split for a visit; any other document
 * tab replaces the focused pane's document.
 */
export function activationMode(
  split: Pick<SplitViewState, 'aTabId' | 'bTabId'> | null,
  tab: { id: string; kind: TabKind; present?: boolean },
): SplitActivationMode {
  if (!split) return 'normal'
  if (tab.id === split.aTabId || tab.id === split.bTabId) return 'pane'
  if (tab.kind === 'home' || tab.kind === 'help' || tab.present === true) return 'cover'
  return 'replace-pane'
}

/** the pane tab that survives when `removedTabId` leaves the split */
export function splitSurvivor(
  split: Pick<SplitViewState, 'aTabId' | 'bTabId'>,
  removedTabId: string,
): { keep: 'a' | 'b'; tabId: string } | null {
  if (removedTabId === split.aTabId) return { keep: 'b', tabId: split.bTabId }
  if (removedTabId === split.bTabId) return { keep: 'a', tabId: split.aTabId }
  return null
}

/**
 * The "other document" a create-drop puts in the opposite pane: the tab the
 * window shows, else the one before it — skipping the dragged tab and
 * anything that cannot be a pane (home/help/present).
 */
export function oppositeDocumentId(input: {
  activeId: string
  previousActiveId: string | null
  excludeId: string
  tabs: ReadonlyArray<{ id: string; kind: TabKind; present?: boolean; hasView: boolean }>
}): string | null {
  for (const candidate of [input.activeId, input.previousActiveId]) {
    if (candidate === null || candidate === input.excludeId) continue
    const tab = input.tabs.find((t) => t.id === candidate)
    if (!tab || !tab.hasView || tab.present) continue
    if (tab.kind === 'home' || tab.kind === 'help') continue
    return tab.id
  }
  return null
}
