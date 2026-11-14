import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const idFor = (catalog, index) => `${catalog}#${index}`

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function expectedJob(plan, jobKey) {
  requireValue(
    plan?.contract === 'main-fault-recovery/v1' && Array.isArray(plan.jobs),
    'Invalid plan',
  )
  const jobs = plan.jobs.filter((job) => job?.jobKey === jobKey)
  requireValue(jobs.length === 1, 'Unknown or duplicate job')
  const job = jobs[0]
  requireValue(typeof job.catalog === 'string' && job.catalog.length > 0, 'Invalid catalog')
  requireValue(sha256(job.catalogSha256), 'Missing catalog digest')
  requireValue(
    Array.isArray(job.indices) &&
      job.indices.length > 0 &&
      job.indices.length <= 25 &&
      job.indices[0] === 0,
    'Invalid job indices or control',
  )
  requireValue(
    Array.isArray(job.entryHashes) && job.entryHashes.length === job.indices.length,
    'Missing entry hashes',
  )
  const seen = new Set()
  for (let i = 0; i < job.indices.length; i++) {
    const index = job.indices[i]
    const entry = job.entryHashes[i]
    requireValue(
      Number.isSafeInteger(index) &&
        index >= 0 &&
        !seen.has(index) &&
        (i === 0 || index > job.indices[i - 1]),
      'Invalid or duplicate index',
    )
    requireValue(
      entry?.index === index && sha256(entry.originalSha256) && sha256(entry.productSha256),
      'Invalid entry hashes',
    )
    seen.add(index)
  }
  return job
}

function validateIdentity(plan, identity, jobKey) {
  requireValue(identity && typeof identity === 'object', 'Missing identity')
  requireValue(
    typeof plan.definitionSha === 'string' &&
      plan.definitionSha.length > 0 &&
      identity.definitionSha === plan.definitionSha,
    'Wrong definition',
  )
  requireValue(
    typeof plan.productSha === 'string' &&
      plan.productSha.length > 0 &&
      identity.productSha === plan.productSha,
    'Wrong product',
  )
  requireValue(
    sha256(plan.manifestSha256) && identity.manifestSha256 === plan.manifestSha256,
    'Wrong manifest',
  )
  requireValue(
    identity.planSha256 === digest(plan) && identity.jobKey === jobKey,
    'Wrong plan or job',
  )
  requireValue(
    /^[1-9][0-9]*$/.test(String(identity.runId ?? '')) &&
      /^[1-9][0-9]*$/.test(String(identity.attempt ?? '')),
    'Missing run identity',
  )
}

function validateDetail(detail, selectors) {
  requireValue(
    typeof detail === 'string' && Array.isArray(selectors) && selectors.length > 0,
    'Missing comparison detail',
  )
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
  let found = false
  for (const segment of segments) {
    requireValue(
      !/^(?:STALE ledger entry\b|no such group:|fatal(?::|\s+error\b)|(?:[A-Za-z_$][A-Za-z0-9_$]*Error|Error)(?:\s+\[[^\]]+\])?(?::|\s+))/i.test(
        segment,
      ) && !/\bFLOOR: fewer than two distinct answers\b/.test(segment),
      'Fatal comparison diagnostic',
    )
    const match = /^DIFF (\S+) case ([0-9]+)(?:\s|$)/.exec(segment)
    if (match && selectors.includes(match[1])) found = true
  }
  requireValue(found, 'Missing selector DIFF')
}

function validateSources(before, after, faults) {
  requireValue(
    before &&
      after &&
      typeof before === 'object' &&
      typeof after === 'object' &&
      !Array.isArray(before) &&
      !Array.isArray(after),
    'Missing source hashes',
  )
  const keys = Object.keys(before)
  const expected = [...new Set(faults.map((fault) => `crates/${fault.file}`))].sort()
  requireValue(
    keys.length > 0 &&
      isDeepStrictEqual([...keys].sort(), expected) &&
      isDeepStrictEqual([...keys].sort(), Object.keys(after).sort()),
    'Source hash paths differ',
  )
  for (const key of keys)
    requireValue(sha256(before[key]) && before[key] === after[key], 'Source was not restored')
}

