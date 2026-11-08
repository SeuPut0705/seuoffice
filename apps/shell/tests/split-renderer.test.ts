import { describe, expect, it } from 'vitest'

import { SPLIT_DIVIDER_PX, SPLIT_MIN_PANE_PX } from '../src/shared/split-view-api'
import { TAB_STRIP_HEIGHT } from '../src/shared/tab-drag-geometry'
import {
  SPLIT_EVEN_RATIO,
  dividerRect,
  ratioForDividerOffset,
  ratioForDragOffset,
  splitAvailablePx,
  splitRatioLimits,
} from '../src/renderer/src/split-view-geometry'

/**
 * Pure geometry behind the split view's divider (split-view-geometry.ts): the
 * main process lays the two WebContentsViews out below the tab strip, leaving
 * SPLIT_DIVIDER_PX between them; the shell renderer paints the divider in that
 * gap, so both sides must derive the same rectangle from the same constants.
 */

// enough room for two SPLIT_MIN_PANE_PX panes on either axis
const VIEWPORT = { width: 1000, height: 800 }
const SIDE_AVAILABLE = VIEWPORT.width - SPLIT_DIVIDER_PX
const STACK_AVAILABLE = VIEWPORT.height - TAB_STRIP_HEIGHT - SPLIT_DIVIDER_PX

describe('SPLIT_EVEN_RATIO', () => {
  it('is half of the pane space', () => {
    expect(SPLIT_EVEN_RATIO).toBe(0.5)
  })
})

describe('dividerRect', () => {
  it('draws a side split as a vertical gap centered at half', () => {
    expect(dividerRect(VIEWPORT, 'side', SPLIT_EVEN_RATIO)).toEqual({
      left: (VIEWPORT.width - SPLIT_DIVIDER_PX) / 2,
      top: TAB_STRIP_HEIGHT,
      width: SPLIT_DIVIDER_PX,
      height: VIEWPORT.height - TAB_STRIP_HEIGHT,
    })
  })

  it('draws a stacked split as a horizontal gap centered at half', () => {
    expect(dividerRect(VIEWPORT, 'stack', SPLIT_EVEN_RATIO)).toEqual({
      left: 0,
      top: TAB_STRIP_HEIGHT + (VIEWPORT.height - TAB_STRIP_HEIGHT - SPLIT_DIVIDER_PX) / 2,
      width: VIEWPORT.width,
      height: SPLIT_DIVIDER_PX,
    })
  })

  it('starts the pane space below the tab strip', () => {
    const side = dividerRect(VIEWPORT, 'side', 0.25)
    const stack = dividerRect(VIEWPORT, 'stack', 0.25)
    expect(side.top).toBe(TAB_STRIP_HEIGHT)
    expect(side.height).toBe(VIEWPORT.height - TAB_STRIP_HEIGHT)
    expect(stack.top).toBeGreaterThanOrEqual(TAB_STRIP_HEIGHT)
  })

  it('moves the leading edge by the share of the space left after the gap', () => {
    expect(dividerRect(VIEWPORT, 'side', 0.25).left).toBe(SIDE_AVAILABLE * 0.25)
    expect(dividerRect(VIEWPORT, 'stack', 0.25).top).toBe(TAB_STRIP_HEIGHT + STACK_AVAILABLE * 0.25)
  })

  it('pins an out-of-range ratio to the edges', () => {
    expect(dividerRect(VIEWPORT, 'side', -1).left).toBe(0)
    expect(dividerRect(VIEWPORT, 'side', 2).left).toBe(SIDE_AVAILABLE)
    expect(dividerRect(VIEWPORT, 'stack', -1).top).toBe(TAB_STRIP_HEIGHT)
    expect(dividerRect(VIEWPORT, 'stack', 2).top).toBe(TAB_STRIP_HEIGHT + STACK_AVAILABLE)
  })

  it('survives a window shorter than the strip', () => {
    const rect = dividerRect({ width: 400, height: 20 }, 'stack', 0.5)
    expect(rect.height).toBe(SPLIT_DIVIDER_PX)
    expect(rect.width).toBe(400)
  })
})

describe('ratioForDividerOffset', () => {
  it('inverts the divider rectangle leading edge', () => {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const side = dividerRect(VIEWPORT, 'side', ratio)
      const stack = dividerRect(VIEWPORT, 'stack', ratio)
      expect(ratioForDividerOffset(side.left, VIEWPORT, 'side')).toBeCloseTo(ratio, 10)
      expect(ratioForDividerOffset(stack.top, VIEWPORT, 'stack')).toBeCloseTo(ratio, 10)
    }
  })

  it('turns a drag position into the same share on both axes', () => {
    expect(ratioForDividerOffset(SIDE_AVAILABLE * 0.3, VIEWPORT, 'side')).toBeCloseTo(0.3, 10)
    expect(
      ratioForDividerOffset(TAB_STRIP_HEIGHT + STACK_AVAILABLE * 0.3, VIEWPORT, 'stack'),
    ).toBeCloseTo(0.3, 10)
  })

  it('falls back to half when the pane space has no length', () => {
    expect(ratioForDividerOffset(10, { width: SPLIT_DIVIDER_PX, height: 200 }, 'side')).toBe(0.5)
    expect(
      ratioForDividerOffset(
        10,
        { width: 200, height: TAB_STRIP_HEIGHT + SPLIT_DIVIDER_PX },
        'stack',
      ),
    ).toBe(0.5)
  })
})

