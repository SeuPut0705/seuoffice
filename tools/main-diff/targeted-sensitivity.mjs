import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { auditComparison, verifyHeads } from './baseline-only.mjs'

const catalogPath = 'tools/main-diff/faults/b5-mcp.json'
const catalogHash = 'a45058cef79809d51c1eda0116ccb3086bd05df0838f4757e820db0c4fb8cc25'
const targetHash = '0544ee04bf0d2ce6697e4a18b9a8ae67f47f3113c07dc6aa9e050958f720568d'
const control = 'zod.toJsonSchema'
const target = 'runtime-archive.extractRuntimeArchive'
const self = fileURLToPath(import.meta.url)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const digest = (value) => hash(JSON.stringify(value))
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const head = (dir) =>
  execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const save = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })

export function identity(env) {
  for (const key of ['PRODUCT_SHA', 'DEFINITION_SHA'])
    assert.match(env[key] ?? '', /^[0-9a-f]{40}$/, `Invalid ${key}`)
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
    assert.match(env[key] ?? '', /^[1-9][0-9]*$/, `Invalid ${key}`)
  assert.equal(env.MODE, 'targeted-sensitivity-only')
  assert.equal(env.MAIN_DIFF_PROFILE, 'node-faults')
  for (const key of [
    'DOCX_FAULTS',
    'ODT_FAULTS',
    'MAIN_FAULTS',
    'FAULT_PRODUCT_SHA',
    'GATE_RUN_ID',
    'BASELINE_PRODUCT_SHA',
  ])
    assert.equal((env[key] ?? '').trim(), '', `${key} conflicts with sensitivity mode`)
  assert.ok(['', 'false'].includes(env.ALL_FAULTS ?? ''))
  assert.ok(['', '1'].includes(env.FAULT_SHARDS ?? ''))
  return {
    contract: 'main-targeted-sensitivity/v1',
    scope: 'targeted-sensitivity-only',
    productSha: env.PRODUCT_SHA,
    definitionSha: env.DEFINITION_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    profile: env.MAIN_DIFF_PROFILE,
    legacyFaultGateCompatible: false,
    fullBaselineCompatible: false,
    fullFaultRunCompatible: false,
  }
}

export function catalogIdentity(bytes) {
  assert.equal(hash(bytes), catalogHash, 'Original catalog bytes changed')
  const faults = JSON.parse(bytes.toString('utf8'))
  assert.equal(faults.length, 810)
  assert.equal(digest(faults[203]), targetHash, 'Target mutation changed')
  assert.deepEqual(faults[0].fn, [control])
  assert.deepEqual(faults[203].fn, [target])
  const shards = Math.ceil(faults.length / 4) * 4
  assert.ok(shards >= faults.length && shards % 4 === 0)
  assert.deepEqual(
    faults.flatMap((_, i) => (i === 0 || i % shards === 203 ? [i] : [])),
    [0, 203],
  )
  return {
    path: catalogPath,
    sha256: catalogHash,
    length: faults.length,
    originalShard: 203 % 4,
    faultShard: `203/${shards}`,
    selected: [0, 203].map((index) => ({ index, sha256: digest(faults[index]), ...faults[index] })),
  }
}

export function validateSelectors(list, catalogs) {
  const known = new Set()
  for (const line of list.trim().split('\n')) {
    const parts = line.split('\t')
    assert.equal(parts.length, 2, 'Malformed function list')
    assert.ok(parts[0] && parts[1], `Invalid function ${line}`)
    known.add(parts[1])
  }
  assert.ok(catalogs.length > 0)
  for (const { path, faults } of catalogs) {
    assert.ok(Array.isArray(faults) && faults.length > 0, `Invalid catalog ${path}`)
    for (const fault of faults) {
      assert.ok(Array.isArray(fault.fn) && fault.fn.length > 0, `Invalid selector in ${path}`)
      for (const fn of fault.fn) assert.ok(known.has(fn), `Unknown selector ${fn} in ${path}`)
    }
  }
}

export function auditBaseline(inventory, report) {
  assert.deepEqual(
    inventory.functions.map(({ group, name, checks }) => ({ group, name, checks })),
    [
      { group: 'b5-mcp', name: control, checks: 118 },
      { group: 'b5-mcp', name: target, checks: 82 },
    ],
  )
  assert.deepEqual(Object.keys(report.report).sort(), [target, control].sort())
  for (const row of Object.values(report.report))
    assert.equal(row.listed, 0, 'Listed baseline difference')
  return auditComparison(inventory.functions, { 'b5-mcp': report })
}

