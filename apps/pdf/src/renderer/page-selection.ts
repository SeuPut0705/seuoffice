/**
 * Multi-page selection in the thumbnail sidebar: click / Shift-click /
 * Ctrl-click, which pages a page action applies to, and the order a
 * dragged block of pages lands in. Pages are original indices so the
 * selection survives a reorder; visible order comes from visList.
 */

export interface PageSelection {
  /** Original page indices in visible order; empty = nothing picked yet */
  pages: number[]
  /** Start of Shift ranges (original index) */
  anchor: number | null
}

export const EMPTY_PAGE_SELECTION: PageSelection = { pages: [], anchor: null }

/** Selected pages that are still visible, in visible order */
export function livePages(pages: readonly number[], visList: readonly number[]): number[] {
  const set = new Set(pages)
  return visList.filter((p) => set.has(p))
}

/**
 * Thumbnail click. Plain click picks one page; Shift extends from the anchor
 * (or the current page); Ctrl/Cmd toggles one page, never emptying the set.
 */
export function clickPageSelection(
  sel: PageSelection,
  visList: readonly number[],
  page: number,
  current: number,
  mods: { shift?: boolean; toggle?: boolean },
): PageSelection {
  if (mods.shift) {
    const anchor = sel.anchor !== null && visList.includes(sel.anchor) ? sel.anchor : current
    const a = visList.indexOf(anchor)
    const b = visList.indexOf(page)
    if (a < 0 || b < 0) return { pages: [page], anchor: page }
    return { pages: visList.slice(Math.min(a, b), Math.max(a, b) + 1), anchor }
  }
  if (mods.toggle) {
    const live = livePages(sel.pages, visList)
    const base = live.length ? live : visList.includes(current) ? [current] : []
    if (!base.includes(page)) return { pages: livePages([...base, page], visList), anchor: page }
    if (base.length === 1) return { pages: base, anchor: page }
    const pages = base.filter((p) => p !== page)
    if (sel.anchor !== page) return { pages, anchor: sel.anchor }
    const at = visList.indexOf(page)
    const anchor = pages.reduce((best, p) =>
      Math.abs(visList.indexOf(p) - at) < Math.abs(visList.indexOf(best) - at) ? p : best,
    )
    return { pages, anchor }
  }
  return { pages: [page], anchor: page }
}

/** A page action on `page` covers the whole selection when the page is part of a multi-selection */
export function pageTargets(live: readonly number[], page: number): number[] {
  return live.length > 1 && live.includes(page) ? [...live] : [page]
}

/**
 * Visible order after dropping `block` on the thumbnail at visible position
 * `to`. Same landing rule as a single-page move: dragging down lands after
 * the target, dragging up lands before it. Null when nothing would change.
 */
export function moveBlockOrder(
  visList: readonly number[],
  block: readonly number[],
  grabbed: number,
  to: number,
): number[] | null {
  const target = visList[to]
  const from = visList.indexOf(grabbed)
  if (target === undefined || from < 0 || block.includes(target)) return null
  const moving = livePages(block, visList)
  const rest = visList.filter((p) => !moving.includes(p))
  const at = rest.indexOf(target) + (to > from ? 1 : 0)
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
  return next.every((p, i) => p === visList[i]) ? null : next
}

/** 1-based page numbers (ascending) → "1-3,5" */
export function formatPageRanges(nums: readonly number[]): string {
  const parts: string[] = []
  for (let i = 0; i < nums.length;) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`)
    i = j + 1
  }
  return parts.join(',')
}
