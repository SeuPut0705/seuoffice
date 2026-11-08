/**
 * Same-format save round trips over a corpus: open, export in the file's own format, apply the
 * corrections the app's save path applies, reopen, and compare what the engine reports. This
 * measures what a save keeps; it does not prove that Hancom Hangul opens the result.
 *
 * Corpus: the fixtures of this app, the root e2e assets, and (outside the repository) the folder
 * named by SEUOFFICE_HWP_CORPUS. Files from that folder are reported by number and never by name.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as CFB from 'cfb'
import init, { HwpDocument } from '@rhwp/core'
import { DISTRIBUTION, ENCRYPTED, FILE_HEADER } from '../src/main/hwp5-file'
import { fieldKindsOf } from '../src/main/field-kinds'
import { applySaveFixes } from '../src/main/save-fixes'
import { sectionTailsOf } from '../src/main/section-tails'
import { hasTrackedChanges, withoutTrackedChanges } from '../src/main/tracked-changes'
import { bytesMatchFormat } from '../src/main/save-plan'
import type { SaveBase } from '../src/main/save-fixes'
import type { HwpFormat } from '../src/shared/ipc'

const require = createRequire(import.meta.url)

/**
 * Files whose round trip is known to differ, by file name, with the reason. A file listed here is
 * reported as a known loss instead of failing; a listed file that now matches fails, so the
 * list cannot go stale. Reasons point at docs/tracking/findings.md or at the investigation.
 */
const KNOWN_LOSSES: Record<string, string> = {}

type Verdict = 'match' | 'known loss' | 'mismatch' | 'reopen failed' | 'excluded'

interface Shape {
  pages: number
  sections: number
  paragraphs: number[]
  text: string
}

interface Row {
  file: string
  format: HwpFormat
  verdict: Verdict
  pages: string
  sections: string
  paragraphs: string
  text: string
  /** whether the saved file is byte-identical to the file as it was opened */
  bytes: string
  note: string
}

const rows: Row[] = []
let outsideCount = 0

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

const here = dirname(new URL(import.meta.url).pathname)

function listCorpus(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /\.hwpx?$/i.test(name))
    .sort()
    .map((name) => join(dir, name))
}

function formatOf(path: string): HwpFormat {
  return /\.hwpx$/i.test(path) ? 'hwpx' : 'hwp'
}

function shapeOf(doc: HwpDocument): Shape {
  const sections = doc.getSectionCount()
  const paragraphs: number[] = []
  for (let i = 0; i < sections; i++) paragraphs.push(doc.getParagraphCount(i))
  return {
    pages: doc.pageCount(),
    sections,
    paragraphs,
    text: doc.getTextFileText().replace(/\r\n?/g, '\n'),
  }
}

/** The reason a file is left out of the comparison, or null when it can be saved. */
function exclusionOf(bytes: Uint8Array, format: HwpFormat): string | null {
  if (!bytesMatchFormat(bytes, format)) {
    return format === 'hwp' ? 'not an OLE container' : 'not a ZIP container'
  }
  if (format === 'hwp') {
    const cfb = CFB.read(Buffer.from(bytes), { type: 'buffer' })
    const header = CFB.find(cfb, FILE_HEADER)?.content
    if (header && header.length >= 40) {
      const flags = Buffer.from(header as Uint8Array).readUInt32LE(36)
      if (flags & ENCRYPTED) return 'encrypted'
      if (flags & DISTRIBUTION) return 'distribution copy'
    }
  }
  return null
}

