/**
 * The update check of a GitHub skill: up to date (same commit, or a new
 * commit with the same folder), changed (with the changed files), edited by
 * the person since the install, and applying an update in place. GitHub is a
 * fake `fetch` serving in-memory archives.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IEUM_SOURCE_FILE,
  SkillImportError,
  applyGitHubSkillUpdate,
  checkGitHubSkillUpdate,
  disposeSkillImport,
  installImportedSkills,
  prepareGitHubImport,
  readIeumSourceRecord,
  skillContentHash,
  type SkillFetch,
} from '../src/user-skills'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'user-skills-update-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SHA1 = '1'.repeat(40)
const SHA2 = '2'.repeat(40)

function skillMd(description: string): string {
  return `---\nname: minutes\ndescription: ${description}\n---\nWrite minutes.\n`
}

/** `o/skills` with branch `main`; `head.commit` is where `main` points now */
function fakeGitHub(archives: Record<string, Record<string, string>>, head: { commit: string }) {
  const archiveUrls: string[] = []
  const fetch: SkillFetch = async (url) => {
    const u = new URL(url)
    if (u.hostname === 'api.github.com') {
      if (u.pathname === '/repos/o/skills') return Response.json({ default_branch: 'main' })
      if (u.pathname === '/repos/o/skills/commits/main') return new Response(head.commit)
      return new Response('', { status: 404 })
    }
    const match = /^\/o\/skills\/zip\/([0-9a-f]{40})$/.exec(u.pathname)
    const files = match ? archives[match[1]!] : undefined
    if (u.hostname === 'codeload.github.com' && files) {
      archiveUrls.push(url)
      const zip = new JSZip()
      for (const [rel, text] of Object.entries(files)) zip.file(`skills-${match![1]}/${rel}`, text)
      return new Response(await zip.generateAsync({ type: 'arraybuffer' }))
    }
    return new Response('', { status: 404 })
  }
  return { fetch, archiveUrls }
}

const V1 = {
  'skills/minutes/SKILL.md': skillMd('Meeting minutes'),
  'skills/minutes/ref/a.md': 'a',
  'skills/minutes/ref/b.md': 'b',
}

async function installed(
  head: { commit: string },
  archives: Record<string, Record<string, string>>,
) {
  const base = temp()
  const app = join(base, 'home', '.ieumoffice', 'skills')
  const tmp = join(base, 'tmp')
  mkdirSync(app, { recursive: true })
  const github = fakeGitHub(archives, head)
  const imported = await prepareGitHubImport({
    address: 'https://github.com/o/skills/tree/main/skills/minutes',
    fetch: github.fetch,
    appSkillsDir: app,
    tempDir: tmp,
  })
  await installImportedSkills(imported, { appSkillsDir: app, selected: ['skills/minutes'] })
  await disposeSkillImport(imported)
  github.archiveUrls.length = 0
  return { app, tmp, skillDir: join(app, 'minutes'), github }
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SkillImportError) return error.kind
    throw error
  }
  return 'resolved'
}

