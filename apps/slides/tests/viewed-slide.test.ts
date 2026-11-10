import { describe, expect, it } from 'vitest'
import type { SetStateAction } from 'react'
import { applyDeckChange, currentAfterDeckChange } from '../src/shared/viewed-slide'
import { currentAfterHistory } from '../src/shared/slide-selection'

type Part = { partPath: string }
const deck = (...names: string[]): Part[] =>
  names.map((name) => ({ partPath: `ppt/slides/${name}.xml` }))
const names = (slides: readonly Part[]): string[] =>
  slides.map((slide) => slide.partPath.slice('ppt/slides/'.length, -'.xml'.length))

/**
 * React's state as a handler outside a React event meets it: a set value is on screen only
 * after the next render, and until then every updater waits in its hook's queue. A render
 * runs the queues in the order the hooks are declared (`slides` before `current` in App.tsx).
 * With `eager`, the first updater set since the last render runs at once, as React does while
 * the component has nothing pending; once one changed a value, the rest wait for the render.
 */
interface FakeWindow {
  setSlides(next: SetStateAction<Part[]>): void
  setCurrent(next: SetStateAction<number>): void
  render(): { slides: string[]; current: number; viewed: string | undefined }
}

function window_(slides: Part[], current: number, eager = false): FakeWindow {
  const state = { slides, current }
  const queues = { slides: [] as SetStateAction<Part[]>[], current: [] as SetStateAction<number>[] }
  let pending = false
  const run = <K extends 'slides' | 'current'>(key: K): void => {
    for (const next of queues[key] as SetStateAction<(typeof state)[K]>[]) {
      state[key] =
        typeof next === 'function'
          ? (next as (previous: (typeof state)[K]) => (typeof state)[K])(state[key])
          : next
    }
    queues[key].length = 0
  }
  const setter =
    <K extends 'slides' | 'current'>(key: K) =>
    (next: SetStateAction<(typeof state)[K]>): void => {
      ;(queues[key] as SetStateAction<(typeof state)[K]>[]).push(next)
      if (!eager || pending) return
      const before = state[key]
      run(key)
      pending = !Object.is(before, state[key])
    }
  return {
    setSlides: setter('slides'),
    setCurrent: setter('current'),
    render() {
      run('slides')
      run('current')
      pending = false
      return {
        slides: names(state.slides),
        current: state.current,
        viewed: names(state.slides)[state.current],
      }
    },
  }
}

/** The main process echoes this window's own edit: the same deck again, whole or as an order */
const echo = (w: FakeWindow, slides: Part[], replaced: string[] = []): void =>
  applyDeckChange(w.setSlides, w.setCurrent, () => slides, slides, replaced)

