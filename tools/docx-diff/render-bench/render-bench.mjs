// Runs the render benchmark of B4 (render-bench.test.ts) for the frozen
// TypeScript engine and the wasm binding, alternately, and decides by main's
// rule: an export whose wasm route costs more than 5% of the TypeScript run's
// total stays TypeScript.
//
//   node tools/docx-diff/render-bench/render-bench.mjs [pairs=3]
//
// Plain runs give the totals; instrumented runs (every export wrapped in a
// timer) give each export's share. Writes tools/docx-diff/out/render-bench.json
// and prints the table.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = `${ROOT}tools/docx-diff/out`
const CONFIG = fileURLToPath(new URL('vitest.config.ts', import.meta.url))
const PAIRS = Number(process.argv[2] ?? 3)
const LIMIT = 0.05

function run(engine, instrument) {
  const done = spawnSync('npx', ['vitest', 'run', '--config', CONFIG], {
    cwd: ROOT,
    env: { ...process.env, BENCH_ENGINE: engine, BENCH_INSTRUMENT: instrument ? '1' : '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (done.status !== 0) throw new Error(`the ${engine} run failed`)
  const name = `render-bench-${engine}${instrument ? '-instrumented' : ''}.json`
  return JSON.parse(readFileSync(`${OUT}/${name}`, 'utf8'))
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const plain = { ts: [], wasm: [] }
const timed = { ts: [], wasm: [] }
for (let i = 0; i < PAIRS; i++) {
  // alternate the order so a drift of the machine falls on both sides
  for (const engine of i % 2 ? ['wasm', 'ts'] : ['ts', 'wasm']) plain[engine].push(run(engine, false))
}
for (let i = 0; i < PAIRS; i++) {
  for (const engine of i % 2 ? ['wasm', 'ts'] : ['ts', 'wasm']) timed[engine].push(run(engine, true))
}

const documents = plain.ts[0].documents.map((doc, i) => ({
  path: doc.path,
  tsMs: median(plain.ts.map((r) => r.documents[i].medianMs)),
  wasmMs: median(plain.wasm.map((r) => r.documents[i].medianMs)),
}))
const tsTotal = median(plain.ts.map((r) => r.totalMedianMs))
const wasmTotal = median(plain.wasm.map((r) => r.totalMedianMs))

const names = new Set([...timed.ts, ...timed.wasm].flatMap((r) => Object.keys(r.exports)))
const exports = [...names]
  .map((name) => {
    const ms = (runs) => median(runs.map((r) => r.exports[name]?.ms ?? 0))
    const calls = median(timed.wasm.map((r) => r.exports[name]?.calls ?? 0))
    const tsMs = ms(timed.ts)
    const wasmMs = ms(timed.wasm)
    const share = (wasmMs - tsMs) / tsTotal
    return { name, calls, tsMs, wasmMs, share, staysTs: share > LIMIT }
  })
  .sort((a, b) => b.wasmMs - b.tsMs - (a.wasmMs - a.tsMs))

const report = { pairs: PAIRS, limit: LIMIT, tsTotal, wasmTotal, documents, exports }
writeFileSync(`${OUT}/render-bench.json`, JSON.stringify(report, null, 1) + '\n')

const f = (n) => n.toFixed(1)
console.log(`\ntotal (median of ${PAIRS}): TypeScript ${f(tsTotal)} ms, wasm ${f(wasmTotal)} ms (${f((wasmTotal / tsTotal - 1) * 100)}%)`)
for (const d of documents) console.log(`  ${d.path}: ${f(d.tsMs)} -> ${f(d.wasmMs)} ms`)
console.log('\nexport | calls per round | TS ms | wasm ms | share of the TS total')
for (const e of exports.slice(0, 25))
  console.log(`${e.name} | ${e.calls} | ${f(e.tsMs)} | ${f(e.wasmMs)} | ${f(e.share * 100)}%${e.staysTs ? '  STAYS TS' : ''}`)
