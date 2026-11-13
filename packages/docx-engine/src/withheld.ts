import { placeholderSource } from '@seuoffice/agent-core/redact-core'
import { type XNode } from './xml-utils'
import { invoke, xnodeArg } from './engine'

/**
 * The label of a run whose rPr carries the mark, or null when the run reads as
 * itself. For the rPr the engine's parser serialised (Run.rawRPr), so its
 * spelling is the serialiser's; a mark whose label is not read is withheld as
 * `private`.
 */
export function withheldLabelOf(rPrXml: string | undefined): string | null {
  return invoke('withheldLabelOf', [rPrXml]) as never
}
/** Whether the raw XML holds anything that looks like the mark, comments and CDATA included. */
export function hasWithheldTrace(xml: string): boolean {
  return invoke('hasWithheldTrace', [xml]) as never
}
/** What a model reads for an entry whose marks cannot all be read: the whole entry is withheld. */
export const WITHHELD_ENTRY_TEXT = placeholderSource('private')
/**
 * A parsed entry with every run hidden from AI replaced by a run that holds
 * its placeholder (neighbours under one label as one; everything inside a
 * hidden run goes with it, a nested text box included). Null when a mark sits
 * anywhere but a run's properties or a paragraph mark: the caller withholds
 * the whole entry rather than guess which words it meant.
 */
export function withheldNode(node: XNode): XNode | null {
  return invoke('withheldNode', [xnodeArg(node)]) as never
}
/**
 * The label of the first run marked hidden from AI anywhere in a block's XML
 * (a text box's paragraphs and a field's cached result included); null when no
 * run is. A block shown as a whole unit (a picture, a drawing, a field or
 * control paragraph) has no run of its own for the mark to sit on, and its
 * picture, description, preview text and display data are its runs' content: so
 * the parser asks here, and withholds the whole block under that label. A block
 * that does not parse and shows a trace of the mark is withheld as `private`.
 */
export function withheldBlockLabel(blockXml: string): string | null {
  return invoke('withheldBlockLabel', [blockXml]) as never
}
/** The run text of a subtree as Word shows it: w:t, outside field codes and deletions. */
export function runsText(node: XNode): string {
  return invoke('runsText', [xnodeArg(node)]) as never
}
/** the first element of an XML text (a declaration skipped), parsed; undefined when it does not parse */
export function parseEntry(xml: string): XNode | undefined {
  return invoke('parseEntry', [xml], { undef: true }) as never
}
/**
 * What a model reads of a parsed entry, given how its reader reads text
 * (`textOf`): undefined when the entry carries no mark, else its text with each
 * hidden run as its placeholder, or the whole entry withheld when a mark sits
 * where no run accounts for it. It is defined whenever a mark is there, also
 * when it reads the same as the entry's own words (a hidden run whose words are
 * the placeholder): its presence is how a reader knows the entry hides something.
 */
export function withheldText(node: XNode, textOf: (node: XNode) => string): string | undefined {
  return invoke('withheldText', [xnodeArg(node), textOf], {
    names: ['node', 'textOf'],
    undef: true,
  }) as never
}
/**
 * The run properties of a run a person hid from AI, as the Docs editor writes
 * them: the character border Word draws and the mark carrying the label (the
 * namespace is declared on the part's root when the document is saved). For
 * the writers that export content hidden from AI into a .docx (Markdown, HTML)
 * to give it the mark the readers withhold by.
 */
export function hiddenRunProperties(label: string): string {
  return invoke('hiddenRunProperties', [label]) as never
}
