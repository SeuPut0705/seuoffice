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
import { attributeOf, creationIdExtXml, creationIdXml, elementRange } from './xml-utils'

/** The uri of the a:ext that holds a shape's a16:creationId. */
const CREATION_ID_URI = '{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}'
const EXT_OPEN = /<a:ext\b(?:[^>"']|"[^"]*"|'[^']*')*>/g
/** A creationId element under whatever prefix the part binds its namespace to. */
const CREATION_ID_TAG = /<(?:[^\s/>:]+:)?creationId\b(?:[^>"']|"[^"]*"|'[^']*')*>/g
const GUID = /^\{?([0-9A-Fa-f-]{36})\}?$/

/**
 * The GUID of the creation id in `own` (a <p:cNvPr> and what it holds): the creationId inside
 * an a:ext whose uri is the creation id's. Both are read as XML reads them (`attributeOf`: any
 * quotes, white space around `=`, decoded once), so another producer's spelling is the same id.
 */
function creationGuidOf(own: string): string | undefined {
  for (const open of own.matchAll(EXT_OPEN)) {
    if (attributeOf(open[0], 'uri') !== CREATION_ID_URI) continue
    const ext = elementRange(own, 'a:ext', open.index)
    if (!ext) continue
    for (const tag of own.slice(ext.contentStart, ext.contentEnd).matchAll(CREATION_ID_TAG)) {
      const guid = GUID.exec(attributeOf(tag[0], 'id') ?? '')?.[1]
      if (guid) return guid
    }
  }
  return undefined
}

/** `xml` with every creation id given a new GUID, however the id is written. */
export function withFreshCreationIds(xml: string): string {
  return xml.replace(CREATION_ID_TAG, (tag) =>
    GUID.test(attributeOf(tag, 'id') ?? '')
      ? tag.replace(
          /(\sid\s*=\s*)(["'])[^"']*\2/,
          (_all, eq: string, quote: string) =>
            `${eq}${quote}{${globalThis.crypto.randomUUID().toUpperCase()}}${quote}`,
        )
      : tag,
  )
}

/** The own <p:cNvPr> block of `xml`: its first cNvPr, from the open tag through its end tag. */
function ownCNvPr(xml: string, from = 0) {
  return elementRange(xml, 'p:cNvPr', from)
}

/** The numeric id a <p:cNvPr> open tag gives, however it is quoted. */
function cNvPrNumber(openTag: string): string | undefined {
  const id = attributeOf(openTag, 'id')
  return id !== undefined && /^\d+$/.test(id) ? id : undefined
}

export function elementDurableId(el: SlideElement): string | null {
  const xml = el.anchor?.originalXml
  if (!xml) {
    // Group children carry no byte slice of their own (it lives inside the parent
    // group's XML); their persisted <p:cNvPr id> — parsed as nvId, unique within
    // the slide part — still identifies them durably. (creationId continuity
    // while grouped is a known follow-up: the GUID sits in the parent's bytes.)
    const nvId = (el as { nvId?: number | string }).nvId
    return nvId != null ? `e_${nvId}` : null
  }
  const own = ownCNvPr(xml)
  if (!own) return null
  const block = xml.slice(own.start, own.end)
  const guid = creationGuidOf(block)
  if (guid) return `e_${guid.slice(0, 8).toLowerCase()}`
  const n = cNvPrNumber(block)
  return n !== undefined ? `e_${n}` : null
}

export function slideDurableId(slide: Slide): string {
  const m = /slide(\d+)\.xml$/.exec(slide.path)
  return m ? `s_${m[1]}` : `s_${slide.path.replace(/[^a-zA-Z0-9]/g, '_')}`
}

/**
 * The pre-upgrade fallback form ("e_<cNvPr id>"), independent of whether a
 * creationId exists. Kept resolvable as an ALIAS after ensureCreationId mints
 * a GUID, so refs held across the upgrade keep working.
 */
export function elementCNvPrId(el: SlideElement): string | null {
  const xml = el.anchor?.originalXml
  if (!xml) {
    const nvId = (el as { nvId?: number | string }).nvId
    return nvId != null ? `e_${nvId}` : null
  }
  const own = ownCNvPr(xml)
  if (!own) return null
  const n = cNvPrNumber(xml.slice(own.start, own.end))
  return n !== undefined ? `e_${n}` : null
}

/** Ref match across all forms: parse-time id, durable GUID, and the cNvPr
    form — the latter stays an alias after ensureCreationId upgrades an
    element to a GUID mid-session, so refs held across the upgrade resolve. */
export function matchesElementRef(el: SlideElement, id: string): boolean {
  return el.id === id || elementDurableId(el) === id || elementCNvPrId(el) === id
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
  const xml = el.anchor?.originalXml
  if (!xml) return
  const own = ownCNvPr(xml)
  if (!own) return
  if (own.contentStart === own.end) {
    // Self-closing: expand into a tag pair carrying the extLst
    const head = xml.slice(own.start, own.end).replace(/\/>$/, '>')
    el.anchor.originalXml =
      xml.slice(0, own.start) + `${head}${creationIdXml()}</p:cNvPr>` + xml.slice(own.end)
    return
  }
  if (creationGuidOf(xml.slice(own.start, own.end))) return
  // extLst has maxOccurs=1: merge into an existing one (decorative/compat extensions) rather
  // than appending a second, invalid, extLst. cNvPr's own extLst is its LAST child: a list
  // that ends where cNvPr's content ends. An earlier one belongs to a nested
  // hlinkClick/hlinkHover and must not receive the GUID. However the list is written (empty,
  // with attributes, with white space in its tags) it is the same list.
  const contentEnd = own.contentStart + xml.slice(own.contentStart, own.contentEnd).trimEnd().length
  for (
    let list = elementRange(xml, 'a:extLst', own.contentStart);
    list && list.end <= contentEnd;
    list = elementRange(xml, 'a:extLst', list.end)
  ) {
    if (list.end !== contentEnd) continue
    el.anchor.originalXml =
      list.contentStart === list.end
        ? xml.slice(0, list.start) +
          xml.slice(list.start, list.end).replace(/\/>$/, '>') +
          `${creationIdExtXml()}</a:extLst>` +
          xml.slice(list.end)
        : xml.slice(0, list.contentEnd) + creationIdExtXml() + xml.slice(list.contentEnd)
    return
  }
  el.anchor.originalXml = xml.slice(0, own.contentEnd) + creationIdXml() + xml.slice(own.contentEnd)
}

/**
 * The <p:cNvPr> block (open tag through end tag) whose own id attribute is exactly `id`. The id
 * is whatever the deck says, so it is compared as text: built into a RegExp, a `(` in it threw,
 * a `.` matched any character (another element answered) and a `$` matched nothing.
 */
function cNvPrWithId(xml: string, id: string): string | undefined {
  for (const open of xml.matchAll(/<p:cNvPr\b[^>]*?(\/?)>/g)) {
    if (attributeOf(open[0], 'id') !== id) continue
    const own = ownCNvPr(xml, open.index)
    return own ? xml.slice(own.start, own.end) : undefined
  }
  return undefined
}

/**
 * Durable id for a group child. Children carry no byte slice of their own —
 * their bytes (including any a16:creationId) live inside the parent group's
 * XML — so locate the child's <p:cNvPr> there by its parsed nvId (unique per
 * slide part) and scope the creationId search to that block. Falls back to
 * elementDurableId's nvId form, so the id is at worst the same as before.
 */
export function groupChildDurableId(grp: SlideElement, child: SlideElement): string | null {
  const nvId = (child as { nvId?: number | string }).nvId
  const xml = grp.anchor?.originalXml
  if (xml && nvId != null) {
    const own = cNvPrWithId(xml, String(nvId))
    const guid = own ? creationGuidOf(own) : undefined
    if (guid) return `e_${guid.slice(0, 8).toLowerCase()}`
  }
  return elementDurableId(child)
}
