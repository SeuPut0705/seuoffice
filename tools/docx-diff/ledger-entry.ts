// Writes (or rewrites) one entry of divergences.json for a function of
// comparison (f), with what each side answers now for the input given.
//
//   npx tsx tools/docx-diff/ledger-entry.ts ENTRY.json
//
// ENTRY.json holds { id, fn, text, args?, reason }; an entry with that id is
// replaced in place, a new one goes last. The tool
// stops where the two sides answer alike: that is no divergence.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { callOutcomes } from './calls-run'
import { toolDir } from './harness'

interface Wanted {
  id: string
  fn: string
  text: string
  args?: Record<string, unknown>
  reason: string
}

const wanted = JSON.parse(readFileSync(resolve(process.argv[2]!), 'utf8')) as Wanted
const { typescript, rust } = await callOutcomes(wanted.fn, wanted.text, wanted.args ?? {})
if (isDeepStrictEqual(typescript, rust)) throw new Error(`${wanted.id}: both sides agree`)
const entry = { id: wanted.id, comparison: 'call', fn: wanted.fn, text: wanted.text, args: wanted.args ?? {}, typescript, rust, reason: wanted.reason }
const path = resolve(toolDir, 'divergences.json')
const ledger = JSON.parse(readFileSync(path, 'utf8')) as Array<{ id: string }>
const at = ledger.findIndex((listed) => listed.id === wanted.id)
if (at >= 0) ledger[at] = entry
else ledger.push(entry)
writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n')
console.log(`${wanted.id}: ${at >= 0 ? 'rewritten' : 'added'}`)
