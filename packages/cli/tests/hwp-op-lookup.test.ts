import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'
const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }
beforeAll(async () => {
  await init({
    module_or_path: readFileSync(createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')),
  })
})
async function apply(ext: string, op: string) {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  doc.insertText(0, 0, 0, 'Synthetic document')
  const dir = tempDir(),
    file = join(dir, 'input.' + ext),
    ops = join(dir, 'ops.json')
  const bytes = Buffer.from(ext === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
  doc.free()
  writeFileSync(file, bytes)
  writeFileSync(ops, JSON.stringify([{ op }]))
  const r = await run(['hwp', 'apply', file, '--ops', ops, '--json'], { env })
  expect(readFileSync(file)).toEqual(bytes)
  return r
}
describe('HWP operation lookup does not inherit object properties', () => {
  it.each(
    ['hwp', 'hwpx'].flatMap((ext) =>
      ['constructor', 'toString', '__proto__'].map((op) => ({ ext, op })),
    ),
  )('classifies $op on $ext as unknown_op', async ({ ext, op }) => {
    const r = await apply(ext, op)
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unknown_op')
    expect(r.json().detail.failures[0]).toMatchObject({ op, reason: 'unknown_op' })
    expect(r.json().detail.failures[0].supported).toContain('read_document')
    expect(r.json().message).not.toContain('native code')
  })
  it('keeps the refusal of real app-only tools', async () => {
    const r = await apply('hwp', 'generate_image')
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unsupported')
  })
  it('keeps ordinary unknown operations unknown', async () => {
    const r = await apply('hwp', 'not_a_tool')
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unknown_op')
  })
  it('keeps a real read-only operation available', async () => {
    const r = await apply('hwp', 'list_tables')
    expect(r.code).toBe(0)
    expect(r.json().detail.results[0]).toMatchObject({ op: 'list_tables', changed: false })
  })
})
