import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPECS } from './saxes-cases'

/**
 * Writes `crates/saxes/tests/node-answers.json`: every built input of `saxesEvents` with the answer of the real
 * saxes, which `crates/saxes/tests/node_answers.rs` replays. Run with `npx tsx saxes-fixture.ts` from this directory.
 */
const spec = SPECS[0]!
// options that change only the prefix of an error message are left to the gate: they would double the file
const GATE_ONLY = [
  '{"xmlns":true,"position":false}',
  '{"fileName":"chapter.xhtml"}',
  '{"position":false}',
  '{"defaultXMLVersion":"1.1"}',
]
const cases = []
for (const input of await spec.built()) {
  if (GATE_ONLY.some((options) => input.label.endsWith(` ${options}`))) continue
  cases.push({
    label: input.label,
    text: input.text ?? '',
    args: input.args ?? {},
    expected: await spec.call(input),
  })
}
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../crates/saxes/tests/node-answers.json',
)
writeFileSync(out, JSON.stringify(cases), 'utf8')
console.log(`${cases.length} cases written to ${out}`)
