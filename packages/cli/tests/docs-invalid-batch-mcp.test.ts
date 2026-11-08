import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { run, tempDir } from './helpers'

describe('malformed document batch entries over MCP', () => {
  let ctx: McpContext
  let client: Client

  beforeAll(async () => {
    const dir = tempDir()
    ctx = createContext({
      cwd: dir,
      env: {
        ...process.env,
        GENOFFICE_USER_DATA: join(dir, 'user-data'),
        GENOFFICE_AUDIT_LOG: 'off',
      },
      log: () => {},
      scratchDir: join(dir, 'scratch'),
    })
    const server = await createMcpServer(ctx)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'batch-regression', version: '0' })
    await client.connect(clientTransport)
  })

  afterAll(async () => {
    await client?.close()
    if (ctx) disposeContext(ctx)
  })

  for (const dryRun of [false, true]) {
    for (const mode of ['atomic', 'best_effort', 'stop_on_error'] as const) {
      it(`${mode}, ${dryRun ? 'dry run' : 'save'}: returns structured failure and cleans inline files`, async () => {
        const dir = tempDir()
        const markdown = join(dir, 'source.md')
        const file = join(dir, 'source.docx')
        writeFileSync(markdown, '# Start\n\nBody.\n\nTail.\n')
        expect(
          (await run(['create', '--type', 'docx', '--from', markdown, '--out', file])).code,
        ).toBe(0)
        const before = readFileSync(file)
        const scratch = readdirSync(ctx.scratchDir).sort()
        const result = await client.callTool({
          name: 'docs_apply',
          arguments: {
            file,
            ops: [
              { op: 'insert_content', afterBlockIndex: 0, html: '<p>Inserted.</p>' },
              null,
              { op: 'findReplace', find: 'Body.', replace: 'Updated.' },
            ],
            dry_run: dryRun,
            ...(mode === 'atomic' ? {} : { [mode]: true }),
          },
        })
        const content = result.content as { type: string; text?: string }[]
        const reply = JSON.parse(
          content.find((part) => part.type === 'text' && part.text?.trimStart().startsWith('{'))!
            .text!,
        )
        expect(result.isError === true).toBe(mode === 'atomic')
        expect(reply.status).toBe(mode === 'atomic' ? 'error' : 'partial')
        if (mode !== 'atomic') expect(content[0]!.text).toMatch(/^partial:/)
        expect(reply.detail.failures[0]).toMatchObject({ index: 1, reason: 'invalid_argument' })
        expect(reply.detail.batch).toEqual({
          total: 3,
          applied: mode === 'atomic' ? 0 : mode === 'best_effort' ? 2 : 1,
          failed: 1,
          skipped: mode === 'atomic' ? 2 : mode === 'best_effort' ? 0 : 1,
        })
        expect(readdirSync(ctx.scratchDir).sort()).toEqual(scratch)
        const after = readFileSync(file)
        if (dryRun || mode === 'atomic') {
          expect(after.equals(before)).toBe(true)
        } else {
          const zip = await JSZip.loadAsync(after)
          const xml = await zip.file('word/document.xml')!.async('string')
          expect(xml).toContain('Inserted.')
          expect(xml).toContain(mode === 'best_effort' ? 'Updated.' : 'Body.')
          expect(xml).toContain('Tail.')
        }
      })
    }
  }
})
