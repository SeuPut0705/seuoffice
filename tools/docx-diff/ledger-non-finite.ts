// Writes the entries of divergences.json for the drawing functions that put a
// non-finite number into the XML on the TypeScript side: one per input of
// NON_FINITE_DRAWING and NON_FINITE_DRAWING_BUILD, with what each side gives
// now. An input both sides agree on, or one where the TypeScript writes no
// NaN or Infinity, is no such divergence: the tool stops on it. The first
// entry is the class `CallSpec.masked` names for every such input: the
// comparison masks the non-finite values and compares the rest.
//
//   npx tsx tools/docx-diff/ledger-non-finite.ts          rewrite the entries
//   npx tsx tools/docx-diff/ledger-non-finite.ts --check  exit 1 when they would change
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { NON_FINITE_DRAWING } from './calls-gen-drawing'
import { NON_FINITE_DRAWING_BUILD } from './calls-gen-drawing-build'
import { callOutcomes } from './calls-run'
import { toolDir } from './harness'
import { NON_FINITE_NUMBER } from './listed'

const PREFIX = 'non-finite-'
const NON_FINITE = /^-?(?:NaN|Infinity)$/
const REASON =
  'TypeScript defect, fix pending on main. The TypeScript formats the number it is given, so a NaN or an ' +
  'infinity reaches the XML as the text "NaN" or "Infinity", which no schema type of that attribute or ' +
  'element admits (they are integers), so the part is invalid. One rule for all 16 functions: a function ' +
  'that patches existing XML keeps what the attribute or text held, as the guarded patchImageParagraphXml ' +
  'does on both sides, and does everything else the TypeScript does, including what the TypeScript\'s own ' +
  'NaN prevents later in the same call; where the TypeScript inserts a new attribute holding the value, ' +
  'the Rust leaves that attribute out. A builder, which has nothing to keep, refuses the call ' +
  '("a non-finite number: <option>"). Where the TypeScript result holds no NaN or Infinity (a size of ' +
  '-Infinity clamped to 1 EMU, a NaN holder spacing), Rust gives that result. The comparison masks, on ' +
  'both sides, each value where the TypeScript wrote a non-finite number and compares the rest exactly.'

/** The paths of the arguments that hold a non-finite number, as text. */
function nonFiniteAt(value: unknown, path: string): string[] {
  if (typeof value === 'string') return NON_FINITE.test(value) ? [`${path}=${value}`] : []
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => nonFiniteAt(inner, path === '' ? key : `${path}.${key}`))
}

const entries: object[] = []
const ids = new Set<string>()
for (const { fn, text, args } of [...NON_FINITE_DRAWING, ...NON_FINITE_DRAWING_BUILD]) {
  const at = nonFiniteAt(args, '')
  if (at.length === 0) throw new Error(`${fn}: no non-finite argument in ${JSON.stringify(args)}`)
  // the first entry carries the id of the class the specs list (listed.ts)
  const id = entries.length === 0 ? NON_FINITE_NUMBER : `${PREFIX}${fn}-${at.join('-')}`
  if (ids.has(id)) throw new Error(`${id}: listed twice`)
  ids.add(id)
  const { typescript, rust } = await callOutcomes(fn, text, args)
  if (isDeepStrictEqual(typescript, rust)) throw new Error(`${id}: both sides agree`)
  if (!/NaN|Infinity/.test(JSON.stringify(typescript))) {
    throw new Error(`${id}: the TypeScript writes no NaN or Infinity, so its output is not invalid: Rust must match it`)
  }
  if (/NaN|Infinity/.test(JSON.stringify(rust))) throw new Error(`${id}: Rust writes a non-finite number`)
  entries.push({ id, comparison: 'call', fn, text, args, typescript, rust, reason: REASON })
}

const path = resolve(toolDir, 'divergences.json')
const before = readFileSync(path, 'utf8')
const kept = (JSON.parse(before) as Array<{ id: string }>).filter((entry) => !entry.id.startsWith(PREFIX))
const after = JSON.stringify([...kept, ...entries], null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (after !== before) {
    console.error('divergences.json: the non-finite entries are stale; run ledger-non-finite.ts')
    process.exitCode = 1
  }
} else {
  writeFileSync(path, after)
}
console.log(`divergences.json: ${entries.length} non-finite entries, ${kept.length} others`)
