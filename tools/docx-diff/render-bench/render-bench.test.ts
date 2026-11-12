// The render benchmark of batch B4 (crates/docx-engine/B4-PLAN.md, main's
// decision 1): open and lay out the five largest .docx files of the
// repository the way the docs renderer does, with @seuoffice/docx-engine
// either the frozen TypeScript engine (BENCH_ENGINE=ts) or the wasm binding
// (BENCH_ENGINE=wasm). render-bench.mjs runs both and compares.
//
// jsdom measures no layout: what the renderer spends in Chromium's layout is
// absent here, so the engine's share of the time, and any slowdown the wasm
// route adds to it, is larger than in the app. A function within 5% here is
// within 5% in the app.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Editor } from '@tiptap/core'
import { parseDocx, readPageColor, readSectionSettings, readSections } from '@seuoffice/docx-engine'
import { afterAll, expect, it, vi } from 'vitest'
import { docStyleCss } from '../../../apps/docs/src/renderer/doc-style-css'
import { blocksToPmDoc, pmDocOptions } from '../../../apps/docs/src/renderer/editor/convert'
import { editorExtensions } from '../../../apps/docs/src/renderer/editor/extensions'
import { collectDocFonts } from '../../../apps/docs/src/renderer/font-check'
import { setDocFontTable } from '../../../apps/docs/src/renderer/line-metrics'

/** per export: how often the app called it and how long it took, in ms (vi.mock is hoisted above the imports) */
const { spent, instrumented } = vi.hoisted(() => ({
  spent: new Map<string, { calls: number; ms: number }>(),
  instrumented: process.env.BENCH_INSTRUMENT === '1',
}))

vi.mock('@seuoffice/docx-engine', async (importOriginal) => {
  const engine = await importOriginal<Record<string, unknown>>()
  if (!instrumented) return engine
  const timed = (name: string, fn: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const start = performance.now()
      const result = fn.apply(this, args)
      const add = (): void => {
        const entry = spent.get(name) ?? { calls: 0, ms: 0 }
        entry.calls++
        entry.ms += performance.now() - start
        spent.set(name, entry)
      }
      if (result instanceof Promise) return result.finally(add)
      add()
      return result
    }
  return Object.fromEntries(
    Object.entries(engine).map(([name, value]) => [
      name,
      typeof value === 'function' && !/^class\b/.test(Function.prototype.toString.call(value))
        ? timed(name, value as (...args: unknown[]) => unknown)
        : value,
    ]),
  )
})

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ENGINE = process.env.BENCH_ENGINE ?? 'wasm'
const WARMUP = 2
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 10)

/** the five largest tracked .docx files that open (an encrypted one does not) */
async function largestDocuments(): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const tracked = execFileSync('git', ['ls-files', '-z', '*.docx'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, size: statSync(join(ROOT, path)).size }))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
  const out: Array<{ path: string; bytes: Uint8Array }> = []
  for (const { path } of tracked) {
    const bytes = new Uint8Array(readFileSync(join(ROOT, path)))
    try {
      await parseDocx(bytes)
    } catch {
      continue
    }
    out.push({ path, bytes })
    if (out.length === 5) break
  }
  return out
}

/** what the renderer does from the bytes to a mounted, styled document (file-actions.ts loadFile) */
async function openAndLayOut(editor: Editor, bytes: Uint8Array): Promise<void> {
  const parsed = await parseDocx(bytes)
  setDocFontTable(parsed.fontTable)
  collectDocFonts(parsed)
  editor.storage.listNumbering.styles = parsed.styles
  editor.storage.listNumbering.docDefaults = parsed.docDefaults
  editor.storage.listNumbering.defs = parsed.numbering
  editor.commands.setContent(
    blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)) as never,
  )
  docStyleCss(parsed)
  readSectionSettings(parsed)
  readSections(parsed)
  readPageColor(parsed)
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const results: Array<{ path: string; medianMs: number; runsMs: number[] }> = []

it(
  `opens and lays out the five largest documents (${ENGINE})`,
  async () => {
    const documents = await largestDocuments()
    expect(documents).toHaveLength(5)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'docParagraph' }] },
    })
    for (const { path, bytes } of documents) {
      for (let i = 0; i < WARMUP; i++) await openAndLayOut(editor, bytes)
    }
    spent.clear()
    for (const { path, bytes } of documents) {
      const runsMs: number[] = []
      for (let i = 0; i < ROUNDS; i++) {
        const start = performance.now()
        await openAndLayOut(editor, bytes)
        runsMs.push(performance.now() - start)
      }
      results.push({ path, medianMs: median(runsMs), runsMs })
    }
    editor.destroy()
  },
  600_000,
)

afterAll(() => {
  const out = join(ROOT, 'tools/docx-diff/out')
  mkdirSync(out, { recursive: true })
  const name = `render-bench-${ENGINE}${instrumented ? '-instrumented' : ''}.json`
  writeFileSync(
    join(out, name),
    JSON.stringify(
      {
        engine: ENGINE,
        instrumented,
        rounds: ROUNDS,
        documents: results,
        totalMedianMs: results.reduce((sum, r) => sum + r.medianMs, 0),
        exports: Object.fromEntries(
          [...spent.entries()]
            .sort((a, b) => b[1].ms - a[1].ms)
            .map(([name, entry]) => [name, { calls: entry.calls / ROUNDS, ms: entry.ms / ROUNDS }]),
        ),
      },
      null,
      1,
    ) + '\n',
  )
})
