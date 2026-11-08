/**
 * Where the arrow keys go in a timeline.
 *
 * The library moves through a map drawn downward by its own rule: left and
 * right go to the topic before and after, down into the topics below, up to
 * the parent. That fits the row of main topics of a timeline, but the topics
 * below a main topic stand in a column (see `map.css`), so there the keys
 * would cross the picture: down would go into a topic's children, right to
 * the next one in the column. The controller asks here instead, so every key
 * moves the way the map looks:
 *
 * - the central topic: right or down to the first main topic;
 * - a main topic (the row): left and right along the row, the first one back
 *   to the central topic; up to the central topic; down to its first topic;
 * - a topic below (a column): up and down along the column, the first one up
 *   to its parent; left to its parent; right to its first topic.
 *
 * Down and right go only into a branch that is open. At the end of a row or a
 * column the selection stays.
 */
import type { NodeObj } from 'mind-elixir'

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

function firstOpenChild(node: NodeObj): NodeObj | null {
  if (node.expanded === false) return null
  return node.children?.[0] ?? null
}

function sibling(node: NodeObj, step: -1 | 1): NodeObj | null {
  const siblings = node.parent?.children ?? []
  const at = siblings.indexOf(node)
  return at < 0 ? null : (siblings[at + step] ?? null)
}

/** The topic an arrow key selects from `node` in a timeline; null when the selection stays. */
export function timelineArrowTarget(node: NodeObj, key: ArrowKey): NodeObj | null {
  const parent = node.parent
  if (!parent) {
    return key === 'ArrowRight' || key === 'ArrowDown' ? firstOpenChild(node) : null
  }
  if (!parent.parent) {
    if (key === 'ArrowLeft') return sibling(node, -1) ?? parent
    if (key === 'ArrowRight') return sibling(node, 1)
    if (key === 'ArrowUp') return parent
    return firstOpenChild(node)
  }
  if (key === 'ArrowUp') return sibling(node, -1) ?? parent
  if (key === 'ArrowDown') return sibling(node, 1)
  if (key === 'ArrowLeft') return parent
  return firstOpenChild(node)
}
