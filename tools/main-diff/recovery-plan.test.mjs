import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditPlan,
  createRecoveryPlan,
  hash,
  hashBytes,
  scheduleRecovery,
  validateManifest,
} from './recovery-plan.mjs'

const productSha = '375b08bd0e1f7e8432e6514468cc9d25be01b100'
const definitionSha = 'a'.repeat(40)
const identities = {
  original: {
    productSha: '30f303cde7b496bf640aadffcb0b70bf7fb2ad21',
    definitionSha: '7594c1243ef0c2965c202dead1fd983ad7ab77e9',
    runId: '43568242384',
    attempt: 1,
  },
  fullBaseline: {
    productSha: 'f5065c06a52b7ebbe4100da637140da4beb67182',
    definitionSha: '59682c00f070a406f108b47dca592381f57d40fa',
    runId: '43578414343',
    attempt: 1,
  },
  targetedProof: {
    productSha,
    definitionSha: '7d30359f16efc9a117963ae38787dfdbe3e88a39',
    runId: '43591069529',
    attempt: 1,
  },
}

function fixture(lengths) {
  let position = 0
  const catalogs = []
  const entries = lengths.map((length, number) => {
    const path = `tools/main-diff/faults/${number === 0 ? 'b2' : `catalog-${number}`}.json`
    const faults = Array.from({ length }, (_, index) => ({
      name: `${number}-${index}`,
      file: 'source.ts',
      fn: ['group.selector'],
    }))
    const digest = hashBytes(Buffer.from(JSON.stringify(faults)))
    catalogs.push({ path, sha256: digest, faults })
    return {
      path,
      originalSha256: number === 0 ? 'f'.repeat(64) : digest,
      productSha256: digest,
      mutations: faults.map((fault, index) => ({
        index,
        originalSha256: number === 0 && index === 14 ? 'e'.repeat(64) : hash(fault),
        productSha256: hash(fault),
        affectedReasons: position++ < 3834 ? ['affected'] : [],
      })),
    }
  })
  return {
    manifest: {
      contract: 'main-recovery-manifest/v1',
      productSha,
      ...structuredClone(identities),
      catalogs: entries,
    },
    catalogs,
  }
}

const productionFixture = () => fixture([...Array(45).fill(133), 136])
const key = (path, index) => `${path}#${index}`

