/**
 * The text under a markup annotation (reading-assist spec 4.3): the
 * characters of a page's PDF.js text content whose boxes overlap the
 * annotation's QuadPoints. Everything is in PDF user space, so the page's
 * /Rotate plays no part, and quads written in any corner order (other
 * programs' annotations) read the same. Pure.
 */

/** the fields of a PDF.js getTextContent() text item this module reads */
export interface TextRun {
  str: string
  /** text space → user space: [a, b, c, d, e, f] */
  transform: number[]
  /** advance along the run's baseline, user space */
  width: number
  /** font height, user space */
  height: number
  hasEOL?: boolean
}

type Point = [number, number]

/** a quad's corners as a convex polygon, counter-clockwise; null when degenerate */
function quadPolygon(q: readonly number[]): Point[] | null {
  if (q.length < 8) return null
  const pts: Point[] = [
    [q[0]!, q[1]!],
    [q[2]!, q[3]!],
    [q[4]!, q[5]!],
    [q[6]!, q[7]!],
  ]
  if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null
  const cx = (pts[0]![0] + pts[1]![0] + pts[2]![0] + pts[3]![0]) / 4
  const cy = (pts[0]![1] + pts[1]![1] + pts[2]![1] + pts[3]![1]) / 4
  // sorting by angle around the centre turns "Z" order and any other corner order into a ring
  pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
  let area = 0
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[(i + 1) % 4]!
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) < 1e-6 ? null : pts
}

/** point inside (or on the edge of) a counter-clockwise convex polygon */
function inside(poly: readonly Point[], x: number, y: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!
    const [x2, y2] = poly[(i + 1) % poly.length]!
    if ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) < -1e-6) return false
  }
  return true
}

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/

/**
 * Relative advance widths (1/1000 em) of printable ASCII, from the metrics of
 * a common sans-serif. The text content gives one advance per run, not per
 * glyph; splitting it by these weights keeps a character's estimated box
 * close to where it is drawn even in proportional fonts. Wide scripts count a
 * full em, anything else an average letter.
 */
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

function charWeight(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32]!
  return CJK.test(ch) ? 1000 : 556
}

/** a space between two pieces, unless either side is a space or both are CJK */
function joiner(before: string, after: string): string {
  if (!before || /\s$/.test(before) || /^\s/.test(after)) return ''
  return CJK.test(before.slice(-1)) && CJK.test(after[0] ?? '') ? '' : ' '
}

/**
 * The text whose character boxes overlap the quads, in content order. A
 * character counts when the middle of its box (the run's advance split by
 * relative glyph widths, a little above the baseline) lies inside a quad. Pieces from
 * different lines or apart in a run are joined with a space (none between
 * CJK characters); whitespace is collapsed. '' when nothing lies under the
 * markup (a scanned page).
 */
export function textUnderQuads(runs: readonly TextRun[], quads: readonly number[][]): string {
  const polys = quads.map(quadPolygon).filter((p): p is Point[] => p !== null)
  if (polys.length === 0) return ''
  let out = ''
  /** a break (end of line, skipped run or character) waits before the next piece */
  let gap = false
  let lastRun = -1
  runs.forEach((r, ri) => {
    const chars = [...(r.str ?? '')]
    const tf = r.transform
    if (chars.length === 0 || !(r.width > 0) || !tf || tf.length < 6) {
      if (r.hasEOL && out) gap = true
      return
    }
    const [a, b, c, d, e, f] = tf as [number, number, number, number, number, number]
    const ul = Math.hypot(a, b) || 1
    const vl = Math.hypot(c, d) || 1
    const [ux, uy] = [a / ul, b / ul]
    const [vx, vy] = [c / vl, d / vl]
    const h = r.height > 0 ? r.height : vl
    const weights = chars.map(charWeight)
    const scale = r.width / weights.reduce((sum, w) => sum + w, 0)
    let start = 0
    let skipped = false
    for (let i = 0; i < chars.length; i++) {
      const along = (start + weights[i]! / 2) * scale
      start += weights[i]!
      const up = h * 0.35
      const x = e + ux * along + vx * up
      const y = f + uy * along + vy * up
      if (!polys.some((p) => inside(p, x, y))) {
        if (out) skipped = true
        continue
      }
      const ch = chars[i]!
      if (out && (gap || skipped || (lastRun !== ri && lastRun !== ri - 1))) out += joiner(out, ch)
      out += ch
      gap = false
      skipped = false
      lastRun = ri
    }
    if (r.hasEOL && out) gap = true
  })
  return out.replace(/\s+/g, ' ').trim()
}
