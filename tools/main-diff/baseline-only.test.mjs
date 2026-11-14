import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditComparison, identity, verifyHeads } from './baseline-only.mjs'

const env = {
  PRODUCT_SHA: '1'.repeat(40),
  DEFINITION_SHA: '2'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
  PROFILE: 'linux',
}
const expected = [
  { group: 'g', name: 'first', checks: 3, single: false },
  { group: 'g', name: 'second', checks: 1, single: true },
]
const complete = () => ({
  g: {
    report: {
      first: { checks: 3, equal: 2, listed: 1, distinct: 2 },
      second: { checks: 1, equal: 1, listed: 0, distinct: 1 },
    },
    differences: [],
  },
})

test('baseline mode refuses refs and mixed fault selections before checkout', () => {
  for (const product of ['main', '1'.repeat(39), 'A'.repeat(40), `${env.PRODUCT_SHA}\n`])
    assert.throws(() => identity({ ...env, PRODUCT_SHA: product }))
  for (const key of [
    'DOCX_FAULTS',
    'ODT_FAULTS',
    'MAIN_FAULTS',
    'FAULT_PRODUCT_SHA',
    'GATE_RUN_ID',
  ])
    assert.throws(() => identity({ ...env, [key]: 'selected' }))
  assert.throws(() => identity({ ...env, ALL_FAULTS: 'true' }))
  assert.throws(() => identity({ ...env, FAULT_SHARDS: '4' }))
})

test('a driver-head run cannot be mistaken for a product-head legacy gate', () => {
  const plan = identity(env)
  assert.equal(plan.legacyFaultGateCompatible, false)
  assert.notEqual(plan.definitionSha, plan.productSha)
  verifyHeads(plan, env.PRODUCT_SHA, env.DEFINITION_SHA)
  assert.throws(() => verifyHeads(plan, env.DEFINITION_SHA, env.DEFINITION_SHA))
  assert.throws(() => verifyHeads(plan, env.PRODUCT_SHA, env.PRODUCT_SHA))
})

test('complete cases account for equality and exact accepted ledger differences', () => {
  assert.deepEqual(auditComparison(expected, complete()), { functions: 2, checks: 4 })
})

test('a missing function or an unexpected function fails completeness', () => {
  const missing = complete()
  delete missing.g.report.second
  assert.throws(() => auditComparison(expected, missing), /Missing function/)
  const extra = complete()
  extra.g.report.other = extra.g.report.second
  assert.throws(() => auditComparison(expected, extra), /Unexpected functions/)
})

test('a missing or duplicated case and an empty inventory fail closed', () => {
  for (const count of [2, 4]) {
    const report = complete()
    report.g.report.first.checks = count
    assert.throws(() => auditComparison(expected, report), /Missing or duplicated cases/)
  }
  assert.throws(() => auditComparison([], {}), /Empty function inventory/)
  assert.throws(
    () => auditComparison([...expected, expected[0]], complete()),
    /Duplicate inventory/,
  )
})

test('unlisted differences, unaccounted cases and a lost answer branch fail', () => {
  const differences = complete()
  differences.g.differences.push({ fn: 'first', case: 0 })
  assert.throws(() => auditComparison(expected, differences), /Unlisted differences/)
  const unaccounted = complete()
  unaccounted.g.report.first.equal = 1
  assert.throws(() => auditComparison(expected, unaccounted), /Unaccounted cases/)
  const floor = complete()
  floor.g.report.first.distinct = 1
  assert.throws(() => auditComparison(expected, floor), /FLOOR/)
})
