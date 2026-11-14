import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditBaseline, auditMutant, catalogIdentity } from './targeted-sensitivity.mjs'

const hashBytes = (value) => createHash('sha256').update(value).digest('hex')
const hash = (value) => hashBytes(JSON.stringify(value))
const original = {
  runId: '43591069529',
  attempt: 1,
  definitionSha: '7d30359f16efc9a117963ae38787dfdbe3e88a39',
  productSha: '375b08bd0e1f7e8432e6514468cc9d25be01b100',
  artifactId: 14112519044,
  archiveSha256: '82c5405db05cb57d4dec94de2b07290bae038abbadaa2936c59f66a204e876e7',
}
const producerSteps = [
  'Validate targeted sensitivity mode',
  'Verify both immutable checkouts',
  'Build exact product WASM',
  'Typecheck central comparison',
  'Inventory original selectors and targeted cases',
  'Normal targeted baseline',
  'Audit normal targeted baseline',
  'Original positive control and mutation 203',
  'Keep targeted sensitivity evidence',
]

export function auditReplay(evidence, auditorDefinitionSha) {
  assert.match(auditorDefinitionSha, /^[0-9a-f]{40}$/)
  const {
    run,
    jobs,
    artifact,
    archiveSha256,
    plan,
    inventory,
    baselineReport,
    baselineIdentity,
    rows,
    mutantReport,
    log,
    originalAuditorSource,
    productSources,
    catalogBytes,
  } = evidence
  assert.equal(String(run.id), original.runId)
  assert.equal(run.run_attempt, original.attempt)
  assert.equal(run.head_sha, original.definitionSha)
  assert.equal(run.path, '.github/workflows/seuoffice-rust.yml')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'failure')
  assert.equal(artifact.id, original.artifactId)
  assert.equal(artifact.name, 'main-targeted-sensitivity')
  assert.equal(artifact.workflow_run?.id ?? run.id, run.id)
  assert.equal(archiveSha256, original.archiveSha256)
  const active = jobs.filter((job) => job.conclusion !== 'skipped')
  assert.equal(active.length, 1)
  const job = active[0]
  assert.equal(job.id, 132435712869)
  assert.equal(job.name, 'main-targeted-sensitivity')
  assert.equal(job.conclusion, 'failure')
  for (const name of producerSteps)
    assert.equal(job.steps.find((step) => step.name === name)?.conclusion, 'success', name)
  assert.equal(
    job.steps.find((step) => step.name === 'Audit original control and target')?.conclusion,
    'failure',
  )
  assert.equal(job.steps.filter((step) => step.conclusion === 'failure').length, 1)
  for (const key of ['productSha', 'definitionSha', 'runId']) assert.equal(plan[key], original[key])
  assert.equal(plan.attempt, String(original.attempt))
  assert.equal(plan.profile, 'node-faults')
  assert.equal(plan.scope, 'targeted-sensitivity-only')
  for (const key of [
    'legacyFaultGateCompatible',
    'fullBaselineCompatible',
    'fullFaultRunCompatible',
  ])
    assert.equal(plan[key], false)
  assert.equal(inventory.planSha256, hash(plan))
  assert.deepEqual(inventory.catalog, catalogIdentity(catalogBytes))
  assert.deepEqual(Object.keys(productSources).sort(), Object.keys(inventory.sources).sort())
  for (const [path, bytes] of Object.entries(productSources))
    assert.equal(hashBytes(bytes), inventory.sources[path])
  const totals = auditBaseline(inventory, baselineReport)
  assert.deepEqual(baselineIdentity, {
    planSha256: hash(plan),
    inventorySha256: hash(inventory),
    sourceSha256: hash(inventory.sources),
    verdict: 'success',
    totals,
  })
  const proof = auditMutant(inventory, rows, mutantReport)
  const sourceGuard = originalAuditorSource.indexOf('verifySources(inventory.sources, sources)')
  const mutantCall = originalAuditorSource.indexOf('const proof = auditMutant(')
  assert.ok(
    sourceGuard >= 0 && mutantCall > sourceGuard,
    'Original source restore guard must precede failed typed audit',
  )
  assert.match(
    log,
    /The input was expected to not match the regular expression \/FLOOR\|STALE\|Error\|no such group\//,
  )
  assert.match(log, /RuntimeArchiveError/)
  assert.match(log, /at auditMutant \(file:\/\/[^\n]*targeted-sensitivity\.mjs:139:/)
  assert.match(log, /at main \(file:\/\/[^\n]*targeted-sensitivity\.mjs:300:/)
  return {
    contract: 'main-sensitivity-replay/v1',
    scope: 'targeted-sensitivity-artifact-replay-only',
    original: { ...original, hostedConclusion: 'failure' },
    auditorDefinitionSha,
    baselineIdentity,
    catalog: inventory.catalog,
    cases: inventory.cases,
    sources: inventory.sources,
    proof,
    sourceRestoration: {
      kind: 'original-successful-guard-before-failed-assertion',
      originalAuditorSha256: hashBytes(originalAuditorSource),
      completedLogSha256: hashBytes(log),
      rawRestoredFilesIncluded: false,
    },
    wasmHash: null,
    wasmHashReason:
      'Original final identity was not written and the artifact excludes WASM; recovery must check its actual product WASM against the full baseline separately.',
    legacyFaultGateCompatible: false,
    fullBaselineCompatible: false,
    fullFaultRunCompatible: false,
  }
}

export function replayArchive({ archive, run, jobs, artifact, log, repo, auditorDefinitionSha }) {
  assert.equal(hashBytes(readFileSync(archive)), original.archiveSha256)
  const bytes = (name) => execFileSync('unzip', ['-p', archive, name], { maxBuffer: 64 << 20 })
  const json = (name) => JSON.parse(bytes(name))
  const prefix = 'product/tools/main-diff/out/'
  const out = prefix + 'targeted-sensitivity/'
  const inventory = json(out + 'inventory.json')
  const git = (...args) => execFileSync('git', ['-C', repo, ...args])
  return auditReplay(
    {
      run,
      jobs,
      artifact,
      log,
      archiveSha256: hashBytes(readFileSync(archive)),
      plan: json('sensitivity-plan.json'),
      inventory,
      baselineReport: json(out + 'baseline/report.json'),
      baselineIdentity: json(out + 'baseline-identity.json'),
      rows: json(prefix + 'faults.json'),
      mutantReport: json(out + 'mutants/report.json'),
      originalAuditorSource: git(
        'show',
        `${original.definitionSha}:tools/main-diff/targeted-sensitivity.mjs`,
      ).toString(),
      productSources: Object.fromEntries(
        Object.keys(inventory.sources).map((path) => [
          path,
          git('show', `${original.productSha}:${path}`),
        ]),
      ),
      catalogBytes: git('show', `${original.productSha}:tools/main-diff/faults/b5-mcp.json`),
    },
    auditorDefinitionSha,
  )
}

function main(env) {
  const cwd = process.cwd()
  const git = (...args) => execFileSync('git', args)
  const auditorDefinitionSha = git('rev-parse', 'HEAD').toString().trim()
  const zip = resolve(env.REPLAY_ARCHIVE)
  assert.equal(hashBytes(readFileSync(zip)), original.archiveSha256)
  const bytes = (name) => execFileSync('unzip', ['-p', zip, name], { maxBuffer: 64 << 20 })
  const json = (name) => JSON.parse(bytes(name))
  const prefix = 'product/tools/main-diff/out/'
  const out = prefix + 'targeted-sensitivity/'
  const inventory = json(out + 'inventory.json')
  const artifactPages = JSON.parse(readFileSync(env.REPLAY_ARTIFACT_METADATA, 'utf8'))
  const artifact = artifactPages
    .flatMap((page) => page.artifacts)
    .find((entry) => entry.id === original.artifactId)
  const evidence = {
    run: JSON.parse(readFileSync(env.REPLAY_RUN_METADATA, 'utf8')),
    jobs: JSON.parse(readFileSync(env.REPLAY_JOBS_METADATA, 'utf8')).flatMap((page) => page.jobs),
    artifact,
    archiveSha256: hashBytes(readFileSync(zip)),
    plan: json('sensitivity-plan.json'),
    inventory,
    baselineReport: json(out + 'baseline/report.json'),
    baselineIdentity: json(out + 'baseline-identity.json'),
    rows: json(prefix + 'faults.json'),
    mutantReport: json(out + 'mutants/report.json'),
    log: readFileSync(env.REPLAY_COMPLETED_LOG, 'utf8'),
    originalAuditorSource: git(
      'show',
      `${original.definitionSha}:tools/main-diff/targeted-sensitivity.mjs`,
    ).toString(),
    productSources: Object.fromEntries(
      Object.keys(inventory.sources).map((path) => [
        path,
        git('show', `${original.productSha}:${path}`),
      ]),
    ),
    catalogBytes: git('show', `${original.productSha}:tools/main-diff/faults/b5-mcp.json`),
  }
  const result = auditReplay(evidence, auditorDefinitionSha)
  writeFileSync(resolve(env.REPLAY_RECEIPT), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log(
    JSON.stringify({
      scope: result.scope,
      original: result.original,
      auditorDefinitionSha,
      cases: result.proof.differences.map((difference) => difference.case),
      cwd,
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.env)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
