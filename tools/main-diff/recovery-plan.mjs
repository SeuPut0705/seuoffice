import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { auditSnapshot } from './recovery-snapshot.mjs'

const PRODUCT = '375b08bd0e1f7e8432e6514468cc9d25be01b100'
const sha256 = /^[0-9a-f]{64}$/
const IDENTITIES = {
  original: {
    productSha: '30f303cde7b496bf640aadffcb0b70bf7fb2ad21',
    definitionSha: '7594c1243ef0c2965c202dead1fd983ad7ab77e9',
    runId: '43568242384',
    attempt: 1,
  },
  fullBaseline: {
    productSha: 'f5065c06a52b7ebbe4100da637140da4beb67182',
    definitionSha: '59682c00f070a406f108b47dca592381f57d40fa',
    runId: '43578414343',
    attempt: 1,
  },
  targetedProof: {
    productSha: PRODUCT,
    definitionSha: '7d30359f16efc9a117963ae38787dfdbe3e88a39',
    runId: '43591069529',
    attempt: 1,
  },
}
const sha = /^[0-9a-f]{40}$/
const catalogPath = /^tools\/main-diff\/faults\/[^/]+\.json$/

export const hashBytes = (buffer) => createHash('sha256').update(buffer).digest('hex')
export const hash = (value) => hashBytes(Buffer.from(JSON.stringify(value)))

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function validateCatalogs(manifest, catalogs) {
  requireValue(manifest?.contract === 'main-recovery-manifest/v1', 'Invalid manifest contract')
  requireValue(sha.test(manifest.productSha ?? ''), 'Invalid product SHA')
  requireValue(
    Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0,
    'No manifest catalogs',
  )
  requireValue(
    Array.isArray(catalogs) && catalogs.length === manifest.catalogs.length,
    'Catalog count mismatch',
  )
  const current = new Map()
  for (const catalog of catalogs) {
    requireValue(
      catalog && catalogPath.test(catalog.path) && !current.has(catalog.path),
      'Invalid or duplicate product catalog',
    )
    requireValue(
      sha256.test(catalog.sha256 ?? '') && Array.isArray(catalog.faults),
      'Invalid product catalog',
    )
    current.set(catalog.path, catalog)
  }
  const seen = new Set()
  for (const catalog of manifest.catalogs) {
    requireValue(
      catalog && catalogPath.test(catalog.path) && !seen.has(catalog.path),
      'Invalid or duplicate manifest catalog',
    )
    seen.add(catalog.path)
    const product = current.get(catalog.path)
    requireValue(
      product &&
        sha256.test(catalog.originalSha256 ?? '') &&
        catalog.productSha256 === product.sha256,
      `Catalog linkage mismatch: ${catalog.path}`,
    )
    requireValue(
      Array.isArray(catalog.mutations) &&
        catalog.mutations.length > 0 &&
        catalog.mutations.length === product.faults.length,
      `Mutation count mismatch: ${catalog.path}`,
    )
    for (let index = 0; index < catalog.mutations.length; index++) {
      const mutation = catalog.mutations[index]
      requireValue(
        mutation &&
          mutation.index === index &&
          sha256.test(mutation.originalSha256 ?? '') &&
          sha256.test(mutation.productSha256 ?? '') &&
          Array.isArray(mutation.affectedReasons) &&
          mutation.affectedReasons.every(
            (reason) => typeof reason === 'string' && reason.length > 0,
          ),
        `Invalid mutation: ${catalog.path}#${index}`,
      )
      requireValue(
        product.faults[index] !== undefined &&
          hash(product.faults[index]) === mutation.productSha256,
        `Product mutation hash mismatch: ${catalog.path}#${index}`,
      )
    }
  }
}

export function validateManifest(manifest, catalogs) {
  validateCatalogs(manifest, catalogs)
  requireValue(manifest.productSha === PRODUCT, 'Unexpected product')
  requireValue(manifest.catalogs.length === 46, 'Expected 46 catalogs')
  let count = 0
  let affected = 0
  for (const [key, identity] of Object.entries(IDENTITIES)) {
    requireValue(isDeepStrictEqual(manifest[key], identity), `Unexpected ${key} identity`)
  }
  requireValue(
    manifest.catalogs.some(
      (catalog) =>
        catalog.path === 'tools/main-diff/faults/b2.json' && catalog.mutations.length > 14,
    ),
    'Missing changed b2 mutation',
  )
  for (const catalog of manifest.catalogs) {
    const changedCatalog = catalog.path === 'tools/main-diff/faults/b2.json'
    requireValue(
      changedCatalog
        ? catalog.originalSha256 !== catalog.productSha256
        : catalog.originalSha256 === catalog.productSha256,
      `Original catalog linkage mismatch: ${catalog.path}`,
    )
    for (const mutation of catalog.mutations) {
      const changed = changedCatalog && mutation.index === 14
      requireValue(
        changed
          ? mutation.originalSha256 !== mutation.productSha256 &&
              mutation.affectedReasons.length > 0
          : mutation.originalSha256 === mutation.productSha256,
        `Original mutation linkage mismatch: ${catalog.path}#${mutation.index}`,
      )
      count++
      if (mutation.affectedReasons.length) affected++
    }
  }
  requireValue(
    count === 6121 && affected === 3834,
    'Unexpected production mutation or affected count',
  )
  return true
}

