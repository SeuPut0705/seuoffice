import { describe, expect, it } from 'vitest'
import { reconcileSheet } from '../src/reconcile'
import type { XmindSheet } from '../src/types'
import type { ViewSheet } from '../src/view'
import { sampleSheets } from './helpers'
import {
  copyOf,
  detach,
  differences,
  freshTopic,
  inSource,
  inView,
  openSheets,
} from './reconcile-helpers'

/**
 * Summaries and boundaries say which branches they cover by position. These
 * tests move, add and delete branches and look at the positions written back.
 */

/** A topic `p` with five branches `k0`..`k4`, a boundary and a summary over some of them. */
function ranged(boundary: string, summary: string, more: object = {}): unknown[] {
  return [
    {
      id: 's',
      rootTopic: {
        id: 'r',
        children: {
          attached: [
            {
              id: 'p',
              children: {
                attached: [0, 1, 2, 3, 4].map((n) => ({ id: `k${n}`, title: `K${n}` })),
                summary: [
                  {
                    id: 'st',
                    title: 'Summary',
                    children: { attached: [{ id: 'below-summary', title: 'kept only' }] },
                  },
                ],
              },
              boundaries: [{ id: 'bd', range: boundary, title: 'Boundary', futureKey: 1 }],
              summaries: [{ id: 'sm', range: summary, topicId: 'st', futureKey: 2 }],
              ...more,
            },
            { id: 'q' },
          ],
        },
      },
    },
  ]
}

async function edit(content: unknown[], change: (view: ViewSheet) => void) {
  const document = await openSheets(content)
  const before = copyOf(document.sheets[0]!)
  const view = document.viewSheets()[0]!
  change(view)
  const result = reconcileSheet(document, 0, view)
  if (!result.ok) throw new Error(`expected the state to be applied, got: ${result.problem}`)
  const p = inSource(document.sheets[0]!, 'p')
  return { result, before, sheet: document.sheets[0]!, p }
}

/** Puts the branches of `p` into this order, by id; an id it does not know is a new topic. */
function order(view: ViewSheet, ids: string[]): void {
  const p = inView(view, 'p')
  const known = new Map(p.children.map((child) => [child.id, child]))
  p.children = ids.map((id) => known.get(id) ?? freshTopic(id, 'new'))
}

describe('ranges: a covered branch is deleted', () => {
  it('rewrites the range with the positions the remaining branches now have', async () => {
    const { p, before } = await edit(ranged('(2,3)', '(1,2)'), (view) => detach(view, 'k0'))
    expect(p!.boundaries).toEqual([{ id: 'bd', range: '(1,2)', title: 'Boundary', futureKey: 1 }])
    expect(p!.summaries).toEqual([{ id: 'sm', range: '(0,1)', topicId: 'st', futureKey: 2 }])
    expect(p!.children!.summary).toEqual(inSource(before, 'p')!.children!.summary)
  })

  it('shortens the range when one of the covered branches goes', async () => {
    const first = await edit(ranged('(1,3)', '(1,3)'), (view) => detach(view, 'k1'))
    expect(first.p).toMatchObject({
      boundaries: [{ range: '(1,2)' }],
      summaries: [{ range: '(1,2)' }],
    })
    const middle = await edit(ranged('(1,3)', '(1,3)'), (view) => detach(view, 'k2'))
    expect(middle.p).toMatchObject({
      boundaries: [{ range: '(1,2)' }],
      summaries: [{ range: '(1,2)' }],
    })
    const last = await edit(ranged('(1,3)', '(1,3)'), (view) => detach(view, 'k3'))
    expect(last.p).toMatchObject({
      boundaries: [{ range: '(1,2)' }],
      summaries: [{ range: '(1,2)' }],
    })
  })

  it('tells the caller when the state it handed in still had the old positions', async () => {
    const stale = await edit(ranged('(2,3)', '(1,2)'), (view) => detach(view, 'k0'))
    expect(stale.result.inSync).toBe(false)
    expect(inView(stale.result.view, 'p').summaries).toMatchObject([{ start: 0, end: 1 }])
    const renumbered = await edit(ranged('(2,3)', '(1,2)'), (view) => {
      detach(view, 'k0')
      Object.assign(inView(view, 'p').summaries[0]!, { start: 0, end: 1 })
    })
    expect(renumbered.result.inSync).toBe(true)
    expect(renumbered.p).toMatchObject({ summaries: [{ range: '(0,1)' }] })
  })
})

