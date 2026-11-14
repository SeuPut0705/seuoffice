import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { auditJob, mergeCompletions } from './recovery-audit.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const h = (char) => char.repeat(64)

test('a typed recovery plan cannot accept prefix-only producer evidence', () => {
  const f = fixture()
  f.plan.mutationEvidenceContract = 'terminal-report-typed-evidence/v1'
  f.plan.jobs[0].typedEvidenceRequirements = [{ index: 1 }]
  f.evidence[0].identity.planSha256 = hash(f.plan)
  assert.throws(
    () => auditJob(f.plan, 'job0', f.catalog, f.evidence[0]),
    /baseline|observation|typed/i,
  )
})

function fixture() {
  const path = 'tools/main-diff/faults/example.json'
  const faults = [
    { name: 'control', file: 'a.rs', fn: ['api.control'], find: 'a', replace: 'b' },
    { name: 'Error is a name', file: 'b.rs', fn: ['api.handleError'], find: 'c', replace: 'd' },
    { name: 'third', file: 'a.rs', fn: ['api.third'], find: 'e', replace: 'f' },
  ]
  const catalog = { path, sha256: h('a'), faults }
  const jobs = [
    [0, 1],
    [0, 2],
  ].map((indices, n) => ({
    jobKey: `job${n}`,
    catalog: path,
    catalogSha256: catalog.sha256,
    indices,
    batch: 0,
    entryHashes: indices.map((index) => ({
      index,
      originalSha256: h(String(index + 1)),
      productSha256: hash(faults[index]),
    })),
  }))
  const plan = {
    contract: 'main-fault-recovery/v1',
    definitionSha: 'definition',
    productSha: 'product',
    manifestSha256: h('b'),
    jobs,
    requiredIds: [0, 1, 2].map((i) => `${path}#${i}`),
    expandedIds: [0, 1, 2].map((i) => `${path}#${i}`),
  }
  const evidence = jobs.map((job) => {
    const sources = Object.fromEntries(job.indices.map((i) => [`crates/${faults[i].file}`, h('c')]))
    return {
      identity: {
        definitionSha: plan.definitionSha,
        productSha: plan.productSha,
        runId: '123',
        attempt: 1,
        planSha256: hash(plan),
        manifestSha256: plan.manifestSha256,
        jobKey: job.jobKey,
      },
      rows: job.indices.map((i) => ({
        faults: path,
        name: faults[i].name,
        file: faults[i].file,
        fn: faults[i].fn,
        verdict: 'CAUGHT',
        detail: `DIFF ${faults[i].fn[0]} case 1`,
      })),
      text: '2 faults: 2 caught, 0 missed, 0 not building, 0 bad\n',
      sourceBefore: sources,
      sourceAfter: { ...sources },
    }
  })
  return { plan, catalog, evidence }
}

function complete(f) {
  return f.plan.jobs.map((job, i) => auditJob(f.plan, job.jobKey, f.catalog, f.evidence[i]))
}

test('complete jobs prove their exact mutations and merge to full coverage', () => {
  const f = fixture()
  const records = complete(f)
  assert.deepEqual(
    records[0].records.map((row) => row.id),
    ['tools/main-diff/faults/example.json#0', 'tools/main-diff/faults/example.json#1'],
  )
  const result = mergeCompletions(f.plan, records)
  assert.equal(result.scope, 'recovery-complete')
  assert.equal(result.jobCount, 2)
  assert.equal(result.mutationCount, 3)
})

