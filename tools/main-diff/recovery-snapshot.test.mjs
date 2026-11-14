import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { auditSnapshot } from './recovery-snapshot.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hashText = (value) => createHash('sha256').update(value).digest('hex')
const h = (c) => c.repeat(64)

function fixture() {
  const path = 'tools/main-diff/faults/example.json'
  const original = {
    productSha: 'a'.repeat(40),
    definitionSha: 'b'.repeat(40),
    runId: '12',
    attempt: 1,
  }
  const faults = Array.from({ length: 5 }, (_, i) => ({
    name: `fault ${i}`,
    file: `src/f${i}.rs`,
    find: 'before',
    replace: 'after',
    fn: [`group.fn${i}`],
  }))
  const mutations = faults.map((fault, index) => ({
    index,
    originalSha256: hash(fault),
    productSha256: hash(fault),
    affectedReasons: index === 4 ? ['affected'] : [],
  }))
  const manifest = {
    contract: 'main-recovery-manifest/v1',
    original,
    productSha: 'c'.repeat(40),
    catalogs: [{ path, originalSha256: h('d'), mutations }],
  }
  const catalogs = [{ path, sha256: h('d'), faults }]
  const names = ['Check plan identities', 'Faults', 'Audit fault results', 'Keep the result']
  const jobs = Array.from({ length: 4 }, (_, shard) => ({
    id: 100 + shard,
    name: `main-faults-only (${path}, example, ${shard})`,
    run_id: 12,
    run_attempt: 1,
    head_sha: original.definitionSha,
    status: shard < 2 ? 'completed' : 'queued',
    conclusion: shard === 0 ? 'success' : shard === 1 ? 'cancelled' : null,
    steps: names.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  }))
  const artifact = {
    id: 200,
    name: 'main-faults-only-example-0',
    expired: false,
    digest: `sha256:${h('e')}`,
    workflow_run: { id: 12, head_sha: original.definitionSha },
  }
  const log = `2026-01-01T00:00:00Z [command]/usr/bin/git log -1 --format=%H\n2026-01-01T00:00:00Z ${original.definitionSha}\n2026-01-01T00:00:00Z [command]/usr/bin/git log -1 --format=%H\n2026-01-01T00:00:00Z ${original.productSha}\n`
  const rows = [0, 4].map((i) => ({
    faults: path,
    name: faults[i].name,
    file: faults[i].file,
    fn: faults[i].fn,
    verdict: 'CAUGHT',
    detail: `DIFF group.fn${i} case 0 | 1 checks, 0 equal, 1 differences`,
  }))
  const complete = {
    catalog: path,
    shard: 0,
    jobId: 100,
    artifactId: 200,
    archiveSha256: h('e'),
    logSha256: hashText(log),
    rows,
    identity: {
      definitionSha: original.definitionSha,
      productSha: original.productSha,
      gate: { id: '43554838447', attempt: 1 },
      catalog: path,
      shard: 0,
      count: 2,
    },
    summaryText:
      '2 faults: 2 caught, 0 missed, 0 not building, 0 bad\n    Finished `node-faults` profile in 1s\n',
    completedLog: log,
  }
  const snapshot = {
    contract: 'main-recovery-snapshot/v1',
    capturedAt: '2026-01-01T00:00:00Z',
    original,
    productSha: manifest.productSha,
    manifestBaseSha256: hash(manifest),
    run: {
      id: 12,
      run_attempt: 1,
      head_sha: original.definitionSha,
      status: 'queued',
      event: 'workflow_dispatch',
      path: '.github/workflows/seuoffice-rust.yml',
    },
    jobCount: jobs.length,
    artifactCount: 1,
    jobs,
    artifacts: [artifact],
    complete: [complete],
    incomplete: [
      {
        catalog: path,
        shard: 1,
        jobId: 101,
        status: 'completed',
        conclusion: 'cancelled',
        artifactId: null,
        reason: 'cancelled',
      },
    ],
    reuseIds: [`${path}#0`],
    reusedSourceHashes: { 'crates/src/f0.rs': { originalSha256: h('f'), productSha256: h('f') } },
  }
  return { manifest, snapshot, catalogs, path }
}

test('only complete unaffected same-hash mutations are reusable while the run is queued', () => {
  const f = fixture()
  const result = auditSnapshot(f.manifest, f.snapshot, f.catalogs)
  assert.equal(result.scope, 'fixed-original-completed-snapshot-only')
  assert.deepEqual(result.completeUniqueIds, [`${f.path}#0`, `${f.path}#4`])
  assert.deepEqual(result.affectedCompletedIds, [`${f.path}#4`])
  assert.deepEqual(result.reuseIds, [`${f.path}#0`])
  assert.deepEqual(
    result.requiredIds,
    [1, 2, 3, 4].map((i) => `${f.path}#${i}`),
  )
})

