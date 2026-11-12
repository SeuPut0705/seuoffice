/**
 * Reading the cells the reader withheld from the model, from the workbook
 * package part that records them (`xl/gxRedactions.json`), or — when that part
 * is not there — from the copy of the same marks written into the workbook's
 * defined names.
 *
 * ## Why this is a three-state answer
 *
 * The part is optional — a workbook that never withheld anything has none, and
 * that is the common case — but its absence and a part this version cannot
 * parse mean opposite things:
 *
 * - **absent** — nothing is withheld. Reads go through unchanged.
 * - **unreadable** — the part exists and says something this version does not
 *   understand. `[]` here would be a lie in the worst direction: the model
 *   would receive exactly the values the reader hid, and nothing on screen
 *   would say so.
 *
 * So the failure is carried to the renderer as its own state instead of being
 * smoothed into an empty list, and the renderer withholds rather than reveals
 * (see `renderer/ai/redact-load.ts`).
 *
 * ## Why there is a second place to read the marks from
 *
 * The part survives Excel and SeuOffice, and not everything else. A reader that
 * rebuilds the package from its own model drops parts it does not model along
 * with their relationships and content-type overrides — `soffice
 * --convert-to xlsx` leaves none of the three. So every save also writes the
 * marks into defined names, which every spreadsheet program has to keep
 * working (`applyRedactionNameMirror` in the gateway).
 *
 * The part stays the record. The mirror is consulted only when the part cannot
 * be read at all, which is exactly the case where the alternative is
 * withholding the whole workbook or — worse, for a file that was merely
 * re-saved elsewhere — reading the values the reader chose to hide. Opening
 * such a workbook and saving it restores the part from the mirror, so the
 * fallback is a repair, not a permanent second-class mode.
 */
import { z } from 'zod'

import {
  readArchiveEntryText,
  type ArchiveClient,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-package-io'
import { readRedactionEntries, type RedactionPartRead } from './workbook-redaction-entries'

/// Only the entry names are needed, so this stays structural rather than
/// re-validating every CRC and size the save path checks. Shared with the
/// slicer-state read.
export const manifestNamesSchema = z.object({ entries: z.array(z.object({ name: z.string() })) })
/**
 * Read the redaction part out of an open session's snapshot, falling back to
 * the defined-name mirror when there is nothing to read there.
 *
 * Existence is checked through the archive manifest rather than by catching the
 * sidecar's "Workbook is missing …" failure: that string is a user-facing
 * message, not a contract, and the manifest is the same list the save path
 * diffs against. The snapshot is read rather than the live path so the marks
 * match the bytes this session's pending edits were made against.
 *
 * Any failure once the part is known to exist — unparseable JSON, an unknown
 * part version, a sidecar error mid-read — is `unreadable`. Not knowing what is
 * withheld is the one state that must never be read as "nothing is". It is the
 * state the mirror exists to rescue: the mirror holds the same marks, written
 * on the same save, so it gets a turn before the answer is given up on.
 */
export async function readWorkbookRedactionPart(
  client: ArchiveClient,
  snapshotPath: string,
): Promise<RedactionPartRead> {
  const manifest = manifestNamesSchema.parse(await client.archiveManifest(snapshotPath))
  const names = new Set(manifest.entries.map((entry) => entry.name))
  return readRedactionEntries({
    has: async (path) => names.has(path),
    readText: (path) => readArchiveEntryText(client, snapshotPath, path),
  })
}
