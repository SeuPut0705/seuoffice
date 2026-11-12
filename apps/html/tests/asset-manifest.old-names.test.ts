import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readOwnedAssetManifest,
  reconcileOwnedAssets,
  writeImageIntoOwnedAssets,
} from '../src/main/asset-lifecycle'

const OLD_MANIFEST = '.genoffice-assets.json'
const NEW_MANIFEST = '.seuoffice-assets.json'

const tempDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'html-assets-old-names-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

/** an assets folder as the previous version left it: one owned picture, one of the user's */
async function folderFromPreviousVersion(): Promise<string> {
  const directory = await temporaryDirectory()
  await mkdir(join(directory, 'assets'))
  await writeFile(join(directory, 'assets', 'old.png'), 'old picture')
  await writeFile(join(directory, 'assets', 'mine.png'), 'user picture')
  await writeFile(
    join(directory, 'assets', OLD_MANIFEST),
    JSON.stringify({
      version: 1,
      files: [{ name: 'old.png', sha256: sha256('old picture') }],
      documents: { 'note.html': ['old.png'] },
      pending: {},
    }),
  )
  return directory
}

async function oldManifest(directory: string): Promise<{
  files: { name: string }[]
  documents: Record<string, string[]>
}> {
  return JSON.parse(await readFile(join(directory, 'assets', OLD_MANIFEST), 'utf8'))
}

describe('an assets folder whose list has the old name', () => {
  it('is read as app-owned', async () => {
    const directory = await folderFromPreviousVersion()
    expect(await readOwnedAssetManifest(join(directory, 'note.html'))).toMatchObject({
      files: [{ name: 'old.png' }],
      documents: { 'note.html': ['old.png'] },
    })
  })

  it('takes a new picture into that same list and gets no second list', async () => {
    const directory = await folderFromPreviousVersion()
    const documentPath = join(directory, 'note.html')

    expect(await writeImageIntoOwnedAssets(documentPath, 'new.png', Buffer.from('new'))).toBe(
      'assets/new.png',
    )

    expect((await oldManifest(directory)).files.map((file) => file.name).sort()).toEqual([
      'new.png',
      'old.png',
    ])
    expect(existsSync(join(directory, 'assets', NEW_MANIFEST))).toBe(false)
  })

  it('still deletes only the listed pictures a save no longer uses', async () => {
    const directory = await folderFromPreviousVersion()
    const documentPath = join(directory, 'note.html')
    await writeImageIntoOwnedAssets(documentPath, 'new.png', Buffer.from('new'))

    const result = await reconcileOwnedAssets(documentPath, ['assets/new.png'])

    expect(result).toMatchObject({ deleted: ['old.png'], errors: [] })
    expect(existsSync(join(directory, 'assets', 'old.png'))).toBe(false)
    expect(existsSync(join(directory, 'assets', 'mine.png'))).toBe(true)
    expect((await oldManifest(directory)).documents).toEqual({ 'note.html': ['new.png'] })
    expect(existsSync(join(directory, 'assets', NEW_MANIFEST))).toBe(false)
  })
})

describe('an assets folder that has a list under each name', () => {
  it('uses the new list and leaves the old one as it was', async () => {
    const directory = await folderFromPreviousVersion()
    const before = await readFile(join(directory, 'assets', OLD_MANIFEST), 'utf8')
    await writeFile(
      join(directory, 'assets', NEW_MANIFEST),
      JSON.stringify({ version: 1, files: [], documents: {}, pending: {} }),
    )
    const documentPath = join(directory, 'note.html')
    await writeImageIntoOwnedAssets(documentPath, 'new.png', Buffer.from('new picture'))

    const current = JSON.parse(await readFile(join(directory, 'assets', NEW_MANIFEST), 'utf8'))
    expect(current.files.map((file: { name: string }) => file.name)).toEqual(['new.png'])
    expect(await readFile(join(directory, 'assets', OLD_MANIFEST), 'utf8')).toBe(before)
  })
})

describe('the list names', () => {
  it.each([OLD_MANIFEST, NEW_MANIFEST])('refuses %s as a picture name', async (name) => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'assets'))
    await writeFile(
      join(directory, 'assets', NEW_MANIFEST),
      JSON.stringify({
        version: 1,
        files: [{ name, sha256: sha256('x') }],
        documents: {},
        pending: {},
      }),
    )
    expect(await readOwnedAssetManifest(join(directory, 'note.html'))).toBeNull()
  })
})
