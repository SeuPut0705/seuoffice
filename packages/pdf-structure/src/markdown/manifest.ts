/**
 * The Markdown editor's app-owned asset list, `assets/.genoffice-assets.json`
 * next to the document. Same format and rules as
 * apps/markdown/src/main/asset-lifecycle.ts: files the app wrote (name +
 * SHA-256), and per document the names its saved text references. Files not
 * listed there are the user's and are never touched.
 *
 * A converted .md file is a finished save, so its pictures go under
 * `documents[<file name>]` (not `pending`, which the editor deletes when an
 * unsaved session is discarded).
 */

/** stored identifier: do not rename (existing documents rely on it) */
export const ASSET_MANIFEST_FILENAME = '.genoffice-assets.json'

export interface OwnedAssetRecord {
  name: string
  sha256: string
}

export interface OwnedAssetManifest {
  version: 1
  files: OwnedAssetRecord[]
  /** Markdown file name -> app-owned files referenced by its last successful save */
  documents: Record<string, string[]>
  /** newly created files stay protected until their owning document saves */
  pending: Record<string, string[]>
}

const SHA256_RE = /^[a-f0-9]{64}$/

function isSafeAssetName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 180 &&
    name !== '.' &&
    name !== '..' &&
    name !== ASSET_MANIFEST_FILENAME &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

function references(raw: unknown, what: string): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>
  if (raw === undefined) return out
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`asset manifest has bad ${what} references`)
  }
  for (const [key, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeAssetName(key) || !Array.isArray(names)) {
      throw new Error(`asset manifest has unsafe ${what} references`)
    }
    for (const name of names) {
      if (typeof name !== 'string' || !isSafeAssetName(name)) {
        throw new Error(`asset manifest has unsafe ${what} references`)
      }
    }
    out[key] = [...new Set(names as string[])].sort()
  }
  return out
}

function checkRecord(item: unknown): OwnedAssetRecord {
  if (!item || typeof item !== 'object') throw new Error('asset manifest has a bad file entry')
  const { name, sha256 } = item as { name?: unknown; sha256?: unknown }
  if (
    typeof name !== 'string' ||
    !isSafeAssetName(name) ||
    typeof sha256 !== 'string' ||
    !SHA256_RE.test(sha256)
  ) {
    throw new Error('asset manifest has an unsafe file entry')
  }
  return { name, sha256 }
}

/** parse and validate like the editor does; throws rather than guess */
export function parseAssetManifest(text: string | null | undefined): OwnedAssetManifest {
  const manifest: OwnedAssetManifest = {
    version: 1,
    files: [],
    documents: Object.create(null) as Record<string, string[]>,
    pending: Object.create(null) as Record<string, string[]>,
  }
  if (text === null || text === undefined || text.trim() === '') return manifest
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('asset manifest is invalid JSON', { cause: error })
  }
  if (!value || typeof value !== 'object') throw new Error('asset manifest is not an object')
  const raw = value as {
    version?: unknown
    files?: unknown
    documents?: unknown
    pending?: unknown
  }
  if (raw.version !== 1 || !Array.isArray(raw.files)) {
    throw new Error('asset manifest has an unsupported format')
  }
  const seen = new Set<string>()
  for (const item of raw.files) {
    const record = checkRecord(item)
    if (seen.has(record.name)) throw new Error('asset manifest has an unsafe file entry')
    seen.add(record.name)
    manifest.files.push(record)
  }
  manifest.documents = references(raw.documents, 'document')
  manifest.pending = references(raw.pending, 'pending')
  return manifest
}

/**
 * Merge a converted document's pictures into the manifest text found on
 * disk (null when there is none) and return the text to write back. Other
 * files, other documents and every pending list are kept as they are; this
 * document's reference list becomes exactly `records`, as after a save.
 * Throws when the existing manifest is unreadable or already owns one of
 * the names with different content: the caller must not overwrite it then.
 */
export function mergeAssetManifest(
  existing: string | null | undefined,
  documentName: string,
  records: readonly OwnedAssetRecord[],
): string {
  if (!isSafeAssetName(documentName)) throw new Error('unsafe document name for asset manifest')
  const manifest = parseAssetManifest(existing)
  const byName = new Map(manifest.files.map((r) => [r.name, r]))
  for (const item of records) {
    const record = checkRecord(item)
    const owned = byName.get(record.name)
    if (owned && owned.sha256 !== record.sha256) {
      throw new Error('asset manifest already owns a different file with this name')
    }
    if (!owned) {
      manifest.files.push(record)
      byName.set(record.name, record)
    }
  }
  manifest.files.sort((a, b) => a.name.localeCompare(b.name))
  const names = [...new Set(records.map((r) => r.name))].sort()
  if (names.length > 0) manifest.documents[documentName] = names
  else delete manifest.documents[documentName]
  return `${JSON.stringify(manifest, null, 2)}\n`
}
