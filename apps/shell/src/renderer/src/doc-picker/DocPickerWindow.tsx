import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type {
  DocItemGroup,
  DocItemState,
  DocListItem,
  DocPickerApi,
} from '../../../shared/doc-picker-api'
import { docPickerText, type DocPickerStringKey } from '../i18n/strings-doc-picker'

/** How many documents one attach may carry (the plan caps the picker here) */
export const DOC_PICK_MAX = 20

/** the groups in the order they are shown: the other split pane, open documents, recent ones */
export const DOC_PICK_GROUPS: ReadonlyArray<{ group: DocItemGroup; label: DocPickerStringKey }> = [
  { group: 'pane', label: 'docPickPane' },
  { group: 'open', label: 'docPickOpen' },
  { group: 'recent', label: 'docPickRecent' },
]

/** why a row cannot be picked; null for a row that can */
export function docPickReason(state: DocItemState): DocPickerStringKey | null {
  switch (state) {
    case 'missing':
      return 'docPickMissing'
    case 'unsaved':
      return 'docPickUnsaved'
    case 'modified':
      return 'docPickModified'
    case 'ok':
      return null
  }
}

/**
 * Tick the documents the shell offers (the other split pane, open tabs, recent
 * files), then attach them to the AI panel that asked. The window deals in ids
 * only (a saved document's id is its path; the shell accepts only ids it
 * just listed, decision 0051).
 */
export function DocPickerWindow({ lang, api }: { lang: Lang; api: DocPickerApi }) {
  const t = (key: DocPickerStringKey, params?: Record<string, string>) =>
    docPickerText(lang, key, params)
  const [items, setItems] = useState<DocListItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<DocPickerStringKey | null>(null)

  useEffect(() => {
    let alive = true
    void api
      .list()
      .then((result) => {
        if (!alive) return
        if (result.ok) setItems(result.items)
        else setUnavailable(true)
        setLoaded(true)
      })
      .catch(() => {
        if (!alive) return
        setUnavailable(true)
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [api])

  const toggle = (item: DocListItem) => {
    // a document that cannot be attached is not ticked; say why instead
    const reason = docPickReason(item.state)
    if (reason) {
      setNotice(reason)
      return
    }
    if (!selected.has(item.id) && selected.size >= DOC_PICK_MAX) {
      setNotice('docPickLimit')
      return
    }
    setNotice(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }

  const attach = async () => {
    setWorking(true)
    setNotice(null)
    const result = await api.choose([...selected]).catch(() => null)
    // on success main closes this window
    if (!result || !result.ok) {
      setWorking(false)
      setNotice('docPickUnavailable')
    }
  }

  return (
    <div className="dp">
      <div className="dp-body">
        {!loaded ? null : unavailable ? (
          <p className="doc-note">{t('docPickUnavailable')}</p>
        ) : items.length === 0 ? (
          <p className="doc-note">{t('docPickEmpty')}</p>
        ) : (
          DOC_PICK_GROUPS.map(({ group, label }) => {
            const inGroup = items.filter((item) => item.group === group)
            if (inGroup.length === 0) return null
            return (
              <section key={group} className="doc-group">
                <h2 className="doc-group-title">{t(label)}</h2>
                <ul className="doc-list">
                  {inGroup.map((item) => {
                    const picked = selected.has(item.id)
                    const reason = docPickReason(item.state)
                    const blocked = reason !== null
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={`doc-item${blocked ? ' dim' : ''}${picked ? ' picked' : ''}`}
                          onClick={() => toggle(item)}
                          disabled={working}
                          aria-disabled={blocked}
                          aria-pressed={picked}
                          title={reason ? t(reason) : undefined}
                        >
                          <span className="doc-check" aria-hidden="true">
                            {picked ? '✓' : ''}
                          </span>
                          <span className="doc-meta">
                            <span className="doc-title">{item.title}</span>
                            {item.dir ? <span className="doc-dir">{item.dir}</span> : null}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })
        )}
      </div>
      <div className="dp-foot">
        <span className="dp-count">
          {working
            ? t('docPickWorking')
            : notice
              ? t(notice)
              : t('docPickSelected', { n: String(selected.size) })}
        </span>
        <button className="doc-ghost" onClick={() => void api.cancel()} disabled={working}>
          {t('docPickCancel')}
        </button>
        <button
          className="doc-primary"
          onClick={() => void attach()}
          disabled={working || selected.size === 0}
        >
          {t('docPickAttach')}
        </button>
      </div>
    </div>
  )
}
