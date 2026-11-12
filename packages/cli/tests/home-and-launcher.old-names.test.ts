/**
 * What an earlier version left on the machine keeps working: its home folder
 * (~/.ieumoffice) still takes the audit log where it is the only one, and the
 * `ieumoffice` command and `genoffice.cjs` bundle name still start the CLI.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditLogPath } from '../src/audit'
import { inspectCliLink, installCliLink, isOurLauncher } from '../src/install'
import { tempDir } from './helpers'

const BIN = resolve(__dirname, '..', 'bin')

describe('the home folder an earlier version made', () => {
  it('keeps the audit log in ~/.ieumoffice while that is the only home folder', () => {
    const home = tempDir()
    expect(auditLogPath({}, home)).toBe(join(home, '.seuoffice', 'cli-audit.jsonl'))

    mkdirSync(join(home, '.ieumoffice'))
    expect(auditLogPath({}, home)).toBe(join(home, '.ieumoffice', 'cli-audit.jsonl'))

    mkdirSync(join(home, '.seuoffice'))
    expect(auditLogPath({}, home)).toBe(join(home, '.seuoffice', 'cli-audit.jsonl'))
  })

  it('never takes the upstream app home, and the overrides still win', () => {
    const home = tempDir()
    mkdirSync(join(home, '.genoffice'))
    expect(auditLogPath({}, home)).toBe(join(home, '.seuoffice', 'cli-audit.jsonl'))

    mkdirSync(join(home, '.ieumoffice'))
    expect(auditLogPath({ SEUOFFICE_AUTH_DIR: '/custom' }, home)).toBe(
      join('/custom', 'cli-audit.jsonl'),
    )
    expect(auditLogPath({ SEUOFFICE_AUDIT_LOG: '/logs/a.jsonl' }, home)).toBe('/logs/a.jsonl')
    expect(auditLogPath({ SEUOFFICE_AUDIT_LOG: 'off' }, home)).toBeNull()
  })
})

/**
 * An installed app's resources/cli folder as electron-builder lays it out: the
 * launchers, the old-name files beside them, and a stub bundle that, like the
 * real one, runs only as the main module and answers with its arguments.
 */
function appCli(): string {
  const cli = join(tempDir(), 'app', 'cli')
  mkdirSync(cli, { recursive: true })
  copyFileSync(join(BIN, 'seuoffice'), join(cli, 'seuoffice'))
  copyFileSync(join(BIN, 'seuoffice.cmd'), join(cli, 'seuoffice.cmd'))
  for (const name of ['ieumoffice', 'ieumoffice.cmd', 'genoffice.cjs']) {
    copyFileSync(join(BIN, 'old-names', name), join(cli, name))
  }
  chmodSync(join(cli, 'seuoffice'), 0o755)
  chmodSync(join(cli, 'ieumoffice'), 0o755)
  writeFileSync(
    join(cli, 'seuoffice.cjs'),
    'if (require.main === module) process.stdout.write(JSON.stringify({ args: process.argv.slice(2), via: process.env.VIA ?? null }))\n',
  )
  return cli
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(command, args, {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, ...env },
  })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout) as { args: string[]; via: string | null }
}

describe.skipIf(process.platform === 'win32')('the command an earlier version linked', () => {
  it('starts the CLI through a PATH link, arguments intact', () => {
    const cli = appCli()
    const bin = join(cli, '..', '..', 'bin')
    mkdirSync(bin)
    symlinkSync(join(cli, 'ieumoffice'), join(bin, 'ieumoffice'))
    // a relative link one more hop away, as a user's own ~/bin link would be
    symlinkSync('ieumoffice', join(bin, 'io'))

    const args = ['mcp', 'two words', '--json', '']
    for (const entry of [join(bin, 'ieumoffice'), join(bin, 'io'), join(cli, 'ieumoffice')]) {
      expect(run(entry, args, { SEUOFFICE_NODE: process.execPath }).args, entry).toEqual(args)
    }
  })
})

describe('the bundle name an earlier version wrote into MCP entries', () => {
  it('runs the current bundle as the main module', () => {
    const cli = appCli()
    expect(run(process.execPath, [join(cli, 'genoffice.cjs'), 'mcp', 'a b'], {}).args).toEqual([
      'mcp',
      'a b',
    ])
  })
})

