import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeImageIntoOwnedAssets } from '../src/main/asset-lifecycle'

const OLD_MANIFEST = '.genoffice-assets.json'
const NEW_MANIFEST = '.seuoffice-assets.json'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('a new assets folder', () => {
  it('keeps the list under the name 0.12.37 reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'assets-new-folder-'))
    dirs.push(directory)

    await writeImageIntoOwnedAssets(join(directory, 'note.md'), 'a.png', Buffer.from('a'))

    const list = JSON.parse(await readFile(join(directory, 'assets', OLD_MANIFEST), 'utf8'))
    expect(list.files.map((f: { name: string }) => f.name)).toEqual(['a.png'])
    expect(existsSync(join(directory, 'assets', NEW_MANIFEST))).toBe(false)
  })
})
