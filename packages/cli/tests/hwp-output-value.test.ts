import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

beforeAll(async () => {
  await init({
    module_or_path: readFileSync(createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')),
  })
})

function fixture(format: 'hwp' | 'hwpx') {
  const dir = tempDir()
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  doc.insertText(0, 0, 0, 'Original answer')
  const original = format === 'hwp' ? doc.exportHwp() : doc.exportHwpx()
  doc.free()
  const input = join(dir, 'form.' + format)
  const ops = join(dir, 'ops.json')
  writeFileSync(input, original)
  writeFileSync(ops, JSON.stringify([{ op: 'replace_text', find: 'Original', replace: 'Revised' }]))
  return { dir, input, ops, original: Buffer.from(original) }
}

for (const format of ['hwp', 'hwpx'] as const) {
  for (const tail of [
    ['--out', '--json'],
    ['--out', '--dry-run', '--json'],
    ['--out=', '--json'],
  ]) {
    it(`refuses ${format} ${tail.join(' ')} without touching the input`, async () => {
      const { input, ops, original } = fixture(format)
      const r = await run(['hwp', 'apply', input, '--ops', ops, ...tail])
      expect(r.code, r.stdout).toBe(1)
      expect(r.json().error).toBe('missing_argument')
      expect(readFileSync(input)).toEqual(original)
      expect(existsSync(input + '.bak')).toBe(false)
    })
  }

  it(`keeps an omitted --out as a deliberate in-place ${format} edit`, async () => {
    const { input, ops, original } = fixture(format)
    const r = await run(['hwp', 'apply', input, '--ops', ops, '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(readFileSync(input)).not.toEqual(original)
    expect(readFileSync(input + '.bak')).toEqual(original)
  })

  it(`writes a named ${format} copy without changing its input`, async () => {
    const { dir, input, ops, original } = fixture(format)
    const output = join(dir, 'edited.' + format)
    const r = await run(['hwp', 'apply', input, '--ops', ops, '--out', output, '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(readFileSync(input)).toEqual(original)
    expect(existsSync(input + '.bak')).toBe(false)
    const reopened = new HwpDocument(readFileSync(output))
    try {
      expect(reopened.getTextFileText()).toContain('Revised answer')
    } finally {
      reopened.free()
    }
  })
}
