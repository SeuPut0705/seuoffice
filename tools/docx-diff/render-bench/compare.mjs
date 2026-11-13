// Compares the runs of apps/web/tests/bench-docx.spec.ts (the B4 render
// benchmark): every bench-<engine>-<n>.json of apps/web/test-results, engine
// `wasm` (the binding) or `ts` (the frozen TypeScript engine). Prints the
// table, writes it to $GITHUB_STEP_SUMMARY when set, and exits 1 where the
// wasm route makes the whole benchmark more than 5% slower (main's rule,
// crates/docx-engine/B4-PLAN.md decision 1).
//
//   node tools/docx-diff/render-bench/compare.mjs
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../../../apps/web/test-results/', import.meta.url))
const LIMIT = 0.05

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const runs = { ts: [], wasm: [] }
for (const name of readdirSync(DIR)) {
  const match = /^bench-(ts|wasm)-\d+\.json$/.exec(name)
  if (match) runs[match[1]].push(JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')))
}
if (!runs.ts.length || !runs.wasm.length) throw new Error(`no runs of both engines in ${DIR}`)

const paths = runs.ts[0].documents.map((d) => d.path)
const samples = (engine, path) =>
  runs[engine].flatMap((run) => run.documents.find((d) => d.path === path).runsMs)
const documents = paths.map((path) => ({
  path,
  tsMs: median(samples('ts', path)),
  wasmMs: median(samples('wasm', path)),
  samples: samples('wasm', path).length,
}))
const tsTotal = documents.reduce((sum, d) => sum + d.tsMs, 0)
const wasmTotal = documents.reduce((sum, d) => sum + d.wasmMs, 0)
const change = wasmTotal / tsTotal - 1

const f = (n) => n.toFixed(0)
const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
const lines = [
  `| document | TS ms | wasm ms | change |`,
  `|---|---:|---:|---:|`,
  ...documents.map((d) => `| ${d.path} | ${f(d.tsMs)} | ${f(d.wasmMs)} | ${pct(d.wasmMs / d.tsMs - 1)} |`),
  `| **total** (medians of ${documents[0].samples} opens each) | ${f(tsTotal)} | ${f(wasmTotal)} | ${pct(change)} |`,
]
const verdict =
  change > LIMIT
    ? `The wasm route is ${pct(change)} slower: over the 5% limit.`
    : `The wasm route is within the 5% limit (${pct(change)}).`
const text = `${lines.join('\n')}\n\n${verdict}\n`
console.log(text)
writeFileSync(`${DIR}bench.json`, JSON.stringify({ tsTotal, wasmTotal, change, documents }, null, 1) + '\n')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Render benchmark\n\n${text}`)
if (change > LIMIT) process.exitCode = 1
