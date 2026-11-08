import { describe, expect, it } from 'vitest'

import {
  activationMode,
  clampSplitRatio,
  decideSplitDrop,
  paneRects,
  SPLIT_EVEN_RATIO,
  splitAvailablePx,
  splitDropZone,
  splitRatioLimits,
} from '../src/main/split-layout'
import {
  SPLIT_DIVIDER_PX,
  SPLIT_EDGE_ZONE_PX,
  SPLIT_MIN_PANE_PX,
} from '../src/shared/split-view-api'
import { TAB_STRIP_HEIGHT } from '../src/shared/tab-drag-geometry'
import {
  dividerRect,
  ratioForDividerOffset,
  ratioForDragOffset,
} from '../src/renderer/src/split-view-geometry'

const W = 1200
const H = 800
const content = { x: 0, y: TAB_STRIP_HEIGHT, width: W, height: H - TAB_STRIP_HEIGHT }

describe('split geometry', () => {
  it('takes the divider out of the shared axis', () => {
    expect(splitAvailablePx(content, 'side')).toBe(W - SPLIT_DIVIDER_PX)
    expect(splitAvailablePx(content, 'stack')).toBe(H - TAB_STRIP_HEIGHT - SPLIT_DIVIDER_PX)
  })

  it('keeps both panes above the minimum when the window is big enough', () => {
    const { min, max } = splitRatioLimits(content, 'side')
    expect(min).toBeCloseTo(SPLIT_MIN_PANE_PX / (W - SPLIT_DIVIDER_PX))
    expect(max).toBeCloseTo(1 - min)
    expect(clampSplitRatio(0.05, content, 'side')).toBeCloseTo(min)
    expect(clampSplitRatio(0.95, content, 'side')).toBeCloseTo(max)
    expect(clampSplitRatio(0.5, content, 'side')).toBeCloseTo(0.5)
  })

  it('lets the share run free when two minimums cannot fit', () => {
    const small = { x: 0, y: TAB_STRIP_HEIGHT, width: SPLIT_MIN_PANE_PX * 2 - 20, height: 400 }
    expect(splitRatioLimits(small, 'side')).toEqual({ min: 0, max: 1 })
  })

  it('lays side-by-side panes out around the divider', () => {
    const rects = paneRects(content, 'side', 0.5)
    expect(rects.a).toEqual({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: (W - SPLIT_DIVIDER_PX) / 2,
      height: H - TAB_STRIP_HEIGHT,
    })
    expect(rects.b.x).toBeCloseTo(rects.a.x + rects.a.width + SPLIT_DIVIDER_PX)
    expect(rects.b.width).toBeCloseTo(rects.a.width)
    expect(rects.b.y).toBe(TAB_STRIP_HEIGHT)
  })

  it('stacks panes top and bottom around the divider', () => {
    const rects = paneRects(content, 'stack', 0.25)
    const available = H - TAB_STRIP_HEIGHT - SPLIT_DIVIDER_PX
    expect(rects.a.height).toBeCloseTo(available * 0.25)
    expect(rects.b.y).toBeCloseTo(rects.a.y + rects.a.height + SPLIT_DIVIDER_PX)
    expect(rects.b.height).toBeCloseTo(available * 0.75)
    expect(rects.a.width).toBe(W)
  })

  it('leaves exactly the divider gap between the panes on both orientations', () => {
    // the renderer's dividerRect (split-view-geometry.ts) draws inside this
    // gap using the same constants; both formulas share these numbers:
    for (const orientation of ['side', 'stack'] as const) {
      for (const ratio of [0.2, 0.5, 0.73]) {
        const rects = paneRects(content, orientation, ratio)
        const available = splitAvailablePx(content, orientation)
        const aLength = ratio * available
        if (orientation === 'side') {
          expect(rects.a.width).toBeCloseTo(aLength)
          expect(rects.b.x).toBeCloseTo(aLength + SPLIT_DIVIDER_PX)
          expect(rects.b.width).toBeCloseTo(available - aLength)
        } else {
          expect(rects.a.height).toBeCloseTo(aLength)
          expect(rects.b.y).toBeCloseTo(content.y + aLength + SPLIT_DIVIDER_PX)
          expect(rects.b.height).toBeCloseTo(available - aLength)
        }
      }
    }
  })

  it('matches the renderer divider rectangle module (parity for both orientations)', () => {
    const viewport = { width: W, height: H }
    for (const orientation of ['side', 'stack'] as const) {
      for (const ratio of [0.2, 0.5, 0.73]) {
        const rects = paneRects(content, orientation, ratio)
        const divider = dividerRect(viewport, orientation, ratio)
        if (orientation === 'side') {
          expect(divider.left).toBeCloseTo(rects.a.width)
          expect(rects.b.x).toBeCloseTo(divider.left + SPLIT_DIVIDER_PX)
        } else {
          expect(divider.top).toBeCloseTo(rects.a.height + TAB_STRIP_HEIGHT)
          expect(rects.b.y).toBeCloseTo(divider.top + SPLIT_DIVIDER_PX)
        }
      }
    }
  })

  it('agrees with the renderer drag ratio: in-between = clamped, past a minimum = close', () => {
    const viewport = { width: W, height: H }
    const share = ratioForDividerOffset(300, viewport, 'side')
    expect(ratioForDragOffset(300, viewport, 'side')).toBeCloseTo(
      clampSplitRatio(share, content, 'side'),
    )
    // the renderer asks for a close (0/1) at the ends; setSplitRatio treats
    // those as unsplit, so no clamp applies to them
    expect(ratioForDragOffset(10, viewport, 'side')).toBe(0)
    expect(ratioForDragOffset(W - 10, viewport, 'side')).toBe(1)
  })

  it('gives an in-between share back un-clamped and asks for a close past a minimum', () => {
    const available = W - SPLIT_DIVIDER_PX
    const share = 300 / available
    expect(clampSplitRatio(share, content, 'side')).toBeCloseTo(share)
    // a pointer inside a minimum band is out of [min, max]: the caller closes
    // that side by sending 0/1 (see setSplitRatio)
    const { min, max } = splitRatioLimits(content, 'side')
    expect(10 / available).toBeLessThan(min)
    expect((W - 10) / available).toBeGreaterThan(max)
  })
})

