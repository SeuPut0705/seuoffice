/**
 * Quick Look reads a compound file (an .hwp for its preview picture, a .doc, .ppt or .hwp
 * for its text) only after the compound-file gate: a file whose sector tables loop or point
 * outside it gets no preview, and the window that asked stays alive.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearQuickLookCache,
  extractEmbeddedThumbnail,
  extractQuickLook,
} from '../src/main/quick-look/extract'
import {
  HOSTILE_FILES,
  REFUSAL_MS,
} from '../../../packages/compound-file/tests/helpers/raw-compound'

describe('Quick Look on a hostile compound file', () => {
  let tmpDir = ''

  afterEach(() => {
    clearQuickLookCache()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = ''
    }
  })

  for (const { what, build } of HOSTILE_FILES) {
    it(`${what}: no preview picture, quickly`, async () => {
      const bytes = Buffer.from(build())
      const started = performance.now()
      expect(await extractEmbeddedThumbnail('hwp', bytes)).toBeUndefined()
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
    })

    for (const ext of ['hwp', 'doc', 'ppt']) {
      it(`${what}: an .${ext} of it previews as unreadable, quickly`, async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'ql-compound-'))
        const path = join(tmpDir, `hostile.${ext}`)
        writeFileSync(path, build())
        const started = performance.now()
        const payload = await extractQuickLook(path)
        expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
        expect(payload.ok).toBe(false)
        expect(payload.error).toBe('unreadable')
      })
    }
  }
})

describe('Quick Look on a sound HWP file', () => {
  it('still shows its preview picture', async () => {
    const file = readFileSync(
      fileURLToPath(new URL('../../hwp/tests/fixtures/memo.hwp', import.meta.url)),
    )
    expect(await extractEmbeddedThumbnail('hwp', file)).toMatch(/^data:image\//)
  })
})
