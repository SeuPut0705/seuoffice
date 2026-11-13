/**
 * ISO Strict OOXML (purl.oclc.org URIs) and non-canonical namespace prefixes,
 * normalized to the transitional URIs + canonical prefixes that the rest of
 * the engine matches literally (`w:p`, `wps:wsp`, rel-type strings...). Runs
 * once per XML part at zip load, so parse offsets, patch splices and saved
 * output all see the same bytes.
 */
import { invoke } from './engine'

export function hasUniversalMeasures(xml: string): boolean {
  return invoke('hasUniversalMeasures', [xml]) as never
}
/** Cheap pre-check; normalizeOoxmlXml is only worth calling when this is true. */
export function needsOoxmlNormalization(xml: string): boolean {
  return invoke('needsOoxmlNormalization', [xml]) as never
}
export function canonicalXmlSyntax(xml: string): string {
  return invoke('canonicalXmlSyntax', [xml]) as never
}
export function normalizeOoxmlXml(xml: string): string {
  return invoke('normalizeOoxmlXml', [xml]) as never
}
/** Cheap pre-check; dedupeStyleRefs is only worth calling when this is true. */
export function hasDuplicateStyleRefs(xml: string): boolean {
  return invoke('hasDuplicateStyleRefs', [xml]) as never
}
/**
 * Repeated w:pStyle / w:rStyle children of one property set: Word applies the
 * last one (invalid per schema, written by some Markdown converters as
 * `Heading1` + `MdHeading1`), so the earlier siblings are dropped here and
 * every reader, string or node based, sees the winner.
 */
export function dedupeStyleRefs(xml: string): string {
  return invoke('dedupeStyleRefs', [xml]) as never
}
