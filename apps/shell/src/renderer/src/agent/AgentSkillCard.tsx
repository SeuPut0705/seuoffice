import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { UserSkillsBridge } from '@genoffice/electron-utils/user-skills-bridge'
import {
  SkillCardLine,
  SkillCardPreviewLine,
  SkillProposalCard,
  skillCardBridge,
  skillCardText,
  skillTemplateText,
  type SkillCardTemplateContext,
} from '@genoffice/ui'
import type {
  AgentSkillProposalPayload,
  AgentTemplateCandidateView,
  AgentTemplateRedaction,
  AgentWindowApi,
} from '../../../shared/agent-api'
import { agentSkillsText, type AgentSkillsStringKey } from '../i18n/strings-agent-skills'

/** The skills bridge calls the agent window has (its preload's part) */
export type AgentSkillsBridge = Pick<
  UserSkillsBridge,
  | 'list'
  | 'openSettings'
  | 'agentNotice'
  | 'markAgentNoticeSeen'
  | 'onChanged'
  | 'importGitHub'
  | 'cancelImport'
  | 'install'
  | 'focusTab'
  | 'onPreviewEnded'
>

/** This window's skills bridge, or null (an older preload) */
export function agentSkillsBridge(): AgentSkillsBridge | null {
  return (
    (window as unknown as { aiOfficeUserSkills?: AgentSkillsBridge }).aiOfficeUserSkills ?? null
  )
}

/** The redaction answer of a candidate, read when it is chosen (null while reading) */
type CandidateState =
  | { kind: 'checking' }
  | { kind: 'ready'; redaction: AgentTemplateRedaction }
  | { kind: 'failed'; reason: string }

/**
 * The template buttons of an agent-window card (spec 5.6, 6.3) for the chosen
 * document: "Make a blank template" opens its copy in a template preview tab
 * whose AI clears it; "Save the document as it is" saves the file, only when
 * the main process finds that no redaction mark can be in it.
 */
function AgentTemplateActions({
  context,
  api,
  proposalKey,
  candidate,
  onPreviewOpened,
}: {
  context: SkillCardTemplateContext
  api: AgentWindowApi
  proposalKey: string
  candidate: AgentTemplateCandidateView
  onPreviewOpened: (opened: { tabId: string; previewId: string }) => void
}) {
  const { lang, busy, blocked } = context
  const ta = (key: AgentSkillsStringKey) => agentSkillsText(lang, key)
  const [state, setState] = useState<CandidateState>({ kind: 'checking' })
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    setState({ kind: 'checking' })
    setFailure(null)
    void api.templateCheck(proposalKey, candidate.id).then((answer) => {
      if (!live) return
      setState(
        answer.ok
          ? { kind: 'ready', redaction: answer.redaction }
          : { kind: 'failed', reason: answer.reason },
      )
    })
    return () => {
      live = false
    }
  }, [api, proposalKey, candidate.id])

  const failureText = (reason: string): string =>
    reason === 'too-large'
      ? ta('templateTooLarge')
      : reason === 'redacted'
        ? skillTemplateText(lang, 'asIsRedacted')
        : reason === 'unknown'
          ? ta('templateUnknown')
          : skillTemplateText(lang, 'documentUnreadable')

  const makeBlank = async () => {
    if (working) return
    setWorking(true)
    setFailure(null)
    try {
      const opened = await api.templateBlank(proposalKey, candidate.id, {
        tabTitle: skillTemplateText(lang, 'previewTabTitle', { title: candidate.title }),
        text: skillTemplateText(lang, 'clearRequest'),
        draft: context.draft,
      })
      if (!liveRef.current) return
      if (opened.ok) onPreviewOpened({ tabId: opened.tabId, previewId: opened.previewId })
      else setFailure(skillTemplateText(lang, 'openFailed'))
    } finally {
      if (liveRef.current) setWorking(false)
    }
  }

  const saveAsIs = async () => {
    if (working) return
    setWorking(true)
    setFailure(null)
    try {
      // asked again on the click: the file may have changed since the card opened
      const answer = await api.templateAsIs(proposalKey, candidate.id)
      if (!liveRef.current) return
      if (!answer.ok) {
        setFailure(failureText(answer.reason))
        return
      }
      await context.save({ bytes: answer.bytes, fileName: answer.fileName })
    } finally {
      if (liveRef.current) setWorking(false)
    }
  }

  const disabled = busy || working || !!blocked
  const asIsAllowed = state.kind === 'ready' && state.redaction === 'none'
  const asIsReason =
    state.kind === 'checking'
      ? null
      : state.kind === 'failed'
        ? failureText(state.reason)
        : state.redaction === 'none'
          ? null
          : failureText(state.redaction)
  const note = failure ?? asIsReason ?? (state.kind === 'checking' ? ta('templateChecking') : null)
  return (
    <>
      <button
        type="button"
        className="ai-skill-card-btn primary"
        disabled={disabled || state.kind === 'failed'}
        title={blocked ?? undefined}
        onClick={() => void makeBlank()}
      >
        {skillCardText(lang, 'templateBlank')}
      </button>
      <button
        type="button"
        className="ai-skill-card-btn"
        disabled={disabled || !asIsAllowed}
        title={asIsReason ?? blocked ?? undefined}
        data-template-as-is-blocked={
          state.kind === 'ready' && state.redaction !== 'none' ? state.redaction : undefined
        }
        onClick={() => void saveAsIs()}
      >
        {skillCardText(lang, 'templateAsIs')}
      </button>
      {note && (
        <p className="ai-skill-card-note is-error ai-skill-card-template-note" role="status">
          {note}
        </p>
      )}
    </>
  )
}

