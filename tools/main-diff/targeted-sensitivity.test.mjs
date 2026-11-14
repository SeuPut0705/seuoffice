import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  auditBaseline,
  auditMutant,
  catalogIdentity,
  identity,
  validateSelectors,
  verifySources,
} from './targeted-sensitivity.mjs'
import { verifyHeads } from './baseline-only.mjs'

const env = {
  PRODUCT_SHA: 'a'.repeat(40),
  DEFINITION_SHA: 'b'.repeat(40),
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
  MODE: 'targeted-sensitivity-only',
  MAIN_DIFF_PROFILE: 'node-faults',
}
const catalogBytes = readFileSync(new URL('./faults/b5-mcp.json', import.meta.url))
const control = 'zod.toJsonSchema'
const target = 'runtime-archive.extractRuntimeArchive'
const inventory = () => ({
  catalog: catalogIdentity(catalogBytes),
  functions: [
    { group: 'b5-mcp', name: control, checks: 118, single: false },
    { group: 'b5-mcp', name: target, checks: 82, single: false },
  ],
})
const baseline = () => ({
  report: {
    [control]: { checks: 118, equal: 118, listed: 0, distinct: 10 },
    [target]: { checks: 82, equal: 82, listed: 0, distinct: 10 },
  },
  differences: [],
})
const rows = (inv) =>
  inv.catalog.selected.map((f, i) => ({
    faults: inv.catalog.path,
    name: f.name,
    file: f.file,
    fn: f.fn,
    verdict: 'CAUGHT',
    detail: `DIFF ${f.fn[0]} case ${i ? 80 : 0} (example)`,
  }))
const side = (value, files) => JSON.stringify({ answer: JSON.stringify({ value }), files })
const mutant = () => ({
  report: { [target]: { checks: 82, equal: 80, listed: 0, distinct: 10 } },
  differences: [
    {
      fn: target,
      case: 80,
      typescript: side({ ok: true }, { 'out/kept.txt': 'file 644 "kept content"' }),
      rust: side({ ok: true }, { 'out/short.txt': 'file 644 "kept content"' }),
    },
    {
      fn: target,
      case: 81,
      typescript: side(
        { ok: true },
        { 'out/after-global.txt': 'file 644 "kept after global metadata"' },
      ),
      rust: side({ kind: 'extract-failed' }, {}),
    },
  ],
})

test('identity excludes mixed modes and validates checkout identity', () => {
  const plan = identity(env)
  verifyHeads(plan, env.PRODUCT_SHA, env.DEFINITION_SHA)
  assert.throws(() => verifyHeads(plan, env.DEFINITION_SHA, env.PRODUCT_SHA))
  for (const [key, value] of Object.entries({
    PRODUCT_SHA: 'main',
    DEFINITION_SHA: 'A'.repeat(40),
    GITHUB_RUN_ID: '0',
    GITHUB_RUN_ATTEMPT: '0',
    MODE: 'baseline-only',
    MAIN_DIFF_PROFILE: 'release',
    ALL_FAULTS: 'true',
    FAULT_SHARDS: '4',
    DOCX_FAULTS: 'x',
    ODT_FAULTS: 'x',
    MAIN_FAULTS: 'x',
    FAULT_PRODUCT_SHA: 'x',
    GATE_RUN_ID: 'x',
    BASELINE_PRODUCT_SHA: 'x',
  }))
    assert.throws(() => identity({ ...env, [key]: value }), key)
})

test('original catalog and shard selection are immutable', () => {
  const catalog = catalogIdentity(catalogBytes)
  assert.equal(catalog.length, 810)
  assert.equal(catalog.faultShard, '203/812')
  assert.equal(catalog.originalShard, 3)
  assert.deepEqual(
    catalog.selected.map((f) => f.index),
    [0, 203],
  )
  const changed = Buffer.from(catalogBytes)
  changed[10] ^= 1
  assert.throws(() => catalogIdentity(changed))
})

test('all catalog selectors must exist in the product list', () => {
  const catalogs = [{ path: 'x.json', faults: [{ fn: [control] }] }]
  validateSelectors(`b5-mcp\t${control}\n`, catalogs)
  assert.throws(() => validateSelectors(`b5-mcp\t${target}\n`, catalogs), /Unknown selector/)
})