describe('drop zones', () => {
  it('recognizes the right and bottom edge bands', () => {
    expect(splitDropZone(W - 10, 400, W, H)).toBe('side')
    expect(splitDropZone(600, H - 10, W, H)).toBe('stack')
    expect(splitDropZone(600, 400, W, H)).toBeNull()
  })

  it('never claims the tab strip band (that is the dock target)', () => {
    expect(splitDropZone(W - 10, TAB_STRIP_HEIGHT - 1, W, H)).toBeNull()
    expect(splitDropZone(W - 10, TAB_STRIP_HEIGHT + 1, W, H)).toBe('side')
  })

  it('picks the nearer edge in the corner', () => {
    expect(splitDropZone(W - 5, H - 40, W, H)).toBe('side')
    expect(splitDropZone(W - 40, H - 5, W, H)).toBe('stack')
  })

  it('treats the exact band edge as a hit and rejects junk coordinates', () => {
    expect(splitDropZone(W - SPLIT_EDGE_ZONE_PX, 400, W, H)).toBe('side')
    expect(splitDropZone(Number.NaN, 400, W, H)).toBeNull()
  })
})

describe('decideSplitDrop', () => {
  const split = { aTabId: 'a1', bTabId: 'b1', orientation: 'side', focus: 'b' } as const
  const outside = { isDocument: true, isPaneTab: false, docPane: null } as const

  it('ignores non-document tabs', () => {
    expect(
      decideSplitDrop({
        split: null,
        dragged: { isDocument: false, isPaneTab: false, docPane: null },
        dropped: 'side',
      }),
    ).toBeNull()
  })

  it('creates the split from an outside tab with no split yet', () => {
    expect(decideSplitDrop({ split: null, dragged: outside, dropped: 'stack' })).toEqual({
      kind: 'create',
      orientation: 'stack',
    })
  })

  it('flips orientation when a pane tab lands on the other edge', () => {
    expect(
      decideSplitDrop({
        split,
        dragged: { isDocument: true, isPaneTab: true, docPane: 'a' },
        dropped: 'stack',
      }),
    ).toEqual({ kind: 'flip', orientation: 'stack' })
    expect(
      decideSplitDrop({
        split,
        dragged: { isDocument: true, isPaneTab: true, docPane: 'a' },
        dropped: 'side',
      }),
    ).toEqual({ kind: 'noop' })
  })

  it('focuses the pane that already shows the dragged document', () => {
    expect(
      decideSplitDrop({
        split,
        dragged: { isDocument: true, isPaneTab: false, docPane: 'a' },
        dropped: 'side',
      }),
    ).toEqual({ kind: 'focus' })
  })

  it('replaces the dropped side or reorients on the other edge', () => {
    expect(decideSplitDrop({ split, dragged: outside, dropped: 'side' })).toEqual({
      kind: 'replace',
    })
    expect(decideSplitDrop({ split, dragged: outside, dropped: 'stack' })).toEqual({
      kind: 'reorient',
      orientation: 'stack',
    })
  })
})

describe('activationMode', () => {
  const split = { aTabId: 'a1', bTabId: 'b1' }

  it('is plain activation without a split', () => {
    expect(activationMode(null, { id: 'x', kind: 'docs' })).toBe('normal')
  })

  it('moves focus for pane tabs, covers for home/help/present, replaces otherwise', () => {
    expect(activationMode(split, { id: 'a1', kind: 'docs' })).toBe('pane')
    expect(activationMode(split, { id: 'h', kind: 'home' })).toBe('cover')
    expect(activationMode(split, { id: 'x', kind: 'help' })).toBe('cover')
    expect(activationMode(split, { id: 'p', kind: 'html', present: true })).toBe('cover')
    expect(activationMode(split, { id: 'x', kind: 'hwp' })).toBe('replace-pane')
  })
})

describe('even ratio', () => {
  it('is half', () => {
    expect(SPLIT_EVEN_RATIO).toBe(0.5)
  })
})
