import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USER_SKILL_PREVIEW_TEXT_MAX_CHARS as MAX } from '@genoffice/electron-utils/user-skills-channels'
import {
  createUserSkillsService,
  importPreviewOf,
  type UserSkillsService,
} from '../src/main/user-skills/user-skills-service'

/**
 * Reading a found skill inside the import preview before installing it
 * (decision 0127): the SKILL.md body and the folder's text files come from the
 * previewed import, cut at the display limit, and nothing is installed.
 */

let root: string
let home: string
let service: UserSkillsService

function tree(base: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(base, ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return base
}

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: About ${name}\n---\n${body}`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-preview-read-'))
  home = join(root, 'home')
  service = createUserSkillsService({
    homeDir: () => home,
    builtinDir: () => undefined,
    settingsPath: () => join(root, 'app-settings.json'),
    tempDir: () => join(root, 'temp'),
    trash: vi.fn(async () => undefined),
    fetch: () => Promise.reject(new Error('no network in tests')),
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function previewOf(files: Record<string, string>) {
  const folder = tree(mkdtempSync(join(root, 'incoming-')), files)
  return service.prepare({ kind: 'folder', folder })
}

describe('opening a found skill in the preview', () => {
  it('gives the body without front matter and the text files it can open', async () => {
    const imported = await previewOf({
      'deck/SKILL.md': skillMd('deck', 'Make the deck tidy.\n'),
      'deck/reference/colors.md': '# Colors\n',
      'deck/scripts/run.py': 'print(1)\n',
      'deck/assets/logo.png': 'png',
    })
    const read = await service.readImported(imported, 'deck')
    expect(read).toEqual({
      ok: true,
      content: {
        body: { text: 'Make the deck tidy.\n', truncated: false },
        files: [{ rel: 'reference/colors.md', size: 9 }],
      },
    })
    expect(await service.readImportedFile(imported, 'deck', 'reference/colors.md')).toEqual({
      ok: true,
      file: { text: '# Colors\n', truncated: false },
    })
    // looking installs nothing
    expect(existsSync(join(home, '.ieumoffice', 'skills', 'deck'))).toBe(false)
  })

  it('cuts a long body and a long file at the display limit and says so', async () => {
    const imported = await previewOf({
      'long/SKILL.md': skillMd('long', '가'.repeat(MAX + 500)),
      'long/notes.txt': 'n'.repeat(MAX * 5),
      'long/hangul.txt': '한'.repeat(MAX * 2),
    })
    const read = await service.readImported(imported, 'long')
    expect(read).toMatchObject({ ok: true, content: { body: { truncated: true } } })
    if (!read.ok) return
    expect(read.content.body.text).toBe('가'.repeat(MAX))

    const notes = await service.readImportedFile(imported, 'long', 'notes.txt')
    expect(notes).toMatchObject({ ok: true, file: { truncated: true } })
    if (notes.ok) expect(notes.file.text).toBe('n'.repeat(MAX))
    // a multi-byte text cut by the head has no broken character at its end
    const hangul = await service.readImportedFile(imported, 'long', 'hangul.txt')
    if (!hangul.ok) throw new Error('unreadable')
    expect(hangul.file.truncated).toBe(true)
    expect(hangul.file.text).toBe('한'.repeat(MAX))
  })

  it('reads only text files inside the found skill', async () => {
    const imported = await previewOf({
      'deck/SKILL.md': skillMd('deck', 'Body\n'),
      'deck/scripts/run.py': 'print(1)\n',
      'other/SKILL.md': skillMd('other', 'Other\n'),
      'secret.txt': 'outside the skill',
    })
    const reasonOf = async (key: string, rel: string) => {
      const read = await service.readImportedFile(imported, key, rel)
      return read.ok ? 'ok' : read.reason
    }
    expect(await reasonOf('deck', '../secret.txt')).toBe('outside')
    expect(await reasonOf('deck', '../other/SKILL.md')).toBe('outside')
    expect(await reasonOf('deck', join(root, 'app-settings.json'))).toBe('outside')
    expect(await reasonOf('deck', 'scripts/run.py')).toBe('not-text')
    expect(await reasonOf('deck', 'missing.md')).toBe('not-found')
    expect(await reasonOf('nope', 'SKILL.md')).toBe('not-found')
    expect(await service.readImported(imported, 'nope')).toMatchObject({ reason: 'not-found' })
  })

  it('never follows a link that leads out of the skill folder', async () => {
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'private notes')
    const folder = tree(mkdtempSync(join(root, 'incoming-')), {
      'deck/SKILL.md': skillMd('deck', 'Body\n'),
    })
    try {
      symlinkSync(outside, join(folder, 'deck', 'notes.md'), 'file')
    } catch {
      // this PC may not allow making links; the listing rule is covered by the core's tests
      return
    }
    const imported = await service.prepare({ kind: 'folder', folder })
    const read = await service.readImported(imported, 'deck')
    expect(read).toMatchObject({ ok: true, content: { files: [] } })
    expect(await service.readImportedFile(imported, 'deck', 'notes.md')).toMatchObject({
      ok: false,
    })
  })
})

describe('a skill whose body is empty', () => {
  it('is marked in the preview and can still be installed', async () => {
    const imported = await previewOf({
      'empty/SKILL.md': skillMd('empty', ''),
      'blank/SKILL.md': skillMd('blank', '\n  \n'),
      'full/SKILL.md': skillMd('full', 'Do it.\n'),
    })
    const preview = importPreviewOf(imported, 'token')
    expect(
      Object.fromEntries(preview.candidates.map((found) => [found.name, found.emptyBody])),
    ).toEqual({ blank: true, empty: true, full: false })
    expect(preview.candidates.every((found) => found.problem === undefined)).toBe(true)

    const done = await service.install(imported, { selected: ['empty'], onCollision: {} })
    expect(done).toMatchObject({ ok: true, installed: [{ key: 'empty', id: 'app:empty' }] })
  })
})
