import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { xlsxSidecarPath } from '../src/resources'
import { hiddenXlsx, PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { expectNoGiveaway, richHiddenXlsx, withDrawing } from './rich-hidden-xlsx'
import { run, tempDir } from './helpers'

const sidecar = Boolean(xlsxSidecarPath())

async function zipText(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  const texts: string[] = []
  for (const [member, entry] of Object.entries(zip.files)) {
    if (!entry.dir && /\.(xml|csv|json|txt)$/.test(member)) texts.push(await entry.async('string'))
  }
  return texts.join('\n')
}

describe('AI-reachable xlsx readers over a workbook with a cell hidden from AI', () => {
  it.skipIf(!sidecar)(
    'sheet read, with every flag, withholds the cell and what it feeds',
    async () => {
      const file = await richHiddenXlsx(tempDir())
      for (const flags of [
        [],
        ['--formats'],
        ['--where', 'number'],
        ['--where', 'text'],
        ['--where', 'formula'],
        ['--stats'],
        ['--range', 'B2:D3'],
        ['--cols', 'B:D'],
      ]) {
        const read = await run(['sheet', 'read', file, ...flags, '--json'])
        expect(read.code).toBe(0)
        expectNoGiveaway(read.stdout + read.stderr, `sheet read ${flags.join(' ')}`)
      }
      const { rows } = (await run(['sheet', 'read', file, '--json'])).json().detail
      expect(rows[1][1]).toBe(PLACEHOLDER)
      expect(rows[2]).toEqual(['Lee', 'public', null, null])
    },
  )

  it.skipIf(!sidecar)('sheet check puts no cell value or formula in its findings', async () => {
    const file = await richHiddenXlsx(tempDir())
    const check = await run(['sheet', 'check', file, '--json'])
    expectNoGiveaway(check.stdout + check.stderr, 'sheet check')
  })

  it.skipIf(!sidecar)('sheet links lists nothing the cell holds', async () => {
    const file = await richHiddenXlsx(tempDir())
    const links = await run(['sheet', 'links', file, '--json'])
    expectNoGiveaway(links.stdout + links.stderr, 'sheet links')
  })

  it.skipIf(!sidecar)('info prints no cell value', async () => {
    const file = await richHiddenXlsx(tempDir())
    const info = await run(['info', file, '--json'])
    expect(info.code).toBe(0)
    expectNoGiveaway(info.stdout + info.stderr, 'info')
  })

  it.skipIf(!sidecar)(
    'convert to csv writes placeholders, not the cell or what it feeds',
    async () => {
      const dir = tempDir()
      const file = await richHiddenXlsx(dir)
      const out = join(dir, 'out.csv')
      const converted = await run(['convert', file, '--to', 'csv', '--out', out, '--json'])
      expectNoGiveaway(converted.stdout + converted.stderr, 'convert csv output')
      if (converted.code === 0) {
        const csv = readFileSync(out, 'utf8')
        expectNoGiveaway(csv, 'the csv')
        expect(csv).toContain(PLACEHOLDER)
        expect(csv).toContain('Lee,public')
      }
    },
  )

  it.skipIf(!sidecar)('convert to ods refuses: the writer cannot withhold a cell', async () => {
    const dir = tempDir()
    const file = await richHiddenXlsx(dir)
    const out = join(dir, 'out.ods')
    const converted = await run(['convert', file, '--to', 'ods', '--out', out, '--json'])
    expectNoGiveaway(converted.stdout + converted.stderr, 'convert ods output')
    expect(converted.code).not.toBe(0)
    expect(existsSync(out)).toBe(false)
  })

  it.skipIf(!sidecar)('convert to ods still works for a workbook with nothing hidden', async () => {
    const dir = tempDir()
    const table = join(dir, 'table.json')
    writeFileSync(table, JSON.stringify([['Name'], ['Kim']]))
    const file = join(dir, 'plain.xlsx')
    expect(
      (await run(['create', '--type', 'xlsx', '--from', table, '--out', file, '--json'])).code,
    ).toBe(0)
    const out = join(dir, 'plain.ods')
    expect((await run(['convert', file, '--to', 'ods', '--out', out, '--json'])).code).toBe(0)
    expect(await zipText(out)).toContain('Kim')
  })

  it.skipIf(!sidecar)('sheet apply echoes no cell it touched or computed from', async () => {
    const dir = tempDir()
    const file = await richHiddenXlsx(dir)
    const ops = join(dir, 'edit.json')
    writeFileSync(
      ops,
      JSON.stringify([
        { op: 'set_cell', address: 'A3', value: 'Park' },
        { op: 'set_cell', address: 'D3', value: '=A3&B3' },
      ]),
    )
    for (const flags of [['--dry-run'], []]) {
      const applied = await run(['sheet', 'apply', file, '--ops', ops, ...flags, '--json'])
      expect(applied.code).toBe(0)
      expectNoGiveaway(applied.stdout + applied.stderr, `sheet apply ${flags.join(' ')}`)
    }
    // the save kept the mark
    const read = await run(['sheet', 'read', file, '--json'])
    expect(read.json().detail.rows[1][1]).toBe(PLACEHOLDER)
    expectNoGiveaway(read.stdout, 'sheet read after the save')
  })

  it.skipIf(!sidecar)('an unmarked workbook converts to csv as before', async () => {
    const dir = tempDir()
    const table = join(dir, 'table.json')
    writeFileSync(
      table,
      JSON.stringify([
        ['Name', 'Phone'],
        ['Kim', Number(SECRET)],
      ]),
    )
    const file = join(dir, 'plain.xlsx')
    expect(
      (await run(['create', '--type', 'xlsx', '--from', table, '--out', file, '--json'])).code,
    ).toBe(0)
    const out = join(dir, 'plain.csv')
    expect((await run(['convert', file, '--to', 'csv', '--out', out, '--json'])).code).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain(`Kim,${SECRET}`)
  })
})

/** every command that opens a workbook for an agent, as its argv after the file */
const READERS: [string, string[]][] = [
  ['sheet read', ['sheet', 'read']],
  ['sheet read --formats', ['sheet', 'read', '--formats']],
  ['sheet read --stats', ['sheet', 'read', '--stats']],
  ['sheet read --where text', ['sheet', 'read', '--where', 'text']],
  ['sheet check', ['sheet', 'check']],
  ['sheet links', ['sheet', 'links']],
  ['info', ['info']],
]

async function expectNoReaderGiveaway(file: string): Promise<void> {
  for (const [what, argv] of READERS) {
    const [command, ...rest] = argv
    const read = await run([
      command!,
      ...(rest[0] && !rest[0].startsWith('-') ? [rest.shift()!] : []),
      file,
      ...rest,
      '--json',
    ])
    expectNoGiveaway(read.stdout + read.stderr, what)
  }
}

describe('pictures and shapes over a cell hidden from AI', () => {
  it.skipIf(!sidecar)('no reader names a picture, text box or alt text over the cell', async () => {
    const file = await withDrawing(await richHiddenXlsx(tempDir()))
    await expectNoReaderGiveaway(file)
    const csv = join(tempDir(), 'drawn.csv')
    expect((await run(['convert', file, '--to', 'csv', '--out', csv, '--json'])).code).toBe(0)
    expectNoGiveaway(readFileSync(csv, 'utf8'), 'the csv')
  })

  it.skipIf(!sidecar)(
    'a save keeps the drawing and the mark, and still lists nothing of it',
    async () => {
      const dir = tempDir()
      const file = await withDrawing(await richHiddenXlsx(dir))
      const ops = join(dir, 'edit.json')
      writeFileSync(ops, JSON.stringify([{ op: 'set_cell', address: 'A3', value: 'Park' }]))
      expect((await run(['sheet', 'apply', file, '--ops', ops, '--json'])).code).toBe(0)
      const zip = await JSZip.loadAsync(readFileSync(file))
      expect(
        Object.keys(zip.files).some((name) => /^xl\/drawings\/drawing\d*\.xml$/.test(name)),
      ).toBe(true)
      expect(await zip.file('xl/gxRedactions.json')!.async('string')).toContain('client phone')
      await expectNoReaderGiveaway(file)
    },
  )
})

describe('a hidden cell that reads as its own placeholder', () => {
  it.skipIf(!sidecar)(
    'stays withheld: what is hidden is decided by the mark, not the value',
    async () => {
      const dir = tempDir()
      const file = await hiddenXlsx(dir, 'literal.xlsx', async (path) => {
        const ops = join(dir, 'literal.json')
        writeFileSync(
          ops,
          JSON.stringify([{ op: 'set_cell', address: 'B2', value: PLACEHOLDER, type: 'text' }]),
        )
        expect((await run(['sheet', 'apply', path, '--ops', ops, '--json'])).code).toBe(0)
      })
      const read = await run(['sheet', 'read', file, '--json'])
      expect(read.code).toBe(0)
      const { rows, formulas } = read.json().detail
      expect(rows[1][1]).toBe(PLACEHOLDER)
      expect(rows[1][2]).toBe('{{private}}')
      expect(formulas).toEqual({})
      const csv = join(dir, 'literal.csv')
      expect((await run(['convert', file, '--to', 'csv', '--out', csv, '--json'])).code).toBe(0)
      expect(readFileSync(csv, 'utf8')).toContain(`Kim,${PLACEHOLDER},`)
      expect(readFileSync(csv, 'utf8')).not.toContain('27600276000')
      const check = await run(['sheet', 'check', file, '--json'])
      expect(check.json().detail.issues).toEqual([])
      expect(check.stdout).not.toContain('B2*2')
    },
  )
})

describe('mcp: the xlsx tools an agent calls', () => {
  let ctx: McpContext
  let client: Client
  let dir: string

  beforeAll(async () => {
    dir = tempDir()
    ctx = createContext({
      cwd: dir,
      env: { ...process.env, SEUOFFICE_AUDIT_LOG: 'off' },
      log: () => {},
    })
    const server = await createMcpServer(ctx, { registry: defaultRegistry() })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
  })

  afterAll(async () => {
    await client.close()
    disposeContext(ctx)
  })

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args })
    const content = r.content as { type: string; text?: string }[]
    return content.map((c) => c.text ?? '').join('\n')
  }

  it.skipIf(!sidecar)('sheet_read, sheet_check, info and convert hand over no cell', async () => {
    const file = await richHiddenXlsx(dir)
    for (const [tool, args] of [
      ['sheet_read', { file }],
      ['sheet_read', { file, stats: true, formats: true }],
      ['sheet_check', { file }],
      ['info', { file }],
      ['convert', { file, to: 'csv', out: join(dir, 'mcp.csv') }],
      ['convert', { file, to: 'ods', out: join(dir, 'mcp.ods') }],
    ] as const) {
      expectNoGiveaway(await call(tool, { ...args }), `mcp ${tool}`)
    }
    expect(readFileSync(join(dir, 'mcp.csv'), 'utf8')).toContain(PLACEHOLDER)
    expect(existsSync(join(dir, 'mcp.ods'))).toBe(false)
  })
})
