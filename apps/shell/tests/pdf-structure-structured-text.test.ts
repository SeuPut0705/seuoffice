/**
 * The structured-text operation with the formatter the app plugs in (spec §2),
 * run in-process with a real PDFium on a synthetic PDF.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPdf, loadPdfium } from '../../../packages/pdf-structure/tests/helpers/fixtures'
import { treeToStructuredText } from '../../../packages/pdf-structure/src/structured-text'
import { runStructureJob, type JobDeps } from '../src/main/pdf-structure/jobs'
import { structuredTextFormatter } from '../src/main/pdf-structure/plugins'
import type { StructuredTextJobValue } from '../src/main/pdf-structure/protocol'

let dir: string
let pdfPath: string

beforeAll(async () => {
  const bytes = await buildPdf([
    [
      { kind: 'text', text: 'Chapter One', x: 72, y: 700, size: 24, bold: true },
      { kind: 'text', text: 'Plain body text on the first page.', x: 72, y: 650 },
    ],
    [{ kind: 'text', text: 'Second page body text.', x: 72, y: 700 }],
  ])
  dir = mkdtempSync(join(tmpdir(), 'pdf-structured-text-'))
  pdfPath = join(dir, 'book.pdf')
  writeFileSync(pdfPath, bytes)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('structured text plug-in', () => {
  it('plugs the pdf-structure formatter into the slot', () => {
    expect(structuredTextFormatter).toBe(treeToStructuredText)
  })

  it('answers per-page structured text without a formatter override', async () => {
    // no structuredTextFormatter key: the job uses plugins.structuredTextFormatter
    const deps: JobDeps = { pdfium: loadPdfium, ocr: () => null }
    const value = (await runStructureJob(
      { op: 'structuredText', source: { pdfPath } },
      deps,
      () => {},
    )) as StructuredTextJobValue
    expect(value.pages.map((p) => p.page)).toEqual([1, 2])
    expect(value.pages[0]!.text).toMatch(/^# Chapter One\n\nPlain body text on the first page\.$/)
    expect(value.pages[1]!.text).toBe('Second page body text.')
  })
})
