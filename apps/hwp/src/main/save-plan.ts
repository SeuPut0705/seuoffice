import type { HwpFormat } from '../shared/ipc'

/**
 * Where the bytes a save is about to replace are kept. Beside the document so
 * the user can find it without the app.
 */
export function backupPathFor(path: string): string {
  return `${path}.bak`
}

/**
 * A file is backed up the first time a view overwrites it. Later saves in the
 * same session replace bytes this app already wrote, and a file the save
 * creates has nothing to keep.
 */
export function needsBackup(
  target: string,
  targetExists: boolean,
  written: ReadonlySet<string>,
): boolean {
  return targetExists && !written.has(target)
}

/** HWPX is a ZIP container. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
/** HWP 5 is an OLE compound file. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/**
 * The last check before bytes replace a user's file: they must at least be a
 * container of the format the file name promises.
 */
export function bytesMatchFormat(bytes: Uint8Array, format: HwpFormat): boolean {
  const magic = format === 'hwpx' ? ZIP_MAGIC : OLE_MAGIC
  if (bytes.length < magic.length) return false
  return magic.every((byte, index) => bytes[index] === byte)
}

/** Save As may return a name with no usable extension; keep the document's current format then. */
export function withFormatExtension(path: string, fallback: HwpFormat): string {
  return /\.(hwpx?)$/i.test(path) ? path : `${path}.${fallback}`
}