const id = (path, index) => `${path}#${index}`
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function scheduleRecovery(manifest, catalogs, requiredIds) {
  validateCatalogs(manifest, catalogs)
  requireValue(
    Array.isArray(requiredIds) && new Set(requiredIds).size === requiredIds.length,
    'Invalid required IDs',
  )
  const required = new Set(requiredIds)
  const known = new Set(
    manifest.catalogs.flatMap((catalog) =>
      catalog.mutations.map((mutation) => id(catalog.path, mutation.index)),
    ),
  )
  requireValue(
    [...required].every((key) => known.has(key)),
    'Unknown required ID',
  )
  const current = new Map(catalogs.map((catalog) => [catalog.path, catalog]))
  const jobs = []
  for (const catalog of manifest.catalogs) {
    const length = catalog.mutations.length
    const modulus = Math.max(4, 4 * Math.ceil((length - 1) / 96))
    const residues = new Set()
    for (let index = 1; index < length; index++) {
      if (required.has(id(catalog.path, index))) residues.add(index % modulus)
    }
    if (residues.size === 0 && required.has(id(catalog.path, 0))) residues.add(0)
    for (const residue of [...residues].sort((a, b) => a - b)) {
      const indices = [0]
      for (let index = 1; index < length; index++)
        if (index % modulus === residue) indices.push(index)
      const requiredIndices = indices.filter((index) => required.has(id(catalog.path, index)))
      const extraIndices = indices.filter((index) => !required.has(id(catalog.path, index)))
      jobs.push({
        jobKey: `${catalog.path}#${residue}/${modulus}`,
        catalog: catalog.path,
        slug: basename(catalog.path, '.json'),
        catalogSha256: current.get(catalog.path).sha256,
        modulus,
        residue,
        originalShard: residue % 4,
        indices,
        requiredIndices,
        extraIndices,
        entryHashes: indices.map((index) => ({
          index,
          originalSha256: catalog.mutations[index].originalSha256,
          productSha256: catalog.mutations[index].productSha256,
        })),
      })
    }
  }
  jobs.sort(
    (a, b) =>
      b.indices.length - a.indices.length || compare(a.catalog, b.catalog) || a.residue - b.residue,
  )
  const batches = []
  for (let index = 0; index < jobs.length; index++) {
    const batch = Math.floor(index / 256)
    jobs[index].batch = batch
    if (!batches[batch]) batches[batch] = []
    batches[batch].push(jobs[index].jobKey)
  }
  const expandedIds = [
    ...new Set(jobs.flatMap((job) => job.indices.map((index) => id(job.catalog, index)))),
  ].sort(compare)
  return { requiredIds: [...required].sort(compare), expandedIds, jobs, batches }
}

export function createRecoveryPlan(
  manifest,
  catalogs,
  { definitionSha, approvedReuse = [], snapshot, originalCatalogs } = {},
) {
  requireValue(Array.isArray(approvedReuse), 'Invalid approved reuse')
  requireValue(approvedReuse.length === 0, 'final original audit not attached')
  requireValue(sha.test(definitionSha ?? ''), 'Invalid definition SHA')
  validateManifest(manifest, catalogs)
  const receipt =
    snapshot === undefined ? undefined : auditSnapshot(manifest, snapshot, originalCatalogs)
  const requiredIds =
    receipt === undefined
      ? manifest.catalogs.flatMap((catalog) =>
          catalog.mutations.map((mutation) => id(catalog.path, mutation.index)),
        )
      : receipt.requiredIds
  return {
    contract: 'main-fault-recovery/v1',
    definitionSha,
    productSha: manifest.productSha,
    manifestSha256: hash(manifest),
    original: structuredClone(manifest.original),
    fullBaseline: structuredClone(manifest.fullBaseline),
    targetedProof: structuredClone(manifest.targetedProof),
    provisional: receipt === undefined,
    unresolvedOriginalAudit: receipt === undefined,
    ...(receipt === undefined
      ? {}
      : {
          selectionBasis: 'fixed-completed-snapshot',
          originalRunStillOpenAllowed: true,
          snapshotSha256: receipt.snapshotSha256,
          reusedIds: receipt.reuseIds,
          snapshotReceipt: {
            scope: receipt.scope,
            capturedAt: receipt.capturedAt,
            original: receipt.original,
            productSha: receipt.productSha,
            completedJobCount: receipt.completedJobCount,
            successfulProducerJobCount: receipt.successfulProducerJobCount,
            rejectedEvidence: receipt.rejectedEvidence,
            completeEvidence: receipt.completeEvidence,
          },
        }),
    ...scheduleRecovery(manifest, catalogs, requiredIds),
    maxParallel: 4,
    timeoutMinutes: 120,
    batchSize: 256,
  }
}

export function auditPlan(plan, manifest, catalogs, options = {}) {
  requireValue(plan && sha.test(plan.definitionSha ?? ''), 'Invalid plan definition')
  const expected = createRecoveryPlan(manifest, catalogs, {
    ...options,
    definitionSha: plan.definitionSha,
  })
  requireValue(
    isDeepStrictEqual(plan, expected),
    'Recovery plan does not match the complete bounded selection',
  )
  return true
}
