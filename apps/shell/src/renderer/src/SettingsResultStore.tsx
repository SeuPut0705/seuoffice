import { useCallback, useEffect, useState } from 'react'
import type { ResultStoreApi } from '../../shared/result-store-api'
import { useI18n } from './locale'

declare global {
  interface Window {
    aiOfficeResultStore?: ResultStoreApi
  }
}

// the same unit symbols in every language, like the file sizes on the home screen
const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** bytes in the largest unit that keeps the number at least 1, e.g. "1.5 MB" */
export function formatStoreSize(bytes: number, locale: string): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const options: Intl.NumberFormatOptions = { maximumFractionDigits: unit === 0 ? 0 : 1 }
  let number: string
  try {
    number = new Intl.NumberFormat(locale, options).format(value)
  } catch {
    number = new Intl.NumberFormat('en-US', options).format(value)
  }
  return `${number} ${UNITS[unit]}`
}

/**
 * Settings → General: the PDF result store (AI-read pages and translations
 * kept on this PC until the user deletes them, spec §6). Shows its size and
 * deletes all of it only after the user confirms below the row.
 */
export function ResultStoreField() {
  const { t, dateLocale } = useI18n()
  const [size, setSize] = useState<number | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    const api = window.aiOfficeResultStore
    if (!api) return
    try {
      setSize(await api.size())
    } catch {
      setSize(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const deleteAll = async () => {
    const api = window.aiOfficeResultStore
    if (!api) return
    setAsking(false)
    setBusy(true)
    setFailed(false)
    try {
      await api.deleteAll()
    } catch {
      setFailed(true)
    }
    await refresh()
    setBusy(false)
  }

  const sizeText = size === null ? '—' : formatStoreSize(size, dateLocale)

  return (
    <>
      <div className="set-field" data-testid="result-store">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('setResultStore')}</div>
            <div className="set-field-desc">{t('setResultStoreDesc', { size: sizeText })}</div>
          </div>
        </div>
        <button
          className="set-btn danger"
          disabled={busy || asking || size === 0}
          onClick={() => {
            setFailed(false)
            setAsking(true)
          }}
        >
          {t('setResultStoreDeleteAll')}
        </button>
      </div>
      {asking && (
        <div
          className="set-adv-confirm"
          role="alertdialog"
          aria-label={t('setResultStoreDeleteAll')}
        >
          <div className="set-field-desc set-adv-warning">{t('setResultStoreConfirm')}</div>
          <div className="set-btn-row">
            <button className="set-btn" onClick={() => setAsking(false)}>
              {t('cancel')}
            </button>
            <button className="set-btn danger" onClick={() => void deleteAll()}>
              {t('setResultStoreDeleteAll')}
            </button>
          </div>
        </div>
      )}
      {failed && (
        <div className="set-sub-failed" role="alert">
          <span>{t('setResultStoreDeleteFailed')}</span>
        </div>
      )}
    </>
  )
}
