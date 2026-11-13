/**
 * Group `m/print-hwp`: the HWP editor's `hwp:print-pages`.
 *
 * The handler is inline in `registerHwpIpc`, so its body is copied verbatim
 * from apps/hwp/src/main/hwp-main.ts:619-662, with `pdfName` and `pickPdfTarget`
 * from 335-357 (the window factory is 343-344). The helpers are the real ones:
 * print-document.ts (`badJob`, `printJobToPdf`, `printJobToPrinter`),
 * dialog-strings.ts, atomic-write.ts, electron-utils' dialog-memory.ts and
 * headless-mode.ts. What the entry wires in is the case's `hosts.m`:
 * `configuredDefaultSaveDir(app)` is `defaultSaveDir`, `isHeadlessMode()` is
 * `headless`, `runtime.openGeneratedPath` is `openGenerated` (logging
 * `openGeneratedPath`), and the UI language is what index.ts settles at start
 * (the stored `language`, else the locale of `appLocale`).
 *
 * Not reachable in the probe, because no document batch provides editors:
 * `savePathByWc` is empty (the dialog starts in `defaultSaveDir`, the name is
 * "Untitled"), and neither `pdfSaveAsByWc` nor `headlessPdfByWc` holds a
 * grant, so an `options.path` is always refused. A second print while one is
 * in flight cannot be made by calls that run one after another. A write that
 * fails (a folder that does not exist) names the atomic writer's temporary
 * file in its error, whose random suffix no case can equalize: not covered.
 */
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import type { WebContents } from 'electron'
import type * as I18n from '@seuoffice/i18n'
import { readAppSettings } from '../../../../apps/shell/src/main/app-settings.ts'
import { atomicWriteFile } from '../../../../apps/hwp/src/main/atomic-write.ts'
import { tm } from '../../../../apps/hwp/src/main/dialog-strings.ts'
import {
  badJob,
  printJobToPdf,
  printJobToPrinter,
} from '../../../../apps/hwp/src/main/print-document.ts'
import type { PrintJob, PrintResult } from '../../../../apps/hwp/src/shared/ipc.ts'
import { showSaveDialogWithMemory } from '../../../../packages/electron-utils/src/dialog-memory.ts'
import { isHeadlessMode, setHeadlessMode } from '../../../../packages/electron-utils/src/headless-mode.ts'
import type { Case, Group } from '../../types.ts'
import { hostConfig, installPrintHosts } from './print/host.ts'

const hwp = [{ view: 1, window: 1, surface: 'Hwp' }]
const files = { temp: { dir: true as const }, out: { dir: true as const } }
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="a" d="M0 0"/></svg>'
const page = { svg, width: 794, height: 1123 }
const job = (extra: Record<string, unknown> = {}) => ({
  mode: 'pdf',
  pages: [page],
  images: [],
  ...extra,
})
const print = (...args: unknown[]) => ({ channel: 'hwp:print-pages', args })
const saves = (...answers: (string | null)[]) => ({ shared: { dialogs: { save: answers } } })

