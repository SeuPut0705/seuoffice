import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { auditReplay } from './sensitivity-replay.mjs'
const raw = JSON.parse(
  readFileSync(new URL('./fixtures/sensitivity43591069529.json', import.meta.url), 'utf8'),
)
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture() {
  const plan = {
    productSha: raw.provenance.productSha,
    definitionSha: raw.provenance.definitionSha,
    runId: raw.provenance.runId,
    attempt: '1',
    profile: 'node-faults',
    scope: 'targeted-sensitivity-only',
    legacyFaultGateCompatible: false,
    fullBaselineCompatible: false,
    fullFaultRunCompatible: false,
  }
  const inventory = structuredClone(raw.inventory)
  inventory.planSha256 = hash(plan)
  const source = Buffer.from('original source')
  const sourceHash = createHash('sha256').update(source).digest('hex')
  inventory.sources = { source: sourceHash }
  const baselineReport = {
    report: {
      'zod.toJsonSchema': { checks: 118, equal: 118, listed: 0, distinct: 50 },
      'runtime-archive.extractRuntimeArchive': { checks: 82, equal: 82, listed: 0, distinct: 82 },
    },
    differences: [],
  }
  const baselineIdentity = {
    planSha256: hash(plan),
    inventorySha256: hash(inventory),
    sourceSha256: hash(inventory.sources),
    verdict: 'success',
    totals: { functions: 2, checks: 200 },
  }
  const steps = [
    'Validate targeted sensitivity mode',
    'Verify both immutable checkouts',
    'Build exact product WASM',
    'Typecheck central comparison',
    'Inventory original selectors and targeted cases',
    'Normal targeted baseline',
    'Audit normal targeted baseline',
    'Original positive control and mutation 203',
    'Keep targeted sensitivity evidence',
  ].map((name) => ({ name, conclusion: 'success' }))
  steps.push({ name: 'Audit original control and target', conclusion: 'failure' })
  return {
    run: {
      id: 43591069529,
      run_attempt: 1,
      head_sha: raw.provenance.definitionSha,
      path: '.github/workflows/seuoffice-rust.yml',
      status: 'completed',
      conclusion: 'failure',
    },
    jobs: [{ id: 132435712869, name: 'main-targeted-sensitivity', conclusion: 'failure', steps }],
    artifact: { id: raw.provenance.artifactId, name: 'main-targeted-sensitivity' },
    archiveSha256: raw.provenance.archiveSha256,
    plan,
    inventory,
    baselineReport,
    baselineIdentity,
    rows: structuredClone(raw.rows),
    mutantReport: structuredClone(raw.report),
    productSources: { source },
    catalogBytes: readFileSync(new URL('./faults/b5-mcp.json', import.meta.url)),
    log: 'The input was expected to not match the regular expression /FLOOR|STALE|Error|no such group/ RuntimeArchiveError\nat auditMutant (file:///driver/targeted-sensitivity.mjs:139:12)\nat main (file:///driver/targeted-sensitivity.mjs:300:17)',
    originalAuditorSource: 'verifySources(inventory.sources, sources)\nconst proof = auditMutant(',
  }
}
test('replay preserves the failed hosted verdict while proving the exact consumer differences', () => {
  const receipt = auditReplay(fixture(), 'a'.repeat(40))
  assert.equal(receipt.original.hostedConclusion, 'failure')
  assert.deepEqual(
    receipt.proof.differences.map((difference) => difference.case),
    [80, 81],
  )
  assert.equal(receipt.wasmHash, null)
  assert.equal(receipt.fullBaselineCompatible, false)
})
test('replay rejects wrong identities, incomplete producers and unrelated audit failures', () => {
  for (const mutate of [
    (e) => {
      e.run.conclusion = 'success'
    },
    (e) => {
      e.run.run_attempt = 2
    },
    (e) => {
      e.archiveSha256 = 'a'.repeat(64)
    },
    (e) => {
      e.plan.productSha = 'b'.repeat(40)
    },
    (e) => {
      e.jobs[0].steps[7].conclusion = 'failure'
    },
    (e) => {
      e.log = 'some unrelated failure'
    },
    (e) => {
      e.originalAuditorSource =
        'const proof = auditMutant(\nverifySources(inventory.sources, sources)'
    },
    (e) => {
      e.productSources.source = Buffer.from('changed')
    },
    (e) => {
      e.rows[1].verdict = 'MISSED'
    },
    (e) => {
      e.mutantReport.differences[1].case = 80
    },
    (e) => {
      e.baselineReport.report['runtime-archive.extractRuntimeArchive'].checks = 81
    },
  ]) {
    const evidence = fixture()
    mutate(evidence)
    assert.throws(() => auditReplay(evidence, 'a'.repeat(40)))
  }
})