describe.skipIf(process.platform === 'win32')('a link under the old command name', () => {
  it('is ours, and installing the new command leaves it working', () => {
    const cli = appCli()
    const launcher = join(cli, 'seuoffice')
    const bin = join(cli, '..', '..', 'bin')
    mkdirSync(bin)
    const old = join(bin, 'ieumoffice')
    symlinkSync(join(cli, 'ieumoffice'), old)
    expect(isOurLauncher(old, launcher)).toBe(true)

    // an earlier install elsewhere: the old launcher beside the old bundle name
    const earlier = join(tempDir(), 'IeumOffice', 'resources', 'cli', 'ieumoffice')
    mkdirSync(join(earlier, '..'), { recursive: true })
    writeFileSync(earlier, '#!/bin/sh\n')
    writeFileSync(join(earlier, '..', 'genoffice.cjs'), '')
    expect(isOurLauncher(earlier, launcher)).toBe(true)

    // a link under the new name into that earlier install is ours to update, not another program
    symlinkSync(earlier, join(bin, 'seuoffice'))
    expect(inspectCliLink({ launcher, platform: 'linux', candidateDirs: [bin] }).status).toBe(
      'missing',
    )
    expect(installCliLink({ launcher, platform: 'linux', candidateDirs: [bin] }).status).toBe(
      'linked',
    )
    expect(readlinkSync(join(bin, 'seuoffice'))).toBe(launcher)
    expect(realpathSync(old)).toBe(realpathSync(join(cli, 'ieumoffice')))
    expect(run(old, ['--version'], { SEUOFFICE_NODE: process.execPath }).args).toEqual([
      '--version',
    ])
  })

  it('never makes the upstream app launcher ours', () => {
    const cli = appCli()
    const upstream = join(tempDir(), 'GenOffice', 'resources', 'cli', 'genoffice')
    mkdirSync(join(upstream, '..'), { recursive: true })
    writeFileSync(upstream, '#!/bin/sh\n')
    writeFileSync(join(upstream, '..', 'genoffice.cjs'), '')
    writeFileSync(join(upstream, '..', 'genoffice.cmd'), '')
    expect(isOurLauncher(upstream, join(cli, 'seuoffice'))).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('the standalone CLI archive', () => {
  it('answers to the old command and bundle names once unpacked', () => {
    const from = tempDir()
    for (const file of [
      'cli/package.json',
      'cli/node_modules/jsdom/package.json',
      'cli/skills/seuoffice/SKILL.md',
      'wasm/pdfium.wasm',
      'wasm/rhwp_bg.wasm',
      'wasm/hb-subset.wasm',
      'wasm/office_wasm.wasm',
      'native/xlsx-sidecar',
    ]) {
      mkdirSync(join(from, file, '..'), { recursive: true })
      writeFileSync(join(from, file), 'placeholder')
    }
    const cli = appCli()
    copyFileSync(join(cli, 'seuoffice'), join(from, 'cli', 'seuoffice'))
    copyFileSync(join(cli, 'seuoffice.cjs'), join(from, 'cli', 'seuoffice.cjs'))
    const notices = tempDir()
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
      writeFileSync(join(notices, name), name)
    }
    const out = tempDir()
    execFileSync(
      process.execPath,
      [
        resolve(__dirname, '../pack-tarball.mjs'),
        '--from',
        from,
        '--out',
        out,
        '--platform',
        'linux',
        '--arch',
        'x64',
        '--notices',
        notices,
      ],
      { env: { ...process.env, SEUOFFICE_APP_VERSION: '9.9.9' }, stdio: 'pipe' },
    )
    const unpacked = tempDir()
    execFileSync('tar', ['-xzf', join(out, 'seuoffice-cli_9.9.9_linux-x64.tar.gz'), '-C', unpacked])
    const unpackedCli = join(unpacked, 'seuoffice-cli', 'cli')

    const env = { SEUOFFICE_NODE: process.execPath }
    expect(run(join(unpackedCli, 'ieumoffice'), ['mcp'], env).args).toEqual(['mcp'])
    expect(run(process.execPath, [join(unpackedCli, 'genoffice.cjs'), 'mcp'], {}).args).toEqual([
      'mcp',
    ])
    expect(readFileSync(join(unpackedCli, 'ieumoffice.cmd'), 'utf-8')).toContain('seuoffice.cmd')
  })
})
