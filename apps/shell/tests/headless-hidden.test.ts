import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  runHeadlessExport,
  type HeadlessExporters,
  type HeadlessPlaceholderExport,
} from '../src/main/headless-export'
import { run } from '../../../packages/cli/tests/helpers'
import type { HeadlessExportRequest } from '@seuoffice/electron-utils'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  OWN_REDACT_NS,
  PLACEHOLDER,
  SECRET,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

/**
 * `--headless-export` run directly (no command line in front of it, no person
 * to ask): a document holding content hidden from AI is not copied into a
 * PDF, a page or a picture, where no placeholder can stand in for it. It is
 * refused before any window opens, as `seuoffice convert` refuses it. A Word
 * document's HTML or Markdown is written as the AI readers' view instead (the
 * command line's conversion, run here in process as the app runs it as a child).
 */

const placeholders: HeadlessPlaceholderExport = async (input, outPath, format) => {
  const r = await run(['convert', input, '--to', format, '--out', outPath, '--force', '--json'])
  if (r.code !== 0) throw new Error(r.stdout)
}

function exporters(): { exporters: HeadlessExporters; calls: string[] } {
  const calls: string[] = []
  const make = (name: string) => async (input: string, outPath: string) => {
    calls.push(`${name}:${input}`)
    writeFileSync(outPath, 'written')
  }
  return {
    calls,
    exporters: {
      docs: make('docs'),
      sheets: make('sheets'),
      slides: make('slides'),
      markdown: make('markdown'),
      html: make('html'),
      hwp: make('hwp'),
      diagram: make('diagram'),
    },
  }
}

const markedRun = `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r>`

const MARKED: Array<{
  name: string
  file: string
  bytes: () => Promise<Uint8Array | string>
  to: HeadlessExportRequest['targetFormat'][]
}> = [
  {
    name: 'a Word document (body)',
    file: 'a.docx',
    bytes: () => buildDocx({ bodyXml: `<w:p>${markedRun}</w:p>` }),
    to: ['pdf'],
  },
  {
    name: 'a Word document (header only)',
    file: 'h.docx',
    bytes: () => buildDocx({ bodyXml: '<w:p/>', headerXml: `<w:p>${markedRun}</w:p>` }),
    to: ['pdf'],
  },
  {
    name: 'a Markdown file',
    file: 'a.md',
    bytes: async () => `Call <span data-redaction data-label="client phone">${SECRET}</span>\n`,
    to: ['pdf'],
  },
  {
    name: 'an HTML page',
    file: 'a.html',
    bytes: async () => `<p>Call <span data-gx-redact="client phone">${SECRET}</span></p>`,
    to: ['pdf', 'docx'],
  },
]

describe.each(MARKED)('$name holding hidden content', ({ file, bytes, to }) => {
  it.each(to)('is refused for --to %s before any exporter runs', async (format) => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-hidden-'))
    const input = join(dir, file)
    writeFileSync(input, await bytes())
    const { exporters: e, calls } = exporters()
    const outcome = await runHeadlessExport(
      { input, outPath: join(dir, `out.${format}`), targetFormat: format, json: true },
      e,
    )
    expect(outcome).toMatchObject({ ok: false, code: 2 })
    expect(outcome.ok ? '' : outcome.message).toContain('hidden from AI')
    expect(outcome.ok ? '' : outcome.message).not.toContain(SECRET)
    expect(calls).toEqual([])
  })
})

describe.each(['html', 'md'] as const)(
  'a Word document holding hidden content, --to %s',
  (format) => {
    it('is written with a placeholder for the hidden words, never the words', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'headless-hidden-'))
      const input = join(dir, 'a.docx')
      writeFileSync(
        input,
        await buildDocx({
          bodyXml: `<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>${markedRun}</w:p>`,
        }),
      )
      const outPath = join(dir, `out.${format}`)
      const { exporters: e, calls } = exporters()
      const outcome = await runHeadlessExport(
        { input, outPath, targetFormat: format, json: true },
        e,
        undefined,
        placeholders,
      )
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
      expect(calls).toEqual([])
      const text = readFileSync(outPath, 'utf-8')
      expect(text).toContain(PLACEHOLDER)
      expect(text).not.toContain(SECRET)
    })

    it('is refused when no placeholder export is at hand, and writes nothing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'headless-hidden-'))
      const input = join(dir, 'a.docx')
      writeFileSync(input, await buildDocx({ bodyXml: `<w:p>${markedRun}</w:p>` }))
      const outPath = join(dir, `out.${format}`)
      const outcome = await runHeadlessExport(
        { input, outPath, targetFormat: format, json: true },
        exporters().exporters,
      )
      expect(outcome).toMatchObject({ ok: false })
      expect(existsSync(outPath)).toBe(false)
    })
  },
)

describe('a document without hidden content', () => {
  it('is exported as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-hidden-'))
    const input = join(dir, 'plain.docx')
    writeFileSync(input, await buildDocx({ bodyXml: '<w:p><w:r><w:t>Plain</w:t></w:r></w:p>' }))
    const { exporters: e, calls } = exporters()
    const outcome = await runHeadlessExport(
      { input, outPath: join(dir, 'out.pdf'), targetFormat: 'pdf', json: true },
      e,
    )
    expect(outcome).toMatchObject({ ok: true })
    expect(calls).toEqual([`docs:${input}`])
  })
})
