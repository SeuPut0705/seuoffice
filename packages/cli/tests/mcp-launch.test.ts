import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSeuofficeLauncher, mcpSnippet, readMcpEntry, writeMcpEntry } from '../src/agent-mcp'
import {
  mcpLaunch,
  mcpLaunchFromLauncher,
  withCompactSchemas,
  type McpLaunch,
} from '../src/mcp-launch'
import { tempDir } from './helpers'

const WIN_DIR = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\seuoffice\\resources\\cli'
const WIN_APP: McpLaunch = {
  command: `${WIN_DIR}\\..\\..\\SeuOffice.exe`,
  args: [`${WIN_DIR}\\seuoffice.cjs`, 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}

describe('mcp launch entry', () => {
  it('is the absolute launcher on macOS and Linux', () => {
    expect(
      mcpLaunchFromLauncher('/Applications/seuoffice.app/Contents/Resources/cli/seuoffice'),
    ).toEqual({
      command: '/Applications/seuoffice.app/Contents/Resources/cli/seuoffice',
      args: ['mcp'],
    })
  })

  it('uses the absolute launcher while the linked dir is still off the PATH (genoffice#1019)', () => {
    const launcherDir = '/Applications/seuoffice.app/Contents/Resources/cli'
    expect(mcpLaunch({ status: 'present', launcherDir })).toEqual({
      command: 'seuoffice',
      args: ['mcp'],
    })
    expect(
      mcpLaunch({
        status: 'present',
        launcherDir,
        pathHint: 'export PATH="$HOME/.local/bin:$PATH"',
      }),
    ).toEqual({ command: `${launcherDir}/seuoffice`, args: ['mcp'] })
  })

  it('runs the packaged Windows app as Node on the bundle, exactly as the app snippet does', () => {
    const exists = (p: string) => p === `${WIN_DIR}\\..\\..\\SeuOffice.exe`
    const fromCli = mcpLaunchFromLauncher(`${WIN_DIR}\\seuoffice.cmd`, { exists })
    expect(fromCli).toEqual(WIN_APP)
    expect(fromCli).toEqual(mcpLaunch({ status: 'missing', launcherDir: WIN_DIR }))
    expect(fromCli).toEqual(mcpLaunch({ status: 'present', launcherDir: WIN_DIR }))
  })

  it('runs a Windows checkout on the system node with the built bundle', () => {
    const dir = 'D:\\src\\seuoffice\\packages\\cli\\bin'
    expect(mcpLaunchFromLauncher(`${dir}\\seuoffice`, { exists: () => false })).toEqual({
      command: 'node',
      args: [`${dir}\\..\\dist\\seuoffice.cjs`, 'mcp'],
    })
    expect(
      mcpLaunchFromLauncher('/mnt/src/packages/cli/bin/seuoffice', {
        platform: 'win32',
        exists: (p) => p.endsWith('/bin/seuoffice.cjs'),
      }),
    ).toEqual({ command: 'node', args: ['/mnt/src/packages/cli/bin/seuoffice.cjs', 'mcp'] })
  })

  it('recognises every launcher shape as ours', () => {
    expect(isSeuofficeLauncher('/opt/seuoffice/resources/cli/seuoffice')).toBe(true)
    expect(isSeuofficeLauncher('C:\\seuoffice\\resources\\cli\\seuoffice.cmd')).toBe(true)
    expect(isSeuofficeLauncher('C:\\Program Files\\seuoffice\\SeuOffice.exe')).toBe(true)
    expect(isSeuofficeLauncher(WIN_APP.command, WIN_APP.args)).toBe(true)
    expect(
      isSeuofficeLauncher('node', ['C:\\src\\packages\\cli\\dist\\seuoffice.cjs', 'mcp']),
    ).toBe(true)
    expect(isSeuofficeLauncher('npx', ['-y', 'other-mcp'])).toBe(false)
    expect(isSeuofficeLauncher(null)).toBe(false)
  })

  it('carries env in every config format', () => {
    const home = tempDir()
    for (const d of ['.cursor', '.gemini', '.copilot', '.codex', 'opencode'])
      mkdirSync(join(home, d))
    const cursor = join(home, '.cursor', 'mcp.json')
    writeMcpEntry('cursor', cursor, WIN_APP)
    expect(JSON.parse(readFileSync(cursor, 'utf-8')).mcpServers.seuoffice).toEqual({
      type: 'stdio',
      ...WIN_APP,
    })
    const gemini = join(home, '.gemini', 'settings.json')
    writeMcpEntry('gemini', gemini, WIN_APP)
    expect(JSON.parse(readFileSync(gemini, 'utf-8')).mcpServers.seuoffice).toEqual(WIN_APP)
    const copilot = join(home, '.copilot', 'mcp-config.json')
    writeMcpEntry('copilot', copilot, WIN_APP)
    expect(JSON.parse(readFileSync(copilot, 'utf-8')).mcpServers.seuoffice).toEqual({
      type: 'local',
      ...WIN_APP,
      tools: ['*'],
    })
    const opencode = join(home, 'opencode', 'opencode.json')
    writeMcpEntry('opencode', opencode, WIN_APP)
    expect(JSON.parse(readFileSync(opencode, 'utf-8')).mcp.seuoffice).toEqual({
      type: 'local',
      command: [WIN_APP.command, ...WIN_APP.args],
      enabled: true,
      environment: WIN_APP.env,
    })
    const codex = join(home, '.codex', 'config.toml')
    writeFileSync(codex, '[mcp_servers.other]\ncommand = "npx"\n')
    writeMcpEntry('codex', codex, WIN_APP)
    expect(readFileSync(codex, 'utf-8')).toBe(
      '[mcp_servers.other]\ncommand = "npx"\n\n' +
        `[mcp_servers.seuoffice]\ncommand = ${JSON.stringify(WIN_APP.command)}\nargs = ${JSON.stringify(WIN_APP.args)}\n\n` +
        '[mcp_servers.seuoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n',
    )
    for (const [id, file] of [
      ['cursor', cursor],
      ['gemini', gemini],
      ['copilot', copilot],
      ['opencode', opencode],
      ['codex', codex],
    ] as const) {
      expect(readMcpEntry(id, file, WIN_APP).status, id).toBe('registered')
      expect(
        readMcpEntry(id, file, { command: '/elsewhere/cli/seuoffice', args: ['mcp'] }).status,
        id,
      ).toBe('stale')
    }
    expect(mcpSnippet('codex', WIN_APP)).toContain('[mcp_servers.seuoffice.env]')
  })

  it('recognises an entry that asks for compact schemas as registered, not stale', () => {
    const home = tempDir()
    const compact = withCompactSchemas(WIN_APP)
    expect(compact.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SEUOFFICE_MCP_COMPACT_SCHEMAS: '1',
    })
    const exists = (p: string) => p === `${WIN_DIR}\\..\\..\\SeuOffice.exe`
    expect(
      mcpLaunch({ status: 'present', launcherDir: WIN_DIR }, { compactSchemas: true }),
    ).toEqual(compact)
    expect(
      mcpLaunchFromLauncher(`${WIN_DIR}\\seuoffice.cmd`, { exists, compactSchemas: true }),
    ).toEqual(compact)
    expect(
      mcpLaunchFromLauncher('/Applications/seuoffice.app/Contents/Resources/cli/seuoffice', {
        compactSchemas: true,
      }),
    ).toEqual({
      command: '/Applications/seuoffice.app/Contents/Resources/cli/seuoffice',
      args: ['mcp'],
      env: { SEUOFFICE_MCP_COMPACT_SCHEMAS: '1' },
    })

    const cursor = join(home, 'mcp.json')
    writeMcpEntry('cursor', cursor, compact)
    expect(readMcpEntry('cursor', cursor, WIN_APP)).toEqual({
      status: 'registered',
      command: compact.command,
      compactSchemas: true,
    })
    // the plain form is registered without the flag
    writeMcpEntry('cursor', cursor, WIN_APP)
    expect(readMcpEntry('cursor', cursor, WIN_APP)).toEqual({
      status: 'registered',
      command: WIN_APP.command,
    })

    const dsh = join(home, 'cordis.patch.yml')
    writeMcpEntry('dsh', dsh, compact)
    expect(readFileSync(dsh, 'utf-8')).toContain("SEUOFFICE_MCP_COMPACT_SCHEMAS: '1'")
    expect(readMcpEntry('dsh', dsh, WIN_APP)).toMatchObject({
      status: 'registered',
      compactSchemas: true,
    })

    const codex = join(home, 'config.toml')
    writeMcpEntry('codex', codex, compact)
    expect(readFileSync(codex, 'utf-8')).toContain('SEUOFFICE_MCP_COMPACT_SCHEMAS = "1"')
    expect(readMcpEntry('codex', codex, WIN_APP)).toMatchObject({
      status: 'registered',
      compactSchemas: true,
    })
  })

  it('treats the app snippet entry (SeuOffice.exe on seuoffice.cjs) as ours, not occupied', () => {
    const home = tempDir()
    const file = join(home, 'mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { seuoffice: WIN_APP } }))
    const posix = { command: '/opt/seuoffice/resources/cli/seuoffice', args: ['mcp'] }
    expect(readMcpEntry('cursor', file, posix)).toEqual({
      status: 'stale',
      command: WIN_APP.command,
    })
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { seuoffice: { command: 'node', args: ['/src/dist/seuoffice.cjs', 'mcp'] } },
      }),
    )
    expect(readMcpEntry('cursor', file, posix).status).toBe('stale')
    const toml = join(home, 'config.toml')
    writeFileSync(
      toml,
      `[mcp_servers.seuoffice]\ncommand = ${JSON.stringify(WIN_APP.command)}\nargs = ${JSON.stringify(WIN_APP.args)}\n[mcp_servers.seuoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n`,
    )
    expect(readMcpEntry('codex', toml, posix).status).toBe('stale')
    expect(readMcpEntry('codex', toml, WIN_APP).status).toBe('registered')
  })
})
