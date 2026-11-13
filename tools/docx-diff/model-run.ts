import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDocx } from './reference/parse'
import { buildDocx } from '../../packages/docx-engine/tests/helpers/build-docx'
import { builtModelInputs } from './model-built'
import { buildModelBody, MODEL_BODIES } from './model-bodies'
import { compareModel } from './compare-model'
import { invalidModelInputs } from './model-invalid'
import { atFloor, Comparison, failGate, repoRoot, toolDir } from './harness'
import { ModelCoverage } from './model-observe'
import { PROPS_TEXTS } from './props-synthetic'
import { readTestInputs } from './model-test-inputs'
import { STORIES } from './withheld-inputs'
import { modelJson, type ModelInput } from './model-wire'

const corpus = new Comparison('(h) typed model, corpus documents', 'modelCorpus')
const built = new Comparison('(h) typed model, built documents', 'modelBuilt')
const tests = new Comparison('(h) typed model, captured test results', 'modelTests')
const types = new Comparison('(h) typed model, independently built values', 'modelTypes')
const invalid = new Comparison('(h) typed model, invalid values refused', 'modelInvalid')
const blocks = new Map(['paragraph', 'passthrough', 'heading', 'table', 'listItem', 'image'].map((type) => [
  type, new Comparison(`(h) typed model, ${type} blocks`, `modelBlocks ${type}`),
]))
const parserCoverage = new ModelCoverage()
const builtCoverage = new ModelCoverage()
const refusals: Array<{ where: string; error: string }> = []
const fieldFloors = JSON.parse(readFileSync(resolve(toolDir, 'model-field-floors.json'), 'utf8')) as Record<string, { parser: number; built: number }>

function check(input: ModelInput, comparison: Comparison): void {
  compareModel(comparison, input)
  parserCoverage.observe(input)
  const model = JSON.parse(input.json) as { blocks: Array<{ type: string }> }
  for (const [index, block] of model.blocks.entries()) {
    let population = blocks.get(block.type)
    if (!population) {
      population = new Comparison(`(h) typed model, ${block.type} blocks`, `modelBlocks ${block.type}`)
      blocks.set(block.type, population)
    }
    compareModel(population, { ...input, where: `${input.where} block ${index}`, type: 'Block', json: JSON.stringify(block) })
  }
}

export function modelOnDocument(where: string, doc: unknown): void {
  check({ where, population: 'corpus', type: 'ParsedDocFull', json: modelJson(doc) }, corpus)
}

/** Extra parser inputs and direct type values, counted separately from the corpus. */
export async function modelAfterCorpus(): Promise<void> {
  for (const [group, texts] of Object.entries(PROPS_TEXTS)) {
    for (const [index, bodyXml] of texts.entries()) {
      const where = `props ${group} ${index}`
      let doc: unknown
      try { doc = await parseDocx(await buildDocx({ bodyXml, withNumbering: true, withImage: true })) }
      catch (error) { refusals.push({ where, error: String(error) }); continue }
      check({ where, population: 'built', type: 'ParsedDocFull', json: modelJson(doc) }, built)
    }
  }
  // hidden from AI: the documents of hidden-stories.ts, every spelling of the mark and every tag mutation
  for (const story of STORIES) {
    const where = `hidden stories ${story.name}`
    let doc: unknown
    try { doc = await parseDocx(story.docx) }
    catch (error) { refusals.push({ where, error: String(error) }); continue }
    check({ where, population: 'built', type: 'ParsedDocFull', json: modelJson(doc) }, built)
  }
  for (const { name, ...options } of MODEL_BODIES) {
    const where = `model body ${name}`
    let doc: unknown
    try { doc = await parseDocx(await buildModelBody(options)) }
    catch (error) { refusals.push({ where, error: String(error) }); continue }
    check({ where, population: 'built', type: 'ParsedDocFull', json: modelJson(doc) }, built)
  }
  mkdirSync(resolve(toolDir, 'out'), { recursive: true })
  const directory = resolve(toolDir, 'out', `model-tests-${process.pid}`)
  // a process id comes back: what an earlier run captured must not count again
  rmSync(directory, { recursive: true, force: true })
  const result = spawnSync(process.execPath, [
    resolve(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', resolve(toolDir, 'model-capture.config.ts'),
    'parse.test.ts', 'chart-edit.test.ts', 'nested-table-edit.test.ts',
    'table-prop-revisions.test.ts', 'insert-and-layout.test.ts', 'roundtrip.test.ts',
  ], { cwd: repoRoot, env: { ...process.env, DOCX_MODEL_CAPTURE_DIR: directory }, encoding: 'utf8' })
  writeFileSync(resolve(toolDir, 'out/model-capture-tests.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`)
  if (result.status !== 0) {
    failGate()
    console.error('Model test capture failed', result.error ?? result.status)
  } else {
    const captured = await readTestInputs(directory)
    for (const input of captured.inputs) check(input, tests)
    console.log(`(h) test capture: ${captured.calls} calls, ${captured.inputs.length} distinct results, ${captured.refused.length} refusals`)
  }
  for (const input of builtModelInputs()) {
    compareModel(types, input)
    builtCoverage.observe(input)
  }
  for (const input of invalidModelInputs()) compareModel(invalid, input)
}

/**
 * The field floors of this run, parser evidence and schema-built evidence
 * apart. `--write-field-floors` commits them to model-field-floors.json
 * instead of checking against it.
 */
export function reportModel(): void {
  const missingFloors: string[] = []
  if (process.argv.includes('--write-field-floors')) {
    // one field a line, so a floor that moves is one line of a diff
    const lines = [...parserCoverage.fields].map(([name, parsed]) =>
      `  ${JSON.stringify(name)}: { "parser": ${parsed.values}, "built": ${builtCoverage.fields.get(name)?.values ?? 0} }`)
    writeFileSync(resolve(toolDir, 'model-field-floors.json'), `{\n${lines.join(',\n')}\n}\n`)
  } else {
    for (const [name, parsed] of parserCoverage.fields) {
      const floor = fieldFloors[name]
      const built = builtCoverage.fields.get(name)
      if (!floor || parsed.values < floor.parser || !built || built.values < floor.built) missingFloors.push(name)
    }
  }
  if (missingFloors.length > 0 || parserCoverage.refused.length || builtCoverage.refused.length) failGate()
  const report = { parser: parserCoverage.report(), built: builtCoverage.report(), refusals, belowFieldFloor: missingFloors }
  mkdirSync(resolve(toolDir, 'out'), { recursive: true })
  writeFileSync(resolve(toolDir, 'out/model-coverage.json'), JSON.stringify(report, null, 2) + '\n')
  const observed = [...parserCoverage.fields.values()].filter((field) => field.values > 0).length
  console.log(`(h) fields: ${observed}/${parserCoverage.fields.size} from parser results; ${missingFloors.length} below field floors; ${parserCoverage.refused.length + builtCoverage.refused.length} schema refusals; built document refusals ${refusals.length} (${atFloor(refusals.length, 'modelBuiltRefusals')})`)
}
