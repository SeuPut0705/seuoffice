/**
 * Pure view helpers for the comments pane's page/all-pages modes.
 *
 * The pane itself only displays what the main process reports; grouping the
 * per-slide lists, resolving a click's target page and keying the deck's slide
 * identity are pure (and therefore tested without JSDOM). Hidden slides need no
 * special case here: their comments arrive in the same per-slide array, and the
 * deck order is the array order.
 */
import type { SlideComment } from '../shared/ipc'

/** Which slice of the deck the comments pane shows. */
export type CommentsMode = 'page' | 'all'

/**
 * Identity sequence of the deck's slides. Changes on add/delete/reorder (the
 * part path follows the slide), not on content edits — so comment reads can
 * key off it without re-reading on every keystroke.
 */
export function deckStructureKey(slides: readonly { partPath?: string }[]): string {
  return slides.map((s) => s.partPath ?? '').join('\n')
}

/** One page's comments in the all-pages list. */
export interface CommentSlideGroup {
  slideIndex: number
  comments: SlideComment[]
}

/**
 * Deck-order groups that actually carry comments. `all` is indexed like the
 * deck (one array per slide, empty included), so the page number comes from
 * the outer index even when earlier pages have no comments.
 */
export function groupCommentsBySlide(all: SlideComment[][]): CommentSlideGroup[] {
  const groups: CommentSlideGroup[] = []
  for (const [slideIndex, comments] of (Array.isArray(all) ? all : []).entries()) {
    if (!Array.isArray(comments) || comments.length === 0) continue
    groups.push({ slideIndex, comments })
  }
  return groups
}

/**
 * Page the deck should move to when a group header or card is clicked.
 * Returns null for a stale target (the page was removed or the index is not a
 * real page), so the caller keeps the current page instead of jumping
 * somewhere unrelated.
 */
export function commentNavigationTarget(slideIndex: number, slideCount: number): number | null {
  if (!Number.isInteger(slideIndex)) return null
  if (slideIndex < 0 || slideIndex >= slideCount) return null
  return slideIndex
}
