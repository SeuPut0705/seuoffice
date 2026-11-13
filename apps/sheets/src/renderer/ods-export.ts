/// ODS export of the whole workbook. The main process writes the workbook as
/// it stands — pending edits included — into a private temp copy, converts
/// that, warns once about the features ODS cannot hold, and only then writes
/// the target. The open workbook keeps its path, its pending edits and its
/// unsaved state: this is a copy, like Export CSV/PDF.

import type { WorkbookSaveRequest } from '../shared/desktop-api'
import { t } from './i18n/locale'
import { showToast } from './toast-bus'
import type { LazyWorkbookState } from './univer-state'

/** The App refs/state the ODS export needs; built fresh per call. */
export interface OdsExportContext {
  lazyWorkbookRef: { readonly current: LazyWorkbookState | null }
  setMessage: (message: string) => void
  /// The pending edits as a save request, assembled the way a save assembles
  /// them but sent nowhere: the export hands it to the main process, which
  /// writes it into its own copy. Null when the edits could not be gathered.
  pendingEdits: () => Promise<WorkbookSaveRequest | null>
  /// Routes into the regular Save As flow when the person answers the refusal
  /// of a workbook that hides cells from the AI with "Save as .xlsx".
  requestSaveAs: () => void
}

/// Runs a save and, when its Save As ended on the ODS format, the export
/// after it. The export gathers the pending edits through the same save gate
/// the save holds, so it may only start once the save has returned: started
/// from inside it, the two wait on each other and every later save of the
/// tab queues behind them.
export async function saveThenExportOds<T extends { ok: boolean; odsSaveAsPath?: string }>(
  save: () => Promise<T>,
  exportTo: (targetPath: string) => Promise<unknown>,
): Promise<T | { ok: false }> {
  const outcome = await save()
  if (outcome.odsSaveAsPath === undefined) return outcome
  await exportTo(outcome.odsSaveAsPath)
  return { ok: false }
}

/// True when a file was written. `targetPath` is the Save As pick the main
/// process authorized for this one export.
export async function handleExportOds(
  ctx: OdsExportContext,
  targetPath?: string,
): Promise<boolean> {
  if (!ctx.lazyWorkbookRef.current) return false
  try {
    // The export must not silently omit edits made since the last save, and
    // it must not save the workbook to get them either.
    const workbook = await ctx.pendingEdits()
    const state = ctx.lazyWorkbookRef.current
    if (!workbook || !state || workbook.sessionId !== state.file.sessionId) {
      ctx.setMessage(t('appOdsExportFailed'))
      return false
    }
    const result = await window.desktopApi.exportOds({
      sessionId: state.file.sessionId,
      ...(targetPath === undefined ? {} : { targetPath }),
      workbook,
    })
    if (result.canceled) {
      if (result.saveAsXlsxInstead) {
        ctx.requestSaveAs()
        return false
      }
      // The main process already showed the dialog for a refusal or a failed
      // write; the status line just records that nothing was exported.
      ctx.setMessage(
        result.reason === 'failed' || result.reason === 'unreadable'
          ? t('appOdsExportFailed')
          : t('appOdsExportCanceled'),
      )
      return false
    }
    const exported = t('appOdsExported', { path: result.path })
    ctx.setMessage(exported)
    showToast(exported)
    return true
  } catch (error: unknown) {
    const failed = error instanceof Error ? error.message : t('appOdsExportFailed')
    ctx.setMessage(failed)
    showToast(failed, 'error')
    return false
  }
}
