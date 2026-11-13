/**
 * Embedded font extraction — <p:embeddedFontLst> declares document-embedded faces whose
 * fntdata parts are EOT containers. PowerPoint renders missing families with these faces,
 * so fidelity needs them registered for measuring and drawing. Only uncompressed payloads
 * are usable directly; MicroType-Express-compressed EOTs (flag 0x4) inflate through the
 * vendored MTX decoder (vendor/mtx).
 */
import { PackageArchive } from './zip'
import type { Slide } from './types'
import { call } from './engine'

export type EmbeddedFontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic'
export interface EmbeddedFontFace {
  typeface: string
  style: EmbeddedFontStyle
  /** Single-face sfnt bytes (TTF/OTF), ready for opentype.js / FontFace */
  sfnt: Uint8Array
} // TrueType / 'OTTO' / 'true' / 'ttcf'

/** Unwrap an EOT container to its sfnt payload; null when compressed or malformed. */
export function eotToSfnt(bytes: Uint8Array): Uint8Array | null {
  return call('eotToSfnt', [bytes]) as never
}
/**
 * Code points each embedded part must cover, keyed by `${typeface}|${style}`
 * (typeface lower-cased; '*' collects runs with no resolved family). PowerPoint
 * subsets every style file on its own, so a bold run only asks of the bold part.
 */
export type GlyphDemand = Map<string, Set<number>>
/** Code-point lookup over the sfnt's cmap (formats 4 and 12); null when unreadable. */
export function sfntCmapLookup(sfnt: Uint8Array): ((cp: number) => boolean) | null {
  try {
    const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)
    // The lookups pushed below are invoked after this try has returned, so a
    // crafted idRangeOffset/numRanges would throw out of the caller's frame.
    const inBounds = (off: number, len: number) => off >= 0 && off + len <= sfnt.byteLength
    let base = 0
    if (dv.getUint32(0, false) === 0x74746366) base = dv.getUint32(12, false)
    const numTables = dv.getUint16(base + 4, false)
    let cmap = -1
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + 16 * i
      if (dv.getUint32(rec, false) === 0x636d6170) cmap = dv.getUint32(rec + 8, false)
    }
    if (cmap < 0) return null
    const lookups: ((cp: number) => boolean)[] = []
    const n = dv.getUint16(cmap + 2, false)
    for (let i = 0; i < n; i++) {
      const sub = cmap + dv.getUint32(cmap + 4 + 8 * i + 4, false)
      const format = dv.getUint16(sub, false)
      if (format === 4) {
        const segCount = dv.getUint16(sub + 6, false) >> 1
        const ends = sub + 14
        const starts = ends + segCount * 2 + 2
        const deltas = starts + segCount * 2
        const rangeOffsets = deltas + segCount * 2
        if (!inBounds(rangeOffsets, segCount * 2)) continue
        lookups.push((cp) => {
          if (cp > 0xffff) return false
          for (let k = 0; k < segCount; k++) {
            const end = dv.getUint16(ends + k * 2, false)
            if (cp > end) continue
            const start = dv.getUint16(starts + k * 2, false)
            if (cp < start) return false
            const delta = dv.getUint16(deltas + k * 2, false)
            const ro = dv.getUint16(rangeOffsets + k * 2, false)
            if (ro === 0) return ((cp + delta) & 0xffff) !== 0
            const at = rangeOffsets + k * 2 + ro + (cp - start) * 2
            if (!inBounds(at, 2)) return false
            const g = dv.getUint16(at, false)
            return g !== 0 && ((g + delta) & 0xffff) !== 0
          }
          return false
        })
      } else if (format === 12) {
        const nGroups = dv.getUint32(sub + 12, false)
        if (!inBounds(sub + 16, nGroups * 12)) continue
        lookups.push((cp) => {
          for (let k = 0; k < nGroups; k++) {
            const g = sub + 16 + k * 12
            if (!inBounds(g, 12)) return false
            const start = dv.getUint32(g, false)
            const end = dv.getUint32(g + 4, false)
            if (cp >= start && cp <= end) return dv.getUint32(g + 8, false) + (cp - start) !== 0
          }
          return false
        })
      }
    }
    if (!lookups.length) return null
    return (cp) => lookups.some((f) => f(cp))
  } catch {
    return null
  }
}
/**
 * Embedded typefaces whose subsets no longer cover the glyphs the edited text
 * asks of them. Each style is checked against its own part; a style with no
 * part of its own renders from the regular one (synthetic bold/italic). A part
 * that cannot be decoded or has no readable cmap counts as stale when anything
 * demands it: unverifiable is not safe.
 */
export function staleEmbeddedTypefaces(archive: PackageArchive, demand: GlyphDemand): string[] {
  return call('staleEmbeddedTypefaces', [archive, demand], {
    names: ['archive', 'demand'],
  }) as never
}
/**
 * Remove embedded faces from the package: their <p:embeddedFont> entries, font
 * relationships, fntdata parts and [Content_Types] overrides. With no typeface
 * filter every face goes; once no face remains the <p:embeddedFontLst> itself,
 * the embedTrueTypeFonts/saveSubsetFonts attributes and the fntdata Default are
 * dropped too. Idempotent; returns whether anything was removed.
 */
export function stripEmbeddedFonts(
  archive: PackageArchive,
  typefaces?: ReadonlySet<string>,
): boolean {
  return call('stripEmbeddedFonts', [archive, typefaces], { mut: { 0: 'archive' } }) as never
}
/**
 * Save-time guard: an embedded subset cannot grow, so text edited into glyphs
 * it lacks renders as invisible text in WPS (which honors the subset strictly,
 * unlike Chromium's per-glyph fallback in the app). Faces the edits outgrew are
 * stripped so viewers fall back to system fonts; covered faces, and untouched
 * decks, stay byte-identical. Returns the stripped typefaces.
 */
export function stripStaleEmbeddedFonts(
  deck: { slides: Slide[] },
  archive: PackageArchive,
): string[] {
  return call('stripStaleEmbeddedFonts', [deck.slides, archive], { mut: { 1: 'archive' } }) as never
}
/** Usable (uncompressed) embedded faces of a package; empty when none are declared. */
export function listEmbeddedFonts(archive: PackageArchive): EmbeddedFontFace[] {
  return call('listEmbeddedFonts', [archive]) as never
}
