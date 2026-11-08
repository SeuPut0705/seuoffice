import React, { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { SkillCardTemplateContext } from './SkillProposalCard'
import { skillCardText } from './strings-skill-card'
import { skillTemplateText } from './strings-skill-template'
import {
  previewOpenResultOf,
  previewOriginalOf,
  type HandedPreview,
  type SkillTemplateBridge,
  type TemplateDocument,
} from './skill-template-model'

/** The redaction answer of a document, read once per card (null while reading) */
function useRedacted(read: (() => boolean | Promise<boolean>) | null): boolean | null {
  const [redacted, setRedacted] = useState<boolean | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    let live = true
    const current = readRef.current
    if (!current) {
      setRedacted(false)
      return
    }
    Promise.resolve()
      .then(() => current())
      .then(
        (answer) => live && setRedacted(answer === true),
        // an answer that cannot be had blocks: less is saved rather than a hidden part
        () => live && setRedacted(true),
      )
    return () => {
      live = false
    }
  }, [])
  return redacted
}

export interface OriginalTemplateActionsProps {
  context: SkillCardTemplateContext
  document: TemplateDocument
  bridge: SkillTemplateBridge | null
  /** the preview tab opened: the card continues there */
  onPreviewOpened: (opened: { tabId: string; previewId: string }) => void
}

/**
 * The two template buttons of a card in the original tab (spec 5.6):
 * "Make a blank template" opens the document's copy in a preview tab and hands
 * over the clearing request with the card; "Save the document as it is" saves
 * the document as edited, blocked while it has redaction marks.
 */
export function OriginalTemplateActions({
  context,
  document,
  bridge,
  onPreviewOpened,
}: OriginalTemplateActionsProps): React.JSX.Element {
  const { lang, busy, blocked } = context
  const redacted = useRedacted(document.redacted)
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  const readBytes = async (): Promise<Uint8Array | null> => {
    try {
      return await document.bytes()
    } catch {
      return null
    }
  }

  /** asked again when a button is pressed: a mark added since the card opened counts */
  const redactedNow = async (): Promise<boolean> => {
    try {
      return (await document.redacted()) !== false
    } catch {
      return true
    }
  }

  const saveAsIs = async () => {
    if (working || redacted !== false) return
    setWorking(true)
    setFailure(null)
    try {
      if (await redactedNow()) {
        if (liveRef.current) setFailure(skillTemplateText(lang, 'asIsRedacted'))
        return
      }
      const bytes = await readBytes()
      if (!liveRef.current) return
      if (!bytes) {
        setFailure(skillTemplateText(lang, 'documentUnreadable'))
        return
      }
      await context.save({ bytes, fileName: document.fileName })
    } finally {
      if (liveRef.current) setWorking(false)
    }
  }

  const makeBlank = async () => {
    if (working || !bridge) return
    setWorking(true)
    setFailure(null)
    try {
      const bytes = await readBytes()
      if (!liveRef.current) return
      if (!bytes) {
        setFailure(skillTemplateText(lang, 'documentUnreadable'))
        return
      }
      const opened = previewOpenResultOf(
        await bridge
          .openPreview({
            bytes,
            fileName: document.fileName,
            title: document.title,
            tabTitle: skillTemplateText(lang, 'previewTabTitle', { title: document.title }),
            text: skillTemplateText(lang, 'clearRequest'),
            originalRedacted: redacted !== false || (await redactedNow()),
            proposal: context.proposal,
            draft: context.draft,
          })
          .catch(() => null),
      )
      if (!liveRef.current) return
      if (opened.ok) onPreviewOpened({ tabId: opened.tabId, previewId: opened.previewId })
      else setFailure(skillTemplateText(lang, 'openFailed'))
    } finally {
      if (liveRef.current) setWorking(false)
    }
  }

  const disabled = busy || working || !!blocked
  const asIsReason = redacted ? skillTemplateText(lang, 'asIsRedacted') : null
  return (
    <>
      <button
        type="button"
        className="ai-skill-card-btn primary"
        disabled={disabled || !bridge}
        title={blocked ?? undefined}
        onClick={() => void makeBlank()}
      >
        {skillCardText(lang, 'templateBlank')}
      </button>
      <button
        type="button"
        className="ai-skill-card-btn"
        disabled={disabled || redacted !== false}
        title={asIsReason ?? blocked ?? undefined}
        data-template-as-is-blocked={redacted ? 'redacted' : undefined}
        onClick={() => void saveAsIs()}
      >
        {skillCardText(lang, 'templateAsIs')}
      </button>
      {(asIsReason || failure) && (
        <p className="ai-skill-card-note is-error ai-skill-card-template-note" role="status">
          {failure ?? asIsReason}
        </p>
      )}
    </>
  )
}

