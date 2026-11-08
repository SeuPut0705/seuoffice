import { useEffect, useState } from 'react'
import { htmlDir, htmlLang, type Params } from '@genoffice/i18n'
import './globals'
import {
  AI_TARGET_KINDS,
  type AiTargetKind,
  type ConvertKind,
  type ConvertProblem,
  type GenerateWindowState,
  type MaterialProblem,
  type MaterialView,
} from '../../../shared/generate-api'
import { defaultGeneratePrompt } from '../../../shared/generate-default-prompts'
import { generateText, type GenerateStringKey } from '../i18n/strings-generate'
import { formatBytes } from './format'

const KIND_LABEL: Record<AiTargetKind, GenerateStringKey> = {
  slides: 'kindSlides',
  html: 'kindHtml',
  mindmap: 'kindMindmap',
}

/** 8.6: what each conversion without AI makes */
const CONVERT_LABEL: Record<ConvertKind, GenerateStringKey> = {
  'mindmap-to-markdown': 'convertToMarkdown',
  'mindmap-to-slides': 'convertToSlides',
  'markdown-to-mindmap': 'convertToMindmap',
}

/** why a conversion did not happen */
const CONVERT_PROBLEM_LABEL: Record<ConvertProblem, GenerateStringKey> = {
  unreadable: 'convertUnreadable',
  redaction: 'convertRedactionFailed',
  'too-many-slides': 'convertTooManySlides',
  failed: 'convertFailed',
}

const PROBLEM_LABEL: Record<MaterialProblem, GenerateStringKey> = {
  missing: 'reasonMissing',
  unsupported: 'reasonUnsupported',
  'too-large': 'reasonTooLarge',
  unreadable: 'reasonUnreadable',
  untitled: 'reasonUntitled',
}

function NoticeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="gen-icon">
      <path
        d="M8 1.8 15 14H1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.7" r=".8" fill="currentColor" />
    </svg>
  )
}

