/**
 * `node tools/seuoffice-test-shard.mjs <index> <count>`: one share of the
 * root `test` script's workspaces, run one after another like `npm test`.
 * CI runs every share on its own runner at the same time (the `test` job's
 * matrix in .github/workflows/ci.yml), so the suite ends when the slowest
 * share does instead of after the sum of all of them.
 *
 *   node tools/seuoffice-test-shard.mjs --plan <count>   print the shares
 *
 * The workspace list is read from the root `test` script, as
 * run-workspace-tests.mjs does, and every workspace lands in exactly one
 * share: the split is checked before anything runs.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Seconds a workspace's tests took on a GitHub runner (CI run 42688054725,
 * 2026-11-10); the split balances on these. A workspace not listed counts as
 * DEFAULT_SECONDS. Stale numbers only unbalance the shares, they never drop a
 * workspace.
 */
const SECONDS = {
  '@genoffice/docs': 297,
  '@genoffice/sheets': 207,
  '@genoffice/cli': 134,
  '@genoffice/slides': 106,
  '@genoffice/markdown': 102,
  '@genoffice/shell': 79,
  '@genoffice/pdf': 70,
  '@genoffice/hwp': 64,
  '@genoffice/docx-engine': 43,
  '@genoffice/mindmap': 33,
  '@genoffice/pptx-engine': 32,
  '@genoffice/html': 30,
  '@genoffice/html2docx': 26,
  '@genoffice/ui': 22,
}
const DEFAULT_SECONDS = 10

/** What the first share's runner does besides tests: lint and typecheck (ci.yml) */
const FIRST_SHARE_HEAD_START = 330

/** The workspaces the root `test` script runs, in its order */
function testWorkspaces() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const names = [...String(pkg.scripts?.test ?? '').matchAll(/npm run test -w (\S+)/g)].map(
    (match) => match[1],
  )
  if (names.length === 0)
    throw new Error('no "npm run test -w <workspace>" in the root test script')
  return names
}

/** Longest first, each into the lightest share so far; a share keeps the root script's order */
function split(workspaces, count) {
  const loads = Array.from({ length: count }, (_, i) => (i === 0 ? FIRST_SHARE_HEAD_START : 0))
  const shareOf = new Map()
  const bySeconds = [...workspaces].sort(
    (a, b) => (SECONDS[b] ?? DEFAULT_SECONDS) - (SECONDS[a] ?? DEFAULT_SECONDS),
  )
  for (const name of bySeconds) {
    const lightest = loads.indexOf(Math.min(...loads))
    shareOf.set(name, lightest)
    loads[lightest] += SECONDS[name] ?? DEFAULT_SECONDS
  }
  const shares = Array.from({ length: count }, (_, i) =>
    workspaces.filter((name) => shareOf.get(name) === i),
  )
  const assigned = shares.flat()
  if (assigned.length !== workspaces.length || new Set(assigned).size !== workspaces.length)
    throw new Error('the shares do not cover every workspace exactly once')
  return { shares, loads }
}

function positiveInt(text, what) {
  const value = Number.parseInt(text ?? '', 10)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${what} must be a positive integer`)
  return value
}

const [first, second] = process.argv.slice(2)
const planOnly = first === '--plan'
const count = positiveInt(second, 'the share count')
const { shares, loads } = split(testWorkspaces(), count)

if (planOnly) {
  shares.forEach((share, i) => console.log(`${i + 1}/${count} ~${loads[i]}s  ${share.join(' ')}`))
} else {
  const index = positiveInt(first, 'the share index')
  if (index > count) throw new Error(`share ${index} of ${count} does not exist`)
  const share = shares[index - 1]
  console.log(`share ${index}/${count}: ${share.length} workspaces\n  ${share.join('\n  ')}`)
  for (const name of share) {
    const run = spawnSync('npm', ['run', 'test', '-w', name], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (run.status !== 0) {
      console.error(`${name} failed`)
      process.exit(run.status ?? 1)
    }
  }
}
