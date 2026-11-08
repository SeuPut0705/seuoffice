/**
 * The AI-read text of the open file's pages, for the viewer search (spec §7):
 * the store's readings matched to pages by fingerprint and written as
 * structured text. Asked only when the store holds readings for the file;
 * the fingerprints come from the document tree the main process caches per
 * view.
 */
import { aiReadPayloadText } from '../../../../../packages/pdf-structure/src/structured-text'
import type { PdfStoreApi, PdfStructureApi } from '../../shared/ipc'

export interface AiReadTextsAccess {
  tree: PdfStructureApi['tree']
  store: Pick<PdfStoreApi, 'docHash' | 'aiReadPages'>
}

let seq = 0

/** 1-based page → AI-read text; empty when nothing is stored or anything fails */
export async function loadAiReadTexts(
  access: AiReadTextsAccess,
  source: { path: string; password?: string | undefined },
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  try {
    const hash = await access.store.docHash(source.path)
    if (!hash.ok) return out
    const stored = await access.store.aiReadPages(hash.docHash)
    if (!stored.ok || stored.pages.length === 0) return out
    const tree = await access.tree({
      jobId: `ai-read-search-${Date.now().toString(36)}-${(++seq).toString(36)}`,
      path: source.path,
      ...(source.password !== undefined ? { password: source.password } : {}),
    })
    if (!tree.ok) return out
    const byFp = new Map(stored.pages.map((p) => [p.pageFingerprint, p.payload]))
    for (const { page, fingerprint } of tree.fingerprints) {
      const payload = byFp.get(fingerprint)
      if (payload === undefined) continue
      const text = aiReadPayloadText(payload, page, fingerprint)
      if (text) out.set(page, text)
    }
  } catch {
    // the search works without them
  }
  return out
}