export interface PreviewTemplateActionsProps {
  context: SkillCardTemplateContext
  preview: HandedPreview
  /** this preview tab's document */
  document: TemplateDocument | null
  bridge: SkillTemplateBridge | null
}

/**
 * The template buttons of the card in a template preview tab (spec 5.6):
 * "Save this tab as the template" saves the tab's content at this moment;
 * "Save the document as it is" saves the original document handed over,
 * blocked when that one had redaction marks.
 */
export function PreviewTemplateActions({
  context,
  preview,
  document,
  bridge,
}: PreviewTemplateActionsProps): React.JSX.Element {
  const { lang, busy, blocked } = context
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  const run = async (read: () => Promise<Uint8Array | null>) => {
    if (working) return
    setWorking(true)
    setFailure(null)
    try {
      const bytes = await read().catch(() => null)
      if (!liveRef.current) return
      if (!bytes) {
        setFailure(skillTemplateText(lang, 'documentUnreadable'))
        return
      }
      await context.save({ bytes, fileName: preview.fileName })
    } finally {
      if (liveRef.current) setWorking(false)
    }
  }

  const saveThisTab = () => run(async () => (document ? document.bytes() : null))
  const saveOriginal = () =>
    run(async () => {
      if (!bridge || preview.originalRedacted) return null
      const original = previewOriginalOf(await bridge.previewOriginal(preview.previewId))
      return original?.bytes ?? null
    })

  const disabled = busy || working || !!blocked
  const asIsReason = preview.originalRedacted ? skillTemplateText(lang, 'asIsRedacted') : null
  return (
    <>
      <button
        type="button"
        className="ai-skill-card-btn primary"
        disabled={disabled || !document}
        title={blocked ?? undefined}
        onClick={() => void saveThisTab()}
      >
        {skillTemplateText(lang, 'saveThisTab')}
      </button>
      <button
        type="button"
        className="ai-skill-card-btn"
        disabled={disabled || preview.originalRedacted || !bridge}
        title={asIsReason ?? blocked ?? undefined}
        data-template-as-is-blocked={preview.originalRedacted ? 'redacted' : undefined}
        onClick={() => void saveOriginal()}
      >
        {skillCardText(lang, 'templateAsIs')}
      </button>
      {(asIsReason || failure) && (
        <p className="ai-skill-card-note is-error ai-skill-card-template-note" role="status">
          {failure ?? asIsReason}
        </p>
      )}
    </>
  )
}

/** "Continues in the template preview tab [Go to the tab]" in the original tab's card */
export function SkillCardPreviewLine({
  lang,
  title,
  onGoToTab,
}: {
  lang: Lang
  title: string
  onGoToTab?: (() => void) | undefined
}): React.JSX.Element {
  return (
    <div className="ai-skill-card-line is-preview" data-skill-card-status="preview">
      <span className="ai-skill-card-line-text" dir="auto">
        {skillTemplateText(lang, 'previewContinues')}
        {title ? ` · ${title}` : ''}
      </span>
      {onGoToTab && (
        <>
          {' · '}
          <button type="button" className="ai-skill-card-link" onClick={onGoToTab}>
            {skillTemplateText(lang, 'goToTab')}
          </button>
        </>
      )}
    </div>
  )
}