describe('ranges: every covered branch is deleted', () => {
  it('removes the summary: its record, its summary topic and what hangs under that', async () => {
    const { p, sheet, result } = await edit(ranged('(0,4)', '(1,2)'), (view) =>
      order(view, ['k0', 'k3', 'k4']),
    )
    expect(p).not.toHaveProperty('summaries')
    expect(p!.children).toEqual({
      attached: [
        { id: 'k0', title: 'K0' },
        { id: 'k3', title: 'K3' },
        { id: 'k4', title: 'K4' },
      ],
    })
    expect(inSource(sheet, 'st')).toBeNull()
    expect(inSource(sheet, 'below-summary')).toBeNull()
    expect(p!.boundaries).toMatchObject([{ id: 'bd', range: '(0,2)' }])
    expect(inView(result.view, 'p').summaries).toEqual([])
    expect(result.inSync).toBe(false)
  })

  it('removes the boundary', async () => {
    const { p } = await edit(ranged('(3,4)', '(0,1)'), (view) => order(view, ['k0', 'k1', 'k2']))
    expect(p).not.toHaveProperty('boundaries')
    expect(p!.summaries).toEqual([{ id: 'sm', range: '(0,1)', topicId: 'st', futureKey: 2 }])
  })

  it('removes both, and the lists that held them, when the topic loses all its branches', async () => {
    const { p } = await edit(ranged('(3,4)', '(0,1)'), (view) => order(view, []))
    expect(p).toEqual({ id: 'p' })
  })

  it('keeps the other records of the topic', async () => {
    const more = {
      boundaries: [
        { id: 'gone', range: '(0,0)' },
        { id: 'stays', range: '(0,1)' },
        { id: 'unread', range: 'master' },
        'text',
      ],
    }
    const { p } = await edit(ranged('', '(1,2)', more), (view) => detach(view, 'k0'))
    expect(p!.boundaries).toEqual([
      { id: 'stays', range: '(0,0)' },
      { id: 'unread', range: 'master' },
      'text',
    ])
  })
})

describe('ranges: the covered branches come apart', () => {
  it('shrinks a boundary to the run that holds its first branch', async () => {
    const moved = await edit(ranged('(1,3)', '(0,0)'), (view) =>
      order(view, ['k0', 'k1', 'k3', 'k4', 'k2']),
    )
    expect(moved.p!.boundaries).toMatchObject([{ id: 'bd', range: '(1,2)' }])
    const split = await edit(ranged('(1,3)', '(0,0)'), (view) =>
      order(view, ['k0', 'k1', 'new-between', 'k2', 'k3', 'k4']),
    )
    expect(split.p!.boundaries).toMatchObject([{ id: 'bd', range: '(1,1)' }])
    const firstAway = await edit(ranged('(1,3)', '(0,0)'), (view) =>
      order(view, ['k2', 'k3', 'k0', 'k1', 'k4']),
    )
    expect(firstAway.p!.boundaries).toMatchObject([{ id: 'bd', range: '(3,3)' }])
  })

  it('follows the covered branches when they move together, in any order', async () => {
    const together = await edit(ranged('(1,3)', '(1,3)'), (view) =>
      order(view, ['k4', 'k0', 'k3', 'k1', 'k2']),
    )
    expect(together.p).toMatchObject({
      boundaries: [{ range: '(2,4)' }],
      summaries: [{ range: '(2,4)' }],
    })
  })

  it('does the same for a summary whose positions the state did not change', async () => {
    const { p } = await edit(ranged('(0,0)', '(1,3)'), (view) =>
      order(view, ['k1', 'k0', 'k2', 'k3', 'k4']),
    )
    expect(p!.summaries).toMatchObject([{ id: 'sm', range: '(0,0)' }])
  })

  it('shortens the range a later branch moved out of, and follows a first branch that moved', async () => {
    const { p, sheet, before } = await edit(ranged('(1,2)', '(2,3)'), (view) => {
      inView(view, 'q').children.push(detach(view, 'k2'))
    })
    // the boundary began at k1, which stayed; the summary began at k2, which moved
    expect(p!.boundaries).toMatchObject([{ id: 'bd', range: '(1,1)' }])
    expect(p).not.toHaveProperty('summaries')
    expect(inSource(sheet, 'q')).toEqual({
      id: 'q',
      children: {
        attached: [{ id: 'k2', title: 'K2' }],
        summary: inSource(before, 'p')!.children!.summary,
      },
      summaries: [{ id: 'sm', range: '(0,0)', topicId: 'st', futureKey: 2 }],
    })
  })

  it('moves the ranges along with the topic that carries them', async () => {
    const { sheet, before } = await edit(ranged('(1,2)', '(2,3)'), (view) => {
      inView(view, 'q').children.push(detach(view, 'p'))
    })
    expect(JSON.stringify(inSource(sheet, 'p'))).toBe(JSON.stringify(inSource(before, 'p')))
  })
})

