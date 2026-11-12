/**
 * Turning what the main process read out of `xl/gxRedactions.json` into the
 * index the read tools ask about a cell (see `./redact`).
 *
 * ## The one decision here
 *
 * A part that exists but cannot be read must not become an empty index. An
 * empty index answers "no cell is withheld" to every read the model makes, so a
 * damaged part read as "nothing hidden" hands over exactly the values the
 * reader chose to hide — a failure that is silent, total, and in the worst
 * direction. So:
 *
 * - `absent` (the common case) and `ok` both resolve to an index built from the
 *   part, and the renderer's message bar stays quiet.
 * - `unreadable` resolves to [`WITHHELD_UNKNOWN`], an index that withholds
 *   every cell with a neutral label, plus the reason for the user. The model
 *   then sees placeholders instead of data, which is a recoverable complaint;
 *   seeing the data would not be.
 *
 * The reason is kept out of the label on purpose: a label reaches the model, so
 * it must not report the workbook's internals back to it.
 */
import {
  buildRedactionIndex,
  NO_REDACTIONS,
  type RedactionIndex,
  type SheetRefLike,
  type CellMark,
} from './redact'
import type { WorkbookRedactionsResult } from '../../shared/desktop-api'
import type { TFunc } from '../i18n/locale'

/** The label shown for a cell whose mark could not be read. */
export const UNKNOWN_REDACTION_LABEL = 'private'

/**
 * Withhold everything, because nothing is known.
 *
 * `isEmpty` is false on purpose: it is what the readers and the write guard ask
 * first, and a truthful "this workbook withholds something" is what keeps them
 * from treating the session as unprotected.
 */
/** one mark over the whole grid: the callers that count or intersect marks withhold everything too */
const WHOLE_SHEET_MARK: CellMark = {
  startRow: 0,
  endRow: Number.MAX_SAFE_INTEGER,
  startColumn: 0,
  endColumn: Number.MAX_SAFE_INTEGER,
  label: UNKNOWN_REDACTION_LABEL,
}

export const WITHHELD_UNKNOWN: RedactionIndex = {
  isEmpty: false,
  sheetIds: [],
  labelAt: () => UNKNOWN_REDACTION_LABEL,
  labelsFor: () => [UNKNOWN_REDACTION_LABEL],
  marksFor: () => [WHOLE_SHEET_MARK],
}

/**
 * What is known about the open workbook's marks.
 *
 * Three states, because "no index yet" is not "nothing is withheld": every save
 * reopens the workbook under a new session, and until that session's read
 * lands the marks are as unknown as those of a part that cannot be read. Only
 * `loaded` carries an index the readers may trust; the other two are answered
 * with [`WITHHELD_UNKNOWN`] (see [`redactionIndexOf`]).
 */
export type RedactionLoad =
  /** a workbook is open and its part has not been read yet */
  | { readonly status: 'not-loaded' }
  | { readonly status: 'loaded'; readonly index: RedactionIndex }
  /** the part exists and could not be read, or the read itself failed */
  | { readonly status: 'unreadable' }

export const REDACTIONS_NOT_LOADED: RedactionLoad = { status: 'not-loaded' }
export const REDACTIONS_UNREADABLE: RedactionLoad = { status: 'unreadable' }
/** Nothing is withheld: a part that is absent, or a workbook with no file behind it. */
export const REDACTIONS_NONE: RedactionLoad = { status: 'loaded', index: NO_REDACTIONS }

export function loadedRedactions(index: RedactionIndex): RedactionLoad {
  return { status: 'loaded', index }
}

/**
 * The index every reader and guard asks. Anything but a loaded index withholds
 * every cell, so a state nobody thought of fails in the direction that hides.
 */
export function redactionIndexOf(load: RedactionLoad): RedactionIndex {
  return load.status === 'loaded' ? load.index : WITHHELD_UNKNOWN
}

/** What the open path installs for a session. */
export interface RedactionSession {
  readonly load: RedactionLoad
  /** the index `load` answers with */
  readonly index: RedactionIndex
  /** the reason to show the user, or null when the part was read or absent */
  readonly error: string | null
  /**
   * Something the user should know but that does not withhold anything, or
   * null when nothing happened. The one case today: the marks came from the
   * defined-name mirror because the package part is gone, which means the file
   * has been through a program that rebuilds the package. Saving here puts the
   * part back, so the reader is told rather than left guessing why.
   */
  readonly notice: string | null
}

function sessionOf(
  load: RedactionLoad,
  error: string | null,
  notice: string | null,
): RedactionSession {
  return { load, index: redactionIndexOf(load), error, notice }
}

/**
 * Resolve one open's redaction state into the index the readers share.
 *
 * The whole batch is checked before it is used, so a refusal never leaves a
 * half-applied index behind: a session gets either its real marks or nothing at
 * all to reveal.
 *
 * `t` is the app's translate function: the notice is product text, so it cannot
 * be built here from an English literal.
 */
export function redactionSessionFor(
  result: WorkbookRedactionsResult,
  sheets: readonly SheetRefLike[],
  t: TFunc,
): RedactionSession {
  if (result.status === 'unreadable') return sessionOf(REDACTIONS_UNREADABLE, result.error, null)
  if (result.status === 'absent') return sessionOf(REDACTIONS_NONE, null, null)
  return sessionOf(
    loadedRedactions(buildRedactionIndex(result.states, sheets)),
    null,
    result.source === 'mirror' ? t('redactRecoveredFromNames') : null,
  )
}

/**
 * Follow one open's read of the redaction part, from "not known yet" to its
 * answer.
 *
 * The state is `not-loaded` from this call until the read settles, so a read
 * that arrives in between (an MCP `read_sheet` straight after `save_sheet`
 * outruns the IPC round trip) gets placeholders rather than the values the
 * marks were hiding. A read that rejects is the same answer as a part that
 * cannot be read.
 */
export function followRedactionRead(
  loadRef: { current: RedactionLoad },
  read: Promise<WorkbookRedactionsResult>,
  hooks: {
    /** false once another open replaced this one: its answer must not install */
    readonly isCurrent: () => boolean
    readonly sheets: () => readonly SheetRefLike[]
    readonly t: TFunc
    /** the state is installed; the caller keeps the marks and tells the user */
    readonly onSettled: (result: WorkbookRedactionsResult, session: RedactionSession) => void
  },
): Promise<void> {
  loadRef.current = REDACTIONS_NOT_LOADED
  const settle = (result: WorkbookRedactionsResult): void => {
    if (!hooks.isCurrent()) return
    const session = redactionSessionFor(
      result,
      result.status === 'ok' ? hooks.sheets() : [],
      hooks.t,
    )
    loadRef.current = session.load
    hooks.onSettled(result, session)
  }
  return read.then(settle).catch((error: unknown) => {
    settle({ status: 'unreadable', error: error instanceof Error ? error.message : String(error) })
  })
}
