/**
 * Inputs that used to write a deck PowerPoint reports as damaged: a page size
 * outside its 1-56 inch range, and a slide listed twice in the section list.
 * The CLI refuses them before the op reaches pptx-ops.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { OpenedPptx } from '@genoffice/pptx-engine'
import { applyOps, blankDeck } from '../src/formats/pptx'
import { refuseOp } from '../src/formats/pptx-op-checks'
import { run, tempDir } from './helpers'

let opened: OpenedPptx

beforeEach(async () => {
  opened = await blankDeck()
  const r = applyOps(opened, [{ op: 'addBlankSlide', target: { slide: 0 } }], {})
  expect(r.applied).toBe(true)
  expect(opened.deck.slides).toHaveLength(2)
})

const sections = (...lists: number[][]) => ({
  op: 'setSections',
  sections: lists.map((slideIndices, i) => ({
    id: `{6F1D2B0A-4C3E-4F58-9A21-0D7E5B3C9A1${i}}`,
    name: `Part ${i + 1}`,
    slideIndices,
  })),
})

describe('setSlideSize input checks', () => {
  it.each([
    [10, 10],
    [999_999_999, 999_999_999],
    [12_192_000.5, 6_858_000],
    [914_399, 6_858_000],
    ['0.5in', '7.5in'],
  ])('rejects %s x %s', (cx, cy) => {
    const r = applyOps(opened, [{ op: 'setSlideSize', cx, cy }], {})
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).toMatch(/whole number of EMU from 914400/)
    expect(r.failures![0]!.error).toMatch(/Nothing was applied \(atomic\)/)
  })

  it('still accepts the common sizes, in EMU or with a unit', () => {
    expect(
      applyOps(opened, [{ op: 'setSlideSize', cx: 9_144_000, cy: 6_858_000 }], {}).applied,
    ).toBe(true)
    expect(applyOps(opened, [{ op: 'setSlideSize', cx: '11in', cy: '8.5in' }], {}).applied).toBe(
      true,
    )
  })

  it('leaves a missing edge to the engine own message', () => {
    expect(refuseOp({ op: 'setSlideSize', cx: 9_144_000 }, 2)).toBeUndefined()
  })
})

describe('setSections input checks', () => {
  it('rejects a slide listed in two sections', () => {
    const r = applyOps(opened, [sections([0, 1], [1])], {})
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).toMatch(/slide 1 is listed in more than one place/)
  })

  it('rejects a slide listed twice in one section', () => {
    const r = applyOps(opened, [sections([0, 0])], {})
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).toMatch(/slide 0 is listed in more than one place/)
  })

  it('rejects a slide index the deck does not have', () => {
    const r = applyOps(opened, [sections([0], [7])], {})
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).toMatch(/slide index 7 is out of range/)
  })

  it('rejects an index that is not a whole number', () => {
    const r = applyOps(opened, [sections([0.5])], {})
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).toMatch(/whole numbers from 0/)
  })

  it('rejects a section without a slide list', () => {
    const r = applyOps(opened, [{ op: 'setSections', sections: [{ id: '{x}', name: 'A' }] }], {})
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).toMatch(/needs "slideIndices"/)
  })

  it('accepts a section split of the existing slides', () => {
    expect(applyOps(opened, [sections([0], [1])], {}).applied).toBe(true)
  })

  it('accepts a slide added by an earlier op, as the CLI applies ops one at a time', () => {
    expect(applyOps(opened, [{ op: 'addBlankSlide', target: { slide: 1 } }], {}).applied).toBe(true)
    expect(applyOps(opened, [sections([0, 1], [2])], {}).applied).toBe(true)
  })

  it('skips the range check for a later op of the same batch, which may follow a slide add', () => {
    const r = applyOps(
      opened,
      [{ op: 'addBlankSlide', target: { slide: 1 } }, sections([0, 1], [2])],
      {},
    )
    expect(r.applied).toBe(true)
  })
})

describe('applyOps isolation', () => {
  it('per_op refuses the bad op and still applies the others, with the caller indexes', () => {
    const r = applyOps(
      opened,
      [
        { op: 'setSlideSize', cx: 10, cy: 10 },
        { op: 'addBlankSlide', target: { slide: 1 } },
      ],
      { isolation: 'per_op' },
    )
    expect(r.applied).toBe(true)
    expect(opened.deck.slides).toHaveLength(3)
    expect(r.failures).toHaveLength(1)
    expect(r.failures![0]!.index).toBe(0)
    expect(r.failures![0]!.error).not.toMatch(/atomic/)
  })
})

describe('slides apply', () => {
  it('refuses an out-of-range slide size and leaves the deck untouched', async () => {
    const dir = tempDir()
    const out = join(dir, 'deck.pptx')
    const base = join(dir, 'base.json')
    writeFileSync(base, JSON.stringify([{ op: 'addBlankSlide', target: { slide: 0 } }]))
    expect(
      (await run(['create', '--type', 'pptx', '--ops', base, '--out', out, '--json'])).code,
    ).toBe(0)
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([{ op: 'setSlideSize', cx: 999_999_999, cy: 999_999_999 }]))
    const r = await run(['slides', 'apply', out, '--ops', ops, '--json'])
    expect(r.code).not.toBe(0)
    expect(JSON.stringify(r.json())).toMatch(/whole number of EMU from 914400/)
  })
})
