import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MARKDOWN_CONVERSION_TTL_MS,
  cleanupStaleMarkdownConversions,
} from '../src/main/conversion-lifecycle'

const OLD_MARKER = '.genoffice-markdown-conversion.json'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function sessionFromPreviousVersion(root: string, name: string, createdAt: number) {
  const directory = join(root, name)
  await mkdir(directory)
  await writeFile(join(directory, OLD_MARKER), JSON.stringify({ version: 1, createdAt }))
  await writeFile(join(directory, 'converted.docx'), 'docx')
  return directory
}

describe('a conversion session the previous version made', () => {
  it('expires like any other session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'markdown-convert-old-names-'))
    tempDirectories.push(root)
    const expired = await sessionFromPreviousVersion(root, 'session-1-old', 1)
    const recent = await sessionFromPreviousVersion(
      root,
      'session-2-recent',
      MARKDOWN_CONVERSION_TTL_MS,
    )

    const removed = await cleanupStaleMarkdownConversions(root, MARKDOWN_CONVERSION_TTL_MS + 2)

    expect(removed).toEqual([expired])
    expect(existsSync(expired)).toBe(false)
    expect(existsSync(join(recent, 'converted.docx'))).toBe(true)
  })
})
