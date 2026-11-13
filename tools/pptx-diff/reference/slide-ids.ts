import { attributeOf } from './xml-utils'

/** ST_SlideId is 256..2147483647. */
const SLIDE_ID_MIN = 256
const SLIDE_ID_MAX = 2147483647

/** Next p:sldId/@id for a presentation part: max+1, or the lowest free id once a deck sits at the ceiling. */
export function nextSlideId(presXml: string): number {
  const used = new Set<number>()
  // The attribute named `id` itself (not `r:id`, whose value may be digits too), with the
  // white space XML allows around `=`.
  for (const m of presXml.matchAll(/<p:sldId\s(?:[^>]*\s)?id\s*=\s*(?:"(\d+)"|'(\d+)')/g)) {
    // Out-of-range values are invalid per ST_SlideId; ignoring them keeps a
    // single hostile attribute from forcing the ceiling scan below.
    const n = Number(m[1] ?? m[2])
    if (Number.isSafeInteger(n) && n >= SLIDE_ID_MIN && n <= SLIDE_ID_MAX) used.add(n)
  }
  // Loop-based max: spreading `used` into Math.max overflows the call stack
  // on decks with hundreds of thousands of slides.
  let max = SLIDE_ID_MIN - 1
  for (const n of used) if (n > max) max = n
  let id = max + 1
  if (id > SLIDE_ID_MAX) {
    id = SLIDE_ID_MIN
    while (used.has(id)) {
      id++
      if (id > SLIDE_ID_MAX) throw new Error('pptx: slide id space exhausted')
    }
  }
  return id
}

/** The slide list of presentation.xml as this engine writes to it: `p:` prefixed, with content or empty. */
const SLIDE_LIST = /<p:sldIdLst\s*>[\s\S]*?<\/p:sldIdLst\s*>/
/** One entry of the list: empty, or holding an extension list. */
const SLIDE_ENTRY = /<p:sldId\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldId\s*>)/g

/** The entry of the slide whose relationship is `rid`, with its offset in presentation.xml. */
function entryOf(presXml: string, rid: string): { at: number; xml: string } | null {
  const list = SLIDE_LIST.exec(presXml)
  if (!list) return null
  for (const entry of list[0].matchAll(SLIDE_ENTRY)) {
    if (attributeOf(entry[0], 'r:id') === rid) {
      return { at: list.index + entry.index, xml: entry[0] }
    }
  }
  return null
}

/**
 * Whether a slide can be added to this presentation.xml. Not when its slide list is not
 * written with the `p:` prefix (a document in the default namespace, or under another
 * prefix): every writer here addresses the list by that name. Callers ask before they
 * write anything, so a deck that cannot take the slide is left as it was.
 */
export function canListSlide(presXml: string | null): boolean {
  return presXml !== null && SLIDE_LIST.test(presXml)
}

/**
 * presentation.xml with the slide of relationship `rid` listed right after the slide of
 * `afterRid` (at the end when that one is not listed), under a slide id not in use. Null
 * when the list cannot be written to (`canListSlide`).
 */
export function withSlideListed(presXml: string, rid: string, afterRid?: string): string | null {
  const list = SLIDE_LIST.exec(presXml)
  if (!list) return null
  let at = list.index + list[0].lastIndexOf('</p:sldIdLst')
  const after = afterRid === undefined ? null : entryOf(presXml, afterRid)
  if (after) at = after.at + after.xml.length
  const added = `<p:sldId id="${nextSlideId(presXml)}" r:id="${rid}"/>`
  return presXml.slice(0, at) + added + presXml.slice(at)
}

/**
 * presentation.xml without the entry of the slide whose relationship is `rid`. Null when the
 * slide is not listed, so a caller can stop before it removes anything else.
 */
export function withSlideUnlisted(presXml: string, rid: string): string | null {
  const entry = entryOf(presXml, rid)
  if (!entry) return null
  return presXml.slice(0, entry.at) + presXml.slice(entry.at + entry.xml.length)
}
