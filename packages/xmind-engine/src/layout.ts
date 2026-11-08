/**
 * The six arrangements the editor can draw. `tree` lists the topics below
 * their parent along a trunk on its left; `timeline` puts the main topics in
 * a row after the central topic, each with its topics listed below it.
 */
export type ViewLayout = 'left' | 'right' | 'both' | 'down' | 'tree' | 'timeline'

/** Every layout, in the order the editor offers them. */
export const VIEW_LAYOUTS: readonly ViewLayout[] = [
  'right',
  'left',
  'both',
  'down',
  'tree',
  'timeline',
]

/**
 * `structureClass` values the editor draws as they are. These are identifiers
 * of the file format, read and written for compatibility.
 */
const EXACT: Readonly<Record<string, ViewLayout>> = {
  'org.xmind.ui.logic.right': 'right',
  'org.xmind.ui.logic.left': 'left',
  'org.xmind.ui.map': 'both',
  'org.xmind.ui.map.unbalanced': 'both',
  'org.xmind.ui.map.clockwise': 'both',
  'org.xmind.ui.map.anticlockwise': 'both',
  'org.xmind.ui.org-chart.down': 'down',
  'org.xmind.ui.tree.right': 'tree',
  'org.xmind.ui.timeline.horizontal': 'timeline',
}

/** What the editor writes when the user picks a layout. */
const WRITTEN: Readonly<Record<ViewLayout, string>> = {
  left: 'org.xmind.ui.logic.left',
  right: 'org.xmind.ui.logic.right',
  both: 'org.xmind.ui.map.clockwise',
  down: 'org.xmind.ui.org-chart.down',
  tree: 'org.xmind.ui.tree.right',
  timeline: 'org.xmind.ui.timeline.horizontal',
}

/**
 * The layout a `structureClass` is drawn with.
 *
 * `exact` is false when the layout is a stand-in: fishbone, a vertical
 * timeline, table, a tree growing to the left, an upward org chart and
 * anything newer are drawn to both sides, or to the right when their name
 * says they grow that way. A stand-in is never `left`, `down`, `tree` or
 * `timeline`; those are drawn only for the classes that mean exactly that.
 * The file keeps its own value in that case; only a layout the user actually
 * picks may replace it. A topic without the key uses the format's default,
 * the map that spreads to both sides.
 */
export function layoutFromStructureClass(structureClass: unknown): {
  layout: ViewLayout
  exact: boolean
} {
  if (structureClass === undefined) return { layout: 'both', exact: true }
  if (typeof structureClass !== 'string') return { layout: 'both', exact: false }
  if (Object.hasOwn(EXACT, structureClass)) return { layout: EXACT[structureClass]!, exact: true }
  return { layout: structureClass.endsWith('.right') ? 'right' : 'both', exact: false }
}

/** The `structureClass` to write for a layout the user picked. */
export function structureClassForLayout(layout: ViewLayout): string {
  return WRITTEN[layout]
}
