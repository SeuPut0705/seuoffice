import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isHiddenEntry, listFolder } from '../src/main/folder-tree'
import { writeMarkdownOutput } from '../src/main/pdf-structure/jobs'

const OLD_MANIFEST = '.genoffice-assets.json'
const NEW_MANIFEST = '.seuoffice-assets.json'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-assets-old-names-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

function picture(content: string) {
  const data = new TextEncoder().encode(content)
  const hash = sha256(data)
  const name = `${hash}.png`
  return { name, path: `assets/${name}`, sha256: hash, mime: 'image/png' as const, data }
}

describe('an assets folder whose list has the old name', () => {
  it('stays out of the home tree as the editors own it', () => {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', OLD_MANIFEST), '{}')
    writeFileSync(join(dir, 'note.md'), '# note')

    expect(isHiddenEntry(dir, 'assets', true)).toBe(true)
    expect(listFolder(dir, new Set()).folders).toEqual([])
  })

  it("takes a converted document's pictures into that same list", async () => {
    mkdirSync(join(dir, 'assets'))
    const mine = picture('mine')
    writeFileSync(join(dir, 'assets', mine.name), mine.data)
    writeFileSync(
      join(dir, 'assets', OLD_MANIFEST),
      JSON.stringify({
        version: 1,
        files: [{ name: mine.name, sha256: mine.sha256 }],
        documents: { 'notes.md': [mine.name] },
        pending: {},
      }),
    )
    const converted = picture('converted')

    await writeMarkdownOutput(join(dir, 'book.md'), {
      markdown: `![](${converted.path})\n`,
      assets: [converted],
      manifestEntries: [{ name: converted.name, sha256: converted.sha256 }],
      warnings: [],
    })

    const manifest = JSON.parse(readFileSync(join(dir, 'assets', OLD_MANIFEST), 'utf8'))
    expect(manifest.documents).toEqual({
      'book.md': [converted.name],
      'notes.md': [mine.name],
    })
    expect(existsSync(join(dir, 'assets', NEW_MANIFEST))).toBe(false)
  })
})