const cases: Case[] = [
  {
    note: 'refused jobs: each reason badJob gives, before any dialog or window',
    views: hwp,
    files,
    calls: [
      print({ $: 'u' }),
      print('job'),
      print(job({ mode: 'html' })),
      print(job({ pages: [] })),
      print(job({ pages: {} })),
      print(job({ images: [1] })),
      print(job({ images: 'x' })),
      print(job({ pages: [{ svg: 'text', width: 1, height: 1 }] })),
      print(job({ pages: [{ svg, width: 0, height: 1 }] })),
      print(job({ pages: [{ svg, width: 1, height: 100000 }] })),
      print(job({ pages: [null] })),
    ],
  },
  {
    note: 'print: the system dialog takes the pages (the window has no scripts, margins none)',
    views: hwp,
    files,
    calls: [print(job({ mode: 'print' }))],
  },
  {
    note: 'print: a user cancel is a sent job as far as the answer goes',
    views: hwp,
    files,
    hosts: { m: { print: { success: false, failureReason: 'Print job canceled' } } },
    calls: [print(job({ mode: 'print' }))],
  },
  {
    note: 'print: a failure with a reason',
    views: hwp,
    files,
    hosts: { m: { print: { success: false, failureReason: 'no printer' } } },
    calls: [print(job({ mode: 'print' }))],
  },
  {
    note: 'print: a failure without a reason is "print failed"',
    views: hwp,
    files,
    hosts: { m: { print: { success: false, failureReason: '' } } },
    calls: [print(job({ mode: 'print' }))],
  },
  {
    note: 'print: the page does not load',
    views: hwp,
    files,
    hosts: { m: { loadError: 'ERR_FILE_NOT_FOUND' } },
    calls: [print(job({ mode: 'print' }))],
  },
  {
    note: 'print: pictures of the job are written next to the page (a data URL that is no picture stays in it)',
    views: hwp,
    files,
    calls: [
      print(
        job({
          mode: 'print',
          images: ['data:image/png;base64,iVBORw0KGgo=', 'data:text/plain;base64,AAAA', 'x'],
          pages: [{ svg: svg.replace('<path', '<image href="ieum-image:0"/><path'), width: 210, height: 297 }],
        }),
      ),
    ],
  },
  {
    note: 'print: pages the editor draws for print: ids made the page\'s own, pictures by file or data URL, sides snapped to paper',
    views: hwp,
    files,
    calls: [
      print(
        job({
          mode: 'print',
          images: ['data:image/jpeg;base64,/9j/4AA=', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/tiff;base64,AAAA', 'not a data url'],
          pages: [
            {
              svg: '<svg><defs><clipPath id="c1"><rect/></clipPath></defs><g clip-path="url(#c1)" id="g"><use href="#g"/><image href="ieum-image:0"/><image href="ieum-image:2"/><image href="ieum-image:9"/></g></svg>',
              width: 793.7,
              height: 1122.52,
            },
            { svg: '<svg id="c1"><text>한글 &amp; <b>x</b></text></svg>', width: 816, height: 1056 },
            { svg: ' \n<svg/>', width: 0.5, height: 99999.5 },
            { svg: '<svg id="a" id="b"/>', width: 1122.52, height: 793.7 },
          ],
        }),
      ),
    ],
  },
  {
    note: 'pdf: the save dialog picks a file, the PDF is written there and shown (not opened in a tab)',
    views: hwp,
    files,
    hosts: { ...saves('$DIR/out/doc.pdf'), m: { pdf: '%PDF-1.7 hwp' } },
    calls: [print(job())],
  },
  {
    note: 'pdf: the app opens the PDF itself, so the file manager is left alone',
    views: hwp,
    files,
    hosts: { ...saves('$DIR/out/b.pdf'), m: { openGenerated: true } },
    calls: [print(job({ pages: [page, { svg, width: 595.5, height: 842.25 }] }))],
  },
  {
    note: 'pdf: a headless export stays silent',
    views: hwp,
    files,
    hosts: { ...saves('$DIR/out/c.pdf'), m: { headless: true } },
    calls: [print(job())],
  },
  {
    note: 'pdf: the name gets ".pdf" unless it has it, in any case',
    views: hwp,
    files,
    hosts: saves('$DIR/out/plain', '$DIR/out/UPPER.PDF', '$DIR/out/odd.pdf.txt'),
    calls: [print(job()), print(job()), print(job())],
  },
  {
    note: 'pdf: the dialog is cancelled, and answers an empty name',
    views: hwp,
    files,
    hosts: saves(null, ''),
    calls: [print(job()), print(job()), print(job())],
  },
  {
    note: 'pdf: the dialog speaks the language of the app (Korean locale)',
    views: hwp,
    files,
    hosts: { ...saves('$DIR/out/ko.pdf'), m: { appLocale: 'ko-KR' } },
    calls: [print(job())],
  },
  {
    note: 'pdf: the stored language wins over the locale, the default folder is the case\'s',
    views: hwp,
    files: { ...files, 'userData/app-settings.json': '{"language":"ko"}' },
    hosts: { ...saves(null), m: { appLocale: 'en-US', defaultSaveDir: '$DIR/documents' } },
    calls: [print(job())],
  },
  {
    note: 'pdf: the page does not load, nothing is written',
    views: hwp,
    files,
    hosts: { ...saves('$DIR/out/never.pdf'), m: { loadError: 'ERR_ABORTED' } },
    calls: [print(job())],
  },
  {
    note: 'pdf: printToPDF rejects',
    views: hwp,
    files,
    hosts: { ...saves('$DIR/out/never2.pdf'), m: { pdfError: 'Printing failed' } },
    calls: [print(job())],
  },
  {
    note: 'pdf: a path in the options was not picked in Save As (no grant exists), in any shape',
    views: hwp,
    files,
    calls: [
      print(job(), { path: '$DIR/out/x.pdf' }),
      print(job({ mode: 'print' }), { path: '$DIR/out/x.pdf' }),
      print(job(), { path: 5 }),
      print(job(), { path: null }),
    ],
  },
  {
    note: 'pdf: options that are no object, or have no path, are no grant',
    views: hwp,
    files,
    hosts: saves('$DIR/out/o1.pdf', '$DIR/out/o2.pdf', '$DIR/out/o3.pdf'),
    calls: [print(job(), 'path'), print(job(), {}), print(job(), null)],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const config = hostConfig(cx)
    const { ipcMain } = cx.electron as unknown as {
      ipcMain: {
        handle(
          channel: string,
          fn: (event: { sender: WebContents }, ...args: never[]) => unknown,
        ): void
      }
    }

    // index.ts settles the language at start from the stored setting and the
    // locale of the system, `SEUOFFICE_LANG` first. The app's modules are
    // CommonJS here, so the i18n they read is the one `require` loads, not
    // the one `import` does
    const { installLang, normalizeLang, setUiLang } = createRequire(import.meta.url)(
      '@seuoffice/i18n',
    ) as typeof I18n
    const stored = readAppSettings(join(cx.dir, 'userData', 'app-settings.json')).language
    setUiLang(
      typeof config.envLang === 'string'
        ? normalizeLang(config.envLang)
        : installLang(stored, config.appLocale ?? 'en-US'),
    )
    setHeadlessMode(config.headless === true)
    const savePathByWc = new Map<number, string>()
    const runtime = {
      openGeneratedPath: (path: string): boolean => {
        cx.electron.log.push(['openGeneratedPath', path])
        return config.openGenerated === true
      },
    }
    const app = { configuredDefaultSaveDir: (): string => config.defaultSaveDir ?? '/docs' }
    const pdfSaveAsByWc = new Map<number, string>()
    const headlessPdfByWc = new Map<number, string>()

    // hwp-main.ts:343-344
    const printWindow = (): BrowserWindow =>
      new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } })

    // hwp-main.ts:335-340
    function pdfName(wcId: number): string {
      const current = savePathByWc.get(wcId)
      const base = current ? basename(current).replace(/.hwpx?$/i, '') : ''
      return `${base || tm('untitledFile')}.pdf`
    }

    // hwp-main.ts:342-357
    async function pickPdfTarget(contents: WebContents): Promise<string | null> {
      const win =
        BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const current = savePathByWc.get(contents.id)
      const picked = await showSaveDialogWithMemory(dialog, win, {
        title: tm('dlgExportPdfTitle'),
        defaultPath: join(
          current ? dirname(current) : app.configuredDefaultSaveDir(),
          pdfName(contents.id),
        ),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (picked.canceled || !picked.filePath) return null
      return /.pdf$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.pdf`
    }

    // hwp-main.ts:619-662
    const printing = new Set<number>()
    ipcMain.handle('hwp:print-pages', async (e, job: unknown, options?: unknown): Promise<PrintResult> => {
      const wcId = e.sender.id
      const bad = badJob(job)
      if (bad) return { ok: false, error: `hwp: ${bad}` }
      const given =
        options && typeof options === 'object' ? (options as { path?: unknown }).path : undefined
      if (given !== undefined) {
        const granted = pdfSaveAsByWc.get(wcId) ?? headlessPdfByWc.get(wcId)
        if (typeof given !== 'string' || given !== granted || (job as PrintJob).mode !== 'pdf') {
          return { ok: false, error: 'hwp: this PDF path was not picked in Save As' }
        }
        pdfSaveAsByWc.delete(wcId)
        headlessPdfByWc.delete(wcId)
      }
      if (printing.has(wcId)) return { ok: false, error: 'hwp: already printing' }
      printing.add(wcId)
      try {
        const printJob = job as PrintJob
        if (printJob.mode === 'print') {
          await printJobToPrinter(printJob, printWindow)
          return { ok: true }
        }
        const target = given ?? (await pickPdfTarget(e.sender))
        if (!target) return { ok: true, canceled: true }
        const pdf = await printJobToPdf(printJob, printWindow)
        await atomicWriteFile(target, pdf)
        if (isHeadlessMode()) return { ok: true, path: target }
        try {
          if (!runtime.openGeneratedPath?.(target)) shell.showItemInFolder(target)
        } catch (err) {
          console.warn('[hwp] could not open the exported PDF:', err)
        }
        return { ok: true, path: target }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        printing.delete(wcId)
      }
    })
  },
  cases,
}
