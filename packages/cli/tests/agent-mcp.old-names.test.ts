import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSeuofficeLauncher,
  mcpSnippet,
  readMcpEntry,
  removeMcpEntry,
  writeMcpEntry,
} from '../src/agent-mcp'
import type { AgentId } from '../src/agent-skills'
import type { McpLaunch } from '../src/mcp-launch'
import { run, tempDir } from './helpers'

// An installed version registered `ieumoffice mcp` under the key `ieumoffice`.
// After the rename that entry is still ours: it is reported, moved to the
// `seuoffice` key by the next install and removed by an uninstall. Another app
// registers the very same names, so an entry is ours only when it starts this
// product: its launcher sits in a SeuOffice install, or its binary is ours.
// Everything else under the old key, and the upstream `genoffice` entry, is
// never touched.

const NOW: McpLaunch = {
  command: '/Applications/SeuOffice.app/Contents/Resources/cli/seuoffice',
  args: ['mcp'],
}
const OLD_LAUNCHER = '/Applications/SeuOffice.app/Contents/Resources/cli/ieumoffice'
const OLD_WINDOWS = {
  command:
    'C:\\Users\\u\\AppData\\Local\\Programs\\SeuOffice\\resources\\cli\\..\\..\\SeuOffice.exe',
  args: ['C:\\Users\\u\\AppData\\Local\\Programs\\SeuOffice\\resources\\cli\\genoffice.cjs', 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}
const UPSTREAM = {
  type: 'stdio',
  command:
    'C:\\Users\\u\\AppData\\Local\\Programs\\GenOffice\\resources\\cli\\..\\..\\GenOffice.exe',
  args: ['C:\\Users\\u\\AppData\\Local\\Programs\\GenOffice\\resources\\cli\\genoffice.cjs', 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}
/** Another product that registers the old names in its own install */
const OTHER_LAUNCHER = '/Applications/OtherOffice.app/Contents/Resources/cli/ieumoffice'
const OTHER_WINDOWS = {
  command:
    'C:\\Users\\u\\AppData\\Local\\Programs\\OtherOffice\\resources\\cli\\..\\..\\OtherOffice.exe',
  args: [
    'C:\\Users\\u\\AppData\\Local\\Programs\\OtherOffice\\resources\\cli\\genoffice.cjs',
    'mcp',
  ],
}
const FOREIGN = { command: 'npx', args: ['-y', 'ieumoffice-lookalike'] }

const pretty = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf-8'))

/** A PATH whose `ieumoffice` is a link to the launcher in `<product>/resources/cli` */
function pathTo(product: string): NodeJS.ProcessEnv {
  const root = tempDir()
  const cli = join(root, 'opt', product, 'resources', 'cli')
  mkdirSync(cli, { recursive: true })
  writeFileSync(join(cli, 'ieumoffice'), '#!/bin/sh\n')
  mkdirSync(join(root, 'bin'))
  symlinkSync(join(cli, 'ieumoffice'), join(root, 'bin', 'ieumoffice'))
  return { PATH: join(root, 'bin') }
}
const OURS_ON_PATH = pathTo('SeuOffice')
const OTHER_ON_PATH = pathTo('OtherOffice')
const NOTHING_ON_PATH: NodeJS.ProcessEnv = { PATH: '' }

/** Entries under the old key that are not ours, with the PATH they are read under */
const NOT_OURS: Array<[string, { command: string; args: string[] }, NodeJS.ProcessEnv]> = [
  ['another program', FOREIGN, NOTHING_ON_PATH],
  ["a launcher in another product's install", { command: OTHER_LAUNCHER, args: ['mcp'] }, {}],
  ["another product's binary on the old bundle", OTHER_WINDOWS, {}],
  [
    "a bare old command PATH takes to another product's install",
    { command: 'ieumoffice', args: ['mcp'] },
    OTHER_ON_PATH,
  ],
  [
    'a bare old command PATH does not know, with other arguments',
    { command: 'ieumoffice', args: ['serve'] },
    NOTHING_ON_PATH,
  ],
]

/** The keys holding an entry that starts one of our launchers, whatever the entry's shape */
function ourKeys(servers: Record<string, any>, env: NodeJS.ProcessEnv): string[] {
  return Object.keys(servers).filter((key) => {
    const { command, args } = servers[key]
    return Array.isArray(command)
      ? isSeuofficeLauncher(command[0], command.slice(1), env)
      : isSeuofficeLauncher(command ?? null, args ?? [], env)
  })
}

const JSON_AGENTS: Array<[AgentId, string]> = [
  ['claude-code', 'mcpServers'],
  ['cursor', 'mcpServers'],
  ['gemini', 'mcpServers'],
  ['copilot', 'mcpServers'],
  ['opencode', 'mcp'],
  ['windsurf', 'mcpServers'],
]
const oldEntry = (id: AgentId, launch: { command: string; args: string[] }) =>
  id === 'opencode'
    ? { type: 'local', command: [launch.command, ...launch.args], enabled: true }
    : { type: 'stdio', ...launch }

describe('our entry under the old key in a JSON config', () => {
  it.each(JSON_AGENTS)(
    '%s: reads as ours, moves to the new key on install, goes on uninstall',
    (id, key) => {
      const file = join(tempDir(), 'config.json')
      writeFileSync(
        file,
        pretty({
          [key]: {
            genoffice: UPSTREAM,
            ieumoffice: oldEntry(id, { command: OLD_LAUNCHER, args: ['mcp'] }),
            other: {},
          },
          theme: 'dark',
        }),
      )

      expect(readMcpEntry(id, file, NOW)).toEqual({ status: 'stale', command: OLD_LAUNCHER })

      writeMcpEntry(id, file, NOW)
      const doc = readJson(file)
      expect(Object.keys(doc[key])).toEqual(['genoffice', 'other', 'seuoffice'])
      expect(ourKeys(doc[key], NOTHING_ON_PATH)).toEqual(['seuoffice'])
      expect(doc[key].genoffice).toEqual(UPSTREAM)
      expect(doc.theme).toBe('dark')
      expect(readMcpEntry(id, file, NOW).status).toBe('registered')

      // an older app writes its entry back as the bare command PATH takes to our install
      doc[key].ieumoffice = oldEntry(id, { command: 'ieumoffice', args: ['mcp'] })
      writeFileSync(file, pretty(doc))
      expect(readMcpEntry(id, file, NOW, OURS_ON_PATH).status).toBe('stale')
      expect(removeMcpEntry(id, file, OURS_ON_PATH)).toBe(true)
      expect(readJson(file)).toEqual({ [key]: { genoffice: UPSTREAM, other: {} }, theme: 'dark' })
      expect(removeMcpEntry(id, file, OURS_ON_PATH)).toBe(false)
    },
  )

  it.each(
    JSON_AGENTS.flatMap(([id, key]) =>
      NOT_OURS.map(([what, launch, env]) => [id, key, what, launch, env] as const),
    ),
  )(
    '%s: %s, %s, under the old key survives install and uninstall byte for byte',
    (id, key, _what, launch, env) => {
      const file = join(tempDir(), 'config.json')
      const foreign = oldEntry(id, launch)
      const original = pretty({ [key]: { genoffice: UPSTREAM, ieumoffice: foreign } })
      writeFileSync(file, original)

      expect(readMcpEntry(id, file, NOW, env)).toEqual({ status: 'absent', command: null })
      expect(removeMcpEntry(id, file, env)).toBe(false)
      expect(readFileSync(file, 'utf-8')).toBe(original)

      writeMcpEntry(id, file, NOW, env)
      expect(readJson(file)[key]).toEqual({
        genoffice: UPSTREAM,
        ieumoffice: foreign,
        seuoffice: expect.anything(),
      })
      expect(readMcpEntry(id, file, NOW, env).status).toBe('registered')
      expect(removeMcpEntry(id, file, env)).toBe(true)
      expect(readFileSync(file, 'utf-8')).toBe(original)
    },
  )

  it("Claude Code: another product's old launcher under our current key is occupied, not ours", () => {
    const file = join(tempDir(), '.claude.json')
    writeFileSync(
      file,
      pretty({ mcpServers: { seuoffice: { command: OTHER_LAUNCHER, args: ['mcp'] } } }),
    )
    expect(readMcpEntry('claude-code', file, NOW)).toEqual({
      status: 'occupied',
      command: OTHER_LAUNCHER,
    })
  })

  it('Claude Code: the Windows form (SeuOffice.exe on the old bundle) is ours and moves', () => {
    const file = join(tempDir(), '.claude.json')
    writeFileSync(file, pretty({ numStartups: 3, mcpServers: { ieumoffice: OLD_WINDOWS } }))
    expect(readMcpEntry('claude-code', file, NOW)).toEqual({
      status: 'stale',
      command: OLD_WINDOWS.command,
    })
    writeMcpEntry('claude-code', file, NOW)
    expect(readJson(file)).toEqual({
      numStartups: 3,
      mcpServers: { seuoffice: { type: 'stdio', ...NOW } },
    })
  })

  it('Claude Code: our entry under both keys reads as stale until the old one is gone', () => {
    const file = join(tempDir(), '.claude.json')
    const current = { type: 'stdio', ...NOW }
    writeFileSync(file, pretty({ mcpServers: { seuoffice: current, ieumoffice: OLD_WINDOWS } }))
    expect(readMcpEntry('claude-code', file, NOW)).toEqual({
      status: 'stale',
      command: NOW.command,
    })
    writeMcpEntry('claude-code', file, NOW)
    expect(readJson(file)).toEqual({ mcpServers: { seuoffice: current } })
    expect(readMcpEntry('claude-code', file, NOW).status).toBe('registered')
  })
})

describe('the [mcp_servers.ieumoffice] table in the Codex config', () => {
  const HEAD =
    'model = "gpt-5"\n\n' +
    `[mcp_servers.genoffice]\ncommand = ${JSON.stringify(UPSTREAM.command)}\nargs = ${JSON.stringify(UPSTREAM.args)}\n\n` +
    '[mcp_servers.ieumoffice-editor]\nurl = "http://127.0.0.1:3093/mcp"\n\n'
  const OLD_TABLE =
    `[mcp_servers.ieumoffice]\ncommand = ${JSON.stringify(OLD_WINDOWS.command)}\nargs = ${JSON.stringify(OLD_WINDOWS.args)}\n\n` +
    '[mcp_servers.ieumoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n\n'
  const TAIL = '[projects."/tmp/x"]\ntrust_level = "trusted"\n'
  const table = (launch: McpLaunch) => mcpSnippet('codex', launch)

  it('of ours: reads as ours, is replaced by the new table on install, sub-table included', () => {
    const file = join(tempDir(), 'config.toml')
    writeFileSync(file, HEAD + OLD_TABLE + TAIL)

    expect(readMcpEntry('codex', file, NOW)).toEqual({
      status: 'stale',
      command: OLD_WINDOWS.command,
    })
    writeMcpEntry('codex', file, NOW)
    expect(readFileSync(file, 'utf-8')).toBe(`${HEAD}${TAIL}\n${table(NOW)}`)
    expect(readMcpEntry('codex', file, NOW).status).toBe('registered')
  })

  it('of ours: goes on uninstall together with the new table, the rest byte for byte', () => {
    const file = join(tempDir(), 'config.toml')
    writeFileSync(file, `${HEAD}${OLD_TABLE}${TAIL}\n${table(NOW)}`)
    expect(readMcpEntry('codex', file, NOW).status).toBe('stale')
    expect(removeMcpEntry('codex', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(HEAD + TAIL)
    expect(removeMcpEntry('codex', file)).toBe(false)
  })

  it.each([
    '[mcp_servers."ieumoffice"]',
    "[mcp_servers.'ieumoffice']",
    '[ mcp_servers . ieumoffice ]',
  ])('%s with the bare old command PATH takes to our install is ours', (header) => {
    const file = join(tempDir(), 'config.toml')
    writeFileSync(file, `${HEAD}${header}\ncommand = "ieumoffice"\nargs = ["mcp"]\n\n${TAIL}`)
    expect(readMcpEntry('codex', file, NOW, OURS_ON_PATH)).toEqual({
      status: 'stale',
      command: 'ieumoffice',
    })
    expect(removeMcpEntry('codex', file, OURS_ON_PATH)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(HEAD + TAIL)
  })

  it.each(NOT_OURS)('of %s survives install and uninstall byte for byte', (_what, launch, env) => {
    const file = join(tempDir(), 'config.toml')
    const foreign =
      `[mcp_servers.ieumoffice]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n\n` +
      '[mcp_servers.ieumoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n'
    const original = HEAD + foreign
    writeFileSync(file, original)

    expect(readMcpEntry('codex', file, NOW, env)).toEqual({ status: 'absent', command: null })
    expect(removeMcpEntry('codex', file, env)).toBe(false)
    writeMcpEntry('codex', file, NOW, env)
    expect(readFileSync(file, 'utf-8')).toBe(`${original}\n${table(NOW)}`)
    expect(readMcpEntry('codex', file, NOW, env).status).toBe('registered')
    expect(removeMcpEntry('codex', file, env)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(original)
  })
})

describe('recognising an entry that uses an old name', () => {
  it('takes it as ours only when it starts this product', () => {
    expect(isSeuofficeLauncher(OLD_LAUNCHER, ['mcp'])).toBe(true)
    expect(isSeuofficeLauncher('C:\\Programs\\SeuOffice\\resources\\cli\\ieumoffice.cmd')).toBe(
      true,
    )
    expect(isSeuofficeLauncher('/opt/SeuOffice/resources/cli/ieumoffice')).toBe(true)
    expect(isSeuofficeLauncher(OLD_WINDOWS.command, OLD_WINDOWS.args)).toBe(true)
    expect(isSeuofficeLauncher('ieumoffice', ['mcp'], OURS_ON_PATH)).toBe(true)

    for (const [what, launch, env] of NOT_OURS) {
      expect(isSeuofficeLauncher(launch.command, launch.args, env), what).toBe(false)
    }
    expect(isSeuofficeLauncher('C:\\Programs\\OtherOffice\\resources\\cli\\ieumoffice.cmd')).toBe(
      false,
    )
    // an old bundle proves nothing: the system node in some checkout is not this product
    expect(
      isSeuofficeLauncher('node', ['C:\\src\\packages\\cli\\dist\\genoffice.cjs', 'mcp']),
    ).toBe(false)
    expect(isSeuofficeLauncher(UPSTREAM.command, UPSTREAM.args)).toBe(false)
    expect(isSeuofficeLauncher('genoffice', ['mcp'])).toBe(false)
  })
})

describe('seuoffice mcp on a machine an older version registered', () => {
  it('moves our old entries to the new key and leaves another product’s alone', async () => {
    const home = tempDir()
    for (const dot of ['.cursor', '.codex', '.gemini']) mkdirSync(join(home, dot))
    const env = { SEUOFFICE_HOME: home, PATH: OTHER_ON_PATH.PATH } as NodeJS.ProcessEnv
    const cursor = join(home, '.cursor', 'mcp.json')
    const codex = join(home, '.codex', 'config.toml')
    const gemini = join(home, '.gemini', 'settings.json')
    writeFileSync(
      cursor,
      pretty({
        mcpServers: { ieumoffice: { type: 'stdio', command: OLD_LAUNCHER, args: ['mcp'] } },
      }),
    )
    writeFileSync(
      codex,
      `[mcp_servers.ieumoffice]\ncommand = ${JSON.stringify(OLD_LAUNCHER)}\nargs = ["mcp"]\n`,
    )
    // the bare old command, which PATH here takes to another product
    const geminiBefore = pretty({
      mcpServers: { ieumoffice: { command: 'ieumoffice', args: ['mcp'] } },
    })
    writeFileSync(gemini, geminiBefore)
    const rowsOf = (r: { json: () => any }) =>
      (r.json().detail.agents as Array<Record<string, unknown>>).filter((a) =>
        ['cursor', 'codex', 'gemini'].includes(a.agent as string),
      )

    const listed = rowsOf(await run(['mcp', 'list', '--json'], { env }))
    expect(listed.map((a) => [a.agent, a.status])).toEqual([
      ['codex', 'stale'],
      ['cursor', 'stale'],
      ['gemini', 'absent'],
    ])

    const installed = await run(['mcp', 'install', 'all', '--json'], { env })
    expect(installed.code).toBe(0)
    expect(rowsOf(installed).map((a) => a.status)).toEqual(['updated', 'updated', 'installed'])
    expect(Object.keys(readJson(cursor).mcpServers)).toEqual(['seuoffice'])
    const toml = readFileSync(codex, 'utf-8')
    expect(toml).toContain('[mcp_servers.seuoffice]')
    expect(toml).not.toContain('ieumoffice')
    expect(Object.keys(readJson(gemini).mcpServers)).toEqual(['ieumoffice', 'seuoffice'])

    const again = await run(['mcp', 'install', 'all', '--json'], { env })
    expect(rowsOf(again).map((a) => a.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])

    const removed = await run(['mcp', 'uninstall', 'all', '--json'], { env })
    expect(rowsOf(removed).map((a) => a.status)).toEqual(['removed', 'removed', 'removed'])
    expect(readFileSync(gemini, 'utf-8')).toBe(geminiBefore)
  })
})
