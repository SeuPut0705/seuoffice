/**
 * The page picker's preselection (spec §7): scanned pages, degraded pages
 * and pages whose footnotes could not be linked. The user adds or removes
 * pages from there (formula and table pages are added by hand). Pages
 * already read by the AI (status 'ai') are not preselected.
 */
import type { DocumentTree } from '../tree/types'

export type AiReadPreselectReason = 'scanned' | 'degraded' | 'footnote-link-failed'

export interface AiReadPreselectPage {
  /** 1-based original page number */
  page: number
  pageFingerprint: string
  reasons: AiReadPreselectReason[]
}

/** preselected pages in the tree's page order */
export function aiReadPreselectPages(tree: DocumentTree): AiReadPreselectPage[] {
  const linkFailed = new Set(tree.footnoteLinkFailedPages)
  const out: AiReadPreselectPage[] = []
  for (const p of tree.pages) {
    if (p.status === 'ai') continue
    const reasons: AiReadPreselectReason[] = []
    if (p.status === 'scanned' || p.status === 'degraded') reasons.push(p.status)
    if (linkFailed.has(p.page)) reasons.push('footnote-link-failed')
    if (reasons.length > 0) out.push({ page: p.page, pageFingerprint: p.fingerprint, reasons })
  }
  return out
}
