import { describe, expect, it } from 'vitest'
import { countPreservedElements } from '../src/preserved'
import { reconcileSheet } from '../src/reconcile'
import type { ViewSheet } from '../src/view'
import { copyOf, detach, inSource, inView, openSheets } from './reconcile-helpers'

/**
 * A summary or boundary whose covered branches leave their topic without being
 * deleted goes with them: nothing the view does not show may disappear because
 * the user dragged a branch.
 */

const BOUNDARY = {
  id: 'b1',
  range: '(1,2)',
  title: 'B1',
  style: { id: 'b1-style', properties: { 'svg:fill': '#eeeeee' } },
  futureKey: true,
}
const SUMMARY_TOPIC = {
  id: 's1',
  title: 'S1',
  children: { attached: [{ id: 'u1', title: 'kept only' }, { id: 'u2' }] },
}
const RELATIONSHIP = {
  id: 'rel',
  end1Id: 's1',
  end2Id: 'q',
  controlPoints: { '0': { x: 1, y: 2 } },
}

/**
 * `p` has branches `k0`..`k4`; a boundary and a summary both cover `k1` and
 * `k2`. Two branches hang under the summary topic and a relationship ends on
 * it. `m` has no branches, `n` has one.
 */
function covered(more: { p?: object; m?: object } = {}): unknown[] {
  return [
    {
      id: 's',
      rootTopic: {
        id: 'r',
        children: {
          attached: [
            {
              id: 'p',
              title: 'P',
              children: {
                attached: [0, 1, 2, 3, 4].map((n) => ({ id: `k${n}`, title: `K${n}` })),
                summary: [SUMMARY_TOPIC],
              },
              boundaries: [BOUNDARY],
              summaries: [{ id: 'r1', range: '(1,2)', topicId: 's1', futureKey: 1 }],
              ...more.p,
            },
            { id: 'm', title: 'M', ...more.m },
            { id: 'n', title: 'N', children: { attached: [{ id: 'n0' }] } },
            { id: 'q', title: 'Q' },
          ],
        },
      },
      relationships: [RELATIONSHIP],
    },
  ]
}

async function edit(content: unknown[], ...changes: ((view: ViewSheet) => void)[]) {
  const document = await openSheets(content)
  const before = copyOf(document.sheets[0]!)
  let view = document.viewSheets()[0]!
  let inSync = true
  for (const change of changes) {
    change(view)
    const result = reconcileSheet(document, 0, view)
    if (!result.ok) throw new Error(`expected the state to be applied, got: ${result.problem}`)
    inSync = result.inSync
    view = result.view
  }
  const sheet = document.sheets[0]!
  const topic = (id: string) => inSource(sheet, id)!
  return { document, before, sheet, view, inSync, topic }
}

const branchIds = (topic: { children?: { attached?: { id: string }[] } }): string[] =>
  (topic.children?.attached ?? []).map((branch) => branch.id)

