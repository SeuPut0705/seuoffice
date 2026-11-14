import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bindLedgerRequirements, selectedGroups } from './recovery-normal-baseline.mjs'
import { runnerModel, originalMutatorSha256 } from './recovery-runner-model.mjs'
import { hash, hashBytes } from './recovery-plan.mjs'

const artifact = JSON.parse(readFileSync(new URL('./recovery-stale-rows.json', import.meta.url)))
const mutator = readFileSync(new URL('./faults.mjs', import.meta.url))

test('selector grouping follows the product last-name-wins list without inventing a selector', () => {
  const faults = [{ fn: ['api.a', 'api.b'] }, { fn: ['api.a'] }]
  assert.deepEqual(selectedGroups('old\tapi.a\nnew\tapi.a\nnew\tapi.b\n', faults), {
    new: ['api.a', 'api.b'],
  })
  assert.throws(() => selectedGroups('new\tapi.a\n', faults), /Unknown selector/)
})

test('actual four ledger requirements bind the exact original object and full tuple', () => {
  const path = 'tools/main-diff/faults/b5-agent-apps.json'
  for (const row of artifact.rows) {
    const faults = []
    faults[row.index] = row.mutation
    const requirement = {
      catalog: path,
      index: row.index,
      mutationSha256: row.mutationSha256,
      name: row.mutation.name,
      selectors: row.mutation.fn,
      ledger: [
        {
          id: row.ledger.id,
          fn: row.ledger.fn,
          case: row.ledger.case,
          tupleSha256: hash({ typescript: row.ledger.typescript, rust: row.ledger.rust }),
        },
      ],
    }
    bindLedgerRequirements([requirement], [row.ledger], { path, faults })
    for (const change of [
      (r) => {
        r.mutationSha256 = 'a'.repeat(64)
      },
      (r) => {
        r.ledger[0].case += 1
      },
      (r) => {
        r.ledger[0].tupleSha256 = 'b'.repeat(64)
      },
      (r) => {
        r.selectors = ['other.fn']
      },
    ]) {
      const changed = structuredClone(requirement)
      change(changed)
      assert.throws(() => bindLedgerRequirements([changed], [row.ledger], { path, faults }))
    }
    assert.throws(() => bindLedgerRequirements([requirement], [], { path, faults }))
    assert.throws(() =>
      bindLedgerRequirements([requirement], [row.ledger, row.ledger], { path, faults }),
    )
  }
})

test('pinned runner source model derives replacement without claiming direct observation', () => {
  const sources = { 'crates/example.rs': 'before target after\n' }
  const sourceBefore = { 'crates/example.rs': hashBytes(sources['crates/example.rs']) }
  const catalog = { faults: [{ file: 'example.rs', find: 'target', replace: 'changed' }] }
  const args = { job: { indices: [0] }, catalog, sources, sourceBefore, mutator }
  const result = runnerModel(args)
  assert.equal(result.mutatorSha256, originalMutatorSha256)
  assert.equal(result.sourceApplication, 'derived-from-pinned-runner-not-directly-observed')
  assert.equal(result.entries[0].derivedAppliedSourceSha256, hashBytes('before changed after\n'))
  assert.throws(() => runnerModel({ ...args, mutator: Buffer.from('different runner') }))
  assert.throws(() =>
    runnerModel({ ...args, sources: { 'crates/example.rs': 'changed original' } }),
  )
  const twice = { 'crates/example.rs': 'target target' }
  assert.throws(
    () =>
      runnerModel({
        ...args,
        sources: twice,
        sourceBefore: { 'crates/example.rs': hashBytes(twice['crates/example.rs']) },
      }),
    /one find/,
  )
})
