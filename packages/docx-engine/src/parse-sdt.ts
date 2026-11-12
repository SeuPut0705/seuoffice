// Structured document tags (w:sdt): block-level SDT classification and the
// split of an SDT's run/table content.
import type { SdtShell } from './types'

/** a <w:sdt>…</w:sdt> element's absolute byte ranges inside the scanned xml */
export interface SdtRange {
  /** index of the opening <w:sdt> tag */
  openStart: number
  /** end of the <w:sdtContent> opening tag (the content starts here) */
  openEnd: number
  /** start of the matching </w:sdtContent> closing tag (the content ends here) */
  closeStart: number
  /** end of the closing </w:sdt> tag */
  closeEnd: number
}
/** one level of a nested block-level control chain, outermost first */
export interface SdtChainLevel extends SdtRange {
  /** metadata and this level's own open/close bytes (full slices of the scanned xml) */
  shell: SdtShell
}