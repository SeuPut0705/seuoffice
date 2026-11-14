import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { auditNormalBaseline, auditTerminalMutation } from './recovery-mutation.mjs'
import { auditJob } from './recovery-audit.mjs'
import { originalMutatorSha256 } from './recovery-runner-model.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reportHash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value, null, 2))
    .digest('hex')
const h = (char) => char.repeat(64)
const wire = (value) => JSON.stringify({ answer: value, files: {} })

function unitFixture() {
  const faults = [
    { name: 'control', file: 'control.rs', find: 'a', replace: 'b', fn: ['control'] },
    { name: 'mutant', file: 'target.rs', find: 'c', replace: 'd', fn: ['target'] },
  ]
  const catalog = { path: 'tools/main-diff/faults/unit.json', sha256: h('a'), faults }
  const ledger = [
    {
      id: 'unit-ledger',
      fn: 'target',
      case: 3,
      typescript: JSON.parse(wire('baseline-ts')),
      rust: JSON.parse(wire('baseline-rust')),
      reason: 'unit only',
    },
  ]
  const marker = {
    catalog: catalog.path,
    index: 1,
    mutationSha256: hash(faults[1]),
    name: 'mutant',
    selectors: ['target'],
    ledger: [
      {
        id: 'unit-ledger',
        fn: 'target',
        case: 3,
        tupleSha256: hash({ typescript: ledger[0].typescript, rust: ledger[0].rust }),
      },
    ],
  }
  const job = {
    jobKey: 'unit',
    catalog: catalog.path,
    catalogSha256: catalog.sha256,
    indices: [0, 1],
    entryHashes: faults.map((fault, index) => ({
      index,
      originalSha256: hash(fault),
      productSha256: hash(fault),
    })),
    typedEvidenceRequirements: [marker],
  }
  const plan = {
    contract: 'main-fault-recovery/v1',
    productSha: 'unit-product',
    definitionSha: 'unit-definition',
    manifestSha256: h('b'),
    jobs: [job],
  }
  const identity = {
    productSha: plan.productSha,
    definitionSha: plan.definitionSha,
    manifestSha256: plan.manifestSha256,
    planSha256: hash(plan),
    jobKey: job.jobKey,
    runId: '123',
    attempt: 1,
  }
  const baseline = {
    identity,
    verdict: 'success',
    sources: {
      productMainSha256: h('a'),
      ledgerFileSha256: h('b'),
      mutatorSha256: h('c'),
      wasmSha256: h('d'),
    },
    functions: [{ group: 'target-group', name: 'target', checks: 4, single: false }],
    ledger,
    ledgerSha256: hash(ledger),
    reports: {
      'target-group': {
        report: { target: { checks: 4, equal: 3, listed: 1, distinct: 4 } },
        differences: [],
      },
    },
    commands: [
      {
        group: 'target-group',
        functions: ['target'],
        status: 0,
        signal: null,
        stdout: 'target: 4 checks, 0 differences, 1 listed, 4 distinct\n',
        stderr: '',
      },
    ],
  }
  const sources = { 'crates/control.rs': h('e'), 'crates/target.rs': h('f') }
  const targetReport = {
    report: { target: { checks: 4, equal: 2, listed: 0, distinct: 4 } },
    differences: [
      { fn: 'target', case: 0, typescript: wire('a'), rust: wire('b') },
      { fn: 'target', case: 3, typescript: wire('baseline-ts'), rust: wire('mutant-rust') },
    ],
  }
  const evidence = {
    identity,
    index: 1,
    mutationSha256: hash(faults[1]),
    group: 'target-group',
    functions: ['target'],
    detail:
      'DIFF target case 0 | DIFF target case 3 | STALE ledger entry unit-ledger: it no longer reproduces',
    report: targetReport,
    reportSha256: reportHash(targetReport),
    sourceModel: {
      kind: 'pinned-original-runner-control-flow',
      mutatorSha256: h('c'),
      before: sources,
      after: { ...sources },
      findCount: 1,
      derivedAppliedSourceSha256: h('2'),
    },
  }
  return { plan, job, catalog, index: 1, baseline, evidence }
}

