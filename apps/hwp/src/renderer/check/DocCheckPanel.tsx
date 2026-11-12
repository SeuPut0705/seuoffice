import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IconClose } from '@seuoffice/ui/icons'
import {
  ADMINISTRATION_RULES,
  audit,
  type AuditResult,
  type Finding,
  type Place,
  type RuleId,
} from '@seuoffice/doc-rules'
import type { AgentDocumentProfile } from '../../../studio-plugin/agent-plugin.mjs'
import type { AgentBridge } from '../ai/agent-bridge'
import { useI18n } from '../i18n/locale'
import type { HwpFormat } from '../../shared/ipc'
import type { HoldTracker } from '../print-flow'

/**
 * The checks that are off by default: they fire on most documents that were written
 * before the guideline, so they stay out of the way until someone asks for them.
 */
const EXTRA_RULES: Partial<Record<RuleId, boolean>> = {
  'font.outside-recommended': true,
  'numbering.mixed': true,
  'numbering.order': true,
  'blank.run': true,
}

/** Places listed under one finding; the count says how many there really are. */
const MAX_SHOWN_PLACES = 6

/** The font the guideline names first: what a Korean-word-processor font is replaced with. */
const REPLACEMENT_FONT = '함초롬바탕'

/** How long to wait after the document changes before reading it again. */
const REREAD_DELAY_MS = 1200

interface Props {
  bridge: AgentBridge
  /**
   * The app's record of an AI run's hold on the document. The font fix is the person's edit made
   * from this window, which the editor's run lock does not reach: while a run holds the
   * document it would be counted as one of the run's steps and held out with it, so it waits.
   */
  aiHold: Pick<HoldTracker, 'isHeld' | 'subscribe'>
  format: HwpFormat
  onClose: () => void
  /** Hands a request to the AI panel's input box; it is not sent. */
  onHandOff?: (request: string) => void
  /**
   * A count of the calls that may have changed the document outside this panel (an AI run's
   * edits). Only a rise while the panel is open means something: the app counts from its
   * start, so the number is above zero before the panel is ever opened.
   */
  revision?: number
}

/**
 * The format check of `@seuoffice/doc-rules` over the open document. It reads the document
 * once through the editor's plugin and judges it here, with no model and no network: the
 * panel works with AI turned off. The font fix is a plain edit; everything else is handed
 * to the AI as a request the user reads before sending.
 */
