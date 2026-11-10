/**
 * The Sheets page joining the host's co-editing session: the format it
 * declares, and the adapter it builds once the renderer shows the workbook.
 */
import { joinPageCollab, webLanguage, type PageCollab } from '@seuoffice/web-platform'
import { handleSave } from '../renderer/save-actions'
import { setEditRefusalRule } from '../renderer/sheet-protection'
import { showToast } from '../renderer/toast-bus'
import {
  type LazyWorkbookState,
  modelResidency,
  type UniverRuntime,
} from '../renderer/univer-state'
import { type BlockReason, type SheetOp, sheetsCollabAdapter } from './collab-adapter'
import { journalMark, structuralOpsRefusal } from './collab-journal'
import { refusalIsSilent, sharedWhileCoEditing } from './collab-refusals'

/** What the renderer hands over (`window.seuCollab.attach`) once the opened workbook is on screen */
export interface SheetsRendererHandles {
  readonly runtime: UniverRuntime
  readonly state: LazyWorkbookState
}

/**
 * Bump `schema` when the op format or what the fingerprint covers changes:
 * pages of two schemas must not share a session.
 */
const FORMAT = { name: 'xlsx', schema: 2 }

const noop = (): void => {}

const REFUSALS: Record<BlockReason, { ko: string; en: string }> = {
  unshared: {
    ko: '함께 편집하는 동안에는 이 편집을 할 수 없습니다.',
    en: 'This edit is not available while several people edit the workbook.',
  },
  'too-large': {
    ko: '한 번에 함께 반영하기에는 너무 큰 편집이라 되돌렸습니다. 범위를 나누어 다시 해 주세요.',
    en: 'This edit was too large to share in one step and was taken back. Do it in smaller parts.',
  },
  // the session's journal starts empty again only with a new session: after a save, once
  // nobody has had the workbook open for the server's idle time (packages/collab README)
  limit: {
    ko: '이 편집 세션에서는 행·열·병합·크기 변경을 더 받을 수 없습니다. 저장한 뒤 모두 문서를 닫고, 잠시 뒤에 다시 열어 주세요.',
    en: 'This session cannot take more row, column, merge or size changes. Save, have everyone close the workbook, and open it again a little later.',
  },
}

const refusalText = (reason: BlockReason = 'unshared'): string =>
  REFUSALS[reason][webLanguage() === 'ko' ? 'ko' : 'en']

/** The app's own toast, as for its other refused actions; at most one per second */
let lastRefusal = 0
function refused(id: string, reason: BlockReason = 'unshared'): void {
  console.warn(`[co-editing] refused an edit (${reason}): ${id}`)
  if (Date.now() - lastRefusal < 1_000) return
  lastRefusal = Date.now()
  showToast(refusalText(reason), 'error')
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
      // Every cell is installed and must stay so: the others' edits apply to this model and its
      // fingerprint is compared with theirs. The windowed loader would evict what scrolls away.
      modelResidency.whole = true
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
          refusalOf: (mutation) => structuralOpsRefusal(state.editJournal, mutation),
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