function wire(text) {
  assert.equal(typeof text, 'string')
  const side = JSON.parse(text)
  assert.ok(side && typeof side === 'object' && !Array.isArray(side))
  assert.equal(typeof side.answer, 'string')
  assert.ok(side.files && typeof side.files === 'object' && !Array.isArray(side.files))
  const answer = JSON.parse(side.answer)
  assert.ok(answer && typeof answer === 'object' && !Array.isArray(answer))
  return { answer, files: side.files }
}

export function auditMutant(inventory, rows, report) {
  const selected = inventory.catalog.selected
  assert.equal(selected.length, 2)
  assert.ok(Array.isArray(rows) && rows.length === 2, 'Expected exactly two fault rows')
  for (const [i, fault] of selected.entries()) {
    const row = rows[i]
    assert.ok(
      row && row.faults === catalogPath && row.name === fault.name && row.file === fault.file,
    )
    assert.deepEqual(row.fn, fault.fn)
    assert.equal(row.verdict, 'CAUGHT')
    assert.equal(typeof row.detail, 'string')
    assert.match(
      row.detail,
      new RegExp(
        `(?:^| \\| )DIFF ${fault.fn[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} case [0-9]+(?: |$)`,
      ),
    )
    const diagnosticText = row.detail.replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""')
    assert.doesNotMatch(
      diagnosticText,
      /(?:^| \| )(?:FLOOR(?: |:)|STALE(?: |:)|(?:[A-Za-z_$][A-Za-z0-9_$]*Error|Error)(?:\s+\[[^\]]+\])?(?: |:)|no such group(?: |:))/,
    )
    assert.doesNotMatch(
      diagnosticText,
      /(?:^| \| )\S+: \d+ checks, \d+ differences, \d+ listed, \d+ distinct {2}FLOOR: fewer than two distinct answers/,
    )
  }
  assert.deepEqual(Object.keys(report.report), [target])
  const r = report.report[target]
  assert.equal(r.checks, 82)
  assert.equal(r.equal, 80)
  assert.equal(r.listed, 0)
  assert.ok(Number.isSafeInteger(r.distinct) && r.distinct >= 2)
  assert.ok(Array.isArray(report.differences) && report.differences.length === 2)
  assert.deepEqual(
    report.differences.map((d) => [d.fn, d.case]),
    [
      [target, 80],
      [target, 81],
    ],
  )
  const [a, b] = report.differences.map((d) => ({ ts: wire(d.typescript), rust: wire(d.rust) }))
  for (const side of [a.ts, b.ts, a.rust]) {
    assert.deepEqual(side.answer.value, { ok: true })
    assert.ok(!Object.hasOwn(side.answer, 'error'))
  }
  assert.match(a.ts.files['out/kept.txt'], /^file [0-7]+ "kept content"$/)
  assert.match(a.rust.files['out/short.txt'], /^file [0-7]+ "kept content"$/)
  assert.ok(!Object.hasOwn(a.rust.files, 'out/kept.txt'))
  assert.match(b.ts.files['out/after-global.txt'], /^file [0-7]+ "kept after global metadata"$/)
  assert.equal(b.rust.answer.value?.kind, 'extract-failed')
  assert.ok(!Object.hasOwn(b.rust.answer, 'error'))
  assert.notEqual(report.differences[0].typescript, report.differences[0].rust)
  assert.notEqual(report.differences[1].typescript, report.differences[1].rust)
  return { positiveControl: rows[0], mutant: rows[1], differences: report.differences }
}

export function verifySources(expected, actual) {
  assert.deepEqual(actual, expected, 'Product source not restored')
}

