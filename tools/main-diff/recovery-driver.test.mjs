import assert from 'node:assert/strict'
import test from 'node:test'
import { identity, validateLineage, verifyRun, auditBatch } from './recovery-driver.mjs'
import { auditJob } from './recovery-audit.mjs'
import { hash } from './recovery-plan.mjs'

const productSha = '375b08bd0e1f7e8432e6514468cc9d25be01b100'
const env = {
  MODE: 'main-fault-recovery',
  PRODUCT_SHA: productSha,
  DEFINITION_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  RECOVERY_BATCH: '0',
}

test('recovery rejects mixed modes, wrong products and an unaudited second batch', () => {
  assert.deepEqual(identity(env, { productSha }), {
    definitionSha: env.DEFINITION_SHA,
    productSha,
    runId: '123',
    attempt: 1,
    batch: 0,
  })
  for (const [key, value] of Object.entries({
    MODE: 'baseline-only',
    PRODUCT_SHA: 'main',
    DEFINITION_SHA: 'main',
    GITHUB_RUN_ID: '0',
    GITHUB_RUN_ATTEMPT: '0',
    DOCX_FAULTS: 'x',
    ODT_FAULTS: 'x',
    MAIN_FAULTS: 'x',
    FAULT_PRODUCT_SHA: 'x',
    GATE_RUN_ID: 'x',
    BASELINE_PRODUCT_SHA: 'x',
    SENSITIVITY_PRODUCT_SHA: 'x',
    ALL_FAULTS: 'true',
    FAULT_SHARDS: '4',
    RECOVERY_BATCH: '2',
    PREVIOUS_RUN: '122',
  }))
    assert.throws(() => identity({ ...env, [key]: value }, { productSha }), key)
  assert.throws(() => identity({ ...env, RECOVERY_BATCH: '1' }, { productSha }))
  assert.throws(() =>
    identity({ ...env, RECOVERY_BATCH: '1', PREVIOUS_RUN: '123' }, { productSha }),
  )
  assert.equal(
    identity({ ...env, RECOVERY_BATCH: '1', PREVIOUS_RUN: '122' }, { productSha }).batch,
    1,
  )
})

test('baseline lineage refuses extra source paths and changed bytes', () => {
  const sourceHashes = { 'a.ts': { baselineSha256: 'a'.repeat(64), productSha256: 'b'.repeat(64) } }
  const manifest = { sourceLineage: { allowedPaths: [{ path: 'a.ts', ...sourceHashes['a.ts'] }] } }
  validateLineage(manifest, ['a.ts'], sourceHashes)
  assert.throws(() => validateLineage(manifest, ['a.ts', 'runtime.rs'], sourceHashes))
  assert.throws(() => validateLineage(manifest, [], sourceHashes))
  assert.throws(() =>
    validateLineage(manifest, ['a.ts'], {
      'a.ts': { ...sourceHashes['a.ts'], productSha256: 'c'.repeat(64) },
    }),
  )
})

test('baseline evidence requires exact successful definition run and attempt', () => {
  const expected = { runId: '42', attempt: 1, definitionSha: 'a'.repeat(40) }
  const run = {
    id: 42,
    run_attempt: 1,
    head_sha: expected.definitionSha,
    path: '.github/workflows/seuoffice-rust.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
  }
  verifyRun(run, expected)
  for (const [key, value] of Object.entries({
    id: 43,
    run_attempt: 2,
    head_sha: productSha,
    path: '.github/workflows/ci.yml',
    event: 'push',
    status: 'in_progress',
    conclusion: 'failure',
  }))
    assert.throws(() => verifyRun({ ...run, [key]: value }, expected), key)
})

function fixture() {
  const path = 'tools/main-diff/faults/example.json'
  const faults = [
    {
      name: 'control',
      file: 'main-core/src/example.rs',
      find: 'yes',
      replace: 'no',
      fn: ['example.visible'],
    },
  ]
  const catalog = { path, sha256: 'a'.repeat(64), faults }
  const job = {
    jobKey: `${path}#0/4`,
    catalog: path,
    catalogSha256: catalog.sha256,
    indices: [0],
    entryHashes: [{ index: 0, originalSha256: hash(faults[0]), productSha256: hash(faults[0]) }],
    batch: 0,
  }
  const plan = {
    contract: 'main-fault-recovery/v1',
    definitionSha: env.DEFINITION_SHA,
    productSha,
    manifestSha256: 'b'.repeat(64),
    jobs: [job],
    batches: [[job.jobKey]],
  }
  const evidence = {
    rows: [
      {
        faults: path,
        name: 'control',
        file: faults[0].file,
        fn: faults[0].fn,
        verdict: 'CAUGHT',
        detail: 'DIFF example.visible case 0',
      },
    ],
    text: '1 faults: 1 caught, 0 missed, 0 not building, 0 bad\n',
    sourceBefore: { 'crates/main-core/src/example.rs': 'c'.repeat(64) },
    sourceAfter: { 'crates/main-core/src/example.rs': 'c'.repeat(64) },
    identity: {
      definitionSha: plan.definitionSha,
      productSha,
      manifestSha256: plan.manifestSha256,
      planSha256: hash(plan),
      jobKey: job.jobKey,
      runId: '123',
      attempt: 1,
    },
  }
  return { plan, completion: auditJob(plan, job.jobKey, catalog, evidence) }
}

test('a completed batch is bounded evidence, not a full recovery verdict', () => {
  const { plan, completion } = fixture()
  const result = auditBatch(plan, 0, [completion], '123', 1)
  assert.equal(result.scope, 'recovery-batch-only')
  assert.equal(result.completions.length, 1)
  assert.throws(() => auditBatch(plan, 0, [], '123', 1))
  assert.throws(() => auditBatch(plan, 0, [completion, completion], '123', 1))
  assert.throws(() => auditBatch(plan, 0, [completion], '124', 1))
  assert.throws(() => auditBatch(plan, 0, [completion], '123', 2))
  const changed = structuredClone(completion)
  changed.evidence.rows[0].verdict = 'MISSED'
  assert.throws(() => auditBatch(plan, 0, [changed], '123', 1))
})
