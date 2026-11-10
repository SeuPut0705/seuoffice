import { describe, expect, it } from 'vitest'
import {
  simulate,
  toyLines,
  toyMap,
  type SimulationReport,
  type Toy,
} from '../src/conformance/index'

const SEEDS = 1000

async function sweep<Op>(toy: Toy<Op>): Promise<SimulationReport[]> {
  const reports: SimulationReport[] = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    reports.push(
      await simulate({
        seed,
        clients: 2 + (seed % 4),
        steps: 400,
        file: { format: toy.format, bytes: toy.file() },
        adapterFactory: toy.open,
        network: { reorderAcrossSockets: seed % 5 !== 0 },
      }),
    )
  }
  return reports
}

function total(reports: SimulationReport[], key: keyof SimulationReport): number {
  return reports.reduce((sum, report) => sum + report[key], 0)
}

describe.each([
  ['keyed last-writer-wins map', toyMap as Toy<unknown>],
  ['list of lines', toyLines as Toy<unknown>],
])('simulate over %s', (_name, toy) => {
  it(`converges on ${SEEDS} seeds while connections break and frames arrive late`, async () => {
    const reports = await sweep(toy)
    expect(reports).toHaveLength(SEEDS)
    // The faults the seeds are meant to exercise actually happened
    expect(total(reports, 'ops')).toBeGreaterThan(SEEDS * 10)
    expect(total(reports, 'stale')).toBeGreaterThan(0)
    expect(total(reports, 'breaks')).toBeGreaterThan(0)
    expect(total(reports, 'lateFrames')).toBeGreaterThan(0)
    expect(total(reports, 'saves')).toBeGreaterThan(0)
    expect(total(reports, 'joiners')).toBeGreaterThan(0)
  }, 60_000)
})
