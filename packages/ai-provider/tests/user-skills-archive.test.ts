/**
 * Opening a skill archive: entry paths that could leave the folder, links,
 * names Windows cannot hold and size limits are refused before anything is
 * written; a GitHub archive's top folder is stripped and a sub-path taken.
 * Archives are built in memory.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillImportError, extractSkillArchive, zipEntryPathProblem } from '../src/user-skills'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'user-skills-archive-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function zipOf(
  files: Record<string, string | { text: string; mode: number }>,
): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, value] of Object.entries(files)) {
    if (typeof value === 'string') zip.file(name, value)
    else zip.file(name, value.text, { unixPermissions: value.mode })
  }
  return zip.generateAsync({ type: 'uint8array', platform: 'UNIX', compression: 'DEFLATE' })
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
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((p) => p.replace(/\\/g, '/'))
}

describe('zipEntryPathProblem', () => {
  it.each([
    ['skills/a/SKILL.md', undefined],
    ['skills/a/', undefined],
    ['a b/c.md', undefined],
    ['../evil.txt', 'unsafe'],
    ['a/../../evil.txt', 'unsafe'],
    ['a/./b', 'unsafe'],
    ['a//b', 'unsafe'],
    ['/etc/passwd', 'unsafe'],
    ['C:/Windows/x.txt', 'unsafe'],
    ['c:x.txt', 'unsafe'],
    ['a\\..\\..\\evil.txt', 'unsafe'],
    ['a\u0000b', 'unsafe'],
    ['', 'unsafe'],
    ['a/b:stream', 'unportable'],
    ['a/CON', 'unportable'],
    ['a/nul.txt', 'unportable'],
    ['a/name.', 'unportable'],
    ['a/name ', 'unportable'],
    ['a/what?.md', 'unportable'],
  ])('%j → %s', (name, problem) => {
    expect(zipEntryPathProblem(name)).toBe(problem)
  })
})

describe('extractSkillArchive', () => {
  it('writes the entries', async () => {
    const dest = join(temp(), 'out')
    const result = await extractSkillArchive(
      await zipOf({ 'a/SKILL.md': 'x', 'a/scripts/run.py': 'print(1)' }),
      dest,
    )
    expect(result).toMatchObject({ files: 2, topFolder: undefined })
    expect(readFileSync(join(dest, 'a', 'scripts', 'run.py'), 'utf8')).toBe('print(1)')
  })

  it.each([
    ['a parent path', '../evil.txt'],
    ['a deeper parent path', 'a/../../evil.txt'],
    ['an absolute path', '/abs.txt'],
    ['a drive letter', 'C:/evil.txt'],
    ['backslashes', 'a\\..\\..\\evil.txt'],
  ])('refuses %s and writes nothing', async (_label, name) => {
    const base = temp()
    const dest = join(base, 'out')
    const bytes = await zipOf({ 'a/SKILL.md': 'x', [name]: 'bad' })
    expect(await kindOf(extractSkillArchive(bytes, dest))).toBe('unsafe')
    expect(existsSync(dest) ? listAll(dest) : []).toEqual([])
    expect(readdirSync(base)).toEqual([])
  })

  it('refuses a link entry and writes nothing', async () => {
    const dest = join(temp(), 'out')
    const bytes = await zipOf({
      'a/SKILL.md': 'x',
      'a/secret': { text: '/home/me/.codex/auth.json', mode: 0o120777 },
    })
    expect(await kindOf(extractSkillArchive(bytes, dest))).toBe('unsafe')
    expect(existsSync(dest) ? listAll(dest) : []).toEqual([])
  })

  it('refuses a name Windows cannot hold inside the part taken', async () => {
    const dest = join(temp(), 'out')
    const bytes = await zipOf({ 'a/SKILL.md': 'x', 'a/notes:x.md': 'y' })
    expect(await kindOf(extractSkillArchive(bytes, dest))).toBe('unsafe')
  })

  it('ignores links and odd names outside the part taken, but never unsafe paths', async () => {
    const dest = join(temp(), 'out')
    const ok = await zipOf({
      'repo-1/skills/a/SKILL.md': 'x',
      'repo-1/other/link': { text: '../..', mode: 0o120777 },
      'repo-1/other/what?.md': 'y',
    })
    const result = await extractSkillArchive(ok, dest, { stripTopFolder: true, subPath: 'skills' })
    expect(result.topFolder).toBe('repo-1')
    expect(listAll(dest).sort()).toEqual(['skills', 'skills/a', 'skills/a/SKILL.md'])

    const bad = await zipOf({ 'repo-1/skills/a/SKILL.md': 'x', 'repo-1/../../evil': 'y' })
    expect(
      await kindOf(
        extractSkillArchive(bad, join(temp(), 'out'), { stripTopFolder: true, subPath: 'skills' }),
      ),
    ).toBe('unsafe')
  })

  it('leaves out macOS folders', async () => {
    const dest = join(temp(), 'out')
    await extractSkillArchive(
      await zipOf({ 'a/SKILL.md': 'x', '__MACOSX/a/._SKILL.md': 'junk' }),
      dest,
    )
    expect(listAll(dest).sort()).toEqual(['a', 'a/SKILL.md'])
  })

  it('refuses an archive over its limits before writing', async () => {
    const dest = join(temp(), 'out')
    const bytes = await zipOf({ 'a/SKILL.md': 'x'.repeat(5000), 'a/b.md': 'y' })
    expect(
      await kindOf(
        extractSkillArchive(bytes, dest, {
          limits: { maxParts: 10, maxPartBytes: 1000, maxTotalBytes: 100_000 },
        }),
      ),
    ).toBe('too-large')
    expect(existsSync(dest)).toBe(false)
    expect(
      await kindOf(
        extractSkillArchive(bytes, dest, {
          limits: { maxParts: 1, maxPartBytes: 100_000, maxTotalBytes: 100_000 },
        }),
      ),
    ).toBe('too-large')
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses something that is not a zip', async () => {
    expect(
      await kindOf(extractSkillArchive(new TextEncoder().encode('not a zip'), join(temp(), 'o'))),
    ).toBe('unsafe')
  })
})
