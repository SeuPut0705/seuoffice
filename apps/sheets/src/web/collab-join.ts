/**
 * The Sheets page joining the host's co-editing session: the format it
 * declares, and the adapter it builds once the renderer shows the workbook.
 */
import { joinPageCollab, webLanguage, type PageCollab } from '@seuoffice/web-platform'
import { handleSave } from '../renderer/save-actions'
import { setEditRefusalRule } from '../renderer/sheet-protection'
import { showToast } from '../renderer/toast-bus'
import type { LazyWorkbookState, UniverRuntime } from '../renderer/univer-state'
import { type SheetOp, sheetsCollabAdapter } from './collab-adapter'
import { journalMark } from './collab-journal'
import { refusalIsSilent, sharedWhileCoEditing } from './collab-refusals'

/** What the renderer hands over (`window.seuCollab.attach`) once the opened workbook is on screen */
export interface SheetsRendererHandles {
  readonly runtime: UniverRuntime
  readonly state: LazyWorkbookState
}

/** Bump `schema` when the op format changes: pages of two schemas must not share a session */
const FORMAT = { name: 'xlsx', schema: 1 }

const noop = (): void => {}

const refusalText = (): string =>
  webLanguage() === 'ko'
    ? '함께 편집하는 동안에는 이 편집을 할 수 없습니다.'
    : 'This edit is not available while several people edit the workbook.'

/** The app's own toast, as for its other refused actions; at most one per second */
let lastRefusal = 0
function refused(id: string): void {
  console.warn(`[co-editing] refused an edit it cannot share: ${id}`)
  if (Date.now() - lastRefusal < 1_000) return
  lastRefusal = Date.now()
  showToast(refusalText(), 'error')
}

export function joinSheetsCollab(
  fileName: string,
  bytes: Uint8Array,
): Promise<PageCollab<SheetsRendererHandles> | null> {
  return joinPageCollab<SheetsRendererHandles, SheetOp>({
    format: FORMAT,
    fileName,
    bytes,
    adapter({ runtime, state }) {
      // A streamed workbook holds only the cells on screen, so it cannot replay or save the log;
      // throwing here makes the page report collab_unavailable and the host reopen under its lock.
      if (!state.formulaMode || !state.flags.preloadComplete) {
        throw new Error('this workbook is too large to co-edit; it opens streamed from the file')
      }
      const unitId = runtime.univerAPI.getActiveWorkbook()?.getId()
      if (!unitId) throw new Error('no workbook on screen')
      const refs = { univerRef: { current: runtime }, lazyWorkbookRef: { current: state } }
      const adapter = sheetsCollabAdapter(
        {
          univer: runtime.univer,
          unitId,
          async produceFile() {
            // 'template' builds the same save request but only writes a copy: no reopen, no re-ided sheets
            const outcome = await handleSave(
              { ...refs, setMessage: noop, openLazyWorkbook: noop, stashViewRestore: noop },
              'template',
              true,
            )
            if (!outcome.ok || !outcome.bytes) throw new Error('the workbook could not be written')
            return { fileName, bytes: outcome.bytes }
          },
          journalMark: (mutation) => journalMark(state.editJournal, mutation),
        },
        { onBlocked: refused },
      )
      // From here on the renderer refuses what would stay on this page (collab-refusals.ts)
      setEditRefusalRule((kind) => {
        if (sharedWhileCoEditing(kind)) return null
        if (!refusalIsSilent(kind)) refused(kind)
        return refusalText()
      })
      return adapter
    },
  })
}
