/**
 * The deck is read-only for the person while an AI request is editing it (AI edit review).
 *
 * The AI's own tool calls reach the main process through the same `slidesApi` calls the
 * editor's controls use, so the person's input is stopped at the DOM instead: while locked,
 * pointer, keyboard, clipboard and drag-drop events aimed outside the AI panel never reach
 * the editor's handlers. The listeners sit on `window` in the capture phase and are added
 * when this module loads, so they run before any component's own window listener.
 *
 * The lock follows the main process: it is on from the moment an AI run is begun until the
 * run is held (`aiRunActive` on the history notice), in every window attached to the deck.
 */
import { showToast } from './components/toast-bus'
import { t } from './i18n/locale'

/** Events that start an edit, a selection change or a command; wheel and mouse moves stay free */
const BLOCKED_EVENTS = [
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

/** The refusal is explained once per burst of blocked input, not on every click */
const NOTICE_GAP_MS = 3000

let locked = false
let lastNoticeAt = 0

export function setAiRunLocked(next: boolean): void {
  locked = next
  lastNoticeAt = 0
}

export function isAiRunLocked(): boolean {
  return locked
}

/** ⌘S / Ctrl+S still reach the save command, whose refusal says why nothing was written */
function isSaveShortcut(e: Event): boolean {
  return (
    e instanceof KeyboardEvent &&
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    e.key.toLowerCase() === 's'
  )
}

function insideAiPanel(target: EventTarget | null): boolean {
  const el =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return !!el?.closest('.ai-dock')
}

function block(e: Event): void {
  if (!locked || insideAiPanel(e.target) || isSaveShortcut(e)) return
  e.stopImmediatePropagation()
  e.preventDefault()
  const now = Date.now()
  if (now - lastNoticeAt < NOTICE_GAP_MS) return
  lastNoticeAt = now
  showToast(t('aiRunLocked'), 'error')
}

if (typeof window !== 'undefined') {
  // not passive: touchstart is passive by default on window, which would ignore preventDefault
  for (const type of BLOCKED_EVENTS) {
    window.addEventListener(type, block, { capture: true, passive: false })
  }
}
