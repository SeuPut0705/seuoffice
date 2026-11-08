/**
 * Taking skills in from a folder, a zip file and GitHub: finding them, the
 * preview (scripts, web addresses, license, name collisions), installing with
 * replace-or-skip choices, the GitHub source record, size limits that install
 * nothing, and temporary folders removed on failure and cancel. GitHub is a
 * fake `fetch` serving in-memory archives.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IEUM_SOURCE_FILE,
  SKILL_STAGING_PREFIX,
  SkillImportError,
  disposeSkillImport,
  findSkillFolders,
  installImportedSkills,
  prepareFolderImport,
  prepareGitHubImport,
  prepareZipImport,
  skillContentHash,
  type SkillFetch,
  type SkillImport,
} from '../src/user-skills'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'user-skills-import-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function skillMd(name: string, description = `${name} does things`, body = 'Do it.\n'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(base, ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
}

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(files)) zip.file(name, text)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
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

function listAll(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => p.replace(/\\/g, '/'))
    .sort()
}

interface Setup {
  base: string
  home: string
  app: string
  tmp: string
}
function setup(): Setup {
  const base = temp()
  const home = join(base, 'home')
  const app = join(home, '.ieumoffice', 'skills')
  const tmp = join(base, 'tmp')
  mkdirSync(app, { recursive: true })
  return { base, home, app, tmp }
}

const SHA1 = '1'.repeat(40)

/** A public repository `o/skills` on a fake GitHub, branch `main` at `commit` */
function fakeGitHub(
  archives: Record<string, Record<string, string>>,
  commit = SHA1,
): { fetch: SkillFetch; urls: string[] } {
  const urls: string[] = []
  const fetch: SkillFetch = async (url) => {
    urls.push(url)
    const u = new URL(url)
    if (u.hostname === 'api.github.com') {
      if (u.pathname === '/repos/o/skills') return Response.json({ default_branch: 'main' })
      if (u.pathname === '/repos/o/skills/commits/main') return new Response(commit)
      return new Response('', { status: 404 })
    }
    const zip = /^\/o\/skills\/zip\/([0-9a-f]{40})$/.exec(u.pathname)
    if (u.hostname === 'codeload.github.com' && zip && archives[zip[1]!]) {
      const files: Record<string, string> = {}
      for (const [rel, text] of Object.entries(archives[zip[1]!]!)) {
        files[`skills-${zip[1]}/${rel}`] = text
      }
      return new Response(Buffer.from(await zipOf(files)))
    }
    return new Response('', { status: 404 })
  }
  return { fetch, urls }
}

const REPO = {
  'README.md': '# skills',
  LICENSE: 'MIT',
  'skills/minutes/SKILL.md': skillMd('minutes', 'Meeting minutes', 'See https://a.example/x.\n'),
  'skills/minutes/LICENSE.txt': 'Apache',
  'skills/pdf-tools/SKILL.md': skillMd('pdf-tools'),
  'skills/pdf-tools/scripts/fill.py': 'print(1)',
  'docs/guide.md': 'not a skill',
}

describe('findSkillFolders', () => {
  it('finds one skill, many skills, and stops at a skill folder', async () => {
    const root = temp()
    writeTree(root, {
      'a/SKILL.md': skillMd('a'),
      'a/nested/SKILL.md': skillMd('nested'),
      'group/b/SKILL.md': skillMd('b'),
      'node_modules/x/SKILL.md': skillMd('x'),
      '.git/y/SKILL.md': skillMd('y'),
      '.claude/skills/c/SKILL.md': skillMd('c'),
    })
    expect(await findSkillFolders(root)).toEqual(['.claude/skills/c', 'a', 'group/b'])
    expect(await findSkillFolders(join(root, 'a'))).toEqual([''])
    expect(await findSkillFolders(root, 'group')).toEqual(['group/b'])
  })
})