export function auditJob(plan, jobKey, catalog, evidence) {
  const job = expectedJob(plan, jobKey)
  validateIdentity(plan, evidence?.identity, jobKey)
  requireValue(
    catalog?.path === job.catalog &&
      catalog.sha256 === job.catalogSha256 &&
      Array.isArray(catalog.faults),
    'Catalog digest or path changed',
  )
  requireValue(
    Array.isArray(evidence.rows) && evidence.rows.length === job.indices.length,
    'Incomplete result rows',
  )
  requireValue(typeof evidence.text === 'string', 'Missing summary')
  const summaries = [
    ...evidence.text.matchAll(
      /^([0-9]+) faults: ([0-9]+) caught, ([0-9]+) missed, ([0-9]+) not building, ([0-9]+) bad\s*$/gm,
    ),
  ]
  requireValue(
    summaries.length === 1 &&
      Number(summaries[0][1]) === job.indices.length &&
      Number(summaries[0][2]) === job.indices.length &&
      summaries[0].slice(3).every((n) => Number(n) === 0),
    'Incomplete or failing summary',
  )
  const selected = []
  const records = job.indices.map((index, position) => {
    const fault = catalog.faults[index]
    const hashes = job.entryHashes[position]
    const row = evidence.rows[position]
    requireValue(
      fault && digest(fault) === hashes.productSha256,
      `Changed product mutation ${index}`,
    )
    requireValue(
      row &&
        row.faults === job.catalog &&
        row.name === fault.name &&
        row.file === fault.file &&
        isDeepStrictEqual(row.fn, fault.fn) &&
        row.verdict === 'CAUGHT',
      `Invalid result ${index}`,
    )
    validateDetail(row.detail, fault.fn)
    selected.push(fault)
    return {
      id: idFor(job.catalog, index),
      index,
      originalSha256: hashes.originalSha256,
      productSha256: hashes.productSha256,
      verdict: row.verdict,
    }
  })
  validateSources(evidence.sourceBefore, evidence.sourceAfter, selected)
  return {
    scope: 'recovery-job-only',
    identity: { ...evidence.identity },
    records,
    catalog,
    evidence,
  }
}

export function mergeCompletions(plan, completions) {
  requireValue(
    Array.isArray(plan?.jobs) &&
      plan.jobs.length > 0 &&
      Array.isArray(plan.requiredIds) &&
      Array.isArray(plan.expandedIds),
    'Invalid plan coverage',
  )
  requireValue(Array.isArray(completions), 'Missing completions')
  const jobs = new Map()
  for (const job of plan.jobs) {
    expectedJob(plan, job.jobKey)
    requireValue(!jobs.has(job.jobKey), 'Duplicate planned job')
    jobs.set(job.jobKey, job)
  }
  requireValue(completions.length === jobs.size, 'Incomplete job set')
  const seenJobs = new Set()
  const seenIds = new Set()
  const batchRuns = new Map()
  for (const completion of completions) {
    const key = completion?.identity?.jobKey
    requireValue(
      completion?.scope === 'recovery-job-only' && jobs.has(key) && !seenJobs.has(key),
      'Unknown or duplicate completion',
    )
    validateIdentity(plan, completion.identity, key)
    const batch = jobs.get(key).batch
    requireValue(Number.isSafeInteger(batch) && batch >= 0, 'Missing batch identity')
    const run = `${completion.identity.runId}/${completion.identity.attempt}`
    requireValue(
      !batchRuns.has(batch) || batchRuns.get(batch) === run,
      'Mismatched batch run identity',
    )
    batchRuns.set(batch, run)
    seenJobs.add(key)
    const job = jobs.get(key)
    const audited = auditJob(plan, key, completion.catalog, completion.evidence)
    requireValue(
      isDeepStrictEqual(completion.identity, audited.identity) &&
        isDeepStrictEqual(completion.records, audited.records),
      'Completion evidence does not match records',
    )
    requireValue(
      Array.isArray(completion.records) && completion.records.length === job.indices.length,
      'Incomplete completion records',
    )
    for (let i = 0; i < job.indices.length; i++) {
      const index = job.indices[i]
      const record = completion.records[i]
      const hashes = job.entryHashes[i]
      const id = idFor(job.catalog, index)
      requireValue(
        record?.id === id &&
          record.index === index &&
          record.verdict === 'CAUGHT' &&
          record.originalSha256 === hashes.originalSha256 &&
          record.productSha256 === hashes.productSha256,
        'Invalid completion mutation',
      )
      if (index !== 0) requireValue(!seenIds.has(id), 'Duplicate noncontrol mutation')
      seenIds.add(id)
    }
  }
  const expanded = new Set(plan.expandedIds)
  const required = new Set(plan.requiredIds)
  requireValue(
    expanded.size === plan.expandedIds.length &&
      required.size === plan.requiredIds.length &&
      [...expanded].every((id) => typeof id === 'string' && seenIds.has(id)) &&
      seenIds.size === expanded.size &&
      [...required].every((id) => expanded.has(id)),
    'Incomplete or unexpected coverage',
  )
  return {
    scope: 'recovery-complete',
    identity: {
      definitionSha: plan.definitionSha,
      productSha: plan.productSha,
      manifestSha256: plan.manifestSha256,
      planSha256: digest(plan),
    },
    jobCount: seenJobs.size,
    mutationCount: seenIds.size,
  }
}
