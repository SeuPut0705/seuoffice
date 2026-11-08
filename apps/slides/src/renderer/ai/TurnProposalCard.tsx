/** AI edit review card: the slides an AI request changed, with Accept and Reject. */
import { useState } from 'react'
import { useI18n } from '../i18n/locale'
import { SlideThumb } from '../SlideThumb'
import type { ProposalState } from './turn-proposal'
import './turn-proposal.css'

const MAX_SHOWN = 4
const THUMB_WIDTH = 112

export function TurnProposalCard({
  state,
  images,
  onAccept,
  onReject,
}: {
  state: Exclude<ProposalState, { kind: 'none' }>
  images: Map<string, HTMLImageElement>
  onAccept: () => Promise<void>
  onReject: () => Promise<void>
}) {
  const { t } = useI18n()
  const [working, setWorking] = useState(false)
  const run = (action: () => Promise<void>) => {
    setWorking(true)
    void action().finally(() => setWorking(false))
  }
  const shown = state.changes.slice(0, MAX_SHOWN)
  const hidden = state.changes.length - shown.length

  return (
    <div className="turn-proposal" role="group" aria-label={t('aiProposalTitle')}>
      <div className="turn-proposal-head">
        <span>{t('aiProposalTitle')}</span>
        <span className="turn-proposal-count">
          {t('aiProposalSummary', { count: state.changes.length })}
        </span>
      </div>
      {state.kind === 'stale' && <div className="turn-proposal-stale">{t('aiProposalStale')}</div>}
      {state.changes.length === 0 ? (
        <div className="turn-proposal-note">{t('aiProposalNoSlideChange')}</div>
      ) : (
        <div className="turn-proposal-list">
          {shown.map((change) => (
            <div key={change.key}>
              <div className="turn-proposal-change-title">
                {t('aiScopeSlide', { n: change.position })}
                {!change.before && ` · ${t('aiProposalAdded')}`}
                {!change.after && ` · ${t('aiProposalRemoved')}`}
              </div>
              <div className="turn-proposal-pair">
                {change.before && change.after && (
                  <div className="turn-proposal-thumb">
                    <SlideThumb slide={change.before} images={images} width={THUMB_WIDTH} />
                    {t('aiProposalBefore')}
                  </div>
                )}
                <div className="turn-proposal-thumb">
                  <SlideThumb
                    slide={(change.after ?? change.before)!}
                    images={images}
                    width={THUMB_WIDTH}
                  />
                  {change.before && change.after ? t('aiProposalAfter') : null}
                </div>
              </div>
            </div>
          ))}
          {hidden > 0 && (
            <div className="turn-proposal-note">{t('aiProposalMore', { count: hidden })}</div>
          )}
        </div>
      )}
      <div className="turn-proposal-actions">
        {state.kind === 'pending' ? (
          <>
            <button
              type="button"
              className="turn-proposal-btn"
              disabled={working}
              onClick={() => run(onReject)}
            >
              {t('aiProposalReject')}
            </button>
            <button
              type="button"
              className="turn-proposal-btn turn-proposal-btn-primary"
              disabled={working}
              onClick={() => run(onAccept)}
            >
              {t('aiProposalAccept')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="turn-proposal-btn"
            disabled={working}
            onClick={() => run(onReject)}
          >
            {t('aiProposalDismiss')}
          </button>
        )}
      </div>
    </div>
  )
}
