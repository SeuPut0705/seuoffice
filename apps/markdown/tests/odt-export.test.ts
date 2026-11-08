import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { parseDocx } from '@genoffice/docx-engine'
import { ODT_MIMETYPE, odtToText, type ConversionReport } from '@genoffice/odt-engine'
import type { Lang } from '@genoffice/i18n'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { exportDocxBytes } from '../src/renderer/export/docxExport'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'
import {
  confirmOdtReport,
  exportOdt,
  odtFilterName,
  odtReportMessageBox,
  type OdtExportSteps,
} from '../src/main/odt-export'

const editors: Editor[] = []
const dirs: string[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function createEditor(md: string): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  editor.commands.setContent(md, { contentType: 'markdown' })
  editors.push(editor)
  return editor
}

const noImages = () => Promise.resolve(null)

/** the renderer's Word export of a markdown document */
const docxOf = (json: JSONContent) => exportDocxBytes(json, noImages)

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'md-odt-'))
  dirs.push(dir)
  return join(dir, name)
}

/** The first zip entry: an ODT starts with an uncompressed `mimetype` entry. */
function firstZipEntry(bytes: Uint8Array): { name: string; data: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint32(0, true)).toBe(0x04034b50)
  const size = view.getUint32(18, true)
  const nameLen = view.getUint16(26, true)
  const extraLen = view.getUint16(28, true)
  const dec = new TextDecoder()
  const name = dec.decode(bytes.subarray(30, 30 + nameLen))
  const start = 30 + nameLen + extraLen
  return { name, data: dec.decode(bytes.subarray(start, start + size)) }
}

function steps(docx: Uint8Array, path: string | null, confirmAnswer = true) {
  const written: Array<{ path: string; bytes: Uint8Array }> = []
  const s = {
    pickPath: vi.fn(async () => path),
    docx: vi.fn(async () => docx),
    confirm: vi.fn(async (_report: ConversionReport) => confirmAnswer),
    write: vi.fn(async (target: string, bytes: Uint8Array) => {
      written.push({ path: target, bytes })
      await writeFile(target, bytes)
    }),
  } satisfies OdtExportSteps
  return { s, written }
}

/** All paragraph/heading text of a docx, as the docx export wrote it */
async function docxText(bytes: Uint8Array): Promise<string> {
  const parsed = await parseDocx(bytes)
  return parsed.blocks.map((b) => (b.runs ?? []).map((r) => r.text).join('')).join('\n')
}

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean))

describe('markdown ODT export', () => {
  it('writes an ODT (zip, stored mimetype first) at the chosen path', async () => {
    const docx = await docxOf(createEditor('# Title\n\nSome **bold** text.').getJSON())
    const path = tempPath('out.odt')
    const { s } = steps(docx, path)
    const outcome = await exportOdt(s)
    expect(outcome).toEqual({ ok: true, path })
    const bytes = new Uint8Array(readFileSync(path))
    expect(firstZipEntry(bytes)).toEqual({ name: 'mimetype', data: ODT_MIMETYPE })
    const text = await odtToText(bytes)
    expect(text).toContain('Title')
    expect(text).toContain('Some bold text.')
  })

  it('an empty report writes without asking', async () => {
    const path = tempPath('plain.odt')
    const { s } = steps(new Uint8Array([1]), path)
    const odtBytes = new TextEncoder().encode('odt')
    const outcome = await exportOdt(s, async () => ({ odtBytes, report: [] }))
    expect(outcome).toEqual({ ok: true, path })
    expect(s.confirm).not.toHaveBeenCalled()
    expect(s.write).toHaveBeenCalledWith(path, odtBytes)
  })

  it('asks before writing when the report is non-empty; cancel writes nothing', async () => {
    const docx = await docxOf(createEditor('Before\n\n$$\n\\frac{a}{b}\n$$').getJSON())
    const path = tempPath('math.odt')
    const { s } = steps(docx, path, false)
    const outcome = await exportOdt(s)
    expect(outcome).toEqual({ ok: true, canceled: true })
    expect(s.confirm).toHaveBeenCalledTimes(1)
    const report = s.confirm.mock.calls[0]![0]
    expect(report).toContainEqual({ kind: 'converted', feature: 'equation', count: 1 })
    expect(s.write).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it('writes after the confirmation is accepted', async () => {
    const docx = await docxOf(createEditor('Before\n\n$$\n\\frac{a}{b}\n$$').getJSON())
    const path = tempPath('math.odt')
    const { s } = steps(docx, path, true)
    expect(await exportOdt(s)).toEqual({ ok: true, path })
    expect(s.confirm).toHaveBeenCalledTimes(1)
    expect(firstZipEntry(new Uint8Array(readFileSync(path))).data).toBe(ODT_MIMETYPE)
  })

  it('a canceled save dialog converts and writes nothing', async () => {
    const { s } = steps(new Uint8Array(), null)
    expect(await exportOdt(s)).toEqual({ ok: true, canceled: true })
    expect(s.docx).not.toHaveBeenCalled()
    expect(s.write).not.toHaveBeenCalled()
  })

  it('a conversion failure is reported, not thrown, and writes nothing', async () => {
    const path = tempPath('bad.odt')
    const { s } = steps(new TextEncoder().encode('not a docx'), path)
    const outcome = await exportOdt(s)
    expect(outcome.ok).toBe(false)
    expect(s.write).not.toHaveBeenCalled()
  })
})

describe('markdown ODT export and AI redaction', () => {
  /** a paragraph whose middle run carries the redaction mark */
  function redactedDoc(): JSONContent {
    return {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Account number ' },
            {
              type: 'text',
              text: 'SECRET-4711',
              marks: [{ type: 'redaction', attrs: { label: 'account' } }],
            },
            { type: 'text', text: ' is on file.' },
          ],
        },
      ],
    }
  }

  it('the ODT carries exactly the text the docx export carries, no more', async () => {
    const docx = await docxOf(redactedDoc())
    const path = tempPath('redacted.odt')
    const { s } = steps(docx, path)
    expect(await exportOdt(s)).toEqual({ ok: true, path })
    const fromDocx = await docxText(docx)
    const fromOdt = await odtToText(new Uint8Array(readFileSync(path)))
    // the ODT path is the docx export's bytes: same treatment of the redacted run
    expect(fromOdt.includes('SECRET-4711')).toBe(fromDocx.includes('SECRET-4711'))
    // no word in the ODT that the docx did not already contain
    const docxWords = words(fromDocx)
    for (const w of words(fromOdt)) expect(docxWords.has(w)).toBe(true)
    // the redaction label and placeholder never surface in either file
    for (const text of [fromDocx, fromOdt]) {
      expect(text).not.toContain('{{account}}')
    }
  })
})

