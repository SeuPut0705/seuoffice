import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import init, { HwpDocument } from '@rhwp/core'
import * as CFB from 'cfb'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import { openHwp, streamOf, writeContainer } from '../../../apps/hwp/src/main/hwp5-file'
import { run, tempDir } from './helpers'
const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }
beforeAll(async () => {
  await init({
    module_or_path: readFileSync(createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')),
  })
})

async function fixture(ext: 'hwp' | 'hwpx') {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  doc.insertText(0, 0, 0, 'Hello fixture')
  try {
    if (ext === 'hwpx') {
      const zip = await JSZip.loadAsync(doc.exportHwpx())
      return zip.generateAsync({
        type: 'nodebuffer',
        compression: 'STORE',
        comment: 'preserve this container comment',
      })
    }
    const opened = openHwp(doc.exportHwp())!
    for (const path of ['/DocInfo', '/BodyText/Section0']) {
      const entry = CFB.find(opened.cfb, path)!
      const content = deflateRawSync(streamOf(opened, path)!, { level: 0 })
      entry.content = content
      entry.size = content.length
    }
    return Buffer.from(writeContainer(opened.cfb))
  } finally {
    doc.free()
  }
}
async function setup(ext: 'hwp' | 'hwpx' = 'hwp') {
  const dir = tempDir(),
    input = join(dir, 'input.' + ext),
    ops = join(dir, 'ops.json')
  const bytes = await fixture(ext)
  writeFileSync(input, bytes)
  writeFileSync(ops, JSON.stringify([{ op: 'list_tables' }]))
  return { dir, input, ops, bytes }
}
describe('read-only HWP batches copy same-format source bytes', () => {
  it.each(['hwp', 'hwpx'] as const)(
    'keeps the original %s container byte-identical in --out',
    async (ext) => {
      const f = await setup(ext),
        out = join(f.dir, 'copy.' + ext)
      const r = await run(['hwp', 'apply', f.input, '--ops', f.ops, '--out', out, '--json'], {
        env,
      })
      expect(r.code, r.stdout).toBe(0)
      expect(readFileSync(out)).toEqual(f.bytes)
      expect(readFileSync(f.input)).toEqual(f.bytes)
      expect(r.json().detail.results[0].changed).toBe(false)
      expect(existsSync(f.input + '.bak')).toBe(false)
    },
  )
  it('still backs up an existing forced output before copying', async () => {
    const f = await setup(),
      out = join(f.dir, 'copy.hwp')
    writeFileSync(out, 'previous output')
    const r = await run(
      ['hwp', 'apply', f.input, '--ops', f.ops, '--out', out, '--force', '--json'],
      { env },
    )
    expect(r.code, r.stdout).toBe(0)
    expect(readFileSync(out)).toEqual(f.bytes)
    expect(readFileSync(out + '.bak', 'utf8')).toBe('previous output')
    expect(readFileSync(f.input)).toEqual(f.bytes)
  })
  it('keeps cross-format export on the engine path', async () => {
    const f = await setup(),
      out = join(f.dir, 'copy.hwpx')
    const r = await run(['hwp', 'apply', f.input, '--ops', f.ops, '--out', out, '--json'], { env })
    expect(r.code, r.stdout).toBe(0)
    expect(readFileSync(out).subarray(0, 2).toString()).toBe('PK')
    expect(
      (await run(['hwp', 'read', out, '--full', '--json'], { env })).json().detail.text,
    ).toContain('Hello fixture')
    expect(readFileSync(f.input)).toEqual(f.bytes)
  })
  it('still serializes a real text change', async () => {
    const f = await setup(),
      out = join(f.dir, 'edited.hwp')
    writeFileSync(f.ops, JSON.stringify([{ op: 'replace_text', find: 'Hello', replace: 'World' }]))
    const r = await run(['hwp', 'apply', f.input, '--ops', f.ops, '--out', out, '--json'], { env })
    expect(r.code, r.stdout).toBe(0)
    expect(
      (await run(['hwp', 'read', out, '--full', '--json'], { env })).json().detail.text,
    ).toContain('World fixture')
    expect(readFileSync(f.input)).toEqual(f.bytes)
  })
  it('does not write a read-only dry run', async () => {
    const f = await setup(),
      out = join(f.dir, 'copy.hwp')
    expect(
      (
        await run(['hwp', 'apply', f.input, '--ops', f.ops, '--out', out, '--dry-run', '--json'], {
          env,
        })
      ).code,
    ).toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(readFileSync(f.input)).toEqual(f.bytes)
  })
  it('keeps overwrite protection without --force', async () => {
    const f = await setup(),
      out = join(f.dir, 'copy.hwp')
    writeFileSync(out, 'keep')
    const r = await run(['hwp', 'apply', f.input, '--ops', f.ops, '--out', out, '--json'], { env })
    expect(r.code).toBe(2)
    expect(r.json().error).toBe('output_exists')
    expect(readFileSync(out, 'utf8')).toBe('keep')
  })
  it('keeps a read-only in-place batch completely untouched', async () => {
    const f = await setup()
    expect((await run(['hwp', 'apply', f.input, '--ops', f.ops, '--json'], { env })).code).toBe(0)
    expect(readFileSync(f.input)).toEqual(f.bytes)
    expect(existsSync(f.input + '.bak')).toBe(false)
  })
})
