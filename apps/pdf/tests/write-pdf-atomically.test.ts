import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writePdfAtomically } from '../src/main/atomic-write'

describe('writePdfAtomically', () => {
  it('replaces a file whose name is near the 255-byte file-name limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-atomic-'))
    // 80 Hangul letters + ".pdf" is 244 bytes; a temp name must not grow past 255
    const name = `${'가'.repeat(80)}.pdf`
    const target = join(dir, name)
    try {
      writeFileSync(target, 'old')
      await writePdfAtomically(target, new TextEncoder().encode('new'))
      expect(readFileSync(target, 'utf8')).toBe('new')
      // the temp file is renamed away, nothing is left beside the file
      expect(readdirSync(dir)).toEqual([name])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
