import { existsSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// a fresh assets folder keeps the name 0.12.37 reads; the other name is the newer one
const WRITTEN_MANIFEST = '.genoffice-assets.json'
const OTHER_MANIFEST = '.seuoffice-assets.json'

const afterRead = vi.hoisted(() => ({ current: null as ((path: string) => void) | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const out = await actual.readFile(...args)
    afterRead.current?.(String(args[0]))
    return out
  }) as typeof actual.readFile
  return { ...actual, default: { ...actual, readFile }, readFile }
})

import { writeImageIntoOwnedAssets } from '../src/main/asset-lifecycle'

const tempDirectories: string[] = []

afterEach(async () => {
  afterRead.current = null
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('a list under the other name appearing during an update', () => {
  it('is left alone: the update writes the list it read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'markdown-assets-race-old-names-'))
    tempDirectories.push(directory)
    const documentPath = join(directory, 'note.md')
    await writeImageIntoOwnedAssets(documentPath, 'first.png', Buffer.from('first'))

    const planted = '{"planted":true}'
    afterRead.current = (path) => {
      if (!path.endsWith(WRITTEN_MANIFEST)) return
      afterRead.current = null
      writeFileSync(join(directory, 'assets', OTHER_MANIFEST), planted)
    }
    await writeImageIntoOwnedAssets(documentPath, 'second.png', Buffer.from('second'))

    expect(afterRead.current).toBeNull()
    expect(await readFile(join(directory, 'assets', OTHER_MANIFEST), 'utf8')).toBe(planted)
    const manifest = JSON.parse(await readFile(join(directory, 'assets', WRITTEN_MANIFEST), 'utf8'))
    expect(manifest.files.map((file: { name: string }) => file.name).sort()).toEqual([
      'first.png',
      'second.png',
    ])
    expect(existsSync(join(directory, 'assets', 'second.png'))).toBe(true)
  })
})
