import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeMarkdownOutput } from '../src/main/pdf-structure/jobs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-assets-new-folder-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a converted document with no assets folder yet', () => {
  it('keeps the list under the name 0.12.37 reads', async () => {
    const data = new TextEncoder().encode('picture')
    const hash = createHash('sha256').update(data).digest('hex')
    const name = `${hash}.png`

    await writeMarkdownOutput(join(dir, 'book.md'), {
      markdown: `![](assets/${name})\n`,
      assets: [{ name, path: `assets/${name}`, sha256: hash, mime: 'image/png' as const, data }],
      manifestEntries: [{ name, sha256: hash }],
      warnings: [],
    })

    const list = JSON.parse(readFileSync(join(dir, 'assets', '.genoffice-assets.json'), 'utf8'))
    expect(list.documents).toEqual({ 'book.md': [name] })
    expect(existsSync(join(dir, 'assets', '.seuoffice-assets.json'))).toBe(false)
  })
})