function refreshReport(f) {
  f.evidence.reportSha256 = reportHash(f.evidence.report)
}

test('unit only: exact typed ledger reaction and independent difference are reported', () => {
  const f = unitFixture()
  assert.equal(auditNormalBaseline(f.baseline).ledgerEntries, 1)
  const result = auditTerminalMutation(f)
  assert.equal(result.scope, 'mutation-typed-evidence-only')
  assert.equal(result.mutationSha256, hash(f.catalog.faults[1]))
  assert.deepEqual(
    result.independentDifferences.map(({ fn, case: n }) => [fn, n]),
    [['target', 0]],
  )
  assert.deepEqual(
    result.ledgerReactions.map(({ id, kind, case: n }) => [id, kind, n]),
    [['unit-ledger', 'changed', 3]],
  )
  assert.deepEqual(result.ledgerReactions[0].mutant.rust, JSON.parse(wire('mutant-rust')))
})

test('unit only: job acceptance binds the terminal row and grants no other STALE exception', () => {
  const make = () => {
    const f = unitFixture()
    f.plan.mutationEvidenceContract = 'terminal-report-typed-evidence/v1'
    f.baseline.identity.planSha256 = hash(f.plan)
    f.baseline.sources.mutatorSha256 = originalMutatorSha256
    f.evidence.sourceModel.mutatorSha256 = originalMutatorSha256
    const before = f.evidence.sourceModel.before
    const evidence = {
      identity: f.baseline.identity,
      rows: f.catalog.faults.map((fault, index) => ({
        faults: f.catalog.path,
        name: fault.name,
        file: fault.file,
        fn: fault.fn,
        verdict: 'CAUGHT',
        detail: index === 0 ? 'DIFF control case 0' : f.evidence.detail,
      })),
      text: '2 faults: 2 caught, 0 missed, 0 not building, 0 bad\n',
      sourceBefore: before,
      sourceAfter: { ...before },
      runnerModel: {
        kind: 'pinned-original-runner-control-flow',
        mutatorSha256: originalMutatorSha256,
        before,
        entries: f.job.indices.map((index) => ({
          index,
          path: `crates/${f.catalog.faults[index].file}`,
          findCount: 1,
          derivedAppliedSourceSha256: h(String(index + 1)),
        })),
      },
      baseline: f.baseline,
      terminal: f.evidence,
    }
    return { ...f, combined: evidence }
  }
  const f = make()
  const accepted = auditJob(f.plan, f.job.jobKey, f.catalog, f.combined)
  assert.equal(accepted.records[1].typedEvidence.ledgerReactions[0].id, 'unit-ledger')
  for (const mutate of [
    (f) => {
      delete f.combined.baseline
    },
    (f) => {
      delete f.combined.terminal
    },
    (f) => {
      f.combined.rows[0].detail += ' | STALE ledger entry unit-ledger: it no longer reproduces'
    },
    (f) => {
      f.combined.rows[1].detail += ' | STALE ledger entry other: it no longer reproduces'
    },
    (f) => {
      f.combined.sourceAfter['crates/target.rs'] = h('0')
    },
    (f) => {
      f.combined.runnerModel.entries[1].index = 0
    },
  ]) {
    const changed = make()
    mutate(changed)
    assert.throws(() =>
      auditJob(changed.plan, changed.job.jobKey, changed.catalog, changed.combined),
    )
  }
})

test('unit only: normal baseline rejects incomplete, stale, unlisted and floor evidence', () => {
  for (const mutate of [
    (f) => {
      f.baseline.commands[0].stdout += 'STALE ledger entry unit-ledger: it no longer reproduces\n'
    },
    (f) => {
      f.baseline.commands[0].stderr = 'Error: crashed\n'
    },
    (f) => {
      f.baseline.reports['target-group'].report.target.listed = 0
    },
    (f) => {
      f.baseline.reports['target-group'].report.target.distinct = 1
    },
    (f) => {
      f.baseline.functions.push({ ...f.baseline.functions[0] })
    },
    (f) => {
      f.baseline.ledger.push(f.baseline.ledger[0])
      f.baseline.ledgerSha256 = hash(f.baseline.ledger)
    },
    (f) => {
      f.baseline.reports['target-group'].differences.push({
        fn: 'target',
        case: 0,
        typescript: wire('a'),
        rust: wire('b'),
      })
    },
    (f) => {
      delete f.baseline.reports['target-group']
    },
    (f) => {
      f.baseline.sources.wasmSha256 = ''
    },
  ]) {
    const f = unitFixture()
    mutate(f)
    assert.throws(() => auditNormalBaseline(f.baseline))
  }
})