describe('ranges: what the state says about a summary', () => {
  it('writes the positions of a summary the state moved', async () => {
    const { p, result } = await edit(ranged('(0,0)', '(1,2)'), (view) => {
      Object.assign(inView(view, 'p').summaries[0]!, { start: 3, end: 4 })
    })
    expect(p!.summaries).toEqual([{ id: 'sm', range: '(3,4)', topicId: 'st', futureKey: 2 }])
    expect(result.inSync).toBe(true)
  })

  it('takes the positions the state gives over the ones it would have worked out', async () => {
    const { p } = await edit(ranged('(0,0)', '(1,2)'), (view) => {
      order(view, ['k0', 'k1', 'new-between', 'k2', 'k3', 'k4'])
      Object.assign(inView(view, 'p').summaries[0]!, { start: 1, end: 3 })
    })
    expect(p!.summaries).toMatchObject([{ range: '(1,3)' }])
  })
})

describe('ranges: nothing to rewrite', () => {
  it('leaves every range as written while the branches of its topic stay as they are', async () => {
    const content = ranged('( 1 , 3 )', '(1,2)', {
      boundaries: [
        { id: 'spaced', range: '( 1 , 3 )' },
        { id: 'past-end', range: '(2,9)' },
        { id: 'unread', range: 'master' },
      ],
    })
    const { before, sheet } = await edit(content, (view) => {
      inView(view, 'k2').title = 'Renamed'
      inView(view, 'k2').children.push(freshTopic('me-new', 'below k2'))
      view.root.children.reverse()
    })
    expect(JSON.stringify(inSource(sheet, 'p')!.boundaries)).toBe(
      JSON.stringify(inSource(before, 'p')!.boundaries),
    )
    expect(inSource(sheet, 'p')!.summaries).toEqual(inSource(before, 'p')!.summaries)
  })

  it('leaves a range it cannot read, or one that reaches past the branches, as written', async () => {
    const content = ranged('', '(1,2)', {
      boundaries: [
        { id: 'past-end', range: '(2,9)' },
        { id: 'unread', range: 'master' },
        { id: 'read', range: '( 2 , 3 )' },
      ],
    })
    const { p } = await edit(content, (view) => detach(view, 'k0'))
    expect(p!.boundaries).toEqual([
      { id: 'past-end', range: '(2,9)' },
      { id: 'unread', range: 'master' },
      { id: 'read', range: '(1,2)' },
    ])
  })

  it('does not rewrite a range whose positions come out the same', async () => {
    const content = ranged('( 0 , 1 )', '(0,1)')
    const { before, sheet } = await edit(content, (view) => detach(view, 'k4'))
    expect(differences(before, sheet)).toEqual([
      '$.rootTopic.children.attached[0].children.attached[4]',
    ])
  })
})

describe('ranges: the sample map', () => {
  it('rewrites the boundary and the summary of a topic that lost its first branch', async () => {
    const document = await openSheets(sampleSheets())
    const view = document.viewSheets()[0]!
    detach(view, 'a1')
    view.relationships = []
    const result = reconcileSheet(document, 0, view)
    expect(result.ok).toBe(true)
    const alpha = inSource(document.sheets[0] as XmindSheet, 'a')!
    expect(alpha.boundaries).toEqual([{ id: 'bound-1', range: '(0,0)', title: 'Group' }])
    expect(alpha.summaries).toEqual([{ id: 'sum-rec', range: '(0,1)', topicId: 'sum-topic' }])
  })
})