test('baseline requires both full functions with no differences or listed entries', () => {
  assert.deepEqual(auditBaseline(inventory(), baseline()), { functions: 2, checks: 200 })
  for (const mutate of [
    (r) => {
      r.differences.push({ fn: target, case: 80 })
    },
    (r) => {
      r.report[target].equal--
      r.report[target].listed++
    },
    (r) => {
      r.report[target].checks--
    },
    (r) => {
      r.report[target].distinct = 1
    },
    (r) => {
      delete r.report[control]
    },
    (r) => {
      r.report.extra = r.report[control]
    },
  ]) {
    const r = baseline()
    mutate(r)
    assert.throws(() => auditBaseline(inventory(), r))
  }
})

test('valid targeted evidence identifies the consumer-visible differences', () => {
  const inv = inventory()
  const proof = auditMutant(inv, rows(inv), mutant())
  assert.equal(proof.mutant.verdict, 'CAUGHT')
  assert.deepEqual(
    proof.differences.map((d) => d.case),
    [80, 81],
  )
})

test('fault rows require exact ordered identities and actual function differences', () => {
  const inv = inventory()
  for (const mutate of [
    (r) => r.pop(),
    (r) => r.push(r[1]),
    (r) => r.reverse(),
    (r) => {
      r[0].verdict = 'MISSED'
    },
    (r) => {
      r[1].name = 'other'
    },
    (r) => {
      r[1].file = 'other'
    },
    (r) => {
      r[1].faults = 'other'
    },
    (r) => {
      r[1].fn = [control]
    },
    (r) => {
      r[1].detail = 'DIFF unrelated case 80'
    },
    (r) => {
      r[0].detail = `DIFF ${control} case 0 | Error failed`
    },
  ]) {
    const r = rows(inv)
    mutate(r)
    assert.throws(() => auditMutant(inv, r, mutant()))
  }
})

test('typed report rejects unrelated, missing, duplicated and wrong consumer outputs', () => {
  const inv = inventory()
  for (const mutate of [
    (r) => {
      r.report[target].equal = 81
    },
    (r) => {
      r.report[target].listed = 1
    },
    (r) => {
      r.report[target].distinct = 1
    },
    (r) => {
      r.report.other = r.report[target]
    },
    (r) => r.differences.pop(),
    (r) => {
      r.differences[1].case = 80
    },
    (r) => {
      r.differences[0].fn = control
    },
    (r) => {
      r.differences[0].typescript = '{}'
    },
    (r) => {
      r.differences[0].rust = side({ ok: true }, { 'out/kept.txt': 'file 644 "kept content"' })
    },
    (r) => {
      r.differences[0].typescript = side({ ok: true }, { 'out/kept.txt': 'file 644 "wrong"' })
    },
    (r) => {
      r.differences[1].typescript = side({ kind: 'extract-failed' }, {})
    },
    (r) => {
      r.differences[1].rust = side({ kind: 'other' }, {})
    },
  ]) {
    const r = mutant()
    mutate(r)
    assert.throws(() => auditMutant(inv, rows(inv), r))
  }
})

test('changed mutation source or fault runner is not restored', () => {
  const original = { target: 'abc', runner: 'def' }
  verifySources(original, { ...original })
  assert.throws(() => verifySources(original, { ...original, target: 'changed' }))
  assert.throws(() => verifySources(original, { ...original, runner: 'changed' }))
})

test('actual hosted consumer error values are not fatal diagnostics', () => {
  const evidence = JSON.parse(
    readFileSync(new URL('./fixtures/sensitivity43591069529.json', import.meta.url), 'utf8'),
  )
  const proof = auditMutant(evidence.inventory, evidence.rows, evidence.report)
  assert.deepEqual(
    proof.differences.map((difference) => difference.case),
    [80, 81],
  )
  assert.equal(proof.mutant.verdict, 'CAUGHT')
})

test('positive control differences cannot hide an actual function FLOOR summary', () => {
  const inv = inventory()
  const r = rows(inv)
  r[0].detail += ` | ${control}: 118 checks, 1 differences, 0 listed, 1 distinct  FLOOR: fewer than two distinct answers`
  assert.throws(() => auditMutant(inv, r, mutant()))
})

test('fatal JS diagnostics are rejected without treating quoted consumer data as diagnostics', () => {
  const inv = inventory()
  for (const diagnostic of [
    'TypeError: failed',
    'RangeError: failed',
    'AssertionError [ERR_ASSERTION]: failed',
  ]) {
    const r = rows(inv)
    r[0].detail += ` | ${diagnostic}`
    assert.throws(() => auditMutant(inv, r, mutant()))
  }
  const r = rows(inv)
  r[0].detail +=
    ' |   rust: {"name":"RuntimeArchiveError","message":"value | TypeError: still data"}'
  assert.equal(auditMutant(inv, r, mutant()).positiveControl.verdict, 'CAUGHT')
})
