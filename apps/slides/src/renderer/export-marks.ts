/**
 * A copy of the deck as PDF or pictures records no "hidden from the AI" mark:
 * what such a file shows is the content itself, and whatever reads it later
 * reads it. So a copy that would carry hidden content asks the person first
 * (Save as .pptx, which keeps the marks / export without them / cancel), and
 * a copy nobody can be asked about is refused.
 */
import type { WithheldExportFormat } from '../shared/ipc'
import { holdsRedactionMark } from '../shared/redaction-marks'
import type { ActionCtx } from './action-context'
import { t } from './i18n/locale'

/**
 * True when the copy may be written: nothing in `exported` is hidden from the
 * AI, or the person chose to export without the marks. False when they
 * cancelled or chose .pptx (Save As opens; nothing is written here). `silent`
 * (the headless CLI) has no one to ask, so hidden content throws.
 */
export async function confirmExportWithoutMarks(
  ctx: Pick<ActionCtx, 'requestSaveAs'>,
  exported: unknown,
  format: WithheldExportFormat,
  silent = false,
): Promise<boolean> {
  if (!holdsRedactionMark(exported)) return true
  if (silent) throw new Error(t('appExportRefusedHidden'))
  const choice = await window.slidesApi.askWithheldExport(format)
  if (choice === 'export') return true
  if (choice === 'pptx') ctx.requestSaveAs()
  return false
}
