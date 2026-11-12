/**
 * Skills a person made with an earlier version live in ~/.ieumoffice/skills.
 * Where only that folder exists it is the app's skills folder: they are listed,
 * and a skill saved now lands beside them. Once ~/.seuoffice exists it is the
 * one used, whatever appears under the old name later.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appSkillsDirOf, listUserSkills } from '../src/user-skills'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'user-skills-home-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function skill(base: string, name: string): void {
  mkdirSync(join(base, name), { recursive: true })
  writeFileSync(
    join(base, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A test skill.\n---\nDo it.\n`,
  )
}

async function ownSkills(home: string): Promise<string[]> {
  const skills = await listUserSkills({ homeDir: home })
  return skills.filter((s) => s.source === 'app').map((s) => s.name)
}

describe('the skills folder an earlier version made', () => {
  it('is the app skills folder while it is the only one', async () => {
    const home = temp()
    expect(appSkillsDirOf(home)).toBe(join(home, '.seuoffice', 'skills'))

    skill(join(home, '.ieumoffice', 'skills'), 'minutes')
    expect(appSkillsDirOf(home)).toBe(join(home, '.ieumoffice', 'skills'))
    expect(await ownSkills(home)).toEqual(['minutes'])
  })

  it('gives way to the new folder when both exist, and is left as it was', async () => {
    const home = temp()
    skill(join(home, '.ieumoffice', 'skills'), 'minutes')
    skill(join(home, '.seuoffice', 'skills'), 'agenda')
    expect(appSkillsDirOf(home)).toBe(join(home, '.seuoffice', 'skills'))
    expect(await ownSkills(home)).toEqual(['agenda'])
    expect(readdirSync(join(home, '.ieumoffice', 'skills'))).toEqual(['minutes'])
  })

  it('does not take over when it appears after the new folder was made', async () => {
    const home = temp()
    skill(join(home, '.seuoffice', 'skills'), 'agenda')
    expect(await ownSkills(home)).toEqual(['agenda'])

    // an earlier version, or the upstream app that uses the same name, runs on this machine
    skill(join(home, '.ieumoffice', 'skills'), 'theirs')
    expect(appSkillsDirOf(home)).toBe(join(home, '.seuoffice', 'skills'))
    expect(await ownSkills(home)).toEqual(['agenda'])
  })

  it('is still the app skills folder when the new one exists but holds nothing yet', async () => {
    const home = temp()
    skill(join(home, '.ieumoffice', 'skills'), 'minutes')
    // made by following the help, before any skill was put in it
    mkdirSync(join(home, '.seuoffice', 'skills'), { recursive: true })
    writeFileSync(join(home, '.seuoffice', '.DS_Store'), '')
    expect(appSkillsDirOf(home)).toBe(join(home, '.ieumoffice', 'skills'))
    expect(await ownSkills(home)).toEqual(['minutes'])
  })

  it('stays in the new folder when it cannot be read, rather than switch to the old one', () => {
    const home = temp()
    skill(join(home, '.ieumoffice', 'skills'), 'minutes')
    skill(join(home, '.seuoffice', 'skills'), 'agenda')
    // a permission problem says nothing about whether the folder holds data
    chmodSync(join(home, '.seuoffice'), 0o000)
    try {
      expect(appSkillsDirOf(home)).toBe(join(home, '.seuoffice', 'skills'))
    } finally {
      chmodSync(join(home, '.seuoffice'), 0o755)
    }
  })

  it('counts the old home folder even before it has a skills folder', () => {
    const home = temp()
    mkdirSync(join(home, '.ieumoffice'))
    writeFileSync(join(home, '.ieumoffice', 'launcher'), '/opt/SeuOffice/resources/cli\n')
    expect(appSkillsDirOf(home)).toBe(join(home, '.ieumoffice', 'skills'))
  })

  it('never takes the upstream app folder', async () => {
    const home = temp()
    skill(join(home, '.genoffice', 'skills'), 'theirs')
    expect(appSkillsDirOf(home)).toBe(join(home, '.seuoffice', 'skills'))
    expect(await ownSkills(home)).toEqual([])
  })
})
