// The built-in `mindmap` skill (apps/shell/resources/builtin-skills) names
// tools and edits of this editor and shows an outline for write_map. These
// tests keep the skill's words true to the editor.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { outlineToSheets, type XmindTopic } from '@genoffice/xmind-engine'
import { EDIT_OPS } from '../src/renderer/ai/map-tools'
import { MAP_TOOL_NAMES } from '../src/renderer/ai/mindmap-skill'

const SKILL = readFileSync(
  join(__dirname, '../../shell/resources/builtin-skills/mindmap/SKILL.md'),
  'utf8',
)

/** `words_like_this` in backticks: the way the skill writes a tool or an edit */
const named = (text: string) => [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1])

const subtopics = (topic: XmindTopic): XmindTopic[] => topic.children?.attached ?? []

function everyTopic(topic: XmindTopic): XmindTopic[] {
  return [topic, ...subtopics(topic).flatMap(everyTopic)]
}

describe('the built-in mindmap skill', () => {
  it('is for the mind map editor', () => {
    expect(SKILL).toMatch(/^---\nname: mindmap\n/)
    expect(SKILL).toMatch(/\nmetadata:\n {2}ieum-editors: mindmap\n---\n/)
  })

  it('names only tools and edits this editor has', () => {
    const known = new Set<string>([...Object.values(MAP_TOOL_NAMES), ...EDIT_OPS])
    const words = named(SKILL)
    expect(words).toEqual(expect.arrayContaining(['write_map', 'read_map', 'edit_map']))
    for (const word of words) expect(known.has(word), word).toBe(true)
  })

  it('shows an outline write_map reads as one sheet that follows its own shape rules', () => {
    const outline = SKILL.split('```')[1]!
    const sheets = outlineToSheets(outline, { untitled: 'Untitled' })
    expect(sheets).toHaveLength(1)
    const central = sheets[0]!.rootTopic
    expect(central.title).toBe('Product launch')
    const branches = subtopics(central)
    expect(branches.length).toBeGreaterThanOrEqual(3)
    expect(branches.length).toBeLessThanOrEqual(7)
    const all = everyTopic(central)
    // no only children, and every title is a short keyword phrase
    for (const topic of all) {
      expect(subtopics(topic).length, topic.title).not.toBe(1)
      expect(topic.title.split(/\s+/).length, topic.title).toBeLessThanOrEqual(5)
    }
    // the example shows a note, a label and a link the way the outline writes them
    expect(all.some((topic) => topic.notes?.plain?.content)).toBe(true)
    expect(all.some((topic) => topic.labels?.includes('open'))).toBe(true)
    expect(all.some((topic) => topic.href === 'https://example.com/launch')).toBe(true)
  })
})
