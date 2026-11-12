/**
 * Places the markers (bookmarks, form fields, kept inline elements) of one or
 * more original paragraphs onto one or more edited paragraphs.
 *
 * The editor splits paragraphs (Enter) and joins them (Backspace), so the
 * text a marker belongs to may end up in another paragraph than the one that
 * carries the original's identity. The originals are therefore treated as
 * one text, the edited paragraphs as another; markers are mapped across that
 * text and land in whichever edited paragraph holds their mapped offset. A
 * bookmark pair never spans paragraphs: when its text was split, the pair
 * stays in the paragraph holding most of it (a warning says so).
 */
import type { BridgeMarker, BridgeParagraph, OoxmlToOdfContext } from '../core/convert'
import { alignTexts } from './align'

/** A marker's original XML, placed at an offset of one edited paragraph. */
export interface Placement {
  offset: number
  xml: string
  /** `next`: sits in the spans of the text after it; `prev`: of the text before it */
  attach: 'prev' | 'next'
  /** document order among placements at the same offset */
  seq: number
  /** characters of the edited text the XML replaces (an intact text field) */
  replaces?: number
}

export interface SequencePlacements {
  /** placements per edited paragraph */
  placements: Placement[][]
}

/**
 * Maps the markers of `originals` (consecutive, in order) onto the edited
 * texts `edited` (consecutive, in order).
 */
export function placeMarkers(
  rctx: OoxmlToOdfContext,
  originals: readonly BridgeParagraph[],
  edited: readonly string[],
): SequencePlacements {
  const bases: number[] = []
  let original = ''
  for (const p of originals) {
    bases.push(original.length)
    original += p.text
  }
  const starts: number[] = []
  let text = ''
  for (const t of edited) {
    starts.push(text.length)
    text += t
  }
  const ends = edited.map((t, i) => starts[i] + t.length)
  const align = alignTexts(original, text)
  const out: Placement[][] = edited.map(() => [])

  const last = edited.length - 1
  /** the paragraph for an offset that starts something (the later one at a boundary) */
  const startPiece = (off: number) => {
    for (let k = last; k >= 0; k--) if (starts[k] <= off) return k
    return 0
  }
  /** the paragraph for an offset that ends something (the earlier one at a boundary) */
  const endPiece = (off: number) => {
    for (let k = 0; k <= last; k++) if (starts[k] < off && off <= ends[k]) return k
    return startPiece(off)
  }
  const put = (
    piece: number,
    offset: number,
    xml: string,
    attach: Placement['attach'],
    seq: number,
    replaces?: number,
  ) =>
    out[piece].push({
      offset: offset - starts[piece],
      xml,
      attach,
      seq,
      ...(replaces ? { replaces } : {}),
    })

  originals.forEach((p, pi) => {
    const xml = rctx.part(p.part).xml
    const source = (m: BridgeMarker) => xml.slice(m.start, m.end)
    const base = bases[pi]
    const seqOf = (i: number) => pi * 1_000_000 + i
    p.markers.forEach((m, i) => {
      switch (m.kind) {
        case 'bookmark-start': {
          if (m.pair === null) {
            const a = align.map(base + m.offset, 'start')
            put(startPiece(a), a, source(m), 'next', seqOf(i))
            break
          }
          const end = p.markers[m.pair]
          let a = align.map(base + m.offset, 'start')
          let b = Math.max(a, align.map(base + end.offset, 'end'))
          let pa = startPiece(a)
          const pb = b > a ? endPiece(b) : pa
          if (pa !== pb) {
            // never a pair across paragraphs: keep it where most of its text is
            const inA = ends[pa] - a
            const inB = b - starts[pb]
            if (inA >= inB) b = ends[pa]
            else {
              a = starts[pb]
              pa = pb
            }
            rctx.warn(
              `bookmark "${m.name}" was split by a new paragraph; kept with most of its text`,
            )
          }
          put(pa, a, source(m), 'next', seqOf(i))
          put(pa, b, source(end), 'prev', seqOf(m.pair))
          break
        }
        case 'bookmark-end': {
          if (m.pair !== null) break
          const b = align.map(base + m.offset, 'end')
          put(endPiece(b), b, source(m), 'prev', seqOf(i))
          break
        }
        case 'bookmark':
        case 'keep': {
          const a = align.map(base + m.offset, 'start')
          put(startPiece(a), a, source(m), 'next', seqOf(i))
          break
        }
        case 'text': {
          const a = align.map(base + m.offset, 'start')
          const piece = startPiece(a)
          if (align.intact(base + m.offset, m.length) && a + m.length <= ends[piece])
            put(piece, a, source(m), 'next', seqOf(i), m.length)
          else rctx.warn(`an edited ${m.name} became plain text`)
          break
        }
        // 'handler' markers belong to their converters (run writers, injectors)
      }
    })
  })
  return { placements: out }
}

/** How many characters of each original survive in the edited texts. */
export function keptCharacters(
  originals: readonly BridgeParagraph[],
  edited: readonly string[],
): number[] {
  const original = originals.map((p) => p.text).join('')
  const align = alignTexts(original, edited.join(''))
  let base = 0
  return originals.map((p) => {
    let n = 0
    for (let k = 0; k < p.text.length; k++) if (align.intact(base + k, 1)) n++
    base += p.text.length
    return n
  })
}
