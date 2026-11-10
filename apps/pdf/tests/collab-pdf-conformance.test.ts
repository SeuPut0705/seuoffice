// @vitest-environment node
/**
 * The conformance kit over the real adapter and the real edit registry:
 * several people highlight, draw, fill and design forms, add, turn, delete and
 * reorder pages, undo and redo at random, against the real server with broken
 * connections, late frames, saves and late joiners. Every seed must converge;
 * a failure names its seed.
 */
import type { Json } from '@seuoffice/collab/client'
import { describe, expect, it } from 'vitest'
// the kit from its source: this package's vitest config has no seuoffice-source condition
import { simulate, type SimulatedEditor } from '../../../packages/collab/src/conformance/index'
import type { EditSnapshot } from '../src/renderer/edit-state'
import { pageCount, type PdfOp } from '../src/web/collab-model'
import { randomAction } from './collab/actions'
import { blankFile, fileBytes, openHeadless } from './collab/headless'

const FORMAT = { name: 'pdf', schema: 1 }

/** What the App and the save path need of an edit state, whatever the peers did */
function invalid(s: EditSnapshot, basePages: number): string | null {
  const count = pageCount(s, basePages)
  const blanks = s.blankPages.map((b) => b.input.pageIndex).sort((a, b) => a - b)
  if (blanks.some((p, i) => p !== basePages + i)) return `blank pages at ${blanks}`
  if (s.order) {
    const sorted = [...s.order].sort((a, b) => a - b)
    if (sorted.length !== count || sorted.some((p, i) => p !== i)) return `order ${s.order}`
  }
  if (count - [...s.deleted].filter((p) => p < count).length < 1) return 'no page left'
  for (const p of [...s.deleted, ...s.rotations.keys()])
    if (p >= count) return `page ${p} of ${count}`
  for (const [p, turn] of s.rotations)
    if (![90, 180, 270].includes(turn)) return `page ${p} turned ${turn}`
  const onPage = [
    ...s.markups.map((m) => m.pageIndex),
    ...s.drawings.map((d) => d.input.pageIndex),
    ...s.formFields.map((f) => f.input.pageIndex),
  ]
  if (onPage.some((p) => p >= count || s.deleted.has(p))) return 'an edit on a missing page'
  const notes = new Set(s.drawings.flatMap((d) => (d.input.kind === 'note' ? [d.id] : [])))
  for (const d of s.drawings) {
    if (d.input.kind === 'note' && d.input.replyToLocalId && !notes.has(d.input.replyToLocalId))
      return `reply ${d.id} without its note`
  }
  const names = new Map<string, string>()
  for (const f of s.formFields) {
    const kind = names.get(f.input.name)
    if (kind !== undefined && !(kind === 'radio' && f.input.kind === 'radio'))
      return `two fields ${f.input.name}`
    names.set(f.input.name, f.input.kind)
  }
  if (s.textEdits.length + s.textInserts.length + s.imageEdits.length + s.annotDeletes.length > 0)
    return 'an edit the web cannot save'
  return null
}

function factory(bytes: Uint8Array): SimulatedEditor<PdfOp> {
  const opened = openHeadless(bytes)
  const { app } = opened
  const checked = <T>(result: T): T => {
    const problem = invalid(app.state, app.basePages)
    if (problem) throw new Error(`${app.name} shows an invalid state: ${problem}`)
    return result
  }
  return {
    ...opened.adapter,
    integrate: (remote, local) => checked(opened.adapter.integrate(remote, local)),
    edit: (random, id) => checked(opened.tagged(id, () => randomAction(app, random, id))),
    opKey: (op: Json) => (op as { id: string }).id,
  }
}

const SEEDS = Number(process.env.PDF_COLLAB_SEEDS ?? 120)

/** What the runs exercised, so a pass over almost nothing does not count */
interface Totals {
  ops: number
  head: number
  saves: number
  joiners: number
  breaks: number
  stale: number
}

describe('co-editing a PDF converges', () => {
  for (const [name, network, clients, steps] of [
    ['calm network', { disconnect: 0 }, 3, 400],
    ['broken connections', { disconnect: 0.06 }, 3, 600],
    ['five people', { disconnect: 0.01 }, 5, 600],
    ['two people, a long session', {}, 2, 2000],
  ] as const) {
    it(`${name}: ${SEEDS} seeds`, { timeout: 600_000 }, async () => {
      const totals: Totals = { ops: 0, head: 0, saves: 0, joiners: 0, breaks: 0, stale: 0 }
      for (let seed = 1; seed <= SEEDS; seed++) {
        const report = await simulate({
          seed,
          clients,
          steps,
          file: { format: FORMAT, bytes: fileBytes(blankFile(3)) },
          adapterFactory: factory,
          network,
        })
        for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] += report[key]
      }
      console.log(`${name}, seeds 1..${SEEDS}: ${JSON.stringify(totals)}`)
      expect(totals.ops).toBeGreaterThan(SEEDS * 10)
      expect(totals.saves).toBeGreaterThan(0)
    })
  }
})
