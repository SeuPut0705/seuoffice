/**
 * `npm run test:parallel`: every workspace's `npm run test`, a few at a time.
 *
 * `npm test` chains the workspaces one after another, so a workspace that
 * mostly waits (a Chromium page load, a jsdom start-up) leaves the other cores
 * idle until it finishes. This runner overlaps those waits. It is opt-in:
 * `npm test` stays the serial gate, because on a busy machine some suites
 * time out only when others share the CPU. Each workspace's output is held
 * back and printed in one piece when it ends, so logs do not interleave; a
 * summary table follows. Exits 1 when any workspace failed.
 *
 * The workspace list is read from the root `test` script, so the two runs
 * always cover the same workspaces. TEST_JOBS=<n> sets how many run at once
 * (default 2). Each vitest starts a worker per core by default; unless
 * VITEST_MAX_WORKERS is set, each workspace gets its share of the cores
 * instead, so the concurrent suites do not oversubscribe the CPU.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'

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

const WORKSPACES = testWorkspaces()

/**
 * Workspaces that must wait for another one to finish. The sheets test script
 * rebuilds the xlsx sidecar, which the cli tests execute: started together,
 * the cli could run a binary that cargo is still writing.
 */
const AFTER = { '@genoffice/cli': ['@genoffice/sheets'] }

/** Started first: the longest workspaces, so none of them is left to run alone at the end */
const FIRST = [
  '@genoffice/docs',
  '@genoffice/sheets',
  '@genoffice/html2docx',
  '@genoffice/slides',
  '@genoffice/markdown',
]

function jobCount() {
  const fromEnv = Number.parseInt(process.env.TEST_JOBS ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  // most suites already use every core on their own; two at once fills the
  // gaps one leaves without starving either (four timed suites out on Windows)
  return 2
}

function workerEnv(jobs) {
  if (process.env.VITEST_MAX_WORKERS || jobs === 1) return process.env
  const workers = Math.max(2, Math.floor(availableParallelism() / jobs))
  return { ...process.env, VITEST_MAX_WORKERS: String(workers) }
}

function runWorkspace(name, env) {
  return new Promise((resolve) => {
    const started = Date.now()
    // npm sets npm_execpath for scripts; going through node avoids needing a
    // shell for npm.cmd on Windows
    const npmCli = process.env.npm_execpath
    const child = npmCli
      ? spawn(process.execPath, [npmCli, 'run', 'test', '-w', name], { env })
      : spawn('npm', ['run', 'test', '-w', name], {
          env,
          shell: process.platform === 'win32',
        })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    child.on('error', (error) => chunks.push(Buffer.from(`${error.message}\n`)))
    child.on('close', (code) => {
      resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000, chunks })
    })
  })
}

async function main() {
  const jobs = jobCount()
  const env = workerEnv(jobs)
  const first = FIRST.filter((name) => WORKSPACES.includes(name))
  const queue = [...first, ...WORKSPACES.filter((name) => !first.includes(name))]
  const done = new Set()
  const results = []
  const started = Date.now()
  let running = 0

  await new Promise((resolveAll) => {
    const next = () => {
      if (queue.length === 0 && running === 0) {
        resolveAll()
        return
      }
      while (running < jobs) {
        const index = queue.findIndex((name) => (AFTER[name] ?? []).every((dep) => done.has(dep)))
        if (index === -1) return
        const [name] = queue.splice(index, 1)
        running++
        void runWorkspace(name, env).then((result) => {
          running--
          done.add(name)
          results.push(result)
          const mark = result.code === 0 ? 'ok' : 'FAILED'
          process.stdout.write(`\n── ${name} (${mark}, ${result.seconds.toFixed(1)} s) ──\n`)
          process.stdout.write(Buffer.concat(result.chunks))
          next()
        })
      }
    }
    next()
  })

  const failed = results.filter((result) => result.code !== 0)
  const workers = env.VITEST_MAX_WORKERS
    ? `, up to ${env.VITEST_MAX_WORKERS} vitest workers each`
    : ''
  process.stdout.write(`\nworkspace tests, ${jobs} at a time${workers}:\n`)
  for (const result of [...results].sort((a, b) => b.seconds - a.seconds)) {
    const mark = result.code === 0 ? 'ok    ' : 'FAILED'
    process.stdout.write(`  ${mark} ${result.seconds.toFixed(1).padStart(6)} s  ${result.name}\n`)
  }
  const total = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write(`${results.length} workspaces in ${total} s, ${failed.length} failed\n`)
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((result) => result.name).join(', ')}\n`)
    process.exitCode = 1
  }
}

await main()