test('incomplete or misattributed job evidence never completes', () => {
  for (const mutate of [
    (f) => f.evidence[0].rows.pop(),
    (f) => f.evidence[0].rows.reverse(),
    (f) => {
      f.evidence[0].rows[1].faults = 'other.json'
    },
    (f) => {
      f.evidence[0].rows[1].fn = ['api.other']
    },
    (f) => {
      f.evidence[0].rows[0].verdict = 'MISSED'
    },
    (f) => {
      f.evidence[0].rows[1].detail = 'DIFF api.control case 1'
    },
    (f) => {
      f.evidence[0].rows[1].detail = '1 checks, 0 equal, " | DIFF api.handleError case 1"'
    },
    (f) => {
      f.evidence[0].rows[1].detail += ' | STALE ledger entry 5: it no longer reproduces'
    },
    (f) => {
      f.evidence[0].rows[1].detail +=
        ' | api.handleError: 1 checks, 0 differences, 0 listed, 1 distinct  FLOOR: fewer than two distinct answers'
    },
    (f) => {
      f.evidence[0].text = 'CAUGHT control\nCAUGHT Error is a name\n'
    },
    (f) => {
      f.evidence[0].text = '2 faults: 1 caught, 1 missed, 0 not building, 0 bad\n'
    },
    (f) => {
      f.evidence[0].identity.productSha = 'other'
    },
    (f) => {
      f.evidence[0].identity.definitionSha = 'other'
    },
    (f) => {
      f.evidence[0].identity.manifestSha256 = h('d')
    },
    (f) => {
      f.evidence[0].identity.planSha256 = h('d')
    },
    (f) => {
      f.evidence[0].identity.jobKey = 'other'
    },
    (f) => {
      f.evidence[0].identity.runId = ''
    },
    (f) => {
      f.catalog.faults[1].replace = 'changed'
    },
    (f) => {
      f.catalog.sha256 = h('d')
    },
    (f) => {
      delete f.evidence[0].sourceBefore['crates/b.rs']
    },
    (f) => {
      f.evidence[0].sourceAfter['crates/b.rs'] = h('d')
    },
    (f) => {
      f.evidence[0].sourceBefore['crates/extra'] = h('c')
      f.evidence[0].sourceAfter['crates/extra'] = h('c')
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.throws(() => auditJob(f.plan, 'job0', f.catalog, f.evidence[0]))
  }
})

test('merge rejects missing, duplicate, tampered and misattributed evidence', () => {
  for (const mutate of [
    (f, records) => records.pop(),
    (f, records) => {
      records[1] = records[0]
    },
    (f, records) => {
      records[0].records[1].id = `${f.catalog.path}#2`
    },
    (f, records) => {
      records[0].records[1].originalSha256 = h('d')
    },
    (f, records) => {
      records[0].evidence.rows[1].detail = 'no such group: unknown'
    },
    (f, records) => {
      records[0].evidence.sourceAfter['crates/b.rs'] = h('d')
    },
    (f, records) => {
      records[1].identity.runId = '124'
      records[1].evidence.identity.runId = '124'
    },
    (f, records) => {
      records[1].identity.jobKey = 'unknown'
    },
  ]) {
    const f = fixture()
    const records = structuredClone(complete(f))
    mutate(f, records)
    assert.throws(() => mergeCompletions(f.plan, records))
  }
})

test('merge rejects duplicate noncontrols and mismatched coverage sets', () => {
  const duplicate = fixture()
  duplicate.plan.jobs[1].indices = [0, 1]
  duplicate.plan.jobs[1].entryHashes = duplicate.plan.jobs[0].entryHashes
  duplicate.evidence[1].rows = structuredClone(duplicate.evidence[0].rows)
  duplicate.evidence[1].sourceBefore = { ...duplicate.evidence[0].sourceBefore }
  duplicate.evidence[1].sourceAfter = { ...duplicate.evidence[0].sourceAfter }
  for (const item of duplicate.evidence) item.identity.planSha256 = hash(duplicate.plan)
  assert.throws(() => mergeCompletions(duplicate.plan, complete(duplicate)))

  for (const field of ['requiredIds', 'expandedIds']) {
    const f = fixture()
    f.plan[field].push('unknown#1')
    for (const item of f.evidence) item.identity.planSha256 = hash(f.plan)
    assert.throws(() => mergeCompletions(f.plan, complete(f)))
  }
})

test('a selector difference does not hide a fatal JS diagnostic in another segment', () => {
  for (const diagnostic of [
    'TypeError: failed',
    'RangeError: failed',
    'AssertionError [ERR_ASSERTION]: failed',
  ]) {
    const f = fixture()
    f.evidence[0].rows[1].detail += ` | ${diagnostic}`
    assert.throws(() => auditJob(f.plan, 'job0', f.catalog, f.evidence[0]))
  }
  const f = fixture()
  f.evidence[0].rows[1].detail +=
    ' |   rust: {"name":"RuntimeArchiveError","message":"value | TypeError: still data"}'
  assert.equal(auditJob(f.plan, 'job0', f.catalog, f.evidence[0]).records[1].verdict, 'CAUGHT')
})
