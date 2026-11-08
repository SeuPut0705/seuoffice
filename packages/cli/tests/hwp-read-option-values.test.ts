import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { previewChars } from '../src/preview'
import { run, tempDir } from './helpers'
const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }
beforeAll(async () => {
  await init({
    module_or_path: readFileSync(createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')),
  })
})
function fixture(ext: string) {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  doc.insertText(0, 0, 0, 'Hello fixture text')
  const file = join(tempDir(), 'input.' + ext)
  writeFileSync(file, ext === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
  doc.free()
  return file
}
describe('read options need an explicit value when present', () => {
  it.each(['hwp', 'hwpx'].flatMap((ext) => ['offset', 'max-chars'].map((flag) => ({ ext, flag }))))(
    'rejects valueless --$flag on $ext',
    async ({ ext, flag }) => {
      const file = fixture(ext),
        before = readFileSync(file)
      const r = await run(['hwp', 'read', file, '--' + flag, '--json'], { env })
      expect(r.code).toBe(1)
      expect(r.json().error).toBe('invalid_argument')
      expect(readFileSync(file)).toEqual(before)
    },
  )
  it.each(['hwp', 'hwpx'])('keeps explicit offsets and limits on %s', async (ext) => {
    const file = fixture(ext)
    const r = await run(['hwp', 'read', file, '--offset', '6', '--max-chars', '7', '--json'], {
      env,
    })
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({ offset: 6, text: 'fixture', next_offset: 13 })
  })
  it('rejects the valueless common preview limit', () => {
    expect(() => previewChars({ positionals: [], flags: { 'max-chars': true } }, 200)).toThrowError(
      expect.objectContaining({ reason: 'invalid_argument' }),
    )
  })
  it('keeps absent defaults and the existing --full precedence', () => {
    expect(previewChars({ positionals: [], flags: {} }, 200)).toBe(200)
    expect(previewChars({ positionals: [], flags: { full: true, 'max-chars': true } }, 200)).toBe(
      Infinity,
    )
  })
})
