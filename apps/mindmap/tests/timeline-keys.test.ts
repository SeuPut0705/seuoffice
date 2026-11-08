import { describe, expect, it } from 'vitest'
import type { NodeObj } from 'mind-elixir'
import { isArrowKey, timelineArrowTarget } from '../src/renderer/map/timeline-keys'

/** A node with its children, parent links set as the library sets them. */
function node(id: string, children: NodeObj[] = [], extra: Partial<NodeObj> = {}): NodeObj {
  const made = { id, topic: id, children, ...extra } as NodeObj
  for (const child of children) child.parent = made
  return made
}

// centre → main a (a1, a2 (a2x)), main b (folded, b1), main c
const a2x = node('a2x')
const a1 = node('a1')
const a2 = node('a2', [a2x])
const a = node('a', [a1, a2])
const b = node('b', [node('b1')], { expanded: false })
const c = node('c')
const root = node('root', [a, b, c])

const go = (from: NodeObj, key: Parameters<typeof timelineArrowTarget>[1]) =>
  timelineArrowTarget(from, key)?.id ?? null

describe('arrow keys in a timeline', () => {
  it('from the central topic, right or down to the first main topic', () => {
    expect(go(root, 'ArrowRight')).toBe('a')
    expect(go(root, 'ArrowDown')).toBe('a')
    expect(go(root, 'ArrowLeft')).toBeNull()
    expect(go(root, 'ArrowUp')).toBeNull()
  })

  it('along the row of main topics, the first one back to the central topic', () => {
    expect(go(a, 'ArrowRight')).toBe('b')
    expect(go(b, 'ArrowLeft')).toBe('a')
    expect(go(a, 'ArrowLeft')).toBe('root')
    expect(go(c, 'ArrowRight')).toBeNull()
    expect(go(b, 'ArrowUp')).toBe('root')
    expect(go(a, 'ArrowDown')).toBe('a1')
  })

  it('along a column below a main topic, the first one up to its parent', () => {
    expect(go(a1, 'ArrowDown')).toBe('a2')
    expect(go(a2, 'ArrowUp')).toBe('a1')
    expect(go(a1, 'ArrowUp')).toBe('a')
    expect(go(a2, 'ArrowDown')).toBeNull()
    expect(go(a2, 'ArrowLeft')).toBe('a')
    expect(go(a2, 'ArrowRight')).toBe('a2x')
    expect(go(a2x, 'ArrowLeft')).toBe('a2')
  })

  it('never into a folded branch', () => {
    expect(go(b, 'ArrowDown')).toBeNull()
    expect(go(a1, 'ArrowRight')).toBeNull()
  })

  it('knows the four arrow keys only', () => {
    expect(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].every(isArrowKey)).toBe(true)
    expect(isArrowKey('Tab')).toBe(false)
    expect(isArrowKey('Home')).toBe(false)
  })
})
