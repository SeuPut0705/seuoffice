import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hashBytes = (value) => createHash('sha256').update(value).digest('hex')
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const same = isDeepStrictEqual
const keyOf = (fn, index) => JSON.stringify([fn, index])
const tuple = (entry) => ({ typescript: entry.typescript, rust: entry.rust })

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function uniqueStrings(values, message) {
  requireValue(
    Array.isArray(values) &&
      values.length > 0 &&
      values.every((value) => typeof value === 'string' && value.length > 0) &&
      new Set(values).size === values.length,
    message,
  )
}

function diagnostics(stdout, stderr) {
  requireValue(
    typeof stdout === 'string' && typeof stderr === 'string',
    'Missing comparison output',
  )
  const text = `${stdout}\n${stderr}`
  requireValue(
    !/\bFLOOR: fewer than two distinct answers\b/.test(text) &&
      !/^(?:no such group:|fatal(?::|\s+error\b)|(?:[A-Za-z_$][\w$]*Error|Error)(?:\s+\[[^\]]+\])?(?::|\s+))/im.test(
        text,
      ),
    'Fatal comparison diagnostic',
  )
  const stale = [
    ...text.matchAll(/^STALE ledger entry ([^:\r\n]+): it no longer reproduces\s*$/gm),
  ].map((m) => m[1])
  requireValue(
    !/^STALE\b(?! ledger entry [^:\r\n]+: it no longer reproduces\s*$)/m.test(text) &&
      new Set(stale).size === stale.length,
    'Invalid or duplicate STALE diagnostic',
  )
  const diffs = [...stdout.matchAll(/^DIFF (\S+) case (\d+)(?:\s|$)/gm)].map((m) =>
    keyOf(m[1], Number(m[2])),
  )
  requireValue(
    new Set(diffs).size === diffs.length && !/^DIFF\b(?! \S+ case \d+(?:\s|$))/m.test(stdout),
    'Invalid or duplicate DIFF diagnostic',
  )
  return { stale, diffs }
}

function inspectReport(payload, inventory, ledger, command, normal, detailOutput) {
  requireValue(
    payload &&
      typeof payload.report === 'object' &&
      payload.report !== null &&
      !Array.isArray(payload.report) &&
      Array.isArray(payload.differences),
    'Missing comparison report',
  )
  const names = inventory.map((item) => item.name)
  requireValue(
    same(Object.keys(payload.report).sort(), [...names].sort()),
    'Report function inventory mismatch',
  )
  const byName = new Map(inventory.map((item) => [item.name, item]))
  const ledgerByKey = new Map(ledger.map((entry) => [keyOf(entry.fn, entry.case), entry]))
  const differences = new Map()
  for (const diff of payload.differences) {
    const fn = byName.get(diff?.fn)
    const key = keyOf(diff?.fn, diff?.case)
    requireValue(
      fn &&
        Number.isSafeInteger(diff.case) &&
        diff.case >= 0 &&
        diff.case < fn.checks &&
        !differences.has(key) &&
        typeof diff.typescript === 'string' &&
        typeof diff.rust === 'string' &&
        diff.typescript !== diff.rust,
      'Invalid or duplicate typed difference',
    )
    try {
      requireValue(
        JSON.parse(diff.typescript) !== null && JSON.parse(diff.rust) !== null,
        'Invalid wire',
      )
    } catch {
      throw new Error('Invalid typed difference wire')
    }
    differences.set(key, diff)
  }
  const output = normal ? diagnostics(command.stdout, command.stderr) : detailOutput
  requireValue(
    output.diffs.every((key) => differences.has(key)) &&
      (differences.size === 0 || output.diffs.length > 0),
    'DIFF output does not match report',
  )
  requireValue(
    output.stale.every((id) => ledger.some((entry) => entry.id === id)),
    'Unknown STALE ledger entry',
  )
  for (const fn of inventory) {
    const r = payload.report[fn.name]
    const count = [...differences.values()].filter((diff) => diff.fn === fn.name).length
    const entries = ledger.filter((entry) => entry.fn === fn.name)
    const staleCount = entries.filter((entry) => output.stale.includes(entry.id)).length
    requireValue(
      r &&
        Number.isSafeInteger(r.checks) &&
        r.checks === fn.checks &&
        Number.isSafeInteger(r.equal) &&
        r.equal >= 0 &&
        Number.isSafeInteger(r.listed) &&
        r.listed >= 0 &&
        Number.isSafeInteger(r.distinct) &&
        r.distinct >= 1 &&
        r.distinct <= r.checks &&
        (fn.single || r.distinct >= 2) &&
        r.equal + r.listed + count === r.checks &&
        r.listed === entries.length - staleCount,
      'Invalid report counts or FLOOR',
    )
    if (normal) {
      const line = `${fn.name}: ${r.checks} checks, ${count} differences, ${r.listed} listed, ${r.distinct} distinct`
      requireValue(
        command.stdout.split(/\r?\n/).filter((item) => item === line).length === 1,
        'Comparison output does not match inventory',
      )
    }
  }
  for (const [key] of differences) {
    const entry = ledgerByKey.get(key)
    if (entry) requireValue(output.stale.includes(entry.id), 'Ledger difference without STALE')
  }
  if (normal)
    requireValue(command.signal === null && command.status === 0, 'Invalid comparison exit status')
  if (normal)
    requireValue(differences.size === 0 && output.stale.length === 0, 'Normal baseline diverged')
  return { differences, stale: output.stale }
}