export function DocCheckPanel({ bridge, aiHold, format, onClose, onHandOff, revision = 0 }: Props) {
  const { t } = useI18n()
  const aiHeld = useSyncExternalStore(aiHold.subscribe, () => aiHold.isHeld())
  const [profile, setProfile] = useState<AgentDocumentProfile | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(true)
  const [extra, setExtra] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [handedOff, setHandedOff] = useState(false)

  // the document is read once; the switch only re-judges the same facts
  const result: AuditResult | null = useMemo(
    () =>
      profile
        ? audit({ ...profile, format }, ADMINISTRATION_RULES, extra ? { rules: EXTRA_RULES } : {})
        : null,
    [profile, format, extra],
  )

  const run = useCallback(async () => {
    setBusy(true)
    setFailed(false)
    try {
      setProfile(await bridge.documentProfile())
    } catch {
      setProfile(null)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [bridge])

  useEffect(() => {
    void run()
  }, [run])

  // an AI run changes the document: read it again once the run has stopped writing. The
  // panel has just read it when it opens, so the count it opened with calls for no read:
  // one would hide the findings and turn the buttons off under the user a moment later.
  const readAtRevision = useRef(revision)
  useEffect(() => {
    if (revision === readAtRevision.current) return
    const timer = setTimeout(() => {
      readAtRevision.current = revision
      void run()
    }, REREAD_DELAY_MS)
    return () => clearTimeout(timer)
  }, [revision, run])

  const goTo = useCallback(
    (place: Place) => {
      const path = place.anchor.path?.map((step) => ({
        controlIndex: step.controlIndex,
        cellIndex: step.cellIndex,
        cellParaIndex: step.cellParaIndex ?? 0,
      }))
      void bridge
        .reveal({
          sec: place.anchor.section ?? 0,
          para: place.anchor.para,
          ...(path && path.length > 0 ? { path } : {}),
          offset: 0,
          length: 0,
        })
        .catch(() => {})
    },
    [bridge],
  )

  const replaceFont = useCallback(
    async (from: string) => {
      // read now, not from the last render: a run may have taken the document since
      if (aiHold.isHeld()) return
      setFixing(from)
      setFailed(false)
      try {
        await bridge.replaceFont(from, REPLACEMENT_FONT)
        await run()
      } catch {
        setFailed(true)
      } finally {
        setFixing(null)
      }
    },
    [aiHold, bridge, run],
  )

  const handOff = useCallback(() => {
    if (!result || !onHandOff) return
    onHandOff(requestFor(result))
    setHandedOff(true)
  }, [onHandOff, result])

  const severityLabel = (severity: Finding['severity']): string =>
    severity === 'violation'
      ? t('checkViolation')
      : severity === 'check'
        ? t('checkReview')
        : t('checkSuggestion')

  return (
    <section className="doc-check" aria-label={t('checkTitle')}>
      <header className="doc-check-head">
        <span className="doc-check-title">{t('checkTitle')}</span>
        <button
          type="button"
          className="doc-check-close"
          onClick={onClose}
          aria-label={t('dismiss')}
        >
          <IconClose size={14} />
        </button>
      </header>

      <div className="doc-check-body">
        {busy && <p className="doc-check-note">{t('checkRunning')}</p>}
        {!busy && failed && (
          <p className="doc-check-note doc-check-failed" role="alert">
            {t('checkFailed')}
          </p>
        )}
        {!busy && !failed && result && (
          <>
            <div className="doc-check-summary">
              {(['violation', 'check', 'suggestion'] as const).map((severity) =>
                result.counts[severity] > 0 ? (
                  <span key={severity} className={`doc-check-badge ${severity}`}>
                    {severityLabel(severity)} {result.counts[severity]}
                  </span>
                ) : null,
              )}
            </div>
            {result.findings.length === 0 && <p className="doc-check-note">{t('checkEmpty')}</p>}
            {result.findings.map((finding) => (
              <article key={finding.id} className="doc-check-finding">
                <div className="doc-check-finding-head">
                  <span className={`doc-check-badge ${finding.severity}`}>
                    {severityLabel(finding.severity)}
                  </span>
                  <strong className="doc-check-finding-title">{finding.title}</strong>
                  <span className="doc-check-count">{finding.count}</span>
                </div>
                <p className="doc-check-why">{finding.why}</p>
                {finding.detail && <p className="doc-check-detail">{finding.detail}</p>}
                {finding.id === 'font.hangul-only' ? (
                  <div className="doc-check-fonts">
                    {finding.places.map((place, index) => (
                      <div key={`${finding.id}-${index}`} className="doc-check-font">
                        <button
                          type="button"
                          className="doc-check-place"
                          onClick={() => goTo(place)}
                        >
                          {place.label}
                        </button>
                        <button
                          type="button"
                          className="doc-check-fix"
                          disabled={fixing !== null || aiHeld}
                          onClick={() => void replaceFont(place.label)}
                        >
                          {t('checkReplaceWith', { font: REPLACEMENT_FONT })}
                        </button>
                      </div>
                    ))}
                    {aiHeld && (
                      <p className="doc-check-note" role="status">
                        {t('checkAiRunning')}
                      </p>
                    )}
                  </div>
                ) : (
                  finding.places.length > 0 && (
                    <div className="doc-check-places">
                      {finding.places.slice(0, MAX_SHOWN_PLACES).map((place, index) => (
                        <button
                          key={`${finding.id}-${index}`}
                          type="button"
                          className="doc-check-place"
                          onClick={() => goTo(place)}
                        >
                          {place.label || `${place.anchor.para + 1}`}
                        </button>
                      ))}
                      {finding.places.length > MAX_SHOWN_PLACES && (
                        <span className="doc-check-note">
                          {t('checkMorePlaces', {
                            count: finding.places.length - MAX_SHOWN_PLACES,
                          })}
                        </span>
                      )}
                    </div>
                  )
                )}
              </article>
            ))}
            {result.truncated && <p className="doc-check-note">{t('checkTruncated')}</p>}
            <p className="doc-check-source">{t('checkSource')}</p>
          </>
        )}
      </div>

      <footer className="doc-check-foot">
        <label className="doc-check-extra">
          <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} />
          <span>{t('checkShowAll')}</span>
        </label>
        {onHandOff && result && result.findings.length > 0 && (
          <button type="button" className="doc-check-again" onClick={handOff} disabled={busy}>
            {t('checkAskAi')}
          </button>
        )}
        <button
          type="button"
          className="doc-check-again"
          disabled={busy}
          onClick={() => void run()}
        >
          {t('checkAgain')}
        </button>
      </footer>
      {handedOff && <p className="doc-check-hint">{t('checkHandedOff')}</p>}
    </section>
  )
}

/**
 * What the panel hands to the AI: the findings, then the rules it must not break. The
 * user reads it in the input box and sends it themselves.
 */
function requestFor(result: AuditResult): string {
  const lines = [
    '문서 점검에서 걸린 항목을 골라 고쳐 주세요. 위에서부터 차례대로 처리해 주세요.',
    '',
  ]
  for (const finding of result.findings) {
    const places = finding.places
      .slice(0, 3)
      .map((place) => place.label)
      .filter((label) => label !== '')
    lines.push(
      `- [${finding.title}] ${finding.count}곳${places.length > 0 ? `: ${places.join(', ')}` : ''}`,
    )
  }
  lines.push(
    '',
    '지킬 것:',
    '- 표를 지우거나 칸을 합치지 마세요. 표 안의 표와 병합은 내용이 사라질 수 있으니 짚어만 주세요.',
    '- 글꼴은 replace_font로 바꾸고, 제목·번호는 문단을 넣거나 글자를 고쳐서 맞춰 주세요.',
    '- 고친 뒤에 무엇을 바꿨는지 한 줄씩 알려 주세요.',
  )
  return lines.join('\n')
}
