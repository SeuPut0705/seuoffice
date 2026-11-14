import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditResults,
  createPlan,
  validateGate,
  validateInputs,
  verifyHeads,
} from './faults-only.mjs'

const productSha = 'a'.repeat(40)
const definitionSha = 'b'.repeat(40)
const env = {
  PRODUCT_SHA: productSha,
  DEFINITION_SHA: definitionSha,
  GATE_RUN_ID: '123',
  FAULT_SHARDS: '4',
  DOCX_FAULTS: '',
  ODT_FAULTS: '',
  MAIN_FAULTS: '',
  ALL_FAULTS: 'false',
}
const identity = { productSha, definitionSha, gateId: '123' }
const run = {
  id: 123,
  head_sha: productSha,
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/seuoffice-rust.yml',
  run_attempt: 2,
}
const jobs = [
  {
    name: 'crates',
    status: 'completed',
    conclusion: 'success',
    steps: [{ name: 'Central process comparison', status: 'completed', conclusion: 'success' }],
  },
]
const path = 'tools/main-diff/faults/example.json'
const faults = Array.from({ length: 9 }, (_, i) => ({
  name: `fault ${i}`,
  file: `file${i}.rs`,
  find: `old${i}`,
  replace: `new${i}`,
  fn: [`function${i}`],
}))
const plan = createPlan(identity, { id: '123', attempt: 2 }, [{ path, label: 'example', faults }])
const row = (i) => ({
  faults: path,
  name: faults[i].name,
  file: faults[i].file,
  fn: faults[i].fn,
  verdict: 'CAUGHT',
  detail: '',
})
const indices = [
  [0, 4, 8],
  [0, 1, 5],
  [0, 2, 6],
  [0, 3, 7],
]

test('input conflicts and invalid identities fail closed', () => {
  assert.deepEqual(validateInputs(env), identity)
  for (const key of ['DOCX_FAULTS', 'ODT_FAULTS', 'MAIN_FAULTS'])
    assert.throws(() => validateInputs({ ...env, [key]: 'selected' }))
  for (const override of [
    { ALL_FAULTS: 'true' },
    { ALL_FAULTS: 'yes' },
    { PRODUCT_SHA: 'a'.repeat(39) },
    { DEFINITION_SHA: 'z'.repeat(40) },
    { GATE_RUN_ID: '12x' },
    { FAULT_SHARDS: '8' },
  ]) {
    assert.throws(() => validateInputs({ ...env, ...override }))
  }
  verifyHeads(plan, productSha, definitionSha)
  assert.throws(() => verifyHeads(plan, definitionSha, definitionSha))
  assert.throws(() => verifyHeads(plan, productSha, productSha))
  assert.throws(() => verifyHeads({ ...plan, productSha: 'bad' }, 'bad', definitionSha))
})

test('gate requires the successful comparison in the successful crates job', () => {
  assert.deepEqual(validateGate(run, jobs, identity), { id: '123', attempt: 2 })
  for (const change of [
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
    { head_sha: definitionSha },
    { path: 'other.yml' },
    { id: 124 },
    { run_attempt: 0 },
  ]) {
    assert.throws(() => validateGate({ ...run, ...change }, jobs, identity))
  }
  assert.throws(() => validateGate(run, [], identity))
  assert.throws(() => validateGate(run, [{ ...jobs[0], conclusion: 'failure' }], identity))
  for (const step of [
    undefined,
    { ...jobs[0].steps[0], conclusion: 'skipped' },
    { ...jobs[0].steps[0], status: 'in_progress' },
    { ...jobs[0].steps[0], name: 'Central process comparison on Windows' },
  ]) {
    assert.throws(() => validateGate(run, [{ ...jobs[0], steps: step ? [step] : [] }], identity))
  }
})

test('four shards cover every noncontrol once and repeat the control', () => {
  for (const [shard, selected] of indices.entries()) {
    const result = auditResults(plan, path, String(shard), faults, selected.map(row))
    assert.equal(result.count, selected.length)
    assert.equal(result.shard, shard)
    assert.deepEqual(result.gate, { id: '123', attempt: 2 })
  }
  assert.deepEqual(
    indices
      .flat()
      .filter((i) => i !== 0)
      .sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
  )
})

test('audit rejects all noncaught verdicts and incorrect result sequences', () => {
  const good = indices[1].map(row)
  for (const verdict of ['MISSED', 'BUILD', 'BAD']) {
    for (const index of [0, 1, 2]) {
      const rows = structuredClone(good)
      rows[index].verdict = verdict
      assert.throws(() => auditResults(plan, path, '1', faults, rows))
    }
  }
  const cases = [
    good.slice(1),
    [...good, good[1]],
    [good[0], good[1], good[1]],
    [good[0], row(2), good[2]],
    [good[1], good[0], good[2]],
  ]
  for (const key of ['faults', 'name', 'file', 'fn']) {
    const rows = structuredClone(good)
    rows[1][key] = key === 'fn' ? ['wrong'] : 'wrong'
    cases.push(rows)
  }
  for (const rows of cases) assert.throws(() => auditResults(plan, path, '1', faults, rows))
  assert.throws(() => auditResults(plan, path, '4', faults, good))
  assert.throws(() => auditResults(plan, 'tools/main-diff/faults/other.json', '1', faults, good))
  const changed = structuredClone(faults)
  changed[2].replace = 'changed'
  assert.throws(() => auditResults(plan, path, '1', changed, good))
})

test('empty and ambiguous catalogs are rejected', () => {
  assert.throws(() => createPlan(identity, plan.gate, []))
  assert.throws(() => createPlan(identity, plan.gate, [{ path, label: 'example', faults: [] }]))
  assert.throws(() =>
    createPlan(identity, plan.gate, [{ path, label: 'example', faults: [faults[0], faults[0]] }]),
  )
})

test('larger catalogs start first with deterministic ties and without mutating input order', () => {
  const small = {
    path: 'tools/main-diff/faults/small.json',
    label: 'small',
    faults: faults.slice(0, 2),
  }
  const largeZ = { path: 'tools/main-diff/faults/large-z.json', label: 'large-z', faults }
  const largeA = { path: 'tools/main-diff/faults/large-a.json', label: 'large-a', faults }
  const catalogs = [small, largeZ, largeA]
  const scheduled = createPlan(identity, plan.gate, catalogs)
  assert.deepEqual(
    scheduled.catalogs.map((catalog) => catalog.label),
    ['large-a', 'large-z', 'small'],
  )
  assert.deepEqual(
    catalogs.map((catalog) => catalog.label),
    ['small', 'large-z', 'large-a'],
  )
})
