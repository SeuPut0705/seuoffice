/**
 * The comparison of the central process: every case of every group through
 * the TypeScript and through the Rust (crates/main-core by way of the
 * main-node addon), each in a fresh folder of its own. A case is equal when
 * the answer (value, error, log lines) and the folder after the call are
 * equal, with each side's folder written as `$DIR`.
 *
 *   npm --prefix tools/main-diff run gate [-- --group update] [--fn name] [--show 20]
 *
 * Fails on a difference that `divergences.json` does not list, on a listed
 * one that no longer reproduces, and on a function whose cases gave fewer
 * than two distinct answers (decision 0030, crates/README.md).
 */
import {
  appendFileSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rustCall } from './rust.ts'
import type { Case, FileSpec, FnSpec, Group, TsContext } from './types.ts'
import { groups } from './groups/index.ts'

const tool = dirname(fileURLToPath(import.meta.url))
/** the clock of every call: 2026-11-12T03:00:00.000Z */
const NOW = 1_794_452_400_000

interface Divergence {
  id: string
  fn: string
  /** the case's index among the function's cases */
  case: number
  typescript: unknown
  rust: unknown
  reason: string
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function substitute(value: unknown, dir: string): unknown {
  if (typeof value === 'string') return value.split('$DIR').join(dir)
  if (Array.isArray(value)) return value.map((v) => substitute(v, dir))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, dir)]))
  }
  return value
}

function setUp(dir: string, files: Record<string, FileSpec> | undefined): void {
  const modes: [string, number][] = []
  for (const [rel, spec] of Object.entries(files ?? {})) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    const s = typeof spec === 'string' ? { text: spec } : spec
    if (s.dir) mkdirSync(path, { recursive: true })
    else if (s.link !== undefined) linkSync(join(dir, s.link), path)
    else writeFileSync(path, s.hex !== undefined ? Buffer.from(s.hex, 'hex') : (s.text ?? ''))
    if (s.mtimeMs !== undefined) utimesSync(path, s.mtimeMs / 1000, s.mtimeMs / 1000)
    if (s.mode !== undefined) modes.push([path, s.mode])
  }
  // modes last, so a read-only folder still received its files
  for (const [path, mode] of modes.reverse()) chmodSync(path, mode)
}

/** The folder after the call: each entry with its kind, mode and contents. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  // a case may leave an entry its owner cannot read (mode 0 or write-only):
  // its mode is recorded first, then lifted while it is read and put back
  const readable = <T>(path: string, mode: number, read: () => T): T => {
    if ((mode & 0o500) === 0o500) return read()
    chmodSync(path, mode | 0o700)
    try {
      return read()
    } finally {
      chmodSync(path, mode)
    }
  }
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const rel = relative(dir, path)
      const st = statSync(path)
      const mode = st.mode & 0o777
      if (st.isDirectory()) {
        out[rel] = `dir ${mode.toString(8)}`
        readable(path, mode, () => walk(path))
      } else {
        const bytes = readable(path, mode, () => readFileSync(path))
        const text = bytes.toString('utf8')
        out[rel] = Buffer.from(text, 'utf8').equals(bytes)
          ? `file ${mode.toString(8)} ${JSON.stringify(text)}`
          : `file ${mode.toString(8)} hex:${bytes.toString('hex')}`
      }
    }
  }
  walk(dir)
  return out
}

function cleanUp(dir: string): void {
  // a case may leave read-only entries behind
  const open = (at: string): void => {
    try {
      chmodSync(at, 0o755)
    } catch {
      /* gone */
    }
    let st
    try {
      st = statSync(at)
    } catch {
      return
    }
    if (st.isDirectory()) for (const name of readdirSync(at)) open(join(at, name))
  }
  open(dir)
  rmSync(dir, { recursive: true, force: true })
}

function errorOf(err: unknown): { code: unknown; message: string } {
  const e = err as { code?: unknown; message?: unknown } | null
  return {
    code: typeof e?.code === 'string' ? e.code : null,
    message: typeof e?.message === 'string' ? e.message : String(err),
  }
}

async function tsWire(spec: FnSpec, args: unknown[], dir: string): Promise<string> {
  const logs: unknown[][] = []
  const cx: TsContext = { now: NOW, log: (...line) => logs.push(line), dir }
  const out: Record<string, unknown> = {}
  try {
    const value = await spec.ts(args, cx)
    if (value !== undefined) out.value = value
  } catch (err) {
    out.error = errorOf(err)
  }
  if (logs.length > 0) out.logs = logs
  return JSON.stringify(out)
}

