import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditComparison } from './baseline-only.mjs'
import { validateSelectors } from './targeted-sensitivity.mjs'
import { auditPlan, createRecoveryPlan, hash, hashBytes } from './recovery-plan.mjs'
import { bindSnapshotEvidence } from './recovery-snapshot-host.mjs'
import { auditJob, mergeCompletions } from './recovery-audit.mjs'
import { replayArchive } from './sensitivity-replay.mjs'

const self = fileURLToPath(import.meta.url)
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args])
const output = (env, key, value) => {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

export function identity(env, manifest) {
  assert.equal(env.MODE, 'main-fault-recovery')
  assert.match(env.DEFINITION_SHA ?? '', /^[0-9a-f]{40}$/)
  assert.equal(env.PRODUCT_SHA, manifest.productSha)
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
    assert.match(env[key] ?? '', /^[1-9][0-9]*$/)
  for (const key of [
    'DOCX_FAULTS',
    'ODT_FAULTS',
    'MAIN_FAULTS',
    'FAULT_PRODUCT_SHA',
    'GATE_RUN_ID',
    'BASELINE_PRODUCT_SHA',
    'SENSITIVITY_PRODUCT_SHA',
  ])
    assert.equal((env[key] ?? '').trim(), '', `${key} conflicts with recovery`)
  assert.ok(['', 'false'].includes(env.ALL_FAULTS ?? ''))
  assert.ok(['', '1'].includes(env.FAULT_SHARDS ?? ''))
  assert.match(env.RECOVERY_BATCH ?? '', /^(0|1)$/)
  const batch = Number(env.RECOVERY_BATCH)
  if (batch === 0) assert.equal(env.PREVIOUS_RUN ?? '', '')
  else {
    assert.match(env.PREVIOUS_RUN ?? '', /^[1-9][0-9]*$/)
    assert.notEqual(env.PREVIOUS_RUN, env.GITHUB_RUN_ID)
  }
  return {
    definitionSha: env.DEFINITION_SHA,
    productSha: env.PRODUCT_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    batch,
  }
}

export function validateLineage(manifest, changedPaths, sourceHashes) {
  const entries = manifest.sourceLineage.allowedPaths
  assert.deepEqual(
    [...changedPaths].sort(),
    entries.map((e) => e.path).sort(),
    'Product delta exceeds reviewed baseline lineage',
  )
  assert.deepEqual(Object.keys(sourceHashes).sort(), entries.map((e) => e.path).sort())
  for (const entry of entries)
    assert.deepEqual(
      sourceHashes[entry.path],
      { baselineSha256: entry.baselineSha256, productSha256: entry.productSha256 },
      `Unreviewed lineage bytes: ${entry.path}`,
    )
}

export function verifyRun(run, expected) {
  assert.equal(String(run.id), expected.runId)
  assert.equal(run.run_attempt, expected.attempt)
  assert.equal(run.head_sha, expected.definitionSha)
  assert.equal(run.path, '.github/workflows/seuoffice-rust.yml')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
}

async function github(path, env) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}` },
  })
  assert.ok(response.ok, `GitHub ${path}: ${response.status}`)
  return response.json()
}

async function runEvidence(expected, env, jobNames) {
  const run = await github(`actions/runs/${expected.runId}/attempts/${expected.attempt}`, env)
  verifyRun(run, expected)
  const jobs = []
  for (let page = 1; ; page++) {
    const response = await github(
      `actions/runs/${expected.runId}/attempts/${expected.attempt}/jobs?per_page=100&page=${page}`,
      env,
    )
    jobs.push(...response.jobs)
    if (response.jobs.length < 100) break
  }
  const active = jobs.filter((job) => job.conclusion !== 'skipped')
  assert.deepEqual(active.map((job) => job.name).sort(), [...jobNames].sort())
  for (const job of active)
    assert.ok(
      job.status === 'completed' && job.conclusion === 'success',
      `Incomplete evidence job ${job.name}`,
    )
  return {
    runId: expected.runId,
    attempt: expected.attempt,
    definitionSha: expected.definitionSha,
    jobs: active
      .map((job) => ({ id: job.id, name: job.name, conclusion: job.conclusion }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function baselineEvidence(root, manifest) {
  const lanes = {}
  for (const profile of ['linux', 'windows']) {
    const dir = join(root, `main-baseline-only-${profile}`)
    const out = join(dir, 'product/tools/main-diff/out')
    const plan = json(join(dir, 'baseline-plan.json'))
    const receipt = json(join(out, 'identity.json'))
    for (const value of [plan, receipt]) {
      for (const key of ['productSha', 'definitionSha', 'runId', 'attempt'])
        assert.equal(String(value[key]), String(manifest.fullBaseline[key]))
      assert.equal(value.profile, profile)
      assert.equal(value.legacyFaultGateCompatible, false)
    }
    assert.deepEqual(json(join(out, 'plan.json')), plan)
    assert.equal(receipt.comparisonVerdict, 'success')
    const inventory = json(join(out, 'inventory.json'))
    const totals = {}
    for (const [lane, selected] of Object.entries(inventory)) {
      assert.ok(
        (profile === 'linux' && lane === 'linux') ||
          (profile === 'windows' && ['windows-filtered', 'windows-node-fs'].includes(lane)),
      )
      const report = json(join(out, lane, 'report.json'))
      totals[lane] = auditComparison(
        selected,
        lane === 'windows-node-fs' ? { 'node-fs': report } : report,
      )
    }
    assert.deepEqual(
      totals,
      profile === 'linux'
        ? { linux: { functions: 2327, checks: 52688 } }
        : {
            'windows-filtered': { functions: 4, checks: 29 },
            'windows-node-fs': { functions: 10, checks: 64 },
          },
    )
    assert.deepEqual(receipt.totals, totals)
    assert.match(receipt.wasmSha256, /^[0-9a-f]{64}$/)
    lanes[profile] = {
      receiptSha256: hash(receipt),
      inventorySha256: hash(inventory),
      totals,
      wasmSha256: receipt.wasmSha256,
    }
  }
  return lanes
}

async function proofReplay(manifest, env, product, definitionSha) {
  const expected = manifest.targetedProof
  const run = await github(`actions/runs/${expected.runId}/attempts/${expected.attempt}`, env)
  const jobs = []
  for (let page = 1; ; page++) {
    const response = await github(
      `actions/runs/${expected.runId}/attempts/${expected.attempt}/jobs?per_page=100&page=${page}`,
      env,
    )
    jobs.push(...response.jobs)
    if (response.jobs.length < 100) break
  }
  const artifact = await github('actions/artifacts/14112519044', env)
  const download = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
    })
    assert.ok(response.ok, `GitHub binary evidence ${path}: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const archive = resolve('targeted-replay.zip')
  writeFileSync(archive, await download('actions/artifacts/14112519044/zip'), { flag: 'wx' })
  const log = (await download('actions/jobs/132435712869/logs')).toString()
  save(resolve('targeted-original-run.json'), run)
  save(resolve('targeted-original-jobs.json'), jobs)
  save(resolve('targeted-original-artifact.json'), artifact)
  writeFileSync(resolve('targeted-original.log'), log, { flag: 'wx' })
  const receipt = replayArchive({
    archive,
    run,
    jobs,
    artifact,
    log,
    repo: product,
    auditorDefinitionSha: definitionSha,
  })
  save(resolve('targeted-replay-receipt.json'), receipt)
  return receipt
}