function measure(path: string, label: string, known: string | undefined): Row {
  const format = formatOf(path)
  const row: Row = {
    file: label,
    format,
    verdict: 'match',
    pages: '',
    sections: '',
    paragraphs: '',
    text: '',
    bytes: '',
    note: '',
  }
  const original: Uint8Array = readFileSync(path)
  let bytes = original
  const excluded = exclusionOf(bytes, format)
  if (excluded) return { ...row, verdict: 'excluded', note: excluded }

  // what the app's read does before the editor gets the bytes
  if (format === 'hwp' && hasTrackedChanges(bytes)) {
    const current = withoutTrackedChanges(bytes)
    if (!current) return { ...row, verdict: 'excluded', note: 'tracked changes cannot be dropped' }
    bytes = current
    row.note = 'tracked changes dropped at open'
  }
  const base: SaveBase =
    format === 'hwp'
      ? { tails: sectionTailsOf(bytes) ?? undefined, kinds: fieldKindsOf(bytes) ?? undefined }
      : {}

  const doc = new HwpDocument(bytes)
  let before: Shape
  let exported: Uint8Array
  try {
    before = shapeOf(doc)
    exported = format === 'hwpx' ? doc.exportHwpx() : doc.exportHwp()
  } finally {
    doc.free()
  }
  // tab widths come from the editor's measures, which a test has none of
  const saved = applySaveFixes(exported, format, undefined, base)
  if (saved.tailsSkipped !== undefined) {
    row.note = `${row.note} section tails skipped: ${JSON.stringify(saved.tailsSkipped)}`.trim()
  }

  let after: Shape
  try {
    const again = new HwpDocument(saved.bytes)
    try {
      after = shapeOf(again)
    } finally {
      again.free()
    }
  } catch (err) {
    return {
      ...row,
      verdict: known ? 'known loss' : 'reopen failed',
      note: `${row.note} ${err instanceof Error ? err.message : String(err)}`.trim(),
    }
  }

  const pagesOk = before.pages === after.pages
  const sectionsOk = before.sections === after.sections
  const parasOk = before.paragraphs.join(',') === after.paragraphs.join(',')
  const textOk = before.text === after.text
  row.pages = pagesOk ? String(before.pages) : `${before.pages} -> ${after.pages}`
  row.sections = sectionsOk ? String(before.sections) : `${before.sections} -> ${after.sections}`
  row.paragraphs = parasOk
    ? String(before.paragraphs.reduce((a, b) => a + b, 0))
    : `${before.paragraphs.join('+')} -> ${after.paragraphs.join('+')}`
  row.text = textOk
    ? `${before.text.length} chars`
    : `${before.text.length} -> ${after.text.length} chars`
  row.bytes = Buffer.compare(original, saved.bytes) === 0 ? 'same' : 'differs'
  if (!(pagesOk && sectionsOk && parasOk && textOk)) row.verdict = known ? 'known loss' : 'mismatch'
  if (known) row.note = `${row.note} ${known}`.trim()
  return row
}

const repoRoot = resolve(here, '../../..')
const repoFiles = [
  ...listCorpus(join(here, 'fixtures')),
  ...listCorpus(join(repoRoot, 'e2e/assets')),
]
const corpusDir = process.env.SEUOFFICE_HWP_CORPUS
const outsideFiles = corpusDir ? listCorpus(corpusDir) : []

describe('same-format save round trip', () => {
  for (const path of repoFiles) {
    const name = basename(path)
    it(`keeps ${name} through export, save fixes and reopen`, () => {
      const known = KNOWN_LOSSES[name]
      const row = measure(path, name, known)
      rows.push(row)
      if (known !== undefined && row.verdict === 'match') {
        expect.fail(`${name} is listed in KNOWN_LOSSES but now round-trips cleanly`)
      }
      expect(['match', 'known loss', 'excluded']).toContain(row.verdict)
    })
  }

  for (const path of outsideFiles) {
    it(`keeps outside corpus file ${++outsideCount} through export, save fixes and reopen`, () => {
      const label = `outside-${outsideCount}`
      let row: Row
      try {
        row = measure(path, label, undefined)
      } catch (err) {
        // an unknown file may fail to open at all; that is a result, not a failed test
        row = {
          file: label,
          format: formatOf(path),
          verdict: 'excluded',
          pages: '',
          sections: '',
          paragraphs: '',
          text: '',
          bytes: '',
          note: `open failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      rows.push(row)
      expect(row.verdict).toBeDefined()
    })
  }

  afterAll(() => {
    const own = rows.filter((r) => !r.file.startsWith('outside-'))
    const outside = rows.filter((r) => r.file.startsWith('outside-'))
    console.table(own)
    if (outside.length > 0) {
      const count = (v: Verdict): number => outside.filter((r) => r.verdict === v).length
      console.table([
        {
          files: outside.length,
          match: count('match'),
          'known loss': count('known loss'),
          mismatch: count('mismatch'),
          'reopen failed': count('reopen failed'),
          excluded: count('excluded'),
        },
      ])
    }
  })
})
