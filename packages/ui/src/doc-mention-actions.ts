import type { Lang } from '@genoffice/i18n'
import { docPickedOf } from './DocAttachButton'
import type { AiComposerDocs } from './use-doc-mention'

/** What an editor's attach route answers: the files it took, and why others were refused */
export interface DocMentionAddResult<T extends { path: string }> {
  accepted: T[]
  rejected: string[]
}

export interface DocMentionActionsOptions<T extends { path: string }> {
  lang: Lang
  /** the editor's normal attach route (`addAttachmentPaths`) */
  add: (paths: string[]) => Promise<DocMentionAddResult<T> | null>
  /** the editor's merge into its attachment row; shows the refusals beside it */
  merge: (result: DocMentionAddResult<T>) => void
}

interface PickBridge {
  pick(): Promise<unknown>
}

function pickBridge(): PickBridge | null {
  const b = (globalThis as { aiOfficeDocs?: Partial<PickBridge> }).aiOfficeDocs
  return typeof b?.pick === 'function' ? (b as PickBridge) : null
}

/**
 * The `attach` and `pickMore` an editor hands to the `@` list: both go through
 * the editor's own attach route, exactly as the "Attach from documents" button
 * does, and resolve to the paths that are attachments afterwards (a refused
 * path is left out; its reason lands on the attachment row through `merge`).
 */
export function docMentionActions<T extends { path: string }>(
  options: DocMentionActionsOptions<T>,
): Pick<AiComposerDocs, 'attach' | 'pickMore'> {
  const attachWithNotes = async (paths: string[], notes: string[]): Promise<string[]> => {
    const added = paths.length > 0 ? await options.add(paths) : null
    const accepted = added?.accepted ?? []
    const rejected = [...(added?.rejected ?? []), ...notes]
    if (accepted.length > 0 || rejected.length > 0) options.merge({ accepted, rejected })
    return accepted.map((a) => a.path)
  }
  return {
    attach: (paths) => attachWithNotes(paths, []),
    pickMore: async () => {
      const b = pickBridge()
      if (!b) return null
      const raw = await b.pick().catch(() => null)
      const picked = docPickedOf(raw, options.lang)
      if (picked.paths.length === 0 && picked.notes.length === 0) return null
      return attachWithNotes(picked.paths, picked.notes)
    },
  }
}
