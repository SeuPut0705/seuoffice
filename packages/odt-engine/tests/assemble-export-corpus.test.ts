/**
 * Local-only run of `docxToOdt` over real docx files (never committed).
 * Skipped unless ODT_CORPUS points at the corpus folder; reads `<ODT_CORPUS>/docx`
 * and writes the ODTs to `<ODT_CORPUS>/out-docx2odt` (outside the repository).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @genoffice/odt-engine
 *
 * Every converted file must re-read through `odtToDocx` with the same
 * paragraph count, text, table grids, drawables, notes and page geometry.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { docxToOdt, odtToDocx } from '../src'
import { type DocSignature, signature } from './helpers/docx-signature'

const root = process.env.ODT_CORPUS
const dir = root ? join(root, 'docx') : ''

describe.skipIf(!root || !existsSync(dir))('docxToOdt over the docx corpus', () => {
  it('converts every docx and re-reads the same content', async () => {
    const out = join(root as string, 'out-docx2odt')
    mkdirSync(out, { recursive: true })
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.docx'))
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    const lines: string[] = []
    for (const name of files.sort()) {
      try {
        const docx = new Uint8Array(readFileSync(join(dir, name)))
        const t0 = performance.now()
        const { odtBytes, report } = await docxToOdt(docx)
        const ms = performance.now() - t0
        writeFileSync(join(out, name.replace(/\.docx$/i, '.odt')), odtBytes)
        const a = signature(await parseDocx(docx))
        const b = signature(await parseDocx((await odtToDocx(odtBytes)).docxBytes))
        const diff = (Object.keys(a) as Array<keyof DocSignature>).filter(
          (k) =>
            k !== 'defaults' && k !== 'headers' && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
        )
        const extra = (['headers', 'defaults'] as const).filter(
          (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
        )
        lines.push(
          `${name}: ${ms.toFixed(0)} ms, paragraphs ${a.paragraphs}, tables ${a.tables.length}, ` +
            `drawables ${a.drawables}, notes ${a.notes.length}, pages ${a.pages.length}` +
            (report.length
              ? `, report ${report.map((r) => `${r.kind}:${r.feature}=${r.count}`).join(' ')}`
              : '') +
            (extra.length ? `, differs: ${extra.join(' ')}` : ''),
        )
        for (const k of diff)
          failures.push(
            `${name}: ${k} ${JSON.stringify(a[k]).slice(0, 200)} → ${JSON.stringify(b[k]).slice(0, 200)}`,
          )
      } catch (e) {
        failures.push(`${name}: ${(e as Error).stack ?? (e as Error).message}`)
      }
    }
    console.log(lines.join('\n'))
    expect(failures).toEqual([])
  }, 600_000)
})

const received = (base: string): string[] =>
  ['hancom', 'gov']
    .filter((d) => existsSync(join(base, d)))
    .flatMap((d) =>
      readdirSync(join(base, d))
        .filter((f) => f.toLowerCase().endsWith('.odt'))
        .map((f) => join(base, d, f)),
    )

describe.skipIf(!root)('docxToOdt over the bridges of received ODTs', () => {
  it('saves every opened ODT as a new ODT with the same content', async () => {
    const files = received(root as string)
    const failures: string[] = []
    let slowest = { name: '', ms: 0 }
    for (const file of files) {
      try {
        const { docxBytes } = await odtToDocx(new Uint8Array(readFileSync(file)))
        const t0 = performance.now()
        const { odtBytes } = await docxToOdt(docxBytes)
        const ms = performance.now() - t0
        if (ms > slowest.ms) slowest = { name: file, ms }
        const a = signature(await parseDocx(docxBytes))
        const b = signature(await parseDocx((await odtToDocx(odtBytes)).docxBytes))
        for (const k of ['paragraphs', 'text', 'tables', 'drawables', 'notes', 'pages'] as const)
          if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) failures.push(`${file}: ${k}`)
      } catch (e) {
        failures.push(`${file}: ${(e as Error).stack ?? (e as Error).message}`)
      }
    }
    console.log(
      `bridge → new ODT: ${files.length} files, slowest ${slowest.name} ${slowest.ms.toFixed(0)} ms`,
    )
    expect(failures).toEqual([])
  }, 1_800_000)
})
