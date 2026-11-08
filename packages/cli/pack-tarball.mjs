// Assembles the command line as a standalone archive for machines that do not
// have the desktop app: agent sandboxes, servers, CI images. It carries the
// same bundle, jsdom tree, wasm engines and xlsx sidecar the installed app
// ships, so behaviour is identical to `ieumoffice` inside the app — only the
// Electron binary is gone.
//
// usage: node pack-tarball.mjs --from <app resources dir> [--out <dir>] [--platform linux] [--arch x64] [--notices <dir>]
//
// The desktop app's resources directory has the layout the command line expects
// (cli/, wasm/, native/); see apps/shell/electron-builder.cjs.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../..')
const ARCHIVE_ROOT = 'ieumoffice-cli'

/** Every entry the archive must carry; a missing one means a broken app build. */
const REQUIRED = [
  'cli/ieumoffice',
  'cli/genoffice.cjs',
  'cli/package.json',
  'cli/node_modules/jsdom/package.json',
  'cli/skills/ieumoffice/SKILL.md',
  'wasm/pdfium.wasm',
  'wasm/rhwp_bg.wasm',
  'wasm/hb-subset.wasm',
  'native/xlsx-sidecar',
]

function parseArgs(argv) {
  const out = {
    platform: process.platform === 'win32' ? 'win' : process.platform,
    arch: process.arch,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--from') out.from = argv[++i]
    else if (arg === '--out') out.out = argv[++i]
    else if (arg === '--platform') out.platform = argv[++i]
    else if (arg === '--arch') out.arch = argv[++i]
    else if (arg === '--notices') out.notices = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

export function archiveName(version, platform, arch) {
  return `ieumoffice-cli_${version}_${platform}-${arch}.tar.gz`
}

/** The version the archive reports: CI injects the release version, a checkout reads the bundle's banner or the package's. */
export function archiveVersion(env = process.env, bundle) {
  const injected = (env.GENOFFICE_APP_VERSION ?? '').trim()
  if (injected) return injected
  if (bundle) {
    const line = readFileSync(bundle, 'utf8')
      .split('\n')
      .find((row) => row.startsWith('const __cliAppVersion = '))
    if (line) {
      try {
        const value = JSON.parse(line.slice('const __cliAppVersion = '.length).replace(/;\s*$/, ''))
        if (typeof value === 'string' && value) return value
      } catch {
        // fall through to the package version
      }
    }
  }
  return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
}

function copyInto(staging, from, entries) {
  for (const entry of entries) {
    cpSync(join(from, entry), join(staging, ARCHIVE_ROOT, entry), { recursive: true })
  }
}

/**
 * Builds the archive and its `.sha256` beside it. Returns the archive path.
 * Exported for tests; the CLI entry below only parses arguments and prints.
 */
export function packTarball({ from, out, platform, arch, notices, env = process.env }) {
  if (!from) throw new Error('pass --from <resources dir> (the app build’s resources folder)')
  const missing = REQUIRED.filter((entry) => !existsSync(join(from, entry)))
  if (missing.length) {
    throw new Error(`resources are missing: ${missing.join(', ')} (run npm run build:all first)`)
  }
  const noticeFiles = notices
    ? ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt'].map((name) => join(resolve(notices), name))
    : [
        join(REPO, 'LICENSE'),
        join(REPO, 'NOTICE'),
        join(REPO, 'apps/shell/build/THIRD-PARTY-NOTICES.txt'),
      ]
  for (const notice of noticeFiles) {
    if (!existsSync(notice)) throw new Error(`notice is missing: ${notice}`)
  }

  const version = archiveVersion(env, join(from, 'cli/genoffice.cjs'))
  const target = resolve(out ?? join(here, 'dist'))
  mkdirSync(target, { recursive: true })
  const archive = join(target, archiveName(version, platform, arch))

  const staging = mkdtempSync(join(tmpdir(), 'ieumoffice-cli-'))
  try {
    copyInto(staging, from, ['cli', 'wasm', 'native'])
    for (const notice of noticeFiles) {
      cpSync(notice, join(staging, ARCHIVE_ROOT, notice.split(/[\\/]/).pop()))
    }
    // the launcher resolves its own location through a PATH symlink, so it must stay executable
    chmodSync(join(staging, ARCHIVE_ROOT, 'cli/ieumoffice'), 0o755)
    execFileSync('tar', ['-czf', archive, '-C', staging, ARCHIVE_ROOT], { stdio: 'inherit' })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(`${archive}.sha256`, `${digest}  ${archiveName(version, platform, arch)}\n`)
  return archive
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'usage: node pack-tarball.mjs --from <resources dir> [--out <dir>] [--platform linux] [--arch x64] [--notices <dir>]',
    )
    process.exit(0)
  }
  const archive = packTarball(args)
  console.log(`${archive} (${(statSync(archive).size / 1048576).toFixed(1)} MB)`)
}
