import { type NoteParagraphReader } from './notes'
import { type BodyElement } from './scan'
import { assertZipWithinLimits } from './zip-load'
import type { ParsedDoc, Run, TableCell } from './types'
import { type ResolveDiff } from './resolve-props'
import { invoke } from './engine'
import * as hand from './engine-hand'

export { resolveMainDocumentPath } from './parse-package'
export { paraCsFormat, styleRunFormat } from './parse-styles'
export { assertZipWithinLimits }
export interface ParseExtras {
  /** ranges of top-level body elements, aligned with docxIndex */
  elements: BodyElement[]
  opaqueRegions: Array<{ start: number; end: number }>
  /** original XML of chart parts referenced by chart blocks (partPath -> xml) */
  chartParts: Record<string, string>
  /** source-document hashes named by lazily served pictures */
  lazyMediaHashes: string[]
  /** HTML/MHT altChunk parts skipped for want of a converter (a Worker parse):
   *  the host reparses on the UI thread, where one is installed */
  altChunksNeedConverter?: number
  /** resolver shadow mode: disagreements between resolve-props and the legacy format path */
  resolveDiff?: ResolveDiff[]
}
export interface ParseOptions {
  /** expand w:altChunk parts into display blocks (off inside the chunk's own parse) */
  expandAltChunks?: boolean
  /** run the property resolver beside the legacy path and collect disagreements in extras.resolveDiff */
  shadowResolve?: boolean
}
export async function parseDocx(
  bytes: Uint8Array,
  options: ParseOptions = {},
): Promise<ParsedDoc & { extras: ParseExtras }> {
  return hand.parseDocx(bytes, options) as never
}
/**
 * Repair grids whose rows do not all span the declared column count (legacy
 * generators emit gridSpan/tblGrid pairs that disagree with the cells' w:tcW).
 * Word lays each such row out from the cells' preferred widths, so the true
 * grid is the union of every row's tcW boundaries; without this, a cell mapped
 * onto a leftover sliver column collapses to one character per line.
 * Mutates the cells' colSpan and returns the rebuilt column widths, or
 * undefined when the grid is already consistent or a width is unresolvable.
 */
export function reconcileGridColumns(
  rows: TableCell[][],
  rowTcws: Array<Array<number | undefined>>,
  gridCols: number[] | undefined,
): number[] | undefined {
  const r = invoke('reconcileGridColumns', [
    rows.map((row) => row.map((cell) => cell.colSpan)),
    rowTcws,
    gridCols,
  ]) as { widths: number[]; spans: number[][] } | null
  if (!r) return undefined
  rows.forEach((row, i) =>
    row.forEach((cell, c) => {
      const span = r.spans[i]![c]!
      if (span > 1) cell.colSpan = span
      else delete cell.colSpan
    }),
  )
  return r.widths
}
/** the <w:drawing> elements of a header/footer part, in the order HfImage.drawing counts them */
export const HF_DRAWING_RE = /<w:drawing[\s>][\s\S]*?<\/w:drawing>/g
/**
 * A HF_DRAWING_RE match the strip can move and resize: one floating picture
 * with its own extents. A text box or group is not one, and neither is a
 * fragment the lazy match cut at the </w:drawing> of a picture nested in a
 * text box (its extents are the box's).
 */
export function hfMovablePictureFrag(frag: string): boolean {
  return invoke('hfMovablePictureFrag', [frag]) as never
}
/** reader for a notes part on its own (no styles: builtin defaults; tests, tools) */
export function standaloneNoteParagraphReader(): NoteParagraphReader {
  const read = ((pXml: string) =>
    invoke('standaloneNoteParagraphReader', [pXml])) as NoteParagraphReader
  return Object.assign(read, { [Symbol.for('seuoffice.standaloneNoteReader')]: true })
}
/** the floating geometry an anchored picture carries on Run.image */
export type RunPictureAnchor = Pick<
  NonNullable<Run['image']>,
  | 'wrap'
  | 'offsetXEmu'
  | 'offsetYEmu'
  | 'relV'
  | 'relH'
  | 'posH'
  | 'posV'
  | 'wrapDistTopEmu'
  | 'wrapDistBottomEmu'
  | 'wrapDistLeftEmu'
  | 'wrapDistRightEmu'
  | 'lineCenterV'
  | 'noOverlap'
>
/**
 * Wrap kind and anchor offsets of a run-level <w:drawing> (empty for an
 * in-line picture). The save diffs the editor's geometry against this, so a
 * picture nobody moved keeps its bytes.
 */
export function runPictureAnchorOf(source: string): RunPictureAnchor {
  return invoke('runPictureAnchorOf', [source]) as never
}
