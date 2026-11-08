/**
 * The markers of a topic, drawn by this app.
 *
 * A file names a marker by an id (`priority-1`, `task-half`, `flag-red`). The
 * ids are part of the file format; the pictures are not, and none is taken
 * from another program. Every glyph below is this project's own drawing on a
 * 16-unit grid, built element by element. Four families have glyphs of their
 * own (priority, progress, flag, star); any other id is drawn as one common
 * mark, so the reader sees that the topic carries a marker.
 *
 * The colours are document content: plain values, the same under the app's
 * light and dark setting. Nothing of the id itself reaches the page: the id is
 * looked up, and only values from the tables below are drawn.
 *
 * A coloured glyph can land on a topic filled with that very colour. So each
 * one is drawn over a slightly larger copy of its own outline (the halo),
 * which `map.css` paints in the map's ground colour: on the ground it cannot
 * be seen, on a fill it keeps the glyph apart from it.
 */

const SVG = 'http://www.w3.org/2000/svg'

export type MarkerGlyph =
  | { family: 'priority'; level: number }
  /** how much is done, in eighths: 0 (not started) to 8 (done) */
  | { family: 'progress'; eighths: number }
  | { family: 'flag'; color: string }
  | { family: 'star'; color: string }
  | { family: 'other' }

const INK_LIGHT = '#ffffff'
const INK_DARK = '#1f2328'

/** Priority 1 to 9: from urgent and warm to quiet and grey. */
const PRIORITY: readonly { fill: string; ink: string }[] = [
  { fill: '#d64541', ink: INK_LIGHT },
  { fill: '#e0762b', ink: INK_LIGHT },
  { fill: '#e2b322', ink: INK_DARK },
  { fill: '#3f9a52', ink: INK_LIGHT },
  { fill: '#1f8f8a', ink: INK_LIGHT },
  { fill: '#2f6fc4', ink: INK_LIGHT },
  { fill: '#5a4fc0', ink: INK_LIGHT },
  { fill: '#6d7480', ink: INK_LIGHT },
  { fill: '#c3c8d0', ink: INK_DARK },
]

/** The steps of progress the format names, as eighths done. */
const PROGRESS: Readonly<Record<string, number>> = {
  'task-start': 0,
  'task-oct': 1,
  'task-quarter': 2,
  'task-3oct': 3,
  'task-half': 4,
  'task-5oct': 5,
  'task-3quar': 6,
  'task-7oct': 7,
  'task-done': 8,
}
const PROGRESS_COLOR = '#2f6fc4'

/** The colour names flags and stars come in, each with this app's own value. */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  red: '#d64541',
  orange: '#e0762b',
  yellow: '#e2b322',
  green: '#3f9a52',
  'dark-green': '#1f6b45',
  blue: '#2f8fd6',
  'dark-blue': '#2a4f9e',
  purple: '#8250c4',
  pink: '#d9609a',
  gray: '#8a919c',
  'dark-gray': '#4b5360',
}

/** Which glyph a marker id is drawn with. An id this app does not know is `other`. */
export function markerGlyph(id: unknown): MarkerGlyph {
  if (typeof id !== 'string') return { family: 'other' }
  const priority = /^priority-([1-9])$/.exec(id)
  if (priority) return { family: 'priority', level: Number(priority[1]) }
  if (Object.hasOwn(PROGRESS, id)) return { family: 'progress', eighths: PROGRESS[id]! }
  const named = /^(flag|star)-([a-z]+(?:-[a-z]+)?)$/.exec(id)
  if (named && Object.hasOwn(NAMED_COLORS, named[2]!)) {
    return { family: named[1] as 'flag' | 'star', color: NAMED_COLORS[named[2]!]! }
  }
  return { family: 'other' }
}

