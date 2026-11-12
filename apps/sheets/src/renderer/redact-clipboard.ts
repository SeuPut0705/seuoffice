/**
 * Cells hidden from AI on the clipboard.
 *
 * A paste inside one workbook is judged against the copy the editor remembers
 * and the marks as they are then (`redact-move-guard`). Another tab or window
 * of the app is another workbook with no marks for these cells: pasted there
 * they are ordinary values its AI reads. All that crosses is the clipboard, so
 * a copy whose range holds a withheld cell (a marked one, or a formula that
 * computes from one) says so in the payload, with one attribute on the table
 * of Univer's own range markup, the same carrier `data-copy-id` rides on. Every
 * paste in the app looks for it and refuses: into the grid, through the Paste
 * Special dialog, and through a paste event anywhere in the window (a cell
 * editor and the AI panel take the text of the payload, which is the value).
 *
 * The plain text and the picture of the copy are untouched. Pasting them into
 * another program is the person's own act with their own data, and nothing
 * here stands in its way.
 *
 * What the mark cannot know: a cell hidden after it was copied (the payload
 * was written before), and a paste that reads only the text flavour through
 * the Clipboard API.
 */
import { EDITOR_ACTIVATED, IContextService, IUniverInstanceService } from '@univerjs/core'
import { ISheetClipboardService } from '@univerjs/sheets-ui'

import type { RedactionIndex } from './ai/redact'
import { t } from './i18n/locale'
import {
  pasteSourceHoldsHidden,
  VALUE_FREE_PASTES,
  type InternalPasteService,
} from './redact-move-guard'
import type { UniverRuntime } from './univer-state'

export interface WithheldCopyDeps {
  /** the on-screen index: it answers "every cell" while the marks are unknown */
  readonly redactions: () => RedactionIndex
  readonly notify: (message: string) => void
}

type ClipboardWrite = (
  text: string,
  html: string,
  customData?: Record<string, string>,
) => Promise<void>

const WITHHELD_COPY_ATTRIBUTE = 'data-gx-withheld'
/// Univer's range-copy markup, up to and including its copy id (USMToHtmlService).
const RANGE_COPY_TABLE = /(<google-sheets-html-origin><table\b)([^>]*\bdata-copy-id="([^"\s]+)")/
/// The attribute on a table's own tag; text that merely mentions it is not a mark.
const MARKED_TABLE = new RegExp(`<table\\b[^>]*\\s${WITHHELD_COPY_ATTRIBUTE}="1"`)

/** Whether clipboard markup is a copy of this app that held withheld cells. */
export function isWithheldCopy(html: string): boolean {
  return MARKED_TABLE.test(html)
}

/**
 * Wrap a clipboard write so a range copy that holds withheld cells says so.
 * `holdsWithheld` is asked with the copy id of the markup; it answers true
 * for a copy it does not know, so an unplaced copy is never taken for clean.
 * `onMarked` hears the id of every copy that was marked.
 */
export function withWithheldCopyMark(
  write: ClipboardWrite,
  holdsWithheld: (copyId: string) => boolean,
  onMarked?: (copyId: string) => void,
): ClipboardWrite {
  return (text, html, customData) => {
    const copy = RANGE_COPY_TABLE.exec(html)
    if (!copy || isWithheldCopy(html) || !holdsWithheld(copy[3]!)) {
      return write(text, html, customData)
    }
    onMarked?.(copy[3]!)
    return write(
      text,
      html.replace(RANGE_COPY_TABLE, `$1 ${WITHHELD_COPY_ATTRIBUTE}="1"$2`),
      customData,
    )
  }
}

/** The slice of Univer's clipboard service a paste of markup it did not copy goes through. */
export interface ExternalPasteService {
  _pasteExternal: (html: string, pasteType: unknown) => Promise<unknown>
}

/** Refuse to paste a marked copy into the grid, whatever kind of paste it is. */
export function guardExternalPaste(
  service: ExternalPasteService,
  deps: Pick<WithheldCopyDeps, 'notify'>,
): { dispose(): void } {
  const previous = service._pasteExternal
  const guarded = async (html: string, pasteType: unknown): Promise<unknown> => {
    if (isWithheldCopy(html)) {
      deps.notify(t('redactMoveRefused'))
      return false
    }
    return previous.call(service, html, pasteType)
  }
  service._pasteExternal = guarded
  return {
    dispose() {
      if (service._pasteExternal === guarded) service._pasteExternal = previous
    },
  }
}

/** What the paste event needs to know about the editor it happens in. */
export interface WindowPasteDeps extends Pick<WithheldCopyDeps, 'notify'> {
  /** whether this editor made the copy with this id */
  readonly knowsCopy?: (copyId: string) => boolean
  /** whether a cell editor or the formula bar is being typed in */
  readonly editing?: () => boolean
}

/// The hidden input Univer keeps focused over the grid and inside its editors.
const UNIVER_INPUT = '[data-u-comp="editor"]'

/**
 * Refuse a marked copy at the paste event, before any control of the window
 * takes it: a cell editor, the formula bar and the AI panel's input take the
 * text of the payload, which is the value itself.
 *
 * One paste is let through to Univer: into the grid of the editor that made
 * the copy. That is a paste inside one workbook, judged against the marks as
 * they are now (`guardInternalPaste`), where a formula that computes from a
 * hidden cell may still be copied as a formula.
 */
