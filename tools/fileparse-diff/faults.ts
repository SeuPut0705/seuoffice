import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseShard, planShards, readCosts } from '../fault-shards.mjs'

interface Fault {
  id: string
  group: string
  file: string
  from: string
  to: string
}
interface Result {
  id: string
  group: string
  verdict: 'DETECTED' | 'MISSED' | 'INVALID' | 'CRASHED' | 'TIMEOUT'
  seconds: number
  differences?: number
  stale?: number
  reason?: string
}
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
/** The gate whose faults.json and main.ts run: `--dir`, or this one. */
const dirArg = process.argv.indexOf('--dir')
const gate = dirArg < 0 ? here : resolve(process.argv[dirArg + 1]!)
const faults = JSON.parse(readFileSync(resolve(gate, 'faults.json'), 'utf8')) as Fault[]
/** `--group a,b`: only the faults of those groups. */
const only = process.argv.indexOf('--group')
const groups = only < 0 ? null : new Set(process.argv[only + 1]!.split(','))
/** `--id a,b`: only those faults. */
const idArg = process.argv.indexOf('--id')
const ids = idArg < 0 ? null : new Set(process.argv[idArg + 1]!.split(','))
const shardArg = process.argv.indexOf('--shard')
const { index: shard, count: shards } =
  shardArg < 0 ? { index: 0, count: 1 } : parseShard(process.argv[shardArg + 1]!)
const named = faults.filter(
  (fault) => (groups === null || groups.has(fault.group)) && (ids === null || ids.has(fault.id)),
)
if (named.length === 0) throw new Error('No fault selected')
const planned = new Set(
  planShards(
    named.map((fault) => fault.id),
    readCosts(resolve(gate, 'fault-costs.json')),
    shards,
  ).shards[shard],
)
const selected = named.filter((fault) => planned.has(fault.id))
if (selected.length === 0) {
  console.log('No faults in this shard, nothing to build')
  process.exit(0)
}
mkdirSync(resolve(gate, 'out'), { recursive: true })
const out = mkdtempSync(resolve(gate, 'out/faults-'))
const scratch = resolve(out, 'crates')
cpSync(resolve(root, 'crates'), scratch, {
  recursive: true,
  filter: (source) => relative(resolve(root, 'crates'), source).split(/[\\/]/)[0] !== 'target',
})
const results: Result[] = []
const env = {
  ...process.env,
  CARGO_TARGET_DIR: resolve(scratch, 'target'),
  FILEPARSE_WASM_PATH: resolve(scratch, 'target/wasm32-wasip1/probe/office_wasm.wasm'),
}
function build(): boolean {
  return (
    spawnSync(
      'cargo',
      [
        'build',
        '--locked',
        '--manifest-path',
        resolve(scratch, 'Cargo.toml'),
        '-p',
        'office-wasm',
        '--target',
        'wasm32-wasip1',
        '--profile',
        'probe',
        '-j4',
      ],
      { cwd: root, env, stdio: 'inherit', timeout: 2_400_000 },
    ).status === 0
  )
}
function compare(group: string, save: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(gate, 'main.ts'), '--group', group, '--save', save],
    { cwd: root, env, stdio: 'inherit', timeout: 3_600_000 },
  )
}
if (!build()) throw new Error('Clean scratch build failed')
for (const group of new Set(selected.map((fault) => fault.group))) {
  if (compare(group, resolve(out, `baseline-${group}.json`)).status !== 0) {
    throw new Error(`Baseline ${group} is not green; no mutation is meaningful`)
  }
}
try {
  for (const fault of selected) {
    const started = Date.now()
    let result: Omit<Result, 'seconds'> | undefined
    try {
      const path = resolve(out, fault.file)
      if (!path.startsWith(scratch))
        throw new Error(`Fault path escapes scratch crates: ${fault.file}`)
      const original = readFileSync(path, 'utf8')
      if (original.split(fault.from).length !== 2) {
        result = {
          id: fault.id,
          group: fault.group,
          verdict: 'INVALID',
          reason: 'Expected exactly one mutation site',
        }
        continue
      }
      try {
        writeFileSync(
          path,
          original.replace(fault.from, () => fault.to),
        )
        if (!build()) {
          result = {
            id: fault.id,
            group: fault.group,
            verdict: 'INVALID',
            reason: 'Mutant did not build',
          }
          continue
        }
        const saved = resolve(out, `${fault.id}.json`)
        const run = compare(fault.group, saved)
        if (run.error || run.signal) {
          result = {
            id: fault.id,
            group: fault.group,
            verdict: run.error?.message.includes('ETIMEDOUT') ? 'TIMEOUT' : 'CRASHED',
            reason: run.error?.message ?? `Signal ${run.signal}`,
          }
          continue
        }
        let report: {
          differences: unknown[]
          stale: unknown[]
          runtimeFailures: Array<{ message: string }>
        }
        try {
          report = JSON.parse(readFileSync(saved, 'utf8'))
        } catch {
          result = {
            id: fault.id,
            group: fault.group,
            verdict: 'INVALID',
            reason: 'Comparison did not produce a report',
          }
          continue
        }
        const differences = report.differences.length
        const stale = report.stale.length
        const failure = report.runtimeFailures[0]
        result = {
          id: fault.id,
          group: fault.group,
          differences,
          stale,
          verdict: failure
            ? /timed? ?out|ETIMEDOUT/i.test(failure.message)
              ? 'TIMEOUT'
              : 'CRASHED'
            : run.status === 1 && differences + stale > 0
              ? 'DETECTED'
              : 'MISSED',
          ...(failure ? { reason: failure.message } : {}),
        }
      } finally {
        writeFileSync(path, original)
      }
    } finally {
      if (result) results.push({ ...result, seconds: (Date.now() - started) / 1000 })
    }
  }
} finally {
  writeFileSync(
    resolve(out, 'summary.json'),
    JSON.stringify({ node: process.version, results }, null, 2) + '\n',
    { flag: 'wx' },
  )
}
console.table(results)
console.log(`Fault evidence: ${out}`)
process.exitCode = results.every((result) => result.verdict === 'DETECTED') ? 0 : 1
