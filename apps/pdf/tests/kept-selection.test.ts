// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AnnotSelection, EditSnapshot } from '../src/renderer/edit-state'
import { keptMarkupMenu, keptSelection } from '../src/renderer/kept-selection'
import { emptySnapshot } from '../src/web/collab-model'

const withItems = (bucket: 'markups' | 'drawings', ids: string[]): EditSnapshot => ({
  ...emptySnapshot(),
  [bucket]: ids.map((id) => ({ id })),
})

describe('a selection through a change from outside', () => {
  const drawing: AnnotSelection = { kind: 'drawing', id: 'd1', x: 10, y: 20 }

  it('stays, the same object, while its item is still pending', () => {
    expect(keptSelection(drawing, withItems('drawings', ['d0', 'd1']))).toBe(drawing)
  })

  it('goes when its item is gone, also when another list holds that id', () => {
    expect(keptSelection(drawing, withItems('drawings', ['d0']))).toBeNull()
    expect(keptSelection(drawing, withItems('markups', ['d1']))).toBeNull()
  })

  it('stays on what the opened file holds, and on stamps only while they are set', () => {
    const page = { kind: 'pageImage', x: 0, y: 0 } as AnnotSelection
    expect(keptSelection(page, emptySnapshot())).toBe(page)
    const stamp: AnnotSelection = { kind: 'stamp', x: 0, y: 0 }
    expect(keptSelection(stamp, emptySnapshot())).toBeNull()
    expect(keptSelection(null, emptySnapshot())).toBeNull()
  })

  it('keeps a markup menu while its markup is pending', () => {
    const menu = { kind: 'pending' as const, id: 'm1' }
    expect(keptMarkupMenu(menu, withItems('markups', ['m1']))).toBe(menu)
    expect(keptMarkupMenu(menu, emptySnapshot())).toBeNull()
    const saved = { kind: 'saved' as const }
    expect(keptMarkupMenu<typeof menu | typeof saved>(saved, emptySnapshot())).toBe(saved)
  })
})