describe('ranges: the covered branches move to another topic', () => {
  it('moves the boundary and the summary with them, and removes nothing', async () => {
    const { before, sheet, topic, view, inSync } = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'), detach(state, 'k2'))
    })
    expect(topic('m')).toEqual({
      id: 'm',
      title: 'M',
      children: {
        attached: [
          { id: 'k1', title: 'K1' },
          { id: 'k2', title: 'K2' },
        ],
        summary: [SUMMARY_TOPIC],
      },
      boundaries: [{ ...BOUNDARY, range: '(0,1)' }],
      summaries: [{ id: 'r1', range: '(0,1)', topicId: 's1', futureKey: 1 }],
    })
    expect(topic('p')).toEqual({
      id: 'p',
      title: 'P',
      children: {
        attached: [
          { id: 'k0', title: 'K0' },
          { id: 'k3', title: 'K3' },
          { id: 'k4', title: 'K4' },
        ],
      },
    })
    expect(sheet.relationships).toEqual([RELATIONSHIP])
    expect(countPreservedElements(sheet)).toBe(countPreservedElements(before))
    expect(countPreservedElements(before)).toBe(3)
    // the state still showed the summary on the topic it came from
    expect(inSync).toBe(false)
    expect(inView(view, 'p').summaries).toEqual([])
    expect(inView(view, 'm').summaries).toEqual([
      { id: 'r1', topicId: 's1', title: 'S1', start: 0, end: 1 },
    ])
    expect(view.relationships).toEqual([{ id: 'rel', fromId: 's1', toId: 'q', title: '' }])
  })

  it('gives the same tree, in sync, when the state itself shows the summary on the new topic', async () => {
    const stale = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'), detach(state, 'k2'))
    })
    const moved = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'), detach(state, 'k2'))
      const [summary] = inView(state, 'p').summaries.splice(0, 1)
      inView(state, 'm').summaries.push({ ...summary!, start: 0, end: 1 })
    })
    expect(moved.inSync).toBe(true)
    expect(moved.sheet).toEqual(stale.sheet)
  })

  it('keeps the positions among the branches the new topic already has', async () => {
    const { topic } = await edit(covered(), (state) => {
      inView(state, 'n').children.push(detach(state, 'k2'), detach(state, 'k1'))
    })
    expect(branchIds(topic('n'))).toEqual(['n0', 'k2', 'k1'])
    expect(topic('n').boundaries).toEqual([{ ...BOUNDARY, range: '(1,2)' }])
    expect(topic('n').summaries).toEqual([
      { id: 'r1', range: '(1,2)', topicId: 's1', futureKey: 1 },
    ])
    expect(topic('n').children!.summary).toEqual([SUMMARY_TOPIC])
    expect(topic('p')).not.toHaveProperty('boundaries')
  })

  it('follows the first covered branch when that one moves away and the others stay', async () => {
    const { before, sheet, topic } = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'))
    })
    expect(topic('m').boundaries).toEqual([{ ...BOUNDARY, range: '(0,0)' }])
    expect(topic('m').summaries).toEqual([
      { id: 'r1', range: '(0,0)', topicId: 's1', futureKey: 1 },
    ])
    expect(topic('m').children!.summary).toEqual([SUMMARY_TOPIC])
    expect(topic('p')).not.toHaveProperty('boundaries')
    expect(topic('p')).not.toHaveProperty('summaries')
    expect(Object.keys(topic('p').children!)).toEqual(['attached'])
    expect(sheet.relationships).toEqual([RELATIONSHIP])
    expect(countPreservedElements(sheet)).toBe(countPreservedElements(before))
  })

  it('stays, shortened, when a later covered branch moves away', async () => {
    const { topic } = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k2'))
    })
    expect(topic('p').boundaries).toEqual([{ ...BOUNDARY, range: '(1,1)' }])
    expect(topic('p').summaries).toEqual([
      { id: 'r1', range: '(1,1)', topicId: 's1', futureKey: 1 },
    ])
    expect(topic('m')).toEqual({
      id: 'm',
      title: 'M',
      children: { attached: [{ id: 'k2', title: 'K2' }] },
    })
  })

  it('follows the first one when the covered branches scatter to two topics', async () => {
    const { before, sheet, topic } = await edit(covered(), (state) => {
      inView(state, 'n').children.push(detach(state, 'k2'))
      inView(state, 'm').children.push(detach(state, 'k1'))
    })
    expect(topic('m').boundaries).toEqual([{ ...BOUNDARY, range: '(0,0)' }])
    expect(topic('m').summaries).toEqual([
      { id: 'r1', range: '(0,0)', topicId: 's1', futureKey: 1 },
    ])
    expect(topic('m').children!.summary).toEqual([SUMMARY_TOPIC])
    expect(topic('n')).toEqual({
      id: 'n',
      title: 'N',
      children: { attached: [{ id: 'n0' }, { id: 'k2', title: 'K2' }] },
    })
    expect(topic('p')).not.toHaveProperty('boundaries')
    expect(topic('p')).not.toHaveProperty('summaries')
    expect(countPreservedElements(sheet)).toBe(countPreservedElements(before))
  })

  it('comes back with a covered branch that moved away and returned', async () => {
    const { before, sheet, topic } = await edit(
      covered(),
      (state) => {
        inView(state, 'm').children.push(detach(state, 'k1'))
      },
      (state) => {
        inView(state, 'p').children.splice(1, 0, detach(state, 'k1'))
      },
    )
    expect(branchIds(topic('p'))).toEqual(['k0', 'k1', 'k2', 'k3', 'k4'])
    // back on its topic with every key; what it covers is the branch it followed
    expect(topic('p').boundaries).toEqual([{ ...BOUNDARY, range: '(1,1)' }])
    expect(topic('p').summaries).toEqual([
      { id: 'r1', range: '(1,1)', topicId: 's1', futureKey: 1 },
    ])
    expect(topic('p').children!.summary).toEqual([SUMMARY_TOPIC])
    expect(topic('m')).toEqual({ id: 'm', title: 'M' })
    expect(sheet.relationships).toEqual([RELATIONSHIP])
    expect(countPreservedElements(sheet)).toBe(countPreservedElements(before))
  })

  it('follows a covered branch that lives on though the topic that carried it was deleted', async () => {
    const { sheet, topic } = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k2'))
      detach(state, 'p')
    })
    expect(inSource(sheet, 'p')).toBeNull()
    expect(inSource(sheet, 'k1')).toBeNull()
    expect(topic('m')).toEqual({
      id: 'm',
      title: 'M',
      children: { attached: [{ id: 'k2', title: 'K2' }], summary: [SUMMARY_TOPIC] },
      boundaries: [{ ...BOUNDARY, range: '(0,0)' }],
      summaries: [{ id: 'r1', range: '(0,0)', topicId: 's1', futureKey: 1 }],
    })
    expect(sheet.relationships).toEqual([RELATIONSHIP])
  })

  it('still removes them when every covered branch is deleted, wherever the others went', async () => {
    const { sheet, topic } = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k3'))
      detach(state, 'k1')
      detach(state, 'k2')
    })
    expect(topic('p')).toEqual({
      id: 'p',
      title: 'P',
      children: {
        attached: [
          { id: 'k0', title: 'K0' },
          { id: 'k4', title: 'K4' },
        ],
      },
    })
    expect(topic('m')).toEqual({
      id: 'm',
      title: 'M',
      children: { attached: [{ id: 'k3', title: 'K3' }] },
    })
    expect(inSource(sheet, 's1')).toBeNull()
    expect(inSource(sheet, 'u1')).toBeNull()
    expect(sheet).not.toHaveProperty('relationships')
  })

  it('still removes a summary the state took off a topic that is there', async () => {
    const { sheet, topic } = await edit(covered(), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'), detach(state, 'k2'))
      inView(state, 'p').summaries = []
      state.relationships = []
    })
    expect(inSource(sheet, 's1')).toBeNull()
    expect(topic('m')).not.toHaveProperty('summaries')
    expect(topic('m').boundaries).toEqual([{ ...BOUNDARY, range: '(0,1)' }])
  })
})