describe.each([false, true])(
  'a deck change before React rendered the last one (eager %s)',
  (eager) => {
    it('a slide this window added stays on screen when the broadcast of it arrives', () => {
      const w = window_(deck('a', 'b', 'c'), 0, eager)
      w.render()
      // slide-actions.ts addSlide: the reply puts the new slide after the viewed one and views it
      const added = deck('a', 'new', 'b', 'c')
      w.setSlides(() => added)
      w.setCurrent(1)
      // a second window is attached: the same change comes back before anything rendered
      echo(w, deck('a', 'new', 'b', 'c'))
      expect(w.render()).toMatchObject({ viewed: 'new', current: 1 })
    })

    it('a slide added at the end is viewed, not the one before it', () => {
      const w = window_(deck('a', 'b'), 1, eager)
      w.render()
      w.setSlides(() => deck('a', 'b', 'new'))
      w.setCurrent(2)
      echo(w, deck('a', 'b', 'new'))
      expect(w.render()).toMatchObject({ viewed: 'new', current: 2 })
    })

    it('the copies of duplicated slides are viewed, not their source', () => {
      const w = window_(deck('a', 'b', 'c'), 1, eager)
      w.render()
      w.setSlides(() => deck('a', 'b', 'copy', 'c'))
      w.setCurrent(2)
      echo(w, deck('a', 'b', 'copy', 'c'))
      expect(w.render()).toMatchObject({ viewed: 'copy', current: 2 })
    })

    it('undo that takes the viewed slide away leaves the view where undo put it', () => {
      const w = window_(deck('a', 'new', 'b'), 1, eager)
      w.render()
      const undone = deck('a', 'b')
      w.setSlides(undone)
      w.setCurrent(currentAfterHistory(undone, 1, 'ppt/slides/new.xml'))
      echo(w, deck('a', 'b'))
      expect(w.render()).toMatchObject({ viewed: 'b', current: 1 })
    })

    it('a deck opened in place of another starts on its first slide, whatever its parts are called', () => {
      // the deck that was open: the fourth slide on screen
      const w = window_(deck('slide1', 'slide2', 'slide3', 'slide4'), 3, eager)
      w.render()
      // applyOpen for a recovered copy, whose parts have the same names
      const opened = deck('slide1', 'slide2', 'slide3', 'slide4', 'slide5')
      w.setSlides(opened)
      w.setCurrent(0)
      // the main process sends the opened deck again right after (it marks the copy unsaved)
      echo(w, deck('slide1', 'slide2', 'slide3', 'slide4', 'slide5'))
      expect(w.render()).toMatchObject({ viewed: 'slide1', current: 0 })
    })

    it('two changes before one render each move the view by their own step', () => {
      const w = window_(deck('a', 'b', 'c'), 2, eager)
      w.render()
      echo(w, deck('x', 'a', 'b', 'c'))
      echo(w, deck('x', 'y', 'a', 'b', 'c'))
      expect(w.render()).toMatchObject({ viewed: 'c', current: 4 })
    })

    it('an update that cannot be merged still keeps the view inside the deck it names', () => {
      const w = window_(deck('a', 'b', 'c'), 2, eager)
      w.render()
      // the order names a slide this window never got: the slides stay until the refetch
      applyDeckChange(w.setSlides, w.setCurrent, (slides) => slides, deck('a', 'unseen'))
      expect(w.render()).toMatchObject({ slides: ['a', 'b', 'c'], current: 1 })
    })

    it('another window’s slide before the viewed one moves the view with its slide', () => {
      const w = window_(deck('a', 'b', 'c'), 1, eager)
      w.render()
      echo(w, deck('x', 'a', 'b', 'c'))
      expect(w.render()).toMatchObject({ viewed: 'b', current: 2 })
    })
  },
)

describe('currentAfterDeckChange', () => {
  const at = (previous: string[], index: number, next: string[], replaced: string[] = []) =>
    currentAfterDeckChange(
      deck(...previous),
      index,
      deck(...next),
      replaced.map((name) => `ppt/slides/${name}.xml`),
    )

  it('follows the viewed slide to where it now is', () => {
    expect(at(['a', 'b', 'c'], 1, ['x', 'a', 'b', 'c'])).toBe(2)
    expect(at(['a', 'b', 'c'], 2, ['c', 'a', 'b'])).toBe(0)
    expect(at(['a', 'b', 'c'], 1, ['a', 'b', 'c'])).toBe(1)
  })

  it('keeps the position, within the deck, when the viewed slide is gone', () => {
    expect(at(['a', 'b', 'c'], 1, ['a', 'c'])).toBe(1)
    expect(at(['a', 'b', 'c'], 2, ['a', 'b'])).toBe(1)
    expect(at(['a'], 0, [])).toBe(0)
  })

  it('keeps the position when the part holds another slide than the one viewed', () => {
    // b was deleted and a new slide got its part name, further down
    expect(at(['a', 'b', 'c'], 1, ['a', 'c', 'b'], ['b'])).toBe(1)
  })

  it('keeps the position in a deck that shares no part with the one before', () => {
    expect(at(['a', 'b', 'c'], 2, ['p', 'q', 'r', 's'])).toBe(2)
    expect(at(['a', 'b', 'c'], 2, ['p'])).toBe(0)
  })

  it('keeps the position when nothing was viewed', () => {
    expect(at([], 0, ['a', 'b'])).toBe(0)
  })
})
