import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundledSkillFrom,
  installSkill,
  legacySkillCopies,
  readInstallState,
  sha256,
  uninstallSkill,
  type SkillLedger,
} from '../src/agent-skills'
import { run, tempDir } from './helpers'

// An installed version put its skill into the agents' skills folders as
// `ieumoffice/SKILL.md` and remembered each write in the ledger by that path.
// Such a copy is still ours: it shows as needing an update, an install replaces
// it when nobody changed it, and an uninstall removes it. Anything else in a
// folder of that name is left alone.

const skillText = (name: string, version: string) =>
  `---\nname: ${name}\ndescription: test\nmetadata:\n  version: ${version}\n  cli: '>=0.4.0'\n---\n\nRun \`${name} --version\` first.\n`
const bundled = bundledSkillFrom(Buffer.from(skillText('seuoffice', '1.2.0')))
const OLD_SKILL = skillText('ieumoffice', '1.2.0')

/** A skills folder holding the copy an older version wrote, and the ledger that version kept */
function oldInstall(text = OLD_SKILL, written = OLD_SKILL) {
  const skills = join(tempDir(), 'skills')
  const old = join(skills, 'ieumoffice', 'SKILL.md')
  mkdirSync(join(skills, 'ieumoffice'), { recursive: true })
  writeFileSync(old, text)
  const ledger: SkillLedger = {
    [old]: {
      version: '1.2.0',
      sha256: sha256(written),
      at: '2026-10-01T00:00:00.000Z',
      channel: 'app',
    },
  }
  return { skills, old, now: join(skills, 'seuoffice', 'SKILL.md'), ledger }
}

describe('a skill copy under the old folder name', () => {
  it('reads as ours and outdated, is replaced by the new folder, and the ledger follows', () => {
    const { skills, old, now, ledger } = oldInstall()
    expect(readInstallState(skills, bundled, ledger)).toEqual({
      status: 'outdated',
      path: old,
      installedVersion: '1.2.0',
      older: true,
    })

    expect(installSkill(skills, bundled, ledger)).toBe(now)
    expect(readFileSync(now, 'utf-8')).toBe(bundled.text)
    expect(existsSync(join(skills, 'ieumoffice'))).toBe(false)
    expect(Object.keys(ledger)).toEqual([now])
    expect(readInstallState(skills, bundled, ledger)).toMatchObject({
      status: 'installed',
      path: now,
    })
  })

  it('is removed by uninstall, keeping other files of its folder', () => {
    const { skills, ledger } = oldInstall()
    writeFileSync(join(skills, 'ieumoffice', 'notes.txt'), 'mine')
    expect(uninstallSkill(skills, ledger)).toBe(true)
    expect(readdirSync(join(skills, 'ieumoffice'))).toEqual(['notes.txt'])
    expect(ledger).toEqual({})
    expect(readInstallState(skills, bundled, ledger).status).toBe('missing')
    expect(uninstallSkill(skills, ledger)).toBe(false)
  })

  it('is removed by uninstall together with the new copy when both are there', () => {
    const { skills, ledger } = oldInstall()
    mkdirSync(join(skills, 'seuoffice'))
    const now = join(skills, 'seuoffice', 'SKILL.md')
    writeFileSync(now, bundled.text)
    ledger[now] = {
      version: '1.2.0',
      sha256: bundled.sha256,
      at: '2026-11-12T00:00:00.000Z',
      channel: 'cli',
    }
    expect(uninstallSkill(skills, ledger)).toBe(true)
    expect(readdirSync(skills)).toEqual([])
  })

  it('edited since it was written: reported as modified, kept when the new one is installed', () => {
    const edited = `${OLD_SKILL}\nMy own note.\n`
    const { skills, old, now, ledger } = oldInstall(edited)
    expect(readInstallState(skills, bundled, ledger)).toMatchObject({
      status: 'modified',
      path: old,
      older: true,
    })
    installSkill(skills, bundled, ledger)
    expect(readFileSync(old, 'utf-8')).toBe(edited)
    expect(readFileSync(now, 'utf-8')).toBe(bundled.text)
  })

  it('not written by this app: reported as foreign and left in place by an install', () => {
    const { skills, old } = oldInstall()
    expect(readInstallState(skills, bundled, {})).toMatchObject({
      status: 'foreign',
      path: old,
      older: true,
    })
    const ledger: SkillLedger = {}
    installSkill(skills, bundled, ledger)
    expect(readFileSync(old, 'utf-8')).toBe(OLD_SKILL)
    expect(uninstallSkill(skills, ledger)).toBe(true)
    expect(readFileSync(old, 'utf-8')).toBe(OLD_SKILL)
  })

  it('holding something else: not seen, not replaced, not removed', () => {
    const skills = join(tempDir(), 'skills')
    const other = join(skills, 'ieumoffice', 'SKILL.md')
    mkdirSync(join(skills, 'ieumoffice'), { recursive: true })
    const text = '---\nname: ieumoffice-notes\ndescription: someone else\n---\n'
    writeFileSync(other, text)
    const ledger: SkillLedger = {}
    expect(readInstallState(skills, bundled, ledger)).toEqual({
      status: 'missing',
      path: join(skills, 'seuoffice', 'SKILL.md'),
    })
    installSkill(skills, bundled, ledger)
    expect(uninstallSkill(skills, ledger)).toBe(true)
    expect(readFileSync(other, 'utf-8')).toBe(text)
    expect(readdirSync(skills)).toEqual(['ieumoffice'])
  })

  it('in the own folder of a tool the shared row serves stays listed as a copy to keep current', () => {
    const h = tempDir()
    const codexSkills = join(h, '.codex', 'skills')
    mkdirSync(join(codexSkills, 'ieumoffice'), { recursive: true })
    const old = join(codexSkills, 'ieumoffice', 'SKILL.md')
    writeFileSync(old, OLD_SKILL)
    const ledger: SkillLedger = {
      [old]: {
        version: '1.2.0',
        sha256: sha256(OLD_SKILL),
        at: '2026-10-01T00:00:00.000Z',
        channel: 'app',
      },
    }
    expect(legacySkillCopies(ledger, {}, h).map((t) => t.id)).toEqual(['codex'])
  })
})

