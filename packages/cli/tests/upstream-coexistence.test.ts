import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  isSeuofficeLauncher,
  MCP_SERVER_NAME,
  mcpSnippet,
  readMcpEntry,
  removeMcpEntry,
  writeMcpEntry,
} from '../src/agent-mcp'
import {
  buildSkillZip,
  bundledSkillFrom,
  installSkill,
  readInstallState,
  SKILL_NAME,
  skillFilePath,
  uninstallSkill,
  type AgentId,
  type SkillLedger,
} from '../src/agent-skills'
import { auditLogPath } from '../src/audit'
import { defaultRegistry } from '../src/cli'
import { controlEndpoint } from '../src/control'
import { CONTROL_FILE } from '../src/control-protocol'
import { seuofficeDevUserDataDir, seuofficeUserDataDir } from '../src/gui'
import { inspectCliLink, installCliLink, isOurLauncher } from '../src/install'
import { INSTRUCTIONS, remoteInstructions } from '../src/mcp/server'
import { resolveTools } from '../src/mcp/tools'
import { mcpLaunch, mcpLaunchFromLauncher, type McpLaunch } from '../src/mcp-launch'
import { CLI_COMMAND, HOME_DIR_NAME } from '../src/names'
import { appBinaryForResources, installedAppBinaries } from '../src/resources'
import { run, tempDir } from './helpers'

// The upstream GenOffice may be installed on the same machine. Everything this
// product registers there carries its own name, and nothing the upstream app
// registered (its command, its MCP entry, its skill folder, its home folder,
// its app binary) is ever read as ours, replaced or removed.

const REPO = resolve(__dirname, '../../..')

