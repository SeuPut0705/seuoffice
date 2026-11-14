import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hash, hashBytes } from './recovery-plan.mjs'
import { auditNormalBaseline } from './recovery-mutation.mjs'

const self = fileURLToPath(import.meta.url)
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })

export function selectedGroups(list, faults) {
  const groupOf = new Map(
    list
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').reverse()),
  )
  const result = new Map()
  for (const fault of faults) {
    for (const name of fault.fn) {
      const group = groupOf.get(name)
      assert.ok(group, `Unknown selector ${name}`)
      if (!result.has(group)) result.set(group, [])
      if (!result.get(group).includes(name)) result.get(group).push(name)
    }
  }
  return Object.fromEntries(result)
}

export function bindLedgerRequirements(requirements, ledger, catalog) {
  for (const requirement of requirements) {
    assert.equal(requirement.catalog, catalog.path)
    const fault = catalog.faults[requirement.index]
    assert.ok(fault)
    assert.equal(requirement.mutationSha256, hash(fault))
    assert.equal(requirement.name, fault.name)
    assert.deepEqual(requirement.selectors, fault.fn)
    for (const wanted of requirement.ledger) {
      const entries = ledger.filter((entry) => entry.id === wanted.id)
      assert.equal(entries.length, 1, 'Missing or duplicate required ledger ID')
      const entry = entries[0]
      assert.equal(entry.fn, wanted.fn)
      assert.equal(entry.case, wanted.case)
      assert.ok(fault.fn.includes(entry.fn))
      assert.equal(hash({ typescript: entry.typescript, rust: entry.rust }), wanted.tupleSha256)
    }
  }
}

// Every inventory group runs in its own process, matching the product registry's
// loader isolation. Reading this inventory does not execute a comparison case.
async function inventoryGroup(product, name) {
  await import(pathToFileURL(join(product, 'packages/engine-wasm/src/node.ts')))
  const { groups } = await import(pathToFileURL(join(product, 'tools/main-diff/groups/index.ts')))
  assert.ok(Object.hasOwn(groups, name), 'Unknown inventory group')
  const { group } = await groups[name]()
  return Object.entries(group).map(([fn, spec]) => ({
    group: name,
    name: fn,
    checks: spec.cases.length,
    single: Boolean(spec.single),
  }))
}

export function collectNormalBaseline({ product, out, identity, job, catalog, list, env }) {
  assert.equal(env.MAIN_DIFF_PROFILE, 'node-faults')
  assert.equal(env.CARGO_INCREMENTAL, '1')
  assert.equal(job.typedEvidenceRequirements?.length, 1, 'Expected one terminal marker')
  const marker = job.typedEvidenceRequirements[0]
  assert.equal(job.indices.at(-1), marker.index)
  const faults = [catalog.faults[marker.index]]
  const groups = selectedGroups(list, faults)
  assert.equal(Object.keys(groups).length, 1, 'Terminal report requires one group')
  const selected = new Set(Object.values(groups).flat())
  const ledgerPath = join(product, 'tools/main-diff/divergences.json')
  const ledger = json(ledgerPath).filter((entry) => selected.has(entry.fn))
  bindLedgerRequirements(job.typedEvidenceRequirements ?? [], ledger, catalog)
  const functions = []
  const commands = []
  const reports = {}
  const root = join(out, 'normal-baseline')
  mkdirSync(root, { recursive: true })
  for (const [group, names] of Object.entries(groups)) {
    const raw = execFileSync(
      process.execPath,
      [join(product, 'node_modules/tsx/dist/cli.mjs'), self, 'inventory-group', product, group],
      { cwd: product, env, encoding: 'utf8', maxBuffer: 64 << 20 },
    )
    const inventory = JSON.parse(raw)
    const mine = inventory.filter((entry) => names.includes(entry.name))
    assert.deepEqual(mine.map((entry) => entry.name).sort(), [...names].sort())
    functions.push(...mine)
    save(join(root, `${group}-inventory.json`), inventory)
  }
  const build = spawnSync('node', ['build.mjs'], {
    cwd: join(product, 'tools/main-diff'),
    env,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
  save(join(root, 'build.json'), {
    status: build.status,
    signal: build.signal,
    stdout: build.stdout,
    stderr: build.stderr,
    profile: env.MAIN_DIFF_PROFILE,
    cargoIncremental: env.CARGO_INCREMENTAL,
  })
  assert.equal(build.signal, null, 'Normal baseline build was interrupted')
  assert.equal(build.status, 0, 'Normal baseline build failed')
  for (const [group, names] of Object.entries(groups)) {
    const groupOut = join(root, group)
    mkdirSync(groupOut)
    const run = spawnSync(
      process.execPath,
      [
        join(product, 'node_modules/tsx/dist/cli.mjs'),
        join(product, 'tools/main-diff/main.ts'),
        '--group',
        group,
        '--show',
        '3',
        ...names.flatMap((name) => ['--fn', name]),
      ],
      {
        cwd: product,
        env: { ...env, MAIN_DIFF_OUT: groupOut },
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      },
    )
    const command = {
      group,
      functions: names,
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    }
    commands.push(command)
    save(join(groupOut, 'command.json'), command)
    assert.equal(run.signal, null, `Normal baseline ${group} was interrupted`)
    assert.equal(run.status, 0, `Normal baseline ${group} failed`)
    reports[group] = json(join(groupOut, 'report.json'))
  }
  const baseline = {
    identity,
    functions,
    ledger,
    ledgerSha256: hash(ledger),
    reports,
    commands,
    sources: {
      productMainSha256: hashBytes(readFileSync(join(product, 'tools/main-diff/main.ts'))),
      ledgerFileSha256: hashBytes(readFileSync(ledgerPath)),
      mutatorSha256: hashBytes(readFileSync(join(product, 'tools/main-diff/faults.mjs'))),
      wasmSha256: hashBytes(readFileSync(env.SEUOFFICE_WASM)),
    },
    verdict: 'success',
  }
  auditNormalBaseline(baseline)
  save(join(out, 'normal-baseline.json'), baseline)
  return { baseline, groups }
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  assert.equal(process.argv[2], 'inventory-group', 'Unknown baseline command')
  inventoryGroup(resolve(process.argv[3]), process.argv[4]).then(
    (inventory) => console.log(JSON.stringify(inventory)),
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )
}
