// The built-in `diagram` skill (apps/shell/resources/builtin-skills) names
// tools, ops and shapes of this editor. These tests keep its words true to
// the editor.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIAGRAM_OP_NAMES, SHAPE_NAMES } from '@genoffice/drawio-model'
import { DIAGRAM_TOOL_NAMES } from '../src/renderer/ai/diagram-tools'

const SKILL = readFileSync(
  join(__dirname, '../../shell/resources/builtin-skills/diagram/SKILL.md'),
  'utf8',
)

/** `words_like_this` in backticks: the way the skill writes a tool or an op */
const named = (text: string) => [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1])

describe('the built-in diagram skill', () => {
  it('is for the diagram editor', () => {
    expect(SKILL).toMatch(/^---\nname: diagram\n/)
    expect(SKILL).toMatch(/\nmetadata:\n {2}ieum-editors: diagram\n---\n/)
  })

  it('names only tools and ops this editor has', () => {
    const known = new Set<string>([...Object.values(DIAGRAM_TOOL_NAMES), ...DIAGRAM_OP_NAMES])
    const words = named(SKILL)
    expect(words).toEqual(
      expect.arrayContaining(['insert_mermaid', 'add_shape', 'add_edge', 'read_diagram']),
    )
    for (const word of words) expect(known.has(word), word).toBe(true)
  })

  it('gives each shape a meaning by a name add_shape takes', () => {
    const line = SKILL.split('\n').find((l) => l.includes('One meaning per shape'))!
    const shapes = [...line.matchAll(/`([a-z]+)`/g)].map((m) => m[1])
    expect(shapes.length).toBeGreaterThanOrEqual(8)
    for (const shape of shapes) expect(SHAPE_NAMES as readonly string[], shape).toContain(shape)
  })

  it('places default shapes on a grid that leaves the gap the editor asks for', () => {
    // the editor's instructions: a new shape is 120 by 60, 40 to 80 units apart
    expect(SKILL).toContain('`x = 40 + 200 × column`, `y = 40 + 120 × row`')
    expect(200 - 120).toBeLessThanOrEqual(80)
    expect(120 - 60).toBeGreaterThanOrEqual(40)
  })
})
