import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { compareModel } from './compare-model'
import { Comparison, gateHasFailed, reportComparisons } from './harness'
import { requireModelNode } from './model-inputs'
import { builtModelInputs } from './model-built'
import { invalidModelInputs } from './model-invalid'
import { modelDigest, type ModelInput } from './model-wire'

requireModelNode()
const here = dirname(fileURLToPath(import.meta.url))
const at = process.argv.indexOf('--inputs')
const inputPath = resolve(at < 0 ? resolve(here, 'out/model-inputs.ndjson') : process.argv[at + 1]!)
const outAt = process.argv.indexOf('--output')
const output = resolve(
  outAt < 0 ? resolve(here, 'out/model-comparison.json') : process.argv[outAt + 1]!,
)
if (
  process.argv.includes('--first') &&
  (() => {
    try {
      readFileSync(output)
      return true
    } catch {
      return false
    }
  })()
) {
  throw new Error(`first run already exists: ${output}`)
}
const populations = new Map<string, Comparison>()
const get = (name: string): Comparison => {
  let comparison = populations.get(name)
  if (!comparison) {
    comparison = new Comparison(
      `(h) model ${name}`,
      `model${name[0]!.toUpperCase()}${name.slice(1)}`,
    )
    populations.set(name, comparison)
  }
  return comparison
}
for (const name of [
  'corpus',
  'built',
  'tests',
  'types',
  'invalid',
  'blocks paragraph',
  'blocks passthrough',
  'blocks heading',
  'blocks table',
  'blocks listItem',
  'blocks image',
])
  get(name)
const results: object[] = []
for await (const line of createInterface({
  input: createReadStream(inputPath),
  crlfDelay: Infinity,
})) {
  if (!line) continue
  const input = JSON.parse(line) as ModelInput
  const actual = compareModel(get(input.population), input)
  results.push({
    where: input.where,
    type: input.type,
    expected: modelDigest(input.json),
    actual: actual.json === undefined ? actual : modelDigest(actual.json),
  })
  const model = JSON.parse(input.json) as { blocks?: Array<{ type: string }> }
  for (const [index, block] of (model.blocks ?? []).entries()) {
    const blockInput: ModelInput = {
      ...input,
      where: `${input.where} block ${index}`,
      type: 'Block',
      json: JSON.stringify(block),
    }
    const blockResult = compareModel(get(`blocks ${block.type}`), blockInput)
    results.push({
      where: blockInput.where,
      type: 'Block',
      expected: modelDigest(blockInput.json),
      actual: blockResult.json === undefined ? blockResult : modelDigest(blockResult.json),
    })
  }
}
if (process.argv.includes('--built-types')) {
  for (const input of builtModelInputs()) {
    const actual = compareModel(get('types'), input)
    results.push({
      where: input.where,
      type: input.type,
      expected: modelDigest(input.json),
      actual: actual.json === undefined ? actual : modelDigest(actual.json),
    })
  }
  for (const input of invalidModelInputs()) {
    const actual = compareModel(get('invalid'), input)
    results.push({
      where: input.where,
      type: input.type,
      expect: input.expect,
      expected: modelDigest(input.json),
      actual: actual.json === undefined ? actual : modelDigest(actual.json),
    })
  }
}
const report = {
  node: process.version,
  comparisons: Object.fromEntries(
    [...populations].map(([name, c]) => [
      name,
      {
        compared: c.compared,
        differences: c.differences.length,
        keyOrderOnly: c.keyOrderOnly,
        details: c.differences,
      },
    ]),
  ),
  results,
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {
  flag: process.argv.includes('--first') ? 'wx' : 'w',
})
reportComparisons()
console.log(`Model report: ${output}`)
process.exitCode = gateHasFailed() ? 1 : 0