describe('ODT confirmation dialog', () => {
  const report: ConversionReport = [
    { kind: 'converted', feature: 'equation', count: 2 },
    { kind: 'converted', feature: 'toc', count: 1 },
    { kind: 'dropped', feature: 'comment', count: 3 },
  ]

  it('lists what changes and what is left out, by feature (ko)', () => {
    const box = odtReportMessageBox(report, 'ko')
    expect(box.title).toBe('ODT로 내보내기')
    expect(box.detail).toBe('바뀌는 것\n• 수식 (2)\n• 목차\n\n빠지는 것\n• 메모 (3)')
    expect(box.buttons).toEqual(['저장', '취소'])
    expect(box.cancelId).toBe(1)
  })

  it('omits an empty section (en)', () => {
    const box = odtReportMessageBox([{ kind: 'dropped', feature: 'watermark', count: 1 }], 'en')
    expect(box.detail).toBe('What is left out\n• Watermark')
  })

  it('save = response 0, cancel = response 1', async () => {
    expect(await confirmOdtReport(report, async () => ({ response: 0 }), 'en')).toBe(true)
    expect(await confirmOdtReport(report, async () => ({ response: 1 }), 'en')).toBe(false)
  })

  it('every language has its own wording, never the English copy', () => {
    const langs: Lang[] = [
      'zh',
      'ja',
      'ko',
      'fr',
      'de',
      'es',
      'th',
      'vi',
      'id',
      'ru',
      'ar',
      'pt',
      'it',
      'pl',
      'cs',
      'nl',
      'ms',
      'he',
      'hi',
      'zh-TW',
    ]
    const en = odtReportMessageBox(report, 'en')
    for (const lang of langs) {
      const box = odtReportMessageBox(report, lang)
      expect(box.title, lang).not.toBe(en.title)
      expect(box.message, lang).not.toBe(en.message)
      expect(box.detail, lang).not.toBe(en.detail)
      expect(odtFilterName(lang), lang).not.toBe(odtFilterName('en'))
    }
  })
})

// main/preload/App import electron or the whole editor, so the request path is
// pinned by reading the sources.
const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('markdown ODT export wiring', () => {
  it("routes the shell's 'odt' request through preload to the main handler", () => {
    const app = source('../src/renderer/App.tsx')
    const preload = source('../src/preload/index.ts')
    const main = source('../src/main/markdown-main.ts')
    expect(MARKDOWN_CHANNELS.exportOdt).toBe('markdown:export-odt')
    expect(app).toMatch(
      /if \(format === 'odt'\) \{\s*[^\n]*\n\s*const result = await window\.markdownApi\.exportOdt\(\{/,
    )
    expect(preload).toMatch(/exportOdt:.*MARKDOWN_CHANNELS\.exportOdt/)
    expect(main).toMatch(/ipcMain\.handle\(\s*MARKDOWN_CHANNELS\.exportOdt,/)
    expect(main.slice(main.indexOf('MARKDOWN_CHANNELS.exportOdt,'))).toContain('.odt`')
  })

  it('sends the very bytes the docx export builds', () => {
    const app = source('../src/renderer/App.tsx')
    const flow = app.slice(app.indexOf('const bytes = await exportDocxBytes('))
    const odt = flow.indexOf('window.markdownApi.exportOdt(')
    const docx = flow.indexOf('window.markdownApi.exportDocx(')
    expect(odt).toBeGreaterThan(0)
    expect(docx).toBeGreaterThan(odt)
    expect(flow.slice(0, docx)).toContain('base64: bytesToBase64(bytes)')
  })
})