function sourceHashes(product, paths, expected = false) {
  return Object.fromEntries(
    [...paths]
      .sort()
      .map((path) => [
        path,
        hashBytes(
          expected ? git(product, 'show', `HEAD:${path}`) : readFileSync(join(product, path)),
        ),
      ]),
  )
}

function loadCatalogs(product, manifest) {
  return manifest.catalogs.map(({ path }) => {
    const bytes = readFileSync(join(product, path))
    assert.equal(hashBytes(bytes), hashBytes(git(product, 'show', `HEAD:${path}`)))
    return { path, sha256: hashBytes(bytes), faults: JSON.parse(bytes) }
  })
}

function snapshotOptions(driver, manifest, catalogs) {
  if (!manifest.reuseSnapshot) return {}
  assert.equal(manifest.reuseSnapshot.path, 'tools/main-diff/recovery-snapshot.json')
  const bytes = readFileSync(join(driver, manifest.reuseSnapshot.path))
  assert.equal(hashBytes(bytes), manifest.reuseSnapshot.sha256)
  const snapshot = JSON.parse(bytes)
  assert.equal(snapshot.capturedAt, manifest.reuseSnapshot.capturedAt)
  const originalCatalogs = catalogs.map((catalog) => {
    const expected = manifest.catalogs.find((entry) => entry.path === catalog.path)
    const faults = structuredClone(catalog.faults)
    for (const mutation of expected.mutations) {
      if (mutation.originalSha256 !== mutation.productSha256) {
        assert.equal(catalog.path, manifest.selectorLineage.catalog)
        assert.equal(mutation.index, manifest.selectorLineage.index)
        faults[mutation.index].fn = manifest.selectorLineage.originalSelectors
      }
      assert.equal(hash(faults[mutation.index]), mutation.originalSha256)
    }
    return { path: catalog.path, sha256: expected.originalSha256, faults }
  })
  return { snapshot, originalCatalogs }
}