type CardStatus =
  | { kind: 'open' }
  | { kind: 'saved'; title: string }
  | { kind: 'unsaved'; title: string }
  | { kind: 'preview'; tabId: string; previewId: string; title: string }

/**
 * A skill card a session's `propose_skill` asked for (spec 6.3): the shared
 * card, with the template chosen above it among the documents open in tabs
 * and the project folder's files (the model's suggestion first chosen, or "no
 * template"). Nothing is written before Save.
 */
export function AgentSkillCard({
  lang,
  payload,
  api,
  skills,
}: {
  lang: Lang
  payload: AgentSkillProposalPayload
  api: AgentWindowApi
  skills: AgentSkillsBridge | null
}) {
  const ta = (key: AgentSkillsStringKey) => agentSkillsText(lang, key)
  const { proposal, candidates } = payload
  const [chosen, setChosen] = useState(payload.selected ?? '')
  const [status, setStatus] = useState<CardStatus>({ kind: 'open' })
  const candidate = candidates.find((c) => c.id === chosen)
  const previewId = status.kind === 'preview' ? status.previewId : null

  // the preview tab's card was saved, or the tab closed unsaved
  useEffect(() => {
    if (!previewId || !skills) return
    return skills.onPreviewEnded((ended) => {
      if (ended.previewId !== previewId) return
      setStatus((was) =>
        ended.outcome === 'saved'
          ? { kind: 'saved', title: ended.title ?? ('title' in was ? was.title : '') }
          : { kind: 'unsaved', title: 'title' in was ? was.title : proposal.title },
      )
    })
  }, [previewId, skills, proposal.title])

  if (status.kind === 'saved' || status.kind === 'unsaved') {
    return (
      <SkillCardLine
        lang={lang}
        status={status.kind}
        title={status.title}
        onOpenSettings={skills ? () => void skills.openSettings() : undefined}
      />
    )
  }
  if (status.kind === 'preview') {
    return (
      <SkillCardPreviewLine
        lang={lang}
        title={status.title}
        onGoToTab={skills ? () => void skills.focusTab(status.tabId) : undefined}
      />
    )
  }

  return (
    <div className="agent-skill-card">
      {candidates.length > 0 ? (
        <label className="agent-skill-template">
          <span className="agent-label">{ta('templateLabel')}</span>
          <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">{ta('templateNone')}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.fileName} · ${ta(c.from === 'tab' ? 'templateFromTab' : 'templateFromProject')}`}
              </option>
            ))}
          </select>
          {candidate?.unsaved ? (
            <span className="agent-choice-note">{ta('templateUnsaved')}</span>
          ) : null}
        </label>
      ) : null}
      <SkillProposalCard
        key={proposal.key}
        lang={lang}
        proposal={proposal}
        bridge={skillCardBridge()}
        canBeTemplate={!!candidate}
        initialDraft={{ withTemplate: proposal.wantsTemplate || !!payload.selected }}
        renderTemplateActions={
          candidate
            ? (context) => (
                <AgentTemplateActions
                  key={candidate.id}
                  context={context}
                  api={api}
                  proposalKey={proposal.key}
                  candidate={candidate}
                  onPreviewOpened={(opened) =>
                    setStatus({ kind: 'preview', ...opened, title: context.draft.title })
                  }
                />
              )
            : undefined
        }
        onSaved={(_id, draft) => setStatus({ kind: 'saved', title: draft.title })}
        onCancel={() => setStatus({ kind: 'unsaved', title: proposal.title })}
      />
    </div>
  )
}
