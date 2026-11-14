import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditSnapshot } from './recovery-snapshot.mjs'
import { hashBytes } from './recovery-plan.mjs'

export async function bindSnapshotEvidence(
  manifest,
  snapshot,
  originalCatalogs,
  { request, archiveDir, sourceAt },
) {
  const receipt = auditSnapshot(manifest, snapshot, originalCatalogs)
  const readJson = async (path) => JSON.parse(await request(path))
  const run = await readJson(
    `actions/runs/${snapshot.original.runId}/attempts/${snapshot.original.attempt}`,
  )
  assert.equal(String(run.id), snapshot.original.runId)
  assert.equal(run.run_attempt, snapshot.original.attempt)
  assert.equal(run.head_sha, snapshot.original.definitionSha)
  const originalRunner = sourceAt(snapshot.original.productSha, 'tools/main-diff/faults.mjs')
  const productRunner = sourceAt(manifest.productSha, 'tools/main-diff/faults.mjs')
  assert.equal(
    hashBytes(originalRunner),
    '5ee0052330c9b76197beb4a4056a1bffdfc2c063f98440f608ebca94644adc5b',
  )
  assert.equal(
    hashBytes(productRunner),
    hashBytes(originalRunner),
    'Original mutator and restore path changed',
  )
  for (const [path, expected] of Object.entries(snapshot.reusedSourceHashes)) {
    assert.equal(hashBytes(sourceAt(snapshot.original.productSha, path)), expected.originalSha256)
    assert.equal(hashBytes(sourceAt(manifest.productSha, path)), expected.productSha256)
  }
  mkdirSync(archiveDir, { recursive: true })
  const bindings = []
  for (const complete of snapshot.complete) {
    const job = await readJson(`actions/jobs/${complete.jobId}`)
    const observed = snapshot.jobs.find((entry) => entry.id === job.id)
    for (const key of ['id', 'run_id', 'run_attempt', 'name', 'status', 'conclusion', 'steps'])
      assert.deepEqual(
        job[key],
        observed[key],
        `Completed job metadata changed: ${complete.jobId}/${key}`,
      )
    const artifact = await readJson(`actions/artifacts/${complete.artifactId}`)
    const oldArtifact = snapshot.artifacts.find((entry) => entry.id === artifact.id)
    for (const key of ['id', 'name', 'expired', 'size_in_bytes', 'workflow_run'])
      assert.deepEqual(
        artifact[key],
        oldArtifact[key],
        `Artifact identity changed: ${complete.artifactId}/${key}`,
      )
    const archiveBytes = await request(`actions/artifacts/${complete.artifactId}/zip`)
    assert.equal(hashBytes(archiveBytes), complete.archiveSha256)
    const path = join(archiveDir, `${complete.artifactId}.zip`)
    writeFileSync(path, archiveBytes, { flag: 'wx' })
    const json = (file) =>
      JSON.parse(execFileSync('unzip', ['-p', path, file], { maxBuffer: 64 << 20 }))
    assert.deepEqual(json('faults.json'), complete.rows)
    assert.deepEqual(json('identity.json'), complete.identity)
    assert.equal(
      execFileSync('unzip', ['-p', path, 'faults.txt'], { encoding: 'utf8', maxBuffer: 64 << 20 }),
      complete.summaryText,
    )
    const log = await request(`actions/jobs/${complete.jobId}/logs`)
    assert.equal(hashBytes(log), complete.logSha256)
    assert.equal(log.toString(), complete.completedLog)
    bindings.push({
      jobId: complete.jobId,
      artifactId: complete.artifactId,
      archiveSha256: complete.archiveSha256,
      logSha256: complete.logSha256,
    })
  }
  return {
    ...receipt,
    liveBinding: {
      originalRunnerSha256: hashBytes(originalRunner),
      artifacts: bindings,
      sourcePaths: Object.keys(snapshot.reusedSourceHashes).sort(),
      sourceRestoration:
        'Pinned original mutator finally and successful final unfaulted build; raw restored files absent.',
    },
  }
}