function bindCompletion(plan, completion, catalogs, product, receiptSha256) {
  const catalog = catalogs.find((c) => c.path === completion.catalog?.path)
  assert.ok(catalog)
  assert.deepEqual(completion.catalog, catalog)
  const paths = Object.keys(completion.evidence.sourceBefore)
  assert.deepEqual(completion.evidence.sourceBefore, sourceHashes(product, paths, true))
  assert.equal(completion.identity.baselineReceiptSha256, receiptSha256)
  assert.deepEqual(completion.identity.buildEnvironment, {
    profile: 'node-faults',
    cargoIncremental: '1',
  })
  assert.deepEqual(
    auditJob(plan, completion.identity.jobKey, catalog, completion.evidence),
    completion,
  )
}

export function auditBatch(plan, batch, completions, runId, attempt) {
  assert.ok(Number.isSafeInteger(batch) && Array.isArray(plan.batches[batch]))
  const expected = plan.batches[batch]
  assert.deepEqual(
    completions.map((c) => c.identity.jobKey).sort(),
    [...expected].sort(),
    'Incomplete or duplicate batch job set',
  )
  for (const completion of completions) {
    assert.equal(String(completion.identity.runId), String(runId))
    assert.equal(Number(completion.identity.attempt), Number(attempt))
    assert.deepEqual(
      auditJob(plan, completion.identity.jobKey, completion.catalog, completion.evidence),
      completion,
    )
  }
  return {
    scope: 'recovery-batch-only',
    definitionSha: plan.definitionSha,
    productSha: plan.productSha,
    planSha256: hash(plan),
    manifestSha256: plan.manifestSha256,
    runId: String(runId),
    attempt: Number(attempt),
    batch,
    completions,
  }
}

