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
  assert.equal('snapshotSha256' in plan, false)
  assert.equal('reusedIds' in plan, false)
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

test('planner never accepts unverified snapshot data or arbitrary reuse', () => {
  const { manifest, catalogs } = productionFixture()
  assert.throws(() =>
    createRecoveryPlan(manifest, catalogs, {
      definitionSha,
      snapshot: {},
      originalCatalogs: catalogs,
    }),
  )
  assert.throws(
    () =>
      createRecoveryPlan(manifest, catalogs, {
        definitionSha,
        snapshot: {},
        originalCatalogs: catalogs,
        approvedReuse: [key(catalogs[1].path, 1)],
      }),
    /final original audit not attached/,
  )
  const plan = createRecoveryPlan(manifest, catalogs, { definitionSha })
  assert.throws(() =>
    auditPlan(plan, manifest, catalogs, {
      snapshot: {},
      originalCatalogs: catalogs,
    }),
  )
})

test('fixed snapshot subtracts only proved unaffected IDs and is reaudited', () => {
  const { manifest, catalogs } = productionFixture()
  for (const catalog of catalogs) {
    for (const fault of catalog.faults) Object.assign(fault, { find: 'a', replace: 'b' })
    catalog.sha256 = hashBytes(Buffer.from(JSON.stringify(catalog.faults)))
  }
  const originalCatalogs = structuredClone(catalogs)
  originalCatalogs[0].faults[14].replace = 'original'
  originalCatalogs[0].sha256 = hashBytes(Buffer.from(JSON.stringify(originalCatalogs[0].faults)))
  for (let c = 0; c < catalogs.length; c++) {
    const entry = manifest.catalogs[c]
    entry.originalSha256 = originalCatalogs[c].sha256
    entry.productSha256 = catalogs[c].sha256
    for (let i = 0; i < entry.mutations.length; i++) {
      entry.mutations[i].originalSha256 = hash(originalCatalogs[c].faults[i])
      entry.mutations[i].productSha256 = hash(catalogs[c].faults[i])
    }
  }
  manifest.catalogs[0].mutations[0].affectedReasons = []
  manifest.catalogs[29].mutations[0].affectedReasons = ['affected']
  const original = manifest.original
  const path = catalogs[29].path
  const jobs = manifest.catalogs.flatMap((catalog, c) =>
    Array.from({ length: 4 }, (_, shard) => ({
      id: c * 4 + shard + 1,
      run_id: Number(original.runId),
      run_attempt: original.attempt,
      head_sha: original.definitionSha,
      name: `main-faults-only (${catalog.path}, ${catalog.path.split('/').pop().slice(0, -5)}, ${shard})`,
      status: 'queued',
    })),
  )
  const job = jobs[29 * 4]
  Object.assign(job, {
    status: 'completed',
    conclusion: 'success',
    steps: ['Check plan identities', 'Faults', 'Audit fault results', 'Keep the result'].map(
      (name) => ({ name, status: 'completed', conclusion: 'success' }),
    ),
  })
  const failed = jobs[29 * 4 + 1]
  Object.assign(failed, { status: 'completed', conclusion: 'failure' })
  const selected = originalCatalogs[29].faults
    .map((fault, index) => ({ fault, index }))
    .filter(({ index }) => index === 0 || index % 4 === 0)
  const archiveSha256 = 'a'.repeat(64)
  const completedLog = [original.definitionSha, original.productSha]
    .map((sha) => `time [command]/usr/bin/git log -1 --format=%H\ntime ${sha}`)
    .join('\n')
  const snapshot = {
    contract: 'main-recovery-snapshot/v1',
    capturedAt: '2026-11-14T12:37:43Z',
    original: structuredClone(original),
    productSha,
    manifestBaseSha256: hash(manifest),
    run: {
      id: Number(original.runId),
      run_attempt: original.attempt,
      head_sha: original.definitionSha,
      status: 'queued',
      event: 'workflow_dispatch',
      path: '.github/workflows/seuoffice-rust.yml',
    },
    jobs,
    jobCount: jobs.length,
    artifacts: [
      {
        id: 1000,
        name: 'main-faults-only-catalog-29-0',
        expired: false,
        digest: `sha256:${archiveSha256}`,
        workflow_run: { id: Number(original.runId), head_sha: original.definitionSha },
      },
    ],
    artifactCount: 1,
    complete: [
      {
        catalog: path,
        shard: 0,
        jobId: job.id,
        artifactId: 1000,
        archiveSha256,
        logSha256: hashBytes(Buffer.from(completedLog)),
        completedLog,
        identity: {
          definitionSha: original.definitionSha,
          productSha: original.productSha,
          gate: { id: '43554838447', attempt: 1 },
          catalog: path,
          shard: 0,
          count: selected.length,
        },
        rows: selected.map(({ fault }) => ({
          faults: path,
          name: fault.name,
          file: fault.file,
          fn: fault.fn,
          verdict: 'CAUGHT',
          detail: `DIFF ${fault.fn[0]} case 1`,
        })),
        summaryText: `${selected.length} faults: ${selected.length} caught, 0 missed, 0 not building, 0 bad\nFinished \`node-faults\` profile\n`,
      },
    ],
    incomplete: [
      {
        catalog: path,
        shard: 1,
        jobId: failed.id,
        status: 'completed',
        conclusion: 'failure',
        artifactId: null,
        reason: 'failed',
      },
    ],
    reuseIds: selected
      .slice(1)
      .map(({ index }) => key(path, index))
      .sort(),
    reusedSourceHashes: {
      'crates/source.ts': { originalSha256: 'b'.repeat(64), productSha256: 'b'.repeat(64) },
    },
  }
  const options = { definitionSha, snapshot, originalCatalogs }
  const plan = createRecoveryPlan(manifest, catalogs, options)
  assert.equal(plan.provisional, false)
  assert.equal(plan.unresolvedOriginalAudit, false)
  assert.equal(plan.selectionBasis, 'fixed-completed-snapshot')
  assert.equal(plan.originalRunStillOpenAllowed, true)
  assert.equal(plan.snapshotSha256, hash(snapshot))
  assert.deepEqual(plan.reusedIds, snapshot.reuseIds)
  assert.equal(plan.requiredIds.length, 6121 - 33)
  assert.throws(
    () => createRecoveryPlan(manifest, catalogs, { ...options, approvedReuse: snapshot.reuseIds }),
    /final original audit not attached/,
  )
  assert.ok(plan.requiredIds.includes(key(path, 0)))
  assert.ok(plan.requiredIds.includes(key(path, 1)))
  assert.ok(plan.requiredIds.includes(key(path, 2)))
  assert.ok(!plan.requiredIds.includes(key(path, 4)))
  assert.equal(auditPlan(plan, manifest, catalogs, { snapshot, originalCatalogs }), true)
  assert.throws(() => auditPlan(plan, manifest, catalogs))
  const altered = structuredClone(snapshot)
  altered.complete[0].rows[1].verdict = 'MISSED'
  assert.throws(() => createRecoveryPlan(manifest, catalogs, { ...options, snapshot: altered }))
  assert.throws(() => auditPlan(plan, manifest, catalogs, { snapshot: altered, originalCatalogs }))
  const forged = structuredClone(snapshot)
  forged.reuseIds.push(key(path, 1))
  forged.reuseIds.sort()
  assert.throws(() => createRecoveryPlan(manifest, catalogs, { ...options, snapshot: forged }))
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