export function auditNormalBaseline(baseline) {
  requireValue(
    baseline &&
      baseline.identity &&
      typeof baseline.identity === 'object' &&
      !Array.isArray(baseline.identity) &&
      Object.keys(baseline.identity).length > 0 &&
      baseline.verdict === 'success' &&
      Array.isArray(baseline.functions) &&
      baseline.functions.length > 0 &&
      Array.isArray(baseline.ledger) &&
      baseline.ledgerSha256 === hash(baseline.ledger) &&
      baseline.reports &&
      typeof baseline.reports === 'object' &&
      Array.isArray(baseline.commands),
    'Invalid normal baseline',
  )
  requireValue(
    baseline.sources &&
      ['productMainSha256', 'ledgerFileSha256', 'mutatorSha256', 'wasmSha256'].every((field) =>
        sha256(baseline.sources[field]),
      ),
    'Invalid baseline source witness',
  )
  const names = new Set()
  const groups = new Map()
  for (const fn of baseline.functions) {
    requireValue(
      fn &&
        typeof fn.name === 'string' &&
        fn.name.length > 0 &&
        !names.has(fn.name) &&
        typeof fn.group === 'string' &&
        fn.group.length > 0 &&
        Number.isSafeInteger(fn.checks) &&
        fn.checks > 0 &&
        typeof fn.single === 'boolean',
      'Invalid or duplicate baseline function',
    )
    names.add(fn.name)
    if (!groups.has(fn.group)) groups.set(fn.group, [])
    groups.get(fn.group).push(fn)
  }
  const ledgerIds = new Set()
  const ledgerCases = new Set()
  for (const entry of baseline.ledger) {
    const fn = baseline.functions.find((item) => item.name === entry?.fn)
    const key = keyOf(entry?.fn, entry?.case)
    requireValue(
      fn &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        !ledgerIds.has(entry.id) &&
        Number.isSafeInteger(entry.case) &&
        entry.case >= 0 &&
        entry.case < fn.checks &&
        !ledgerCases.has(key) &&
        entry.typescript !== undefined &&
        entry.rust !== undefined &&
        JSON.stringify(entry.typescript) !== JSON.stringify(entry.rust),
      'Invalid or duplicate baseline ledger entry',
    )
    ledgerIds.add(entry.id)
    ledgerCases.add(key)
  }
  requireValue(
    same(Object.keys(baseline.reports).sort(), [...groups.keys()].sort()) &&
      baseline.commands.length === groups.size,
    'Baseline group inventory mismatch',
  )
  for (const [group, inventory] of groups) {
    const commands = baseline.commands.filter((item) => item?.group === group)
    requireValue(
      commands.length === 1 &&
        same([...commands[0].functions].sort(), inventory.map((fn) => fn.name).sort()),
      'Baseline command inventory mismatch',
    )
    inspectReport(
      baseline.reports[group],
      inventory,
      baseline.ledger.filter((entry) => inventory.some((fn) => fn.name === entry.fn)),
      commands[0],
      true,
    )
  }
  return {
    scope: 'normal-baseline-only',
    identity: baseline.identity,
    ledgerSha256: baseline.ledgerSha256,
    functions: baseline.functions.length,
    ledgerEntries: baseline.ledger.length,
  }
}

