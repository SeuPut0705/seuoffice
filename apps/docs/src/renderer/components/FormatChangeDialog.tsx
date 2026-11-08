import { useEffect, useRef, useState } from 'react'
import type { ReportItem } from '@genoffice/odt-engine'
import { useI18n } from '../i18n/locale'
import { useModalKeys } from './modal-keys'
import {
  REPORT_FEATURE_KEYS,
  setFormatChangeHost,
  type FormatChangeRequest,
} from './format-change-bus'

type Pending = { request: FormatChangeRequest; answer: (confirmed: boolean) => void }

/**
 * Save As to the other format: lists what changes and what is left out
 * (by feature), and saves only on confirmation. Mounted once by App; the save
 * flow asks through confirmFormatChange.
 */
export function FormatChangeHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  useEffect(() => {
    setFormatChangeHost((request, answer) => {
      // a newer request supersedes an unanswered one (never left hanging)
      pendingRef.current?.answer(false)
      pendingRef.current = { request, answer }
      setPending(pendingRef.current)
    })
    return () => {
      setFormatChangeHost(null)
      pendingRef.current?.answer(false)
      pendingRef.current = null
    }
  }, [])
  if (!pending) return null
  const close = (confirmed: boolean) => {
    if (pendingRef.current === pending) pendingRef.current = null
    pending.answer(confirmed)
    setPending(null)
  }
  return <FormatChangeDialog request={pending.request} onClose={close} />
}

function FormatChangeDialog({
  request,
  onClose,
}: {
  request: FormatChangeRequest
  onClose: (confirmed: boolean) => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(() => onClose(false))
  const list = (kind: ReportItem['kind']) =>
    request.report
      .filter((item) => item.kind === kind)
      .map((item) => (
        <li key={item.feature}>
          {t('appFormatChangeItem', {
            name: t(REPORT_FEATURE_KEYS[item.feature]),
            count: item.count,
          })}
        </li>
      ))
  const converted = list('converted')
  const dropped = list('dropped')
  return (
    <div
      className="modal-backdrop"
      ref={modalKeys.ref}
      onKeyDown={modalKeys.onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{t(request.to === 'odt' ? 'appFormatChangeTitleOdt' : 'appFormatChangeTitleDocx')}</h2>
        <p>{t('appFormatChangeBody')}</p>
        {converted.length > 0 && (
          <section className="format-change-group">
            <h3>{t('appFormatChangeConverted')}</h3>
            <ul>{converted}</ul>
          </section>
        )}
        {dropped.length > 0 && (
          <section className="format-change-group">
            <h3>{t('appFormatChangeDropped')}</h3>
            <ul>{dropped}</ul>
          </section>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => onClose(false)}>
            {t('appCancel')}
          </button>
          <button className="btn-primary" onClick={() => onClose(true)}>
            {t('appFormatChangeConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
