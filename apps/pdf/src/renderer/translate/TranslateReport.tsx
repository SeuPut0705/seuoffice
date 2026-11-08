/**
 * The result of a translation's export (spec §8 "결과 보고"): blocks
 * translated, blocks kept in the source language and why, blocks that did
 * not fit their box, pages kept as they were, and the files written. A
 * Markdown file is opened in a Markdown tab when the report is closed, like
 * the Markdown conversion does after its warnings.
 */
import { useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import type { TFunc } from '../i18n/locale'
import { useModalDialog } from '../modal-dialog'
import {
  originalPageLines,
  overflowPages,
  untranslatedLines,
  type TranslationFormat,
  type TranslationResultReport,
} from './translate-model'

export interface TranslateReportProps {
  t: TFunc
  /** the target language as the user reads it */
  language: string
  report: TranslationResultReport | null
  /** the files written, in format order */
  outputs: ReadonlyArray<{ format: TranslationFormat; path: string }>
  /** one line per format that could not be written */
  failures: readonly string[]
  /** written from a stopped translation (the rest stays in the source language) */
  partial: boolean
  onOpenFolder: (path: string) => void
  /** closed; the caller opens the Markdown result */
  onClose: () => void
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function TranslateReport(props: TranslateReportProps): ReactElement {
  const { t, report, outputs, failures, partial } = props
  const propsRef = useRef(props)
  propsRef.current = props
  const dismiss = useCallback(() => propsRef.current.onClose(), [])
  const dialogRef = useModalDialog(dismiss)
  const untranslated = report ? untranslatedLines(report.untranslated, t) : []
  const kept = report ? originalPageLines(report.originalPages, t) : []
  const overflow = report && report.overflowed.length > 0 ? overflowPages(report) : ''
  const clean =
    report !== null &&
    report.pending === 0 &&
    untranslated.length === 0 &&
    kept.length === 0 &&
    overflow === ''

  return (
    <div className="pdf-modal-mask">
      <div
        ref={dialogRef}
        className="pdf-modal pdf-modal-wide pdf-translate-report"
        role="dialog"
        aria-modal="true"
        aria-label={t('trReportTitle')}
        data-partial={partial || undefined}
      >
        <div className="pdf-modal-title">
          {partial ? t('trReportPartialTitle') : t('trReportTitle')}
        </div>
        {report && (
          <ul className="pdf-ai-read-summary">
            <li data-translated={report.translated}>
              {t('trReportTranslated', {
                language: props.language,
                translated: report.translated,
                total: report.total,
              })}
            </li>
            {report.pending > 0 && (
              <li data-pending={report.pending}>
                {t('trReportPending', { count: report.pending })}
              </li>
            )}
            {clean && <li>{t('trReportNone')}</li>}
          </ul>
        )}
        {untranslated.length > 0 && (
          <section className="pdf-translate-report-part" data-report="untranslated">
            <span className="pdf-translate-report-head">{t('trReportUntranslated')}</span>
            <ul className="pdf-convert-warnings">
              {untranslated.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {overflow && (
          <section className="pdf-translate-report-part" data-report="overflowed">
            <span className="pdf-translate-report-head">
              {t('trReportOverflowed', { pages: overflow, count: report!.overflowed.length })}
            </span>
          </section>
        )}
        {kept.length > 0 && (
          <section className="pdf-translate-report-part" data-report="original-pages">
            <span className="pdf-translate-report-head">{t('trReportOriginalPages')}</span>
            <ul className="pdf-convert-warnings">
              {kept.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {failures.length > 0 && (
          <ul className="pdf-convert-warnings" role="alert" data-report="failures">
            {failures.map((line) => (
              <li key={line} className="pdf-convert-error">
                {line}
              </li>
            ))}
          </ul>
        )}
        {outputs.length > 0 && (
          <section className="pdf-translate-report-part" data-report="files">
            <span className="pdf-translate-report-head">{t('trReportFiles')}</span>
            <ul className="pdf-convert-warnings">
              {outputs.map((o) => (
                <li
                  key={o.path}
                  className="pdf-convert-path"
                  data-tip={o.path}
                  data-output={o.format}
                >
                  {baseName(o.path)}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="pdf-modal-actions">
          {outputs.length > 0 && (
            <button
              type="button"
              className="pdf-modal-btn"
              data-action="open-folder"
              onClick={() => props.onOpenFolder(outputs[0]!.path)}
            >
              {t('cvOpenFolder')}
            </button>
          )}
          <button
            type="button"
            className="pdf-modal-btn primary"
            data-action="close-report"
            onClick={props.onClose}
          >
            {outputs.some((o) => o.format === 'md') ? t('cvOpenMd') : t('arClose')}
          </button>
        </div>
      </div>
    </div>
  )
}
