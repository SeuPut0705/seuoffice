/**
 * Stored AI readings in the structure jobs (spec §7): Markdown, EPUB and the
 * structured text use a page's AI reading in place of the page; the tree job
 * (what the page picker and the main process's cache see) stays the PDF's own.
 * Real PDFium on a synthetic PDF, a real result store in a temp folder.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildPdf, loadPdfium } from '../../../packages/pdf-structure/tests/helpers/fixtures'
import { ResultStore } from '../../../packages/pdf-structure/src/store'
import { aiReadingsFromStore, runStructureJob, type JobDeps } from '../src/main/pdf-structure/jobs'
import type {
  FingerprintsJobValue,
  StructuredTextJobValue,
  TreeJobValue,
} from '../src/main/pdf-structure/protocol'
import { treeToStructuredText } from '../../../packages/pdf-structure/src/structured-text'

let dir: string
let pdfPath: string
let bytes: Uint8Array
let store: ResultStore

const noProgress = () => {}

const AI_PAYLOAD = {
  version: 1,
  blocks: [
    { kind: 'heading', level: 1, runs: [{ kind: 'text', text: 'Read By The AI' }] },
    { kind: 'paragraph', runs: [{ kind: 'text', text: 'Text the AI saw in the picture.' }] },
  ],
  footnotes: [],
  droppedRepetitions: 0,
  reasked: false,
}

const depsWith = (aiReadings: JobDeps['aiReadings']): JobDeps => ({
  pdfium: loadPdfium,
  ocr: () => null,
  now: () => new Date('2026-01-02T03:04:05Z'),
  structuredTextFormatter: treeToStructuredText,
  translatedPdfWriter: null,
  aiReadings,
})

beforeAll(async () => {
  bytes = await buildPdf([
    [{ kind: 'text', text: 'First page text stays.', x: 72, y: 700 }],
    [{ kind: 'text', text: 'Second page original words.', x: 72, y: 700 }],
  ])
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf-structure-ai-readings-'))
  pdfPath = join(dir, 'book.pdf')
  writeFileSync(pdfPath, bytes)
  store = new ResultStore(join(dir, 'user-data'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function fingerprints(): Promise<FingerprintsJobValue> {
  return (await runStructureJob(
    { op: 'fingerprints', source: { pdfPath } },
    depsWith(null),
    noProgress,
  )) as FingerprintsJobValue
}

describe('stored AI readings in conversions', () => {
  it('Markdown uses the AI reading in place of its page', async () => {
    const { docHash, fingerprints: fps } = await fingerprints()
    await store.writeAiReadPage(docHash, fps[1]!, AI_PAYLOAD, { provider: 'claude-code' })
    const outPath = join(dir, 'book.md')
    await runStructureJob(
      { op: 'markdown', source: { pdfPath }, outPath },
      depsWith(aiReadingsFromStore(join(dir, 'user-data'))),
      noProgress,
    )
    const md = readFileSync(outPath, 'utf8')
    expect(md).toContain('# Read By The AI')
    expect(md).toContain('Text the AI saw in the picture.')
    expect(md).not.toContain('Second page original words.')
    expect(md).toContain('First page text stays.')
  })

  it('a reading stored for another fingerprint or another document is not used', async () => {
    const { docHash, fingerprints: fps } = await fingerprints()
    await store.writeAiReadPage(docHash, 'not-a-page-of-this-file', AI_PAYLOAD)
    await store.writeAiReadPage('f'.repeat(64), fps[1]!, AI_PAYLOAD)
    const outPath = join(dir, 'book.md')
    await runStructureJob(
      { op: 'markdown', source: { pdfPath }, outPath },
      depsWith(aiReadingsFromStore(join(dir, 'user-data'))),
      noProgress,
    )
    const md = readFileSync(outPath, 'utf8')
    expect(md).toContain('Second page original words.')
    expect(md).not.toContain('Read By The AI')
  })

  it('without a store the conversion is the PDF alone', async () => {
    const { docHash, fingerprints: fps } = await fingerprints()
    await store.writeAiReadPage(docHash, fps[1]!, AI_PAYLOAD)
    const outPath = join(dir, 'book.md')
    await runStructureJob(
      { op: 'markdown', source: { pdfPath }, outPath },
      depsWith(null),
      noProgress,
    )
    expect(readFileSync(outPath, 'utf8')).toContain('Second page original words.')
  })

  it('an unreadable store does not fail the conversion', async () => {
    const outPath = join(dir, 'book.md')
    await runStructureJob(
      { op: 'markdown', source: { pdfPath }, outPath },
      depsWith(async () => {
        throw new Error('disk gone')
      }),
      noProgress,
    )
    expect(readFileSync(outPath, 'utf8')).toContain('Second page original words.')
  })

  it('structured text uses the reading; the extracted tree handed back stays the PDF own', async () => {
    const { docHash, fingerprints: fps } = await fingerprints()
    await store.writeAiReadPage(docHash, fps[1]!, AI_PAYLOAD)
    const value = (await runStructureJob(
      { op: 'structuredText', source: { pdfPath } },
      depsWith(aiReadingsFromStore(join(dir, 'user-data'))),
      noProgress,
    )) as StructuredTextJobValue
    const page2 = value.pages.find((p) => p.page === 2)!
    expect(page2.text).toContain('# Read By The AI')
    expect(page2.text).not.toContain('Second page original words.')
    expect(value.extracted?.tree.pages.map((p) => p.status)).not.toContain('ai')
  })

  it('the tree job is not changed by stored readings', async () => {
    const { docHash, fingerprints: fps } = await fingerprints()
    await store.writeAiReadPage(docHash, fps[1]!, AI_PAYLOAD)
    const value = (await runStructureJob(
      { op: 'tree', source: { pdfPath } },
      depsWith(aiReadingsFromStore(join(dir, 'user-data'))),
      noProgress,
    )) as TreeJobValue
    expect(value.tree.pages.map((p) => p.status)).not.toContain('ai')
    expect(JSON.stringify(value.tree.blocks)).toContain('Second page original words.')
  })
})
