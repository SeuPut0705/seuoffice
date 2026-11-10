/**
 * Pages copied in the thumbnail sidebar (Ctrl+C), pasted into the same or
 * another PDF view (Ctrl+V). One slot for the whole app, kept in the main
 * process: it holds a small PDF of just the copied pages, so a paste needs
 * neither the source file nor a path from the renderer.
 */

import { PDFDocument } from 'pdf-lib'
import type { SavePdfRequest } from '../shared/ipc'
import { pdfBytesWithEditsFrom } from './save-pdf'

export interface CopiedPages {
  /** A PDF holding the copied pages, in the order they were shown */
  bytes: Uint8Array
  count: number
}

let held: CopiedPages | null = null

export function holdCopiedPages(pages: CopiedPages | null): void {
  held = pages
}

export function heldCopiedPages(): CopiedPages | null {
  return held
}

/**
 * The pages at `positions` of the document as displayed: `source` with the
 * view's pending edits applied (what a save would write, order and deletions
 * included), nothing written anywhere. Null when no position is a page.
 */
export async function copiedPagesOf(
  source: Uint8Array,
  request: SavePdfRequest,
  positions: readonly unknown[],
): Promise<CopiedPages | null> {
  const shown = await PDFDocument.load(await pdfBytesWithEditsFrom(source, request), {
    updateMetadata: false,
  })
  const total = shown.getPageCount()
  const valid = [
    ...new Set(
      positions.filter(
        (p): p is number => Number.isInteger(p) && Number(p) >= 0 && Number(p) < total,
      ),
    ),
  ].sort((a, b) => a - b)
  if (valid.length === 0) return null
  const out = await PDFDocument.create()
  for (const page of await out.copyPages(shown, valid)) out.addPage(page)
  return { bytes: await out.save({ useObjectStreams: false }), count: valid.length }
}
