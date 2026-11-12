import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { tempDir } from './helpers'

/**
 * The agent skill an earlier version installed (skills/ieumoffice/SKILL.md)
 * stays on a user's machine and tells the agent to read the guides at
 * ieumoffice://guide/…: those addresses still answer, with the same text as
 * the current ones, and are not listed twice.
 */
describe('the guide resources under the old scheme', () => {
  let client: Client
  let ctx: McpContext

  beforeAll(async () => {
    ctx = createContext({
      cwd: tempDir(),
      env: { ...process.env, SEUOFFICE_AUDIT_LOG: 'off' },
      log: () => {},
    })
    const server = await createMcpServer(ctx, { registry: defaultRegistry() })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    client = new Client({ name: 'old-skill', version: '0' })
    await client.connect(b)
  })

  afterAll(async () => {
    await client.close()
    disposeContext(ctx)
  })

  const text = async (uri: string) =>
    ((await client.readResource({ uri })).contents[0] as { text: string }).text

  it.each(['docs', 'sheets', 'slides/spec', 'slides/templates'])(
    'ieumoffice://guide/%s reads as the current guide',
    async (path) => {
      const current = await text(`seuoffice://guide/${path}`)
      expect(current.length).toBeGreaterThan(100)
      expect(await text(`ieumoffice://guide/${path}`)).toBe(current)
    },
  )

  it('lists each guide once, under the current scheme', async () => {
    const { resources } = await client.listResources()
    expect(resources.filter((r) => r.uri.startsWith('ieumoffice://'))).toEqual([])
  })

  it('an old address with no guide behind it is an error, not an empty answer', async () => {
    await expect(client.readResource({ uri: 'ieumoffice://guide/nothing-here' })).rejects.toThrow()
  })
})
