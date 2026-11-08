/**
 * The sheet tabs at the bottom: one tab per sheet, add, rename, delete.
 *
 * Sheet names come from the file. They are drawn as text by React and never
 * as markup.
 *
 * Adding and renaming happen at once; deleting asks first (the caller's
 * `onDelete` does the asking). None of the three is part of the map's undo.
 */
import { useEffect, useRef, useState } from 'react'
import type { SheetTab } from '../document/session'
import { useI18n } from '../i18n/locale'
import { IconClose, IconPlus } from './icons'

export interface SheetTabsProps {
  tabs: readonly SheetTab[]
  activeKey: string | null
  disabled: boolean
  onSelect(key: string): void
  onAdd(): void
  onRename(key: string, title: string): void
  onDelete(key: string): void
}

export function SheetTabs(p: SheetTabsProps) {
  const { t } = useI18n()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming !== null) input.current?.select()
  }, [renaming])

  const startRename = (tab: SheetTab): void => {
    if (p.disabled) return
    setDraft(tab.title)
    setRenaming(tab.key)
  }
  const commit = (): void => {
    if (renaming === null) return
    const title = draft.trim()
    // an emptied name keeps the old one rather than leaving a sheet nobody can tell apart
    if (title !== '') p.onRename(renaming, title)
    setRenaming(null)
  }
  const only = p.tabs.length === 1

  return (
    <div className="mm-sheets" role="tablist" aria-label={t('sheetTabs')}>
      {p.tabs.map((tab) => {
        const active = tab.key === p.activeKey
        if (renaming === tab.key) {
          return (
            <input
              key={tab.key}
              ref={input}
              className="mm-sheet-rename"
              aria-label={t('sheetRename')}
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                // a composition's Enter confirms the composition, not the rename
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') setRenaming(null)
              }}
            />
          )
        }
        return (
          <span key={tab.key} className={`mm-sheet${active ? ' on' : ''}`} data-sheet-key={tab.key}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="mm-sheet-name"
              data-tip={active ? t('sheetRename') : undefined}
              disabled={p.disabled}
              onClick={() => p.onSelect(tab.key)}
              onDoubleClick={() => startRename(tab)}
            >
              {tab.title}
            </button>
            {active && (
              <button
                type="button"
                className="mm-sheet-delete"
                data-action="sheet-delete"
                data-tip={only ? t('lastSheetNote') : t('sheetDelete')}
                aria-label={t('sheetDelete')}
                disabled={p.disabled || only}
                onClick={() => p.onDelete(tab.key)}
              >
                <IconClose />
              </button>
            )}
          </span>
        )
      })}
      <button
        type="button"
        className="mm-sheet-add"
        data-action="sheet-add"
        data-tip={t('sheetAdd')}
        aria-label={t('sheetAdd')}
        disabled={p.disabled}
        onClick={p.onAdd}
      >
        <IconPlus />
      </button>
    </div>
  )
}
