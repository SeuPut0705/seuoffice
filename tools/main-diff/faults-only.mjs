// A driver definition and the product it tests are separate immutable commits.
// The green product gate supplies the baseline; this plan covers every catalog.
// Audit every expected row because faults.mjs may exit zero after a noncontrol miss.

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

const workflow = '.github/workflows/seuoffice-rust.yml'
const catalogDir = 'tools/main-diff/faults'
const shaPattern = /^[0-9a-f]{40}$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

export function validateInputs(env) {
  requireValue(shaPattern.test(env.PRODUCT_SHA ?? ''), 'PRODUCT_SHA must be a full lowercase SHA')
  requireValue(
    shaPattern.test(env.DEFINITION_SHA ?? ''),
    'DEFINITION_SHA must be a full lowercase SHA',
  )
  requireValue(
    /^[1-9][0-9]*$/.test(env.GATE_RUN_ID ?? ''),
    'GATE_RUN_ID must be a positive numeric run ID',
  )
  requireValue(env.FAULT_SHARDS === '4', 'FAULT_SHARDS must be 4')
  for (const key of ['DOCX_FAULTS', 'ODT_FAULTS', 'MAIN_FAULTS']) {
    requireValue(!(env[key] ?? '').trim(), `${key} must be empty`)
  }
  requireValue(
    ['', 'false'].includes((env.ALL_FAULTS ?? '').trim()),
    'ALL_FAULTS must be false or empty',
  )
  return { definitionSha: env.DEFINITION_SHA, productSha: env.PRODUCT_SHA, gateId: env.GATE_RUN_ID }
}

export function validateGate(run, jobs, { productSha, gateId }) {
  requireValue(
    String(run.id) === gateId && run.head_sha === productSha,
    'Gate identity or product SHA does not match',
  )
  requireValue(
    run.status === 'completed' && run.conclusion === 'success',
    'Gate is not completed successfully',
  )
  requireValue(run.path === workflow, 'Gate workflow path does not match')
  requireValue(
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
    'Gate attempt is invalid',
  )
  const crates = jobs.filter((job) => job.name === 'crates')
  requireValue(
    crates.length === 1 && crates[0].status === 'completed' && crates[0].conclusion === 'success',
    'Successful crates job is missing',
  )
  const steps = crates[0].steps?.filter((step) => step.name === 'Central process comparison') ?? []
  requireValue(
    steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success',
    'Successful Central process comparison is missing',
  )
  return { id: gateId, attempt: run.run_attempt }
}

function validateCatalog(path, faults) {
  requireValue(/^tools\/main-diff\/faults\/[^/]+\.json$/.test(path), 'Invalid catalog path')
  requireValue(Array.isArray(faults) && faults.length > 0, `Empty or invalid catalog: ${path}`)
  const keys = new Set()
  for (const fault of faults) {
    requireValue(
      fault &&
        typeof fault.name === 'string' &&
        fault.name.length > 0 &&
        typeof fault.file === 'string' &&
        fault.file.length > 0 &&
        typeof fault.find === 'string' &&
        fault.find.length > 0 &&
        typeof fault.replace === 'string' &&
        Array.isArray(fault.fn) &&
        fault.fn.length > 0 &&
        fault.fn.every((fn) => typeof fn === 'string' && fn.length > 0),
      `Invalid fault in ${path}`,
    )
    const key = JSON.stringify([fault.name, fault.file, fault.fn])
    requireValue(!keys.has(key), `Duplicate fault identity in ${path}`)
    keys.add(key)
  }
}

export function createPlan(identity, gate, catalogs) {
  requireValue(catalogs.length > 0, 'No fault catalogs found')
  for (const catalog of catalogs) validateCatalog(catalog.path, catalog.faults)
  return {
    definitionSha: identity.definitionSha,
    productSha: identity.productSha,
    gate,
    shards: 4,
    // Counts are only a cost proxy; product-catalog runtimes are unmeasured.
    catalogs: catalogs.toSorted(
      (a, b) =>
        b.faults.length - a.faults.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    ),
  }
}

export function verifyHeads(plan, productHead, definitionHead) {
  requireValue(
    shaPattern.test(plan.productSha ?? '') && shaPattern.test(plan.definitionSha ?? ''),
    'Invalid plan SHA',
  )
  requireValue(
    plan.productSha === productHead && plan.definitionSha === definitionHead,
    'Checkout HEAD does not match plan identity',
  )
}

