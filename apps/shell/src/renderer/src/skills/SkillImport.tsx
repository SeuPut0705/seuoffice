import { useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { skillNameBeside } from '@genoffice/ui'
import type { UserSkillsBridge } from '@genoffice/electron-utils/user-skills-bridge'
import {
  USER_SKILL_PREVIEW_TEXT_MAX_CHARS,
  type UserSkillCollisionChoice,
  type UserSkillImportCandidateView,
  type UserSkillImportContent,
  type UserSkillImportPreview,
  type UserSkillImportText,
} from '@genoffice/electron-utils/user-skills-channels'
import { skillsText, type SkillsStringKey } from '../i18n/strings-skills'
import { SkillDialog, useFinalCleanup } from './SkillDialog'
import { failureKey, formatSkillSize, unreadableKey } from './skills-model'

type Text = (key: SkillsStringKey, params?: Record<string, string | number>) => string

export interface SkillsNotice {
  tone: 'ok' | 'error'
  text: string
}

/** The sentence spec 5.2 shows under every preview, never hidden */
export function PreviewWarning({ lang }: { lang: Lang }) {
  return (
    <p className="skl-preview-warning" role="note">
      {skillsText(lang, 'previewWarning')}
    </p>
  )
}

/** What a found skill holds: size, scripts, web addresses, license */
export function CandidateSummary({
  candidate,
  text,
  locale,
}: {
  candidate: UserSkillImportCandidateView
  text: Text
  locale: string
}) {
  const c = candidate
  return (
    <div className="skl-candidate-text">
      <div className="skl-row-head">
        <span className="skl-row-title">{c.title || c.name}</span>
        {skillNameBeside(c) && <code className="skl-name">{skillNameBeside(c)}</code>}
      </div>
      {c.description && <div className="set-field-desc skl-candidate-desc">{c.description}</div>}
      <div className="skl-badges">
        <span className="skl-meta">
          {text('previewSize', { n: c.files, size: formatSkillSize(c.bytes, locale) })}
        </span>
        {c.emptyBody && (
          <span className="skl-badge" data-empty-body="true">
            {text('previewBodyEmpty')}
          </span>
        )}
        {c.hasScripts && <span className="skl-badge">{text('previewScripts')}</span>}
        {c.license && (
          <span className="skl-meta">{text('previewLicense', { name: c.license })}</span>
        )}
      </div>
      {c.urlCount > 0 && (
        <div className="skl-urls">
          <span className="set-field-desc">{text('previewUrls', { n: c.urlCount })}</span>
          <ul>
            {c.urls.map((url) => (
              <li key={url}>
                <code>{url}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.warningCount > 0 && (
        <div className="skl-line-warnings" role="note">
          <span className="skl-line-warnings-title">
            {text('previewWarnings', { n: c.warningCount })}
          </span>
          <ul>
            {c.warnings.map((w) => (
              <li key={`${w.file}:${w.line}:${w.messageKey}`} data-warning={w.messageKey}>
                <span>{text(w.messageKey)}</span>{' '}
                <span className="set-field-desc">
                  {text('previewWarningAt', { file: w.file, line: w.line })}
                </span>
                <code dir="auto">{w.excerpt}</code>
              </li>
            ))}
          </ul>
          <span className="set-field-desc">{text('previewWarningsNote')}</span>
        </div>
      )}
    </div>
  )
}

/** Read-only text of a previewed file, with a note when it goes on past what is shown */
function PreviewText({
  shown,
  text,
  locale,
}: {
  shown: UserSkillImportText
  text: Text
  locale: string
}) {
  return (
    <>
      <pre className="skl-read-text" dir="auto" tabIndex={0}>
        {shown.text}
      </pre>
      {shown.truncated && (
        <p className="set-field-desc skl-read-more" role="note">
          {text('previewTruncated', {
            n: USER_SKILL_PREVIEW_TEXT_MAX_CHARS.toLocaleString(locale),
          })}
        </p>
      )}
    </>
  )
}

type OpenedFile = { rel: string; shown?: UserSkillImportText; errorKey?: SkillsStringKey }

/**
 * A found skill opened to read before installing (decision 0127): its
 * SKILL.md body and, one at a time, its text files. The text comes from the
 * previewed import and shows as plain text; nothing is installed by looking.
 */
export function CandidateContent({
  api,
  token,
  candidate,
  text,
  locale,
}: {
  api: Pick<UserSkillsBridge, 'readImport' | 'readImportFile'>
  token: string
  candidate: UserSkillImportCandidateView
  text: Text
  locale: string
}) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<UserSkillImportContent | null>(null)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  const [file, setFile] = useState<OpenedFile | null>(null)

  const toggle = async () => {
    setOpen((was) => !was)
    if (open || content) return
    setErrorKey(null)
    const answer = await api.readImport(token, candidate.key)
    if (answer.ok) setContent(answer.content)
    else setErrorKey(failureKey(answer.reason) ?? 'failGeneric')
  }

  const openFile = async (rel: string) => {
    if (file?.rel === rel) {
      setFile(null)
      return
    }
    setFile({ rel })
    const answer = await api.readImportFile(token, candidate.key, rel)
    setFile((was) =>
      was?.rel !== rel
        ? was
        : answer.ok
          ? { rel, shown: answer.file }
          : { rel, errorKey: failureKey(answer.reason) ?? 'failGeneric' },
    )
  }

  return (
    <div className="skl-read" data-read={candidate.key}>
      <button
        type="button"
        className="set-link skl-read-toggle"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        {text(open ? 'close' : 'actView')}
      </button>
      {open && errorKey && (
        <p className="set-field-desc skl-error" role="alert">
          {text(errorKey)}
        </p>
      )}
      {open && !errorKey && !content && <p className="set-field-desc">{text('loading')}</p>}
      {open && content && (
        <div className="skl-read-box">
          <span className="skl-field-label">SKILL.md</span>
          {content.body.text.trim() === '' ? (
            <p className="set-field-desc" data-empty-body="true">
              {text('previewBodyEmpty')}
            </p>
          ) : (
            <PreviewText shown={content.body} text={text} locale={locale} />
          )}
          {content.files.length > 0 && (
            <>
              <span className="skl-field-label">{text('files')}</span>
              <ul className="skl-files">
                {content.files.map((entry) => (
                  <li key={entry.rel}>
                    <button
                      type="button"
                      className="set-link"
                      aria-expanded={file?.rel === entry.rel}
                      onClick={() => void openFile(entry.rel)}
                    >
                      <code>{entry.rel}</code>
                    </button>
                    <span className="set-field-desc">{formatSkillSize(entry.size, locale)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {file && (
            <div className="skl-read-file" data-file={file.rel}>
              <code className="skl-name">{file.rel}</code>
              {file.errorKey && (
                <p className="set-field-desc skl-error" role="alert">
                  {text(file.errorKey)}
                </p>
              )}
              {file.shown && <PreviewText shown={file.shown} text={text} locale={locale} />}
              {!file.errorKey && !file.shown && <p className="set-field-desc">{text('loading')}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The paste step: SKILL.md text goes to the shared preview as one skill */
export function PasteImportDialog({
  api,
  lang,
  onPreview,
  onClose,
}: {
  api: Pick<UserSkillsBridge, 'importText'>
  lang: Lang
  onPreview: (preview: UserSkillImportPreview) => void
  onClose: () => void
}) {
  const s: Text = (key, params) => skillsText(lang, key, params)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)

  const find = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setErrorKey(null)
    const answer = await api.importText(value)
    setBusy(false)
    if (answer.ok) {
      onPreview(answer.preview)
      return
    }
    setErrorKey(
      answer.reason === 'no-skills'
        ? 'pasteNotSkill'
        : (failureKey(answer.reason, 'other') ?? 'failGeneric'),
    )
  }

  return (
    <SkillDialog
      label={s('pasteTitle')}
      onCancel={onClose}
      footer={
        <>
          <button type="button" className="set-btn" onClick={onClose}>
            {s('cancel')}
          </button>
          <button
            type="button"
            className="set-btn primary"
            disabled={busy || !value.trim()}
            onClick={() => void find()}
          >
            {s('pastePreview')}
          </button>
        </>
      }
    >
      <label className="skl-field">
        <span className="skl-field-label">{s('pasteLabel')}</span>
        <textarea
          className="skl-input skl-textarea-body"
          value={value}
          spellCheck={false}
          disabled={busy}
          placeholder={'---\nname: \ndescription: \n---\n'}
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="set-field-desc">{s('pasteHint')}</span>
      </label>
      {errorKey && (
        <p className="set-field-desc skl-error" role="alert">
          {s(errorKey)}
        </p>
      )}
    </SkillDialog>
  )
}

/** The GitHub address step; a found preview goes to the shared preview */
export function GitHubImportDialog({
  api,
  lang,
  onPreview,
  onClose,
}: {
  api: Pick<UserSkillsBridge, 'importGitHub' | 'cancelImport'>
  lang: Lang
  onPreview: (preview: UserSkillImportPreview) => void
  onClose: () => void
}) {
  const s: Text = (key, params) => skillsText(lang, key, params)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  const [state] = useState(() => ({ running: false, closed: false }))

  // the settings closing mid-download stops it; the main process drops what it got
  useFinalCleanup(() => {
    state.closed = true
    if (state.running) void api.cancelImport()
  })

  const find = async () => {
    const value = address.trim()
    if (!value || busy) return
    setBusy(true)
    setErrorKey(null)
    state.running = true
    const answer = await api.importGitHub(value)
    state.running = false
    if (state.closed) {
      if (answer.ok) void api.cancelImport(answer.preview.token)
      return
    }
    setBusy(false)
    if (answer.ok) {
      onPreview(answer.preview)
      return
    }
    setErrorKey(failureKey(answer.reason, 'import') ?? null)
  }

  const cancel = () => {
    state.closed = true
    if (state.running) void api.cancelImport()
    onClose()
  }

  return (
    <SkillDialog
      label={s('githubTitle')}
      onCancel={cancel}
      footer={
        <>
          <button type="button" className="set-btn" onClick={cancel}>
            {s('cancel')}
          </button>
          <button
            type="button"
            className="set-btn primary"
            disabled={busy || !address.trim()}
            onClick={() => void find()}
          >
            {s('githubFind')}
          </button>
        </>
      }
    >
      <label className="skl-field">
        <span className="skl-field-label">{s('githubLabel')}</span>
        <input
          className="skl-input"
          value={address}
          placeholder={s('githubPlaceholder')}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void find()
          }}
        />
        <span className="set-field-desc">{s('githubHint')}</span>
      </label>
      {busy && (
        <p className="set-field-desc" role="status">
          {s('githubFetching')}
        </p>
      )}
      {errorKey && (
        <p className="set-field-desc skl-error" role="alert">
          {s(errorKey)}
        </p>
      )}
    </SkillDialog>
  )
}

function originLine(preview: UserSkillImportPreview, text: Text): string {
  const n = preview.candidates.length
  const origin = preview.origin
  if (origin.kind === 'github') {
    const ref = origin.path ? `${origin.ref}/${origin.path}` : origin.ref
    return text('previewFromGitHub', { repo: origin.repo, ref, n })
  }
  const key: Record<typeof origin.kind, SkillsStringKey> = {
    folder: 'previewFromFolder',
    zip: 'previewFromZip',
    'skill-file': 'previewFromSkillFile',
    text: 'previewFromText',
  }
  return text(key[origin.kind], { n })
}

/**
 * The one preview every import passes (spec 5.2): one checkbox per found
 * skill, its text to read before installing, a Replace/Skip choice where the
 * name is taken among the person's own skills, and the warning sentence
 * always in view. Closing without installing drops what was fetched.
 */
export function SkillImportPreviewDialog({
  api,
  preview,
  lang,
  locale,
  onDone,
  onClose,
}: {
  api: Pick<UserSkillsBridge, 'install' | 'cancelImport' | 'readImport' | 'readImportFile'>
  preview: UserSkillImportPreview
  lang: Lang
  locale: string
  onDone: (notice: SkillsNotice) => void
  onClose: () => void
}) {
  const s: Text = (key, params) => skillsText(lang, key, params)
  const installable = preview.candidates.filter((c) => !c.problem)
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(installable.map((c) => c.key)),
  )
  const [choices, setChoices] = useState<Record<string, UserSkillCollisionChoice>>({})
  const [installing, setInstalling] = useState(false)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  const [state] = useState(() => ({ settled: false }))

  useFinalCleanup(() => {
    if (!state.settled) void api.cancelImport(preview.token)
  })

  const selected = preview.candidates.filter((c) => !c.problem && checked.has(c.key))
  const missingChoice = selected.some((c) => c.collision && !choices[c.key])

  const toggle = (key: string) => {
    setChecked((was) => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const install = async () => {
    if (installing || selected.length === 0 || missingChoice) return
    const onCollision: Record<string, UserSkillCollisionChoice> = {}
    for (const c of selected) {
      const choice = choices[c.key]
      if (c.collision && choice) onCollision[c.key] = choice
    }
    setInstalling(true)
    setErrorKey(null)
    state.settled = true
    const answer = await api.install(
      preview.token,
      selected.map((c) => c.key),
      onCollision,
    )
    setInstalling(false)
    if (answer.ok) {
      onDone({ tone: 'ok', text: s('installed', { n: answer.installed.length }) })
      return
    }
    if (answer.reason === 'needs-choice') {
      // the main process keeps the preview for the missing answer
      state.settled = false
      setErrorKey('chooseCollision')
      return
    }
    onDone({ tone: 'error', text: s(failureKey(answer.reason, 'import') ?? 'failGeneric') })
  }

  const cancel = () => {
    state.settled = true
    void api.cancelImport(preview.token)
    onClose()
  }

  return (
    <SkillDialog
      label={s('previewTitle')}
      onCancel={cancel}
      footer={
        <>
          {missingChoice && (
            <span className="set-field-desc skl-footer-note" role="status">
              {s('chooseCollision')}
            </span>
          )}
          <button type="button" className="set-btn" onClick={cancel}>
            {s('cancel')}
          </button>
          <button
            type="button"
            className="set-btn primary"
            disabled={installing || selected.length === 0 || missingChoice}
            onClick={() => void install()}
          >
            {s('install')}
          </button>
        </>
      }
    >
      <p className="set-field-desc">{originLine(preview, s)}</p>
      {preview.rootLicense && (
        <p className="set-field-desc">{s('previewRootLicense', { name: preview.rootLicense })}</p>
      )}
      <ul className="skl-candidates">
        {preview.candidates.map((c) => {
          const isChecked = !c.problem && checked.has(c.key)
          return (
            <li
              key={c.key}
              className="skl-candidate"
              data-key={c.key}
              data-problem={c.problem ? 'true' : undefined}
            >
              <input
                type="checkbox"
                className="skl-check"
                checked={isChecked}
                disabled={!!c.problem || installing}
                aria-label={s('previewInstallLabel', { title: c.title || c.name })}
                onChange={() => toggle(c.key)}
              />
              <div className="skl-candidate-main">
                <CandidateSummary candidate={c} text={s} locale={locale} />
                {c.problem !== 'too-large' && (
                  <CandidateContent
                    api={api}
                    token={preview.token}
                    candidate={c}
                    text={s}
                    locale={locale}
                  />
                )}
                {c.problem && (
                  <div className="set-field-desc skl-error">
                    {c.problem === 'duplicate'
                      ? s('problemDuplicate')
                      : s('problemCannot', { reason: s(unreadableKey(c.problem)) })}
                  </div>
                )}
                {c.collision && isChecked && (
                  <div className="skl-collision" role="group" aria-label={s('collision')}>
                    <span className="set-field-desc">{s('collision')}</span>
                    {(['replace', 'skip'] as const).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        className={`set-btn skl-choice${choices[c.key] === choice ? ' active' : ''}`}
                        aria-pressed={choices[c.key] === choice}
                        onClick={() => setChoices((was) => ({ ...was, [c.key]: choice }))}
                      >
                        {s(choice === 'replace' ? 'collisionReplace' : 'collisionSkip')}
                      </button>
                    ))}
                    <span className="set-field-desc skl-collision-note">{s('collisionKeeps')}</span>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {errorKey && (
        <p className="set-field-desc skl-error" role="alert">
          {s(errorKey)}
        </p>
      )}
      <PreviewWarning lang={lang} />
    </SkillDialog>
  )
}
