/**
 * Group `m/print-html`: the HTML editor's `html:print-preview` and
 * `html:print-html`.
 *
 * The handlers are inline in `registerHtmlIpc` (the whole editor), so their
 * bodies are copied verbatim from apps/html/src/main/html-main.ts: `renderPrintPdf`
 * 573-596, `printHtml` 761-769, the two handlers 1624-1655. The helpers are the
 * real ones: preview-document.ts and electron-utils' print-window.ts. The hidden
 * windows are print/host.ts's; the folders they make are under `$DIR/temp`.
 *
 * `savePathByWc.get(e.sender.id)` is undefined here: no document batch
 * provides editors in the probe, so the document has no path and the
 * `assetBaseHref` branch (a document that was saved) is not reachable.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import {
  printHtmlDocument,
  type PrintDialogOutcome,
} from '../../../../packages/electron-utils/src/print-window.ts'
import { assetBaseHref, buildPreviewDocument } from '../../../../apps/html/src/main/preview-document.ts'
import { BrowserWindow } from 'electron'
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const html = [{ view: 1, window: 1, surface: 'Html' }]
const temp = { temp: { dir: true as const } }
const page = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>'
const withBase = '<html><head><base href="https://example.test/"></head><body>x</body></html>'
const preview = (...args: unknown[]) => ({ channel: 'html:print-preview', args })
const send = (...args: unknown[]) => ({ channel: 'html:print-html', args })
const m = (config: Record<string, unknown>) => ({ m: config })

const cases: Case[] = [
  {
    note: 'preview: a page becomes the bytes of the PDF the window printed (A4, 0.6 in)',
    views: html,
    files: temp,
    calls: [preview({ html: page })],
  },
  {
    note: 'preview: a document with a base of its own, and the empty document',
    views: html,
    files: temp,
    hosts: m({ pdf: '%PDF-1.4 other' }),
    calls: [preview({ html: withBase }), preview({ html: '' })],
  },
  {
    note: 'preview: a request without html is answered null, no window is made',
    views: html,
    files: temp,
    calls: [preview({}), preview(null), preview({ html: 12 }), preview({ $: 'u' })],
  },
  {
    note: 'preview: the page does not load, which is a null too (the window is destroyed)',
    views: html,
    files: temp,
    hosts: m({ loadError: 'ERR_FILE_NOT_FOUND' }),
    calls: [preview({ html: page })],
  },
  {
    note: 'preview: printToPDF rejects: null',
    views: html,
    files: temp,
    hosts: m({ pdfError: 'Printing failed' }),
    calls: [preview({ html: page })],
  },
  {
    note: 'print-html: the system dialog takes the job',
    views: html,
    files: temp,
    calls: [send({ html: page })],
  },
  {
    note: 'print-html: the user closes the dialog, which is no failure',
    views: html,
    files: temp,
    hosts: m({ print: { success: false, failureReason: 'Print job canceled' } }),
    calls: [send({ html: withBase })],
  },
  {
    note: 'print-html: only the exact reason is a cancel; one that merely mentions it is a failure',
    views: html,
    files: temp,
    hosts: m({ print: { success: false, failureReason: 'print job CANCELED by driver' } }),
    calls: [send({ html: page })],
  },
  {
    note: 'print-html: the print fails without a reason',
    views: html,
    files: temp,
    hosts: m({ print: { success: false, failureReason: '' } }),
    calls: [send({ html: page })],
  },
  {
    note: 'print-html: the page does not load',
    views: html,
    files: temp,
    hosts: m({ loadError: 'ERR_ABORTED' }),
    calls: [send({ html: page })],
  },
  {
    note: 'print-html: the readiness probe rejects, and printing goes on',
    views: html,
    files: temp,
    hosts: m({ exec: 'rejected' }),
    calls: [send({ html: page })],
  },
  {
    note: 'print-html: a probe that never settles is cut off by its timer',
    views: html,
    files: temp,
    hosts: m({ exec: 'pending' }),
    calls: [send({ html: page })],
  },
  {
    note: 'print-html: a request without html is refused before any window is made',
    views: html,
    files: temp,
    calls: [send({ html: 3 }), send(null), send({ $: 'u' })],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const { ipcMain } = cx.electron as unknown as {
      ipcMain: { handle(channel: string, fn: (event: Sender, ...args: never[]) => unknown): void }
    }
    interface Sender {
      sender: { id: number }
    }
    const savePathByWc = new Map<number, string>()

    // html-main.ts:573-596
    async function renderPrintPdf(
      html: string,
      docPath: string | undefined,
      workDir: string,
    ): Promise<Buffer> {
      const base = docPath ? assetBaseHref(dirname(docPath)) : null
      const htmlPath = join(workDir, 'print.html')
      await writeFile(htmlPath, buildPreviewDocument(html, base), 'utf8')
      const printWin = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, javascript: false },
      })
      try {
        await printWin.loadFile(htmlPath)
        return await printWin.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
        })
      } finally {
        printWin.destroy()
      }
    }

    // html-main.ts:761-769
    function printHtml(html: string, docPath: string | undefined): Promise<PrintDialogOutcome> {
      const base = docPath ? assetBaseHref(dirname(docPath)) : null
      return printHtmlDocument({
        html: buildPreviewDocument(html, base),
        window: new BrowserWindow({ show: false, webPreferences: { sandbox: true } }),
        fileName: 'print.html',
        dirPrefix: 'seuoffice-html-print-',
      })
    }

    // html-main.ts:1624-1636
    ipcMain.handle('html:print-preview', async (e, request: { html?: unknown }) => {
      if (typeof request?.html !== 'string') return null
      const workDir = await mkdtemp(join(os.tmpdir(), 'seuoffice-html-preview-'))
      try {
        return await renderPrintPdf(request.html, savePathByWc.get(e.sender.id), workDir)
      } catch (err) {
        console.error('[html] print preview failed:', err)
        return null
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    // html-main.ts:1638-1650
    ipcMain.handle('html:print-html', async (e, request: { html?: unknown }) => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad print request' }
      }
      return printHtml(request.html, savePathByWc.get(e.sender.id))
    })
  },
  cases,
}
