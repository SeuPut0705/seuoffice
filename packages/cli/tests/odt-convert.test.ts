import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { odtToDocx, odtToText } from '@genoffice/odt-engine'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError, EXIT } from '../src/result'
import { run, tempDir } from './helpers'
import { formOdt, writeFormOdt, zipEntries } from './odt-fixtures'

/** The app's headless export never runs in tests: this stand-in records what it was given. */
const app = vi.hoisted(() => ({
  calls: [] as Array<{ input: string; target: string; output: string; inputBytes: Buffer }>,
  fail: false,
  docx: null as Uint8Array | null,
}))

vi.mock('../src/formats/app-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/formats/app-export')>()),
  exportViaApp: async (input: string, target: string, output: string) => {
    app.calls.push({ input, target, output, inputBytes: readFileSync(input) })
    if (app.fail) throw new CliError(EXIT.conversion, 'export failed')
    writeFileSync(output, target === 'docx' ? app.docx! : `${target} from ${input}`)
    return { outputPath: output, summary: 'exported' }
  },
}))

beforeEach(() => {
  app.calls = []
  app.fail = false
})

/** Nothing the conversion staged is left beside the output. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.ieumoffice-odt-'))
}

describe('convert routes through .odt', () => {
  it('odt → docx writes the bridge docx and reports what changed', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const r = await run(['convert', odt, '--to', 'docx', '--json'])
    expect(r.code).toBe(0)
    const out = r.json()
    const expected = (await odtToDocx(await formOdt())).report
    expect(expected.length).toBeGreaterThan(0)
    expect(out.detail.odt_report).toEqual(expected)
    expect(out.warnings.map((w: { code: string }) => w.code)).toEqual(
      expected.map((i) => (i.kind === 'converted' ? 'odt_converted' : 'odt_dropped')),
    )
    for (const [i, item] of expected.entries()) {
      expect(out.warnings[i].message).toContain(item.feature)
      expect(out.warnings[i].message).toContain(String(item.count))
    }
    const entries = await zipEntries(readFileSync(join(dir, 'form.docx')))
    expect(entries.get('word/document.xml')!.toString('utf8')).toContain('alpha')
  })

  it('odt → md goes through the docx route in memory', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const r = await run(['convert', odt, '--to', 'md', '--json'])
    expect(r.code).toBe(0)
    const md = readFileSync(join(dir, 'form.md'), 'utf8')
    expect(md).toContain('Title')
    expect(md).toContain('alpha')
    expect(r.json().detail.odt_report).toEqual((await odtToDocx(await formOdt())).report)
    expect(leftovers(dir)).toEqual([])
  })

  it.each(['pdf', 'html'])(
    'odt → %s exports a temporary docx through the app and deletes it',
    async (to) => {
      const dir = tempDir()
      const odt = await writeFormOdt(dir)
      const r = await run(['convert', odt, '--to', to, '--json'])
      expect(r.code, r.stdout).toBe(0)
      expect(app.calls).toHaveLength(1)
      const call = app.calls[0]!
      expect(call.target).toBe(to)
      expect(call.input).toMatch(/form\.docx$/)
      expect(call.inputBytes.subarray(0, 2).toString('latin1')).toBe('PK')
      expect(call.output).toBe(join(dir, `form.${to}`))
      expect(existsSync(call.input)).toBe(false)
      expect(leftovers(dir)).toEqual([])
      expect(r.json().detail.odt_report.length).toBeGreaterThan(0)
      expect(r.json().warnings.length).toBe(r.json().detail.odt_report.length)
    },
  )

  it('deletes the temporary docx when the app export fails', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    app.fail = true
    const r = await run(['convert', odt, '--to', 'pdf', '--json'])
    expect(r.code).toBe(EXIT.conversion)
    expect(app.calls).toHaveLength(1)
    expect(existsSync(app.calls[0]!.input)).toBe(false)
    expect(leftovers(dir)).toEqual([])
  })

  it('md → odt and docx → odt write a new ODT with its report', async () => {
    const dir = tempDir()
    const md = join(dir, 'notes.md')
    writeFileSync(md, '# Notes\n\nFirst **point**.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
    const r = await run(['convert', md, '--to', 'odt', '--json'])
    expect(r.code, r.stdout).toBe(0)
    const odt = readFileSync(join(dir, 'notes.odt'))
    expect((await zipEntries(odt)).get('mimetype')!.toString()).toBe(
      'application/vnd.oasis.opendocument.text',
    )
    expect(await odtToText(odt)).toContain('First point.')
    // a theme part alone changes nothing visible, so a plain document reports nothing
    expect(r.json().detail.odt_report).toEqual([])
    expect(r.json().warnings ?? []).toEqual([])

    // a docx with a comment: the ODT cannot keep it
    const docx = join(dir, 'notes.docx')
    expect((await run(['convert', md, '--to', 'docx'])).code).toBe(0)
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([{ op: 'add_comment', blockIndex: 1, comment: 'check' }]))
    expect((await run(['docs', 'apply', docx, '--ops', ops])).code).toBe(0)
    const out = join(dir, 'from-docx.odt')
    const d = await run(['convert', docx, '--to', 'odt', '--out', out, '--json'])
    expect(d.code, d.stdout).toBe(0)
    expect(d.json().detail.odt_report).toContainEqual({
      kind: 'dropped',
      feature: 'comment',
      count: 1,
    })
    expect(d.json().warnings).toContainEqual(
      expect.objectContaining({ code: 'odt_dropped', message: expect.stringContaining('comment') }),
    )
    expect(await odtToText(readFileSync(out))).toContain('Notes')
  })

  it('html → odt converts through a temporary docx from the app and deletes it', async () => {
    const dir = tempDir()
    const md = join(dir, 'page.md')
    writeFileSync(md, '# Page\n\nBody text.\n')
    expect((await run(['convert', md, '--to', 'docx', '--out', join(dir, 'made.docx')])).code).toBe(
      0,
    )
    app.docx = readFileSync(join(dir, 'made.docx'))
    const html = join(dir, 'page.html')
    writeFileSync(html, '<h1>Page</h1><p>Body text.</p>')
    const r = await run(['convert', html, '--to', 'odt', '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(app.calls).toHaveLength(1)
    expect(app.calls[0]).toMatchObject({ input: html, target: 'docx' })
    expect(existsSync(app.calls[0]!.output)).toBe(false)
    expect(leftovers(dir)).toEqual([])
    expect(await odtToText(readFileSync(join(dir, 'page.odt')))).toContain('Body text.')
  })

  it('lists the ODT routes and still refuses others', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const r = await run(['convert', odt, '--to', 'pptx', '--json'])
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unsupported')
    expect(r.json().detail.supported).toContain('odt→docx/pdf/md/html')
  })
})
