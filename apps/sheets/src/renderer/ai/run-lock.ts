/**
 * The workbook belongs to an AI run while it is in flight.
 *
 * A run edits the live workbook and is reverted at its end (turn-proposal.ts),
 * so anything else that touches the workbook in that time is lost or leaks:
 * a person's edit would be swept into the revert, and a save would write the
 * run's unaccepted edits. This lock closes both:
 *   - the person's input is stopped at the DOM while the run is in flight, and their
 *     commands are vetoed again before they run (the run's own writes pass the veto),
 *   - every save path refuses (save-scheduler.ts `guardedSave`).
 */
import { CommandType } from '@univerjs/core'

import { t } from '../i18n/locale'
import { showToast } from '../toast-bus'
import { aiRunLock, journalSuppression, type UniverRuntime } from '../univer-state'
import { VISUAL_UNDO_COMMAND_ID } from '../undo-carry'
import type { TurnProposal } from './turn-proposal'

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
  if (!aiRunLock.active || aiRunLock.agentWriting > 0 || journalSuppression.active) return false
  // the formula engine's results are derived from what the run wrote; co-editing's mutations
  // are other people's confirmed edits, which this page must hold to stay equal to theirs
  const options = event.options as { fromFormula?: boolean; fromCollab?: boolean } | undefined
  if (options?.fromFormula || options?.fromCollab) return false
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

/** Events that start an edit, a selection change or a command; wheel and mouse moves stay free. */
const BLOCKED_DOM_EVENTS = [
  'keydown',
  'keypress',
  'beforeinput',
  'paste',
  'cut',
  'drop',
  'dragover',
  'dragstart',
  'pointerdown',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'touchstart',
] as const

/** The refusal is explained once per burst of blocked input, not on every click. */
const NOTICE_GAP_MS = 3000
let lastNoticeAt = 0

/** The AI panel's own root: the person keeps typing, stopping and undoing there. */
const AI_PANEL_SELECTOR = '.copilot'

function insideAiPanel(target: EventTarget | null): boolean {
  const el =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return !!el?.closest(AI_PANEL_SELECTOR)
}

/** ⌘S / Ctrl+S still reach the save command, whose refusal says why nothing was written. */
function isSaveShortcut(e: Event): boolean {
  return (
    e instanceof KeyboardEvent &&
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    e.key.toLowerCase() === 's'
  )
}

/**
 * The person's input is stopped at the window, before the grid or any control sees it, so it
 * cannot land while the run's own async writes are in progress (the command veto cannot tell
 * those apart: it lets the run's commands through). Added when this module loads, so it runs
 * before any component's own window listener.
 */
function blockPersonInput(e: Event): void {
  if (!aiRunLock.active || insideAiPanel(e.target) || isSaveShortcut(e)) return
  e.stopImmediatePropagation()
  e.preventDefault()
  const now = Date.now()
  if (now - lastNoticeAt < NOTICE_GAP_MS) return
  lastNoticeAt = now
  showToast(t('appAiRunLocked'), 'error')
}

if (typeof window !== 'undefined') {
  // not passive: touchstart is passive by default on window, which would ignore preventDefault
  for (const type of BLOCKED_DOM_EVENTS) {
    window.addEventListener(type, blockPersonInput, { capture: true, passive: false })
  }
}

/** One claim on the workbook; only the claimant's own release ends it. */
export type AiRunLockHold = symbol

const holds = new Set<AiRunLockHold>()

/**
 * Takes the workbook for a run (or an Accept); from here on the person's edits and every save
 * are refused. The workbook stays taken until every claim is released, so a late release of an
 * abandoned run cannot hand the workbook to the person under a newer run.
 */
export function lockForAiRun(): AiRunLockHold {
  const hold = Symbol('ai-run-hold')
  holds.add(hold)
  aiRunLock.active = true
  lastNoticeAt = 0
  return hold
}

/** Gives the workbook back once this claim's edits are out of it (or could not be taken out). */
export function unlockAfterAiRun(hold: AiRunLockHold): void {
  holds.delete(hold)
  aiRunLock.active = holds.size > 0
}

/** Tells the save path whether a held proposal awaits the person's Accept or Reject. */
export function setProposalPending(proposal: TurnProposal): void {
  aiRunLock.proposalPending = proposal.kind === 'pending'
}

/**
 * Raises the "the run is writing" flag for the writes the run itself makes (its plan applies,
 * its revert, an Accept); returns the release. Scopes nest: the flag stays up until the last
 * one is released, and a release counts once.
 */
export function beginAgentWrite(): () => void {
  aiRunLock.agentWriting += 1
  let released = false
  return () => {
    if (released) return
    released = true
    aiRunLock.agentWriting -= 1
  }
}

/** Why no file may be opened over the workbook right now, or null when one may. */
export function aiRunOpenRefusal(): string | null {
  return aiRunLock.active ? t('appAiRunLocked') : null
}

/**
 * The ways a save can be asked for; the two that write the file reopen it afterwards. `ods`
 * gathers the pending edits for an ODS export and writes nothing.
 */
export type SaveRefusalMode = 'save' | 'save-as' | 'recovery' | 'template' | 'ods'

/**
 * Why a save must not write the workbook right now, or null when it may. A copy (recovery,
 * template, export) leaves the open workbook alone; a save reopens the file and with it drops
 * the held proposal, so it waits for the person's Accept or Reject.
 */
export function aiRunSaveRefusal(mode?: SaveRefusalMode): string | null {
  if (aiRunLock.active) return t('appSaveBlockedAiRun')
  if (aiRunLock.stranded) return t('appAiRunStranded')
  if (aiRunLock.proposalPending && (mode === 'save' || mode === 'save-as')) {
    return t('appSaveBlockedProposal')
  }
  return null
}
