import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readMcpEntry, removeMcpEntry, writeMcpEntry } from '../src/agent-mcp'
import type { AgentId } from '../src/agent-skills'
import { tempDir } from './helpers'

/**
 * An earlier version could register a bare `ieumoffice mcp` (the command
 * resolved through PATH). It is still our entry when nothing else owns that
 * name: PATH does not know it, or PATH takes it to our install. When PATH
 * takes it to another program's install, it stays that program's.
 */

const LAUNCH = {
  command: '/Applications/SeuOffice.app/Contents/Resources/cli/seuoffice',
  args: ['mcp'],
}

function pathTo(product: string): NodeJS.ProcessEnv {
  const root = tempDir()
  const cli = join(root, 'opt', product, 'resources', 'cli')
  mkdirSync(cli, { recursive: true })
  writeFileSync(join(cli, 'ieumoffice'), '#!/bin/sh\n')
  mkdirSync(join(root, 'bin'))
  symlinkSync(join(cli, 'ieumoffice'), join(root, 'bin', 'ieumoffice'))
  return { PATH: join(root, 'bin') }
}
const NOTHING_ON_PATH: NodeJS.ProcessEnv = { PATH: tempDir() }
const OURS_ON_PATH = pathTo('SeuOffice')
const OTHER_ON_PATH = pathTo('OtherOffice')

interface Case {
  agent: AgentId
  file: string
  bare: string
  keys: (file: string) => string[]
}

const json = {
  agent: 'claude-code' as const,
  file: 'claude.json',
  bare: `${JSON.stringify({ mcpServers: { ieumoffice: { type: 'stdio', command: 'ieumoffice', args: ['mcp'] } } }, null, 2)}\n`,
  keys: (file: string) => Object.keys(JSON.parse(readFileSync(file, 'utf-8')).mcpServers),
}
const toml = {
  agent: 'codex' as const,
  file: 'config.toml',
  bare: 'model = "gpt-5"\n\n[mcp_servers.ieumoffice]\ncommand = "ieumoffice"\nargs = ["mcp"]\n',
  keys: (file: string) =>
    [...readFileSync(file, 'utf-8').matchAll(/^\[mcp_servers\.([^\].]+)\]/gm)].map((m) => m[1]!),
}
const dsh = {
  agent: 'dsh' as const,
  file: 'cordis.patch.yml',
  bare: [
    '- insert:',
    '  - id: mcp-ieumoffice',
    "    name: '@deepseek-ai/dsh-mcp-client'",
    '    config:',
    '      serverName: ieumoffice',
    '      transport: stdio',
    '      command: ieumoffice',
    "      args: ['mcp']",
    '      toolCallTimeoutMs: 180000',
    '      failOnStartupError: false',
    '',
  ].join('\n'),
  keys: (file: string) =>
    [...readFileSync(file, 'utf-8').matchAll(/^\s+serverName: (\S+)/gm)].map((m) => m[1]!),
}
const CASES: Case[] = [json, toml, dsh]

function setup(c: Case): string {
  const file = join(tempDir(), c.file)
  writeFileSync(file, c.bare)
  return file
}

describe.each(CASES)('a bare `ieumoffice mcp` entry in the $agent config', (c) => {
  it('that no PATH entry names is ours: listed stale, install leaves one entry of ours', () => {
    const file = setup(c)
    expect(readMcpEntry(c.agent, file, LAUNCH, NOTHING_ON_PATH).status).toBe('stale')
    writeMcpEntry(c.agent, file, LAUNCH, NOTHING_ON_PATH)
    expect(c.keys(file)).toEqual(['seuoffice'])
    expect(readMcpEntry(c.agent, file, LAUNCH, NOTHING_ON_PATH).status).toBe('registered')
  })

  it('that no PATH entry names is removed by uninstall', () => {
    const file = setup(c)
    expect(removeMcpEntry(c.agent, file, NOTHING_ON_PATH)).toBe(true)
    expect(c.keys(file)).toEqual([])
    expect(removeMcpEntry(c.agent, file, NOTHING_ON_PATH)).toBe(false)
  })

  it('that PATH takes to our install is ours', () => {
    const file = setup(c)
    expect(readMcpEntry(c.agent, file, LAUNCH, OURS_ON_PATH).status).toBe('stale')
  })

  it("that PATH takes to another program's install stays foreign", () => {
    const file = setup(c)
    expect(readMcpEntry(c.agent, file, LAUNCH, OTHER_ON_PATH).status).not.toBe('stale')
    writeMcpEntry(c.agent, file, LAUNCH, OTHER_ON_PATH)
    expect(c.keys(file)).toContain('ieumoffice')
    expect(readFileSync(file, 'utf-8')).toContain('command')
    const before = readFileSync(file, 'utf-8')
    expect(removeMcpEntry(c.agent, file, OTHER_ON_PATH)).toBe(true)
    expect(readFileSync(file, 'utf-8')).not.toBe(before)
    expect(c.keys(file)).toContain('ieumoffice')
  })
})
