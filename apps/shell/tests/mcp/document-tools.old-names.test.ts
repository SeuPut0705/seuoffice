import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServerService } from '../../src/main/mcp/mcp-server'
import { createDocumentTools } from '../../src/main/mcp/tools/document-tools'
import { createSessionHost } from '../../src/main/mcp/tools/session-tools'
import { fakeCli } from './fake-cli'

// The tool that opens a file in the app was `open_in_genoffice` before it
// became `open_in_seuoffice`. A client that still has the old name in an
// allow list or a saved prompt gets the same tool; the list shows the new name.

let service: McpServerService | undefined
let client: Client | undefined
let dir: string
let port: number
let opened: string[]

// the shell compiles against ES2022, which has no Promise.withResolvers
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const p = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(p))
    })
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seuoffice-mcp-old-'))
  opened = []
  port = await freePort()
  service = new McpServerService({
    port,
    tools: createDocumentTools(
      {
        version: '0.9.0-test',
        defaultSaveDir: () => dir,
        openInTab: (filePath) => {
          opened.push(filePath)
        },
        cli: fakeCli().runner,
      },
      createSessionHost(),
    ),
  })
  await service.start()
})

afterEach(async () => {
  await client?.close()
  client = undefined
  await service?.stop()
  service = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('open_in_genoffice, the old name of open_in_seuoffice', () => {
  it('opens the file like the new name, and only the new name is listed', async () => {
    client = new Client({ name: 'old-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    const file = join(dir, 'old.docx')
    await writeFile(file, 'placeholder')

    const result = await client.callTool({ name: 'open_in_genoffice', arguments: { path: file } })
    expect(result.isError).toBeFalsy()
    expect(opened).toEqual([file])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('open_in_seuoffice')
    expect(names).not.toContain('open_in_genoffice')
  })

  it('reports the tool error the new name reports', async () => {
    client = new Client({ name: 'old-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    const missing = join(dir, 'missing.docx')
    const result = await client.callTool({
      name: 'open_in_genoffice',
      arguments: { path: missing },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('file not found')
    expect(opened).toEqual([])
  })

  it('works over the legacy SSE transport too', async () => {
    client = new Client({ name: 'old-sse-client', version: '0.0.0' })
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)))
    const file = join(dir, 'sse.docx')
    await writeFile(file, 'placeholder')
    const result = await client.callTool({ name: 'open_in_genoffice', arguments: { path: file } })
    expect(result.isError).toBeFalsy()
    expect(opened).toEqual([file])
  })
})