export function auditResults(plan, catalogPath, shard, currentFaults, rows) {
  requireValue(plan.shards === 4 && /^[0-3]$/.test(String(shard)), 'Invalid shard')
  requireValue(Array.isArray(plan.catalogs), 'Invalid plan catalogs')
  const matches = plan.catalogs.filter((catalog) => catalog.path === catalogPath)
  requireValue(matches.length === 1, 'Catalog is not uniquely present in plan')
  const catalog = matches[0]
  validateCatalog(catalog.path, catalog.faults)
  requireValue(isDeepStrictEqual(catalog.faults, currentFaults), 'Catalog changed since planning')
  const expected = catalog.faults.filter((_, i) => i === 0 || i % 4 === Number(shard))
  requireValue(
    Array.isArray(rows) && rows.length === expected.length,
    'Result count does not match shard',
  )
  for (let i = 0; i < expected.length; i++) {
    const row = rows[i]
    const fault = expected[i]
    requireValue(
      row &&
        row.faults === catalogPath &&
        row.name === fault.name &&
        row.file === fault.file &&
        isDeepStrictEqual(row.fn, fault.fn) &&
        row.verdict === 'CAUGHT',
      `Invalid result at index ${i}`,
    )
  }
  return {
    definitionSha: plan.definitionSha,
    productSha: plan.productSha,
    gate: plan.gate,
    catalog: catalogPath,
    shard: Number(shard),
    count: expected.length,
  }
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'seuoffice-faults-only',
    },
  })
  requireValue(response.ok, `GitHub API request failed (${response.status})`)
  return response.json()
}

async function main(command, env) {
  const productDir = resolve(env.PRODUCT_DIR ?? 'product')
  const driverDir = resolve(env.DRIVER_DIR ?? 'driver')
  const planPath = resolve(env.PLAN_PATH ?? 'plan.json')
  if (command === 'plan') {
    const identity = validateInputs(env)
    verifyHeads(identity, head(productDir), head(driverDir))
    requireValue(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? ''),
      'Invalid GITHUB_REPOSITORY',
    )
    requireValue(Boolean(env.GH_TOKEN), 'GH_TOKEN is required')
    const base = `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${identity.gateId}`
    const run = await github(base, env.GH_TOKEN)
    requireValue(
      Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
      'Gate attempt is invalid',
    )
    const jobs = []
    for (let page = 1; ; page++) {
      const result = await github(
        `${base}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
        env.GH_TOKEN,
      )
      requireValue(Array.isArray(result.jobs), 'Invalid GitHub jobs response')
      jobs.push(...result.jobs)
      if (result.jobs.length < 100) break
    }
    const gate = validateGate(run, jobs, identity)
    const dir = join(productDir, catalogDir)
    const catalogs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => {
        requireValue(entry.isFile(), `Catalog is not a regular file: ${entry.name}`)
        const path = `${catalogDir}/${entry.name}`
        return {
          path,
          label: basename(entry.name, '.json'),
          faults: JSON.parse(readFileSync(join(productDir, path), 'utf8')),
        }
      })
    const plan = createPlan(identity, gate, catalogs)
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' })
    const matrix = plan.catalogs.map(({ path, label }) => ({ path, label }))
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `catalogs=${JSON.stringify(matrix)}\n`)
    const summary = `Definition SHA: ${plan.definitionSha}\nProduct SHA: ${plan.productSha}\nGate: ${gate.id} attempt ${gate.attempt}\nCatalogs: ${catalogs.length}\nFaults: ${catalogs.reduce((n, c) => n + c.faults.length, 0)}\nMatrix creation order: descending fault-count proxy; actual start order is not guaranteed; product-catalog seconds unmeasured\n`
    console.log(summary)
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
  } else if (command === 'check' || command === 'audit') {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    verifyHeads(plan, head(productDir), head(driverDir))
    if (command === 'audit') {
      requireValue(
        typeof env.CATALOG === 'string' &&
          /^tools\/main-diff\/faults\/[^/]+\.json$/.test(env.CATALOG),
        'Invalid CATALOG',
      )
      requireValue(typeof env.SHARD === 'string' && /^[0-3]$/.test(env.SHARD), 'Invalid SHARD')
      const faults = JSON.parse(readFileSync(join(productDir, env.CATALOG), 'utf8'))
      const out = join(productDir, 'tools/main-diff/out')
      const rows = JSON.parse(readFileSync(join(out, 'faults.json'), 'utf8'))
      const identity = auditResults(plan, env.CATALOG, env.SHARD, faults, rows)
      writeFileSync(join(out, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`)
    }
  } else {
    throw new Error('Expected command: plan, check, or audit')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.env).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