describe('checkGitHubSkillUpdate', () => {
  it('is up to date on the same commit without downloading', async () => {
    const head = { commit: SHA1 }
    const { app, tmp, skillDir, github } = await installed(head, { [SHA1]: V1 })
    const check = await checkGitHubSkillUpdate({
      skillDir,
      appSkillsDir: app,
      fetch: github.fetch,
      tempDir: tmp,
    })
    expect(check).toMatchObject({ status: 'up-to-date', commit: SHA1, locallyEdited: false })
    expect(github.archiveUrls).toEqual([])
  })

  it('is up to date when a new commit leaves the skill folder as it was', async () => {
    const head = { commit: SHA1 }
    const { app, tmp, skillDir, github } = await installed(head, {
      [SHA1]: V1,
      [SHA2]: { ...V1, 'README.md': 'changed elsewhere' },
    })
    head.commit = SHA2
    const check = await checkGitHubSkillUpdate({
      skillDir,
      appSkillsDir: app,
      fetch: github.fetch,
      tempDir: tmp,
    })
    expect(check).toMatchObject({ status: 'up-to-date', commit: SHA2, locallyEdited: false })
    expect(github.archiveUrls).toHaveLength(1)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('lists the changed files and applies the update in place', async () => {
    const head = { commit: SHA1 }
    const { app, tmp, skillDir, github } = await installed(head, {
      [SHA1]: V1,
      [SHA2]: {
        'skills/minutes/SKILL.md': skillMd('Better minutes'),
        'skills/minutes/ref/a.md': 'a',
        'skills/minutes/ref/c.md': 'c',
      },
    })
    head.commit = SHA2
    const check = await checkGitHubSkillUpdate({
      skillDir,
      appSkillsDir: app,
      fetch: github.fetch,
      tempDir: tmp,
    })
    expect(check.status).toBe('changed')
    if (check.status !== 'changed') return
    expect(check.locallyEdited).toBe(false)
    expect(check.changedFiles).toEqual([
      { rel: 'SKILL.md', change: 'modified' },
      { rel: 'ref/b.md', change: 'removed' },
      { rel: 'ref/c.md', change: 'added' },
    ])
    expect(check.update.candidates.map((c) => [c.name, c.description, c.collision])).toEqual([
      ['minutes', 'Better minutes', false],
    ])

    const result = await applyGitHubSkillUpdate(check, {
      appSkillsDir: app,
      skillDir,
      now: () => new Date('2026-11-01T00:00:00Z'),
    })
    expect(result).toMatchObject({ name: 'minutes', dir: skillDir, replaced: true })
    expect(readdirSync(app)).toEqual(['minutes'])
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain('Better minutes')
    expect(readdirSync(join(skillDir, 'ref')).sort()).toEqual(['a.md', 'c.md'])
    const record = await readIeumSourceRecord(skillDir)
    expect(record).toEqual({
      kind: 'github',
      repo: 'o/skills',
      ref: 'main',
      path: 'skills/minutes',
      commit: SHA2,
      installedAt: '2026-11-01T00:00:00Z',
      contentHash: await skillContentHash(skillDir),
    })
    expect(readdirSync(tmp)).toEqual([])
  })

  it('flags a skill the person changed after installing', async () => {
    const head = { commit: SHA1 }
    const { app, tmp, skillDir, github } = await installed(head, {
      [SHA1]: V1,
      [SHA2]: { ...V1, 'skills/minutes/ref/a.md': 'a2' },
    })
    writeFileSync(join(skillDir, 'ref', 'mine.md'), 'my notes')
    const same = await checkGitHubSkillUpdate({
      skillDir,
      appSkillsDir: app,
      fetch: github.fetch,
      tempDir: tmp,
    })
    expect(same).toMatchObject({ status: 'up-to-date', locallyEdited: true })

    head.commit = SHA2
    const check = await checkGitHubSkillUpdate({
      skillDir,
      appSkillsDir: app,
      fetch: github.fetch,
      tempDir: tmp,
    })
    expect(check).toMatchObject({ status: 'changed', locallyEdited: true })
    if (check.status === 'changed') {
      expect(check.changedFiles).toEqual([
        { rel: 'ref/a.md', change: 'modified' },
        { rel: 'ref/mine.md', change: 'removed' },
      ])
      await disposeSkillImport(check.update)
    }
    expect(readdirSync(tmp)).toEqual([])
  })

  it('reports a skill gone from the repository and one without a source record', async () => {
    const head = { commit: SHA1 }
    const { app, tmp, skillDir, github } = await installed(head, {
      [SHA1]: V1,
      [SHA2]: { 'README.md': 'moved away' },
    })
    head.commit = SHA2
    expect(
      await kindOf(
        checkGitHubSkillUpdate({ skillDir, appSkillsDir: app, fetch: github.fetch, tempDir: tmp }),
      ),
    ).toBe('no-skills')
    expect(readdirSync(tmp)).toEqual([])

    rmSync(join(skillDir, IEUM_SOURCE_FILE))
    expect(
      await kindOf(
        checkGitHubSkillUpdate({ skillDir, appSkillsDir: app, fetch: github.fetch, tempDir: tmp }),
      ),
    ).toBe('not-github')
  })

  it('refuses a folder outside the app skills folder', async () => {
    const head = { commit: SHA1 }
    const { app, tmp, github } = await installed(head, { [SHA1]: V1 })
    expect(
      await kindOf(
        checkGitHubSkillUpdate({
          skillDir: temp(),
          appSkillsDir: app,
          fetch: github.fetch,
          tempDir: tmp,
        }),
      ),
    ).toBe('invalid-source')
  })
})
