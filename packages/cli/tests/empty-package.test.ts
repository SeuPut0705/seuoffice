import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNotEmptyPackage, assertPackageWithinLimits } from '../src/limits'
import { run } from './helpers'

const dirs: string[] = []
function empty(ext: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ieumoffice-empty-package-'))
  dirs.push(dir)
  const path = join(dir, `empty.${ext}`)
  writeFileSync(path, '')
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('empty packaged inputs', () => {
  it.each([
    'docx',
    'docm',
    'dotx',
    'dotm',
    'odt',
    'xlsx',
    'xlsm',
    'xltx',
    'xltm',
    'pptx',
    'pptm',
    'potx',
    'potm',
    'ppsx',
    'ppsm',
  ])('rejects a zero-byte .%s before the engine can create a blank document', (ext) => {
    expect(() => assertNotEmptyPackage(empty(ext), ext)).toThrow(/empty/i)
  })

  it('rejects conversion before launching the app or overwriting an existing output', async () => {
    const input = empty('pptx')
    const output = join(dirs.at(-1)!, 'existing.pdf')
    const previous = Buffer.from('existing output must survive')
    writeFileSync(output, previous)
    const r = await run(['convert', input, '--to', 'pdf', '--out', output, '--force', '--json'], {
      env: { GENOFFICE_APP_BIN: join(dirs.at(-1)!, 'missing-app') },
    })
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({
      status: 'error',
      error: 'invalid_argument',
      detail: { bytes: 0 },
      message: expect.stringMatching(/empty/i),
      suggestion: expect.stringMatching(/save the document once/i),
    })
    expect(readFileSync(input).length).toBe(0)
    expect(readFileSync(output)).toEqual(previous)
  })

  it.each(['md', 'html', 'csv'])('leaves an empty .%s to its text-format reader', (ext) => {
    expect(() => assertNotEmptyPackage(empty(ext), ext)).not.toThrow()
  })

  it('keeps the shared input check open to a zero-byte package so the editors can start a new document', () => {
    for (const ext of ['docx', 'xlsx', 'pptx', 'odt']) {
      expect(() => assertPackageWithinLimits(empty(ext), ext)).not.toThrow()
    }
  })

  it('does not refuse a zero-byte file for open, which lets the editor start a new document', async () => {
    const input = empty('docx')
    const r = await run(['open', input, '--json'], {
      env: { GENOFFICE_APP_BIN: join(dirs.at(-1)!, 'missing-app') },
    })
    // it got as far as launching the (missing) app instead of refusing the input
    expect(r.code).toBe(4)
    expect(r.json()).toMatchObject({ error: 'app_unavailable' })
  })

  it('still delegates nonempty malformed input to the engine for its own diagnosis', () => {
    const input = empty('pptx')
    writeFileSync(input, 'not a zip')
    expect(() => assertNotEmptyPackage(input, 'pptx')).not.toThrow()
    expect(() => assertPackageWithinLimits(input, 'pptx')).not.toThrow()
  })
})
