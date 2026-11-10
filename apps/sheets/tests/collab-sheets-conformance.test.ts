/**
 * Randomized co-editing over real Univer workbooks, two ways.
 *
 * The step runs drive pages through the adapter calls the engine makes, in a
 * seeded order of edits, submits and partial catch-ups, and compare every page
 * with a late joiner whenever all of them are at the head; a mismatch prints
 * the first differing part of the two workbooks.
 *
 * The kit runs use the conformance kit of @seuoffice/collab: two to four pages
 * against the real server through a scheduler that breaks connections, delays
 * frames, saves and adds late joiners. Each seed must end with every page, the
 * late joiner and every saved file at the same fingerprint.
 *
 * Failures name their seed; rerun one with COLLAB_SEED=<seed>.
 */
import { simulate } from '@seuoffice/collab/conformance'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintText } from '../src/web/collab-fingerprint'
import { int, pick, randomEdit, seeded } from './collab/random-edit'
import { Room } from './collab/room'
import {
  disposeAll,
  FORMAT,
  fileOf,
  type OpenedBook,
  simulatedBook,
  workbookData,
} from './collab/sheets-workbook'

afterEach(disposeAll)

const CELLS = {
  0: { 0: { v: 'name' }, 1: { v: 'amount' } },
  1: { 0: { v: 'kim' }, 1: { v: 3 } },
  2: { 0: { v: 'lee' }, 1: { v: 4 }, 2: { f: '=B2+B3' } },
  6: { 3: { v: 'bold', s: 'bold' } },
}

const seeds = (count: number) =>
  process.env.COLLAB_SEED
    ? [Number(process.env.COLLAB_SEED)]
    : Array.from({ length: Number(process.env.COLLAB_SEEDS ?? count) }, (_, i) => i + 1)

/** The first place two fingerprint texts part, with some context */
function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && a[at] === b[at]) at++
  const from = Math.max(0, at - 160)
  return `\n  page: ${a.slice(from, at + 160)}\n  log:  ${b.slice(from, at + 160)}`
}

function stepRun(seed: number): { ops: number } {
  const random = seeded(seed)
  const room = new Room(CELLS)
  const pages: OpenedBook[] = []
  for (let i = 0, count = 2 + (seed % 3); i < count; i++) pages.push(room.join())
  let edits = 0
  for (let step = 0; step < 120; step++) {
    const page = pick(random, pages)
    const roll = random()
    if (roll < 0.55) {
      const id = `p${pages.indexOf(page)}.${edits}`
      room.check(page, `the steps before edit ${id}`)
      if (randomEdit(page, random, id)) {
        edits += 1
        room.check(
          page,
          `edit ${id} (${page.emitted
            .at(-1)!
            .mutations.map((m) => m.id)
            .join(', ')})`,
        )
      }
    } else if (roll < 0.8) room.submit(page)
    else room.catchUp(page, int(random, room.log.length + 1))
    if (step % 30 === 29) {
      room.settle(...pages)
      const late = room.late()
      const reference = fingerprintText(late.workbook)
      for (const other of pages) {
        const shown = fingerprintText(other.workbook)
        if (shown !== reference) {
          const ops = room.log.map((change) =>
            change.ops
              .map(
                (op) =>
                  `${op.id}[${op.mutations.map((m) => m.id.replace('sheet.mutation.', '')).join(',')}]`,
              )
              .join(' '),
          )
          throw new Error(
            `seed ${seed}: page ${pages.indexOf(other)} differs from the log at step ${step}${firstDifference(shown, reference)}\n  log: ${ops.join('\n       ')}`,
          )
        }
      }
      late.dispose()
      room.pages.pop()
    }
  }
  return { ops: edits }
}

describe('co-editing conformance over real workbooks', () => {
  it('step runs converge for every seed', () => {
    let ops = 0
    for (const seed of seeds(300)) {
      ops += stepRun(seed).ops
      disposeAll()
    }
    expect(ops).toBeGreaterThan(0)
  }, 600_000)

  it('kit runs converge for every seed', async () => {
    let ops = 0
    let stale = 0
    for (const seed of seeds(100)) {
      const report = await simulate({
        seed,
        clients: 2 + (seed % 3),
        steps: 400,
        file: { format: FORMAT, bytes: fileOf(workbookData(CELLS)) },
        adapterFactory: (bytes) => simulatedBook(bytes, randomEdit),
      })
      ops += report.ops
      stale += report.stale
      disposeAll()
    }
    expect(ops).toBeGreaterThan(0)
    expect(stale).toBeGreaterThan(0)
  }, 600_000)
})
