import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubSkillUpdateCheck } from '@genoffice/ai-provider'
import {
  createUserSkillsService,
  type UserSkillsService,
} from '../src/main/user-skills/user-skills-service'

/**
 * What stays when another version takes an own skill's place (decision 0127):
 * a reinstall over the same name and a GitHub update keep on/off, when it is
 * used and where it is used; a skill that is new starts as its source starts.
 */

let root: string
let home: string
let service: UserSkillsService

const appDir = () => join(home, '.ieumoffice', 'skills')

function skillMd(name: string, extra = '', body = 'Do it.\n') {
  return `---\nname: ${name}\ndescription: About ${name}\n${extra}---\n${body}`
}

function write(dir: string, text: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-replace-'))
  home = join(root, 'home')
  service = createUserSkillsService({
    homeDir: () => home,
    builtinDir: () => undefined,
    settingsPath: () => join(root, 'app-settings.json'),
    tempDir: () => join(root, 'temp'),
    trash: vi.fn(async (path: string) => rmSync(path, { recursive: true, force: true })),
    fetch: () => Promise.reject(new Error('no network in tests')),
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const viewOf = async (id: string) => (await service.list()).find((view) => view.id === id)
const installedText = (name: string) => readFileSync(join(appDir(), name, 'SKILL.md'), 'utf8')

/** A folder outside the app's skills folder holding the given skills, as a zip would unpack */
function incoming(skills: Record<string, string>): string {
  const folder = mkdtempSync(join(root, 'incoming-'))
  for (const [name, text] of Object.entries(skills)) write(join(folder, name), text)
  return folder
}

async function installAll(folder: string, onCollision: Record<string, 'replace' | 'skip'> = {}) {
  const imported = await service.prepare({ kind: 'folder', folder })
  return service.install(imported, {
    selected: imported.candidates.map((candidate) => candidate.key),
    onCollision,
  })
}

describe('replacing an own skill by installing the same name again', () => {
  beforeEach(async () => {
    await installAll(incoming({ deck: skillMd('deck'), weekly: skillMd('weekly') }))
    await service.save({
      id: 'app:deck',
      title: '',
      description: 'About deck',
      body: 'Do it.\n',
      editors: ['slides'],
    })
    await service.setState('app:weekly', { enabled: false })
    await service.setState('app:deck', { invoke: 'manual' })
  })

  it('keeps on/off, when it is used and where it is used', async () => {
    const again = incoming({
      deck: skillMd('deck', '', 'Do it better.\n'),
      weekly: skillMd('weekly', '', 'Weekly, again.\n'),
    })
    const done = await installAll(again, { deck: 'replace', weekly: 'replace' })
    expect(done).toMatchObject({ ok: true, skipped: [] })

    expect(installedText('deck')).toContain('Do it better.')
    expect(await viewOf('app:deck')).toMatchObject({
      enabled: true,
      invoke: 'manual',
      editors: ['slides'],
    })
    expect(await viewOf('app:weekly')).toMatchObject({ enabled: false, invoke: 'auto' })
    // the editor screen reads the file, so the kept value is there too
    const read = await service.read('app:deck')
    expect(read).toMatchObject({
      ok: true,
      skill: { editors: ['slides'], body: 'Do it better.\n' },
    })
  })

  it('lets a where-used value the new file brings win over the old one', async () => {
    const again = incoming({ deck: skillMd('deck', 'metadata:\n  ieum-editors: docs sheets\n') })
    await installAll(again, { deck: 'replace' })
    expect((await viewOf('app:deck'))?.editors).toEqual(['docs', 'sheets'])
    expect(installedText('deck')).toContain('ieum-editors: docs sheets')
  })

  it('writes the kept where-used value beside the metadata the new file has', async () => {
    const again = incoming({
      deck: skillMd('deck', 'license: MIT\nmetadata:\n  author: someone\n'),
    })
    await installAll(again, { deck: 'replace' })
    expect(installedText('deck')).toContain(
      'license: MIT\nmetadata:\n  author: someone\n  ieum-editors: slides\n',
    )
  })

  it('leaves a skipped skill and its settings alone', async () => {
    const again = incoming({ deck: skillMd('deck', '', 'Other.\n') })
    const done = await installAll(again, { deck: 'skip' })
    expect(done).toMatchObject({ ok: true, installed: [], skipped: ['deck'] })
    expect(installedText('deck')).toContain('Do it.')
    expect(await viewOf('app:deck')).toMatchObject({ invoke: 'manual', editors: ['slides'] })
  })
})

describe('a skill that is new', () => {
  it('starts on, used on its own, in every editor', async () => {
    await installAll(incoming({ fresh: skillMd('fresh') }))
    const view = await viewOf('app:fresh')
    expect(view).toMatchObject({ enabled: true, invoke: 'auto' })
    expect(view?.editors).toBeUndefined()
  })

  it('does not take the settings a removed skill of that name left behind', async () => {
    await installAll(incoming({ fresh: skillMd('fresh') }))
    await service.setState('app:fresh', { enabled: false, invoke: 'manual' })
    // the folder goes away outside the app, so the saved state stays in the settings file
    rmSync(join(appDir(), 'fresh'), { recursive: true, force: true })
    await installAll(incoming({ fresh: skillMd('fresh') }))
    expect(await viewOf('app:fresh')).toMatchObject({ enabled: true, invoke: 'auto' })
  })
})

describe('a GitHub update', () => {
  async function changedCheck(folder: string) {
    const update = await service.prepare({ kind: 'folder', folder: join(folder, 'deck') })
    const check: Extract<GitHubSkillUpdateCheck, { status: 'changed' }> = {
      status: 'changed',
      record: {
        kind: 'github',
        repo: 'owner/repo',
        ref: 'main',
        path: '',
        commit: 'a'.repeat(40),
        installedAt: '2026-11-10T00:00:00Z',
        contentHash: 'x',
      },
      commit: 'b'.repeat(40),
      locallyEdited: false,
      changedFiles: [{ rel: 'SKILL.md', change: 'modified' }],
      update,
    }
    return check
  }

  it('keeps the same settings a reinstall keeps', async () => {
    await installAll(incoming({ deck: skillMd('deck') }))
    await service.save({
      id: 'app:deck',
      title: '',
      description: 'About deck',
      body: 'Do it.\n',
      editors: ['slides'],
    })
    await service.setState('app:deck', { enabled: false, invoke: 'manual' })

    const check = await changedCheck(incoming({ deck: skillMd('deck', '', 'Updated.\n') }))
    expect(await service.applyUpdate('app:deck', check)).toEqual({ ok: true, id: 'app:deck' })

    expect(installedText('deck')).toContain('Updated.')
    expect(await viewOf('app:deck')).toMatchObject({
      enabled: false,
      invoke: 'manual',
      editors: ['slides'],
    })
  })

  it('carries the settings to the new name when the update renames the skill', async () => {
    await installAll(incoming({ deck: skillMd('deck', 'metadata:\n  ieum-editors: slides\n') }))
    await service.setState('app:deck', { invoke: 'manual' })

    const check = await changedCheck(incoming({ deck: skillMd('deck-two') }))
    expect(await service.applyUpdate('app:deck', check)).toEqual({ ok: true, id: 'app:deck-two' })
    expect(await viewOf('app:deck-two')).toMatchObject({ invoke: 'manual', editors: ['slides'] })
  })
})
