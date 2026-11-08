import {
  assertZipInflatesWithinLimits,
  DEFAULT_ZIP_LIMITS,
  type ZipLimits,
} from '@genoffice/zip-gate'
import type JSZip from 'jszip'
import { carriesEveryEntry, loadArchive, readEntry, zipEntryCount } from './archive'
import { parseJsonBytes, serializeSheets } from './content'
import { XmindDocument } from './document'
import { CONTENT_ENTRY, LEGACY_CONTENT_ENTRY, MANIFEST_ENTRY } from './entry-names'
import { checkContentStructure } from './structure-check'
import { isRecord } from './types'

/** The limits a map file is opened with: the ones the other document engines share. */
export const XMIND_ZIP_LIMITS: ZipLimits = DEFAULT_ZIP_LIMITS

/**
 * The five ways opening a file can end.
 *
 * - `ok`: `content.json` is there and passed the structure check.
 * - `legacy-format`: no `content.json`, only the older `content.xml`.
 * - `encrypted`: the zip is fine, and the file's own manifest says its content
 *   is encrypted.
 * - `unreadable`: not a zip, a zip with no content, content that cannot be
 *   parsed or fails the structure check, or an archive whose entries a save
 *   could not carry over (see `carriesEveryEntry`).
 * - `rejected`: a zip the zip gate turned down, whatever the reason, including
 *   zip-level encryption and compression the gate cannot check.
 */
export type XmindOpenStatus = 'ok' | 'legacy-format' | 'encrypted' | 'unreadable' | 'rejected'

/**
 * Only `ok` carries a document. Every other result is a status and a line for
 * the log (`detail` is English and not meant for the screen): no bytes, no
 * tree, nothing a save could be made from.
 */
export type XmindOpenResult =
  | { status: 'ok'; document: XmindDocument }
  | { status: Exclude<XmindOpenStatus, 'ok'>; detail: string }

export interface XmindOpenOptions {
  /** zip limits to open with; `XMIND_ZIP_LIMITS` when left out */
  limits?: ZipLimits
}

/**
 * Opens a map file held in memory. Never throws for anything in the file and
 * never changes the bytes it is given; the document works on its own copy.
 *
 * The zip gate runs first and nothing is unpacked before it passes.
 */
export async function openXmind(
  input: Uint8Array,
  options: XmindOpenOptions = {},
): Promise<XmindOpenResult> {
  // A real copy: `slice` on a Node byte buffer would only be another view.
  const bytes = new Uint8Array(input)
  const declaredEntries = zipEntryCount(bytes)
  if (declaredEntries === null) return failed('unreadable', 'the file is not a zip archive')
  try {
    await assertZipInflatesWithinLimits(bytes, options.limits ?? XMIND_ZIP_LIMITS)
  } catch (error) {
    return failed('rejected', messageOf(error))
  }

  let zip: JSZip
  try {
    zip = await loadArchive(bytes)
  } catch (error) {
    return failed('unreadable', `the archive cannot be read: ${messageOf(error)}`)
  }
  if (!zip.file(CONTENT_ENTRY)) {
    return zip.file(LEGACY_CONTENT_ENTRY)
      ? failed('legacy-format', `the file has ${LEGACY_CONTENT_ENTRY} but no ${CONTENT_ENTRY}`)
      : failed('unreadable', `the archive has no ${CONTENT_ENTRY}`)
  }
  // Before the content is parsed: encrypted content is not JSON, and the file
  // should be reported for what it is.
  if (await manifestMarksEncryption(zip)) {
    return failed('encrypted', `${MANIFEST_ENTRY} marks the content as encrypted`)
  }

  let content: unknown
  try {
    content = parseJsonBytes((await readEntry(zip, CONTENT_ENTRY))!)
  } catch (error) {
    return failed('unreadable', `${CONTENT_ENTRY} cannot be parsed: ${messageOf(error)}`)
  }
  const check = checkContentStructure(content)
  if (!check.ok) return failed('unreadable', `${CONTENT_ENTRY}: ${check.problem}`)
  let baselineContent: string
  try {
    // Also proves the tree can be written back: values nested too deep to
    // serialise would otherwise only fail at the first save.
    baselineContent = serializeSheets(check.sheets)
  } catch (error) {
    return failed('unreadable', `${CONTENT_ENTRY} cannot be written back: ${messageOf(error)}`)
  }
  // Last, so a file that would not have opened anyway keeps its own reason.
  if (!carriesEveryEntry(zip, declaredEntries)) {
    return failed('unreadable', 'the archive has entries a save could not carry over by name')
  }
  return { status: 'ok', document: new XmindDocument(bytes, zip, check.sheets, baselineContent) }
}

/**
 * The one sign of an encrypted map the engine relies on: any entry under the
 * manifest's `file-entries` that carries `encryption-data`. Which cipher it
 * names is not looked at. A manifest that is missing or cannot be read marks
 * nothing; such a file is then judged by its content.
 */
async function manifestMarksEncryption(zip: JSZip): Promise<boolean> {
  try {
    const bytes = await readEntry(zip, MANIFEST_ENTRY)
    if (!bytes) return false
    const manifest = parseJsonBytes(bytes)
    const entries = isRecord(manifest) ? manifest['file-entries'] : undefined
    if (!isRecord(entries)) return false
    return Object.values(entries).some(
      (entry) => isRecord(entry) && Object.hasOwn(entry, 'encryption-data'),
    )
  } catch {
    return false
  }
}

function failed(status: Exclude<XmindOpenStatus, 'ok'>, detail: string): XmindOpenResult {
  return { status, detail }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error)
}
