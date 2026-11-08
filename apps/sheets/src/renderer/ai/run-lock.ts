/**
 * The workbook belongs to an AI run while it is in flight.
 *
 * A run edits the live workbook and is reverted at its end (turn-proposal.ts),
 * so anything else that touches the workbook in that time is lost or leaks:
 * a person's edit would be swept into the revert, and a save would write the
 * run's unaccepted edits. This lock closes both:
 *   - the person's edits are vetoed before they run (the run's own writes pass),
 *   - every save path refuses (save-scheduler.ts `guardedSave`).
 */
import { CommandType } from '@univerjs/core'

import { t } from '../i18n/locale'
import { aiRunLock, journalSuppression, type UniverRuntime } from '../univer-state'
import { VISUAL_UNDO_COMMAND_ID } from '../undo-carry'

const OPEN_CELL_EDITOR = 'sheet.operation.set-cell-edit-visible'
/** the formula engine's own bookkeeping: derived from what the run wrote, never a person's edit */
const FORMULA_ENGINE_MUTATION = /^formula\./
/** a mutation that names no unit still changes the workbook when it is a sheet one */
const SHEET_MUTATION_ID = /^sheets?[.-]/

/** The slice of a Univer BeforeCommandExecute event the veto reads. */
export interface CommandEventLike {
  readonly id: string
  readonly type?: number
  readonly params?: unknown
  readonly options?: unknown
}

/**
 * Whether a command is a person's edit to refuse while a run is in flight.
 * Mutations are the real writers (every edit, paste, undo and redo ends in one),
 * so they are vetoed per unit; opening the cell editor is vetoed up front so a
 * person cannot type into a cell that would then refuse the commit.
 */
export function personEditVetoed(event: CommandEventLike, workbookId: string | undefined): boolean {
  if (!aiRunLock.active || aiRunLock.agentWriting || journalSuppression.active) return false
  // the formula engine's results are derived from what the run wrote
  if ((event.options as { fromFormula?: boolean } | undefined)?.fromFormula) return false
  const params = (event.params ?? {}) as { unitId?: unknown; visible?: unknown }
  if (event.id === OPEN_CELL_EDITOR) return params.visible === true
  if (event.type !== CommandType.MUTATION || FORMULA_ENGINE_MUTATION.test(event.id)) return false
  if (typeof params.unitId === 'string') return params.unitId === workbookId
  return event.id === VISUAL_UNDO_COMMAND_ID || SHEET_MUTATION_ID.test(event.id)
}

/** Vetoes the person's edits to the active workbook while a run is in flight. */
export function installAiRunLockGuard(
  runtime: UniverRuntime,
  notify: (message: string) => void,
): { dispose(): void } {
  return runtime.univerAPI.addEvent(runtime.univerAPI.Event.BeforeCommandExecute, (event) => {
    if (!personEditVetoed(event, runtime.univerAPI.getActiveWorkbook()?.getId())) return
    event.cancel = true
    notify(t('appAiRunLocked'))
  })
}

/** Takes the workbook for a run; from here on the person's edits and every save are refused. */
export function lockForAiRun(): void {
  aiRunLock.active = true
}

/** Gives the workbook back once the run's edits are out of it (or could not be taken out). */
export function unlockAfterAiRun(): void {
  aiRunLock.active = false
}

/**
 * Raises the "the run is writing" flag for the writes the run itself makes
 * (its plan applies and its revert); returns the release.
 */
export function beginAgentWrite(): () => void {
  aiRunLock.agentWriting = true
  return () => {
    aiRunLock.agentWriting = false
  }
}

/** Why a save must not write the workbook right now, or null when it may. */
export function aiRunSaveRefusal(): string | null {
  if (aiRunLock.active) return t('appSaveBlockedAiRun')
  if (aiRunLock.stranded) return t('appAiRunStranded')
  return null
}
