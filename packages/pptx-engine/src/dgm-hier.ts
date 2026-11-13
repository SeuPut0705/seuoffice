/**
 * Hierarchy-family (orgChart1, and the built-in hierarchy1) diagram layout
 * interpreter.
 *
 * PowerPoint org charts carry the full layout algorithm in diagrams/layoutN.xml:
 * box proportions and gaps as <dgm:constr> factors, and the std/hang branch
 * decision as <dgm:choose> conditions on node depth. This module evaluates those
 * instead of approximating them:
 *  - box h = `h` fact × w (0.5); sibling gap = `sibSp` fact × w (0.21);
 *    row gap = `sp` fact × w (0.21) — all read from the constraint list
 *  - subtrees pack by per-row contours (a hanging overhang may slide under a
 *    sibling's box row), parent centered on the midpoint of its outer children
 *  - `init` auto-branch: deep all-leaf branches hang beside the trunk once the
 *    standard layout reaches 4+ rows (see branchOf)
 *  - hang trunk drops from the hidden rootConnector (left 20% of the box, so
 *    x = left + 0.1w); hanging boxes start at left + 0.25w (PowerPoint measured)
 *  - the whole unit-space layout scales uniformly into the frame and centers
 * All geometry below is in units of one box width.
 */
import { call } from './engine'

/**
 * Hierarchy-family (orgChart1, and the built-in hierarchy1) diagram layout
 * interpreter.
 *
 * PowerPoint org charts carry the full layout algorithm in diagrams/layoutN.xml:
 * box proportions and gaps as <dgm:constr> factors, and the std/hang branch
 * decision as <dgm:choose> conditions on node depth. This module evaluates those
 * instead of approximating them:
 *  - box h = `h` fact × w (0.5); sibling gap = `sibSp` fact × w (0.21);
 *    row gap = `sp` fact × w (0.21) — all read from the constraint list
 *  - subtrees pack by per-row contours (a hanging overhang may slide under a
 *    sibling's box row), parent centered on the midpoint of its outer children
 *  - `init` auto-branch: deep all-leaf branches hang beside the trunk once the
 *    standard layout reaches 4+ rows (see branchOf)
 *  - hang trunk drops from the hidden rootConnector (left 20% of the box, so
 *    x = left + 0.1w); hanging boxes start at left + 0.25w (PowerPoint measured)
 *  - the whole unit-space layout scales uniformly into the frame and centers
 * All geometry below is in units of one box width.
 */

export interface HierTreeNode {
  texts: string[]
  children: HierTreeNode[]
  asst?: boolean
  hierBranch?: string
  spPr?: any
}
export interface HierConstraints {
  boxAspect: number
  sibSp: number
  sp: number
  trunkOff: number
  hangIndent: number
  fontMax: number
}
export interface HierBox {
  node: HierTreeNode
  x: number
  y: number
  w: number
  h: number
}
export interface HierLine {
  x1: number
  y1: number
  x2: number
  y2: number
  /** The child node of the connection this segment draws. Callers rendering
   *  the layout use it to key each segment to the connection's presentation
   *  point; the trunk segment shared by a parent's children points at the
   *  first child. */
  to?: HierTreeNode
}
/** Pull the factors this engine consumes out of the layout part's constraint lists. */
export function parseHierConstraints(layoutXml: string | undefined): HierConstraints {
  return call('parseHierConstraints', [layoutXml]) as never
}
export function layoutHierTree(
  roots: HierTreeNode[],
  cons: HierConstraints,
  frameCx: number,
  frameCy: number,
): {
  boxes: HierBox[]
  lines: Array<{ x: number; y: number; cx: number; cy: number; to?: HierTreeNode }>
  boxW: number
} | null {
  const r = call('layoutHierTree', [roots, cons, frameCx, frameCy]) as never as {
    boxes: Array<{ node: number; x: number; y: number; w: number; h: number }>
    lines: Array<{ x: number; y: number; cx: number; cy: number; to?: number }>
    boxW: number
  } | null
  if (r === null) return null
  const nodes: HierTreeNode[] = []
  const walk = (list: HierTreeNode[]): void => {
    for (const node of list) {
      nodes.push(node)
      walk(node.children)
    }
  }
  walk(roots)
  return {
    boxes: r.boxes.map((b) => ({ ...b, node: nodes[b.node]! })),
    lines: r.lines.map((l) =>
      l.to === undefined ? { x: l.x, y: l.y, cx: l.cx, cy: l.cy } : { ...l, to: nodes[l.to]! },
    ),
    boxW: r.boxW,
  }
}
