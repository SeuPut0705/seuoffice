/**
 * An earlier version kept the launcher record and the person's skills in
 * ~/.ieumoffice. Where only that folder exists the app keeps using it as a
 * whole; once ~/.seuoffice exists that one is used. Agent sessions may never
 * reach either.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0' } }))

import { launcherFilePath } from '../src/main/cli-link'
import { agentProtectedPaths, projectFolderProblem } from '../src/main/agent/agent-sessions'
import { createUserSkillsService } from '../src/main/user-skills/user-skills-service'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'home-folder-old-names-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the launcher record', () => {
  it('is in ~/.seuoffice when that holds data, else in an existing ~/.ieumoffice, else in a new ~/.seuoffice', () => {
    const home = temp()
    expect(launcherFilePath({}, home)).toBe(join(home, '.seuoffice', 'launcher'))

    mkdirSync(join(home, '.ieumoffice'))
    expect(launcherFilePath({}, home)).toBe(join(home, '.ieumoffice', 'launcher'))

    mkdirSync(join(home, '.seuoffice'))
    expect(launcherFilePath({}, home)).toBe(join(home, '.ieumoffice', 'launcher'))

    writeFileSync(join(home, '.seuoffice', 'cli-audit.jsonl'), '{}\n')
    expect(launcherFilePath({}, home)).toBe(join(home, '.seuoffice', 'launcher'))
    expect(launcherFilePath({ SEUOFFICE_AUTH_DIR: '/tmp/x' }, home)).toBe(
      join('/tmp/x', 'launcher'),
    )
  })
})

describe('skills made with an earlier version', () => {
  it('are listed as the person’s own, and a skill saved now lands beside them', async () => {
    const root = temp()
    const home = join(root, 'home')
    const old = join(home, '.ieumoffice', 'skills')
    mkdirSync(join(old, 'minutes'), { recursive: true })
    writeFileSync(
      join(old, 'minutes', 'SKILL.md'),
      '---\nname: minutes\ndescription: Takes minutes.\n---\nDo it.\n',
    )
    const service = createUserSkillsService({
      homeDir: () => home,
      builtinDir: () => join(root, 'builtin'),
      settingsPath: () => join(root, 'app-settings.json'),
      tempDir: () => join(root, 'temp'),
      trash: async () => {},
      fetch: () => Promise.reject(new Error('no network in tests')),
    })

    const own = (await service.list()).filter((view) => view.id.startsWith('app:'))
    expect(own.map((view) => view.id)).toEqual(['app:minutes'])

    const saved = await service.saveFromCard({
      title: 'Letter',
      name: 'home-letter',
      description: 'Writes a home letter.',
      body: 'Greet.\n',
      invoke: 'auto',
    })
    expect(saved).toMatchObject({ ok: true })
    expect(existsSync(join(old, 'home-letter', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.seuoffice'))).toBe(false)
  })
})

describe('agent sessions', () => {
  it('never reach the current home folder or the one an earlier version made', () => {
    const home = temp()
    const guards = agentProtectedPaths(home, join(home, 'AppData', 'SeuOffice'))
    for (const name of ['.seuoffice', '.ieumoffice', '.genoffice']) {
      mkdirSync(join(home, name, 'inside'), { recursive: true })
      expect(projectFolderProblem(join(home, name), home, guards), name).toBe('protected')
      expect(projectFolderProblem(join(home, name, 'inside'), home, guards), name).toBe('protected')
    }
  })
})
