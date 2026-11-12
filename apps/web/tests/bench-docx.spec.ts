// The render benchmark of batch B4 (crates/docx-engine/B4-PLAN.md, main's
// decision 1): open and lay out the five largest .docx files of the
// repository in the web Docs app, in Chromium. Runs only under
// SEUOFFICE_BENCH=<label> (.github/workflows/seuoffice-bench.yml builds the
// app once with the wasm binding and once with the frozen TypeScript engine,
// SEUOFFICE_DOCX_ENGINE=ts, and runs this against each in turn).
//
// One sample is the time from handing the file to the launcher to the last
// change of the laid-out pages (their count and the bottom of the last one),
// taken in the page on every animation frame, once nothing has changed for
// 1.5 s. Both builds start the same wasm engine at boot, so the difference is
// what the engine's calls cost on the renderer path.
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Frame, type Page } from '@playwright/test'

const label = process.env.SEUOFFICE_BENCH
const ROUNDS = Number(process.env.SEUOFFICE_BENCH_ROUNDS ?? 5)
const repo = fileURLToPath(new URL('../../..', import.meta.url))

/** the five largest tracked .docx files that are not encrypted */
function largestDocuments(): string[] {
  return execFileSync('git', ['ls-files', '-z', '*.docx'], { cwd: repo, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && !/encrypted/.test(path))
    .map((path) => ({ path, size: statSync(resolve(repo, path)).size }))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, 5)
    .map(({ path }) => path)
}

async function docsFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 600; i++) {
    const frame = page.frames().find((f) => /\/docs\//.test(f.url()))
    if (frame) return frame
    await page.waitForTimeout(50)
  }
  throw new Error('the Docs frame never appeared')
}

/** ms from `start` (Date.now() before the file was handed over) to the last change of the layout */
async function settled(frame: Frame, start: number): Promise<number> {
  await frame.waitForSelector('.doc-page', { timeout: 60_000 })
  return frame.evaluate((since) => {
    const { promise, resolve, reject } = Promise.withResolvers<number>()
    let signature = ''
    let changed = Date.now()
    const deadline = Date.now() + 60_000
    const tick = (): void => {
      const pages = document.querySelectorAll('.doc-page')
      const last = pages[pages.length - 1]
      const now = `${pages.length}:${last ? Math.round(last.getBoundingClientRect().bottom) : 0}`
      if (now !== signature) {
        signature = now
        changed = Date.now()
      }
      if (Date.now() - changed > 1_500) resolve(changed - since)
      else if (Date.now() > deadline) reject(new Error(`layout never settled (${signature})`))
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return promise
  }, start)
}

test.describe('docx render benchmark', () => {
  test.skip(!label, 'set SEUOFFICE_BENCH to run the benchmark')
  test.setTimeout(30 * 60_000)

  test(`opens and lays out the five largest documents (${label})`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const documents = largestDocuments()
    expect(documents).toHaveLength(5)
    const results: Array<{ path: string; runsMs: number[] }> = []
    for (const path of documents) {
      const runsMs: number[] = []
      // the first open warms the caches and the code: not counted
      for (let round = 0; round <= ROUNDS; round++) {
        await page.goto('/')
        const start = Date.now()
        await page.setInputFiles('#file', resolve(repo, path))
        const ms = await settled(await docsFrame(page), start)
        if (round > 0) runsMs.push(ms)
      }
      results.push({ path, runsMs })
    }
    expect(errors).toEqual([])
    const out = resolve(repo, 'apps/web/test-results')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      resolve(out, `bench-${label}.json`),
      JSON.stringify({ label, documents: results }, null, 1) + '\n',
    )
  })
})
