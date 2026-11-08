/**
 * The memo panel's own column beside the document, and the top bar's button for it.
 *
 * The memo list used to share the AI dock, so opening it hid the AI panel. Like the
 * PDF editor's notes, it now has a column of its own between the AI dock and the
 * document: the two can be out at once, and the memo list stays next to the page
 * it points into. With the assistant on the right the column is the window's left
 * edge, still beside the document.
 *
 * The column is hidden, not unmounted, while closed: the memo editor's locks and the
 * list live in MemoPanel and must survive (MemoPanel.tsx). Its edge toward the
 * document resizes it; the width and the open state are remembered.
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useI18n } from './i18n/locale'
import { MemoPanel, type MemoPanelProps } from './MemoPanel'

/** Whether the memo column is out, remembered across launches. */
export const MEMO_OPEN_KEY = 'hwpapp.memoPanel'
/** The shared dock's old mode ('ai' | 'memo'): read once, so a memo panel left out stays out. */
export const LEGACY_DOCK_MODE_KEY = 'hwpapp.sidePanel'
/** The column's width the user dragged it to. */
export const MEMO_WIDTH_KEY = 'hwpapp.memoPanelWidth'
export const MEMO_WIDTH_DEFAULT = 300
export const MEMO_WIDTH_MIN = 240
/** The widest the column gets, also never more than this share of the window. */
export const MEMO_WIDTH_MAX = 480
const MEMO_WIDTH_SHARE = 0.4

type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The width kept within its bounds for a window this wide. */
export function clampMemoWidth(width: number, windowWidth = window.innerWidth): number {
  const max = Math.max(
    MEMO_WIDTH_MIN,
    Math.min(MEMO_WIDTH_MAX, Math.round(windowWidth * MEMO_WIDTH_SHARE)),
  )
  return Math.min(Math.max(width, MEMO_WIDTH_MIN), max)
}

/** The width the user chose last time, or the default. */
export function loadMemoWidth(storage: FlagStorage = localStorage): number {
  try {
    const saved = Number(storage.getItem(MEMO_WIDTH_KEY))
    return Number.isFinite(saved) && saved > 0
      ? Math.min(Math.max(saved, MEMO_WIDTH_MIN), MEMO_WIDTH_MAX)
      : MEMO_WIDTH_DEFAULT
  } catch {
    return MEMO_WIDTH_DEFAULT
  }
}

/** Whether the column starts out; a memo panel left out in the old shared dock stays out. */
export function memoPanelInitiallyOpen(storage: FlagStorage = localStorage): boolean {
  try {
    const saved = storage.getItem(MEMO_OPEN_KEY)
    if (saved !== null) return saved === '1'
    return storage.getItem(LEGACY_DOCK_MODE_KEY) === 'memo'
  } catch {
    return false
  }
}

/** Remember the open state; the old dock mode has been read by now and goes. */
export function rememberMemoPanelOpen(open: boolean, storage: FlagStorage = localStorage): void {
  try {
    storage.setItem(MEMO_OPEN_KEY, open ? '1' : '0')
    storage.removeItem(LEGACY_DOCK_MODE_KEY)
  } catch {
    // storage refused: the column still works for this session
  }
}

/** The top bar's button: the editor has no ribbon, so this is the memo column's way in. */
export function MemoToggle({ open, onToggle }: { open: boolean; onToggle(): void }): ReactElement {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className={`memo-toggle${open ? ' on' : ''}`}
      aria-pressed={open}
      onClick={onToggle}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1z" />
        <path d="M5.5 5.75h5M5.5 8h3.5" strokeLinecap="round" />
      </svg>
      <span>{t('memoOpen')}</span>
    </button>
  )
}

/** The memo panel in its own resizable column; `open` false hides the column but keeps the panel. */
export function MemoSide(props: MemoPanelProps): ReactElement {
  const { open } = props
  const [width, setWidth] = useState(() => clampMemoWidth(loadMemoWidth()))
  /** the width the user chose: a narrower window clamps what is shown, not this */
  const preferredRef = useRef(width)
  const [resizing, setResizing] = useState(false)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  // a narrower window shrinks the column; growing it back restores the chosen width
  useEffect(() => {
    const onResize = (): void => setWidth(clampMemoWidth(preferredRef.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => () => resizeCleanupRef.current?.(), [])

  /** Drag the edge toward the document; the pointer is captured, so the editor's frame cannot take it. */
  const startResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const resizer = e.currentTarget
    const startX = e.clientX
    const startW = width
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent): void => {
      const w = clampMemoWidth(startW + ev.clientX - startX)
      preferredRef.current = w
      setWidth(w)
    }
    let done = false
    const cleanup = (): void => {
      if (done) return
      done = true
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizer.removeEventListener('lostpointercapture', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      try {
        localStorage.setItem(MEMO_WIDTH_KEY, String(Math.round(preferredRef.current)))
      } catch {
        // storage refused: the width holds for this session
      }
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    resizer.addEventListener('lostpointercapture', cleanup)
    resizer.setPointerCapture(e.pointerId)
  }

  return (
    <div
      className={`memo-side${open ? '' : ' collapsed'}${resizing ? ' memo-side-resizing' : ''}`}
      style={{ width }}
    >
      <MemoPanel {...props} />
      {open && <div className="memo-side-resizer" onPointerDown={startResize} />}
    </div>
  )
}
