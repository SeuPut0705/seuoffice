import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { skillEditorsOf } from '@genoffice/agent-core/skill-editors'
import {
  SAME_NAME_ON,
  SkillEditorsChooser,
  sameNameSourcesOf,
  skillEditorsText,
  useNameFromTitle,
  type SkillEditorsDraft,
} from '@genoffice/ui'
import type { UserSkillsBridge } from '@genoffice/electron-utils/user-skills-bridge'
import type {
  UserSkillSaveInput,
  UserSkillView,
} from '@genoffice/electron-utils/user-skills-channels'
import { skillsText, type SkillsStringKey } from '../i18n/strings-skills'
import { SkillDialog } from './SkillDialog'
import {
  failureKey,
  formatSkillSize,
  nameProblemKey,
  skillDisplayDesc,
  skillDisplayTitle,
  sourceLabel,
} from './skills-model'

export type SkillEditorMode = 'view' | 'edit' | 'new'

/** wait this long after the last keystroke before asking the main process about a name */
const NAME_CHECK_DELAY_MS = 250

const TITLE_KEY: Record<SkillEditorMode, SkillsStringKey> = {
  view: 'editorView',
  edit: 'editorEdit',
  new: 'editorNew',
}

/** What the editor holds that a save would write */
interface SkillDraft {
  /** the title lists show, in any language; '' shows the name */
  title: string
  name: string
  description: string
  body: string
  editors: SkillEditorsDraft
}

function sameDraft(a: SkillDraft, b: SkillDraft): boolean {
  return (
    a.title === b.title &&
    a.name === b.name &&
    a.description === b.description &&
    a.body === b.body &&
    String(a.editors) === String(b.editors)
  )
}

/**
 * Read-only view, edit of an own skill, or a new skill (spec 5.1). The title
 * (any language; what lists show), the name (checked as it is typed),
 * description and body are edited here; the other files are listed and
 * changed in the folder. A new skill's name follows its title until the
 * person types a name. A name an enabled skill of another source has is
 * asked about before the save. Whatever keeps Save off because of the name
 * is said under the name field. Escape, a click outside and Cancel all ask
 * before they throw away something typed or changed. A builtin's view shows
 * its description in the UI language, as the list does; its body is the text
 * the AI is given, as written. `toWhereUsed` opens on the where-used chooser.
 */
