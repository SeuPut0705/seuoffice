/**
 * A PDF printed from the editor embeds each bundled face under the names in
 * its own `name` table, and a font inspector lists every record of it: they
 * carry this product's name, never the original work's.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWoff2Table } from './helpers/woff2-metrics'

const FONTS = join(__dirname, '../src/renderer/fonts')

/** the `name` table of a bare sfnt (TrueType/OpenType) file */
function sfntNameTable(path: string): Buffer | undefined {
  const buf = readFileSync(path)
  const numTables = buf.readUInt16BE(4)
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    if (buf.toString('latin1', rec, rec + 4) !== 'name') continue
    const offset = buf.readUInt32BE(rec + 8)
    return buf.subarray(offset, offset + buf.readUInt32BE(rec + 12))
  }
  return undefined
}

function nameRecords(name: Buffer): string[] {
  const count = name.readUInt16BE(2)
  const strings = name.readUInt16BE(4)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    const platform = name.readUInt16BE(rec)
    const len = name.readUInt16BE(rec + 8)
    const start = strings + name.readUInt16BE(rec + 10)
    const bytes = name.subarray(start, start + len)
    out.push(
      platform === 1 ? bytes.toString('latin1') : Buffer.from(bytes).swap16().toString('utf16le'),
    )
  }
  return out
}

describe('bundled font names', () => {
  const files = readdirSync(FONTS).filter((f) => /\.(woff2|ttf|otf)$/.test(f))

  it('finds the bundled faces', () => {
    expect(files.filter((f) => f.endsWith('.woff2')).length).toBeGreaterThan(20)
    expect(files.filter((f) => f.endsWith('.ttf')).length).toBeGreaterThan(10)
  })

  it.each(files)('%s names no GenOffice face', (file) => {
    const path = join(FONTS, file)
    const table = file.endsWith('.woff2') ? readWoff2Table(path, 'name') : sfntNameTable(path)
    const names = nameRecords(table!)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => /genoffice/i.test(n))).toEqual([])
  })
})
