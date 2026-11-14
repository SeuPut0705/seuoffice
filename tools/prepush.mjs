#!/usr/bin/env node
/**
 * `node tools/prepush.mjs [--base <git-ref>]`: the cheap checks of CI, run
 * here on what this branch changed, before a push.
 *
 * Every check runs whether or not an earlier one failed, so one run lists
 * everything a runner would fail on; the exit status is 1 when any failed.
 * The base is the merge base with origin/main unless --base names another.
 *
 *   formatting      prettier on the changed files (tools/format-changed.mjs)
 *   comments        tools/check-english-comments.mjs, the whole tree (seconds)
 *   lint            eslint on the changed JS and TS files
 *   typecheck       each changed workspace and tools/<gate>, by its typecheck script
 *   tests           each changed workspace's vitest run, only the tests that the
 *                   changed files reach (vitest --changed)
 *   crates          cargo fmt --check of crates/, then clippy -D warnings and the
 *                   unit tests of each changed crate
 *   workflows       actionlint on changed workflow files, when it is installed
 *
 * What it does not run: the parity gates, the fault matrices, e2e, the whole
 * test suite and the workspaces that only depend on a changed one. Those stay on
 * the runners.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
let base = 'origin/main'
if (args[0] === '--base' && args[1]) base = args.splice(0, 2)[1]
if (args.length > 0) {
  console.error('usage: node tools/prepush.mjs [--base <git-ref>]')
  process.exit(2)
}

function git(...gitArgs) {
  const run = spawnSync('git', gitArgs, { encoding: 'utf8' })
  if (run.status !== 0) {
    console.error(`git ${gitArgs.join(' ')}: ${run.stderr.trim()}`)
    process.exit(2)
  }
  return run.stdout
}

const root = git('rev-parse', '--show-toplevel').trim()
process.chdir(root)
if (!existsSync('node_modules')) {
  console.error('prepush: node_modules is missing; run npm ci first')
  process.exit(2)
}
const mergeBase = git('merge-base', 'HEAD', base).trim()

const lines = (text) => text.split('\n').filter(Boolean)
const changed = [
  ...new Set([
    ...lines(git('diff', '--name-only', '--diff-filter=ACMRT', `${mergeBase}...HEAD`)),
    ...lines(git('diff', '--name-only', '--diff-filter=ACMRT', 'HEAD')),
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ]),
]
  .filter((file) => existsSync(file))
  .sort()

console.log(`prepush: ${changed.length} files changed since ${base} (${mergeBase.slice(0, 9)})`)
if (changed.length === 0) process.exit(0)

/** The folder of the nearest manifest above `file` that lies inside one of `roots`. */
function ownerOf(file, roots, manifest) {
  for (let dir = dirname(file); dir !== '.' && dir !== '/'; dir = dirname(dir)) {
    if (roots.some((r) => dir.startsWith(`${r}/`)) && existsSync(join(dir, manifest))) return dir
  }
  return null
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const ownersOf = (roots, manifest) => [
  ...new Set(changed.map((f) => ownerOf(f, roots, manifest)).filter(Boolean)),
]

const failed = []
function check(label, command, commandArgs, options = {}) {
  console.log(`\n== ${label}: ${command} ${commandArgs.join(' ')}`)
  const run = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (run.status !== 0) failed.push(label)
}

check('formatting', process.execPath, ['tools/format-changed.mjs', '--check', '--base', mergeBase])
check('comments', process.execPath, ['tools/check-english-comments.mjs'])

const lintable = changed.filter((f) => /\.(c|m)?[jt]sx?$/.test(f))
if (lintable.length > 0) check('lint', 'npx', ['eslint', '--no-warn-ignored', '--', ...lintable])

for (const dir of ownersOf(['apps', 'packages'], 'package.json')) {
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg.scripts?.typecheck)
    check(`typecheck ${pkg.name}`, 'npm', ['run', 'typecheck', '-w', pkg.name])
  // only a plain vitest script takes --changed; sheets builds its sidecar first
  // and web runs Playwright, which are left to the runners
  if (/^vitest run\b/.test(pkg.scripts?.test ?? ''))
    check(`tests ${pkg.name}`, 'npm', ['run', 'test', '-w', pkg.name, '--', '--changed', mergeBase])
}

for (const dir of ownersOf(['tools'], 'package.json')) {
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg.scripts?.typecheck)
    check(`typecheck ${dir}`, 'npm', ['--prefix', dir, 'run', 'typecheck'])
}

const crateFiles = changed.filter((f) => f.startsWith('crates/'))
if (crateFiles.length > 0 && existsSync('crates/Cargo.toml')) {
  const manifest = ['--manifest-path', 'crates/Cargo.toml']
  const metadata = spawnSync(
    'cargo',
    ['metadata', ...manifest, '--no-deps', '--format-version', '1'],
    {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    },
  )
  // the members of the workspace, deepest folder first, so a file goes to its own crate
  const members =
    metadata.status === 0
      ? JSON.parse(metadata.stdout)
          .packages.map((p) => ({
            name: p.name,
            dir: dirname(p.manifest_path).slice(root.length + 1),
          }))
          .sort((a, b) => b.dir.length - a.dir.length)
      : []
  const owners = crateFiles.map((f) => members.find((m) => f.startsWith(`${m.dir}/`)))
  // a file of no member (Cargo.lock, the workspace manifest, a vendored crate)
  // can change any of them
  const packages = owners.every(Boolean)
    ? [...new Set(owners.map((m) => m.name))].flatMap((name) => ['-p', name])
    : ['--workspace']
  // --check only reads: nothing under crates/ is rewritten
  check('crates format', 'cargo', ['fmt', ...manifest, '--', '--check'])
  check('crates clippy', 'cargo', [
    'clippy',
    ...manifest,
    ...packages,
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ])
  check('crates tests', 'cargo', ['test', ...manifest, ...packages])
}

const workflows = changed.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f))
if (workflows.length > 0) {
  if (spawnSync('actionlint', ['-version'], { stdio: 'ignore' }).status === 0)
    check('workflows', 'actionlint', ['-shellcheck=', ...workflows])
  else console.log('\n== workflows: actionlint is not installed; skipped')
}

if (failed.length > 0) {
  console.error(`\nprepush: failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\nprepush: every check passed')
