/**
 * Reading and writing the "withheld from the model" marker.
 *
 * A span is a *mark over real words*, not a replacement for them: the deck and
 * the .pptx on disk keep the actual text, and only the model's view swaps it for
 * `{{label}}`. Losing the reader's own data to hide it from a model would be the
 * worse failure, so nothing here ever removes content.
 *
 * ## Why the marker has to be modelled
 *
 * The obvious idea is to leave the mark in the XML and let it ride along, the way
 * the engine already passes untouched `ByteAnchor.originalXml` through verbatim.
 * That works for a save that patches in place, and this engine was measured to
 * confirm it — but it breaks on the other path:
 *
 * - `patchTextElementXml` takes its **aligned** path when the model and the XML
 *   have the same number of runs, and patches each `<a:t>` in place. An
 *   `<a:extLst>` already inside `<a:rPr>` survives: the patcher rewrites the
 *   attributes it manages and keeps the rest of the node's inner XML.
 * - When the run count changes — splitting a run in half is exactly what marking
 *   half a word does — it falls through to `rebuildTxBody`, which regenerates
 *   `<a:txBody>` from the model. Anything the model does not carry is gone.
 *
 * So the mark is read into the model on parse and written back on save, in both
 * paths. The same measurement showed the visible half is not free either: the
 * patch path writes `u="none"` for a run whose model does not carry `underline`,
 * so the underline that shows the span has to be set by the caller as well.
 *
 * ## Where it lives
 *
 * `<a:extLst><a:ext uri="…"><go:redact label="…"/></a:ext></a:extLst>` inside
 * the run's `<a:rPr>`, or inside the element's `<p:spPr>` for a picture. `a:extLst`
 * is the OOXML extension list — the schema's own slot for things it does not
 * know — so PowerPoint round-trips the file without noticing, and fast-xml-parser
 * hands the label back on the way in (verified: no element whitelist, so the
 * node survives parsing).
 *
 * `w:bdr` in docx and an inline `<span data-redaction>` in markdown are the same
 * idea in their own formats; the underline here is the counterpart of the
 * character border there.
 */
import { call } from './engine'

/**
 * A fixed URI for our extension. Office's convention is that the `uri` is a
 * GUID identifying the extension's schema, so it must be stable: a deck that
 * round-trips through this engine has to land on the same value.
 */
export { REDACT_EL, REDACT_NS_WRITTEN, REDACT_PREFIX } from '@seuoffice/agent-core/redact-range'
export const REDACT_EXT_URI = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'
/**
 * The whole extension node, for splicing into an `<a:extLst>`.
 *
 * The namespace is declared on the `a:ext` itself rather than on the part root:
 * `a:extLst` is OOXML's own extension point, and a consumer is required to skip
 * content in an `<a:ext>` whose `uri` it does not know, so no `mc:Ignorable` is
 * needed — only that the prefix resolves.
 */
export function redactExtXml(label: string): string {
  return call('redactExtXml', [label]) as never
}
/** True when the fragment already carries our mark. */
export function hasRedactExtIn(xml: string): boolean {
  return call('hasRedactExtIn', [xml]) as never
}
/**
 * Sync our mark on the element named `tag` inside `xml` — `a:rPr` for a run, the
 * picture's `p:spPr` for media. A `label` of undefined removes it.
 *
 * Both save paths call this: the aligned patch path, which would otherwise leave
 * a mark the model no longer claims, and the rebuild path, which has just
 * regenerated the node from the model and needs the mark put back.
 */
export function syncRedactExt(xml: string, tag: string, label?: string): string {
  return call('syncRedactExt', [xml, tag, label]) as never
}
/** The label, read out of an already-parsed `<a:rPr>` / `<p:spPr>` node. */
export function readRedactLabel(node: unknown): string | undefined {
  return call('readRedactLabel', [node], { undef: true }) as never
}
/** Remove our extension from a raw `<a:rPr>` / `<p:spPr>` string, leaving everything else. */
export function stripRedactExt(xml: string): string {
  return call('stripRedactExt', [xml]) as never
}
/**
 * Put the mark in a raw `<a:rPr>` (or `<p:spPr>`) string, replacing any previous one.
 *
 * The `inner` of the node is preserved verbatim; only our own extension is added
 * or swapped. A self-closing `<a:rPr/>` gains a paired form because the mark
 * needs a child.
 */
export function setRedactExt(propsXml: string, label: string): string {
  return call('setRedactExt', [propsXml, label]) as never
}