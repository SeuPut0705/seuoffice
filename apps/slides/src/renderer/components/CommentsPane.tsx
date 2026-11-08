/**
 * Comments pane (right side) — current page's comment list + create/delete,
 * plus a read-only all-pages view. The source of truth lives in the main
 * process (the pptx comments part); this only displays and sends back intents.
 * The lists are owned by App (refreshed after page switch/add/delete), keeping
 * the ribbon badge in sync.
 */
import React, { useEffect, useRef, useState } from 'react'
import type { SlideComment } from '../../shared/ipc'
import { groupCommentsBySlide, type CommentsMode, type CommentSlideGroup } from '../comments-view'
import { useI18n } from '../i18n/locale'
import { IconComment, IconSidebarCollapse } from './icons'

interface Props {
  slideIndex: number
  comments: SlideComment[]
  /** Every page's comments in deck order (empty pages included; hidden slides too) */
  allComments: SlideComment[][]
  mode: CommentsMode
  onModeChange: (mode: CommentsMode) => void
  /** Focus the input when it changes (the "new comment" entry increments it per click) */
  focusNonce?: number
  onAdd: (text: string) => void
  onDelete: (c: SlideComment) => void
  /** Jump to a page from the all-pages list (the caller returns to page mode) */
  onGoToSlide: (slideIndex: number) => void
  onCollapse: () => void
}

/** dt (ISO) → local short time; returned as-is on parse failure. */
function fmtDt(dt: string, locale: string): string {
  const d = new Date(dt)
  if (Number.isNaN(d.getTime())) return dt
  return d.toLocaleString(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function CommentsPane({
  slideIndex,
  comments,
  allComments,
  mode,
  onModeChange,
  focusNonce,
  onAdd,
  onDelete,
  onGoToSlide,
  onCollapse,
}: Props) {
  const { t, dateLocale } = useI18n()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const allMode = mode === 'all'
  const groups: CommentSlideGroup[] = allMode ? groupCommentsBySlide(allComments) : []

  useEffect(() => {
    if (focusNonce) inputRef.current?.focus()
  }, [focusNonce])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onAdd(text)
    setDraft('')
  }

  const renderCard = (c: SlideComment, page: number, readOnly: boolean) => (
    <div
      key={`${page}-${c.authorId}-${c.idx}`}
      className={`comment-card${readOnly ? ' comment-card-link' : ''}`}
      role={readOnly ? 'button' : undefined}
      tabIndex={readOnly ? 0 : undefined}
      onClick={readOnly ? () => onGoToSlide(page) : undefined}
      onKeyDown={
        readOnly
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onGoToSlide(page)
            }
          : undefined
      }
    >
      <div className="comment-head">
        <span className="comment-avatar">{(c.initials || c.author).slice(0, 2)}</span>
        <span className="comment-meta">
          <span className="comment-author">{c.author}</span>
          {c.dt && <span className="comment-time">{fmtDt(c.dt, dateLocale)}</span>}
        </span>
        {!readOnly && (
          <button
            className="comment-del"
            data-tip={t('paneCommentsDelete')}
            aria-label={t('paneCommentsDelete')}
            onClick={() => onDelete(c)}
          >
            ✕
          </button>
        )}
      </div>
      <div className="comment-text">{c.text}</div>
    </div>
  )

  return (
    <aside className="comments-pane">
      <div className="ai-panel-header">
        <span className="ai-panel-title">{t('paneCommentsTitle', { n: slideIndex + 1 })}</span>
        <div className="ai-panel-header-actions">
          <button
            className="ai-header-btn"
            onClick={onCollapse}
            data-tip={t('paneCommentsCollapse')}
            aria-label={t('paneCommentsCollapse')}
          >
            <IconSidebarCollapse size={15} />
          </button>
        </div>
      </div>

      <div className="comments-scope" role="group">
        <button
          className={`comments-scope-btn${allMode ? '' : ' active'}`}
          aria-pressed={!allMode}
          onClick={() => onModeChange('page')}
        >
          {t('paneCommentsScopePage')}
        </button>
        <button
          className={`comments-scope-btn${allMode ? ' active' : ''}`}
          aria-pressed={allMode}
          onClick={() => onModeChange('all')}
        >
          {t('paneCommentsScopeAll')}
        </button>
      </div>

      {allMode ? (
        <div className="comments-list comments-all-list">
          {groups.length === 0 && (
            <div className="comments-empty">
              <IconComment size={22} />
              <p>{t('paneCommentsAllEmpty')}</p>
              <p className="comments-empty-sub">{t('paneCommentsAllEmptySub')}</p>
            </div>
          )}
          {groups.map((group) => (
            <section key={group.slideIndex} className="comment-group">
              <button className="comment-group-head" onClick={() => onGoToSlide(group.slideIndex)}>
                <span className="comment-group-title">
                  {t('paneCommentsPageHeading', { n: group.slideIndex + 1 })}
                </span>
                <span className="comment-group-count">
                  {t('paneCommentsPageCount', { n: group.comments.length })}
                </span>
              </button>
              {group.comments.map((c) => renderCard(c, group.slideIndex, true))}
            </section>
          ))}
        </div>
      ) : (
        <>
          <div className="comments-list">
            {comments.length === 0 && (
              <div className="comments-empty">
                <IconComment size={22} />
                <p>{t('paneCommentsEmpty')}</p>
                <p className="comments-empty-sub">{t('paneCommentsEmptySub')}</p>
              </div>
            )}
            {comments.map((c) => renderCard(c, slideIndex, false))}
          </div>

          <div className="comment-new">
            <textarea
              ref={inputRef}
              rows={3}
              value={draft}
              placeholder={t('paneCommentsPlaceholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button className="btn-primary" disabled={!draft.trim()} onClick={submit}>
              {t('paneCommentsPost')}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
