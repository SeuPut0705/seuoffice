/**
 * The strip a running document job shows over the page view (spec §9):
 * progress (done / total, the page in flight) and "Stop"; once the job ended,
 * what happened and a close button. Presentational and kind-agnostic: the
 * caller words the lines (AI page reading, translation).
 */
import type { ReactElement, ReactNode } from 'react'
import type { TFunc } from '../i18n/locale'
import type { DocumentJobView } from './job-session'

export interface JobProgressStripProps {
  view: DocumentJobView
  /** the headline: running progress or the outcome */
  title: string
  /** further lines (the page in flight, failed pages, the reason it stopped) */
  details?: readonly string[]
  /** buttons before Close once the job ended (a stopped translation's choices) */
  actions?: ReactNode
  t: TFunc
  onStop: () => void
  onClose: () => void
}

export function JobProgressStrip({
  view,
  title,
  details = [],
  actions,
  t,
  onStop,
  onClose,
}: JobProgressStripProps): ReactElement {
  const running = view.state === 'running'
  const percent = view.total > 0 ? Math.min(100, (view.done / view.total) * 100) : 0
  const tone = running ? '' : view.state === 'complete' ? ' is-done' : ' is-stopped'
  return (
    <div
      className={`pdf-job-strip${tone}`}
      role={running ? 'status' : 'alert'}
      data-job-kind={view.kind}
      data-job-state={view.state}
    >
      <div className="pdf-job-strip-text">
        <span className="pdf-job-strip-title">{title}</span>
        {details.map((line) => (
          <span key={line} className="pdf-job-strip-detail">
            {line}
          </span>
        ))}
        {running && (
          <div className="pdf-job-strip-bar" aria-hidden="true">
            <div className="pdf-job-strip-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {running ? (
        <button
          type="button"
          className="pdf-modal-btn"
          data-action="stop-job"
          disabled={view.stopping}
          onClick={onStop}
        >
          {view.stopping ? t('arStopping') : t('arStop')}
        </button>
      ) : (
        <>
          {actions}
          <button type="button" className="pdf-modal-btn" data-action="close-job" onClick={onClose}>
            {t('arClose')}
          </button>
        </>
      )}
    </div>
  )
}