describe('ranges: a topic that cannot take what follows a branch', () => {
  async function refused(content: unknown[], change: (view: ViewSheet) => void) {
    const document = await openSheets(content)
    const before = JSON.stringify(document.sheets)
    const view = document.viewSheets()[0]!
    change(view)
    const result = reconcileSheet(document, 0, view)
    if (result.ok) throw new Error('expected the state to be refused')
    expect(JSON.stringify(document.sheets)).toBe(before)
    expect(document.changed).toBe(false)
    return result.problem
  }

  it('refuses the state when the new topic holds something else where the boundaries go', async () => {
    const problem = await refused(covered({ m: { boundaries: 'not a list' } }), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'))
    })
    expect(problem).toMatch(/boundaries/)
  })

  it('refuses the state when the new topic holds something else where the summaries go', async () => {
    const problem = await refused(covered({ m: { summaries: { not: 'a list' } } }), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'))
    })
    expect(problem).toMatch(/summaries/)
  })

  it('refuses the state when a second record on the old topic names the same summary topic', async () => {
    const twice = {
      summaries: [
        { id: 'r1', range: '(1,2)', topicId: 's1' },
        { id: 'r2', range: '(3,4)', topicId: 's1' },
      ],
    }
    const problem = await refused(covered({ p: twice }), (state) => {
      inView(state, 'm').children.push(detach(state, 'k1'))
    })
    expect(problem).toMatch(/s1 is named by two records/)
  })
})

