// A baseline run's head is the driver definition, not the tested product.
// Its evidence is not a gate accepted by the legacy faults-only validator.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha = /^[0-9a-f]{40}$/
const windowsFunctions = [
  'rename-validation.isSameFile',
  'rename-validation.pdfSaveAsTarget',
  'folder-files.plainFileIn.hardLinks',
  'write-guard.appendData.hardLinks',
]

export function identity(env) {
  assert.match(env.PRODUCT_SHA ?? '', sha, 'PRODUCT_SHA must be a full lowercase SHA')
  assert.match(env.DEFINITION_SHA ?? '', sha, 'DEFINITION_SHA must be a full lowercase SHA')
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/, 'Invalid run ID')
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/, 'Invalid run attempt')
  assert.ok(['linux', 'windows'].includes(env.PROFILE), 'Invalid baseline profile')
  for (const key of [
    'DOCX_FAULTS',
    'ODT_FAULTS',
    'MAIN_FAULTS',
    'FAULT_PRODUCT_SHA',
    'GATE_RUN_ID',
  ])
    assert.equal((env[key] ?? '').trim(), '', `${key} conflicts with baseline-only`)
  assert.ok(['', 'false'].includes(env.ALL_FAULTS ?? ''), 'ALL_FAULTS conflicts with baseline-only')
  assert.ok(['', '1'].includes(env.FAULT_SHARDS ?? ''), 'Baseline has no fault shards')
  return {
    contract: 'main-baseline-only/v1',
    definitionSha: env.DEFINITION_SHA,
    productSha: env.PRODUCT_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    profile: env.PROFILE,
    legacyFaultGateCompatible: false,
  }
}

export function verifyHeads(plan, productHead, definitionHead) {
  assert.match(plan.productSha, sha)
  assert.match(plan.definitionSha, sha)
  assert.equal(productHead, plan.productSha, 'Wrong product checkout')
  assert.equal(definitionHead, plan.definitionSha, 'Wrong driver checkout')
}

export function auditComparison(expected, reports) {
  assert.ok(expected.length > 0, 'Empty function inventory')
  const actual = new Map()
  for (const [group, result] of Object.entries(reports)) {
    assert.deepEqual(result.differences, [], `Unlisted differences in ${group}`)
    for (const [name, row] of Object.entries(result.report)) {
      const key = `${group}\t${name}`
      assert.ok(!actual.has(key), `Duplicate report ${key}`)
      actual.set(key, row)
    }
  }
  const wanted = new Set()
  let checks = 0
  for (const item of expected) {
    const key = `${item.group}\t${item.name}`
    assert.ok(!wanted.has(key), `Duplicate inventory ${key}`)
    wanted.add(key)
    const row = actual.get(key)
    assert.ok(row, `Missing function ${key}`)
    assert.ok(Number.isSafeInteger(item.checks) && item.checks > 0, `Empty cases ${key}`)
    assert.equal(row.checks, item.checks, `Missing or duplicated cases ${key}`)
    assert.equal(row.equal + row.listed, row.checks, `Unaccounted cases ${key}`)
    assert.ok(item.single || row.distinct >= 2, `FLOOR ${key}`)
    checks += row.checks
  }
  assert.deepEqual([...actual.keys()].sort(), [...wanted].sort(), 'Unexpected functions')
  return { functions: expected.length, checks }
}

const head = (dir) =>
  execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const self = fileURLToPath(import.meta.url)

async function main(command, env) {
  const product = resolve(env.PRODUCT_DIR ?? 'product')
  const driver = resolve(env.DRIVER_DIR ?? 'driver')
  const planPath = resolve(env.PLAN_PATH ?? 'baseline-plan.json')
  const out = join(product, 'tools/main-diff/out')
  if (command === 'prepare') {
    const plan = identity(env)
    assert.equal(head(driver), plan.definitionSha, 'Wrong driver checkout')
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' })
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `product_sha=${plan.productSha}\n`)
    console.log(JSON.stringify(plan))
    return
  }
  const plan = json(planPath)
  verifyHeads(plan, head(product), head(driver))
  if (command === 'check') return
  if (command === 'group' || command === 'inventory') {
    // Use the product's loader and registry, never a copy of its cases.
    await import(pathToFileURL(join(product, 'packages/engine-wasm/src/node.ts')))
    const { groups } = await import(pathToFileURL(join(product, 'tools/main-diff/groups/index.ts')))
    if (command === 'group') {
      const name = process.argv[3]
      assert.ok(Object.hasOwn(groups, name), 'Unknown inventory group')
      const { group } = await groups[name]()
      console.log(
        JSON.stringify(
          Object.entries(group).map(([fn, spec]) => ({
            group: name,
            name: fn,
            checks: spec.cases.length,
            single: Boolean(spec.single),
          })),
        ),
      )
      return
    }
    const entries = []
    for (const name of Object.keys(groups)) {
      const text = execFileSync(
        process.execPath,
        [join(product, 'node_modules/tsx/dist/cli.mjs'), self, 'group', name],
        {
          cwd: product,
          env,
          encoding: 'utf8',
          maxBuffer: 64 << 20,
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      )
      entries.push(...JSON.parse(text))
    }
    const inventory =
      plan.profile === 'linux'
        ? { linux: entries }
        : {
            'windows-filtered': entries.filter((item) => windowsFunctions.includes(item.name)),
            'windows-node-fs': entries.filter((item) => item.group === 'node-fs'),
          }
    if (plan.profile === 'windows')
      assert.deepEqual(
        inventory['windows-filtered'].map((item) => item.name).sort(),
        [...windowsFunctions].sort(),
      )
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, {
      flag: 'wx',
    })
    return
  }
  assert.equal(command, 'audit', 'Expected prepare, check, inventory, group or audit')
  const inventory = json(join(out, 'inventory.json'))
  const totals = {}
  for (const [lane, expected] of Object.entries(inventory)) {
    assert.ok(['linux', 'windows-filtered', 'windows-node-fs'].includes(lane))
    const report = json(join(out, lane, 'report.json'))
    totals[lane] = auditComparison(
      expected,
      lane === 'windows-node-fs' ? { 'node-fs': report } : report,
    )
  }
  assert.deepEqual(
    Object.keys(totals).sort(),
    plan.profile === 'linux' ? ['linux'] : ['windows-filtered', 'windows-node-fs'],
  )
  const wasm = readFileSync(env.SEUOFFICE_WASM)
  const result = {
    ...plan,
    comparisonVerdict: 'success',
    totals,
    wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  }
  writeFileSync(join(out, 'identity.json'), `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(out, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
    )
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  main(process.argv[2], process.env).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