/** One side of one case: its answer and its folder, with `$DIR` for the folder. */
async function side(
  run: (args: unknown[], dir: string) => Promise<string> | string,
  c: Case,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'main-diff-'))
  try {
    setUp(dir, c.files)
    const wire = await run(substitute(c.args, dir) as unknown[], dir)
    const files = snapshot(dir)
    // the folder appears as written and inside one or two JSON strings, where
    // a Windows path's backslashes are escaped once or twice
    const once = JSON.stringify(dir).slice(1, -1)
    const twice = JSON.stringify(once).slice(1, -1)
    let text = JSON.stringify({ answer: wire, files })
    for (const form of [twice, once, dir]) text = text.split(form).join('$DIR')
    return text
  } finally {
    cleanUp(dir)
  }
}

const ledger: Divergence[] = JSON.parse(readFileSync(join(tool, 'divergences.json'), 'utf8'))
const only = argValue('--group')
/** `--fn name`, repeatable: only those functions */
const fns = process.argv.flatMap((a, i) => (a === '--fn' ? [process.argv[i + 1]] : []))
const show = Number(argValue('--show') ?? 10)

interface FnReport {
  checks: number
  equal: number
  distinct: number
  listed: number
}
const report: Record<string, FnReport> = {}
const differences: { fn: string; case: number; note?: string; typescript: string; rust: string }[] =
  []
const reproduced = new Set<string>()
const singles = new Set<string>()
let failed = false
/** MAIN_DIFF_TRACE=file: each side of each case is named before it runs, written
 * synchronously, so a case that never returns is the last line */
const trace = process.env.MAIN_DIFF_TRACE

for (const [groupName, group] of Object.entries(groups) as [string, Group][]) {
  if (only && only !== groupName) continue
  for (const [fn, spec] of Object.entries(group)) {
    if (fns.length > 0 && !fns.includes(fn)) continue
    const r: FnReport = { checks: 0, equal: 0, distinct: 0, listed: 0 }
    const answers = new Set<string>()
    for (let i = 0; i < spec.cases.length; i++) {
      const c = spec.cases[i]
      if (trace) appendFileSync(trace, `${fn} #${i} typescript\n`)
      const ts = await side((args, dir) => tsWire(spec, args, dir), c)
      if (trace) appendFileSync(trace, `${fn} #${i} rust\n`)
      const rust = await side((args) => rustCall(fn, args, NOW), c)
      r.checks++
      answers.add(ts)
      if (ts === rust) {
        r.equal++
        continue
      }
      const entry = ledger.find((d) => d.fn === fn && d.case === i)
      if (entry && JSON.stringify(entry.typescript) === ts && JSON.stringify(entry.rust) === rust) {
        r.listed++
        reproduced.add(entry.id)
        continue
      }
      differences.push({ fn, case: i, note: c.note, typescript: ts, rust })
    }
    r.distinct = answers.size
    if (spec.single) singles.add(fn)
    report[fn] = r
  }
}

const out = process.env.MAIN_DIFF_OUT ?? join(tool, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'report.json'), JSON.stringify({ report, differences }, null, 2))

let checks = 0
let equal = 0
for (const [fn, r] of Object.entries(report)) {
  checks += r.checks
  equal += r.equal
  const floor = r.distinct >= 2 || singles.has(fn) ? '' : '  FLOOR: fewer than two distinct answers'
  if (floor) failed = true
  console.log(
    `${fn}: ${r.checks} checks, ${r.checks - r.equal - r.listed} differences, ${r.listed} listed, ${r.distinct} distinct${floor}`,
  )
}
for (const d of differences.slice(0, show)) {
  console.log(`\nDIFF ${d.fn} case ${d.case}${d.note ? ` (${d.note})` : ''}`)
  console.log(`  typescript: ${d.typescript}`)
  console.log(`  rust:       ${d.rust}`)
}
const stale = ledger.filter((d) => d.fn in report && !reproduced.has(d.id))
for (const d of stale) console.log(`STALE ledger entry ${d.id}: it no longer reproduces`)
if (differences.length > 0 || stale.length > 0) failed = true
console.log(
  `\n${checks} checks, ${equal} equal, ${differences.length} differences, ${reproduced.size} listed, ${Object.keys(report).length} functions`,
)
process.exitCode = failed ? 1 : 0
