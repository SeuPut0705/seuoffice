// The built-in `html-document` skill (apps/shell/resources/builtin-skills)
// names tools of this editor. This test keeps its words true to the editor.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS } from '../src/renderer/ai/tools'

const SKILL = readFileSync(
  join(__dirname, '../../shell/resources/builtin-skills/html-document/SKILL.md'),
  'utf8',
)

/** `words_like_this` in backticks: the way the skill writes a tool */
const named = (text: string) => [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1])

describe('the built-in html-document skill', () => {
  it('is for the HTML editor', () => {
    expect(SKILL).toMatch(/^---\nname: html-document\n/)
    expect(SKILL).toMatch(/\nmetadata:\n {2}ieum-editors: html\n---\n/)
  })

  it('names only tools this editor has', () => {
    const known = new Set(AGENT_TOOLS.map((tool) => tool.name))
    const words = named(SKILL)
    expect(words).toEqual(
      expect.arrayContaining([
        'plan_page',
        'write_document',
        'apply_ops',
        'check_pages',
        'get_outline',
      ]),
    )
    for (const word of words) expect(known.has(word), word).toBe(true)
  })

  it('names the two things write_document passes to the page writer', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'write_document')!
    const args = Object.keys((tool.inputSchema as { properties: object }).properties)
    expect(args).toEqual(expect.arrayContaining(['plan', 'context']))
    expect(SKILL).toContain('`plan` holds')
    expect(SKILL).toContain('`context` holds')
  })

  it('stays short: a skill sent as a chip rides in the same turn as the request', () => {
    expect(SKILL.length).toBeLessThan(6000)
  })
})
