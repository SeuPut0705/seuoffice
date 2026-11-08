/**
 * addChart used to accept data the chart builder drops without a word: text
 * values, a short value list and an unknown kind (drawn as columns) all gave a
 * chart that quietly lacked data, and a non-text label threw a TypeError. The
 * CLI refuses them before the op reaches pptx-ops.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NewChartKind, OpenedPptx } from '@genoffice/pptx-engine'
import { applyOps, blankDeck } from '../src/formats/pptx'
import { refuseChartOp } from '../src/formats/pptx-chart-checks'
import { run, tempDir } from './helpers'

let opened: OpenedPptx

beforeEach(async () => {
  opened = await blankDeck()
})

const chart = (over: Record<string, unknown>) => ({
  op: 'addChart',
  target: { slide: 0 },
  kind: 'bar',
  categories: ['Q1', 'Q2'],
  series: [{ name: 'Revenue', values: [120, 135] }],
  offset: { x: 914400, y: 914400, cx: 5000000, cy: 3000000 },
  ...over,
})

const failure = (over: Record<string, unknown>): string => {
  const r = applyOps(opened, [chart(over)], {})
  expect(r.applied).toBe(false)
  return r.failures![0]!.error
}

describe('addChart input checks', () => {
  it('rejects an unknown kind instead of drawing columns', () => {
    expect(failure({ kind: 'sparkle' })).toMatch(/unknown "kind" "sparkle"; use one of bar, /)
  })

  it('rejects a value that is neither a number nor null', () => {
    expect(failure({ series: [{ name: 'Revenue', values: [120, '135'] }] })).toMatch(
      /series\[0\]\.values\[1\] must be a number or null for a gap, got "135"/,
    )
  })

  it('rejects fewer or more values than categories', () => {
    expect(failure({ series: [{ name: 'Revenue', values: [120] }] })).toMatch(
      /series\[0\] has 1 values for 2 categories/,
    )
    expect(failure({ series: [{ name: 'Revenue', values: [1, 2, 3] }] })).toMatch(
      /series\[0\] has 3 values for 2 categories/,
    )
  })

  it('rejects a category that is not text and a series without a name', () => {
    expect(failure({ categories: [2023, 2024] })).toMatch(/categories\[0\] must be text/)
    expect(failure({ series: [{ values: [1, 2] }] })).toMatch(/series\[0\] needs "name"/)
  })

  it('says nothing was applied when the call is atomic', () => {
    expect(failure({ kind: 'sparkle' })).toMatch(/Nothing was applied \(atomic\)/)
  })

  it('leaves a missing kind, categories or series to the op own message', () => {
    expect(refuseChartOp(chart({ kind: undefined }))).toBeUndefined()
    expect(refuseChartOp(chart({ categories: [] }))).toBeUndefined()
    expect(refuseChartOp(chart({ series: [] }))).toBeUndefined()
    expect(refuseChartOp(chart({ series: [{ name: 'x' }] }))).toBeUndefined()
    expect(failure({ categories: [] })).toMatch(/needs "categories"/)
  })

  it('accepts every kind the engine can insert, including the ones the ribbon gallery sends', () => {
    const kinds: NewChartKind[] = [
      'bar',
      'barStacked',
      'barPercentStacked',
      'line',
      'area',
      'pie',
      'doughnut',
      'scatter',
      'radar',
      'comboBarLine',
      'pie3D',
      'bar3D',
    ]
    for (const kind of kinds) {
      const over = kind === 'scatter' ? { kind, categories: ['1', '2'] } : { kind }
      const r = applyOps(opened, [chart(over)], {})
      expect(r.applied, `${kind}: ${r.failures?.[0]?.error ?? ''}`).toBe(true)
    }
  })

  it('still accepts a gap, a stacked kind and a scatter chart', () => {
    for (const over of [
      { series: [{ name: 'Revenue', values: [120, null] }] },
      { kind: 'barStacked' },
      { kind: 'scatter', categories: ['1', '2'] },
    ]) {
      expect(applyOps(opened, [chart(over)], {}).applied).toBe(true)
    }
  })

  it('per_op isolation refuses the bad chart and still applies the others', () => {
    const r = applyOps(
      opened,
      [chart({ kind: 'sparkle' }), chart({ kind: 'pie' }), chart({ categories: [1, 2] })],
      { isolation: 'per_op' },
    )
    expect(r.failures!.map((f) => f.index)).toEqual([0, 2])
    expect(r.failures![0]!.error).not.toMatch(/Nothing was applied/)
    expect(r.applied).toBe(true)
  })
})

describe('slides apply', () => {
  it('refuses a chart with a text value and leaves the deck untouched', async () => {
    const dir = tempDir()
    const out = join(dir, 'deck.pptx')
    const base = join(dir, 'base.json')
    writeFileSync(base, JSON.stringify([{ op: 'addBlankSlide', target: { slide: 0 } }]))
    expect(
      (await run(['create', '--type', 'pptx', '--ops', base, '--out', out, '--json'])).code,
    ).toBe(0)
    const before = readFileSync(out)
    const ops = join(dir, 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([chart({ series: [{ name: 'Revenue', values: [120, '135'] }] })]),
    )
    const r = await run(['slides', 'apply', out, '--ops', ops, '--json'])
    expect(r.code).not.toBe(0)
    expect(JSON.stringify(r.json())).toMatch(/must be a number or null for a gap/)
    expect(readFileSync(out).equals(before)).toBe(true)
  })
})
