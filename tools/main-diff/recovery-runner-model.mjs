import assert from 'node:assert/strict'
import { hashBytes } from './recovery-plan.mjs'

export const originalMutatorSha256 =
  '5ee0052330c9b76197beb4a4056a1bffdfc2c063f98440f608ebca94644adc5b'

// This is a control-flow model of the pinned, synchronous product runner. It
// does not claim to have observed the faulted source immediately before cargo.
export function runnerModel({ job, catalog, sources, sourceBefore, mutator }) {
  assert.equal(hashBytes(mutator), originalMutatorSha256, 'Product mutator changed')
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(sourceBefore).sort())
  for (const [path, source] of Object.entries(sources))
    assert.equal(hashBytes(source), sourceBefore[path], `Changed committed source ${path}`)
  return {
    kind: 'pinned-original-runner-control-flow',
    mutatorSha256: originalMutatorSha256,
    before: sourceBefore,
    entries: job.indices.map((index) => {
      const fault = catalog.faults[index]
      const path = `crates/${fault.file}`
      const source = sources[path]
      assert.equal(typeof source, 'string', `Missing source ${path}`)
      const findCount = source.split(fault.find).length - 1
      assert.equal(findCount, 1, `Mutation ${index} does not have one find`)
      return {
        index,
        path,
        findCount,
        derivedAppliedSourceSha256: hashBytes(source.replace(fault.find, fault.replace)),
      }
    }),
    sourceApplication: 'derived-from-pinned-runner-not-directly-observed',
  }
}
