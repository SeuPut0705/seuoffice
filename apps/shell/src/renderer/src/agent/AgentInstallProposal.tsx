import { useEffect, useRef, useState } from 'react'
import { htmlLang, type Lang } from '@genoffice/i18n'
import type { UserSkillImportPreview } from '@genoffice/electron-utils/user-skills-channels'
import { skillsText } from '../i18n/strings-skills'
import { agentSkillsText } from '../i18n/strings-agent-skills'
import { SkillImportPreviewDialog } from '../skills/SkillImport'
import { failureKey } from '../skills/skills-model'
import type { AgentSkillsBridge } from './AgentSkillCard'
import '../skills/skills.css'

type InstallState =
  | { kind: 'proposed' }
  | { kind: 'fetching' }
  | { kind: 'preview'; preview: UserSkillImportPreview }
  | { kind: 'done'; tone: 'ok' | 'error'; text: string }
  | { kind: 'dismissed' }

/**
 * A GitHub skill a session's `propose_skill_install` proposed (spec 6.4). The
 * address is shown; GitHub is reached only when the person opens the preview,
 * and the skill is installed only by their Install in the settings' own
 * preview dialog. Closing drops what was fetched.
 */
export function AgentInstallProposal({
  lang,
  address,
  skills,
}: {
  lang: Lang
  address: string
  skills: AgentSkillsBridge
}) {
  const [state, setState] = useState<InstallState>({ kind: 'proposed' })
  const fetchingRef = useRef(false)
  useEffect(
    () => () => {
      // the window going away mid-download stops it; the main process drops what it got
      if (fetchingRef.current) void skills.cancelImport()
    },
    [skills],
  )

  const openPreview = async () => {
    if (state.kind !== 'proposed' && state.kind !== 'done') return
    setState({ kind: 'fetching' })
    fetchingRef.current = true
    const answer = await skills.importGitHub(address)
    fetchingRef.current = false
    if (answer.ok) {
      setState({ kind: 'preview', preview: answer.preview })
      return
    }
    if (answer.reason === 'cancelled') {
      setState({ kind: 'proposed' })
      return
    }
    setState({
      kind: 'done',
      tone: 'error',
      text: skillsText(lang, failureKey(answer.reason, 'import') ?? 'failGeneric'),
    })
  }

  if (state.kind === 'dismissed') {
    return <div className="agent-system">{agentSkillsText(lang, 'installDismissed')}</div>
  }

  return (
    <div className="agent-install" role="group" aria-label={agentSkillsText(lang, 'installTitle')}>
      <span className="agent-label">{agentSkillsText(lang, 'installTitle')}</span>
      <code className="agent-install-address">{address}</code>
      <span className="agent-choice-note">{agentSkillsText(lang, 'installHint')}</span>
      {state.kind === 'fetching' ? (
        <span className="agent-choice-note" role="status">
          {skillsText(lang, 'githubFetching')}
        </span>
      ) : null}
      {state.kind === 'done' ? (
        <span
          className={state.tone === 'error' ? 'agent-error' : 'agent-choice-note'}
          role={state.tone === 'error' ? 'alert' : 'status'}
        >
          {state.text}
        </span>
      ) : null}
      <div className="agent-perm-actions">
        {state.kind === 'fetching' ? (
          <button className="agent-btn" type="button" onClick={() => void skills.cancelImport()}>
            {agentSkillsText(lang, 'installCancel')}
          </button>
        ) : state.kind === 'done' && state.tone === 'ok' ? null : (
          <>
            <button
              className="agent-btn"
              type="button"
              onClick={() => setState({ kind: 'dismissed' })}
            >
              {agentSkillsText(lang, 'installDismiss')}
            </button>
            <button
              className="agent-btn agent-btn-primary"
              type="button"
              disabled={state.kind === 'preview'}
              onClick={() => void openPreview()}
            >
              {agentSkillsText(lang, 'installOpen')}
            </button>
          </>
        )}
      </div>
      {state.kind === 'preview' ? (
        <SkillImportPreviewDialog
          api={skills}
          preview={state.preview}
          lang={lang}
          locale={htmlLang(lang)}
          onDone={(notice) => setState({ kind: 'done', ...notice })}
          onClose={() => setState({ kind: 'dismissed' })}
        />
      ) : null}
    </div>
  )
}
