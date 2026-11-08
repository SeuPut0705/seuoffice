// PDF export and print render the print HTML in a hidden window of their own, which
// sees only the fonts the page declares: both must declare the bundled faces from the
// same folder the grid canvas reads. Electron is mocked; the HTML the window loads is
// captured from the temp file.
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const loaded: string[] = []
const PDF_PATH = join(tmpdir(), `sheets-template-fonts-${process.pid}.pdf`)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => resolve(import.meta.dirname, '..'),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    webContents = {
      printToPDF: async () => Buffer.from('%PDF-1.7'),
      print: (_options: unknown, done: (ok: boolean, reason: string) => void) => done(true, ''),
    }
    async loadFile(path: string) {
      loaded.push(readFileSync(path, 'utf8'))
    }
    destroy() {}
  },
  dialog: {
    showSaveDialog: async () => ({
      canceled: false,
      filePath: PDF_PATH,
    }),
  },
}))

import { exportPdf, printWorkbook } from '../src/main/pdf-export'
import { TEMPLATE_FONT_FACE_REGISTRATIONS } from '@genoffice/ui/template-fonts'

import type { IpcMainInvokeEvent } from 'electron'
import type { WorkbookExportPdfRequest } from '../src/shared/desktop-api'

const FOLDER = resolve(import.meta.dirname, '../../../packages/ui/template-fonts')
const REQUEST: WorkbookExportPdfRequest = {
  fileName: 'Book1.pdf',
  html: `<!doctype html><html><head><meta charset="utf-8"></head><body><td style="font-family:'Noto Serif KR',Calibri">가</td></body></html>`,
  landscape: false,
  pageSize: 'A4',
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
  scale: 1,
}
const EVENT = { sender: {} } as IpcMainInvokeEvent

function expectBundledFaces(html: string): void {
  for (const { family, file, weight } of TEMPLATE_FONT_FACE_REGISTRATIONS) {
    const href = pathToFileURL(join(FOLDER, file)).href
    expect(html).toContain(`font-family: '${family}'; src: url("${href}"); font-weight: ${weight};`)
  }
  expect(html).toContain('PlayfairDisplay%5Bwght%5D.ttf')
  expect(html).toContain(`<body><td style="font-family:'Noto Serif KR',Calibri">가</td>`)
}

describe('bundled fonts on the export and print page', () => {
  beforeEach(() => {
    loaded.length = 0
  })
  afterAll(() => {
    rmSync(PDF_PATH, { force: true })
  })

  it('PDF export declares every bundled face', async () => {
    const result = await exportPdf(EVENT, REQUEST)
    expect(result.canceled).toBe(false)
    expect(loaded).toHaveLength(1)
    expectBundledFaces(loaded[0]!)
  })

  it('print declares the same faces', async () => {
    expect(await printWorkbook(EVENT, { ...REQUEST, deviceName: 'Printer' })).toEqual({ ok: true })
    expect(loaded).toHaveLength(1)
    expectBundledFaces(loaded[0]!)
  })
})