export function SkillEditor({
  api,
  mode,
  view,
  toWhereUsed = false,
  lang,
  locale,
  onClose,
  onSaved,
}: {
  api: UserSkillsBridge
  mode: SkillEditorMode
  view?: UserSkillView | undefined
  /** the person asked for "where it is used": bring its chooser into view and focus it */
  toWhereUsed?: boolean | undefined
  lang: Lang
  locale: string
  onClose: () => void
  onSaved: () => void
}) {
  const s = (key: SkillsStringKey, params?: Record<string, string | number>) =>
    skillsText(lang, key, params)
  const readOnly = mode === 'view'
  const [loading, setLoading] = useState(mode !== 'new')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [title, setTitle] = useState('')
  const [name, setName] = useState('')
  /** a new skill's name follows its title until the person types in the name field */
  const [nameFollows, setNameFollows] = useState(mode === 'new')
  /** the sources of enabled skills that have this name, once a save was refused for them */
  const [sameNameOn, setSameNameOn] = useState<string | null>(null)
  const [originalName, setOriginalName] = useState('')
  const [files, setFiles] = useState<Array<{ rel: string; size: number }>>([])
  const [nameProblem, setNameProblem] = useState<string | null>(null)
  const [checkingName, setCheckingName] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  /** where the skill is used: an own skill's file value (saved with it), else the list's */
  const [editors, setEditors] = useState<SkillEditorsDraft>(
    () => skillEditorsOf(view?.editors) ?? 'all',
  )
  const [editorsFailed, setEditorsFailed] = useState(false)
  /** what the dialog started from: empty for a new skill, the skill as read for an edit */
  const [started, setStarted] = useState<SkillDraft>({
    title: '',
    name: '',
    description: '',
    body: '',
    editors: 'all',
  })
  /** the "discard what you typed?" question is showing */
  const [asking, setAsking] = useState(false)
  const viewId = view?.id
  /** a skill the person cannot edit: its where-used choice goes to the settings file at once */
  const choosesInSettings = readOnly && !!view && !view.can.edit && !view.unreadable
  const whereUsed = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toWhereUsed || loading) return
    const chooser = whereUsed.current
    chooser?.scrollIntoView?.({ block: 'center' })
    // the mode that is on: every editor, or only the checked ones
    chooser?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus()
  }, [toWhereUsed, loading])

  useEffect(() => {
    if (mode === 'new' || !viewId) return
    let live = true
    void api.read(viewId).then((answer) => {
      if (!live) return
      setLoading(false)
      if (!answer.ok) {
        setErrorKey(failureKey(answer.reason) ?? 'failGeneric')
        return
      }
      const { skill } = answer
      // a skill without a title is listed by its name: its title field is empty
      const fileTitle = skill.title !== skill.name ? skill.title : ''
      setTitle(fileTitle)
      setDescription(skill.description)
      setBody(skill.body)
      setName(skill.name)
      setOriginalName(skill.name)
      setFiles(skill.files)
      const fileEditors: SkillEditorsDraft = skillEditorsOf(skill.editors) ?? 'all'
      if (mode === 'edit') {
        setEditors(fileEditors)
        setStarted({
          title: fileTitle,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          editors: fileEditors,
        })
      }
    })
    return () => {
      live = false
    }
  }, [api, mode, viewId])

  const nameChanged = mode === 'edit' ? name !== originalName : name.trim() !== ''

  useNameFromTitle({
    title,
    follows: nameFollows && !readOnly,
    name,
    suggest: (text) => api.suggestName(text),
    onName: (next) => {
      setSameNameOn(null)
      setName(next)
    },
  })

  useEffect(() => {
    if (readOnly || !nameChanged) {
      setNameProblem(null)
      setCheckingName(false)
      return
    }
    let live = true
    setCheckingName(true)
    const handle = setTimeout(() => {
      void api.checkName(name, viewId).then((answer) => {
        if (!live) return
        setCheckingName(false)
        setNameProblem(answer.ok ? null : answer.problem)
      })
    }, NAME_CHECK_DELAY_MS)
    return () => {
      live = false
      clearTimeout(handle)
    }
  }, [api, readOnly, nameChanged, name, viewId])

  const canSave =
    !readOnly &&
    !loading &&
    !saving &&
    !checkingName &&
    !nameProblem &&
    name.trim() !== '' &&
    description.trim() !== '' &&
    body.trim() !== '' &&
    (editors === 'all' || editors.length > 0)

  const save = async (turnOffSameName = false) => {
    if (!canSave) return
    const input: UserSkillSaveInput = { title: title.trim(), description, body, editors }
    if (mode === 'edit' && viewId) input.id = viewId
    if (nameChanged) input.name = name.trim()
    if (turnOffSameName) input.turnOffSameName = true
    setSaving(true)
    setErrorKey(null)
    const answer = await api.save(input)
    setSaving(false)
    if (answer.ok) {
      onSaved()
      return
    }
    // an enabled skill of another source has the name: ask before taking its place
    if (answer.reason === SAME_NAME_ON) setSameNameOn(answer.problem ?? '')
    else setErrorKey(failureKey(answer.reason) ?? 'failGeneric')
  }
  const sameNameSources =
    sameNameOn === null
      ? ''
      : sameNameSourcesOf(sameNameOn)
          .map((from) => sourceLabel(from, s))
          .filter(Boolean)
          .join(', ')

  const chooseInSettings = (next: SkillEditorsDraft) => {
    setEditors(next)
    setEditorsFailed(false)
    if (!viewId || (next !== 'all' && next.length === 0)) return
    void api.setState(viewId, { editors: next }).then((answer) => {
      if (!answer.ok) setEditorsFailed(true)
    })
  }

  const label = s(TITLE_KEY[mode])
  const heading = view ? skillDisplayTitle(view) : ''
  const builtinView = readOnly && view?.source === 'builtin'
  const unsaved =
    !readOnly && !loading && !sameDraft(started, { title, name, description, body, editors })
  // an empty name keeps Save off: say so once something was typed, unless the
  // title is about to fill the name in
  const nameMissing = unsaved && name.trim() === '' && !(nameFollows && title.trim() !== '')
  const nameReason: SkillsStringKey | null = nameProblem
    ? nameProblemKey(nameProblem)
    : nameMissing
      ? 'nameEmpty'
      : null
  const closeUnlessUnsaved = () => {
    if (unsaved) setAsking(true)
    else onClose()
  }

  return (
    <SkillDialog
      label={label}
      onCancel={closeUnlessUnsaved}
      footer={
        readOnly ? (
          <button type="button" className="set-btn" onClick={onClose}>
            {s('close')}
          </button>
        ) : asking ? (
          <div className="skl-confirm skl-discard" role="alertdialog" aria-label={s('discardAsk')}>
            <span className="set-field-desc">{s('discardAsk')}</span>
            <div className="skl-confirm-actions">
              <button type="button" className="set-btn" autoFocus onClick={() => setAsking(false)}>
                {s('discardKeep')}
              </button>
              <button type="button" className="set-btn danger" onClick={onClose}>
                {s('discardClose')}
              </button>
            </div>
          </div>
        ) : sameNameOn !== null ? (
          <div className="skl-confirm" role="alertdialog" aria-label={s('saveTurnOff')}>
            <span className="set-field-desc" data-skill-same-name="">
              {s('sameNameOn', { sources: sameNameSources })}
            </span>
            <div className="skl-confirm-actions">
              <button
                type="button"
                className="set-btn"
                autoFocus
                onClick={() => setSameNameOn(null)}
              >
                {s('cancel')}
              </button>
              <button
                type="button"
                className="set-btn primary"
                disabled={!canSave}
                onClick={() => void save(true)}
              >
                {s('saveTurnOff')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="set-btn" onClick={closeUnlessUnsaved}>
              {s('cancel')}
            </button>
            <button
              type="button"
              className="set-btn primary"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {s('save')}
            </button>
          </>
        )
      }
    >
      {heading && mode !== 'new' && <div className="skl-editor-heading">{heading}</div>}
      {mode === 'new' && <p className="set-field-desc skl-editor-hint">{s('createHint')}</p>}
      {loading ? (
        <p className="set-field-desc">{s('loading')}</p>
      ) : (
        <>
          {!readOnly && (
            <label className="skl-field">
              <span className="skl-field-label">{s('fieldTitle')}</span>
              <input
                className="skl-input"
                data-field="title"
                value={title}
                dir="auto"
                onChange={(e) => setTitle(e.target.value)}
              />
              <span className="set-field-desc">{s('titleHint')}</span>
            </label>
          )}
          {!readOnly && (
            <label className="skl-field">
              <span className="skl-field-label">{s('fieldName')}</span>
              <input
                className="skl-input"
                data-field="name"
                value={name}
                spellCheck={false}
                dir="ltr"
                aria-invalid={nameReason ? true : undefined}
                onChange={(e) => {
                  setNameFollows(false)
                  setSameNameOn(null)
                  setName(e.target.value)
                }}
              />
              <span
                className={`set-field-desc${nameReason ? ' skl-error' : ''}`}
                data-skill-name-note={nameReason ? 'problem' : 'hint'}
              >
                {s(nameReason ?? 'nameHint')}
              </span>
            </label>
          )}
          <label className="skl-field">
            <span className="skl-field-label">{s('fieldDescription')}</span>
            <textarea
              className="skl-input skl-textarea-short"
              rows={2}
              value={builtinView && view ? skillDisplayDesc(view, lang) : description}
              readOnly={readOnly}
              onChange={(e) => setDescription(e.target.value)}
            />
            {!readOnly && <span className="set-field-desc">{s('fieldDescriptionHint')}</span>}
          </label>
          <label className="skl-field">
            <span className="skl-field-label">{s('fieldBody')}</span>
            {builtinView && (
              <span className="set-field-desc" data-skill-body-note="">
                {s('builtinBodyNote')}
              </span>
            )}
            <textarea
              className="skl-input skl-textarea-body"
              rows={12}
              value={body}
              readOnly={readOnly}
              spellCheck={false}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>

          {(!readOnly || choosesInSettings) && (
            <div className="skl-field" ref={whereUsed}>
              <SkillEditorsChooser
                lang={lang}
                value={editors}
                onChange={readOnly ? chooseInSettings : setEditors}
                disabled={saving}
                note={readOnly ? skillEditorsText(lang, 'settingsNote') : undefined}
              />
              {editorsFailed && (
                <span className="set-field-desc skl-error" role="alert">
                  {skillEditorsText(lang, 'changeFailed')}
                </span>
              )}
            </div>
          )}

          {readOnly && heading !== name && (
            <div className="skl-field">
              <span className="skl-field-label">{s('fieldName')}</span>
              <code className="skl-name">{name}</code>
            </div>
          )}

          {mode !== 'new' && (
            <div className="skl-field">
              <span className="skl-field-label">{s('files')}</span>
              {files.length === 0 ? (
                <span className="set-field-desc">{s('filesNone')}</span>
              ) : (
                <ul className="skl-files">
                  {files.map((file) => (
                    <li key={file.rel}>
                      <code>{file.rel}</code>
                      <span className="set-field-desc">{formatSkillSize(file.size, locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {view?.can.openFolder && (
                <div className="skl-files-actions">
                  {mode === 'edit' && <span className="set-field-desc">{s('filesHint')}</span>}
                  <button
                    type="button"
                    className="set-btn"
                    onClick={() => void api.openFolder(view.id)}
                  >
                    {s('actOpenFolder')}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {errorKey && (
        <p className="set-field-desc skl-error" role="alert">
          {s(errorKey)}
        </p>
      )}
    </SkillDialog>
  )
}