function detailDiagnostics(detail) {
  requireValue(typeof detail === 'string' && detail.length > 0, 'Missing mutation detail')
  const segments = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < detail.length; i++) {
    const char = detail[i]
    if (quoted && escaped) escaped = false
    else if (quoted && char === '\\') escaped = true
    else if (char === '"') quoted = !quoted
    if (!quoted && detail.startsWith(' | ', i)) {
      segments.push(detail.slice(start, i))
      i += 2
      start = i + 1
    }
  }
  segments.push(detail.slice(start))
  return diagnostics(segments.join('\n'), '')
}

export function auditTerminalMutation({ plan, job, catalog, index, baseline, evidence }) {
  auditNormalBaseline(baseline)
  requireValue(
    plan?.contract === 'main-fault-recovery/v1' &&
      Array.isArray(plan.jobs) &&
      plan.jobs.filter((item) => item.jobKey === job?.jobKey && same(item, job)).length === 1 &&
      catalog?.path === job.catalog &&
      catalog.sha256 === job.catalogSha256 &&
      Array.isArray(catalog.faults) &&
      Array.isArray(job.indices) &&
      job.indices.length > 1 &&
      job.indices[0] === 0 &&
      new Set(job.indices).size === job.indices.length &&
      job.indices.at(-1) === index &&
      Array.isArray(job.entryHashes) &&
      job.entryHashes.length === job.indices.length,
    'Invalid terminal mutation job',
  )
  const identity = baseline.identity
  requireValue(
    identity.jobKey === job.jobKey &&
      identity.planSha256 === hash(plan) &&
      identity.productSha === plan.productSha &&
      identity.definitionSha === plan.definitionSha &&
      identity.manifestSha256 === plan.manifestSha256 &&
      sha256(identity.manifestSha256) &&
      /^[1-9]\d*$/.test(String(identity.runId ?? '')) &&
      /^[1-9]\d*$/.test(String(identity.attempt ?? '')) &&
      same(evidence?.identity, identity),
    'Baseline identity mismatch',
  )
  for (let position = 0; position < job.indices.length; position++) {
    const current = job.indices[position]
    const fault = catalog.faults[current]
    const hashes = job.entryHashes[position]
    requireValue(
      Number.isSafeInteger(current) &&
        current >= 0 &&
        (position === 0 || current > job.indices[position - 1]) &&
        fault &&
        typeof fault.file === 'string' &&
        fault.file.length > 0 &&
        hashes?.index === current &&
        sha256(hashes.originalSha256) &&
        hashes.productSha256 === hash(fault),
      'Mutation hash or index mismatch',
    )
  }
  const fault = catalog.faults[index]
  uniqueStrings(fault.fn, 'Invalid fault selectors')
  const mutationSha256 = hash(fault)
  requireValue(
    Array.isArray(job.typedEvidenceRequirements) && job.typedEvidenceRequirements.length === 1,
    'Invalid typed evidence requirements',
  )
  const marker = job.typedEvidenceRequirements[0]
  requireValue(
    marker.index === index &&
      marker.catalog === job.catalog &&
      marker.mutationSha256 === mutationSha256 &&
      marker.name === fault.name &&
      same(marker.selectors, fault.fn) &&
      Array.isArray(marker.ledger) &&
      marker.ledger.length > 0 &&
      new Set(marker.ledger.map((entry) => entry.id)).size === marker.ledger.length,
    'Typed evidence requirement mismatch',
  )
  requireValue(
    evidence.index === index &&
      evidence.mutationSha256 === mutationSha256 &&
      Array.isArray(evidence.functions) &&
      same([...evidence.functions].sort(), [...fault.fn].sort()) &&
      typeof evidence.group === 'string' &&
      baseline.functions.every((fn) => fn.group === evidence.group) &&
      same(baseline.functions.map((fn) => fn.name).sort(), [...fault.fn].sort()),
    'Terminal selected function inventory mismatch',
  )
  const model = evidence.sourceModel
  const expectedPaths = [
    ...new Set(job.indices.map((i) => `crates/${catalog.faults[i].file}`)),
  ].sort()
  requireValue(
    model?.kind === 'pinned-original-runner-control-flow' &&
      model.mutatorSha256 === baseline.sources.mutatorSha256 &&
      model.findCount === 1 &&
      model.before &&
      same(Object.keys(model.before).sort(), expectedPaths) &&
      Object.values(model.before).every(sha256) &&
      same(model.before, model.after) &&
      sha256(model.derivedAppliedSourceSha256) &&
      model.derivedAppliedSourceSha256 !== model.before[`crates/${fault.file}`],
    'Invalid source model or source restoration',
  )
  requireValue(
    evidence.report &&
      evidence.reportSha256 === hashBytes(JSON.stringify(evidence.report, null, 2)),
    'Missing or changed terminal report',
  )
  const output = detailDiagnostics(evidence.detail)
  const declared = marker.ledger.map((entry) => entry.id)
  requireValue(
    same([...output.stale].sort(), [...declared].sort()),
    'Unexpected or missing STALE ledger reaction',
  )
  const result = inspectReport(
    evidence.report,
    baseline.functions,
    baseline.ledger,
    null,
    false,
    output,
  )
  const currentDiffs = [...result.differences.values()]
  const ledgerReactions = []
  for (const requirement of marker.ledger) {
    const entry = baseline.ledger.find((item) => item.id === requirement.id)
    requireValue(
      entry &&
        entry.fn === requirement.fn &&
        entry.case === requirement.case &&
        fault.fn.includes(entry.fn) &&
        sha256(requirement.tupleSha256) &&
        hash(tuple(entry)) === requirement.tupleSha256,
      'Baseline ledger tuple mismatch',
    )
    const diff = currentDiffs.find((item) => item.fn === entry.fn && item.case === entry.case)
    requireValue(
      diff &&
        diff.typescript === JSON.stringify(entry.typescript) &&
        diff.rust !== JSON.stringify(entry.rust) &&
        diff.typescript !== diff.rust,
      'Missing or unchanged typed ledger tuple',
    )
    const mutant = { typescript: JSON.parse(diff.typescript), rust: JSON.parse(diff.rust) }
    ledgerReactions.push({
      id: entry.id,
      fn: entry.fn,
      case: entry.case,
      kind: 'changed',
      baseline: tuple(entry),
      baselineTupleSha256: hash(tuple(entry)),
      mutant,
      mutantTupleSha256: hash(mutant),
    })
  }
  const ledgerKeys = new Set(baseline.ledger.map((entry) => keyOf(entry.fn, entry.case)))
  const independentDifferences = currentDiffs.filter(
    (diff) => !ledgerKeys.has(keyOf(diff.fn, diff.case)),
  )
  requireValue(independentDifferences.length > 0, 'Missing independent selected-function DIFF')
  return {
    scope: 'mutation-typed-evidence-only',
    index,
    mutationSha256,
    derivedAppliedSourceSha256: model.derivedAppliedSourceSha256,
    independentDifferences,
    ledgerReactions,
  }
}
