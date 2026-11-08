import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MathfieldElement } from 'mathlive'
import 'mathlive/fonts.css'
import { useModalKeys } from '@genoffice/ui'
import { useI18n } from '../../i18n/locale'
import { MATH_TEMPLATES, MAX_LATEX_LENGTH, renderMath, type MathValue } from './model'
import './math.css'

// Vite bundles the CSS font URLs locally. MathLive must not load from a CDN.
MathfieldElement.fontsDirectory = null
MathfieldElement.soundsDirectory = null

interface Props {
  initial: MathValue
  editing: boolean
  onApply: (value: MathValue) => boolean
  onCancel: () => void
}

/** Meditor's visual field + synchronized LaTeX workflow, without a global editor store. */
export function MathDialog({ initial, editing, onApply, onCancel }: Props) {
  const { t, lang } = useI18n()
  const titleId = useId()
  const host = useRef<HTMLDivElement>(null)
  const field = useRef<MathfieldElement | null>(null)
  const [latex, setLatex] = useState(initial.latex)
  const [display, setDisplay] = useState(initial.display)
  const [stale, setStale] = useState(false)
  const value = useMemo(() => ({ latex, display }), [latex, display])
  const preview = useMemo(() => renderMath(value), [value])
  const modalKeys = useModalKeys(onCancel, { restoreFocus: true })
  const inputLabel = t('mathVisualInput')

  useEffect(() => {
    const mf = new MathfieldElement()
    mf.mathVirtualKeyboardPolicy = 'manual'
    mf.value = initial.latex.length <= MAX_LATEX_LENGTH ? initial.latex : ''
    const keyboardZIndex = document.body.style.getPropertyValue('--keyboard-zindex')
    document.body.style.setProperty('--keyboard-zindex', '1300')
    const input = () => setLatex(mf.value)
    mf.addEventListener('input', input)
    host.current?.append(mf)
    // MathLive's menu setter is only available after its connectedCallback.
    mf.menuItems = []
    field.current = mf
    mf.focus()
    return () => {
      mf.removeEventListener('input', input)
      window.mathVirtualKeyboard?.hide()
      if (keyboardZIndex) document.body.style.setProperty('--keyboard-zindex', keyboardZIndex)
      else document.body.style.removeProperty('--keyboard-zindex')
      mf.remove()
      field.current = null
    }
  }, [initial])

  useEffect(() => {
    field.current?.setAttribute('aria-label', inputLabel)
    field.current?.setAttribute('lang', lang)
  }, [inputLabel, lang])

  const apply = () => {
    if (!latex.trim() || latex.length > MAX_LATEX_LENGTH) return
    if (!onApply(value)) setStale(true)
  }

  return (
    <div
      className="html-math-mask"
      ref={modalKeys.ref}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          e.stopPropagation()
          apply()
        } else modalKeys.onKeyDown(e)
      }}
    >
      <section
        className="html-math-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{t(editing ? 'mathEdit' : 'mathInsert')}</h2>
          <button type="button" aria-label={t('closeEsc')} onClick={onCancel}>
            ×
          </button>
        </header>
        <p>{t('mathHelp')}</p>
        <div className="html-math-field" ref={host} />
        <div className="html-math-templates">
          {MATH_TEMPLATES.map(([label, snippet]) => (
            <button
              type="button"
              key={label}
              onClick={() => {
                field.current?.insert(snippet)
                field.current?.focus()
                setLatex(field.current?.value ?? latex)
              }}
            >
              {t(label)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              const keyboard = window.mathVirtualKeyboard
              if (keyboard.visible) keyboard.hide()
              else keyboard.show()
            }}
          >
            {t('mathKeyboard')}
          </button>
        </div>
        <label className="html-math-source">
          {t('mathSource')}
          <textarea
            aria-label={t('mathSource')}
            rows={3}
            spellCheck={false}
            value={latex}
            onChange={(e) => {
              setLatex(e.target.value)
              if (e.target.value.length <= MAX_LATEX_LENGTH)
                field.current?.setValue(e.target.value, { silenceNotifications: true })
            }}
          />
        </label>
        <label className="html-math-display">
          <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} />
          {t('mathDisplay')}
        </label>
        <div
          className="html-math-preview"
          aria-label={t('mathPreview')}
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
        {preview.error && (
          <p className="html-math-warning" role="status">
            {t('mathUnsupported')}
          </p>
        )}
        {latex.length > MAX_LATEX_LENGTH && (
          <p role="alert">{t('mathTooLong', { n: MAX_LATEX_LENGTH })}</p>
        )}
        {stale && <p role="alert">{t('mathStale')}</p>}
        <footer>
          <small>{t('mathShortcut')}</small>
          <button type="button" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!latex.trim() || latex.length > MAX_LATEX_LENGTH || stale}
            onClick={apply}
          >
            {t('mathApply')}
          </button>
        </footer>
      </section>
    </div>
  )
}
