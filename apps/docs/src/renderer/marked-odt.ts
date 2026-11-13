import { clearHiddenMarks, docxHoldsHiddenContent } from '@seuoffice/docx-engine'

/**
 * An ODT cannot hold the mark that hides content from AI: a marked run written
 * into one reads as plain words to every reader. Every write of an ODT from
 * the Word editor goes through here with the docx the editor serialized (body,
 * headers, footers, comments, notes and hidden pictures all sit in it): what
 * comes back is what may be written, or the reason it may not.
 */
export type MarkedOdtChoice = 'docx' | 'clear' | 'cancel'

export type OdtWritePlan =
  /** write this docx as ODT: the editor's own when nothing is hidden, else the marks-cleared copy */
  | { kind: 'write'; docx: Uint8Array }
  /** marked content: the person asked for Word instead */
  | { kind: 'save-as-docx' }
  /** marked content: the person declined, or nobody could be asked */
  | { kind: 'declined' }

/**
 * `ask` shows the choice; null when nobody can be asked (an automatic save, an
 * MCP-driven save): marked content is then declined, never written.
 */
export async function planOdtWrite(
  docx: Uint8Array,
  ask: (() => Promise<MarkedOdtChoice>) | null,
): Promise<OdtWritePlan> {
  if (!(await docxHoldsHiddenContent(docx))) return { kind: 'write', docx }
  if (!ask) return { kind: 'declined' }
  const choice = await ask()
  if (choice === 'docx') return { kind: 'save-as-docx' }
  if (choice === 'clear') return { kind: 'write', docx: await clearHiddenMarks(docx) }
  return { kind: 'declined' }
}

/** Thrown where an ODT is built from marked content with no one to ask: nothing is written. */
export class MarkedOdtError extends Error {
  constructor() {
    super('content hidden from AI cannot be written into an ODT file')
  }
}

/** `docx` itself when nothing in it is hidden; throws MarkedOdtError otherwise. */
export async function assertNoMarks(docx: Uint8Array): Promise<Uint8Array> {
  if (await docxHoldsHiddenContent(docx)) throw new MarkedOdtError()
  return docx
}
