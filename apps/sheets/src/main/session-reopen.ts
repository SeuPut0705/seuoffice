/**
 * Continuing a session after the sidecar process died.
 *
 * The renderer recovers by asking to re-open "the workbook at this path". For
 * a plain file that is the whole story. A converted copy (.xls, .ods, .csv),
 * a restored recovery copy, a new unsaved workbook or a decrypted one is more
 * than its path: the session remembers where the original lives, that the
 * first Save must be a Save As, which temp directory it owns. Opened again by
 * path alone, the converted copy in the temp directory would come back as an
 * ordinary file — Save would write it in place and report success on a file
 * that is deleted with the tab, and the original .ods would lose its
 * protection against being exported over.
 *
 * So a re-open first looks for the session it continues and opens its twin:
 * the same backing file with the same memory of how it was opened.
 */
export interface ReopenableSession {
  readonly path: string
  readonly suggestSaveAs?: string
  readonly csvImport?: boolean
  readonly csvSourcePath?: string
  readonly importTempDir?: string
  readonly restoreTarget?: string
  readonly emptySource?: boolean
  readonly unsavedNew?: boolean
  readonly password?: string
  readonly recoveryIdentity?: unknown
  readonly recoveryOriginalPath?: string
  readonly unsavedRestore?: boolean
  readonly odsConverted?: boolean
  readonly formulasDropped?: number
  readonly odsSourcePath?: string
}

/** What the open pipeline is told again so the twin remembers the same things. */
const CARRIED = [
  'suggestSaveAs',
  'csvImport',
  'csvSourcePath',
  'restoreTarget',
  'emptySource',
  'unsavedNew',
  'password',
  'recoveryIdentity',
  'recoveryOriginalPath',
  'unsavedRestore',
  'odsConverted',
  'formulasDropped',
  'odsSourcePath',
] as const

type CarriedKey = (typeof CARRIED)[number]

/** The path the renderer knows the session by (see `openWorkbookSession`). */
function rendererPath(session: ReopenableSession): string {
  return session.restoreTarget ?? session.path
}

/** True when opening `session.path` as an ordinary file would forget something. */
function remembersItsOpen(session: ReopenableSession): boolean {
  return (
    session.suggestSaveAs !== undefined ||
    session.csvSourcePath !== undefined ||
    session.importTempDir !== undefined ||
    session.restoreTarget !== undefined ||
    session.unsavedNew === true ||
    session.password !== undefined ||
    session.unsavedRestore === true ||
    session.odsSourcePath !== undefined
  )
}

/**
 * The session a re-open of `path` continues, or null when a plain open by
 * path loses nothing. The latest matching session wins: a save replaces the
 * session, and the one opened last is the one the renderer was reading.
 */
export function sessionToContinue<S extends ReopenableSession>(
  sessions: Iterable<S>,
  path: string,
): S | null {
  let found: S | null = null
  for (const session of sessions) {
    if (rendererPath(session) === path && remembersItsOpen(session)) found = session
  }
  return found
}

/**
 * The open options that make the twin. The import directory is left out on
 * purpose: a failed open deletes the directory it was handed, and the session
 * being continued still owns it. The caller attaches it once the twin is open.
 */
export function continuedOpenOptions<S extends ReopenableSession>(
  session: S,
): Partial<Pick<S, CarriedKey>> {
  return Object.fromEntries(
    CARRIED.filter((key) => session[key] !== undefined).map((key) => [key, session[key]]),
  ) as Partial<Pick<S, CarriedKey>>
}
