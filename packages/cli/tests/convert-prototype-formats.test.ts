import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'
const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }

describe('conversion only recognizes registered format names', () => {
  it.each(
    ['constructor', '__proto__'].flatMap((ext) =>
      ['empty', 'text', 'zip'].map((kind) => ({ ext, kind })),
    ),
  )('rejects .$ext ($kind) as unsupported before touching output', async ({ ext, kind }) => {
    const dir = tempDir()
    const input = join(dir, `input.${ext}`)
    const zip = new JSZip().file('anything.txt', 'ordinary archive')
    const bytes =
      kind === 'zip'
        ? await zip.generateAsync({ type: 'nodebuffer' })
        : Buffer.from(kind === 'empty' ? '' : 'ordinary text')
    writeFileSync(input, bytes)
    const out = join(dir, 'existing.html')
    const sentinel = Buffer.from('keep this output')
    writeFileSync(out, sentinel)
    const r = await run(['convert', input, '--to', 'html', '--out', out, '--force', '--json'], {
      env,
    })
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unsupported')
    expect(readFileSync(input)).toEqual(bytes)
    expect(readFileSync(out)).toEqual(sentinel)
  })

  it('keeps an ordinary unsupported extension on the same error path', async () => {
    const file = join(tempDir(), 'input.unknown')
    writeFileSync(file, 'text')
    const r = await run(['convert', file, '--to', 'html', '--json'], { env })
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unsupported')
  })

  it('keeps Markdown conversion working', async () => {
    const dir = tempDir()
    const input = join(dir, 'input.md')
    writeFileSync(input, '# Hello')
    const out = join(dir, 'output.html')
    const r = await run(['convert', input, '--to', 'html', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    expect(readFileSync(out, 'utf-8')).toContain('<h1>Hello</h1>')
    expect(readFileSync(input, 'utf-8')).toBe('# Hello')
  })

  it('still rejects an empty registered package as an input error', async () => {
    const input = join(tempDir(), 'input.docx')
    writeFileSync(input, '')
    const r = await run(['convert', input, '--to', 'html', '--json'], { env })
    expect(r.code).toBe(2)
    expect(r.json().error).toBe('invalid_argument')
    expect(r.json().detail).toEqual({ bytes: 0 })
  })
})