export function GenerateWindow() {
  const api = window.aiOfficeGenerateWindow
  const [state, setState] = useState<GenerateWindowState | null>(null)
  const [text, setText] = useState('')

  useEffect(() => {
    let alive = true
    void api.getState().then((s) => {
      if (alive && s) setState(s)
    })
    const off = api.onState((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [api])

  const lang = state?.lang
  useEffect(() => {
    if (!lang) return
    document.documentElement.lang = htmlLang(lang)
    document.documentElement.dir = htmlDir(lang)
    document.title = generateText(lang, 'windowTitle')
  }, [lang])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void api.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

  if (!state) return <div className="gen-boot" />

  const t = (key: GenerateStringKey, params?: Params) => generateText(state.lang, key, params)
  const listed = state.materials.filter((m) => m.state !== 'excluded')
  const unsaved = state.materials.filter((m) => m.state === 'unsaved')
  const excluded = state.materials.filter((m) => m.state === 'excluded')
  const busy = state.making
  const converting = state.mode === 'convert'
  const make = () => {
    // 8.1: a conversion carries no request text
    if (state.canMake) void api.make(converting ? '' : text)
  }

  const saveButton = (m: MaterialView) => {
    const saving = state.saving.includes(m.key)
    return (
      <button
        className="gen-btn gen-btn-small"
        data-testid="gen-save-material"
        disabled={saving || busy}
        onClick={() => void api.saveMaterial(m.key)}
      >
        {saving
          ? t('savingMaterial')
          : m.saveAction === 'save'
            ? t('saveMaterial')
            : t('showMaterial')}
      </button>
    )
  }

  const removeButton = (m: MaterialView) => (
    <button
      className="gen-icon-btn"
      aria-label={`${t('removeMaterial')}: ${m.name}`}
      title={t('removeMaterial')}
      disabled={busy}
      onClick={() => void api.removeMaterial(m.key)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </button>
  )

  return (
    <div className="gen" data-testid="generate-window">
      <header className="gen-head">
        <h1 className="gen-title">{t('windowTitle')}</h1>
      </header>

      <div className="gen-body">
        <section className="gen-section">
          <div className="gen-label" id="gen-kind-label">
            {t('kindLabel')}
          </div>
          <div className="gen-kinds" role="radiogroup" aria-labelledby="gen-kind-label">
            {AI_TARGET_KINDS.map((kind) => (
              <button
                key={kind}
                role="radio"
                aria-checked={!converting && state.kind === kind}
                data-kind={kind}
                className={`gen-kind${!converting && state.kind === kind ? ' active' : ''}`}
                disabled={busy}
                onClick={() => void api.setKind(kind)}
              >
                {t(KIND_LABEL[kind])}
              </button>
            ))}
          </div>
          {state.conversions.length > 0 && (
            <div className="gen-convert" data-testid="gen-convert">
              <div className="gen-sublabel" id="gen-convert-label">
                {t('convertLabel')}
              </div>
              <div className="gen-kinds" role="radiogroup" aria-labelledby="gen-convert-label">
                {state.conversions.map((kind) => (
                  <button
                    key={kind}
                    role="radio"
                    aria-checked={state.convertKind === kind}
                    data-convert={kind}
                    className={`gen-kind${state.convertKind === kind ? ' active' : ''}`}
                    disabled={busy}
                    onClick={() => void api.setConvert(kind)}
                  >
                    {t(CONVERT_LABEL[kind])}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="gen-section">
          <div className="gen-row-head">
            <span className="gen-label">{t('materialsLabel')}</span>
            <button
              className="gen-btn gen-btn-small"
              data-testid="gen-add-materials"
              disabled={busy}
              onClick={() => void api.addMaterials()}
            >
              {t('addMaterials')}
            </button>
          </div>
          {listed.length === 0 && excluded.length === 0 ? (
            <div className="gen-empty">{t('emptyMaterials')}</div>
          ) : (
            <ul className="gen-list" data-testid="gen-materials">
              {listed.map((m) => (
                <li
                  key={m.key}
                  className={`gen-item gen-item-${m.state}`}
                  data-state={m.state}
                  data-name={m.name}
                >
                  <span className="gen-item-name" title={m.path ?? m.name}>
                    {m.name}
                  </span>
                  <span className="gen-item-size" data-testid="gen-item-size">
                    {m.state === 'checking'
                      ? t('checking')
                      : m.sizeBytes !== undefined
                        ? formatBytes(m.sizeBytes, state.lang)
                        : ''}
                  </span>
                  {removeButton(m)}
                </li>
              ))}
            </ul>
          )}
          <div className="gen-total" data-testid="gen-total">
            {state.checking
              ? t('checking')
              : t(state.readyCount === 1 ? 'totalLineOne' : 'totalLine', {
                  n: state.readyCount,
                  size: formatBytes(state.totalBytes, state.lang),
                })}
          </div>

          {unsaved.length > 0 && (
            <div className="gen-callout gen-callout-block" data-testid="gen-unsaved" role="alert">
              <div className="gen-callout-title">{t('unsavedTitle')}</div>
              <div className="gen-callout-body">{t('unsavedBody')}</div>
              <ul className="gen-sublist">
                {unsaved.map((m) => (
                  <li key={m.key} className="gen-subitem" data-name={m.name}>
                    <span className="gen-item-name" title={m.path ?? m.name}>
                      {m.name}
                    </span>
                    {saveButton(m)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {excluded.length > 0 && (
            <div className="gen-excluded" data-testid="gen-excluded">
              <div className="gen-sublabel">{t('excludedLabel')}</div>
              <ul className="gen-sublist">
                {excluded.map((m) => (
                  <li
                    key={m.key}
                    className="gen-subitem"
                    data-problem={m.problem}
                    data-name={m.name}
                  >
                    <span className="gen-subitem-text">
                      <span className="gen-item-name" title={m.path ?? m.name}>
                        {m.name}
                      </span>
                      <span className="gen-reason">
                        {m.problem
                          ? t(PROBLEM_LABEL[m.problem], {
                              mb: m.limitMb ?? state.limits.maxMaterialMb,
                            })
                          : ''}
                      </span>
                    </span>
                    {m.saveAction && saveButton(m)}
                    {removeButton(m)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {converting && state.redactionNotice && (
          <div className="gen-notices" data-testid="gen-redaction-notice" role="status">
            <div className="gen-callout" data-notice="redacted">
              <NoticeIcon />
              <span>{t('noticeRedacted')}</span>
            </div>
          </div>
        )}

        <section className="gen-section" hidden={converting}>
          <label className="gen-label" htmlFor="gen-request">
            {t('requestLabel')}
          </label>
          <textarea
            id="gen-request"
            className="gen-request"
            rows={4}
            value={text}
            placeholder={defaultGeneratePrompt(state.lang, state.kind)}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) make()
            }}
          />
          <div className="gen-hint">{t('requestHint')}</div>
        </section>

        {(state.notices.usage || state.notices.longMaterial) && (
          <div className="gen-notices" data-testid="gen-notices" role="status">
            {state.notices.usage && (
              <div className="gen-callout" data-notice="usage">
                <NoticeIcon />
                <span>{t('noticeUsage')}</span>
              </div>
            )}
            {state.notices.longMaterial && (
              <div className="gen-callout" data-notice="long">
                <NoticeIcon />
                <span>{t('noticeLong')}</span>
              </div>
            )}
          </div>
        )}

        {state.tooMany && (
          <div className="gen-blocker" data-testid="gen-too-many">
            {t('tooMany', { max: state.limits.maxMaterials })}
          </div>
        )}
        {!state.checking && state.readyCount === 0 && state.materials.length > 0 && (
          <div className="gen-blocker">{t('noReadable')}</div>
        )}
        {state.failure && (
          <div className="gen-blocker" role="alert" data-testid="gen-failure">
            {state.failure === 'convert'
              ? t(CONVERT_PROBLEM_LABEL[state.convertProblem ?? 'failed'], {
                  max: state.limits.maxConvertSlides,
                })
              : state.failure === 'make'
                ? t('makeFailed')
                : t('saveFailed')}
          </div>
        )}
      </div>

      <footer className="gen-foot">
        <span className="gen-hint gen-foot-hint">
          {converting ? t('convertHint') : t('makeHint')}
        </span>
        <div className="gen-actions">
          <button className="gen-btn" onClick={() => void api.cancel()}>
            {t('cancel')}
          </button>
          <button
            className="gen-btn gen-btn-primary"
            data-testid="gen-make"
            disabled={!state.canMake}
            onClick={make}
          >
            {busy ? t('making') : t('make')}
          </button>
        </div>
      </footer>
    </div>
  )
}
