import { collectPlaceholders, placeholderInstruction, readPlaceholderLabel } from './redact'
import { redactLabelsOf } from './redact-view'
import type { Editor } from '@tiptap/core'
import { attachedImageNote, type AgentSkill } from '@seuoffice/agent-core'
import { AGENT_SYSTEM_PROMPT, buildDocContext, getSelectionScope, type NumIds } from './protocol'
import type { AiDocWriter } from './doc-writer'
import type { AiPageSetupAccess } from './page-setup'
import {
  AGENT_TOOLS,
  executeTool,
  markDocSeen,
  type AiCommentsAccess,
  type AiHeaderFooterAccess,
  type FrozenSelection,
  type AiDocExtras,
  type AiAttachmentAccess,
} from './tools'
import type { AiNotesAccess } from './note-ops'
import type { AgentToolDef } from '../../shared/ipc'
import { isOdtSession } from '../odt-gate'
import { ODT_SYSTEM_NOTE, odtToolFilter } from './odt-tools'
import { AI_REVISION_AUTHOR } from './revision-author'

/** the labels of the placeholders in a model text, none for an entry that hides nothing */
function placeholderLabels(modelText: string | undefined): string[] {
  return (modelText === undefined ? [] : collectPlaceholders(modelText)).flatMap(
    (marker) => readPlaceholderLabel(marker) ?? [],
  )
}

const IMAGE_GEN_OFF_NOTE =
  '\n\nNote: generate_image is currently unavailable (no image provider: no Codex subscription connected and no image API key in Settings). Do not call or promise it; use image_search for imagery.'

const MEDIA_ANALYSIS_OFF_NOTE =
  '\n\nNote: analyze_media is currently unavailable (no media provider: no AI connection that can look at pictures and no media API key in Settings). You cannot see what a picture inside the document shows — tell the user that instead of guessing at its content.'

/** tools the AI never gets: resolving tracked changes is the person's call (the CLI keeps them) */
const PERSON_ONLY_TOOLS = new Set(['accept_changes', 'reject_changes'])

/**
 * The docx capability as an AgentSkill: document skeleton context, the five
 * document tools, and the local executor. Future apps register their own
 * skills (Excel / PPT) against the same agent loop.
 *
 * Every AI edit is recorded as a tracked revision by AI_REVISION_AUTHOR; a
 * person accepts or rejects them in the Review tab. ODT cannot hold
 * revisions, so edits there stay plain.
 */
export function createDocsSkill(
  getEditor: () => Editor,
  getNumIds: () => NumIds,
  getComments?: () => AiCommentsAccess | undefined,
  getHf?: () => AiHeaderFooterAccess | undefined,
  /** live predicate (the main process's tool capabilities: a subscription or a media key); false hides generate_image */
  imageGenAvailable?: () => boolean,
  /** streaming long-form writer behind write_document (panel-owned: progress chip, partial keep/discard) */
  getWriter?: () => AiDocWriter | undefined,
  getPageSetup?: () => AiPageSetupAccess | undefined,
  /** styles.xml catalog + page watermark stores (define_style / applyStyle / set_watermark) */
  getExtras?: () => AiDocExtras | undefined,
  getNotes?: () => AiNotesAccess | undefined,
  /** same as imageGenAvailable, for analyze_media (seeing pictures that are in the document) */
  mediaAnalysisAvailable?: () => boolean,
  /** the files attached to this chat, so insert_image can take one the user made elsewhere */
  getAttachments?: () => AiAttachmentAccess | undefined,
): AgentSkill {
  // Selection frozen per run: tools act on the range the prompt described,
  // not on wherever the user's live selection has wandered mid-run. The doc
  // snapshot bounds the freeze's validity (see FrozenSelection).
  let frozen: FrozenSelection | null = null
  /** tools that need a media provider: a connected subscription, or a media key in Settings */
  const mediaToolsOff = (): Set<string> => {
    const hidden = new Set<string>()
    if (imageGenAvailable?.() === false) hidden.add('generate_image')
    if (mediaAnalysisAvailable?.() === false) hidden.add('analyze_media')
    return hidden
  }
  const mediaOffNote = (): string =>
    [...mediaToolsOff()]
      .map((name) => (name === 'generate_image' ? IMAGE_GEN_OFF_NOTE : MEDIA_ANALYSIS_OFF_NOTE))
      .join('')
  return {
    id: 'docx',
    // live: the predicate is re-read before every model request
    get systemPrompt() {
      // only when the open document actually withholds something, so a
      // document without spans pays nothing and the model is not told to
      // look for markers that are not there
      const editor = getEditor()
      const labels = [
        ...(editor
          ? redactLabelsOf(editor.getJSON() as unknown as Parameters<typeof redactLabelsOf>[0])
          : []),
        // a comment or note carries a model text exactly when it hides something
        ...(getComments?.()?.list() ?? []).flatMap((c) => placeholderLabels(c.modelText)),
        ...(['footnote', 'endnote'] as const).flatMap((kind) =>
          (getNotes?.()?.list(kind) ?? []).flatMap((n) => placeholderLabels(n.modelText)),
        ),
      ]
      const redact = labels.length > 0 ? `\n\n${placeholderInstruction(labels)}` : ''
      const odt = isOdtSession() ? ODT_SYSTEM_NOTE : ''
      const attached = attachedImageNote(
        getAttachments?.()?.names() ?? [],
        'call insert_image with attachment set to the name',
      )
      return AGENT_SYSTEM_PROMPT + mediaOffNote() + attached + redact + odt
    },
    get tools() {
      const hidden = mediaToolsOff()
      const tools = AGENT_TOOLS.filter((t) => !hidden.has(t.name) && !PERSON_ONLY_TOOLS.has(t.name))
      // an ODT document: tools for switched-off features are not offered
      return odtToolFilter(tools) as AgentToolDef[]
    },
    buildContext: () => {
      const editor = getEditor()
      markDocSeen(editor) // the context the model receives is the freshness baseline for index-addressed writes
      frozen = { scope: getSelectionScope(editor), doc: editor.state.doc }
      return buildDocContext(
        editor,
        frozen.scope,
        getComments?.()?.list(),
        getHf?.()?.read(),
        getPageSetup?.()?.list(),
      )
    },
    executeTool: async (call, signal) => {
      if (PERSON_ONLY_TOOLS.has(call.name)) {
        return {
          output: `${call.name} is not available to the AI: a person accepts or rejects tracked changes in the Review tab`,
          isError: true,
          summary: call.name,
        }
      }
      return executeTool(
        getEditor(),
        call,
        getNumIds(),
        isOdtSession() ? undefined : { author: AI_REVISION_AUTHOR },
        signal,
        frozen,
        getComments?.(),
        getHf?.(),
        getWriter?.(),
        getPageSetup?.(),
        getExtras?.(),
        getNotes?.(),
        getAttachments?.(),
      )
    },
  }
}
