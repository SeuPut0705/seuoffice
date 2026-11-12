import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { xlsxSidecarPath } from '../src/resources'
import {
  hiddenDocx,
  hiddenPptx,
  hiddenXlsx,
  NAMESPACES,
  PLACEHOLDER,
  SECRET,
} from './hidden-text-fixtures'
import { tempDir } from './helpers'

/** The document tools of the MCP server answer with what the commands read: nothing hidden from AI. */

describe('mcp: text hidden from AI stays hidden', () => {
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
    return content.find((c) => c.type === 'text')?.text ?? ''
  }

  it('docs_read gives the placeholder for a hidden span', async () => {
    const file = await hiddenDocx(dir, NAMESPACES[1]![1])
    const text = await call('docs_read', { file, full: true, html: true })
    expect(text).not.toContain(SECRET)
    expect(text).toContain(PLACEHOLDER)
  })

  it('slides_read gives the placeholder for a hidden run and hidden notes', async () => {
    const file = await hiddenPptx(dir)
    const text = await call('slides_read', { file, full: true })
    expect(text).not.toContain(SECRET)
    expect(text).toContain(PLACEHOLDER)
  })

  it.skipIf(!xlsxSidecarPath())('sheet_read gives the placeholder for a hidden cell', async () => {
    const file = await hiddenXlsx(dir)
    const text = await call('sheet_read', { file })
    expect(text).not.toContain(SECRET)
    expect(text).toContain(PLACEHOLDER)
  })
})
