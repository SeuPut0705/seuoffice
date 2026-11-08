/**
 * The selection display above the AI panel's input: the selected template's
 * name (or a "Template" button when there is none), which opens the gallery to
 * pick or change it, a button that removes it, and, when the user has added
 * requests on top of the template, a mark and a button that clears them.
 *
 * A pick in a deck that already has slides says once that the existing slides
 * stay as they are: picking changes nothing in the document, the template
 * applies to the slides the AI makes from then on.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/locale'
import { TEMPLATE_START_GALLERY_ID, TemplateGallery } from './TemplateGallery'
import {
  builtinTemplateById,
  templateSelectionState,
  useTemplateSelection,
  type TemplateSelectionState,
} from './template-selection-state'

export interface TemplatePickerProps {
  state?: TemplateSelectionState
  /** The document has no slides yet: a pick needs no word about existing slides */
  deckEmpty: boolean
  /** The start screen already shows the gallery: the chip moves to it instead of opening another */
  galleryShown?: boolean
}

export function TemplatePicker({
  state = templateSelectionState,
  deckEmpty,
  galleryShown = false,
}: TemplatePickerProps) {
  const { t } = useI18n()
  const selection = useTemplateSelection(state)
  const [open, setOpen] = useState(false)
  const [appliesNotice, setAppliesNotice] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const name = selection
    ? selection.kind === 'builtin'
      ? (builtinTemplateById(selection.key)?.name ?? selection.key)
      : selection.key
    : null

  // While the start screen shows its gallery, no second one opens here
  const popoverOpen = open && !galleryShown
  // No selection, no word about it
  const showNotice = appliesNotice && selection !== null

  // Opened: keyboard users land on the selected card (or the first); a press outside closes it
  useEffect(() => {
    if (!popoverOpen) return
    const popover = popoverRef.current
    const target =
      popover?.querySelector<HTMLElement>('.ai-tpl-card[aria-pressed="true"]') ??
      popover?.querySelector<HTMLElement>('.ai-tpl-card')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView?.({ block: 'nearest' })
    const onPress = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [popoverOpen])

  const onChip = (): void => {
    const startGallery = galleryShown ? document.getElementById(TEMPLATE_START_GALLERY_ID) : null
    if (startGallery) {
      startGallery.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      const target =
        startGallery.querySelector<HTMLElement>('.ai-tpl-card[aria-pressed="true"]') ??
        startGallery.querySelector<HTMLElement>('.ai-tpl-card')
      target?.focus({ preventScroll: true })
      return
    }
    setOpen((was) => !was)
  }

  const onPicked = (changed: boolean): void => {
    setOpen(false)
    chipRef.current?.focus()
    if (changed) setAppliesNotice(!deckEmpty)
  }

  return (
    <div className="ai-tpl-picker" ref={rootRef}>
      {popoverOpen && (
        <div
          ref={popoverRef}
          className="ai-tpl-popover"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            chipRef.current?.focus()
          }}
        >
          <TemplateGallery state={state} onPicked={onPicked} />
        </div>
      )}
      {showNotice && (
        <div className="ai-tpl-notice" role="status">
          {t('aiTplAppliesToNew')}
        </div>
      )}
      <div className="ai-tpl-bar">
        <span className={selection ? 'ai-tpl-chip ai-tpl-chip-selected' : 'ai-tpl-chip'}>
          <button
            ref={chipRef}
            type="button"
            className="ai-tpl-chip-main"
            aria-expanded={galleryShown ? undefined : popoverOpen}
            {...(name
              ? {
                  'aria-label': `${t('aiTplChipChange')}: ${name}`,
                  'data-tip': t('aiTplChipChange'),
                }
              : {})}
            onClick={onChip}
          >
            {name ?? t('aiTplChipPick')}
          </button>
          {selection && (
            <button
              type="button"
              className="ai-tpl-chip-remove"
              aria-label={t('aiTplChipRemove')}
              data-tip={t('aiTplChipRemove')}
              onClick={() => {
                setOpen(false)
                setAppliesNotice(false)
                void state.remove()
              }}
            >
              <svg width="12" height="12" viewBox="0 0 32 32" aria-hidden>
                <path
                  d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                  fill="currentColor"
                />
              </svg>
            </button>
          )}
        </span>
        {selection && selection.adjustments.length > 0 && (
          <>
            <span className="ai-tpl-adjust-mark">{t('aiTplAdjustMark')}</span>
            <button
              type="button"
              className="ai-tpl-adjust-clear"
              onClick={() => void state.clearRequests()}
            >
              {t('aiTplAdjustClear')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
