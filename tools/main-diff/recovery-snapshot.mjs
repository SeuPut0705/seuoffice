import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hashText = (value) => createHash('sha256').update(value).digest('hex')
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const id = (path, index) => `${path}#${index}`
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}

function detailFailure(detail, selectors) {
  check(typeof detail === 'string', 'Missing comparison detail')
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
    if (
      /^(?:STALE ledger entry\b|no such group:|fatal(?::|\s+error\b)|(?:[A-Za-z_$][A-Za-z0-9_$]*Error|Error)(?:\s+\[[^\]]+\])?(?::|\s+))/i.test(
        segment,
      ) ||
      /^(?:\s*FLOOR: fewer than two distinct answers\b|\S+: \d+ checks, \d+ differences, \d+ listed, \d+ distinct {2}FLOOR: fewer than two distinct answers\b)/.test(
        segment,
      )
    )
      return `Fatal comparison diagnostic: ${segment}`
    const match = /^DIFF (\S+) case ([0-9]+)(?:\s|$)/.exec(segment)
    if (match && selectors.includes(match[1])) found = true
  }
  return found ? null : 'Missing selector DIFF'
}

function checkoutHeads(log, original) {
  check(typeof log === 'string', 'Missing completed log')
  const lines = log.split(/\r?\n/)
  const heads = []
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\S+ \[command\]\/usr\/bin\/git log -1 --format=%H$/.test(lines[i])) {
      const match = /^\S+ ([a-f0-9]{40})$/.exec(lines[i + 1])
      check(match, 'Invalid checkout log output')
      heads.push(match[1])
    }
  }
  check(
    isDeepStrictEqual(heads, [original.definitionSha, original.productSha]),
    'Checkout heads mismatch',
  )
}

