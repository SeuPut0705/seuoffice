import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { revisionsDocx } from '../../docx-engine/tests/helpers/hidden-revisions'
import {
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES,
} from '../../docx-engine/tests/helpers/hidden-stories'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { run, tempDir } from './helpers'

/**
 * A tracked change whose words a person hid from AI is listed with its
 * placeholder by `docs read` and the MCP tool behind it, and accepting or
 * rejecting changes echoes no hidden word.
 */

const MUTATIONS = ['none', ...TAG_MUTATION_NAMES] as const
const READ = [
  '--full',
  '--html',
  '--revisions',
  '--comments',
  '--notes',
  '--header-footer',
  '--fields',
  '--json',
]

describe.each([false, true])('docs read --revisions, hidden words literal: %s', (literal) => {
  it.each(MUTATIONS)('lists no hidden word (tags: %s)', async (mutation) => {
    const file = await revisionsDocx(tempDir(), mutation, literal)
    const read = await run(['docs', 'read', file, ...READ])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    expect(read.stderr).not.toContain(SECRET)
    if (mutation === 'none') {
      const revisions = read.json().detail.revisions as Array<{ text: string }>
      expect(revisions.length).toBeGreaterThan(0)
      for (const revision of revisions) expect(revision.text).toContain(PLACEHOLDER)
    }
  })

  it.each(['accept_changes', 'reject_changes'])('%s echoes no hidden word', async (op) => {
    const dir = tempDir()
    const file = await revisionsDocx(dir, 'none', literal)
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([{ op, all: true }]))
    const applied = await run(['docs', 'apply', file, '--ops', ops, '--json'])
    expect(applied.stdout).not.toContain(SECRET)
    expect(applied.stderr).not.toContain(SECRET)
  })
})

describe('mcp: docs_read with revisions', () => {
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

  it.each([false, true])('hands over no hidden word (literal: %s)', async (literal) => {
    for (const mutation of MUTATIONS) {
      const file = await revisionsDocx(dir, mutation, literal)
      const r = await client.callTool({
        name: 'docs_read',
        arguments: {
          file,
          full: true,
          html: true,
          revisions: true,
          comments: true,
          notes: true,
          'header-footer': true,
          fields: true,
        },
      })
      const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
      expect(text, mutation).not.toContain(SECRET)
    }
  })
})
