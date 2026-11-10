import type { Dispatch, SetStateAction } from 'react'

type Part = { partPath?: string }

/**
 * Where the view is once the deck changed under it (another window's edit, another person's
 * on the web): on the slide it was on, found by its part, wherever that slide now is. `index`
 * is the viewed position in `previous`. The position itself decides only when that slide is
 * gone, or when its part now holds another slide (`replaced`): it is kept, within the new deck.
 */
export function currentAfterDeckChange(
  previous: readonly Part[],
  index: number,
  next: readonly Part[],
  replaced: readonly string[] = [],
): number {
  const viewed = previous[index]?.partPath
  const kept =
    viewed !== undefined && !replaced.includes(viewed)
      ? next.findIndex((slide) => slide.partPath === viewed)
      : -1
  return kept >= 0 ? kept : Math.min(index, Math.max(0, next.length - 1))
}

/**
 * Change the deck under the view: `change` makes the new slides, `order` is the deck after the
 * change (which `change` may fail to make from a partial update, leaving a refetch to do), and
 * the viewed index follows its slide (`currentAfterDeckChange`).
 *
 * The slide being viewed is read inside the state updaters, from the slides and the index
 * React holds pending. What the last render saw is not enough: the reply to this window's own
 * edit (a new slide, now viewed) and the broadcast of that same edit can both arrive before
 * React renders, and the last render still names the slide viewed before the edit.
 *
 * React runs the slides updater before the index updater: at the call when nothing is queued,
 * otherwise at the next render, where the `slides` state must be declared before `current`.
 */
export function applyDeckChange<S extends Part>(
  setSlides: Dispatch<SetStateAction<S[]>>,
  setCurrent: Dispatch<SetStateAction<number>>,
  change: (slides: S[]) => S[],
  order: readonly Part[],
  replaced: readonly string[] = [],
): void {
  // this change's own: several changes can be queued before one render
  let previous: readonly Part[] | null = null
  setSlides((slides) => {
    previous = slides
    return change(slides)
  })
  setCurrent((index) =>
    previous ? currentAfterDeckChange(previous, index, order, replaced) : index,
  )
}
