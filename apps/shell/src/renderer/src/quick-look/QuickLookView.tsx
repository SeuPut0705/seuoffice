import React, { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type {
  QuickLookDocBlock,
  QuickLookMindmapSheet,
  QuickLookPayload,
  QuickLookSheet,
  QuickLookSlide,
} from '../../../shared/quick-look-api'
import { quickLookText } from '../i18n/strings-quick-look'

export interface QuickLookViewProps {
  lang: Lang
  payload: QuickLookPayload | null
  loading?: boolean
  standalone?: boolean
  closing?: boolean
  navDirection?: 'up' | 'down' | 'none'
  canPrev?: boolean
  canNext?: boolean
  onPrev?: () => void
  onNext?: () => void
  onOpenInEditor: () => void
  onRevealInFolder: () => void
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

function colName(index: number): string {
  let n = index
  let label = ''
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

function SheetsBody({ sheets }: { sheets: QuickLookSheet[] }): React.JSX.Element {
  const [activeIdx, setActiveIdx] = useState(0)
  const safeIdx = activeIdx < sheets.length ? activeIdx : 0
  const sheet = sheets[safeIdx]
  if (!sheet) return <div />
  const colCount = sheet.rows.reduce((max, r) => Math.max(max, r.length), 1)

  return (
    <div>
      {sheets.length > 1 && (
        <div className="ql-tabs" style={{ marginBottom: 10 }}>
          {sheets.map((s, idx) => (
            <button
              key={`${s.name}-${idx}`}
              type="button"
              className={`ql-tab ${idx === safeIdx ? 'ql-tab-active' : ''}`}
              onClick={() => setActiveIdx(idx)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="ql-table-wrap">
        <table className="ql-table">
          <thead>
            <tr>
              <th className="ql-table-rownum">#</th>
              {Array.from({ length: colCount }, (_, c) => (
                <th key={c}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rIdx) => (
              <tr key={rIdx}>
                <td className="ql-table-rownum">{rIdx + 1}</td>
                {Array.from({ length: colCount }, (_, cIdx) => (
                  <td key={cIdx} title={row[cIdx] ?? ''}>
                    {row[cIdx] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SlidesBody({
  slides,
  lang,
}: {
  slides: QuickLookSlide[]
  lang: Lang
}): React.JSX.Element {
  return (
    <div className="ql-slides">
      {slides.map((slide) => (
        <div key={slide.number} className="ql-slide-card">
          <div className="ql-slide-head">
            <span className="ql-slide-num">
              {quickLookText(lang, 'slideLabel', { n: slide.number })}
            </span>
            {slide.title && <span className="ql-slide-title">{slide.title}</span>}
          </div>
          {slide.bullets.length > 0 && (
            <ul className="ql-slide-bullets">
              {slide.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          {slide.notes.length > 0 && (
            <ul className="ql-slide-bullets">
              {slide.notes.map((n, i) => (
                <li key={`note-${i}`}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function MindmapBody({ sheets }: { sheets: QuickLookMindmapSheet[] }): React.JSX.Element {
  const [activeIdx, setActiveIdx] = useState(0)
  const safeIdx = activeIdx < sheets.length ? activeIdx : 0
  const sheet = sheets[safeIdx]
  if (!sheet) return <div />

  return (
    <div>
      {sheets.length > 1 && (
        <div className="ql-tabs" style={{ marginBottom: 10 }}>
          {sheets.map((s, idx) => (
            <button
              key={`${s.title}-${idx}`}
              type="button"
              className={`ql-tab ${idx === safeIdx ? 'ql-tab-active' : ''}`}
              onClick={() => setActiveIdx(idx)}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}
      <div className="ql-mindmap">
        {sheet.nodes.map((node, i) => (
          <div
            key={i}
            className="ql-mindmap-node"
            data-depth={Math.min(node.depth, 3)}
            style={{ paddingLeft: `${node.depth * 18 + 6}px` }}
          >
            <span className="ql-mindmap-dot" />
            <span>{node.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DocBlocksBody({ blocks }: { blocks: QuickLookDocBlock[] }): React.JSX.Element {
  return (
    <div className="ql-doc">
      {blocks.map((block, idx) => {
        if (block.kind === 'heading') {
          const level = block.level ?? 1
          if (level <= 1) {
            return (
              <h1 key={idx} className="ql-doc-h1">
                {block.text}
              </h1>
            )
          }
          if (level === 2) {
            return (
              <h2 key={idx} className="ql-doc-h2">
                {block.text}
              </h2>
            )
          }
          return (
            <h3 key={idx} className="ql-doc-h3">
              {block.text}
            </h3>
          )
        }
        if (block.kind === 'bullet') {
          return (
            <ul key={idx} className="ql-doc-ul">
              <li>{block.text}</li>
            </ul>
          )
        }
        if (block.kind === 'table' && block.rows) {
          return (
            <div key={idx} className="ql-table-wrap">
              <table className="ql-table">
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) =>
                        rIdx === 0 ? (
                          <th key={cIdx}>{cell}</th>
                        ) : (
                          <td key={cIdx}>{cell}</td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre key={idx} className="ql-doc-code">
              {block.text}
            </pre>
          )
        }
        return (
          <p key={idx} className="ql-doc-p">
            {block.text}
          </p>
        )
      })}
    </div>
  )
}

export function QuickLookView({
  lang,
  payload,
  loading = false,
  standalone = false,
  closing = false,
  navDirection = 'none',
  canPrev = false,
  canNext = false,
  onPrev,
  onNext,
  onOpenInEditor,
  onRevealInFolder,
  onClose,
}: QuickLookViewProps): React.JSX.Element {
  const [viewTab, setViewTab] = useState<'content' | 'thumbnail'>('content')

  useEffect(() => {
    // Default to content view unless the file only has a thumbnail or is an image.
    if (!payload) return
    const hasStructured =
      Boolean(payload.sheets?.length) ||
      Boolean(payload.slides?.length) ||
      Boolean(payload.mindmap?.length) ||
      Boolean(payload.docBlocks?.length) ||
      Boolean(payload.plainText?.trim())
    if (payload.thumbnailDataUrl && !hasStructured) {
      setViewTab('thumbnail')
    } else {
      setViewTab('content')
    }
  }, [payload?.path, payload?.mtimeMs])

  const extLabel = (payload?.ext || payload?.family || 'FILE').toUpperCase()
  const metaParts: string[] = []
  if (payload && payload.sizeBytes > 0) {
    metaParts.push(formatBytes(payload.sizeBytes))
  }
  if (payload?.sheets?.length) {
    metaParts.push(quickLookText(lang, 'sheetCount', { n: payload.sheets.length }))
  } else if (payload?.slides?.length) {
    metaParts.push(quickLookText(lang, 'slideCount', { n: payload.slides.length }))
  } else if (payload?.plainText) {
    const lines = payload.plainText.split('\n').length
    metaParts.push(quickLookText(lang, 'lineCount', { n: lines }))
  }

  const hasBothThumbAndContent =
    payload?.ok &&
    payload.family !== 'image' &&
    Boolean(payload.thumbnailDataUrl) &&
    (Boolean(payload.sheets?.length) ||
      Boolean(payload.slides?.length) ||
      Boolean(payload.mindmap?.length) ||
      Boolean(payload.docBlocks?.length) ||
      Boolean(payload.plainText?.trim()))

  const contentStageKey = payload
    ? `${payload.path}:${payload.mtimeMs}:${viewTab}`
    : 'loading'

  function renderBody(): React.JSX.Element {
    if (loading || !payload) {
      return (
        <div className="ql-state">
          <span className="ql-spinner" aria-hidden="true" />
          <div>{quickLookText(lang, 'loading')}</div>
        </div>
      )
    }
    if (!payload.ok) {
      const msgKey =
        payload.error === 'encrypted'
          ? 'encrypted'
          : payload.error === 'unsupported'
            ? 'unsupported'
            : 'failed'
      return (
        <div className="ql-state">
          <div>{quickLookText(lang, msgKey)}</div>
          <button type="button" className="ql-btn ql-btn-primary" onClick={onOpenInEditor}>
            {quickLookText(lang, 'openInEditor')}
          </button>
        </div>
      )
    }

    if (payload.family === 'image' && payload.thumbnailDataUrl) {
      return (
        <div className="ql-image-wrap">
          <img className="ql-image" src={payload.thumbnailDataUrl} alt={payload.name} />
        </div>
      )
    }

    if (viewTab === 'thumbnail' && payload.thumbnailDataUrl) {
      return (
        <div className="ql-image-wrap">
          <img className="ql-image" src={payload.thumbnailDataUrl} alt={payload.name} />
        </div>
      )
    }

    if (payload.sheets && payload.sheets.length > 0) {
      return <SheetsBody sheets={payload.sheets} />
    }
    if (payload.slides && payload.slides.length > 0) {
      return <SlidesBody slides={payload.slides} lang={lang} />
    }
    if (payload.mindmap && payload.mindmap.length > 0) {
      return <MindmapBody sheets={payload.mindmap} />
    }
    if (payload.docBlocks && payload.docBlocks.length > 0) {
      return <DocBlocksBody blocks={payload.docBlocks} />
    }
    if (payload.plainText && payload.plainText.trim()) {
      return <pre className="ql-doc-code">{payload.plainText}</pre>
    }
    if (payload.thumbnailDataUrl) {
      return (
        <div className="ql-image-wrap">
          <img className="ql-image" src={payload.thumbnailDataUrl} alt={payload.name} />
        </div>
      )
    }

    return <div className="ql-state">{quickLookText(lang, 'empty')}</div>
  }

  const rootClass = [
    standalone ? 'ql-standalone' : 'ql-modal',
    closing ? 'ql-closing' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={rootClass}
      role="dialog"
      aria-modal="true"
      aria-label={payload?.name || quickLookText(lang, 'windowTitle')}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`ql-header ${standalone ? 'ql-header-draggable' : ''}`}>
        <div className="ql-title-group">
          <span className="ql-badge" data-kind={payload?.family ?? 'docx'}>
            {extLabel}
          </span>
          <div className="ql-title-text">
            <div className="ql-filename" title={payload?.path ?? ''}>
              {payload?.name || quickLookText(lang, 'windowTitle')}
            </div>
            {metaParts.length > 0 && <div className="ql-meta">{metaParts.join(' · ')}</div>}
          </div>
        </div>
        <div className="ql-actions">
          {(onPrev || onNext) && (
            <>
              <button
                type="button"
                className="ql-btn ql-btn-icon"
                disabled={!canPrev}
                onClick={onPrev}
                title={quickLookText(lang, 'prevFile')}
                aria-label={quickLookText(lang, 'prevFile')}
              >
                ↑
              </button>
              <button
                type="button"
                className="ql-btn ql-btn-icon"
                disabled={!canNext}
                onClick={onNext}
                title={quickLookText(lang, 'nextFile')}
                aria-label={quickLookText(lang, 'nextFile')}
              >
                ↓
              </button>
            </>
          )}
          <button type="button" className="ql-btn" onClick={onRevealInFolder}>
            {quickLookText(lang, 'revealInFolder')}
          </button>
          <button type="button" className="ql-btn ql-btn-primary" onClick={onOpenInEditor}>
            {quickLookText(lang, 'openInEditor')}
          </button>
          <button
            type="button"
            className="ql-btn ql-btn-icon"
            onClick={onClose}
            title={quickLookText(lang, 'close')}
            aria-label={quickLookText(lang, 'close')}
          >
            ✕
          </button>
        </div>
      </div>

      {hasBothThumbAndContent && (
        <div className="ql-subbar">
          <div className="ql-tabs">
            <button
              type="button"
              className={`ql-tab ${viewTab === 'content' ? 'ql-tab-active' : ''}`}
              onClick={() => setViewTab('content')}
            >
              {quickLookText(lang, 'tabContent')}
            </button>
            <button
              type="button"
              className={`ql-tab ${viewTab === 'thumbnail' ? 'ql-tab-active' : ''}`}
              onClick={() => setViewTab('thumbnail')}
            >
              {quickLookText(lang, 'tabThumbnail')}
            </button>
          </div>
        </div>
      )}

      <div className="ql-body">
        <div key={contentStageKey} className="ql-content-stage" data-nav={navDirection}>
          {renderBody()}
        </div>
      </div>

      <div className="ql-footer">
        <span>{quickLookText(lang, 'shortcutHint')}</span>
        {payload?.truncated && (
          <span className="ql-truncated">{quickLookText(lang, 'truncated')}</span>
        )}
      </div>
    </div>
  )
}