describe('prepareFolderImport', () => {
  it('previews scripts, web addresses, license and name collisions', async () => {
    const { home, app } = setup()
    const folder = temp()
    const urls = Array.from({ length: 7 }, (_, i) => `https://site${i}.example/page`)
    writeTree(folder, {
      'one/SKILL.md': skillMd('one', 'First', `${urls.join('\n')}\n`),
      'one/LICENSE': 'MIT',
      'two/SKILL.md': skillMd('two'),
      'two/tool.ps1': 'Write-Host hi',
      'broken/SKILL.md': 'no front matter',
      'ieumoffice/SKILL.md': skillMd('ieumoffice'),
    })
    writeTree(app, { 'two/SKILL.md': skillMd('two') })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    expect(imported.tempDir).toBeUndefined()
    const byKey = Object.fromEntries(imported.candidates.map((c) => [c.key, c]))
    expect(Object.keys(byKey).sort()).toEqual(['broken', 'one', 'two'])
    expect(byKey.one).toMatchObject({
      name: 'one',
      description: 'First',
      hasScripts: false,
      urls: urls.slice(0, 5),
      urlCount: 7,
      license: 'LICENSE',
      collision: false,
      problem: undefined,
      files: 2,
    })
    expect(byKey.two).toMatchObject({ hasScripts: true, collision: true, problem: undefined })
    expect(byKey.broken!.problem).toBe('no-frontmatter')
  })

  it('takes a folder that is one skill', async () => {
    const { home, app } = setup()
    const folder = join(temp(), 'my-skill')
    writeTree(folder, { 'SKILL.md': skillMd('my-skill') })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    expect(imported.candidates.map((c) => [c.key, c.rel, c.name])).toEqual([['.', '', 'my-skill']])
  })

  it('marks a second skill of the same name', async () => {
    const { home, app } = setup()
    const folder = temp()
    writeTree(folder, { 'a/SKILL.md': skillMd('same'), 'b/SKILL.md': skillMd('same') })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    expect(imported.candidates.map((c) => c.problem)).toEqual([undefined, 'duplicate'])
  })

  it('refuses the app skills folder and the Codex home, and reports nothing found', async () => {
    const { home, app } = setup()
    writeTree(app, { 'x/SKILL.md': skillMd('x') })
    expect(
      await kindOf(prepareFolderImport({ folder: app, appSkillsDir: app, homeDir: home })),
    ).toBe('invalid-source')
    const codex = join(home, '.codex', 'skills')
    writeTree(codex, { 'y/SKILL.md': skillMd('y') })
    expect(
      await kindOf(prepareFolderImport({ folder: codex, appSkillsDir: app, homeDir: home })),
    ).toBe('invalid-source')
    // searching the home folder skips both
    writeTree(home, { 'mine/z/SKILL.md': skillMd('z') })
    const imported = await prepareFolderImport({ folder: home, appSkillsDir: app, homeDir: home })
    expect(imported.candidates.map((c) => c.rel)).toEqual(['mine/z'])
    const empty = temp()
    expect(
      await kindOf(prepareFolderImport({ folder: empty, appSkillsDir: app, homeDir: home })),
    ).toBe('no-skills')
  })
})