describe('splitAvailablePx', () => {
  it('takes the divider gap out of the pane space', () => {
    expect(splitAvailablePx(VIEWPORT, 'side')).toBe(SIDE_AVAILABLE)
    expect(splitAvailablePx(VIEWPORT, 'stack')).toBe(STACK_AVAILABLE)
  })
})

describe('splitRatioLimits', () => {
  it('keeps both panes at least SPLIT_MIN_PANE_PX long', () => {
    const side = splitRatioLimits(VIEWPORT, 'side')
    expect(side.min).toBe(SPLIT_MIN_PANE_PX / SIDE_AVAILABLE)
    expect(side.max).toBe(1 - side.min)

    const stack = splitRatioLimits(VIEWPORT, 'stack')
    expect(stack.min).toBe(SPLIT_MIN_PANE_PX / STACK_AVAILABLE)
    expect(stack.max).toBe(1 - stack.min)
  })

  it('stops enforcing a minimum when the window cannot fit two of them', () => {
    const tiny = splitRatioLimits({ width: SPLIT_MIN_PANE_PX * 2, height: 400 }, 'side')
    expect(tiny).toEqual({ min: 0, max: 1 })
  })
})

describe('ratioForDragOffset', () => {
  it('passes through a share between both minimums', () => {
    expect(ratioForDragOffset(300, VIEWPORT, 'side')).toBeCloseTo(300 / SIDE_AVAILABLE, 10)
    expect(ratioForDragOffset(TAB_STRIP_HEIGHT + 300, VIEWPORT, 'stack')).toBeCloseTo(
      300 / STACK_AVAILABLE,
      10,
    )
  })

  it('keeps the minimum itself a live share, not a close', () => {
    expect(ratioForDragOffset(SPLIT_MIN_PANE_PX, VIEWPORT, 'side')).toBeCloseTo(
      SPLIT_MIN_PANE_PX / SIDE_AVAILABLE,
      10,
    )
    expect(ratioForDragOffset(TAB_STRIP_HEIGHT + SPLIT_MIN_PANE_PX, VIEWPORT, 'stack')).toBeCloseTo(
      SPLIT_MIN_PANE_PX / STACK_AVAILABLE,
      10,
    )
  })

  it('means "close a" (0) once the first pane would drop under its minimum', () => {
    expect(ratioForDragOffset(SPLIT_MIN_PANE_PX - 1, VIEWPORT, 'side')).toBe(0)
    expect(ratioForDragOffset(-50, VIEWPORT, 'side')).toBe(0)
    expect(ratioForDragOffset(TAB_STRIP_HEIGHT + SPLIT_MIN_PANE_PX - 1, VIEWPORT, 'stack')).toBe(0)
  })

  it('means "close b" (1) once the second pane would drop under its minimum', () => {
    expect(ratioForDragOffset(SIDE_AVAILABLE - SPLIT_MIN_PANE_PX + 1, VIEWPORT, 'side')).toBe(1)
    expect(ratioForDragOffset(10_000, VIEWPORT, 'side')).toBe(1)
    expect(
      ratioForDragOffset(
        TAB_STRIP_HEIGHT + STACK_AVAILABLE - SPLIT_MIN_PANE_PX + 1,
        VIEWPORT,
        'stack',
      ),
    ).toBe(1)
  })

  it('lets the maximum itself stay a live share', () => {
    expect(ratioForDragOffset(SIDE_AVAILABLE - SPLIT_MIN_PANE_PX, VIEWPORT, 'side')).toBeCloseTo(
      1 - SPLIT_MIN_PANE_PX / SIDE_AVAILABLE,
      10,
    )
  })

  it('keeps the share live when the window cannot fit two minimums', () => {
    const tiny = { width: SPLIT_MIN_PANE_PX * 2, height: 400 }
    expect(ratioForDragOffset(0, tiny, 'side')).toBe(0)
    expect(ratioForDragOffset(tiny.width, tiny, 'side')).toBe(1)
    expect(ratioForDragOffset(tiny.width / 2, tiny, 'side')).toBeCloseTo(
      tiny.width / 2 / (tiny.width - SPLIT_DIVIDER_PX),
      10,
    )
  })
})
