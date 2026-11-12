import { OLD_ENV_NAMES } from '@seuoffice/i18n'
import { describe, expect, it } from 'vitest'
import { plannedLaunch, type PlannedLaunch } from '../../src/main/mcp-client/local-launch'
import type { McpRuntimeKit } from '../../src/main/mcp-client/runtimes'

// The command and every main process still take a variable over from its
// earlier spelling, so a name the app must never hand to a local MCP server is
// refused under both. Before the rename one pattern covered what the product
// read; with only the new prefix refused, the earlier spelling of the same
// switch would reach a server that is this product's own command.

const kit: Pick<McpRuntimeKit, 'resolveCommand'> = {
  async resolveCommand() {
    return {
      ok: true,
      command: process.execPath,
      prefixArgs: [],
      env: {},
      pathPrepend: [],
      source: 'pc',
      runtime: 'node',
    }
  },
}

async function plan(env: Record<string, string>): Promise<Extract<PlannedLaunch, { ok: true }>> {
  const planned = await plannedLaunch({ command: 'node', args: [], env }, kit, { baseEnv: {} })
  if (!planned.ok) throw new Error(planned.message)
  return planned
}

describe('variables a person registered for a local MCP server', () => {
  it('are not passed on under the earlier spelling of a variable the product takes over', async () => {
    const earlier = OLD_ENV_NAMES.map((name) => `GENOFFICE_${name}`)
    const planned = await plan({
      MY_TOKEN: 'kept',
      ...Object.fromEntries(earlier.map((name) => [name, 'x'])),
    })
    expect(planned.env.map((v) => v.name)).toEqual(['MY_TOKEN'])
    expect(planned.droppedEnv).toEqual(earlier)
  })

  it('are not passed on under either prefix, whatever follows it and in any case', async () => {
    const planned = await plan({
      SEUOFFICE_ANYTHING: 'x',
      GENOFFICE_ANYTHING: 'x',
      genoffice_allowed_roots: 'x',
      MY_GENOFFICE_NOTE: 'kept',
    })
    expect(planned.env.map((v) => v.name)).toEqual(['MY_GENOFFICE_NOTE'])
    expect(planned.droppedEnv).toEqual([
      'SEUOFFICE_ANYTHING',
      'GENOFFICE_ANYTHING',
      'genoffice_allowed_roots',
    ])
  })
})
