// The render benchmark of batch C2 (crates/pptx-engine/C2-PLAN.md): open and
// lay out the five largest decks the gate has, as the slides app does in its
// main process (openPptx, then buildRenderSlide for every slide), once with the
// frozen TypeScript engine and once with the binding over the wasm engine;
// then once per export the render path calls, with that one export taken from
// the TypeScript. An export whose wasm route makes the run more than 5% slower
// stays TypeScript (decision of main, 2026-11-12).
//
//   npx tsx tools/pptx-diff/bench-render.ts [--rounds 30] [--json FILE]
//
// Each configuration runs in its own process: which engine the package name
// loads is fixed when the modules load (bench-hooks.mjs).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Engine from '../../packages/pptx-engine/src/index'
import { repoRoot } from '../docx-diff/harness'

const REFERENCE = resolve(repoRoot, 'tools/pptx-diff/reference')
const BINDING = resolve(repoRoot, 'packages/pptx-engine/src')
const DECK_COUNT = 5
/** Rounds run before the timed ones: they warm the JIT and the wasm instance. */
const WARMUP_ROUNDS = 3

/** The exports packages/pptx-render calls with a value, by the subpath it imports them from. */
const RENDER_PATH: Record<string, string[]> = {
  'table-grid': ['tableRowGridCols'],
  identity: ['elementDurableId', 'groupChildDurableId'],
  'background-promote': ['isBackgroundLikeElement'],
}

interface Timing {
  config: string
  openMs: number
  renderMs: number
  totalMs: number
}

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** One configuration, in this process: the medians of `rounds` rounds over the decks. */
async function measure(config: string, rounds: number): Promise<Timing> {
  // loaded here, not at the top: the driver process loads no engine, and in a
  // child the package name resolves through bench-hooks.mjs to the engine of
  // this configuration
  const { openPptx } = (await import('@seuoffice/pptx-engine')) as typeof Engine
  const { buildRenderSlide } = await import('../../packages/pptx-render/src/index')
  const { DECKS } = await import('./deck-ops')
  const decks = DECKS.map(([name, base64]): [string, Uint8Array] => [
    name,
    Buffer.from(base64, 'base64'),
  ])
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, DECK_COUNT)
  const opens: number[] = []
  const renders: number[] = []
  for (let round = 0; round < rounds + WARMUP_ROUNDS; round++) {
    let open = 0
    let render = 0
    for (const [, bytes] of decks) {
      const t0 = performance.now()
      const opened = await openPptx(bytes)
      const t1 = performance.now()
      opened.deck.slides.forEach((slide, index) => {
        buildRenderSlide(slide, opened.deck.size, { fitWidthPx: 1280, slideNo: index + 1 })
      })
      render += performance.now() - t1
      open += t1 - t0
    }
    if (round >= WARMUP_ROUNDS) {
      opens.push(open)
      renders.push(render)
    }
  }
  const openMs = median(opens)
  const renderMs = median(renders)
  return { config, openMs, renderMs, totalMs: openMs + renderMs }
}

/** A folder of shims: each subpath module of the binding with `names` taken from the reference. */
function shimsFor(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pptx-bench-'))
  for (const [sub, exported] of Object.entries(RENDER_PATH)) {
    const own = exported.filter((name) => names.includes(name))
    if (!own.length) continue
    writeFileSync(
      join(dir, `${sub}.mjs`),
      `export * from ${JSON.stringify(pathToFileURL(join(BINDING, `${sub}.ts`)).href)}\n` +
        `export { ${own.join(', ')} } from ${JSON.stringify(pathToFileURL(join(REFERENCE, `${sub}.ts`)).href)}\n`,
    )
  }
  return dir
}

function runChild(config: string, env: Record<string, string>, rounds: number): Timing {
  const out = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      pathToFileURL(resolve(repoRoot, 'tools/pptx-diff/bench-register.mjs')).href,
      process.argv[1]!,
      '--child',
      config,
      '--rounds',
      String(rounds),
    ],
    { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 26 },
  )
  return JSON.parse(out.trim().split('\n').at(-1)!) as Timing
}

const rounds = Number(argAfter('--rounds') ?? 30)
const child = argAfter('--child')
if (child) {
  console.log(JSON.stringify(await measure(child, rounds)))
} else {
  const results: Timing[] = []
  results.push(runChild('typescript', { BENCH_ENGINE_DIR: REFERENCE }, rounds))
  const wasm = runChild('wasm', {}, rounds)
  results.push(wasm)
  for (const name of Object.values(RENDER_PATH).flat()) {
    results.push(
      runChild(`wasm, ${name} in TypeScript`, { BENCH_SHIM_DIR: shimsFor([name]) }, rounds),
    )
  }
  const base = results[0]!.totalMs
  console.log('| Configuration | Open ms | Render ms | Total ms | vs TypeScript | Export costs |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const cost = r.config.startsWith('wasm, ')
      ? `${(((wasm.totalMs - r.totalMs) / base) * 100).toFixed(1)}%`
      : ''
    console.log(
      `| ${r.config} | ${r.openMs.toFixed(1)} | ${r.renderMs.toFixed(1)} | ${r.totalMs.toFixed(1)} | ${(((r.totalMs - base) / base) * 100).toFixed(1)}% | ${cost} |`,
    )
  }
  const file = argAfter('--json')
  if (file) {
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(results, null, 2) + '\n')
  }
}
