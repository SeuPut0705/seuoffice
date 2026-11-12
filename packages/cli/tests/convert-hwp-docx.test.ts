import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hwpToText } from '@genoffice/file-parse/hwp'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function documentText(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((m) => m[1])
    .join('')
    .replace(/\s+/g, '')
}

describe('convert a Hangul document to docx', () => {
  for (const [name, via] of [
    ['memo.hwp', 'rhwp'],
    ['title-table-zone-fill.hwpx', undefined],
  ] as const) {
    it(`converts ${name} headlessly and keeps its first line of text`, async () => {
      const input = fileURLToPath(
        new URL(`../../../apps/hwp/tests/fixtures/${name}`, import.meta.url),
      )
      const out = join(tempDir(), 'out.docx')
      const r = await run(['convert', input, '--to', 'docx', '--out', out, '--json'])
      expect(r.code).toBe(0)
      expect(r.json().detail.via).toBe(via)
      expect(r.json().detail.blocks).toBeGreaterThan(0)
      const firstLine = (await hwpToText(readFileSync(input)))
        .split('\n')
        .find((line) => line.trim() !== '')
      expect(firstLine).toBeTruthy()
      expect(await documentText(out)).toContain(firstLine!.split(' | ')[0]!.replace(/\s+/g, ''))
    })
  }

  it('refuses a file that is neither HWP nor HWPX', async () => {
    const input = join(tempDir(), 'fake.hwp')
    writeFileSync(input, 'not a hangul document')
    const r = await run(['convert', input, '--to', 'docx', '--json'])
    expect(r.code).toBe(3)
    expect(r.json().detail.reason).toBe('unreadable')
  })
})
