import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { placeFolderMenu } from '../folder-menu-position'

/**
 * A dialog above the settings window. Escape closes this dialog only: the
 * window-level capture listener runs before the settings modal's own Escape
 * handler and stops it, so the settings stay open behind.
 */
export function SkillDialog({
  label,
  onCancel,
  children,
  footer,
}: {
  label: string
  onCancel: () => void
  children: ReactNode
  footer: ReactNode
}) {
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      cancelRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    boxRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      className="skl-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={boxRef}
        className="skl-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <h3 className="skl-dialog-title">{label}</h3>
        <div className="skl-dialog-body">{children}</div>
        <div className="skl-dialog-footer">{footer}</div>
      </div>
    </div>
  )
}

export interface MenuItem {
  key: string
  label: string
  onPick: () => void
}

/** the gap between a menu button and its menu */
const MENU_GAP = 4

/**
 * A button with a small menu under it; a click anywhere else closes it. The
 * menu is placed in the window like the home screen's folder menu: under the
 * button, above it when there is no room below, and never past an edge, so a
 * row at the bottom of the settings shows its whole menu.
 */
export function MenuButton({
  label,
  ariaLabel,
  items,
  className = 'set-btn',
}: {
  label: ReactNode
  ariaLabel?: string
  items: readonly MenuItem[]
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    // the menu is fixed in the window, so it would come away from its row when the list moves
    const close = () => setOpen(false)
    document.addEventListener('mousedown', outside)
    document.addEventListener('click', outside)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('click', outside)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const menu = menuRef.current
    if (!open || !wrap || !menu) return
    const button = wrap.getBoundingClientRect()
    // the app frame may be scaled: the button's place is in window pixels, the menu's in its own
    const scale = wrap.offsetWidth > 0 && button.width > 0 ? button.width / wrap.offsetWidth : 1
    const rtl = getComputedStyle(wrap).direction === 'rtl'
    const { left, top } = placeFolderMenu(
      {
        x: (rtl ? button.left : button.right) / scale,
        y: button.bottom / scale + MENU_GAP,
        above: button.top / scale - MENU_GAP,
        align: rtl ? 'start' : 'end',
      },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      {
        width: document.documentElement.clientWidth / scale,
        height: document.documentElement.clientHeight / scale,
      },
    )
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [open])

  return (
    <div className="skl-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((was) => !was)}
      >
        {label}
      </button>
      {open && (
        <div className="skl-menu" role="menu" ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="skl-menu-item"
              onClick={() => {
                setOpen(false)
                item.onPick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Run `cleanup` when the component goes away for good. StrictMode unmounts
 * and mounts again at once in development; the deferred check skips that.
 */
export function useFinalCleanup(cleanup: () => void): void {
  const cleanupRef = useRef(cleanup)
  cleanupRef.current = cleanup
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      setTimeout(() => {
        if (!mounted.current) cleanupRef.current()
      }, 0)
    }
  }, [])
}