describe('installImportedSkills', () => {
  it('copies the checked skills, leaving no staging folder and no source record', async () => {
    const { home, app } = setup()
    const folder = temp()
    writeTree(folder, {
      'one/SKILL.md': skillMd('one'),
      'one/assets/form.docx': 'doc',
      [`one/${IEUM_SOURCE_FILE}`]: '{"kind":"github"}',
      'two/SKILL.md': skillMd('two'),
    })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    const result = await installImportedSkills(imported, { appSkillsDir: app, selected: ['one'] })
    expect(result).toEqual({
      installed: [{ key: 'one', name: 'one', dir: join(app, 'one'), replaced: false }],
      skipped: [],
    })
    expect(listAll(app)).toEqual(['one', 'one/SKILL.md', 'one/assets', 'one/assets/form.docx'])
  })

  it('needs a choice for a taken name and then replaces or skips', async () => {
    const { home, app } = setup()
    writeTree(app, { 'one/SKILL.md': skillMd('one', 'old'), 'one/old.md': 'old' })
    const folder = temp()
    writeTree(folder, { 'one/SKILL.md': skillMd('one', 'new'), 'two/SKILL.md': skillMd('two') })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    const before = listAll(app)

    expect(
      await kindOf(
        installImportedSkills(imported, { appSkillsDir: app, selected: ['one', 'two'] }),
      ),
    ).toBe('needs-choice')
    expect(listAll(app)).toEqual(before)

    const skip = await installImportedSkills(imported, {
      appSkillsDir: app,
      selected: ['one', 'two'],
      onCollision: { one: 'skip' },
    })
    expect(skip.skipped).toEqual(['one'])
    expect(skip.installed.map((s) => s.name)).toEqual(['two'])
    expect(readFileSync(join(app, 'one', 'old.md'), 'utf8')).toBe('old')

    const discarded: string[] = []
    const replace = await installImportedSkills(imported, {
      appSkillsDir: app,
      selected: ['one'],
      onCollision: { one: 'replace' },
      discardReplaced: async (dir) => {
        discarded.push(listAll(dir).join(','))
      },
    })
    expect(replace.installed).toEqual([
      { key: 'one', name: 'one', dir: join(app, 'one'), replaced: true },
    ])
    expect(discarded).toEqual(['SKILL.md,old.md'])
    expect(listAll(join(app, 'one'))).toEqual(['SKILL.md'])
    expect(readFileSync(join(app, 'one', 'SKILL.md'), 'utf8')).toContain('new')
    expect(readdirSync(app).filter((n) => n.startsWith(SKILL_STAGING_PREFIX))).toEqual([])
  })

  it('keeps the old folder in place when it cannot go to the trash, and says so', async () => {
    const { home, app } = setup()
    writeTree(app, { 'one/SKILL.md': skillMd('one', 'old'), 'one/old.md': 'old' })
    const folder = temp()
    writeTree(folder, { 'one/SKILL.md': skillMd('one', 'new'), 'two/SKILL.md': skillMd('two') })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })

    expect(
      await kindOf(
        installImportedSkills(imported, {
          appSkillsDir: app,
          selected: ['one', 'two'],
          onCollision: { one: 'replace' },
          discardReplaced: async () => {
            throw new Error('no trash here')
          },
        }),
      ),
    ).toBe('trash-failed')
    // the old skill is back as it was; nothing was deleted for good
    expect(listAll(join(app, 'one'))).toEqual(['SKILL.md', 'old.md'])
    expect(readFileSync(join(app, 'one', 'SKILL.md'), 'utf8')).toContain('old')
    // nothing of that install stays: the person tries again once the trash works
    expect(existsSync(join(app, 'two'))).toBe(false)
    expect(readdirSync(app).filter((n) => n.startsWith(SKILL_STAGING_PREFIX))).toEqual([])
  })

  it('installs nothing when one chosen skill is over the size limit', async () => {
    const { home, app } = setup()
    const folder = temp()
    writeTree(folder, {
      'small/SKILL.md': skillMd('small'),
      'big/SKILL.md': skillMd('big'),
      'big/data.txt': 'x'.repeat(2000),
    })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    expect(
      await kindOf(
        installImportedSkills(imported, {
          appSkillsDir: app,
          selected: ['small', 'big'],
          limits: { files: 100, bytes: 1000 },
        }),
      ),
    ).toBe('too-large')
    expect(readdirSync(app)).toEqual([])
  })

  it('refuses a skill the preview marked', async () => {
    const { home, app } = setup()
    const folder = temp()
    writeTree(folder, { 'broken/SKILL.md': 'nothing', 'ok/SKILL.md': skillMd('ok') })
    const imported = await prepareFolderImport({ folder, appSkillsDir: app, homeDir: home })
    expect(
      await kindOf(
        installImportedSkills(imported, { appSkillsDir: app, selected: ['ok', 'broken'] }),
      ),
    ).toBe('not-installable')
    expect(readdirSync(app)).toEqual([])
  })
})