export function auditSnapshot(manifest, snapshot, catalogs) {
  check(
    manifest?.contract === 'main-recovery-manifest/v1' &&
      snapshot?.contract === 'main-recovery-snapshot/v1',
    'Invalid snapshot or manifest contract',
  )
  const original = manifest.original
  check(
    original &&
      sha(original.definitionSha) &&
      sha(original.productSha) &&
      /^[1-9][0-9]*$/.test(original.runId) &&
      original.attempt === 1 &&
      sha(manifest.productSha),
    'Invalid original identity',
  )
  check(
    isDeepStrictEqual(snapshot.original, original) && snapshot.productSha === manifest.productSha,
    'Snapshot identity mismatch',
  )
  const base = { ...manifest }
  delete base.reuseSnapshot
  check(snapshot.manifestBaseSha256 === hash(base), 'Snapshot manifest binding mismatch')
  check(
    typeof snapshot.capturedAt === 'string' && Number.isFinite(Date.parse(snapshot.capturedAt)),
    'Invalid capture time',
  )
  const run = snapshot.run
  check(
    run &&
      String(run.id) === original.runId &&
      run.run_attempt === original.attempt &&
      run.head_sha === original.definitionSha &&
      ['queued', 'in_progress', 'completed'].includes(run.status) &&
      run.event === 'workflow_dispatch' &&
      run.path === '.github/workflows/seuoffice-rust.yml',
    'Original run mismatch',
  )
  check(
    Array.isArray(manifest.catalogs) &&
      Array.isArray(catalogs) &&
      catalogs.length === manifest.catalogs.length,
    'Original catalog count mismatch',
  )
  const catalogMap = new Map()
  const mutations = new Map()
  const mutationFiles = new Map()
  for (const entry of manifest.catalogs) {
    check(
      entry &&
        /^tools\/main-diff\/faults\/[^/]+\.json$/.test(entry.path) &&
        !catalogMap.has(entry.path),
      'Invalid manifest catalog',
    )
    const matches = catalogs.filter((catalog) => catalog.path === entry.path)
    check(
      matches.length === 1 &&
        matches[0].sha256 === entry.originalSha256 &&
        sha256(entry.originalSha256) &&
        Array.isArray(matches[0].faults) &&
        Array.isArray(entry.mutations) &&
        matches[0].faults.length === entry.mutations.length &&
        entry.mutations.length > 0,
      'Original catalog mismatch',
    )
    const faults = matches[0].faults
    const identities = new Set()
    faults.forEach((fault, index) => {
      const mutation = entry.mutations[index]
      check(
        fault &&
          typeof fault.name === 'string' &&
          fault.name &&
          typeof fault.file === 'string' &&
          fault.file &&
          typeof fault.find === 'string' &&
          fault.find &&
          typeof fault.replace === 'string' &&
          Array.isArray(fault.fn) &&
          fault.fn.length &&
          fault.fn.every((fn) => typeof fn === 'string' && fn),
        'Invalid original fault',
      )
      mutationFiles.set(id(entry.path, index), `crates/${fault.file}`)
      const identity = JSON.stringify([fault.name, fault.file, fault.fn])
      check(!identities.has(identity), 'Duplicate fault identity')
      identities.add(identity)
      check(
        mutation &&
          mutation.index === index &&
          mutation.originalSha256 === hash(fault) &&
          sha256(mutation.productSha256) &&
          Array.isArray(mutation.affectedReasons) &&
          mutation.affectedReasons.every((reason) => typeof reason === 'string' && reason.length),
        'Original mutation mismatch',
      )
      mutations.set(id(entry.path, index), mutation)
    })
    catalogMap.set(entry.path, faults)
  }
  check(
    Array.isArray(snapshot.jobs) &&
      Number.isSafeInteger(snapshot.jobCount) &&
      snapshot.jobs.length === snapshot.jobCount &&
      Array.isArray(snapshot.artifacts) &&
      Number.isSafeInteger(snapshot.artifactCount) &&
      snapshot.artifacts.length === snapshot.artifactCount,
    'Snapshot metadata count mismatch',
  )
  check(
    Array.isArray(snapshot.complete) && Array.isArray(snapshot.incomplete),
    'Missing evidence lists',
  )
  const jobs = new Map()
  const matrix = new Map()
  const otherJobs = new Set([
    'main-faults-only-prepare',
    'quick',
    'faults',
    'pptx',
    'odt',
    'main-windows',
    'odt-faults',
    'crates',
    'pptx-faults',
    'main-faults',
  ])
  for (const job of snapshot.jobs) {
    check(
      Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        !jobs.has(job.id) &&
        String(job.run_id) === original.runId &&
        job.run_attempt === original.attempt &&
        job.head_sha === original.definitionSha &&
        ['queued', 'in_progress', 'completed'].includes(job.status),
      'Invalid or duplicate job metadata',
    )
    jobs.set(job.id, job)
    const match =
      /^main-faults-only \((tools\/main-diff\/faults\/[^/]+\.json), ([^,]+), ([0-3])\)$/.exec(
        job.name,
      )
    if (!match) {
      check(otherJobs.delete(job.name), 'Unknown or duplicate job name')
      continue
    }
    const [, path, label, shard] = match
    check(catalogMap.has(path) && label === basename(path, '.json'), 'Unknown matrix job')
    const key = `${path}#${shard}`
    check(!matrix.has(key), 'Duplicate matrix job')
    matrix.set(key, job)
  }
  check(matrix.size === catalogMap.size * 4, 'Incomplete original job matrix')
  const artifacts = new Map()
  const artifactNames = new Map()
  for (const artifact of snapshot.artifacts) {
    check(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        !artifacts.has(artifact.id) &&
        typeof artifact.name === 'string' &&
        !artifactNames.has(artifact.name) &&
        String(artifact.workflow_run?.id) === original.runId &&
        artifact.workflow_run?.head_sha === original.definitionSha,
      'Invalid or duplicate artifact metadata',
    )
    if (artifact.name !== 'main-faults-only-plan') {
      const match = /^main-faults-only-(.+)-([0-3])$/.exec(artifact.name)
      check(
        match && matrix.has(`tools/main-diff/faults/${match[1]}.json#${match[2]}`),
        'Unknown artifact',
      )
      const job = matrix.get(`tools/main-diff/faults/${match[1]}.json#${match[2]}`)
      check(job.status === 'completed', 'Artifact for unfinished job')
    }
    artifacts.set(artifact.id, artifact)
    artifactNames.set(artifact.name, artifact)
  }
  const used = new Set()
  const completedIds = new Set()
  const completeEvidence = []
  const rejectedEvidence = []
  for (const entry of snapshot.complete) {
    check(
      entry && Number.isInteger(entry.shard) && entry.shard >= 0 && entry.shard < 4,
      'Invalid complete shard',
    )
    const key = `${entry.catalog}#${entry.shard}`
    const job = matrix.get(key)
    const faults = catalogMap.get(entry.catalog)
    check(
      job &&
        job.id === entry.jobId &&
        job.status === 'completed' &&
        job.conclusion === 'success' &&
        !used.has(key),
      'Unmatched complete job',
    )
    used.add(key)
    for (const name of [
      'Check plan identities',
      'Faults',
      'Audit fault results',
      'Keep the result',
    ]) {
      const steps = job.steps?.filter((step) => step.name === name)
      check(
        steps?.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success',
        `Unsuccessful ${name} step`,
      )
    }
    const artifact = artifacts.get(entry.artifactId)
    check(
      artifact &&
        artifact.name === `main-faults-only-${basename(entry.catalog, '.json')}-${entry.shard}` &&
        artifact.expired === false &&
        sha256(entry.archiveSha256) &&
        artifact.digest === `sha256:${entry.archiveSha256}`,
      'Complete artifact mismatch',
    )
    const indices = faults
      .map((_, index) => index)
      .filter((index) => index === 0 || index % 4 === entry.shard)
    check(
      isDeepStrictEqual(entry.identity, {
        definitionSha: original.definitionSha,
        productSha: original.productSha,
        gate: { id: '43554838447', attempt: 1 },
        catalog: entry.catalog,
        shard: entry.shard,
        count: indices.length,
      }),
      'Original identity mismatch',
    )
    check(
      Array.isArray(entry.rows) && entry.rows.length === indices.length,
      'Incomplete result rows',
    )
    const diagnostics = []
    indices.forEach((index, rowIndex) => {
      const fault = faults[index]
      const row = entry.rows[rowIndex]
      check(
        row &&
          row.faults === entry.catalog &&
          row.name === fault.name &&
          row.file === fault.file &&
          isDeepStrictEqual(row.fn, fault.fn) &&
          row.verdict === 'CAUGHT',
        'Invalid result row',
      )
      const reason = detailFailure(row.detail, fault.fn)
      if (reason) diagnostics.push({ index, name: fault.name, mutationSha256: hash(fault), reason })
    })
    check(typeof entry.summaryText === 'string', 'Missing summary')
    const summaries = [
      ...entry.summaryText.matchAll(
        /^(\d+) faults: (\d+) caught, (\d+) missed, (\d+) not building, (\d+) bad\r?$/gm,
      ),
    ]
    check(
      summaries.length === 1 &&
        Number(summaries[0][1]) === indices.length &&
        Number(summaries[0][2]) === indices.length &&
        summaries[0].slice(3).every((n) => Number(n) === 0),
      'Invalid success summary',
    )
    check(
      /(?:^|\n)\s*Finished `node-faults` profile[^\n]*(?:\n|$)/.test(
        entry.summaryText.slice(summaries[0].index + summaries[0][0].length),
      ),
      'Missing final unfaulted build',
    )
    check(
      sha256(entry.logSha256) &&
        typeof entry.completedLog === 'string' &&
        hashText(entry.completedLog) === entry.logSha256,
      'Completed log hash mismatch',
    )
    checkoutHeads(entry.completedLog, original)
    const evidence = {
      catalog: entry.catalog,
      shard: entry.shard,
      jobId: job.id,
      artifactId: artifact.id,
      archiveSha256: entry.archiveSha256,
      logSha256: entry.logSha256,
      identitySha256: hash(entry.identity),
      rowsSha256: hash(entry.rows),
      summarySha256: hashText(entry.summaryText),
      originalCatalogSha256: manifest.catalogs.find((catalog) => catalog.path === entry.catalog)
        .originalSha256,
      sourceRestore:
        'original runner finally and successful Faults step final unfaulted build; raw restored files absent',
    }
    if (diagnostics.length) {
      rejectedEvidence.push({ ...evidence, indices, diagnostics })
    } else {
      for (const index of indices) completedIds.add(id(entry.catalog, index))
      completeEvidence.push(evidence)
    }
  }
  for (const entry of snapshot.incomplete) {
    check(
      entry && Number.isInteger(entry.shard) && entry.shard >= 0 && entry.shard < 4,
      'Invalid incomplete shard',
    )
    const key = `${entry.catalog}#${entry.shard}`
    const job = matrix.get(key)
    check(
      job &&
        job.id === entry.jobId &&
        job.status === 'completed' &&
        job.conclusion !== 'success' &&
        job.status === entry.status &&
        job.conclusion === entry.conclusion &&
        !used.has(key) &&
        typeof entry.reason === 'string' &&
        entry.reason.length,
      'Unmatched incomplete job',
    )
    const artifact = artifactNames.get(
      `main-faults-only-${basename(entry.catalog, '.json')}-${entry.shard}`,
    )
    check(entry.artifactId === (artifact?.id ?? null), 'Incomplete artifact mismatch')
    used.add(key)
  }
  for (const [key, job] of matrix)
    check(job.status !== 'completed' || used.has(key), 'Completed job missing evidence')
  const completeUniqueIds = [...completedIds].sort()
  const affectedCompletedIds = completeUniqueIds.filter(
    (key) => mutations.get(key).affectedReasons.length > 0,
  )
  const reuseIds = completeUniqueIds.filter((key) => {
    const mutation = mutations.get(key)
    return (
      mutation.affectedReasons.length === 0 && mutation.originalSha256 === mutation.productSha256
    )
  })
  const sourcePaths = [...new Set(reuseIds.map((key) => mutationFiles.get(key)))].sort()
  const sourceHashes = snapshot.reusedSourceHashes
  check(
    sourceHashes &&
      typeof sourceHashes === 'object' &&
      !Array.isArray(sourceHashes) &&
      isDeepStrictEqual(Object.keys(sourceHashes).sort(), sourcePaths),
    'Reused source path mismatch',
  )
  for (const path of sourcePaths) {
    const source = sourceHashes[path]
    check(
      sha256(source?.originalSha256) && source.originalSha256 === source.productSha256,
      'Reused source hash mismatch',
    )
  }
  check(isDeepStrictEqual(snapshot.reuseIds, reuseIds), 'Snapshot reuse IDs mismatch')
  const reused = new Set(reuseIds)
  const requiredIds = [...mutations.keys()].filter((key) => !reused.has(key)).sort()
  return {
    scope: 'fixed-original-completed-snapshot-only',
    capturedAt: snapshot.capturedAt,
    original,
    productSha: manifest.productSha,
    snapshotSha256: hash(snapshot),
    completedJobCount: completeEvidence.length,
    successfulProducerJobCount: snapshot.complete.length,
    rejectedEvidence,
    completeUniqueIds,
    affectedCompletedIds,
    reuseIds,
    requiredIds,
    completeEvidence,
  }
}
