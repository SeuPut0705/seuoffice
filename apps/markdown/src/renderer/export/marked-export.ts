import type { JSONContent } from '@tiptap/core'
import { clearRedaction, holdsRedaction } from '../editor/redact'
import type { ExportFormat, MarkedExportChoice, MarkedExportFormat } from '../../shared/ipc'

/**
 * A PDF, page images and an ODT cannot carry the mark that hides content from
 * AI: the words in the file read as plain text to everything that opens it.
 * Every export of those formats goes through here with the document's JSON:
 * what comes back is what may be built, or why nothing is.
 */
export type MarkedExportPlan =
  /** export this document: the editor's own when nothing is hidden, else the copy with the marks off */
  | { kind: 'write'; json: JSONContent }
  /** marked content: the person asked for Word, which keeps the mark, instead */
  | { kind: 'save-as-docx' }
  /** marked content: the person cancelled */
  | { kind: 'declined' }
  /** marked content and no one to ask (command line, AI): nothing is written */
  | { kind: 'refused' }

/** the exports whose files cannot hold the mark; Word (`docx`, `docs`) does */
export function cannotKeepMark(format: ExportFormat): format is MarkedExportFormat {
  return format !== 'docx' && format !== 'docs'
}

/** `ask` null: nobody can be asked, so a marked document is refused, never written. */
export async function planMarkedExport(
  format: ExportFormat,
  json: JSONContent,
  ask: ((format: MarkedExportFormat) => Promise<MarkedExportChoice>) | null,
): Promise<MarkedExportPlan> {
  if (!cannotKeepMark(format) || !holdsRedaction(json)) return { kind: 'write', json }
  if (!ask) return { kind: 'refused' }
  const choice = await ask(format)
  if (choice === 'docx') return { kind: 'save-as-docx' }
  if (choice === 'clear') return { kind: 'write', json: clearRedaction(json) }
  return { kind: 'declined' }
}