test('rejects metadata omissions, wrong identities and incomplete producer evidence', () => {
  const changes = [
    (f) => {
      f.snapshot.jobCount++
    },
    (f) => {
      f.snapshot.artifactCount++
    },
    (f) => {
      f.snapshot.jobs[1].id = f.snapshot.jobs[0].id
    },
    (f) => {
      f.snapshot.jobs[0].head_sha = 'd'.repeat(40)
    },
    (f) => {
      f.snapshot.jobs[0].steps[1].conclusion = 'failure'
    },
    (f) => {
      f.snapshot.incomplete = []
    },
    (f) => {
      f.snapshot.complete = []
    },
    (f) => {
      f.snapshot.artifacts[0].expired = true
    },
    (f) => {
      f.snapshot.artifacts[0].digest = `sha256:${h('a')}`
    },
    (f) => {
      f.snapshot.complete[0].identity.gate.id = '1'
    },
    (f) => {
      f.snapshot.complete[0].shard = '0'
    },
    (f) => {
      f.snapshot.complete[0].rows.pop()
    },
    (f) => {
      f.snapshot.complete[0].rows[0].verdict = 'MISSED'
    },
    (f) => {
      f.snapshot.complete[0].rows[0].detail = 'DIFF other.fn case 0'
    },
    (f) => {
      f.snapshot.complete[0].rows[0].detail += ' | Error: fatal'
    },
    (f) => {
      f.snapshot.complete[0].rows[0].detail += ' | FLOOR: fewer than two distinct answers'
    },
    (f) => {
      f.snapshot.complete[0].summaryText = '1 faults: 1 caught, 0 missed, 0 not building, 0 bad'
    },
    (f) => {
      f.snapshot.complete[0].summaryText = '2 faults: 2 caught, 0 missed, 0 not building, 0 bad\n'
    },
    (f) => {
      f.snapshot.complete[0].completedLog = `PRODUCT_SHA=${f.manifest.original.productSha}\nDEFINITION_SHA=${f.manifest.original.definitionSha}\n`
      f.snapshot.complete[0].logSha256 = hashText(f.snapshot.complete[0].completedLog)
    },
    (f) => {
      f.snapshot.reuseIds.push(`${f.path}#4`)
    },
    (f) => {
      f.snapshot.reusedSourceHashes['crates/src/f0.rs'].productSha256 = h('a')
    },
    (f) => {
      f.snapshot.reusedSourceHashes['crates/extra.rs'] = {
        originalSha256: h('f'),
        productSha256: h('f'),
      }
    },
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    assert.throws(() => auditSnapshot(f.manifest, f.snapshot, f.catalogs))
  }
})

test('quoted comparison data is not a top-level diagnostic', () => {
  const f = fixture()
  f.snapshot.complete[0].rows[0].detail +=
    ' |   typescript: {"answer":"FLOOR: fewer than two distinct answers | Error: data"}'
  assert.deepEqual(auditSnapshot(f.manifest, f.snapshot, f.catalogs).reuseIds, [`${f.path}#0`])
})

test('a changed original mutation or different product hash cannot be reused', () => {
  const f = fixture()
  f.manifest.catalogs[0].mutations[0].productSha256 = h('a')
  f.snapshot.manifestBaseSha256 = hash(f.manifest)
  f.snapshot.reuseIds = []
  f.snapshot.reusedSourceHashes = {}
  assert.deepEqual(auditSnapshot(f.manifest, f.snapshot, f.catalogs).reuseIds, [])
  f.catalogs[0].faults[0].replace = 'changed'
  assert.throws(() => auditSnapshot(f.manifest, f.snapshot, f.catalogs))
})

test('a function FLOOR summary after a DIFF cannot prove reuse', () => {
  const f = fixture()
  f.snapshot.complete[0].rows[0].detail +=
    ' | group.fn0: 2 checks, 1 differences, 0 listed, 1 distinct  FLOOR: fewer than two distinct answers'
  assert.throws(() => auditSnapshot(f.manifest, f.snapshot, f.catalogs))
})

test('a producer-green job with strict diagnostic failure stays required without blocking other evidence', () => {
  const f = fixture()
  f.snapshot.complete[0].rows[0].detail += ' | STALE ledger entry old: it no longer reproduces'
  f.snapshot.reuseIds = []
  f.snapshot.reusedSourceHashes = {}
  const result = auditSnapshot(f.manifest, f.snapshot, f.catalogs)
  assert.equal(result.successfulProducerJobCount, 1)
  assert.equal(result.completedJobCount, 0)
  assert.equal(result.rejectedEvidence.length, 1)
  assert.deepEqual(result.completeUniqueIds, [])
  assert.deepEqual(result.reuseIds, [])
  assert.deepEqual(
    result.requiredIds,
    [0, 1, 2, 3, 4].map((index) => `${f.path}#${index}`),
  )
})