async function main(command, env) {
  const product = resolve(env.PRODUCT_DIR ?? 'product')
  const driver = resolve(env.DRIVER_DIR ?? 'driver')
  const planPath = resolve(env.PLAN_PATH ?? 'targeted-sensitivity-plan.json')
  const out = join(product, 'tools/main-diff/out/targeted-sensitivity')
  const current = identity(env)
  if (command === 'prepare') {
    assert.equal(head(driver), current.definitionSha, 'Wrong driver checkout')
    save(planPath, current)
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `product_sha=${current.productSha}\n`)
    console.log(JSON.stringify(current))
    return
  }
  const plan = json(planPath)
  assert.deepEqual(plan, current, 'Plan metadata changed')
  verifyHeads(plan, head(product), head(driver))
  if (command === 'check') return
  if (command === 'inventory') {
    const catalog = catalogIdentity(readFileSync(join(product, catalogPath)))
    const tool = join(product, 'tools/main-diff')
    await import(pathToFileURL(join(product, 'packages/engine-wasm/src/node.ts')))
    const list = execFileSync(
      process.execPath,
      [join(product, 'node_modules/tsx/dist/cli.mjs'), join(tool, 'main.ts'), '--list'],
      { cwd: tool, env, encoding: 'utf8', maxBuffer: 64 << 20 },
    )
    const catalogs = readdirSync(join(tool, 'faults'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ path: name, faults: json(join(tool, 'faults', name)) }))
    validateSelectors(list, catalogs)
    assert.ok(
      json(join(tool, 'divergences.json')).every((entry) => ![control, target].includes(entry.fn)),
      'Selected functions have ledger entries',
    )
    const { groups } = await import(pathToFileURL(join(tool, 'groups/index.ts')))
    const { group } = await groups['b5-mcp']()
    const functions = [control, target].map((name) => ({
      group: 'b5-mcp',
      name,
      checks: group[name].cases.length,
      single: Boolean(group[name].single),
    }))
    assert.deepEqual(
      functions.map((f) => f.checks),
      [118, 82],
    )
    const cases = [80, 81].map((index) => {
      const c = group[target].cases[index]
      assert.ok(c && Array.isArray(c.args) && c.files && Object.keys(c.files).length)
      return { index, sha256: digest({ args: c.args, files: c.files }) }
    })
    const sourcePaths = [
      ...new Set([
        ...catalog.selected.map((f) => `crates/${f.file}`),
        'tools/main-diff/faults.mjs',
      ]),
    ]
    const sources = Object.fromEntries(
      sourcePaths.map((path) => {
        const bytes = readFileSync(join(product, path))
        const committed = execFileSync('git', ['-C', product, 'show', `${plan.productSha}:${path}`])
        assert.equal(hash(bytes), hash(committed), `Unclean source ${path}`)
        return [path, hash(bytes)]
      }),
    )
    const inventory = { planSha256: digest(plan), catalog, functions, cases, sources }
    mkdirSync(out, { recursive: true })
    save(join(out, 'inventory.json'), inventory)
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `fault_shard=${catalog.faultShard}\n`)
    console.log(JSON.stringify(inventory))
    return
  }
  assert.ok(
    ['audit-baseline', 'audit'].includes(command),
    'Expected prepare, check, inventory, audit-baseline or audit',
  )
  const inventory = json(join(out, 'inventory.json'))
  assert.equal(inventory.planSha256, digest(plan))
  assert.deepEqual(inventory.catalog, catalogIdentity(readFileSync(join(product, catalogPath))))
  assert.ok(
    json(join(product, 'tools/main-diff/divergences.json')).every(
      (entry) => ![control, target].includes(entry.fn),
    ),
    'Selected functions have ledger entries',
  )
  const expectedPaths = [
    ...new Set([
      ...inventory.catalog.selected.map((f) => `crates/${f.file}`),
      'tools/main-diff/faults.mjs',
    ]),
  ]
  assert.deepEqual(
    Object.keys(inventory.sources).sort(),
    expectedPaths.sort(),
    'Invalid source inventory',
  )
  for (const path of expectedPaths) {
    const committed = execFileSync('git', ['-C', product, 'show', `${plan.productSha}:${path}`])
    assert.equal(inventory.sources[path], hash(committed), `Source identity changed: ${path}`)
  }
  const sources = Object.fromEntries(
    Object.keys(inventory.sources).map((path) => [path, hash(readFileSync(join(product, path)))]),
  )
  verifySources(inventory.sources, sources)
  if (command === 'audit-baseline') {
    const totals = auditBaseline(inventory, json(join(out, 'baseline/report.json')))
    const result = {
      planSha256: digest(plan),
      inventorySha256: digest(inventory),
      sourceSha256: digest(sources),
      verdict: 'success',
      totals,
    }
    save(join(out, 'baseline-identity.json'), result)
    console.log(JSON.stringify(result))
    return
  }
  const baseline = json(join(out, 'baseline-identity.json'))
  assert.deepEqual(baseline, {
    planSha256: digest(plan),
    inventorySha256: digest(inventory),
    sourceSha256: digest(sources),
    verdict: 'success',
    totals: auditBaseline(inventory, json(join(out, 'baseline/report.json'))),
  })
  const proof = auditMutant(
    inventory,
    json(join(product, 'tools/main-diff/out/faults.json')),
    json(join(out, 'mutants/report.json')),
  )
  const wasm = readFileSync(env.SEUOFFICE_WASM)
  assert.deepEqual([...wasm.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], 'Invalid WASM header')
  const result = {
    ...plan,
    catalog: inventory.catalog,
    cases: inventory.cases,
    sources,
    baseline,
    wasmSha256: hash(wasm),
    ...proof,
  }
  save(join(out, 'identity.json'), result)
  console.log(JSON.stringify(result))
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
    )
}

if (process.argv[1] && resolve(process.argv[1]) === self)
  main(process.argv[2], process.env).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
