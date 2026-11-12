/**
 * Durable identity (design step 0): ids resolved from the element's own bytes,
 * so they survive save→reopen, reparse, and group/ungroup.
 *
 * - element: the a16:creationId GUID (newborn elements mint one — see
 *   creationIdXml — and PowerPoint writes them too) → "e_<guid8>"; otherwise
 *   the <p:cNvPr id>, also persisted in the XML, unique per slide and stable
 *   across reparses → "e_<n>".
 * - slide: the part path (slide7.xml → "s_7"; save never renames parts).
 *
 * The element search is scoped to the element's OWN <p:cNvPr> (always the
 * first in the fragment): group/SmartArt fragments embed their children's
 * bytes, and a wrapper without a creationId must not inherit a child's GUID —
 * after ungroup that same id would suddenly mean the child.
 */
import type { Slide, SlideElement } from './types'
import { call } from './engine'

/** `xml` with every creation id given a new GUID, however the id is written. */
export function withFreshCreationIds(xml: string): string {
  return call('withFreshCreationIds', [xml]) as never
}
export function elementDurableId(el: SlideElement): string | null {
  return call('elementDurableId', [el]) as never
}
export function slideDurableId(slide: Slide): string {
  return call('slideDurableId', [slide]) as never
}
/**
 * The pre-upgrade fallback form ("e_<cNvPr id>"), independent of whether a
 * creationId exists. Kept resolvable as an ALIAS after ensureCreationId mints
 * a GUID, so refs held across the upgrade keep working.
 */
export function elementCNvPrId(el: SlideElement): string | null {
  return call('elementCNvPrId', [el]) as never
}
/** Ref match across all forms: parse-time id, durable GUID, and the cNvPr
    form — the latter stays an alias after ensureCreationId upgrades an
    element to a GUID mid-session, so refs held across the upgrade resolve. */
export function matchesElementRef(el: SlideElement, id: string): boolean {
  return call('matchesElementRef', [el, id]) as never
}
/**
 * Progressive identity hardening for foreign decks: mint an a16:creationId
 * into the element's OWN <p:cNvPr> when it lacks one. Mutates the anchor and
 * is idempotent — callers invoke it only for elements whose bytes are being
 * rewritten anyway (the patch-save path), so untouched content stays
 * byte-identical on save. extLst is cNvPr's last child, so appending before
 * the close tag keeps schema order (after any hlinkClick).
 */
export function ensureCreationId(el: SlideElement): void {
  return call('ensureCreationId', [el], { mut: { 0: 'json' }, undef: true }) as never
}
/**
 * Durable id for a group child. Children carry no byte slice of their own —
 * their bytes (including any a16:creationId) live inside the parent group's
 * XML — so locate the child's <p:cNvPr> there by its parsed nvId (unique per
 * slide part) and scope the creationId search to that block. Falls back to
 * elementDurableId's nvId form, so the id is at worst the same as before.
 */
export function groupChildDurableId(grp: SlideElement, child: SlideElement): string | null {
  return call('groupChildDurableId', [grp, child]) as never
}