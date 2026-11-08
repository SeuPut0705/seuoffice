import { describe, expect, it } from 'vitest'

import { oppositeDocumentId, splitSurvivor } from '../src/main/split-layout'

describe('splitSurvivor', () => {
  const split = { aTabId: 'a1', bTabId: 'b1' }

  it('keeps the other pane when a pane tab leaves', () => {
    expect(splitSurvivor(split, 'a1')).toEqual({ keep: 'b', tabId: 'b1' })
    expect(splitSurvivor(split, 'b1')).toEqual({ keep: 'a', tabId: 'a1' })
  })

  it('is null for a tab outside the split', () => {
    expect(splitSurvivor(split, 'x')).toBeNull()
  })
})

describe('oppositeDocumentId (the create rule)', () => {
  const tabs = [
    { id: 'home', kind: 'home' as const, hasView: false },
    { id: 'a', kind: 'docs' as const, hasView: true },
    { id: 'b', kind: 'hwp' as const, hasView: true },
    { id: 'help', kind: 'help' as const, hasView: true },
    { id: 'present', kind: 'html' as const, hasView: true, present: true },
  ]

  it('keeps the visible document when a background tab is dragged', () => {
    expect(
      oppositeDocumentId({ activeId: 'a', previousActiveId: 'home', excludeId: 'b', tabs }),
    ).toBe('a')
  })

  it('falls back to the previously shown document when the visible tab is dragged', () => {
    expect(oppositeDocumentId({ activeId: 'b', previousActiveId: 'a', excludeId: 'b', tabs })).toBe(
      'a',
    )
  })

  it('skips home, help, present tabs and the dragged tab itself', () => {
    expect(
      oppositeDocumentId({ activeId: 'home', previousActiveId: 'help', excludeId: 'x', tabs }),
    ).toBeNull()
    expect(
      oppositeDocumentId({ activeId: 'present', previousActiveId: 'a', excludeId: 'b', tabs }),
    ).toBe('a')
  })

  it('is null when nothing eligible remains (a lone document)', () => {
    expect(
      oppositeDocumentId({ activeId: 'a', previousActiveId: 'home', excludeId: 'a', tabs }),
    ).toBe(null)
  })

  it('never picks the excluded tab even if it matches a candidate', () => {
    expect(
      oppositeDocumentId({ activeId: 'b', previousActiveId: 'b', excludeId: 'b', tabs }),
    ).toBeNull()
  })
})