/**
 * A map laid out like one the format's own program writes: branch A with four
 * branches, a summary over A2..A3 with a branch under its summary topic, a
 * summary over A1, a boundary over A3..A4, a callout on A1, a boundary around
 * B on the central topic, and a floating topic.
 */
function drawn(): unknown[] {
  return [
    {
      id: 'sheet',
      class: 'sheet',
      rootTopic: {
        id: 'central',
        class: 'topic',
        title: 'Central',
        structureClass: 'org.xmind.ui.map.clockwise',
        children: {
          attached: [
            {
              id: 'A',
              title: 'A',
              children: {
                attached: [
                  {
                    id: 'A1',
                    title: 'A1',
                    children: { callout: [{ id: 'callout', title: 'Says' }] },
                  },
                  { id: 'A2', title: 'A2' },
                  { id: 'A3', title: 'A3' },
                  { id: 'A4', title: 'A4' },
                ],
                summary: [
                  {
                    id: 'SUM',
                    title: 'Sum',
                    children: { attached: [{ id: 'SUM-child', title: 'Under the summary' }] },
                  },
                  { id: 'SUM2', title: 'Sum two' },
                ],
              },
              boundaries: [{ id: 'bound-A', range: '(2,3)' }],
              summaries: [
                { id: 'rec', range: '(1,2)', topicId: 'SUM' },
                { id: 'rec2', range: '(0,0)', topicId: 'SUM2' },
              ],
            },
            { id: 'B', title: 'B' },
            { id: 'C', title: 'C' },
            { id: 'D', title: 'D' },
          ],
          detached: [{ id: 'float', title: 'Floating', position: { x: 10, y: 20 } }],
        },
        boundaries: [{ id: 'bound-B', range: '(1,1)' }],
      },
      title: 'Sheet',
    },
  ]
}

describe('ranges: dragging on a map as the format draws it', () => {
  it('keeps the boundary around a branch that is dragged under another branch', async () => {
    const { before, sheet, topic, inSync } = await edit(drawn(), (state) => {
      inView(state, 'A').children.push(detach(state, 'B'))
    })
    expect(countPreservedElements(before)).toBe(5)
    expect(countPreservedElements(sheet)).toBe(5)
    expect(sheet.rootTopic).not.toHaveProperty('boundaries')
    expect(topic('A').boundaries).toEqual([
      { id: 'bound-A', range: '(2,3)' },
      { id: 'bound-B', range: '(4,4)' },
    ])
    expect(topic('A').summaries).toEqual(inSource(before, 'A')!.summaries)
    expect(inSync).toBe(true)
  })

  it('keeps the summary, its topic and the branch under it when its branches are dragged away', async () => {
    const { before, sheet, topic } = await edit(drawn(), (state) => {
      inView(state, 'C').children.push(detach(state, 'A2'), detach(state, 'A3'))
    })
    expect(countPreservedElements(sheet)).toBe(5)
    expect(topic('C')).toEqual({
      id: 'C',
      title: 'C',
      children: {
        attached: [
          { id: 'A2', title: 'A2' },
          { id: 'A3', title: 'A3' },
        ],
        summary: [inSource(before, 'SUM')],
      },
      summaries: [{ id: 'rec', range: '(0,1)', topicId: 'SUM' }],
      boundaries: [{ id: 'bound-A', range: '(1,1)' }],
    })
    expect(inSource(sheet, 'SUM-child')).toEqual({ id: 'SUM-child', title: 'Under the summary' })
    expect(topic('A').summaries).toEqual([{ id: 'rec2', range: '(0,0)', topicId: 'SUM2' }])
    expect(topic('A').children!.summary).toEqual([{ id: 'SUM2', title: 'Sum two' }])
    expect(topic('A')).not.toHaveProperty('boundaries')
    expect(branchIds(topic('A'))).toEqual(['A1', 'A4'])
  })
})
