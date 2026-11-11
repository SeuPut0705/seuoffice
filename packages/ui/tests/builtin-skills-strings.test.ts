import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import {
  BUILTIN_SKILL_NAMES,
  BUILTIN_SKILL_STRINGS,
  builtinSkillDesc,
  isBuiltinSkillName,
  type BuiltinSkillName,
  type BuiltinSkillStringKey,
} from '../src/strings-builtin-skills'

const KEYS = Object.keys(BUILTIN_SKILL_STRINGS.zh) as BuiltinSkillStringKey[]

/** Languages written in another script: a value equal to the English one is an untranslated copy */
const NON_LATIN: readonly Lang[] = ['zh', 'ja', 'ko', 'th', 'ru', 'ar', 'he', 'hi', 'zh-TW']

const MANIFEST = join(__dirname, '../../../apps/shell/resources/builtin-skills/builtin-skills.json')

describe('BUILTIN_SKILL_STRINGS', () => {
  it('covers all 21 ui languages', () => {
    expect(LANGS).toHaveLength(21)
    expect(Object.keys(BUILTIN_SKILL_STRINGS).sort()).toEqual([...LANGS].sort())
  })

  it('has only a description key (no title key) for every built-in skill', () => {
    const expected = BUILTIN_SKILL_NAMES.map((name) => `builtinSkillDesc.${name}`)
    expect([...KEYS].sort()).toEqual(expected.sort())
  })

  it('has every key, non-empty, in every language', () => {
    for (const lang of LANGS) {
      const dict = BUILTIN_SKILL_STRINGS[lang] as Record<string, string>
      expect(Object.keys(dict).sort(), lang).toEqual([...KEYS].sort())
      for (const key of KEYS) {
        expect(dict[key]?.trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('is translated, not copied from English, in every non-Latin-script language', () => {
    for (const lang of NON_LATIN) {
      for (const key of KEYS) {
        expect(BUILTIN_SKILL_STRINGS[lang][key], `${lang}.${key}`).not.toBe(
          BUILTIN_SKILL_STRINGS.en[key],
        )
      }
    }
  })

  it('names no vendor product in any description', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(BUILTIN_SKILL_STRINGS[lang][key], `${lang}.${key}`).not.toMatch(
          /claude|anthropic|openai|chatgpt|codex/i,
        )
      }
    }
  })

  it('resolves descriptions through the accessor', () => {
    expect(builtinSkillDesc('ko', 'humanizer')).toBe(
      '글에서 AI가 쓴 티가 나는 표현을 찾아 내용은 그대로 두고 자연스럽게 고칩니다.',
    )
    expect(builtinSkillDesc('en', 'find-skills')).toMatch(/agent window/)
    expect(isBuiltinSkillName('humanizer')).toBe(true)
    expect(isBuiltinSkillName('docx')).toBe(true)
    expect(isBuiltinSkillName('odt')).toBe(false)
  })

  it('does not limit humanizer to English text, while copy-editing still says English', () => {
    expect(builtinSkillDesc('en', 'humanizer')).toBe(
      'Finds phrasing that sounds AI-written and makes it natural without changing what it says.',
    )
    expect(builtinSkillDesc('en', 'humanizer')).not.toMatch(/english/i)
    expect(builtinSkillDesc('ko', 'humanizer')).not.toMatch(/영어/)
    expect(builtinSkillDesc('en', 'copy-editing')).toMatch(/English/)
    expect(builtinSkillDesc('ko', 'copy-editing')).toMatch(/영어/)
  })

  it('lists the same skills as the shipped builtin-skills.json', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { name: string }[]
    expect(manifest.map((e) => e.name).sort()).toEqual([...BUILTIN_SKILL_NAMES].sort())
  })

  it('scopes each skill written for one editor to that editor, in a standard front matter', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      name: string
      source: string
      agentOnly: boolean
    }[]
    const editors: Record<string, string> = {
      'hwp-document': 'hwp',
      mindmap: 'mindmap',
      diagram: 'diagram',
      'html-document': 'html',
    }
    for (const [name, editor] of Object.entries(editors)) {
      expect(
        manifest.find((e) => e.name === name),
        name,
      ).toMatchObject({ source: 'ieumoffice', agentOnly: false })
      const text = readFileSync(join(MANIFEST, '..', name, 'SKILL.md'), 'utf8')
      const front = text.split('\n---\n')[0]!
      expect(front.split('\n')[1], name).toBe(`name: ${name}`)
      expect(front.split('\n').slice(-2), name).toEqual(['metadata:', `  ieum-editors: ${editor}`])
      // the standard's limit for a description
      const description = /\ndescription: '(.+)'\n/.exec(front)?.[1] ?? ''
      expect(description.length, name).toBeGreaterThan(80)
      expect(description.length, name).toBeLessThanOrEqual(1024)
      // each ends with a check the assistant runs before it answers
      expect(text, name).toMatch(/\n## \d\. Check before you answer \(required\)\n/)
    }
  })

  it('ships the four document skills for the agent window only, as upstream wrote them', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      name: string
      source: string
      license: string
      agentOnly: boolean
      modified: boolean
    }[]
    for (const name of ['docx', 'pptx', 'xlsx', 'pdf']) {
      // their instructions run scripts, which only the agent window does
      expect(
        manifest.find((e) => e.name === name),
        name,
      ).toMatchObject({ license: 'Apache-2.0', agentOnly: true, modified: false })
      expect(builtinSkillDesc('en', name as BuiltinSkillName)).toMatch(/only in the agent window/)
      expect(builtinSkillDesc('ko', name as BuiltinSkillName)).toMatch(/에이전트 창에서만/)
    }
  })
})
