import { call } from './engine'

/** Next p:sldId/@id for a presentation part: max+1, or the lowest free id once a deck sits at the ceiling. */
export function nextSlideId(presXml: string): number {
  return call('nextSlideId', [presXml]) as never
}
/**
 * Whether a slide can be added to this presentation.xml. Not when its slide list is not
 * written with the `p:` prefix (a document in the default namespace, or under another
 * prefix): every writer here addresses the list by that name. Callers ask before they
 * write anything, so a deck that cannot take the slide is left as it was.
 */
export function canListSlide(presXml: string | null): boolean {
  return call('canListSlide', [presXml]) as never
}
/**
 * presentation.xml with the slide of relationship `rid` listed right after the slide of
 * `afterRid` (at the end when that one is not listed), under a slide id not in use. Null
 * when the list cannot be written to (`canListSlide`).
 */
export function withSlideListed(presXml: string, rid: string, afterRid?: string): string | null {
  return call('withSlideListed', [presXml, rid, afterRid]) as never
}
/**
 * presentation.xml without the entry of the slide whose relationship is `rid`. Null when the
 * slide is not listed, so a caller can stop before it removes anything else.
 */
export function withSlideUnlisted(presXml: string, rid: string): string | null {
  return call('withSlideUnlisted', [presXml, rid]) as never
}