export function guardWindowPaste(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  deps: WindowPasteDeps,
): { dispose(): void } {
  const onPaste = (event: Event): void => {
    const html = (event as ClipboardEvent).clipboardData?.getData('text/html') ?? ''
    if (!isWithheldCopy(html)) return
    const copyId = RANGE_COPY_TABLE.exec(html)?.[3]
    const ownGridPaste =
      copyId !== undefined &&
      deps.knowsCopy?.(copyId) === true &&
      deps.editing?.() === false &&
      event.target instanceof Element &&
      event.target.closest(UNIVER_INPUT) !== null
    if (ownGridPaste) return
    event.preventDefault()
    event.stopImmediatePropagation()
    deps.notify(t('redactMoveRefused'))
  }
  target.addEventListener('paste', onPaste, true)
  return {
    dispose() {
      target.removeEventListener('paste', onPaste, true)
    },
  }
}

/**
 * The marked copies this editor made, by the workbook they came from.
 *
 * A tab that opens another workbook keeps its editor, and with it Univer's
 * memory of the last copies: pasting one is a paste "inside the editor" that
 * never looks at the clipboard markup, and the marks it would be judged
 * against are those of the new workbook. So what a copy held is remembered
 * here, and counts once its workbook is gone.
 */
export interface WithheldCopyLedger {
  /** a copy that held withheld cells was made from this workbook unit */
  note(copyId: string, unitId: string | undefined): void
  /** the editor let go of a workbook unit */
  unitDisposed(unitId: string): void
  /** whether the copy held withheld cells of a workbook that is no longer open */
  fromClosedWorkbook(copyId: string): boolean
}

/// Univer remembers 10 copies; anything older cannot be pasted from its memory.
const LEDGER_LIMIT = 64

export function createWithheldCopyLedger(): WithheldCopyLedger {
  /// copy id -> its unit while that is open, null once it closed (or was never known)
  const copies = new Map<string, string | null>()
  return {
    note(copyId, unitId) {
      copies.delete(copyId)
      copies.set(copyId, unitId ?? null)
      if (copies.size > LEDGER_LIMIT) copies.delete(copies.keys().next().value!)
    },
    unitDisposed(unitId) {
      for (const [copyId, unit] of copies) if (unit === unitId) copies.set(copyId, null)
    },
    fromClosedWorkbook: (copyId) => copies.get(copyId) === null,
  }
}

/** Refuse to paste, from the editor's memory, a marked copy of a workbook that is no longer open. */
export function guardClosedWorkbookPaste(
  service: Pick<InternalPasteService, '_pasteInternal'>,
  ledger: WithheldCopyLedger,
  deps: Pick<WithheldCopyDeps, 'notify'>,
): { dispose(): void } {
  const previous = service._pasteInternal
  const guarded = async (copyId: string, pasteType: unknown): Promise<unknown> => {
    if (!VALUE_FREE_PASTES.has(pasteType) && ledger.fromClosedWorkbook(copyId)) {
      deps.notify(t('redactMoveRefused'))
      return false
    }
    return previous.call(service, copyId, pasteType)
  }
  service._pasteInternal = guarded
  return {
    dispose() {
      if (service._pasteInternal === guarded) service._pasteInternal = previous
    },
  }
}

interface ClipboardInterface {
  write: ClipboardWrite
}

/** Mark the copies of the running editor and guard its pastes. */
export function installWithheldCopyMark(
  runtime: UniverRuntime,
  deps: WithheldCopyDeps,
): { dispose(): void } {
  const injector = runtime.univer.__getInjector()
  const contextService = injector.get(IContextService)
  const service = injector.get(ISheetClipboardService) as unknown as ExternalPasteService &
    Pick<InternalPasteService, '_pasteInternal'> & {
      _clipboardInterfaceService: ClipboardInterface
      _copyContentCache?: {
        get(id: string):
          | {
              unitId?: string
              subUnitId?: string
              range?: { rows: readonly number[]; cols: readonly number[] }
            }
          | undefined
      }
    }
  const ledger = createWithheldCopyLedger()
  const unitDisposed = injector
    .get(IUniverInstanceService)
    .unitDisposed$.subscribe((unit) => ledger.unitDisposed(unit.getUnitId()))
  const inner = service._clipboardInterfaceService
  // Defined on a derived object, as copy-picture does: the injector hands out
  // a proxy, and assigning `write` through it would replace the shared method.
  const wrapped = Object.create(inner, {
    write: {
      value: withWithheldCopyMark(
        (text, html, customData) => inner.write(text, html, customData),
        (copyId) => {
          const copied = service._copyContentCache?.get(copyId)
          if (copied?.subUnitId === undefined || copied.range === undefined) return true
          return pasteSourceHoldsHidden(
            deps.redactions(),
            { subUnitId: copied.subUnitId, rows: copied.range.rows, cols: copied.range.cols },
            true,
          )
        },
        (copyId) => ledger.note(copyId, service._copyContentCache?.get(copyId)?.unitId),
      ),
    },
  }) as ClipboardInterface
  service._clipboardInterfaceService = wrapped
  const externalPaste = guardExternalPaste(service, deps)
  const closedWorkbookPaste = guardClosedWorkbookPaste(service, ledger, deps)
  const windowPaste = guardWindowPaste(window, {
    notify: deps.notify,
    knowsCopy: (copyId) => service._copyContentCache?.get(copyId) !== undefined,
    editing: () => contextService.getContextValue(EDITOR_ACTIVATED) === true,
  })
  return {
    dispose() {
      if (service._clipboardInterfaceService === wrapped) service._clipboardInterfaceService = inner
      externalPaste.dispose()
      closedWorkbookPaste.dispose()
      windowPaste.dispose()
      unitDisposed.unsubscribe()
    },
  }
}
