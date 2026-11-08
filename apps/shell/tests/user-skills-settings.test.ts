import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_PROJECT_PREF,
  agentSkillNoticeDue,
  markAgentSkillNoticeSeen,
  readAgentProjectPref,
  readAppSettings,
  readSkillSettings,
  updateSkillSettings,
  writeAgentPrefs,
  writeAgentProjectPref,
  writeSkillSettings,
} from '../src/main/app-settings'

/**
 * The settings values the skills feature adds (spec 10.1, 6.5, 7.2):
 * `skills`, `agentSkillNoticeSeen` and `agentProjectPrefs`.
 */

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skills-settings-'))
  path = join(dir, 'app-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const seed = (value: unknown) => writeFileSync(path, JSON.stringify(value))

describe('skills settings', () => {
  it('reads nothing saved as the initial state', () => {
    expect(readSkillSettings(path)).toEqual({ states: {}, hiddenBuiltins: [] })
  })

  it('drops unknown values and keeps the known ones', () => {
    seed({
      skills: {
        states: {
          'user:notes': { enabled: true, invoke: 'manual' },
          'app:a': { enabled: 'yes', invoke: 'never' },
          'project:p': { enabled: false },
          nonsense: { enabled: false },
        },
        hiddenBuiltins: ['humanizer', 3, 'humanizer'],
      },
    })
    expect(readSkillSettings(path)).toEqual({
      states: { 'user:notes': { enabled: true, invoke: 'manual' }, 'app:a': {} },
      hiddenBuiltins: ['humanizer'],
    })
  })

  it('writes only states that hold something, beside the other settings', () => {
    seed({ language: 'ko' })
    writeSkillSettings(path, {
      states: { 'user:a': { enabled: true }, 'app:b': {} },
      hiddenBuiltins: [],
    })
    expect(readAppSettings(path)).toEqual({
      language: 'ko',
      skills: { states: { 'user:a': { enabled: true } } },
    })
    updateSkillSettings(path, (settings) => settings.hiddenBuiltins.push('humanizer'))
    expect(readSkillSettings(path).hiddenBuiltins).toEqual(['humanizer'])
  })
})

describe('the agent window one-time skills notice', () => {
  it('is due for someone who accepted the agent warning before', () => {
    seed({ agent: { warningAccepted: 1 } })
    expect(agentSkillNoticeDue(path)).toBe(true)
    markAgentSkillNoticeSeen(path)
    expect(agentSkillNoticeDue(path)).toBe(false)
  })

  it('is not due for someone who never accepted the warning', () => {
    seed({ agent: { warningAccepted: 0 } })
    expect(agentSkillNoticeDue(path)).toBe(false)
    expect(agentSkillNoticeDue(join(dir, 'missing.json'))).toBe(false)
  })

  it('is never due for someone accepting the warning for the first time now', () => {
    writeAgentPrefs(path, { warningAccepted: 1 })
    expect(readAppSettings(path).agentSkillNoticeSeen).toBe(true)
    expect(agentSkillNoticeDue(path)).toBe(false)
  })

  it('stays due when an earlier user saves other preferences', () => {
    seed({ agent: { warningAccepted: 1 } })
    writeAgentPrefs(path, { warningAccepted: 1 })
    expect(readAppSettings(path).agentSkillNoticeSeen).toBeUndefined()
    expect(agentSkillNoticeDue(path)).toBe(true)
  })
})

describe('agent project preferences', () => {
  it('gives a folder used for the first time the defaults', () => {
    expect(readAgentProjectPref(path, join(dir, 'project'))).toEqual(DEFAULT_AGENT_PROJECT_PREF)
    expect(DEFAULT_AGENT_PROJECT_PREF).toEqual({ codexWebSearch: 'cached', codexNetwork: false })
  })

  it('remembers each folder on its own and ignores unknown values', () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    writeAgentProjectPref(path, a, { codexNetwork: true })
    writeAgentProjectPref(path, b, { codexWebSearch: 'live' })
    expect(readAgentProjectPref(path, a)).toEqual({ codexWebSearch: 'cached', codexNetwork: true })
    expect(readAgentProjectPref(path, b)).toEqual({ codexWebSearch: 'live', codexNetwork: false })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    raw.agentProjectPrefs = { ...(raw.agentProjectPrefs as object), [a]: { codexWebSearch: 'x' } }
    seed(raw)
    expect(readAgentProjectPref(path, a)).toEqual(DEFAULT_AGENT_PROJECT_PREF)
  })

  it('refuses a relative folder', () => {
    expect(() => writeAgentProjectPref(path, 'relative', { codexNetwork: true })).toThrow()
  })
})