async function main(command, env) {
  const driver = resolve(env.DRIVER_DIR ?? 'driver')
  const product = resolve(env.PRODUCT_DIR ?? 'product')
  const manifest = json(join(driver, 'tools/main-diff/recovery-manifest.json'))
  const current = identity(env, manifest)
  assert.equal(git(driver, 'rev-parse', 'HEAD').toString().trim(), current.definitionSha)
  if (command === 'validate') {
    output(env, 'product_sha', current.productSha)
    return
  }
  assert.equal(git(product, 'rev-parse', 'HEAD').toString().trim(), current.productSha)
  const catalogs = loadCatalogs(product, manifest)
  const selection = snapshotOptions(driver, manifest, catalogs)
  const plan = createRecoveryPlan(manifest, catalogs, {
    definitionSha: current.definitionSha,
    ...selection,
  })
  auditPlan(plan, manifest, catalogs, selection)
  const planPath = resolve(env.PLAN_PATH ?? 'recovery-plan.json')
  const receiptPath = resolve(env.RECEIPT_PATH ?? 'recovery-baseline-receipt.json')
  assert.ok(plan.batches[current.batch], 'Unknown manifest batch')
  if (command === 'prepare') {
    const changes = git(
      product,
      'diff',
      '--name-only',
      manifest.fullBaseline.productSha,
      current.productSha,
    )
      .toString()
      .trim()
      .split('\n')
    const lineage = Object.fromEntries(
      manifest.sourceLineage.allowedPaths.map((entry) => [
        entry.path,
        {
          baselineSha256:
            entry.baselineSha256 === null
              ? null
              : hashBytes(
                  git(product, 'show', `${manifest.fullBaseline.productSha}:${entry.path}`),
                ),
          productSha256: hashBytes(git(product, 'show', `${current.productSha}:${entry.path}`)),
        },
      ]),
    )
    validateLineage(manifest, changes, lineage)
    for (const catalog of manifest.catalogs) {
      const bytes = git(product, 'show', `${manifest.original.productSha}:${catalog.path}`)
      assert.equal(hashBytes(bytes), catalog.originalSha256)
      const original = JSON.parse(bytes)
      assert.equal(original.length, catalog.mutations.length)
      for (const row of catalog.mutations)
        assert.equal(hash(original[row.index]), row.originalSha256)
    }
    const fullRun = await runEvidence(manifest.fullBaseline, env, [
      'main-baseline-only (ubuntu-latest, linux)',
      'main-baseline-only (windows-latest, windows)',
    ])
    const lanes = baselineEvidence(resolve(env.FULL_BASELINE_DIR ?? 'full-baseline'), manifest)
    const targetedReplay = await proofReplay(manifest, env, product, current.definitionSha)
    assert.ok(selection.snapshot, 'A fixed completed snapshot is required for recovery dispatch')
    const snapshotReceipt = await bindSnapshotEvidence(
      manifest,
      selection.snapshot,
      selection.originalCatalogs,
      {
        archiveDir: resolve('snapshot-verification'),
        sourceAt: (ref, path) => git(product, 'show', `${ref}:${path}`),
        request: async (path) => {
          const response = await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`,
            { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` } },
          )
          assert.ok(response.ok, `Original snapshot evidence ${path}: ${response.status}`)
          return Buffer.from(await response.arrayBuffer())
        },
      },
    )
    save(resolve('snapshot-verification-receipt.json'), snapshotReceipt)
    const receipt = {
      scope: 'explicit-f506-full-plus-375-targeted-replay-lineage',
      fullBaseline: manifest.fullBaseline,
      targetedProof: manifest.targetedProof,
      fullRun,
      lanes,
      targetedReplay,
      lineage,
      snapshotReceipt,
      legacyFaultGateCompatible: false,
    }
    if (current.batch > 0) {
      const previous = json(
        resolve(env.PREVIOUS_BATCH_PATH ?? 'previous-batch/batch-completion.json'),
      )
      verifyRun(await github(`actions/runs/${env.PREVIOUS_RUN}`, env), {
        runId: env.PREVIOUS_RUN,
        attempt: previous.attempt,
        definitionSha: current.definitionSha,
      })
      assert.equal(previous.batch, current.batch - 1)
      assert.equal(previous.planSha256, hash(plan))
      for (const completion of previous.completions)
        bindCompletion(plan, completion, catalogs, product, hash(receipt))
      assert.deepEqual(
        previous,
        auditBatch(
          plan,
          current.batch - 1,
          previous.completions,
          env.PREVIOUS_RUN,
          previous.attempt,
        ),
      )
    }
    save(planPath, plan)
    save(receiptPath, receipt)
    output(
      env,
      'matrix',
      JSON.stringify({
        include: plan.jobs
          .filter((job) => job.batch === current.batch)
          .map((job) => ({
            jobKey: job.jobKey,
            slug: job.slug,
            residue: job.residue,
            modulus: job.modulus,
          })),
      }),
    )
    output(env, 'batch', String(current.batch))
    output(env, 'product_sha', current.productSha)
    console.log(
      JSON.stringify({
        provisional: plan.provisional,
        batch: current.batch,
        jobs: plan.batches[current.batch].length,
        required: plan.requiredIds.length,
        expanded: plan.expandedIds.length,
        manifestSha256: plan.manifestSha256,
        planSha256: hash(plan),
      }),
    )
    return
  }
  assert.deepEqual(json(planPath), plan)
  const receipt = json(receiptPath)
  assert.deepEqual(receipt.fullBaseline, manifest.fullBaseline)
  assert.deepEqual(receipt.targetedProof, manifest.targetedProof)
  if (command === 'aggregate') {
    const root = resolve(env.COMPLETIONS_DIR ?? 'completions')
    const completions = readdirSync(root).map((name) => json(join(root, name, 'completion.json')))
    for (const completion of completions)
      bindCompletion(plan, completion, catalogs, product, hash(receipt))
    const batch = auditBatch(plan, current.batch, completions, current.runId, current.attempt)
    save(resolve(env.BATCH_PATH ?? 'batch-completion.json'), batch)
    if (current.batch === plan.batches.length - 1) {
      const previous =
        current.batch > 0
          ? json(resolve(env.PREVIOUS_BATCH_PATH ?? 'previous-batch/batch-completion.json'))
              .completions
          : []
      for (const completion of previous)
        bindCompletion(plan, completion, catalogs, product, hash(receipt))
      save(
        resolve(env.COMPLETE_PATH ?? 'recovery-complete.json'),
        mergeCompletions(plan, [...previous, ...completions]),
      )
    }
    return
  }
  const job = plan.jobs.find((j) => j.jobKey === env.JOB_KEY && j.batch === current.batch)
  assert.ok(job, 'Unknown job for batch')
  const out = resolve(env.JOB_OUT ?? 'job-out')
  assert.equal(env.MAIN_DIFF_PROFILE, 'node-faults')
  assert.equal(env.CARGO_INCREMENTAL, '1')
  const buildEnvironment = {
    profile: env.MAIN_DIFF_PROFILE,
    cargoIncremental: env.CARGO_INCREMENTAL,
  }
  if (command === 'job-prepare') {
    assert.equal(env.MAIN_DIFF_PROFILE, 'node-faults')
    assert.equal(hashBytes(readFileSync(env.SEUOFFICE_WASM)), receipt.lanes.linux.wasmSha256)
    const list = execFileSync(
      process.execPath,
      [
        join(product, 'node_modules/tsx/dist/cli.mjs'),
        join(product, 'tools/main-diff/main.ts'),
        '--list',
      ],
      { cwd: product, encoding: 'utf8', maxBuffer: 64 << 20, env },
    )
    validateSelectors(list, catalogs)
    const paths = [
      ...new Set(
        job.indices.map(
          (index) => `crates/${catalogs.find((c) => c.path === job.catalog).faults[index].file}`,
        ),
      ),
    ]
    const before = sourceHashes(product, paths)
    assert.deepEqual(before, sourceHashes(product, paths, true))
    mkdirSync(out, { recursive: true })
    save(join(out, 'source-before.json'), before)
    save(join(out, 'job-identity.json'), {
      ...current,
      jobKey: job.jobKey,
      planSha256: hash(plan),
      manifestSha256: plan.manifestSha256,
      baselineReceiptSha256: hash(receipt),
      buildEnvironment,
    })
    output(env, 'fault_shard', `${job.residue}/${job.modulus}`)
    output(env, 'catalog', job.catalog)
    return
  }
  assert.equal(command, 'audit-job', 'Unknown recovery command')
  copyFileSync(join(product, 'tools/main-diff/out/faults.json'), join(out, 'faults.json'))
  const before = json(join(out, 'source-before.json'))
  assert.deepEqual(before, sourceHashes(product, Object.keys(before), true))
  const evidence = {
    rows: json(join(product, 'tools/main-diff/out/faults.json')),
    text: readFileSync(join(out, 'faults.txt'), 'utf8'),
    sourceBefore: before,
    sourceAfter: sourceHashes(product, Object.keys(before)),
    identity: json(join(out, 'job-identity.json')),
  }
  assert.deepEqual(evidence.identity, {
    ...current,
    jobKey: job.jobKey,
    planSha256: hash(plan),
    manifestSha256: plan.manifestSha256,
    baselineReceiptSha256: hash(receipt),
    buildEnvironment,
  })
  save(
    join(out, 'completion.json'),
    auditJob(
      plan,
      job.jobKey,
      catalogs.find((c) => c.path === job.catalog),
      evidence,
    ),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === self)
  main(process.argv[2], process.env).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
