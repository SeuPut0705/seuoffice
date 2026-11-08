import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

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

/** A button with a small menu under it; a click anywhere else closes it */
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
    document.addEventListener('mousedown', outside)
    document.addEventListener('click', outside)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('click', outside)
      window.removeEventListener('keydown', onKey, true)
    }
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
        <div className="skl-menu" role="menu">
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