function shape(
  doc: Document,
  name: string,
  attributes: Readonly<Record<string, string | number>>,
): SVGElement {
  const element = doc.createElementNS(SVG, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

/** The class of a halo; `map.css` gives it the ground colour. Without that rule it is not drawn at all. */
export const MARKER_HALO_CLASS = 'mm-marker-halo'

/** An outline to lay under a glyph: the given shape, drawn `spread` wider all round. */
function halo(
  doc: Document,
  name: string,
  attributes: Readonly<Record<string, string | number>>,
  spread: number,
): SVGElement {
  return shape(doc, name, {
    ...attributes,
    class: MARKER_HALO_CLASS,
    fill: 'none',
    stroke: 'none',
    'stroke-width': spread * 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  })
}

const FLAG_CLOTH = 'M4 3.2H12.6L10.5 6 12.6 8.8H4Z'
const FLAG_POLE = 'M4 2.4V13.8'

/** A five-pointed star around (8, 8.4), as a path. */
function starPath(): string {
  const points: string[] = []
  for (let corner = 0; corner < 10; corner++) {
    const radius = corner % 2 === 0 ? 6.4 : 2.9
    const angle = (Math.PI / 5) * corner - Math.PI / 2
    const x = 8 + radius * Math.cos(angle)
    const y = 8.4 + radius * Math.sin(angle)
    points.push(`${corner === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return `${points.join(' ')}Z`
}

/** The wedge of a disc around (8, 8) that is `eighths` of the way round, from the top, clockwise. */
function wedgePath(eighths: number, radius: number): string {
  const angle = (Math.PI / 4) * eighths
  const x = 8 + radius * Math.sin(angle)
  const y = 8 - radius * Math.cos(angle)
  return `M8 8L8 ${8 - radius}A${radius} ${radius} 0 ${eighths > 4 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`
}

function draw(doc: Document, glyph: MarkerGlyph): SVGElement[] {
  switch (glyph.family) {
    case 'priority': {
      const { fill, ink } = PRIORITY[glyph.level - 1]!
      const digit = shape(doc, 'text', {
        x: 8,
        y: 8,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': 10.5,
        'font-weight': 700,
        fill: ink,
      })
      digit.textContent = String(glyph.level)
      return [
        halo(doc, 'circle', { cx: 8, cy: 8, r: 7 }, 1),
        shape(doc, 'circle', { cx: 8, cy: 8, r: 7, fill }),
        digit,
      ]
    }
    case 'progress': {
      const ring = shape(doc, 'circle', {
        cx: 8,
        cy: 8,
        r: 6.25,
        fill: glyph.eighths === 8 ? PROGRESS_COLOR : 'none',
        stroke: PROGRESS_COLOR,
        'stroke-width': 1.5,
      })
      // the disc under the ring is the ground's colour too, so the part not yet done reads as empty
      const under = halo(doc, 'circle', { cx: 8, cy: 8, r: 7 }, 1)
      if (glyph.eighths === 0) return [under, ring]
      if (glyph.eighths === 8) {
        return [
          under,
          ring,
          shape(doc, 'path', {
            d: 'M4.9 8.3 7.1 10.5 11.2 5.9',
            fill: 'none',
            stroke: INK_LIGHT,
            'stroke-width': 1.6,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
        ]
      }
      return [
        under,
        ring,
        shape(doc, 'path', { d: wedgePath(glyph.eighths, 3.9), fill: PROGRESS_COLOR }),
      ]
    }
    case 'flag':
      return [
        halo(doc, 'path', { d: FLAG_CLOTH }, 1.6),
        halo(doc, 'path', { d: FLAG_POLE }, 1.8),
        shape(doc, 'path', {
          d: FLAG_CLOTH,
          fill: glyph.color,
          stroke: glyph.color,
          'stroke-width': 1.2,
          'stroke-linejoin': 'round',
        }),
        shape(doc, 'path', {
          d: FLAG_POLE,
          fill: 'none',
          stroke: glyph.color,
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
        }),
      ]
    case 'star':
      return [
        halo(doc, 'path', { d: starPath() }, 1.6),
        shape(doc, 'path', {
          d: starPath(),
          fill: glyph.color,
          stroke: glyph.color,
          'stroke-width': 1.2,
          'stroke-linejoin': 'round',
        }),
      ]
    case 'other':
      // one quiet mark in the text colour of its topic, readable on any fill
      return [
        shape(doc, 'circle', {
          cx: 8,
          cy: 8,
          r: 5.75,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.5,
        }),
        shape(doc, 'circle', { cx: 8, cy: 8, r: 1.9, fill: 'currentColor' }),
      ]
  }
}

/** The glyph of a marker as an element. `label` is what assistive technology reads for it. */
export function markerElement(doc: Document, id: unknown, label: string): SVGElement {
  const glyph = markerGlyph(id)
  const svg = shape(doc, 'svg', {
    class: 'mm-marker',
    viewBox: '0 0 16 16',
    role: 'img',
    'aria-label': label,
    focusable: 'false',
  })
  svg.dataset.markerFamily = glyph.family
  for (const part of draw(doc, glyph)) svg.appendChild(part)
  return svg
}