describe('prepareZipImport', () => {
  it('names a skill at the top of the zip by its front matter', async () => {
    const { app, tmp } = setup()
    const file = join(temp(), 'upload.zip')
    writeFileSync(file, await zipOf({ 'SKILL.md': skillMd('from-zip'), 'ref/a.md': 'a' }))
    const imported = await prepareZipImport({ file, appSkillsDir: app, tempDir: tmp })
    expect(imported.candidates.map((c) => [c.key, c.name, c.files])).toEqual([['.', 'from-zip', 2]])
    await installImportedSkills(imported, { appSkillsDir: app, selected: ['.'] })
    expect(listAll(app)).toEqual([
      'from-zip',
      'from-zip/SKILL.md',
      'from-zip/ref',
      'from-zip/ref/a.md',
    ])
    await disposeSkillImport(imported)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('finds many skills in a zip', async () => {
    const { app, tmp } = setup()
    const file = join(temp(), 'many.zip')
    writeFileSync(file, await zipOf({ 'a/SKILL.md': skillMd('a'), 'b/SKILL.md': skillMd('b') }))
    const imported = await prepareZipImport({ file, appSkillsDir: app, tempDir: tmp })
    expect(imported.candidates.map((c) => c.name)).toEqual(['a', 'b'])
    await disposeSkillImport(imported)
  })

  it('removes its temporary folder when the zip fails a check or holds no skill', async () => {
    const { app, tmp } = setup()
    const bad = join(temp(), 'bad.zip')
    writeFileSync(bad, await zipOf({ 'a/SKILL.md': skillMd('a'), '../evil.md': 'x' }))
    expect(await kindOf(prepareZipImport({ file: bad, appSkillsDir: app, tempDir: tmp }))).toBe(
      'unsafe',
    )
    expect(readdirSync(tmp)).toEqual([])
    const none = join(temp(), 'none.zip')
    writeFileSync(none, await zipOf({ 'readme.md': 'x' }))
    expect(await kindOf(prepareZipImport({ file: none, appSkillsDir: app, tempDir: tmp }))).toBe(
      'no-skills',
    )
    expect(readdirSync(tmp)).toEqual([])
    expect(
      await kindOf(
        prepareZipImport({ file: none, appSkillsDir: app, tempDir: tmp, maxArchiveBytes: 10 }),
      ),
    ).toBe('too-large')
    expect(readdirSync(app)).toEqual([])
  })
})

describe('prepareGitHubImport', () => {
  it('finds the skills under the address folder and installs with a source record', async () => {
    const { app, tmp } = setup()
    const { fetch, urls } = fakeGitHub({ [SHA1]: REPO })
    const imported = await prepareGitHubImport({
      address: 'https://github.com/o/skills/tree/main/skills',
      fetch,
      appSkillsDir: app,
      tempDir: tmp,
    })
    expect(urls.map((url) => new URL(url).hostname)).toEqual([
      'api.github.com',
      'codeload.github.com',
    ])
    expect(imported.origin).toEqual({
      kind: 'github',
      repo: 'o/skills',
      ref: 'main',
      commit: SHA1,
      path: 'skills',
    })
    expect(imported.rootLicense).toBe('LICENSE')
    expect(imported.candidates.map((c) => [c.key, c.hasScripts, c.license, c.urlCount])).toEqual([
      ['skills/minutes', false, 'LICENSE.txt', 1],
      ['skills/pdf-tools', true, undefined, 0],
    ])

    const result = await installImportedSkills(imported, {
      appSkillsDir: app,
      selected: ['skills/minutes'],
      now: () => new Date('2026-10-21T09:00:00.123Z'),
    })
    const dir = result.installed[0]!.dir
    expect(dir).toBe(join(app, 'minutes'))
    const recordText = readFileSync(join(dir, IEUM_SOURCE_FILE), 'utf8')
    const record = JSON.parse(recordText) as Record<string, string>
    expect(Object.keys(record)).toEqual([
      'kind',
      'repo',
      'ref',
      'path',
      'commit',
      'installedAt',
      'contentHash',
    ])
    expect(record).toEqual({
      kind: 'github',
      repo: 'o/skills',
      ref: 'main',
      path: 'skills/minutes',
      commit: SHA1,
      installedAt: '2026-10-21T09:00:00Z',
      contentHash: await skillContentHash(dir),
    })
    await disposeSkillImport(imported)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('takes only the named skill for owner/repo@name, and a root skill has an empty path', async () => {
    const { app, tmp } = setup()
    const { fetch } = fakeGitHub({ [SHA1]: REPO })
    const imported = await prepareGitHubImport({
      address: 'o/skills@pdf-tools',
      fetch,
      appSkillsDir: app,
      tempDir: tmp,
    })
    expect(imported.candidates.map((c) => c.key)).toEqual(['skills/pdf-tools'])
    await disposeSkillImport(imported)

    const root = fakeGitHub({ [SHA1]: { 'SKILL.md': skillMd('root-skill') } })
    const top = await prepareGitHubImport({
      address: 'o/skills',
      fetch: root.fetch,
      appSkillsDir: app,
      tempDir: tmp,
    })
    await installImportedSkills(top, { appSkillsDir: app, selected: ['.'] })
    const record = JSON.parse(readFileSync(join(app, 'root-skill', IEUM_SOURCE_FILE), 'utf8'))
    expect(record.path).toBe('')
    await disposeSkillImport(top)
  })

  it('reports nothing found and a bad address, writing nothing', async () => {
    const { app, tmp } = setup()
    const { fetch, urls } = fakeGitHub({ [SHA1]: REPO })
    expect(
      await kindOf(
        prepareGitHubImport({
          address: 'o/skills@missing',
          fetch,
          appSkillsDir: app,
          tempDir: tmp,
        }),
      ),
    ).toBe('no-skills')
    expect(
      await kindOf(
        prepareGitHubImport({
          address: 'https://github.com/o/skills/tree/main/docs',
          fetch,
          appSkillsDir: app,
          tempDir: tmp,
        }),
      ),
    ).toBe('no-skills')
    const before = urls.length
    expect(
      await kindOf(
        prepareGitHubImport({
          address: 'https://example.com/o/skills',
          fetch,
          appSkillsDir: app,
          tempDir: tmp,
        }),
      ),
    ).toBe('bad-address')
    expect(urls.length).toBe(before)
    expect(readdirSync(tmp)).toEqual([])
    expect(readdirSync(app)).toEqual([])
  })

  it('removes the temporary folder when the archive fails a check or the person cancels', async () => {
    const { app, tmp } = setup()
    const { fetch } = fakeGitHub({ [SHA1]: { ...REPO, 'skills/minutes/../../../evil.md': 'x' } })
    expect(
      await kindOf(
        prepareGitHubImport({ address: 'o/skills', fetch, appSkillsDir: app, tempDir: tmp }),
      ),
    ).toBe('unsafe')
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])

    const controller = new AbortController()
    const good = fakeGitHub({ [SHA1]: REPO })
    const cancelling: SkillFetch = async (url, init) => {
      const response = await good.fetch(url, init)
      if (new URL(url).hostname === 'codeload.github.com') controller.abort()
      return response
    }
    expect(
      await kindOf(
        prepareGitHubImport({
          address: 'o/skills',
          fetch: cancelling,
          appSkillsDir: app,
          tempDir: tmp,
          signal: controller.signal,
        }),
      ),
    ).toBe('cancelled')
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])
    expect(readdirSync(app)).toEqual([])
  })

  it('refuses an archive over the cap', async () => {
    const { app, tmp } = setup()
    const { fetch } = fakeGitHub({ [SHA1]: REPO })
    expect(
      await kindOf(
        prepareGitHubImport({
          address: 'o/skills',
          fetch,
          appSkillsDir: app,
          tempDir: tmp,
          maxArchiveBytes: 100,
        }),
      ),
    ).toBe('too-large')
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])
  })
})

// keep the type import used when the file is type-checked on its own
export type { SkillImport }
