/**
 * A colour of the format panel: one row that shows the colour in force and
 * opens the shared palette below it.
 *
 * The palette used to lie open in the panel, once for every colour, which
 * made each group taller than the window. Closed, the row says what the
 * palette would: the colour, "automatic" when none is written, or "mixed"
 * while the selected items differ.
 *
 * The row and the palette keep the focus where it is, so a title being typed
 * keeps its selection. A press outside or Escape closes the palette; a pick
 * closes it too. The window losing the focus does not, because "more
 * colours" opens the system's own window, which takes the focus while its
 * colour is still being chosen, and that colour is applied as it changes.
 */
import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { ColorPicker, colorSwatchName, type ColorPickerStrings } from '@genoffice/ui'
import { type TFunc, useI18n } from '../i18n/locale'
import type { ShownColor } from './format-model'

/** A value no swatch of the palette has: while the items differ, nothing looks chosen. */
const MIXED = 'mixed'

function pickerStrings(lang: Lang, t: TFunc, auto: string): ColorPickerStrings {
  return {
    auto,
    themeColors: t('formatThemeColors'),
    standardColors: t('formatStandardColors'),
    moreColors: t('formatMoreColors'),
    colorName: (swatch) => colorSwatchName(lang, swatch),
  }
}

export function ColorField(p: {
  /** names the row for the tests and the real-run scripts */
  action: string
  /** what the colour is of, read out with the row */
  label: string
  current: ShownColor
  /** what no colour reads as: "automatic", "as the theme" */
  auto: string
  /** what the value `none` reads as (a boundary without a fill) */
  none?: string
  disabled?: boolean
  onPick(color: string | null): void
}) {
  const { lang, t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const disabled = p.disabled ?? false

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onPress = (event: PointerEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // the palette closes; the map keeps its selection
      event.stopPropagation()
      close()
    }
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const mixed = p.current.state !== 'value'
  const written = p.current.state === 'value' ? p.current.value : null
  const none = written === 'none'
  const hex = written !== null && !none ? written : null
  const text = mixed
    ? t('formatMixed')
    : none
      ? (p.none ?? p.auto)
      : hex
        ? hex.toUpperCase()
        : p.auto
  const state = mixed ? 'mixed' : none ? 'none' : hex ? 'value' : 'auto'

  return (
    <div
      ref={wrap}
      className="mm-color"
      data-color-state={state}
      // the focus stays in the map or in the title being typed
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="mm-color-field"
        data-action={p.action}
        aria-label={`${p.label}: ${text}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span
          className="mm-color-swatch"
          style={hex ? { background: hex } : undefined}
          aria-hidden="true"
        />
        <span className="mm-color-text">{text}</span>
        <span className="mm-color-caret" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path
              d="M5.5 9.25 12 15.75l6.5-6.5"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && (
        <div className="mm-color-pop mm-format-colors" role="dialog" aria-label={p.label}>
          <ColorPicker
            value={mixed || none ? MIXED : hex}
            strings={pickerStrings(lang, t, p.auto)}
            onPick={(picked) => {
              p.onPick(picked ? picked.toLowerCase() : null)
              setOpen(false)
            }}
            moreInputProps={{
              // applied as it changes, without closing: taking the field away would
              // close the system's colour window with it
              onChange: (event) => p.onPick(event.currentTarget.value.toLowerCase()),
            }}
          />
        </div>
      )}
    </div>
  )
}
