import { describe, expect, it } from 'vitest'
import {
  EMPTY_PAGE_SELECTION,
  clickPageSelection,
  formatPageRanges,
  livePages,
  moveBlockOrder,
  pageTargets,
} from '../src/renderer/page-selection'

// visible order differs from original order: page 3 was moved to the front
const vis = [3, 0, 1, 2, 4]

describe('clickPageSelection', () => {
  it('a plain click picks one page and makes it the anchor', () => {
    expect(clickPageSelection(EMPTY_PAGE_SELECTION, vis, 1, 3, {})).toEqual({
      pages: [1],
      anchor: 1,
    })
  })

  it('Shift extends from the anchor in visible order', () => {
    const sel = { pages: [0], anchor: 0 }
    expect(clickPageSelection(sel, vis, 4, 0, { shift: true })).toEqual({
      pages: [0, 1, 2, 4],
      anchor: 0,
    })
    expect(clickPageSelection(sel, vis, 3, 0, { shift: true })).toEqual({
      pages: [3, 0],
      anchor: 0,
    })
  })

  it('Shift without an anchor starts from the current page', () => {
    expect(clickPageSelection(EMPTY_PAGE_SELECTION, vis, 2, 0, { shift: true }).pages).toEqual([
      0, 1, 2,
    ])
  })

  it('Shift falls back to the current page when the anchor was deleted', () => {
    const sel = { pages: [9], anchor: 9 }
    expect(clickPageSelection(sel, vis, 1, 3, { shift: true }).pages).toEqual([3, 0, 1])
  })

  it('Ctrl adds the current page and the clicked one when nothing was picked', () => {
    expect(clickPageSelection(EMPTY_PAGE_SELECTION, vis, 4, 0, { toggle: true })).toEqual({
      pages: [0, 4],
      anchor: 4,
    })
  })

  it('Ctrl removes a picked page but never the last one', () => {
    const sel = { pages: [0, 2], anchor: 0 }
    expect(clickPageSelection(sel, vis, 2, 0, { toggle: true })).toEqual({
      pages: [0],
      anchor: 0,
    })
    expect(
      clickPageSelection({ pages: [0], anchor: 0 }, vis, 0, 0, { toggle: true }).pages,
    ).toEqual([0])
  })

  it('removing the anchor hands it to the nearest picked page', () => {
    const sel = { pages: [0, 1, 4], anchor: 1 }
    expect(clickPageSelection(sel, vis, 1, 3, { toggle: true })).toEqual({
      pages: [0, 4],
      anchor: 0,
    })
  })
})

describe('livePages / pageTargets', () => {
  it('drops deleted pages and keeps visible order', () => {
    expect(livePages([4, 3, 7], vis)).toEqual([3, 4])
  })

  it('an action on a picked page covers the whole selection', () => {
    expect(pageTargets([0, 2], 2)).toEqual([0, 2])
  })

  it('an action outside the selection, or with one page picked, covers that page alone', () => {
    expect(pageTargets([0, 2], 4)).toEqual([4])
    expect(pageTargets([2], 2)).toEqual([2])
  })
})

describe('moveBlockOrder', () => {
  const order = [0, 1, 2, 3, 4, 5]

  it('dragging down lands the block after the target', () => {
    expect(moveBlockOrder(order, [0, 2], 0, 4)).toEqual([1, 3, 4, 0, 2, 5])
  })

  it('dragging up lands the block before the target', () => {
    expect(moveBlockOrder(order, [3, 5], 5, 1)).toEqual([0, 3, 5, 1, 2, 4])
  })

  it('matches the single-page move for a block of one', () => {
    const single = (from: number, to: number) => {
      const next = [...order]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved!)
      return next
    }
    expect(moveBlockOrder(order, [1], 1, 4)).toEqual(single(1, 4))
    expect(moveBlockOrder(order, [4], 4, 0)).toEqual(single(4, 0))
  })

  it('does nothing when dropped on a picked page or when the order stays the same', () => {
    expect(moveBlockOrder(order, [1, 3], 1, 3)).toBeNull()
    expect(moveBlockOrder(order, [1, 2], 1, 3)).toEqual([0, 3, 1, 2, 4, 5])
    expect(moveBlockOrder(order, [0, 1], 1, 0)).toBeNull()
  })
})

describe('formatPageRanges', () => {
  it('joins runs into ranges', () => {
    expect(formatPageRanges([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8')
    expect(formatPageRanges([4])).toBe('4')
    expect(formatPageRanges([])).toBe('')
  })
})