const OURS: McpLaunch = {
  command: '/Applications/seuoffice.app/Contents/Resources/cli/seuoffice',
  args: ['mcp'],
}
const OURS_WINDOWS: McpLaunch = {
  command:
    'C:\\Users\\u\\AppData\\Local\\Programs\\seuoffice\\resources\\cli\\..\\..\\SeuOffice.exe',
  args: ['C:\\Users\\u\\AppData\\Local\\Programs\\seuoffice\\resources\\cli\\genoffice.cjs', 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}
const UPSTREAM_POSIX = {
  command: '/Applications/GenOffice.app/Contents/Resources/cli/genoffice',
  args: ['mcp'],
}
const UPSTREAM_WINDOWS = {
  command:
    'C:\\Users\\u\\AppData\\Local\\Programs\\GenOffice\\resources\\cli\\..\\..\\GenOffice.exe',
  args: ['C:\\Users\\u\\AppData\\Local\\Programs\\GenOffice\\resources\\cli\\genoffice.cjs', 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}

const pretty = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`

describe('registered names', () => {
  it('are all seuoffice', () => {
    expect(CLI_COMMAND).toBe('seuoffice')
    expect(MCP_SERVER_NAME).toBe('seuoffice')
    expect(SKILL_NAME).toBe('seuoffice')
    expect(HOME_DIR_NAME).toBe('.seuoffice')
  })

  it('keeps the audit log under ~/.seuoffice', () => {
    expect(auditLogPath({})).toBe(join(homedir(), '.seuoffice', 'cli-audit.jsonl'))
    expect(auditLogPath({ SEUOFFICE_AUTH_DIR: '/custom' })).toBe(join('/custom', 'cli-audit.jsonl'))
  })
})

describe("an upstream genoffice MCP entry in an agent's JSON config", () => {
  const JSON_AGENTS: Array<[AgentId, string]> = [
    ['claude-code', 'mcpServers'],
    ['cursor', 'mcpServers'],
    ['gemini', 'mcpServers'],
    ['copilot', 'mcpServers'],
    ['opencode', 'mcp'],
    ['windsurf', 'mcpServers'],
  ]

  it.each(JSON_AGENTS)(
    '%s: survives our install, re-install and uninstall unchanged',
    (id, key) => {
      const file = join(tempDir(), 'config.json')
      const upstream =
        id === 'opencode'
          ? { type: 'local', command: [UPSTREAM_POSIX.command, 'mcp'], enabled: true }
          : { type: 'stdio', ...UPSTREAM_WINDOWS }
      const original = pretty({
        [key]: { genoffice: upstream, other: { url: 'https://x.test/mcp' } },
        theme: 'dark',
      })
      writeFileSync(file, original)

      expect(readMcpEntry(id, file, OURS)).toEqual({ status: 'absent', command: null })
      expect(removeMcpEntry(id, file)).toBe(false)
      expect(readFileSync(file, 'utf-8')).toBe(original)

      writeMcpEntry(id, file, OURS)
      let doc = JSON.parse(readFileSync(file, 'utf-8'))
      expect(Object.keys(doc[key])).toEqual(['genoffice', 'other', 'seuoffice'])
      expect(doc[key].genoffice).toEqual(upstream)
      expect(readMcpEntry(id, file, OURS).status).toBe('registered')

      // an update to another install path replaces only our entry
      writeMcpEntry(id, file, OURS_WINDOWS)
      doc = JSON.parse(readFileSync(file, 'utf-8'))
      expect(doc[key].genoffice).toEqual(upstream)
      expect(readMcpEntry(id, file, OURS).status).toBe('stale')
      expect(readMcpEntry(id, file, OURS_WINDOWS).status).toBe('registered')

      expect(removeMcpEntry(id, file)).toBe(true)
      expect(readFileSync(file, 'utf-8')).toBe(original)
      expect(removeMcpEntry(id, file)).toBe(false)
      expect(readFileSync(file, 'utf-8')).toBe(original)
    },
  )

  it('is never offered as the snippet key', () => {
    expect(Object.keys(JSON.parse(mcpSnippet('cursor', OURS)).mcpServers)).toEqual(['seuoffice'])
    expect(mcpSnippet('codex', OURS)).toContain('[mcp_servers.seuoffice]')
    expect(mcpSnippet('codex', OURS)).not.toContain('genoffice')
  })
})

describe('an upstream [mcp_servers.genoffice] table in the Codex config', () => {
  const ORIGINAL =
    'model = "gpt-5"\n\n' +
    `[mcp_servers.genoffice]\ncommand = ${JSON.stringify(UPSTREAM_WINDOWS.command)}\nargs = ${JSON.stringify(UPSTREAM_WINDOWS.args)}\n\n` +
    '[mcp_servers.genoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n\n' +
    '[mcp_servers."genoffice-editor"]\nurl = "http://127.0.0.1:3093/mcp"\n\n' +
    '[projects."/tmp/x"]\ntrust_level = "trusted"\n'

  const table = (launch: McpLaunch) => mcpSnippet('codex', launch)

  it('survives our install, re-install and uninstall byte for byte, sub-tables included', () => {
    const file = join(tempDir(), 'config.toml')
    writeFileSync(file, ORIGINAL)

    expect(readMcpEntry('codex', file, OURS)).toEqual({ status: 'absent', command: null })
    expect(removeMcpEntry('codex', file)).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL)

    writeMcpEntry('codex', file, OURS)
    expect(readFileSync(file, 'utf-8')).toBe(`${ORIGINAL}\n${table(OURS)}`)
    expect(readMcpEntry('codex', file, OURS).status).toBe('registered')

    // re-install with an env sub-table of our own, then back without it
    writeMcpEntry('codex', file, OURS_WINDOWS)
    expect(readFileSync(file, 'utf-8')).toBe(`${ORIGINAL}\n${table(OURS_WINDOWS)}`)
    expect(table(OURS_WINDOWS)).toContain('[mcp_servers.seuoffice.env]')
    expect(readMcpEntry('codex', file, OURS)).toEqual({
      status: 'stale',
      command: OURS_WINDOWS.command,
    })
    writeMcpEntry('codex', file, OURS)
    expect(readFileSync(file, 'utf-8')).toBe(`${ORIGINAL}\n${table(OURS)}`)

    expect(removeMcpEntry('codex', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL)
    expect(removeMcpEntry('codex', file)).toBe(false)
  })

  it('survives when our table sits in the middle of the file', () => {
    const file = join(tempDir(), 'config.toml')
    const head = '[mcp_servers.genoffice]\ncommand = "genoffice"\nargs = ["mcp"]\n\n'
    const tail = '[mcp_servers.genoffice.env]\nFOO = "1"\n\n[mcp_servers.other]\ncommand = "npx"\n'
    const stale =
      '[mcp_servers.seuoffice]\ncommand = "/old/seuoffice.app/Contents/Resources/cli/seuoffice"\nargs = ["mcp"]\n\n' +
      '[mcp_servers.seuoffice.env]\nBAR = "2"\n\n'
    writeFileSync(file, head + stale + tail)

    expect(readMcpEntry('codex', file, OURS)).toEqual({
      status: 'stale',
      command: '/old/seuoffice.app/Contents/Resources/cli/seuoffice',
    })
    writeMcpEntry('codex', file, OURS)
    expect(readFileSync(file, 'utf-8')).toBe(`${head}${tail}\n${table(OURS)}`)
    expect(removeMcpEntry('codex', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(head + tail)
  })

  it.each([
    '[mcp_servers."genoffice"]',
    "[mcp_servers.'genoffice']",
    '[ mcp_servers . genoffice ]',
    '[mcp_servers.genoffice.env]',
    '[mcp_servers.genoffice-editor]',
    '[mcp_servers.seuoffice-editor]',
  ])('%s is not our table', (header) => {
    const file = join(tempDir(), 'config.toml')
    const original = `${header}\ncommand = "genoffice"\nargs = ["mcp"]\n`
    writeFileSync(file, original)
    expect(readMcpEntry('codex', file, OURS).status).toBe('absent')
    expect(removeMcpEntry('codex', file)).toBe(false)
    writeMcpEntry('codex', file, OURS)
    expect(readFileSync(file, 'utf-8')).toBe(`${original}\n${table(OURS)}`)
    expect(removeMcpEntry('codex', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(original)
  })
})

describe('recognising our own launcher in an existing entry', () => {
  it('accepts this product only, never the upstream launcher or app', () => {
    expect(isSeuofficeLauncher(OURS.command, OURS.args)).toBe(true)
    expect(isSeuofficeLauncher('C:\\seuoffice\\resources\\cli\\seuoffice.cmd')).toBe(true)
    expect(isSeuofficeLauncher(OURS_WINDOWS.command, OURS_WINDOWS.args)).toBe(true)
    expect(isSeuofficeLauncher('seuoffice', ['mcp'])).toBe(true)
    // a checkout runs the bundle on the system node
    expect(isSeuofficeLauncher('node', ['/src/packages/cli/dist/genoffice.cjs', 'mcp'])).toBe(true)

    expect(isSeuofficeLauncher(UPSTREAM_POSIX.command, UPSTREAM_POSIX.args)).toBe(false)
    expect(isSeuofficeLauncher('C:\\GenOffice\\resources\\cli\\genoffice.cmd')).toBe(false)
    expect(isSeuofficeLauncher(UPSTREAM_WINDOWS.command, UPSTREAM_WINDOWS.args)).toBe(false)
    expect(isSeuofficeLauncher('genoffice', ['mcp'])).toBe(false)
  })

  it('reports an seuoffice entry that starts the upstream app as occupied, not as ours', () => {
    const file = join(tempDir(), 'mcp.json')
    const original = pretty({ mcpServers: { seuoffice: { type: 'stdio', ...UPSTREAM_WINDOWS } } })
    writeFileSync(file, original)
    expect(readMcpEntry('cursor', file, OURS)).toEqual({
      status: 'occupied',
      command: UPSTREAM_WINDOWS.command,
    })
    const toml = join(tempDir(), 'config.toml')
    writeFileSync(
      toml,
      `[mcp_servers.seuoffice]\ncommand = ${JSON.stringify(UPSTREAM_POSIX.command)}\nargs = ["mcp"]\n`,
    )
    expect(readMcpEntry('codex', toml, OURS).status).toBe('occupied')
  })
})

describe('seuoffice mcp on a machine that has the upstream registered', () => {
  it('lists, installs, re-installs and uninstalls without touching the upstream entries', async () => {
    const home = tempDir()
    mkdirSync(join(home, '.cursor'))
    mkdirSync(join(home, '.codex'))
    const env = { SEUOFFICE_HOME: home } as NodeJS.ProcessEnv
    const cursor = join(home, '.cursor', 'mcp.json')
    const codex = join(home, '.codex', 'config.toml')
    const cursorBefore = pretty({
      mcpServers: { genoffice: { type: 'stdio', ...UPSTREAM_WINDOWS } },
    })
    const codexBefore =
      `[mcp_servers.genoffice]\ncommand = ${JSON.stringify(UPSTREAM_POSIX.command)}\nargs = ["mcp"]\n\n` +
      '[mcp_servers.genoffice.env]\nFOO = "1"\n'
    writeFileSync(cursor, cursorBefore)
    writeFileSync(codex, codexBefore)
    const upstreamIntact = () => {
      expect(JSON.parse(readFileSync(cursor, 'utf-8')).mcpServers.genoffice).toEqual({
        type: 'stdio',
        ...UPSTREAM_WINDOWS,
      })
      expect(readFileSync(codex, 'utf-8').startsWith(codexBefore)).toBe(true)
    }
    const rowsOf = (r: { json: () => any }) =>
      (r.json().detail.agents as Array<Record<string, unknown>>).filter(
        (a) => a.agent === 'cursor' || a.agent === 'codex',
      )

    const listed = await run(['mcp', 'list', '--json'], { env })
    expect(listed.code).toBe(0)
    for (const row of rowsOf(listed)) {
      expect(row).toMatchObject({ registered: false, status: 'absent', command: null })
    }
    // nothing of ours yet: uninstall has nothing to remove and leaves both files alone
    const noop = await run(['mcp', 'uninstall', 'all', '--json'], { env })
    expect(noop.code).toBe(0)
    expect(rowsOf(noop).map((a) => a.status)).toEqual(['absent', 'absent'])
    expect(readFileSync(cursor, 'utf-8')).toBe(cursorBefore)
    expect(readFileSync(codex, 'utf-8')).toBe(codexBefore)

    const installed = await run(['mcp', 'install', 'all', '--json'], { env })
    expect(installed.code).toBe(0)
    expect(rowsOf(installed).map((a) => a.status)).toEqual(['installed', 'installed'])
    expect(JSON.parse(readFileSync(cursor, 'utf-8')).mcpServers.seuoffice).toBeDefined()
    expect(readFileSync(codex, 'utf-8')).toContain('\n[mcp_servers.seuoffice]\n')
    upstreamIntact()

    const again = await run(['mcp', 'install', 'all', '--json'], { env })
    expect(rowsOf(again).map((a) => a.status)).toEqual(['unchanged', 'unchanged'])
    upstreamIntact()

    // --force is about an entry under OUR name; it never reaches the upstream one
    const removed = await run(['mcp', 'uninstall', 'all', '--force', '--json'], { env })
    expect(removed.code).toBe(0)
    expect(rowsOf(removed).map((a) => a.status)).toEqual(['removed', 'removed'])
    expect(readFileSync(cursor, 'utf-8')).toBe(cursorBefore)
    expect(readFileSync(codex, 'utf-8')).toBe(codexBefore)
  })
})

describe('an upstream genoffice skill folder', () => {
  const ourSkill = bundledSkillFrom(
    Buffer.from(
      "---\nname: seuoffice\ndescription: test\nmetadata:\n  version: 1.2.0\n  cli: '>=0.4.0'\n---\n\nRun `seuoffice --version` first.\n",
    ),
  )
  const UPSTREAM_SKILL =
    "---\nname: genoffice\ndescription: upstream\nmetadata:\n  version: 9.9.9\n  cli: '>=0.4.0'\n---\n\nRun `genoffice --version` first.\n"

  function skillsDirWithUpstream() {
    const skills = join(tempDir(), 'skills')
    mkdirSync(join(skills, 'genoffice'), { recursive: true })
    writeFileSync(join(skills, 'genoffice', 'SKILL.md'), UPSTREAM_SKILL)
    writeFileSync(join(skills, 'genoffice', 'notes.txt'), 'kept')
    return skills
  }
  const upstreamIntact = (skills: string) => {
    expect(readdirSync(join(skills, 'genoffice')).sort()).toEqual(['SKILL.md', 'notes.txt'])
    expect(readFileSync(join(skills, 'genoffice', 'SKILL.md'), 'utf-8')).toBe(UPSTREAM_SKILL)
    expect(readFileSync(join(skills, 'genoffice', 'notes.txt'), 'utf-8')).toBe('kept')
  }

  it('is not seen as an install of ours and survives install, re-install and uninstall', () => {
    const skills = skillsDirWithUpstream()
    const ledger: SkillLedger = {}
    const path = join(skills, 'seuoffice', 'SKILL.md')
    expect(skillFilePath(skills)).toBe(path)
    expect(readInstallState(skills, ourSkill, ledger)).toEqual({ status: 'missing', path })

    expect(installSkill(skills, ourSkill, ledger)).toBe(path)
    expect(readInstallState(skills, ourSkill, ledger).status).toBe('installed')
    expect(Object.keys(ledger)).toEqual([path])
    upstreamIntact(skills)

    installSkill(skills, ourSkill, ledger)
    upstreamIntact(skills)

    expect(uninstallSkill(skills, ledger)).toBe(true)
    expect(existsSync(join(skills, 'seuoffice'))).toBe(false)
    expect(readdirSync(skills)).toEqual(['genoffice'])
    upstreamIntact(skills)
  })

  it('is never removed, even when a ledger names its path', () => {
    const skills = skillsDirWithUpstream()
    const upstreamPath = join(skills, 'genoffice', 'SKILL.md')
    const ledger: SkillLedger = {
      [upstreamPath]: {
        version: '9.9.9',
        sha256: 'x',
        at: '2026-01-01T00:00:00.000Z',
        channel: 'app',
      },
    }
    expect(uninstallSkill(skills, ledger)).toBe(false)
    expect(Object.keys(ledger)).toEqual([upstreamPath])
    upstreamIntact(skills)
  })

  it("copied into our folder name is somebody else's content, not our skill", () => {
    const skills = join(tempDir(), 'skills')
    mkdirSync(join(skills, 'seuoffice'), { recursive: true })
    writeFileSync(join(skills, 'seuoffice', 'SKILL.md'), UPSTREAM_SKILL)
    expect(readInstallState(skills, ourSkill, {}).status).toBe('occupied')
  })

  it('stays out of the uploaded zip layout', async () => {
    const zip = await JSZip.loadAsync(await buildSkillZip(ourSkill))
    expect(Object.keys(zip.files).filter((f) => !zip.files[f]!.dir)).toEqual(['seuoffice/SKILL.md'])
    expect(Object.keys(zip.files).some((f) => f.startsWith('genoffice'))).toBe(false)
  })

  it('survives the skill command on a machine that has it', async () => {
    const home = tempDir()
    const skills = join(home, '.claude', 'skills')
    mkdirSync(join(skills, 'genoffice'), { recursive: true })
    writeFileSync(join(skills, 'genoffice', 'SKILL.md'), UPSTREAM_SKILL)
    const userData = join(home, 'userData')
    mkdirSync(userData)
    const env = { SEUOFFICE_HOME: home, SEUOFFICE_USER_DATA: userData }

    const listed = await run(['skill', 'list', '--json'], { env })
    const claude = (listed.json().detail.agents as Array<Record<string, unknown>>).find(
      (a) => a.agent === 'claude-code',
    )
    expect(claude).toMatchObject({ status: 'missing', installed_version: null })

    expect((await run(['skill', 'install', 'claude-code', '--json'], { env })).code).toBe(0)
    expect(readFileSync(join(skills, 'seuoffice', 'SKILL.md'), 'utf-8')).toBe(
      readFileSync(join(REPO, 'skills', 'seuoffice', 'SKILL.md'), 'utf-8'),
    )
    const again = await run(['skill', 'install', 'claude-code', '--json'], { env })
    expect(again.code).toBe(0)
    expect(again.json().detail.agents[0]).toMatchObject({ status: 'installed' })
    expect(readdirSync(skills).sort()).toEqual(['genoffice', 'seuoffice'])
    expect(readdirSync(join(skills, 'genoffice'))).toEqual(['SKILL.md'])
    expect(readFileSync(join(skills, 'genoffice', 'SKILL.md'), 'utf-8')).toBe(UPSTREAM_SKILL)
  })
})

describe('an upstream genoffice launcher on the PATH', () => {
  function machine() {
    const dir = tempDir()
    const upstream = join(dir, 'opt', 'GenOffice', 'resources', 'cli')
    mkdirSync(upstream, { recursive: true })
    for (const f of ['genoffice', 'genoffice.cjs', 'genoffice.cmd']) {
      writeFileSync(join(upstream, f), '')
    }
    const ours = join(dir, 'opt', 'seuoffice', 'resources', 'cli')
    mkdirSync(ours, { recursive: true })
    for (const f of ['seuoffice', 'genoffice.cjs', 'seuoffice.cmd']) {
      writeFileSync(join(ours, f), '')
    }
    return { dir, upstream: join(upstream, 'genoffice'), launcher: join(ours, 'seuoffice') }
  }

  it('keeps its link while ours is added beside it under our own name', () => {
    const m = machine()
    const bin = join(m.dir, 'bin')
    mkdirSync(bin)
    symlinkSync(m.upstream, join(bin, 'genoffice'))
    const opts = { launcher: m.launcher, platform: 'linux' as const, candidateDirs: [bin] }

    expect(inspectCliLink(opts)).toMatchObject({
      status: 'missing',
      location: join(bin, 'seuoffice'),
    })
    expect(installCliLink(opts)).toEqual({ status: 'linked', location: join(bin, 'seuoffice') })
    expect(readlinkSync(join(bin, 'seuoffice'))).toBe(m.launcher)
    expect(readlinkSync(join(bin, 'genoffice'))).toBe(m.upstream)
    expect(installCliLink(opts).status).toBe('present')
    expect(readdirSync(bin).sort()).toEqual(['genoffice', 'seuoffice'])
    expect(readlinkSync(join(bin, 'genoffice'))).toBe(m.upstream)
    expect(opts.launcher).toBe(m.launcher)
    expect(installCliLink(opts).manual).toBeUndefined()
  })

  it('is never taken for a launcher of ours', () => {
    const m = machine()
    expect(isOurLauncher(m.upstream, m.launcher)).toBe(false)
    expect(isOurLauncher(m.launcher, m.launcher)).toBe(true)

    // a link under our name that runs the upstream launcher belongs to whoever made it
    const bin = join(m.dir, 'bin')
    mkdirSync(bin)
    symlinkSync(m.upstream, join(bin, 'seuoffice'))
    const opts = { launcher: m.launcher, platform: 'linux' as const, candidateDirs: [bin] }
    expect(inspectCliLink(opts).status).toBe('occupied')
    expect(installCliLink(opts).status).toBe('occupied')
    expect(readlinkSync(join(bin, 'seuoffice'))).toBe(m.upstream)
  })

  it('does not stop a second copy of this product from taking over our own link', () => {
    const m = machine()
    const older = join(m.dir, 'old', 'seuoffice', 'resources', 'cli')
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, 'seuoffice'), '')
    writeFileSync(join(older, 'genoffice.cjs'), '')
    expect(isOurLauncher(join(older, 'seuoffice'), m.launcher)).toBe(true)
    const bin = join(m.dir, 'bin')
    mkdirSync(bin)
    symlinkSync(join(older, 'seuoffice'), join(bin, 'seuoffice'))
    writeFileSync(join(bin, 'genoffice'), '#!/bin/sh\n')
    const opts = { launcher: m.launcher, platform: 'linux' as const, candidateDirs: [bin] }
    expect(installCliLink(opts).status).toBe('linked')
    expect(readlinkSync(join(bin, 'seuoffice'))).toBe(m.launcher)
    expect(readFileSync(join(bin, 'genoffice'), 'utf-8')).toBe('#!/bin/sh\n')
  })

  it('leaves the manual commands and the Windows PATH edit about our launcher only', () => {
    const m = machine()
    const absent = join(m.dir, 'no-such-bin')
    const r = installCliLink({ launcher: m.launcher, platform: 'linux', candidateDirs: [absent] })
    expect(r.location).toBe(join(absent, 'seuoffice'))
    expect(r.manual).toContain('/usr/local/bin/seuoffice')

    const scripts: string[] = []
    const win = 'C:\\Users\\u\\AppData\\Local\\Programs\\seuoffice\\resources\\cli\\seuoffice.cmd'
    const out = installCliLink({
      launcher: win,
      platform: 'win32',
      runPowerShell: (script) => {
        scripts.push(script)
        return { ok: true, stdout: 'linked\n' }
      },
    })
    expect(out.location).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\seuoffice\\resources\\cli')
    // the existing value is kept whole and our directory appended: no entry is dropped
    expect(scripts[0]).toContain("$next = (@($p, $dir) | Where-Object { $_ }) -join ';'")
    expect(scripts[0]).not.toMatch(/GenOffice\\resources/)
  })
})

describe('finding the app', () => {
  const posix = (p: string) => p.replace(/\\/g, '/')

  it('looks only where this product installs', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }
    expect(installedAppBinaries(env, 'win32', null)).toEqual([
      join(env.LOCALAPPDATA, 'Programs', 'SeuOffice', 'SeuOffice.exe'),
      join(env.ProgramFiles, 'SeuOffice', 'SeuOffice.exe'),
    ])
    expect(installedAppBinaries({}, 'darwin', null).map(posix)).toEqual([
      '/Applications/SeuOffice.app/Contents/MacOS/SeuOffice',
      posix(join(homedir(), 'Applications/SeuOffice.app/Contents/MacOS/SeuOffice')),
    ])
    expect(installedAppBinaries({}, 'linux', null).map(posix)).toEqual(['/opt/SeuOffice/seuoffice'])
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const found = installedAppBinaries(env, platform, null).map(posix)
      expect(found.length).toBeGreaterThan(0)
      for (const p of found) {
        expect(p).not.toMatch(/GenOffice|\/genoffice$/)
        expect(p).not.toBe('/usr/bin/genoffice')
        expect(p).toMatch(/\/seuoffice(\.app)?\//i)
      }
    }
  })

  it('resolves the binary of the install that ships this CLI', () => {
    expect(appBinaryForResources(join('D:\\Apps\\seuoffice', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\seuoffice', 'SeuOffice.exe'),
    )
    expect(
      posix(appBinaryForResources('/Volumes/Work/seuoffice.app/Contents/Resources', 'darwin')),
    ).toBe('/Volumes/Work/seuoffice.app/Contents/MacOS/SeuOffice')
    expect(posix(appBinaryForResources('/opt/seuoffice/resources', 'linux'))).toBe(
      '/opt/seuoffice/seuoffice',
    )
  })

  it('starts the MCP server on our app binary, never on an upstream one beside the launcher', () => {
    const dir = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\seuoffice\\resources\\cli'
    expect(mcpLaunch({ status: 'present', launcherDir: dir })).toEqual({
      command: `${dir}\\..\\..\\SeuOffice.exe`,
      args: [`${dir}\\genoffice.cjs`, 'mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    const mac = '/Applications/seuoffice.app/Contents/Resources/cli'
    expect(mcpLaunch({ status: 'present', launcherDir: mac })).toEqual({
      command: 'seuoffice',
      args: ['mcp'],
    })
    expect(mcpLaunch({ status: 'missing', launcherDir: mac })).toEqual({
      command: `${mac}/seuoffice`,
      args: ['mcp'],
    })

    const upstreamOnly = (p: string) => p.endsWith('GenOffice.exe') || p.endsWith('genoffice.cjs')
    expect(mcpLaunchFromLauncher(`${dir}\\seuoffice.cmd`, { exists: upstreamOnly })).toEqual({
      command: 'node',
      args: [`${dir}\\genoffice.cjs`, 'mcp'],
    })
    const ours = (p: string) => p === `${dir}\\..\\..\\SeuOffice.exe`
    expect(mcpLaunchFromLauncher(`${dir}\\seuoffice.cmd`, { exists: ours }).command).toBe(
      `${dir}\\..\\..\\SeuOffice.exe`,
    )
  })
})

describe('finding the running app', () => {
  it('reads the control endpoint of this product only, installed or development', () => {
    const base = tempDir()
    const env = { HOME: base, APPDATA: base, XDG_CONFIG_HOME: base }
    const installed = seuofficeUserDataDir(env)
    const dev = seuofficeDevUserDataDir(env)
    const publish = (dir: string, token: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, CONTROL_FILE),
        JSON.stringify({ pid: process.pid, endpoint: 'pipe', token }),
      )
    }
    // a running upstream app, installed and development, and the old dev folder spelling
    publish(join(dirname(installed), 'GenOffice'), 'upstream')
    publish(join(dirname(installed), 'GenOffice Dev'), 'upstream-dev')
    publish(`${installed} Dev`, 'old-spelling')
    expect(controlEndpoint(env)).toBeNull()

    publish(dev, 'dev')
    expect(controlEndpoint(env)?.token).toBe('dev')
    publish(installed, 'installed')
    expect(controlEndpoint(env)?.token).toBe('installed')
  })
})

describe('what the CLI prints and tells agents to run', () => {
  const OLD_NAME = /genoffice|GenOffice/

  it('names the command seuoffice in the version line, usage and hints', async () => {
    expect((await run(['--version'])).stdout).toMatch(/^seuoffice \d+\.\d+\.\d+/)
    const help = (await run(['help'])).stdout
    expect(help).toContain('Usage: seuoffice <command> [options]')
    expect(help).toMatch(/^seuoffice \S+ — SeuOffice command line/)
    expect(help).not.toMatch(OLD_NAME)

    const unknown = await run(['no-such-command'])
    expect(unknown.stderr).toMatch(/^seuoffice: unknown command/)
    expect(unknown.stderr).toContain('run `seuoffice help` for the command list')
    expect((await run(['no-such-command', '--json'])).json().suggestion).toContain('seuoffice help')
  })

  it('names it in the help of every command', async () => {
    for (const def of defaultRegistry().list()) {
      const help = (await run(['help', def.name])).stdout
      expect(help, def.name).toContain(`Usage: seuoffice ${def.usage}`)
      expect(help, def.name).not.toMatch(OLD_NAME)
    }
  })

  it('names it in the guides an agent reads before writing ops', async () => {
    for (const argv of [
      ['guide', 'docs'],
      ['guide', 'sheets'],
      ['guide', 'slides'],
      ['guide', 'slides', 'design'],
      ['guide', 'slides', 'spec'],
    ]) {
      const r = await run(argv)
      expect(r.code, argv.join(' ')).toBe(0)
      expect(r.stdout, argv.join(' ')).toMatch(/seuoffice/)
      expect(r.stdout, argv.join(' ')).not.toMatch(OLD_NAME)
    }
  })

  it('names it in what the MCP server tells a client', () => {
    expect(INSTRUCTIONS).not.toMatch(OLD_NAME)
    expect(INSTRUCTIONS).toContain('SeuOffice')
    expect(remoteInstructions('http://h:1')).not.toMatch(OLD_NAME)
    for (const tool of resolveTools(defaultRegistry())) {
      expect(tool.description, tool.name).not.toMatch(OLD_NAME)
      for (const p of [...(tool.positionals ?? []), ...tool.params]) {
        expect(p.description, `${tool.name}.${p.key}`).not.toMatch(OLD_NAME)
      }
    }
  })

  it('ships the skill under its own name with every command spelled seuoffice', () => {
    expect(existsSync(join(REPO, 'skills', 'genoffice'))).toBe(false)
    const text = readFileSync(join(REPO, 'skills', 'seuoffice', 'SKILL.md'), 'utf-8')
    expect(/^name:\s*(\S+)\s*$/m.exec(text)?.[1]).toBe('seuoffice')
    expect(text).toContain('`seuoffice --version`')
    expect(text).toContain('~/.seuoffice/launcher')
    expect(text).not.toMatch(OLD_NAME)
  })

  it('ships launchers named seuoffice that start only this product', () => {
    const bin = join(REPO, 'packages', 'cli', 'bin')
    expect(readdirSync(bin).sort()).toEqual(['seuoffice', 'seuoffice.cmd'])
    const sh = readFileSync(join(bin, 'seuoffice'), 'utf-8')
    const cmd = readFileSync(join(bin, 'seuoffice.cmd'), 'utf-8')
    expect(sh).toContain('MacOS/SeuOffice')
    expect(sh).toContain('SeuOffice.exe')
    expect(sh).toContain('"$here/../../seuoffice"')
    expect(sh).not.toContain('"$here/../../seuoffice"')
    expect(sh).not.toContain('"$here/../../genoffice"')
    expect(cmd).toContain('SeuOffice.exe')
    expect(sh).not.toMatch(/GenOffice/)
    expect(cmd).not.toMatch(/GenOffice/)
  })
})
