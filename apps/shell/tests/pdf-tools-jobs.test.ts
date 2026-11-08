/**
 * The PDF tools window's add password, remove password and repair, run as
 * structure jobs in-process with the real qpdf and PDFium: what the window
 * sends (tools.ts jobFor) comes back as a file that keeps the tool's promise.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { loadPdfium } from '../../../packages/pdf-structure/tests/helpers/fixtures'
import { qpdfWasmPath } from '../../pdf/src/main/wasm-path'
import { runStructureJob, type JobDeps } from '../src/main/pdf-structure/jobs'
import { errorMessageOf } from '../src/main/pdf-structure/protocol'
import { checkOptions, inspectPdf, jobBytesOf, jobFor } from '../src/main/pdf-tools/tools'

const deps: JobDeps = {
  pdfium: loadPdfium,
  ocr: () => null,
  now: () => new Date('2026-01-02T03:04:05Z'),
  structuredTextFormatter: null,
  translatedPdfWriter: null,
  qpdfWasmPath: qpdfWasmPath(),
}
const noProgress = () => {}

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300])
  return doc.save({ useObjectStreams: false })
}

let dir: string
const write = (name: string, bytes: Uint8Array) => {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

/** run the job the window would send for `tool` with these options, as the window checks them */
async function runTool(
  tool: 'encrypt' | 'decrypt' | 'repair',
  path: string,
  options: Record<string, unknown> = {},
  jobDeps: JobDeps = deps,
): Promise<Uint8Array> {
  const checked = checkOptions(tool, options, 1)
  if (!checked.ok) throw new Error(checked.error)
  const value = await runStructureJob(jobFor(tool, path, checked.options), jobDeps, noProgress)
  const bytes = jobBytesOf(value)
  if (!bytes) throw new Error('no bytes')
  return bytes
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf-tools-jobs-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('add password and remove password', () => {
  it('locks a PDF and opens it again only with the password', async () => {
    const source = write('a.pdf', await pdf(3))
    const locked = await runTool('encrypt', source, { password: '열려라 참깨' })
    expect(await inspectPdf(locked)).toEqual({ ok: false, problem: 'encrypted' })

    const lockedPath = write('a-locked.pdf', locked)
    const wrong = await runStructureJob(
      jobFor('decrypt', lockedPath, { password: 'nope' }),
      deps,
      noProgress,
    ).catch((err: unknown) => err)
    // the window shows "the password is not correct" for this, and nothing else
    expect(errorMessageOf(wrong).error).toBe('password-required')
    expect(errorMessageOf(wrong).message).not.toContain('nope')

    const open = await runTool('decrypt', lockedPath, { password: '열려라 참깨' })
    expect(await inspectPdf(open)).toEqual({ ok: true, pages: 3 })
  })

  it('sends the permission password only when blocking is asked for', () => {
    expect(jobFor('encrypt', 'x.pdf', { password: 'a', permissionPassword: 'b' })).toEqual({
      op: 'encrypt',
      source: { pdfPath: 'x.pdf' },
      userPassword: 'a',
    })
    expect(
      jobFor('encrypt', 'x.pdf', { password: 'a', restrict: true, permissionPassword: 'b' }),
    ).toEqual({
      op: 'encrypt',
      source: { pdfPath: 'x.pdf' },
      userPassword: 'a',
      ownerPassword: 'b',
    })
  })

  it('is not offered without qpdf', async () => {
    const source = write('a.pdf', await pdf(1))
    const err = await runStructureJob(
      jobFor('encrypt', source, { password: 'a' }),
      { ...deps, qpdfWasmPath: null },
      noProgress,
    ).catch((e: unknown) => e)
    expect(errorMessageOf(err).error).toBe('not-available')
  })
})

describe('repair', () => {
  it('rewrites a PDF whose cross-reference table points at the wrong places', async () => {
    const text = Buffer.from(await pdf(2)).toString('latin1')
    // every offset in the table now points 7 bytes off, and the startxref too
    const broken = text
      .replace(
        /(\d{10}) 00000 n/g,
        (_m, offset: string) => `${String(Number(offset) + 7).padStart(10, '0')} 00000 n`,
      )
      .replace(/startxref\s+(\d+)/, (_m, at: string) => `startxref\n${Number(at) + 7}`)
    expect(broken).not.toBe(text)
    const path = write('broken.pdf', new Uint8Array(Buffer.from(broken, 'latin1')))
    const repaired = await runTool('repair', path)
    expect(await inspectPdf(repaired)).toEqual({ ok: true, pages: 2 })
  })

  it('keeps the whole pages of a file cut short, which PDFium gives up on', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 3; i++) {
      doc.addPage([200, 200]).drawText(`page ${i + 1}`, { x: 20, y: 100, size: 12, font })
    }
    const whole = await doc.save({ useObjectStreams: false })
    // the last page and the cross-reference table are gone, an object is cut off partway,
    // and neither PDFium nor the other tools read what is left
    const cut = whole.slice(0, Math.floor(whole.length * 0.7))
    expect(await inspectPdf(cut)).toEqual({ ok: false, problem: 'unreadable' })
    const path = write('cut.pdf', cut)
    const repaired = await runTool('repair', path)
    expect(await inspectPdf(repaired)).toEqual({ ok: true, pages: 2 })
  })

  it('names a file it cannot read at all', async () => {
    const path = write('junk.pdf', new TextEncoder().encode('%PDF-1.7\nnothing here'))
    const err = await runStructureJob(jobFor('repair', path, {}), deps, noProgress).catch(
      (e: unknown) => e,
    )
    expect(errorMessageOf(err).error).toBe('failed')
  })
})
