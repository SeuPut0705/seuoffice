/**
 * One workbook save at a time. Two saves in flight race in the main process:
 * the first finisher tears the workbook session down while the second is
 * still reading, and the survivor fails with "Unknown workbook session."
 * although the file was written. Manual saves queue behind the running one;
 * the periodic ticks below skip and retry on their next wake-up.
 */
export interface SaveGate {
  readonly busy: boolean
  run<T>(task: () => Promise<T>): Promise<T>
}

export function createSaveGate(): SaveGate {
  let inFlight: Promise<unknown> | null = null
  return {
    get busy() {
      return inFlight !== null
    },
    run(task) {
      const next = (inFlight ?? Promise.resolve()).catch(() => undefined).then(task)
      inFlight = next
      next
        .finally(() => {
          if (inFlight === next) inFlight = null
        })
        .catch(() => undefined)
      return next
    },
  }
}

/**
 * Every save, Save As, autosave, recovery copy and template export enters the
 * gate through here. `refusal` says why the workbook must not be written right
 * now (an AI run holds edits no one accepted) or null. It is checked again when
 * the save's turn comes, because a save queued behind another can start after
 * a run has begun; a save already past that check finished before the run's
 * first edit (a run waits for the gate to drain before it starts).
 */
export function guardedSave<T>(
  gate: SaveGate,
  refusal: () => T | null,
  write: () => Promise<T>,
): Promise<T> {
  const early = refusal()
  if (early !== null) return Promise.resolve(early)
  return gate.run(async () => refusal() ?? (await write()))
}

export interface SaveTickState {
  /** a save of either kind is currently running */
  saveInFlight: boolean
  /** no workbook open */
  hasWorkbook: boolean
  /** nothing unsaved since the last flush */
  journalEmpty: boolean
  /**
   * The reader's marks differ from what the file was opened with.
   *
   * A mark is not in the journal, so a workbook whose only edit is a
   * newly withheld cell would otherwise look clean to both ticks: no
   * AutoSave, no crash-recovery copy, and the mark lost when the tab
   * closes — with the reader having seen it drawn on the grid.
   */
  redactionsPendingSave: boolean
  /** the in-cell editor is open (its pending text is not in the journal yet; a save reloads the workbook and would wipe the edit) */
  editingCell: boolean
  /** AutoSave only: converted .xls import whose first save must open a Save As dialog (a new unsaved workbook saves its backing file quietly instead) */
  needsSaveAsNotUnsavedNew: boolean
  /** AutoSave only: CSV sessions, which AutoSave would silently flatten (their recovery copy is an untitled one) */
  isCsv: boolean
  kind: 'save' | 'recovery'
  /** recovery-only: this workbook writes no recovery copy (password, oversized sheets) */
  automaticRecoveryDisabled: boolean
}

export function shouldRunSaveTick(s: SaveTickState): boolean {
  if (s.saveInFlight || !s.hasWorkbook) return false
  if (s.journalEmpty && !s.redactionsPendingSave) return false
  if (s.editingCell) return false
  // a CSV or converted workbook keeps its copy (an untitled one) but is never auto-saved
  if (s.kind === 'save') return !s.needsSaveAsNotUnsavedNew && !s.isCsv
  return !s.automaticRecoveryDisabled
}

/**
 * What the end of an AI run that changed the workbook does with the file. A
 * CSV session is left with its edits pending, for the reason the periodic
 * AutoSave never saves one (`shouldRunSaveTick`): the save writes the active
 * sheet's values over the .csv, flattening the workbook, and the file cannot
 * keep the marks of cells hidden from AI, so their values (and values the run
 * computed from them) would land in a plain file the AI can read back. The
 * person's own Save still asks and writes as before.
 */
export function aiRunAutoSave(s: { autoSave: boolean; isCsv: boolean }): 'save' | 'leave-pending' {
  return s.autoSave && !s.isCsv ? 'save' : 'leave-pending'
}