test('unit only: incomplete and misattributed terminal evidence is rejected', () => {
  for (const mutate of [
    (f) => {
      delete f.evidence.report
    },
    (f) => {
      f.evidence.functions = ['other']
    },
    (f) => {
      f.evidence.detail = f.evidence.detail.replaceAll('DIFF target', 'DIFF other')
    },
    (f) => {
      f.evidence.detail += ' | Error: crash'
    },
    (f) => {
      f.evidence.detail += ' | FLOOR: fewer than two distinct answers'
    },
    (f) => {
      f.evidence.detail += ' | STALE ledger entry unknown: it no longer reproduces'
    },
    (f) => {
      f.evidence.detail += ' | STALE ledger entry unit-ledger: it no longer reproduces'
    },
    (f) => {
      f.evidence.report.differences.push(f.evidence.report.differences[0])
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.differences[0].case = 9
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.report.target.checks = 3
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.report.target.distinct = 1
      refreshReport(f)
    },
    (f) => {
      f.evidence.reportSha256 = h('0')
    },
    (f) => {
      f.evidence.mutationSha256 = h('0')
    },
    (f) => {
      f.evidence.sourceModel.mutatorSha256 = h('0')
    },
    (f) => {
      f.evidence.sourceModel.findCount = 2
    },
    (f) => {
      f.evidence.sourceModel.derivedAppliedSourceSha256 = h('f')
    },
    (f) => {
      f.evidence.sourceModel.after['crates/target.rs'] = h('0')
    },
    (f) => {
      f.evidence.identity = { ...f.evidence.identity, jobKey: 'other' }
    },
    (f) => {
      f.job.indices.push(2)
    },
  ]) {
    const f = unitFixture()
    mutate(f)
    assert.throws(() => auditTerminalMutation(f))
  }
})

test('unit only: a ledger reaction needs actual case 3 wire and an independent DIFF', () => {
  for (const mutate of [
    (f) => {
      f.evidence.report.differences.pop()
      f.evidence.report.report.target.equal = 3
      f.evidence.detail = f.evidence.detail.replace(' | DIFF target case 3', '')
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.differences.shift()
      f.evidence.report.report.target.equal = 3
      f.evidence.detail = f.evidence.detail.replace('DIFF target case 0 | ', '')
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.differences[1].typescript = wire('different-ts')
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.differences[1].rust = wire('baseline-rust')
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.differences[1].rust = wire('baseline-ts')
      refreshReport(f)
    },
    (f) => {
      f.evidence.report.differences[1].rust = 'not-json'
      refreshReport(f)
    },
    (f) => {
      f.job.typedEvidenceRequirements[0].ledger[0].tupleSha256 = h('0')
      f.baseline.identity.planSha256 = hash(f.plan)
    },
  ]) {
    const f = unitFixture()
    mutate(f)
    assert.throws(() => auditTerminalMutation(f))
  }
})

test('historical fixture: four real stale rows do not supply terminal typed reports', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./recovery-stale-rows.json', import.meta.url), 'utf8'),
  )
  assert.equal(fixture.scope, 'original-intermediate-reports-absent-not-accepted')
  const rows = fixture.rows
  assert.equal(rows.length, 4)
  for (const row of rows) {
    assert.match(row.detail, /DIFF .* case \d+/)
    assert.equal(hash(row.mutation), row.mutationSha256)
    assert.equal(row.ledger.case, 3)
    const f = unitFixture()
    f.evidence.detail = row.detail
    delete f.evidence.report
    assert.throws(() => auditTerminalMutation(f), /terminal report/i)
  }
})
