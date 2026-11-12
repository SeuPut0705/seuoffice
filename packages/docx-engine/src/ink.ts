import type { NewInkImage } from './types'
import { invoke } from './engine'

/**
 * Ink annotations (freehand strokes). Each saved annotation is a floating picture —
 * a run-level <w:drawing><wp:anchor> injected into its anchor paragraph:
 *
 * - wp:positionV relativeFrom="paragraph": the drawing moves with the
 *   paragraph when content above it reflows.
 * - wp:positionH relativeFrom="column": offsets are measured from the text
 *   column edge, independent of the paragraph's own indentation.
 * - behindDoc="0" + wp:wrapNone: floats in front of the text without
 *   affecting layout.
 * - wp:docPr name starts with "aidocs-ink" so we can recognize our own
 *   annotations when the file is reopened; descr carries the editor's
 *   stroke vectors (opaque payload) so the layer stays re-editable.
 *
 * Word renders these as ordinary floating pictures; only our editor restores
 * them into live strokes.
 */

export const INK_NAME_PREFIX = 'aidocs-ink'
/**
 * The anchored-picture run for one ink annotation. Namespaces are declared
 * inline so the fragment is valid regardless of what the document root
 * declares (w: is always present).
 */
export function anchoredInkRunXml(
  ink: Pick<NewInkImage, 'widthPx' | 'heightPx' | 'offsetXPx' | 'offsetYPx' | 'payload'>,
  rId: string,
  docPrId: number,
): string {
  return invoke('anchoredInkRunXml', [{ blockIndex: 0, base64: '', ...ink }, rId, docPrId]) as never
}
/** Remove every aidocs-ink run from a body-element XML slice. */
export function stripInkRuns(xml: string): string {
  return invoke('stripInkRuns', [xml]) as never
}
/** One raw ink run found in a paragraph's XML. */
export interface InkRunMatch {
  /** the exact <w:r>...</w:r> slice, for stripping */
  xml: string
  offsetXPx: number
  offsetYPx: number
  widthPx: number
  heightPx: number
  payload: string | null
  /** relationship id of the embedded PNG */
  embedRId: string | null
}
/** Find aidocs-ink anchored runs inside one paragraph's XML. */
export function findInkRuns(paragraphXml: string): InkRunMatch[] {
  return invoke('findInkRuns', [paragraphXml]) as never
}
/**
 * Insert ink runs at the end of a paragraph fragment (after all content
 * runs). Returns null when the fragment's root is not a w:p — floating ink
 * can only anchor to paragraphs.
 */
export function injectInkRunsIntoParagraph(xml: string, runsXml: string): string | null {
  return invoke('injectInkRunsIntoParagraph', [xml, runsXml]) as never
}
