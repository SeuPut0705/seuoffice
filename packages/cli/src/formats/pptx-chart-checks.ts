/**
 * Input checks the `addChart` op of `@genoffice/pptx-ops` does not make,
 * applied by the CLI before the op reaches the engine. The chart builder drops
 * data it cannot draw without a word: a text value leaves a gap in the series,
 * a short value list leaves the last category empty, an unknown kind is drawn
 * as columns, and a category that is not text throws a TypeError. pptx-ops
 * stays as it is, so a valid chart is built exactly as before.
 */
import type { NewChartKind } from '@genoffice/pptx-engine'

// A record over the engine's own NewChartKind: adding a kind there fails the
// typecheck here until it is listed, so the two lists cannot drift apart (the
// Slides ribbon sends barPercentStacked, bar3D and pie3D through this op).
const CHART_KIND_LIST: Record<NewChartKind, true> = {
  bar: true,
  barStacked: true,
  barPercentStacked: true,
  line: true,
  area: true,
  pie: true,
  doughnut: true,
  scatter: true,
  radar: true,
  comboBarLine: true,
  pie3D: true,
  bar3D: true,
}
export const CHART_KINDS: string[] = Object.keys(CHART_KIND_LIST)

type Series = { name?: unknown; values: unknown[] }

/**
 * The reason an `addChart` op must not run, or undefined. A value that is
 * missing altogether (no kind, no categories, no series) is left to the op's
 * own "needs ..." message.
 */
export function refuseChartOp(op: unknown): string | undefined {
  if (typeof op !== 'object' || op === null) return undefined
  const chart = op as Record<string, unknown>
  if (chart.op !== 'addChart') return undefined
  if (typeof chart.kind === 'string' && !CHART_KINDS.includes(chart.kind)) {
    return `op "addChart": unknown "kind" ${JSON.stringify(chart.kind)}; use one of ${CHART_KINDS.join(', ')}.`
  }
  const categories = chart.categories
  if (!Array.isArray(categories) || categories.length === 0) return undefined
  const series = chart.series
  if (
    !Array.isArray(series) ||
    series.length === 0 ||
    series.some((s) => !s || typeof s !== 'object' || !Array.isArray((s as Series).values))
  ) {
    return undefined
  }
  for (const [i, c] of categories.entries()) {
    if (typeof c !== 'string') {
      return `op "addChart": categories[${i}] must be text; write a number such as a year as a string ("2024").`
    }
  }
  for (const [i, s] of (series as Series[]).entries()) {
    if (typeof s.name !== 'string') {
      return `op "addChart": series[${i}] needs "name": the series label.`
    }
    if (s.values.length !== categories.length) {
      return `op "addChart": series[${i}] has ${s.values.length} values for ${categories.length} categories; give one value per category (null leaves a gap).`
    }
    for (const [j, v] of s.values.entries()) {
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) {
        return `op "addChart": series[${i}].values[${j}] must be a number or null for a gap, got ${JSON.stringify(v)}.`
      }
    }
  }
  return undefined
}