describe('seuoffice skill on a machine an older version installed into', () => {
  const REPO = resolve(__dirname, '../../..')

  it('lists the old copy as outdated, replaces it on install and removes the new one on remove', async () => {
    const home = tempDir()
    const userData = join(home, 'userData')
    mkdirSync(userData)
    const skills = join(home, '.claude', 'skills')
    mkdirSync(join(skills, 'ieumoffice'), { recursive: true })
    const old = join(skills, 'ieumoffice', 'SKILL.md')
    writeFileSync(old, OLD_SKILL)
    writeFileSync(
      join(userData, 'app-settings.json'),
      JSON.stringify({
        agentSkillInstalls: {
          [old]: {
            version: '1.2.0',
            sha256: sha256(OLD_SKILL),
            at: '2026-10-01T00:00:00.000Z',
            channel: 'app',
          },
        },
      }),
    )
    const env = { SEUOFFICE_HOME: home, SEUOFFICE_USER_DATA: userData }
    const claudeRow = (r: { json: () => any }) =>
      (r.json().detail.agents as Array<Record<string, unknown>>).find(
        (a) => a.agent === 'claude-code',
      )

    expect(claudeRow(await run(['skill', 'list', '--json'], { env }))).toMatchObject({
      status: 'outdated',
      up_to_date: false,
    })

    const installed = await run(['skill', 'install', 'claude-code', '--json'], { env })
    expect(installed.code).toBe(0)
    expect(readdirSync(skills)).toEqual(['seuoffice'])
    expect(readFileSync(join(skills, 'seuoffice', 'SKILL.md'), 'utf-8')).toBe(
      readFileSync(join(REPO, 'skills', 'seuoffice', 'SKILL.md'), 'utf-8'),
    )
    const settings = JSON.parse(readFileSync(join(userData, 'app-settings.json'), 'utf-8'))
    expect(Object.keys(settings.agentSkillInstalls)).toEqual([
      join(skills, 'seuoffice', 'SKILL.md'),
    ])

    const removed = await run(['skill', 'remove', 'claude-code', '--json'], { env })
    expect(removed.code).toBe(0)
    expect(readdirSync(skills)).toEqual([])
  })

  it('names the skills folder, not the old copy, in a --dir row', async () => {
    const home = tempDir()
    const userData = join(home, 'userData')
    mkdirSync(userData)
    const skills = join(home, 'picked')
    mkdirSync(join(skills, 'ieumoffice'), { recursive: true })
    writeFileSync(join(skills, 'ieumoffice', 'SKILL.md'), OLD_SKILL)
    const env = { SEUOFFICE_HOME: home, SEUOFFICE_USER_DATA: userData }

    const r = await run(['skill', 'remove', '--dir', skills, '--json'], { env })
    expect(r.code).toBe(0)
    expect(r.json().detail.agents[0]).toMatchObject({ status: 'foreign', skills_dir: skills })
    expect(readFileSync(join(skills, 'ieumoffice', 'SKILL.md'), 'utf-8')).toBe(OLD_SKILL)
  })
})