test('hashes use JSON serialization and raw bytes respectively', () => {
  assert.equal(hash({ a: 1 }), hashBytes(Buffer.from('{"a":1}')))
  assert.equal(
    hashBytes(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('full provisional plan covers each original ID and preserves bounded shard lineage', () => {
  const { manifest, catalogs } = productionFixture()
  const before = structuredClone({ manifest, catalogs })
  assert.equal(validateManifest(manifest, catalogs), true)
  const plan = createRecoveryPlan(manifest, catalogs, { definitionSha })
  assert.deepEqual({ manifest, catalogs }, before)
  assert.deepEqual(plan, createRecoveryPlan(manifest, catalogs, { definitionSha }))
  assert.equal(plan.provisional, true)
  assert.equal(plan.unresolvedOriginalAudit, true)
  assert.equal(plan.requiredIds.length, 6121)
  assert.equal(plan.expandedIds.length, 6121)
  assert.equal(plan.maxParallel, 4)
  assert.equal(plan.timeoutMinutes, 120)
  assert.ok(plan.batches.every((batch) => batch.length <= 256))
  const counts = new Map()
  for (const job of plan.jobs) {
    assert.equal(job.indices[0], 0)
    assert.ok(job.indices.length <= 25)
    assert.equal(job.originalShard, job.residue % 4)
    assert.equal(job.batch, Math.floor(plan.jobs.indexOf(job) / 256))
    for (const index of job.indices.slice(1)) {
      assert.equal(index % job.modulus, job.residue)
      assert.equal(index % 4, job.originalShard)
      const id = key(job.catalog, index)
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  for (const catalog of manifest.catalogs) {
    for (let index = 1; index < catalog.mutations.length; index++)
      assert.equal(counts.get(key(catalog.path, index)), 1)
  }
  assert.equal(counts.size, 6121 - 46)
  assert.equal(auditPlan(plan, manifest, catalogs), true)
  assert.throws(
    () =>
      createRecoveryPlan(manifest, catalogs, {
        definitionSha,
        approvedReuse: [plan.requiredIds[0]],
      }),
    /final original audit not attached/,
  )
})

test('810 entries remain bounded and retain their original indices', () => {
  const { manifest, catalogs } = fixture([810])
  const path = catalogs[0].path
  const scheduled = scheduleRecovery(
    manifest,
    catalogs,
    Array.from({ length: 810 }, (_, index) => key(path, index)),
  )
  assert.equal(scheduled.jobs.length, 36)
  assert.equal(scheduled.expandedIds.length, 810)
  assert.ok(scheduled.jobs.every((job) => job.modulus === 36 && job.indices.length <= 25))
  const noncontrols = scheduled.jobs.flatMap((job) => job.indices.slice(1))
  assert.equal(new Set(noncontrols).size, 809)
  assert.equal(noncontrols.length, 809)
})

test('sparse residue expansion and control-only selection expose all extra IDs', () => {
  const { manifest, catalogs } = fixture([810])
  const path = catalogs[0].path
  const scheduled = scheduleRecovery(manifest, catalogs, [key(path, 1), key(path, 37)])
  assert.equal(scheduled.jobs.length, 1)
  const job = scheduled.jobs[0]
  assert.deepEqual(job.requiredIndices, [1, 37])
  assert.deepEqual(
    job.extraIndices,
    job.indices.filter((index) => index !== 1 && index !== 37),
  )
  assert.equal(scheduled.expandedIds.length, 24)
  const control = scheduleRecovery(manifest, catalogs, [key(path, 0)])
  assert.equal(control.jobs.length, 1)
  assert.equal(control.jobs[0].residue, 0)
  assert.deepEqual(control.jobs[0].requiredIndices, [0])
  assert.throws(() => scheduleRecovery(manifest, catalogs, [key(path, 810)]), /Unknown required ID/)
})

test('production validation rejects modified identity, index, linkage and mutation content', () => {
  for (const change of [
    ({ manifest }) => {
      manifest.original.runId = '1'
    },
    ({ manifest }) => {
      manifest.catalogs[1].mutations[1].index = 2
    },
    ({ manifest }) => {
      manifest.catalogs[1].originalSha256 = 'a'.repeat(64)
    },
    ({ manifest }) => {
      manifest.catalogs[0].mutations[14].affectedReasons = []
    },
    ({ catalogs }) => {
      catalogs[1].faults[3].name = 'shifted'
    },
    ({ catalogs }) => {
      catalogs[1].sha256 = 'a'.repeat(64)
    },
  ]) {
    const data = productionFixture()
    change(data)
    assert.throws(() => validateManifest(data.manifest, data.catalogs))
  }
})

test('audit rejects missing, duplicate, shifted, misattributed and unbounded job evidence', () => {
  const { manifest, catalogs } = productionFixture()
  const plan = createRecoveryPlan(manifest, catalogs, { definitionSha })
  for (const change of [
    (p) => {
      p.jobs.pop()
    },
    (p) => {
      p.jobs[1] = structuredClone(p.jobs[0])
    },
    (p) => {
      p.jobs[0].indices[1]++
    },
    (p) => {
      p.jobs[0].catalog = p.jobs.find((job) => job.catalog !== p.jobs[0].catalog).catalog
    },
    (p) => {
      p.jobs[0].modulus += 4
    },
    (p) => {
      p.jobs[0].indices.shift()
    },
    (p) => {
      p.jobs[0].indices.push(...Array(25).fill(1))
    },
    (p) => {
      p.jobs[0].entryHashes[1].productSha256 = 'b'.repeat(64)
    },
    (p) => {
      p.batches[0].push(p.jobs[0].jobKey)
    },
    (p) => {
      p.productSha = 'b'.repeat(40)
    },
    (p) => {
      p.requiredIds.pop()
    },
  ]) {
    const altered = structuredClone(plan)
    change(altered)
    assert.throws(() => auditPlan(altered, manifest, catalogs))
  }
})
