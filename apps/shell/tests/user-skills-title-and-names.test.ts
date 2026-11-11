import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUserSkillsService,
  type UserSkillsService,
} from '../src/main/user-skills/user-skills-service'

/**
 * What a save writes for the title of an own skill (decision 0128), and the
 * question a save answers with when an enabled skill of another source has
 * the name.
 */

let root: string
let home: string
let builtin: string
let service: UserSkillsService

const appDir = () => join(home, '.ieumoffice', 'skills')
const fileOf = (name: string) => readFileSync(join(appDir(), name, 'SKILL.md'), 'utf8')
const viewOf = async (id: string) => (await service.list()).find((view) => view.id === id)

function skill(dir: string, name: string, extra = '') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: About ${name}\n${extra}---\nDo it.\n`,
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-title-'))
  home = join(root, 'home')
  builtin = join(root, 'builtin')
  skill(join(builtin, 'humanizer'), 'humanizer')
  writeFileSync(
    join(builtin, 'builtin-skills.json'),
    JSON.stringify([{ name: 'humanizer', agentOnly: false }]),
  )
  skill(join(home, '.claude', 'skills', 'weekly'), 'weekly')
  service = createUserSkillsService({
    homeDir: () => home,
    builtinDir: () => builtin,
    settingsPath: () => join(root, 'app-settings.json'),
    tempDir: () => join(root, 'temp'),
    trash: vi.fn(async (path: string) => rmSync(path, { recursive: true, force: true })),
    fetch: () => Promise.reject(new Error('no network in tests')),
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the title of an own skill', () => {
  it('is written in any language beside the name the person gave', async () => {
    const saved = await service.save({
      title: '가정통신문 쓰기',
      name: 'home-letter',
      description: 'Writes the letter',
      body: 'Steps.\n',
    })
    expect(saved).toEqual({ ok: true, id: 'app:home-letter' })
    expect(fileOf('home-letter')).toBe(
      '---\nname: home-letter\ndescription: Writes the letter\nmetadata:\n  ieum-title: 가정통신문 쓰기\n---\nSteps.\n',
    )
    expect(await viewOf('app:home-letter')).toMatchObject({
      name: 'home-letter',
      title: '가정통신문 쓰기',
    })
  })

  it('gets a name the app makes up when the title has no letters a name can hold', async () => {
    const saved = await service.save({ title: '주간 보고', description: 'd', body: 'b' })
    expect(saved.ok && saved.id).toMatch(/^app:skill-[a-z0-9]{6}$/)
    const view = await viewOf(saved.ok ? saved.id : '')
    expect(view?.title).toBe('주간 보고')
  })

  it('changes with an edit and leaves the rest of the front matter as written', async () => {
    const before =
      '---\nname: deck\ndescription: "Makes decks: slides"\nlicense: MIT\nmetadata:\n  author: kim\n  ieum-title: 발표\n---\nSteps.\n'
    mkdirSync(join(appDir(), 'deck'), { recursive: true })
    writeFileSync(join(appDir(), 'deck', 'SKILL.md'), before)
    const edit = (title: string) =>
      service.save({
        id: 'app:deck',
        title,
        description: 'Makes decks: slides',
        body: 'Steps.\n',
      })

    expect(await edit('발표 자료 만들기')).toMatchObject({ ok: true })
    expect(fileOf('deck')).toBe(before.replace('ieum-title: 발표', 'ieum-title: 발표 자료 만들기'))

    // an emptied title takes the key out, and nothing else
    expect(await edit('  ')).toMatchObject({ ok: true })
    expect(fileOf('deck')).toBe(before.replace('  ieum-title: 발표\n', ''))
    expect((await viewOf('app:deck'))?.title).toBe('deck')
  })

  it('goes into the file from a skill card too', async () => {
    const saved = await service.saveFromCard({
      title: '회의록',
      name: 'minutes',
      description: 'd',
      body: 'b',
      invoke: 'auto',
    })
    expect(saved).toMatchObject({ ok: true })
    expect(fileOf('minutes')).toContain('ieum-title: 회의록')
  })
})

describe('saving an own skill under a name another enabled skill has', () => {
  const mine = (name: string, turnOffSameName?: boolean) =>
    service.save({
      title: '',
      name,
      description: 'Mine',
      body: 'My steps.\n',
      ...(turnOffSameName ? { turnOffSameName } : {}),
    })

  it('asks first, naming where the other skill is from, and writes nothing', async () => {
    expect(await mine('humanizer')).toEqual({
      ok: false,
      reason: 'same-name-on',
      problem: 'builtin',
    })
    expect(await viewOf('app:humanizer')).toBeUndefined()
    expect((await viewOf('builtin:humanizer'))?.enabled).toBe(true)
  })

  it('saves and turns the other skill off once the person agreed', async () => {
    expect(await mine('humanizer', true)).toEqual({ ok: true, id: 'app:humanizer' })
    expect((await viewOf('app:humanizer'))?.enabled).toBe(true)
    expect((await viewOf('builtin:humanizer'))?.enabled).toBe(false)
  })

  it('does not ask when the other skill is already off', async () => {
    // a skill of the Claude folder starts off
    expect((await viewOf('user:weekly'))?.enabled).toBe(false)
    expect(await mine('weekly')).toEqual({ ok: true, id: 'app:weekly' })

    await service.setState('builtin:humanizer', { enabled: false })
    expect(await mine('humanizer')).toEqual({ ok: true, id: 'app:humanizer' })
  })

  it('asks for a Claude folder skill the person turned on', async () => {
    await service.setState('user:weekly', { enabled: true })
    expect(await mine('weekly')).toMatchObject({ reason: 'same-name-on', problem: 'user' })
    expect(await mine('weekly', true)).toMatchObject({ ok: true })
    expect((await viewOf('user:weekly'))?.enabled).toBe(false)
  })

  it('asks when an own skill is renamed to such a name, and not for an edit that keeps its name', async () => {
    expect(await mine('notes')).toMatchObject({ ok: true })
    const rename = (turnOffSameName?: boolean) =>
      service.save({
        id: 'app:notes',
        title: '',
        name: 'humanizer',
        description: 'Mine',
        body: 'My steps.\n',
        ...(turnOffSameName ? { turnOffSameName } : {}),
      })
    expect(await rename()).toMatchObject({ reason: 'same-name-on', problem: 'builtin' })
    expect(await viewOf('app:notes')).toBeDefined()
    expect(await rename(true)).toEqual({ ok: true, id: 'app:humanizer' })
    expect((await viewOf('builtin:humanizer'))?.enabled).toBe(false)

    // the person turns the builtin on again: both stay as they chose, and an edit asks nothing
    await service.setState('builtin:humanizer', { enabled: true })
    const edit = await service.save({
      id: 'app:humanizer',
      title: '',
      description: 'Mine, again',
      body: 'My steps.\n',
    })
    expect(edit).toMatchObject({ ok: true })
    expect((await viewOf('builtin:humanizer'))?.enabled).toBe(true)
  })

  it('still refuses a name one of my own skills has', async () => {
    expect(await mine('notes')).toMatchObject({ ok: true })
    expect(await mine('notes', true)).toMatchObject({ ok: false, reason: 'name-taken' })
  })

  it('asks from a skill card as well', async () => {
    const card = (turnOffSameName?: boolean) =>
      service.saveFromCard({
        title: '',
        name: 'humanizer',
        description: 'Mine',
        body: 'My steps.\n',
        invoke: 'auto',
        ...(turnOffSameName ? { turnOffSameName } : {}),
      })
    expect(await card()).toMatchObject({ reason: 'same-name-on', problem: 'builtin' })
    expect(await card(true)).toMatchObject({ ok: true })
    expect((await viewOf('builtin:humanizer'))?.enabled).toBe(false)
  })
})
