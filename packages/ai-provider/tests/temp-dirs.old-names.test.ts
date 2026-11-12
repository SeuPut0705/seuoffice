import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupTrackedTempDirs } from '../src/subscription/temp-dirs'

let root: string
let records: string
let tempRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'temp-dirs-old-names-test-'))
  records = join(root, 'records')
  tempRoot = join(root, 'temp')
  await mkdir(records, { recursive: true })
  await mkdir(tempRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** a folder and its record as a force-killed previous version left them */
async function leftover(folderName: string, recordName: string): Promise<string> {
  const dir = join(tempRoot, folderName)
  await mkdir(dir)
  await writeFile(join(dir, 'image-1.png'), 'pixels')
  await writeFile(
    join(records, recordName),
    JSON.stringify({ version: 1, path: dir, ownerPid: 1, ownerStartedAt: 1 }),
  )
  return dir
}

describe('temporary folders a previous version recorded', () => {
  it('are removed at the next start, with their records', async () => {
    const codex = await leftover(
      'genoffice-codex-app-server-abc123',
      'ai-temp-dir-aaaaaaaaaaaaaaaa.json',
    )
    const claude = await leftover(
      'genoffice-claude-code-def456',
      'ai-temp-dir-bbbbbbbbbbbbbbbb.json',
    )

    expect(await cleanupTrackedTempDirs(records, { tempRoot, alive: () => false })).toBe(2)

    await expect(stat(codex)).rejects.toThrow()
    await expect(stat(claude)).rejects.toThrow()
    await expect(readFile(join(records, 'ai-temp-dir-aaaaaaaaaaaaaaaa.json'))).rejects.toThrow()
  })

  it('are kept while their owner still runs', async () => {
    const codex = await leftover(
      'genoffice-codex-app-server-abc123',
      'ai-temp-dir-aaaaaaaaaaaaaaaa.json',
    )

    expect(await cleanupTrackedTempDirs(records, { tempRoot, alive: () => true })).toBe(0)
    expect((await stat(codex)).isDirectory()).toBe(true)
  })
})
