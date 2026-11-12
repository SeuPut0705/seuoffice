import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listUserSkills, readUserSkillFolder, validateNewUserSkillName } from '../src/user-skills'

// The app's own command-line skill was installed into agents' skills folders as
// `ieumoffice` before it took the name `seuoffice`. Both are the app's, not a
// person's skill: never read, never shown, never taken by a new skill.

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function skill(base: string, folder: string, name = folder): string {
  const dir = join(base, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill.\n---\nDo it.\n`)
  return dir
}

describe("the app's own skill under its old name", () => {
  it('is never read from a skills folder, by folder name or by front matter name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'old-skill-names-'))
    roots.push(home)
    const claude = join(home, '.claude', 'skills')
    skill(claude, 'IeumOffice')
    skill(claude, 'renamed-folder', 'ieumoffice')
    skill(join(home, '.agents', 'skills'), 'ieumoffice')
    skill(claude, 'kept')
    const ids = (await listUserSkills({ homeDir: home })).map((s) => s.id)
    expect(ids).toEqual(['user:kept'])
    expect(
      await readUserSkillFolder(join(claude, 'IeumOffice'), { source: 'user' }),
    ).toBeUndefined()
  })

  it('cannot be the name of a new skill, nor can the current one', () => {
    expect(validateNewUserSkillName('ieumoffice')).toBe('reserved')
    expect(validateNewUserSkillName('seuoffice')).toBe('reserved')
    expect(validateNewUserSkillName('my-office')).toBeUndefined()
  })
})
