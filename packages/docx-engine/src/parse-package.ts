// Package-level parts: main document path, relationships, comments,
// protection settings and numbering definitions.
import JSZip from 'jszip'
import { findChildren, type XNode } from './xml-utils'
import {
  firstMarkLabel,
  hasMarkElement,
  overWithheldModelText,
  parseEntry,
  runsText,
  WITHHELD_ENTRY_TEXT,
  withheldNode,
} from './withheld'
import { patchParagraphTexts } from './text-patch'
import type { DocProtection, WriteProtection } from './types'
import { invoke } from './engine'
import { zipCall } from './engine-hand'

/**
 * Main document part: word/document.xml when present, else the package-level
 * officeDocument relationship target (LO corpus has e.g. word/trial.xml).
 */
export async function resolveMainDocumentPath(zip: JSZip): Promise<string | null> {
  return zipCall('resolveMainDocumentPath', zip, [], false) as never
}
export function resolveRelationshipTargetPath(sourcePath: string, target: string): string | null {
  return invoke('resolveRelationshipTargetPath', [sourcePath, target]) as never
}
/**
 * A comment's text as a model may read it, from the parser's own node: each
 * hidden run as its placeholder, the whole comment withheld when a mark sits
 * where no run accounts for it; undefined when it hides nothing.
 */
function commentModelText(node: XNode): string | undefined {
  if (!hasMarkElement(node)) return undefined
  const view = withheldNode(node)
  return view === null ? WITHHELD_ENTRY_TEXT : findChildren(view, 'w:p').map(runsText).join('\n')
}
/**
 * What a model reads of a marked comment once a person's edit has given it
 * `text`: the save patches the text into the comment's own XML, keeping its
 * runs and their marks (patchParagraphTexts, as buildCommentsXml does). An
 * edit the runs cannot carry is written with every word hidden, and reads so.
 */
export function editedCommentModelText(markedXml: string, text: string): string | undefined {
  const patched = patchParagraphTexts(markedXml, text)
  // an edit the runs cannot carry is saved with every word hidden under the
  // first label (buildCommentsXml), and reads that way now
  const node = patched === null ? undefined : parseEntry(patched)
  const modelText = node
    ? commentModelText(node)
    : overWithheldModelText(text, firstMarkLabel(markedXml))
  return modelText === text ? undefined : modelText
}
/** w:documentProtection from word/settings.xml (editing restriction) */
export async function parseProtection(zip: JSZip): Promise<DocProtection | null> {
  return zipCall('parseProtection', zip, [], false) as never
}
/** w:writeProtection from word/settings.xml (password to modify / read-only recommended) */
export async function parseWriteProtection(zip: JSZip): Promise<WriteProtection | null> {
  return zipCall('parseWriteProtection', zip, [], false) as never
}
