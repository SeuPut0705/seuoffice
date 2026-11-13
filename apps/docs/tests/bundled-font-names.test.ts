/**
 * A PDF printed from the editor embeds each bundled face under the names in
 * its own `name` table, so a reader's font list shows them: they carry this
 * product's name, never the original work's.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWoff2Table } from './helpers/woff2-metrics'

const FONTS = join(__dirname, '../src/renderer/fonts')

/** family, full name, PostScript name, typographic family */
const SHOWN_NAME_IDS = new Set([1, 4, 6, 16])

function shownNames(name: Buffer): string[] {
  const count = name.readUInt16BE(2)
  const strings = name.readUInt16BE(4)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    const platform = name.readUInt16BE(rec)
    const nameId = name.readUInt16BE(rec + 6)
    if (!SHOWN_NAME_IDS.has(nameId)) continue
    const len = name.readUInt16BE(rec + 8)
    const start = strings + name.readUInt16BE(rec + 10)
    const bytes = name.subarray(start, start + len)
    out.push(platform === 1 ? bytes.toString('latin1') : Buffer.from(bytes).swap16().toString('utf16le'))
  }
  return out
}

describe('bundled font names', () => {
  const files = readdirSync(FONTS).filter((f) => f.endsWith('.woff2'))

  it('finds the bundled faces', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files)('%s names no GenOffice face', (file) => {
    const names = shownNames(readWoff2Table(join(FONTS, file), 'name')!)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => /genoffice/i.test(n))).toEqual([])
  })
})
