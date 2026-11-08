import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../src/store.js'
import type { ChatSkillChip } from '../src/types.js'

describe('skill chips on a user message', () => {
  let tmpDir: string
  let store: ProjectStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'project-store-skills-'))
    store = new ProjectStore(tmpDir)
    store.ensureDefaultProject()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stores the chips with the message and reads them back', () => {
    const skills: ChatSkillChip[] = [
      { id: 'app:minutes', source: 'app', title: '회의록 정리' },
      { id: 'plugin:pk:p', source: 'plugin', title: 'P' },
    ]
    store.appendChatMessage('default', 'c1', { role: 'user', text: 'go', skills })
    store.appendChatMessage('default', 'c1', { role: 'assistant', text: 'done' })
    const [user, reply] = store.loadChat('default', 'c1')
    expect(user?.skills).toEqual(skills)
    expect(reply?.skills).toBeUndefined()
  })

  it('bounds the chips: count, field lengths, malformed entries dropped', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `app:s${i}`,
      source: 'app',
      title: 't'.repeat(300),
    }))
    const raw = [{ id: 7 }, null, { id: 'x'.repeat(600) }, ...many] as unknown as ChatSkillChip[]
    store.appendChatMessage('default', 'c2', { role: 'user', text: 'go', skills: raw })
    store.appendChatMessage('default', 'c2', { role: 'assistant', text: 'ok' })
    const skills = store.loadChat('default', 'c2')[0]?.skills ?? []
    expect(skills).toHaveLength(32)
    expect(skills[0]).toEqual({ id: 'app:s0', source: 'app', title: 't'.repeat(200) })
  })

  it('writes no field for an empty or unusable list', () => {
    store.appendChatMessage('default', 'c3', {
      role: 'user',
      text: 'go',
      skills: [{ id: '' }] as unknown as ChatSkillChip[],
    })
    store.appendChatMessage('default', 'c3', { role: 'assistant', text: 'ok' })
    expect(store.loadChat('default', 'c3')[0]).not.toHaveProperty('skills')
  })
})
