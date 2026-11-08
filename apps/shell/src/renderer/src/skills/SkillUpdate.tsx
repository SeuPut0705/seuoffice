import { useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { UserSkillsBridge } from '@genoffice/electron-utils/user-skills-bridge'
import type { UserSkillUpdateCheck } from '@genoffice/electron-utils/user-skills-channels'
import { skillsText, type SkillsStringKey } from '../i18n/strings-skills'
import { SkillDialog, useFinalCleanup } from './SkillDialog'
import { CandidateSummary, PreviewWarning, type SkillsNotice } from './SkillImport'
import { failureKey } from './skills-model'

export type ChangedUpdate = Extract<UserSkillUpdateCheck, { status: 'changed' }>

type Text = (key: SkillsStringKey, params?: Record<string, string | number>) => string

const CHANGE_KEY = {
  added: 'changeAdded',
  removed: 'changeRemoved',
  modified: 'changeModified',
} as const satisfies Record<ChangedUpdate['changedFiles'][number]['change'], SkillsStringKey>

/**
 * A GitHub skill that changed upstream (spec 5.3): the changed files, the
 * preview of the new version, and a warning when the person's own edits
 * would be replaced. Closing without updating drops the download.
 */
export function SkillUpdateDialog({
  api,
  title,
  check,
  lang,
  locale,
  onDone,
  onClose,
}: {
  api: Pick<UserSkillsBridge, 'applyUpdate' | 'cancelUpdate'>
  title: string
  check: ChangedUpdate
  lang: Lang
  locale: string
  onDone: (notice: SkillsNotice) => void
  onClose: () => void
}) {
  const s: Text = (key, params) => skillsText(lang, key, params)
  const [applying, setApplying] = useState(false)
  const [state] = useState(() => ({ settled: false }))

  useFinalCleanup(() => {
    if (!state.settled) void api.cancelUpdate(check.token)
  })

  const apply = async () => {
    if (applying) return
    setApplying(true)
    state.settled = true
    const answer = await api.applyUpdate(check.token)
    setApplying(false)
    onDone(
      answer.ok
        ? { tone: 'ok', text: s('updated') }
        : { tone: 'error', text: s(failureKey(answer.reason, 'import') ?? 'failGeneric') },
    )
  }

  const cancel = () => {
    state.settled = true
    void api.cancelUpdate(check.token)
    onClose()
  }

  return (
    <SkillDialog
      label={s('updateTitle', { title })}
      onCancel={cancel}
      footer={
        <>
          <button type="button" className="set-btn" onClick={cancel}>
            {s('cancel')}
          </button>
          <button
            type="button"
            className="set-btn primary"
            disabled={applying}
            onClick={() => void apply()}
          >
            {s('updateApply')}
          </button>
        </>
      }
    >
      <p className="set-field-desc">{s('updateIntro')}</p>
      {check.locallyEdited && (
        <p className="skl-warning" role="alert">
          {s('updateLocalEdits')}
        </p>
      )}
      <div className="skl-field">
        <span className="skl-field-label">{s('updateFiles')}</span>
        <ul className="skl-files">
          {check.changedFiles.map((file) => (
            <li key={file.rel} data-change={file.change}>
              <code>{file.rel}</code>
              <span className="skl-change">{s(CHANGE_KEY[file.change])}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="skl-candidate skl-candidate-solo">
        <CandidateSummary candidate={check.candidate} text={s} locale={locale} />
      </div>
      <PreviewWarning lang={lang} />
    </SkillDialog>
  )
}
