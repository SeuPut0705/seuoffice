/**
 * The zip side of a map file: reading entries and writing an archive back with
 * some entries replaced.
 *
 * A rewrite starts from the original archive and touches only the entries it
 * is told to replace. Every other entry keeps its name, its place in the
 * archive, its date and its compression method, which lets JSZip copy the
 * stored bytes across as they are instead of inflating and deflating them
 * again. The container around them is written anew: per-entry extra fields
 * (extended timestamps and the like) are not carried.
 */

import JSZip from 'jszip'

const EOCD_SIGNATURE = 0x06054b50
const EOCD_MIN_LENGTH = 22
const MAX_ZIP_COMMENT = 0xffff
/** what a UTF-8 decoder leaves in place of bytes that are not UTF-8 */
const UNDECODABLE = '�'

type Compression = 'STORE' | 'DEFLATE'

/**
 * How many entries the archive's end-of-central-directory record declares, or
 * null when the bytes have no such record. That record is the line between
 * "not a zip at all" and "a zip the gate turns down": the scan covers the same
 * span the gate searches, so whatever has a count here is judged by the gate
 * as an archive.
 */
export function zipEntryCount(bytes: Uint8Array): number | null {
  const last = bytes.byteLength - EOCD_MIN_LENGTH
  if (last < 0) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = last; at >= Math.max(0, last - MAX_ZIP_COMMENT); at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return view.getUint16(at + 10, true)
  }
  return null
}

/**
 * Whether a rewrite can carry every entry over under its own name. JSZip keeps
 * one entry per name, cleans names that climb out of the archive and decodes
 * names as UTF-8, so an archive with a repeated name, a `../` name or a name
 * in another encoding would come back with an entry missing or renamed.
 */
export function carriesEveryEntry(zip: JSZip, declaredEntries: number): boolean {
  const files = Object.values(zip.files)
  if (files.length !== declaredEntries) return false
  return files.every((file) => {
    const original = (file as { unsafeOriginalName?: string }).unsafeOriginalName
    const renamed = original !== undefined && original !== file.name
    return !renamed && !file.name.includes(UNDECODABLE)
  })
}

/** Opens an archive that has already passed the zip gate. */
export function loadArchive(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes)
}

/** Names of the file entries, in archive order. Folders are not listed. */
export function fileNames(zip: JSZip): string[] {
  return Object.values(zip.files)
    .filter((file) => !file.dir)
    .map((file) => file.name)
}

/** The bytes of one file entry, or null when the archive has no such file. */
export async function readEntry(zip: JSZip, name: string): Promise<Uint8Array | null> {
  const file = zip.file(name)
  return file ? file.async('uint8array') : null
}

/**
 * The original archive with the given entries replaced. A replacement for a
 * name the archive does not have is added after the existing entries.
 */
export async function rewriteArchive(
  original: Uint8Array,
  replacements: ReadonlyMap<string, Uint8Array>,
  now: Date,
): Promise<Uint8Array> {
  const zip = await loadArchive(original)
  const files = Object.values(zip.files)
  for (const file of files) {
    const method = storedMethod(file)
    if (method) file.options.compression = method
  }
  for (const [name, data] of replacements) {
    const previous = zip.file(name)
    zip.file(name, data, {
      binary: true,
      // A missing folder entry is not invented: the entry list stays as it was.
      createFolders: false,
      date: now,
      compression: (previous && storedMethod(previous)) ?? 'DEFLATE',
      comment: previous?.comment,
      unixPermissions: previous?.unixPermissions,
      dosPermissions: previous?.dosPermissions,
    })
  }
  // Unix permissions are only written for a Unix-made archive: stay what it was.
  const platform = files.some((file) => file.unixPermissions != null) ? 'UNIX' : 'DOS'
  return zip.generateAsync({ type: 'uint8array', platform })
}

/** A new archive with these entries, in this order. */
export function buildArchive(
  entries: readonly (readonly [name: string, data: Uint8Array])[],
  now: Date,
): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, data] of entries) {
    zip.file(name, data, { binary: true, createFolders: false, date: now, compression: 'DEFLATE' })
  }
  return zip.generateAsync({ type: 'uint8array' })
}

/**
 * How an entry read from an archive was compressed. JSZip keeps this on the
 * loaded entry without exposing it; an entry it cannot tell for is left to the
 * archive-wide default.
 */
function storedMethod(file: JSZip.JSZipObject): Compression | null {
  const magic = (file as unknown as { _data?: { compression?: { magic?: unknown } } })._data
    ?.compression?.magic
  if (magic === '\x08\x00') return 'DEFLATE'
  if (magic === '\x00\x00') return 'STORE'
  return null
}
